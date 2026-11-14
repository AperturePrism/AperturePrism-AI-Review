/**
 * 工作台全部持久数据的唯一所有者。一个事务整体提交，不会留下一半预算或审计。
 * @example const records = new Records({dataDirectory:'/var/lib/apertureprism/workbench'});
 * await records.change(snapshot => { snapshot.revision += 1; });
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkbenchOptions, WorkbenchSnapshot } from "./types.js";
import { WORKBENCH_DATA_COLLECTIONS } from "./types.js";
import { WorkbenchError } from "./utils/input.js";

/** 编译后的文件也可能深嵌在某个 app/dist 下，不能靠固定的 ../ 数量猜项目根。 */
function projectRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const data = JSON.parse(readFileSync(manifest, "utf8")) as {
        name?: string;
      };
      if (data.name === "apertureprism-ai-review") return directory;
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw new WorkbenchError(
        "project_root_missing",
        "未找到工作台运行目录的项目清单",
        500,
      );
    directory = parent;
  }
}

/** 先解析已存在的父目录，避免把“源码外的符号链接”当成真的外部数据目录。 */
function physicalPath(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing)
      throw new WorkbenchError(
        "invalid_data_directory",
        "数据目录没有可解析的父目录",
      );
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

/** 空快照没有种子发现；演示不会混入用户的真实记录。 */
export function emptySnapshot(): WorkbenchSnapshot {
  return {
    format: "apertureprism-workbench",
    version: 1,
    revision: 0,
    policies: [],
    baselines: [],
    findings: [],
    suppressions: [],
    batches: [],
    feedback: [],
    budgets: [],
    reservations: [],
    evaluations: [],
    audit: [],
    reviews: [],
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/**
 * 每次读取磁盘最新值，再持有跨进程锁完成写入。
 * 锁没有时间到就强行抢占：活进程慢一点也不能导致丢数据。
 */
export class Records {
  readonly directory: string;
  private readonly file: string;
  private readonly lock: string;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkbenchOptions) {
    if (!isAbsolute(options.dataDirectory)) {
      throw new WorkbenchError(
        "invalid_data_directory",
        "工作台数据目录必须是绝对路径",
      );
    }
    this.directory = physicalPath(resolve(options.dataDirectory)); // 数据位置由配置决定，与启动cwd无关。
    const inside = relative(realpathSync(projectRoot()), this.directory);
    if (!inside || (!inside.startsWith("..") && !isAbsolute(inside))) {
      throw new WorkbenchError(
        "invalid_data_directory",
        "工作台数据应放在源码目录之外",
      );
    }
    this.file = join(this.directory, "workbench.json");
    this.lock = join(this.directory, "workbench.lock");
    this.timeout = options.lockTimeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 120_000
    ) {
      throw new WorkbenchError(
        "invalid_options",
        "lockTimeoutMs 必须为 1 到 120000 的整数",
      );
    }
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1024 ||
      this.maxBytes > 512 * 1024 * 1024
    ) {
      throw new WorkbenchError(
        "invalid_options",
        "maxBytes 必须为 1 KiB 到 512 MiB 的整数",
      );
    }
  }

  /** 等当前实例的写入结束；rename 让跨进程读者看到完整旧版或新版。 */
  async read(): Promise<WorkbenchSnapshot> {
    await this.queue;
    return this.load();
  }

  /** 在一个磁盘事务里修改；回调抛错时没有任何业务记录被保存。 */
  async change<T>(operation: (snapshot: WorkbenchSnapshot) => T): Promise<T> {
    const run = this.queue.then(async () => {
      // 先排队，避免同一进程为自己的写入争用文件锁。
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lock = await this.acquire();
      try {
        const snapshot = await this.load(); // 取锁后重读，才能看到其它容器刚提交的版本。
        const value = operation(snapshot); // 业务失败会直接退出，旧文件保持原样。
        snapshot.revision += 1; // 每个成功提交都有单调增加的快照版本。
        await this.save(snapshot); // 写临时文件并原子替换，不会出现半份JSON。
        return structuredClone(value); // 调用者改返回对象不会反过来改事务数据。
      } finally {
        await lock.close(); // 关闭OFD才释放内核锁，慢写不会被另一个进程抢走。
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<WorkbenchSnapshot> {
    let content: string;
    try {
      const information = await stat(this.file);
      if (information.size > this.maxBytes) {
        throw new WorkbenchError(
          "snapshot_too_large",
          "工作台数据超过配置大小限制",
          507,
        );
      }
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return emptySnapshot();
      throw error;
    }
    let snapshot: WorkbenchSnapshot;
    try {
      snapshot = JSON.parse(content) as WorkbenchSnapshot;
    } catch {
      throw new WorkbenchError(
        "snapshot_corrupt",
        "工作台数据不是有效 JSON，请从备份恢复",
        500,
      );
    }
    if (
      snapshot?.format !== "apertureprism-workbench" ||
      snapshot.version !== 1 ||
      !Number.isSafeInteger(snapshot.revision)
    ) {
      throw new WorkbenchError(
        "snapshot_version",
        "工作台数据格式或版本不受支持",
        500,
      );
    }
    // 首版快照没有交付账本；补空集合兼容已创建的本地工作台。
    if (snapshot.reviews === undefined) snapshot.reviews = [];
    for (const name of WORKBENCH_DATA_COLLECTIONS) {
      if (!Array.isArray(snapshot[name]))
        throw new WorkbenchError(
          "snapshot_corrupt",
          `工作台缺少 ${name} 记录`,
          500,
        );
    }
    return snapshot;
  }

  private async save(snapshot: WorkbenchSnapshot): Promise<void> {
    const content = JSON.stringify(snapshot, null, 2) + "\n";
    if (Buffer.byteLength(content) > this.maxBytes) {
      throw new WorkbenchError(
        "snapshot_too_large",
        "工作台数据超过配置大小限制",
        507,
      );
    }
    const temporary = join(this.directory, `workbench.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.file);
      // 同步目录，保证断电后 rename 本身也已提交到文件系统。
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * Linux flock 作用于 open-file-description。子进程在继承的 fd3 上加锁后退出，
   * 父进程仍持有同一描述，因此锁一直保留到 finally close。
   * 容器退出或 SIGKILL 时内核自动释放，不依赖 hostname、PID 命名空间或过期抢锁。
   * 固定锁文件永不删除，避免两个进程锁住不同 inode。
   */
  private async acquire(): Promise<FileHandle> {
    const handle = await open(this.lock, "a+", 0o600);
    try {
      await new Promise<void>((resolveLock, rejectLock) => {
        const child = spawn(
          "flock",
          [
            "--exclusive",
            "--timeout",
            String(this.timeout / 1000),
            "--conflict-exit-code",
            "75",
            "3",
          ],
          {
            stdio: ["ignore", "ignore", "pipe", handle.fd],
            shell: false,
          },
        );
        child.stderr?.resume();
        child.once("error", () =>
          rejectLock(
            new WorkbenchError(
              "lock_unavailable",
              "持久工作台需要 Linux/WSL 与 util-linux flock",
              503,
            ),
          ),
        );
        child.once("exit", (code) => {
          if (code === 0) resolveLock();
          else if (code === 75)
            rejectLock(
              new WorkbenchError(
                "workbench_busy",
                "工作台正在写入，请稍后重试",
                503,
              ),
            );
          else
            rejectLock(
              new WorkbenchError(
                "lock_failed",
                "工作台文件系统不能取得排他锁",
                503,
              ),
            );
        });
      });
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}
