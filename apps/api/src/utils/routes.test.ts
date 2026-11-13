import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, it, expect, vi } from "vitest";
import { dispatch, loadRoutes, orderRoutes } from "./routes.js";

function request(path: string, method = "GET"): IncomingMessage {
  return { url: path, method } as IncomingMessage;
}
function response(): ServerResponse {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}
const context = { isAdmin: async () => true };

describe("HTTP routes locate a business path before checking its method", () => {
  it("routes a specific command before a subject detail prefix", async () => {
    const list = vi.fn();
    const create = vi.fn();
    const routes = orderRoutes([
      { path: "/tasks", prefix: true, methods: ["GET"], handle: list },
      { path: "/tasks/manual", methods: ["POST"], handle: create },
    ]);
    await expect(
      dispatch(
        routes,
        request("/tasks/manual", "POST"),
        response(),
        "id",
        context,
      ),
    ).resolves.toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("does not fall through a known command's wrong method into its detail prefix", async () => {
    const read = vi.fn();
    const remove = vi.fn();
    const output = response();
    const routes = orderRoutes([
      { path: "/results", prefix: true, methods: ["GET"], handle: read },
      { path: "/results/delete", methods: ["POST"], handle: remove },
    ]);
    await dispatch(routes, request("/results/delete"), output, "id", context);
    expect(output.writeHead).toHaveBeenCalledWith(405, expect.anything());
    expect(output.setHeader).toHaveBeenCalledWith("allow", "POST");
    expect(read).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("selects one of multiple allowed methods on the same exact path", async () => {
    const read = vi.fn();
    const write = vi.fn();
    const routes = orderRoutes([
      { path: "/scans/config", methods: ["GET"], handle: read },
      { path: "/scans/config", methods: ["PUT"], handle: write },
    ]);
    await dispatch(
      routes,
      request("/scans/config", "PUT"),
      response(),
      "id",
      context,
    );
    expect(write).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it("returns a method error listing all methods for a known path", async () => {
    const output = response();
    await dispatch(
      [
        { path: "/config", methods: ["GET"], handle: vi.fn() },
        { path: "/config", methods: ["PUT"], handle: vi.fn() },
      ],
      request("/config", "DELETE"),
      output,
      "id",
      context,
    );
    expect(output.setHeader).toHaveBeenCalledWith("allow", "GET, PUT");
    expect(output.end).toHaveBeenCalledWith(
      JSON.stringify({ status: "error", reason: "method not allowed" }),
    );
  });

  it("keeps query strings out of path matching", async () => {
    const handler = vi.fn();
    await dispatch(
      [{ path: "/tasks", methods: ["GET"], handle: handler }],
      request("/tasks?limit=25"),
      response(),
      "id",
      context,
    );
    expect(handler).toHaveBeenCalledOnce();
  });

  it("requires a slash after a subject prefix", async () => {
    const handler = vi.fn();
    const result = await dispatch(
      [{ path: "/tasks", prefix: true, handle: handler }],
      request("/tasks-else"),
      response(),
      "id",
      context,
    );
    expect(result).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("checks an admin route before invoking its command", async () => {
    const handler = vi.fn();
    const output = response();
    const isAdmin = vi.fn(async () => false);
    await dispatch(
      [
        {
          path: "/backup/import",
          methods: ["POST"],
          admin: true,
          handle: handler,
        },
      ],
      request("/backup/import", "POST"),
      output,
      "id",
      { isAdmin },
    );
    expect(isAdmin).toHaveBeenCalledOnce();
    expect(output.writeHead).toHaveBeenCalledWith(403, expect.anything());
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not request admin data for a read route", async () => {
    const isAdmin = vi.fn(async () => false);
    await dispatch(
      [{ path: "/tasks", handle: vi.fn() }],
      request("/tasks"),
      response(),
      "id",
      { isAdmin },
    );
    expect(isAdmin).not.toHaveBeenCalled();
  });

  it("preserves the original request, response and correlation id", async () => {
    const handler = vi.fn();
    const input = request("/tasks");
    const output = response();
    await dispatch(
      [{ path: "/tasks", handle: handler }],
      input,
      output,
      "run-4",
      context,
    );
    expect(handler).toHaveBeenCalledWith(input, output, "run-4");
  });

  it("leaves business failures to the single HTTP error boundary", async () => {
    const error = new Error("connection failed");
    const handle = vi.fn(async () => {
      throw error;
    });
    const output = response();
    await expect(
      dispatch(
        [{ path: "/tasks", handle }],
        request("/tasks"),
        output,
        "id",
        context,
      ),
    ).rejects.toBe(error);
    expect(output.writeHead).not.toHaveBeenCalled();
  });

  it("supports an exact regex path with a repository parameter", async () => {
    const handle = vi.fn();
    await dispatch(
      [{ path: /^\/repositories\/[^/]+\/settings$/, methods: ["PUT"], handle }],
      request("/repositories/repo-1/settings", "PUT"),
      response(),
      "id",
      context,
    );
    expect(handle).toHaveBeenCalledOnce();
  });

  it("gives regex parameter routes precedence over a broad subject prefix", async () => {
    const exact = vi.fn();
    const broad = vi.fn();
    await dispatch(
      orderRoutes([
        { path: "/repositories", prefix: true, handle: broad },
        { path: /^\/repositories\/[^/]+\/settings$/, handle: exact },
      ]),
      request("/repositories/repo-1/settings"),
      response(),
      "id",
      context,
    );
    expect(exact).toHaveBeenCalledOnce();
    expect(broad).not.toHaveBeenCalled();
  });

  it("matches a global regex independently for every request", async () => {
    const handle = vi.fn();
    const routes = [{ path: /^\/tasks\/[^/]+$/g, handle }];
    await dispatch(routes, request("/tasks/one"), response(), "id", context);
    await dispatch(routes, request("/tasks/two"), response(), "id", context);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("uses the longest matching prefix", async () => {
    const broad = vi.fn();
    const narrow = vi.fn();
    await dispatch(
      orderRoutes([
        { path: "/tasks", prefix: true, handle: broad },
        { path: "/tasks/history", prefix: true, handle: narrow },
      ]),
      request("/tasks/history/123"),
      response(),
      "id",
      context,
    );
    expect(narrow).toHaveBeenCalledOnce();
    expect(broad).not.toHaveBeenCalled();
  });

  it("rejects conflicting registrations at startup", () => {
    expect(() =>
      orderRoutes([
        { path: "/tasks", methods: ["GET"], handle: vi.fn() },
        { path: "/tasks", methods: ["GET"], handle: vi.fn() },
      ]),
    ).toThrow("duplicate HTTP route");
  });

  it("does not reject different methods or independent prefix and exact routes", () => {
    expect(
      orderRoutes([
        { path: "/tasks", methods: ["GET"], handle: vi.fn() },
        { path: "/tasks", methods: ["POST"], handle: vi.fn() },
        { path: "/tasks", prefix: true, methods: ["GET"], handle: vi.fn() },
      ]),
    ).toHaveLength(3);
  });

  it("discovers a new command without changing an application registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aperture-http-routes-"));
    try {
      await writeFile(join(directory, "package.json"), '{"type":"module"}');
      await writeFile(
        join(directory, "reviews.js"),
        'export const routes = [{path:"/reviews", methods:["GET"], handle:(_req,res)=>res.end("reviews")}]',
      );
      await writeFile(
        join(directory, "ignored.test.js"),
        'throw new Error("test file must not run")',
      );
      await writeFile(join(directory, "notes.txt"), "not JavaScript");
      const discovered = await loadRoutes(pathToFileURL(directory + "/"));
      const output = response();
      expect(discovered).toHaveLength(1);
      await dispatch(discovered, request("/reviews"), output, "id", context);
      expect(output.end).toHaveBeenCalledWith("reviews");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
