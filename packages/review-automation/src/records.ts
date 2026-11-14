/**
 * 自动化全部持久记录的唯一所有者：跨进程 flock、完整快照读取、fsync 与原子替换。
 * 调用：const records = new AutomationRecords(options); await records.change(data => ...)。
 * 文件锁随进程退出自动释放，不用超时抢占仍然活着的写入者。
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AutomationAudit,
  AutomationOptions,
  AutomationSnapshot,
  ObjectValue,
} from "./types.js";
import { AutomationError } from "./utils/input.js";

export function emptyAutomation(): AutomationSnapshot {
  return {
    format: "apertureprism-review-automation",
    version: 1,
    revision: 0,
    rules: [],
    events: [],
    runs: [],
    approvals: [],
    artifacts: [],
    audit: [],
  };
}
function sourceRoot(): string | null {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (dirname(directory) !== directory) {
    const manifest = join(directory, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name ===
        "apertureprism-ai-review"
    )
      return directory;
    directory = dirname(directory);
  }
  return null;
}
function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export class AutomationRecords {
  private readonly directory: string;
  private readonly file: string;
  private readonly lock: string;
  private readonly timeout: number;
  private readonly maxBytes: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: AutomationOptions) {
    if (!isAbsolute(options.dataDirectory))
      throw new AutomationError(
        "invalid_data_directory",
        "automation dataDirectory must be absolute",
      );
    this.directory = resolve(options.dataDirectory);
    const root = sourceRoot();
    const within = root ? relative(root, this.directory) : null;
    if (
      within !== null &&
      (!within || (!within.startsWith("..") && !isAbsolute(within)))
    )
      throw new AutomationError(
        "invalid_data_directory",
        "automation data must be outside the source directory",
      );
    this.file = join(this.directory, "automation.json");
    this.lock = join(this.directory, "automation.lock");
    this.timeout = options.lockTimeoutMs ?? 10_000;
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 120_000
    )
      throw new AutomationError(
        "invalid_options",
        "lockTimeoutMs must be between 1 and 120000",
      );
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1024 ||
      this.maxBytes > 512 * 1024 * 1024
    )
      throw new AutomationError(
        "invalid_options",
        "maxBytes must be between 1 KiB and 512 MiB",
      );
  }

  /** 读取最新磁盘快照；一次原子替换不会让读者看到半份 JSON。 */
  async read(): Promise<AutomationSnapshot> {
    await this.queue;
    return this.load();
  }

  /** 回调只做内存业务变更；动作的网络或工作台调用在锁外执行并用持久步骤去重。 */
  async change<T>(operation: (data: AutomationSnapshot) => T): Promise<T> {
    const transaction = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await this.acquire();
      try {
        const data = await this.load();
        const result = operation(data);
        data.revision += 1;
        await this.save(data);
        return structuredClone(result);
      } finally {
        await handle.close();
      }
    });
    this.queue = transaction.catch(() => undefined);
    return transaction;
  }

  private async load(): Promise<AutomationSnapshot> {
    let content: string;
    try {
      if ((await stat(this.file)).size > this.maxBytes)
        throw new AutomationError(
          "data_too_large",
          "automation data exceeds the configured size limit",
          507,
        );
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if (nodeError(error, "ENOENT")) return emptyAutomation();
      throw error;
    }
    let data: AutomationSnapshot;
    try {
      data = JSON.parse(content) as AutomationSnapshot;
    } catch {
      throw new AutomationError(
        "data_corrupt",
        "automation data is not valid JSON",
        500,
      );
    }
    if (
      data?.format !== "apertureprism-review-automation" ||
      data.version !== 1 ||
      !Number.isSafeInteger(data.revision)
    )
      throw new AutomationError(
        "data_version",
        "unsupported automation data format",
        500,
      );
    for (const collection of [
      "rules",
      "events",
      "runs",
      "approvals",
      "artifacts",
      "audit",
    ] as const)
      if (!Array.isArray(data[collection]))
        throw new AutomationError(
          "data_corrupt",
          `automation collection ${collection} is missing`,
          500,
        );
    return data;
  }

  private async save(data: AutomationSnapshot): Promise<void> {
    const content = JSON.stringify(data) + "\n";
    if (Buffer.byteLength(content) > this.maxBytes)
      throw new AutomationError(
        "data_too_large",
        "automation data exceeds the configured size limit",
        507,
      );
    const temporary = join(this.directory, `automation.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      await rename(temporary, this.file);
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
          { stdio: ["ignore", "ignore", "pipe", handle.fd], shell: false },
        );
        child.stderr?.resume();
        child.once("error", () =>
          rejectLock(
            new AutomationError(
              "lock_unavailable",
              "automation persistence requires Linux/WSL util-linux flock",
              503,
            ),
          ),
        );
        child.once("exit", (code) =>
          code === 0
            ? resolveLock()
            : rejectLock(
                new AutomationError(
                  "automation_busy",
                  "automation data is busy or cannot be locked",
                  503,
                ),
              ),
        );
      });
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
}

/** 审计事件只保存必要业务元数据，不复制完整 PR、模型输入或账号设置。 */
export function writeAutomationAudit(
  data: AutomationSnapshot,
  repository: string,
  actor: string,
  action: string,
  target: string,
  detail: ObjectValue,
  at: string,
): AutomationAudit {
  const entry: AutomationAudit = {
    id: randomUUID(),
    repository,
    actor,
    action,
    target,
    detail,
    at,
  };
  data.audit.push(entry);
  return entry;
}
