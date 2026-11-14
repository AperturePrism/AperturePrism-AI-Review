import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkbenchHttp } from "./http.js";
import type { Actor, Batch, Policy } from "./types.js";
import {
  administrator,
  makeHarness,
  observer,
  reviewer,
  sampleFinding,
} from "./test-fixture.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function serve(actor: Actor = reviewer) {
  const harness = await makeHarness();
  const handler = createWorkbenchHttp(harness.workbench);
  const server = createServer((request, response) => {
    void handler(request, response, actor)
      .then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end("outside");
        }
      })
      .catch((error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("测试服务未监听TCP");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string) =>
    fetch(
      `${base}/api/workbench${path}${path.includes("?") ? "&" : "?"}repository=acme%2Fapp`,
    );
  const post = (path: string, input: Record<string, unknown>) =>
    fetch(`${base}/api/workbench${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository: "acme/app", ...input }),
    });
  return { ...harness, base, get, post };
}

describe("真实HTTP入口", () => {
  it("创建、列出、版本更新和读取经过真实HTTP往返", async () => {
    const { post, get } = await serve();
    const created = await post("/policies", { name: "HTTP策略" });
    expect(created.status).toBe(200);
    const policy = (await created.json()) as Policy;
    const listed = await get("/policies");
    expect(await listed.json()).toMatchObject({
      total: 1,
      items: [{ id: policy.id }],
    });
    await post(`/policies/${policy.id}/version`, {
      rules: { maxNewFindings: 0 },
    });
    expect(await (await get(`/policies/${policy.id}`)).json()).toMatchObject({
      activeVersion: 2,
    });
  });

  it("畸形JSON、数组正文与错误Content-Type返回可修正的4xx", async () => {
    const { base } = await serve();
    const bad = await fetch(`${base}/api/workbench/policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: "invalid_json" } });
    const array = await fetch(`${base}/api/workbench/policies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });
    expect(array.status).toBe(400);
    const type = await fetch(`${base}/api/workbench/policies`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(type.status).toBe(415);
  });

  it("未知路径、非法方法和畸形URL不会落入写操作", async () => {
    const { base, get } = await serve();
    expect((await get("/unknown")).status).toBe(404);
    expect(
      (await fetch(`${base}/api/workbench/policies`, { method: "DELETE" }))
        .status,
    ).toBe(405);
    expect((await get("/policies/%ZZ")).status).toBe(400);
    expect((await fetch(`${base}/another-prefix`)).status).toBe(404);
  });

  it("GET不能触发批次start等变更，内部worker动作不暴露给HTTP", async () => {
    const { get, post, call } = await serve(administrator);
    const batch = await call<Batch>("batches.create", {
      name: "只读路由",
      items: [{ subject: "pr:1", reference: "sha" }],
    });
    expect((await get(`/batches/${batch.id}/start`)).status).toBe(404);
    for (const action of ["claim", "heartbeat", "link", "complete"])
      expect(
        (await post(`/batches/${batch.id}/${action}`, { worker: "forged" }))
          .status,
      ).toBe(404);
    expect(
      (
        await post("/review/sync", {
          source: "forged",
          reference: "sha",
          findings: [],
        })
      ).status,
    ).toBe(404);
    expect(await call("batches.get", { id: batch.id })).toMatchObject({
      status: "draft",
    });
  });

  it("只读身份不能通过正文伪装管理员", async () => {
    const { post, get } = await serve(observer);
    const denied = await post("/policies", {
      name: "伪造",
      actor: { isAdmin: true },
      isAdmin: true,
      userId: "admin",
    });
    expect(denied.status).toBe(404);
    expect(await (await get("/policies")).json()).toMatchObject({ total: 0 });
  });

  it("重复查询参数与非法数字不会被静默取第一个", async () => {
    const { base, get } = await serve();
    expect(
      (
        await fetch(
          `${base}/api/workbench/summary?repository=acme/app&repository=private/secret`,
        )
      ).status,
    ).toBe(400);
    expect((await get("/findings?limit=abc")).status).toBe(400);
    expect((await get("/gate?humanApproved=yes")).status).toBe(400);
  });

  it("报告以原格式下载，响应禁缓存且不执行内容嗅探", async () => {
    const { call, get } = await serve();
    await call("findings.create", sampleFinding);
    const response = await get("/reports?format=csv");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(
      'filename="acme-app-review.csv"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain(sampleFinding.ruleId);
  });

  it("分页参数与评估结果路由在HTTP侧保持类型", async () => {
    const { post, get } = await serve();
    await post("/policies", { name: "一" });
    await post("/policies", { name: "二" });
    const page = await get("/policies?limit=1&offset=1");
    expect(await page.json()).toMatchObject({
      total: 2,
      items: [expect.any(Object)],
    });
    const evaluation = (await (
      await post("/evaluations", {
        name: "离线",
        model: "local",
        cases: [{ name: "干净", expected: [], observed: [] }],
      })
    ).json()) as { id: string };
    expect(
      await (await get(`/evaluations/${evaluation.id}/result`)).json(),
    ).toMatchObject({ f1: 1 });
  });

  it("chunked超大正文得到413，服务仍可继续处理后续请求", async () => {
    const { base, get } = await serve();
    const code = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${base}/api/workbench/policies`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.write('{"repository":"acme/app","name":"');
      request.write("x".repeat(2 * 1024 * 1024));
      request.end('"}');
    });
    expect(code).toBe(413);
    expect((await get("/summary")).status).toBe(200);
  });

  it("归档通过真实HTTP下载和预览，普通写用户不能恢复", async () => {
    const { get, post, call } = await serve();
    await call("findings.create", sampleFinding);
    const download = await get("/archive");
    expect(download.headers.get("content-disposition")).toContain(
      "workbench-backup.json",
    );
    const archive = (await download.json()) as { checksum: string };
    const preview = await post("/archive/preview", { archive });
    expect(await preview.json()).toMatchObject({
      counts: { findings: 1 },
      canRestore: false,
    });
    const denied = await post("/archive/restore", {
      archive,
      confirmChecksum: archive.checksum,
    });
    expect(denied.status).toBe(403);
    expect(await call("findings.list")).toMatchObject({ total: 1 });
  });

  it("管理员恢复和真实UTC趋势端到端可调用", async () => {
    const { get, post, call } = await serve(administrator);
    const archive = (await (await get("/archive")).json()) as {
      checksum: string;
    };
    await call("review.sync", {
      source: "pr:1",
      reference: "sha",
      findings: [sampleFinding],
    });
    const trends = (await (await get("/trends?days=7")).json()) as {
      daily: unknown[];
      totals: { reviews: number };
    };
    expect(trends.daily).toHaveLength(7);
    expect(trends.totals.reviews).toBe(1);
    expect(
      (
        await post("/archive/restore", {
          archive,
          confirmChecksum: archive.checksum,
        })
      ).status,
    ).toBe(200);
    expect(await call("findings.list")).toMatchObject({ total: 0 });
  });
});
