import { spawn } from "node:child_process";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Records } from "./records.js";
import { createWorkbench } from "./index.js";
import type { Policy } from "./types.js";
import { administrator, makeHarness } from "./test-fixture.js";

const compiledRecords = new URL("../dist/records.js", import.meta.url).href;
const compiledWorkbench = new URL("../dist/index.js", import.meta.url).href;

function runNode(
  script: string,
  args: string[] = [],
): Promise<{ output: string; error: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ output, error, code }));
  });
}

describe("真实文件持久化与跨进程互斥", () => {
  it("数据目录要求绝对路径并拒绝源码目录", () => {
    expect(() => new Records({ dataDirectory: "relative" })).toThrow(
      /绝对路径/,
    );
    const source = fileURLToPath(new URL("../../..", import.meta.url));
    expect(() => new Records({ dataDirectory: source })).toThrow(/源码目录/);
  });

  it("另一实例立即读取已提交快照，调用方修改返回值不会改写数据", async () => {
    const { call, directory } = await makeHarness();
    const created = await call<Policy>("policies.create", { name: "保存" });
    created.name = "调用方篡改";
    const fresh = createWorkbench({ dataDirectory: directory });
    const result = (await fresh.execute(administrator, {
      action: "policies.list",
      input: { repository: "acme/app" },
    })) as { items: Policy[] };
    expect(result.items[0]?.name).toBe("保存");
    expect(result.items[0]?.id).toBe(created.id);
    expect((await stat(join(directory, "workbench.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("外部符号链接指回源码目录时仍然拒绝，未创建子目录也一样", async () => {
    const { directory } = await makeHarness();
    const source = fileURLToPath(new URL("../../..", import.meta.url));
    const link = join(directory, "source-link");
    await symlink(source, link, "dir");
    expect(
      () => new Records({ dataDirectory: join(link, "new-data") }),
    ).toThrow(/源码目录/);
  });

  it("回调抛错不提交，后续事务仍然可用", async () => {
    const { directory } = await makeHarness();
    const records = new Records({ dataDirectory: directory });
    await expect(
      records.change((snapshot) => {
        snapshot.revision = 99;
        throw new Error("测试故障");
      }),
    ).rejects.toThrow("测试故障");
    expect((await records.read()).revision).toBe(0);
    await records.change(() => "saved");
    expect((await records.read()).revision).toBe(1);
  });

  it("损坏快照明确报错，不会悄悄重置用户数据", async () => {
    const { directory } = await makeHarness();
    await writeFile(join(directory, "workbench.json"), "{broken");
    const records = new Records({ dataDirectory: directory });
    await expect(records.read()).rejects.toMatchObject({
      code: "snapshot_corrupt",
    });
    await expect(records.change(() => undefined)).rejects.toMatchObject({
      code: "snapshot_corrupt",
    });
    expect(await readFile(join(directory, "workbench.json"), "utf8")).toBe(
      "{broken",
    );
  });

  it("超出磁盘大小限制会回滚业务与审计", async () => {
    const { directory } = await makeHarness();
    const workbench = createWorkbench({
      dataDirectory: directory,
      maxBytes: 1024,
    });
    await expect(
      workbench.execute(administrator, {
        action: "policies.create",
        input: {
          repository: "acme/app",
          name: "大小限制",
          description: "x".repeat(2000),
        },
      }),
    ).rejects.toMatchObject({ code: "snapshot_too_large" });
    const records = new Records({ dataDirectory: directory });
    expect((await records.read()).policies).toHaveLength(0);
  });

  it("四个独立进程竞争写同一快照不丢更新", async () => {
    const { directory } = await makeHarness();
    const script = `
      import {createWorkbench} from ${JSON.stringify(compiledWorkbench)};
      const workbench=createWorkbench({dataDirectory:process.argv[1]});
      const actor={userId:process.argv[2],isAdmin:true,canAccessRepository:()=>true};
      for(let index=0;index<5;index+=1){
        await workbench.execute(actor,{action:'policies.create',input:{repository:'acme/app',name:process.argv[2]+'-'+index}});
      }
    `;
    const results = await Promise.all(
      ["a", "b", "c", "d"].map((name) => runNode(script, [directory, name])),
    );
    for (const result of results)
      expect(result, result.error).toMatchObject({ code: 0 });
    const snapshot = await new Records({ dataDirectory: directory }).read();
    expect(snapshot.policies).toHaveLength(20);
    expect(new Set(snapshot.policies.map((policy) => policy.name)).size).toBe(
      20,
    );
    expect(snapshot.audit).toHaveLength(20);
  }, 15_000);

  it("慢写持锁不会被超时抢占，写入进程SIGKILL后内核释放锁", async () => {
    const { directory } = await makeHarness();
    const script = `
      import {Records} from ${JSON.stringify(compiledRecords)};
      const records=new Records({dataDirectory:process.argv[1]});
      await records.change(()=>{process.stdout.write('locked\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);});
    `;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", script, directory],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = "";
    child.stderr.on("data", (chunk: Buffer) => {
      error += chunk.toString();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", () => reject(new Error(error || "子进程未取得锁")));
        child.stdout.once("data", () => resolve());
      });
      const contender = new Records({
        dataDirectory: directory,
        lockTimeoutMs: 40,
      });
      await expect(contender.change(() => undefined)).rejects.toMatchObject({
        code: "workbench_busy",
      });
    } finally {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exited;
    }
    const recovered = new Records({
      dataDirectory: directory,
      lockTimeoutMs: 1000,
    });
    await recovered.change(() => undefined);
    expect((await recovered.read()).revision).toBe(1);
  }, 10_000);

  it("已编译工厂同样禁止写源码内目录，并能从其它cwd运行", async () => {
    const { directory } = await makeHarness();
    const project = fileURLToPath(new URL("../../..", import.meta.url));
    const script = `
      import {createWorkbench} from ${JSON.stringify(compiledWorkbench)};
      process.chdir('/tmp');
      let rejected=false;
      try { createWorkbench({dataDirectory:process.argv[2]}); } catch(error) { rejected=error.code==='invalid_data_directory'; }
      if(!rejected) throw new Error('source directory accepted');
      const workbench=createWorkbench({dataDirectory:process.argv[1]});
      await workbench.execute({userId:'cli',isAdmin:true,canAccessRepository:()=>true},{action:'policies.create',input:{repository:'acme/app',name:'compiled'}});
    `;
    const result = await runNode(script, [directory, project]);
    expect(result, result.error).toMatchObject({ code: 0 });
    expect(
      (await new Records({ dataDirectory: directory }).read()).policies[0]
        ?.name,
    ).toBe("compiled");
  });
});
