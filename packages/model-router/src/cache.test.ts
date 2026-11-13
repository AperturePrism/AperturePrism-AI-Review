/** 验证请求隔离、独立取消、在途失效与容量约束。 */
import { describe, expect, it } from "vitest";
import { ModelResponseCache, modelRequestCacheKey } from "./cache.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("model response cache", () => {
  it("isolates scopes and canonicalizes object property order", () => {
    expect(modelRequestCacheKey("tenant-a:v1", { x: 1, y: 2 })).toBe(
      modelRequestCacheKey("tenant-a:v1", { y: 2, x: 1 }),
    );
    expect(modelRequestCacheKey("tenant-a:v1", { x: 1 })).not.toBe(
      modelRequestCacheKey("tenant-b:v1", { x: 1 }),
    );
    expect(
      modelRequestCacheKey("tenant-a:v1", { messages: "secret source" }),
    ).not.toContain("secret");
    expect(() => modelRequestCacheKey(" ", {})).toThrow("cacheScope");
  });

  it("returns immutable copies for stored and coalesced values", async () => {
    const cache = new ModelResponseCache();
    let calls = 0;
    const invoke = async () => {
      calls += 1;
      return { nested: { content: "ok" } };
    };
    const original = await cache.run("tenant", "key", invoke);
    original.value.nested.content = "changed";
    const hit = await cache.run("tenant", "key", invoke);
    expect(hit).toEqual({
      value: { nested: { content: "ok" } },
      status: "hit",
    });
    expect(calls).toBe(1);
    expect(cache.snapshot()).toMatchObject({
      hits: 1,
      misses: 1,
      entries: 1,
      inflight: 0,
    });
  });

  it("coalesces duplicate in-flight work and saves only successful results", async () => {
    const cache = new ModelResponseCache();
    const gate = deferred<string>();
    let calls = 0;
    const invoke = () => {
      calls += 1;
      return gate.promise;
    };
    const a = cache.run("tenant", { id: 1 }, invoke);
    const b = cache.run("tenant", { id: 1 }, invoke);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(cache.snapshot()).toMatchObject({
      inflight: 1,
      waiters: 2,
      coalesced: 1,
    });
    gate.resolve("ok");
    expect(await a).toEqual({ value: "ok", status: "miss" });
    expect(await b).toEqual({ value: "ok", status: "coalesced" });
  });

  it("does not let one canceled subscriber cancel another subscriber", async () => {
    const cache = new ModelResponseCache();
    const gate = deferred<string>();
    let upstream: AbortSignal | undefined;
    const invoke = (signal: AbortSignal) => {
      upstream = signal;
      return gate.promise;
    };
    const controller = new AbortController();
    const a = cache.run("tenant", "key", invoke, controller.signal);
    const b = cache.run("tenant", "key", invoke);
    const canceled = expect(a).rejects.toMatchObject({ category: "canceled" });
    await Promise.resolve();
    controller.abort();
    await canceled;
    expect(upstream?.aborted).toBe(false);
    gate.resolve("ok");
    expect((await b).value).toBe("ok");
  });

  it("cancels the upstream after its last subscriber leaves", async () => {
    const cache = new ModelResponseCache();
    const gate = deferred<string>();
    let upstream: AbortSignal | undefined;
    const controller = new AbortController();
    const a = cache.run(
      "tenant",
      "key",
      (signal) => {
        upstream = signal;
        return gate.promise;
      },
      controller.signal,
    );
    const canceled = expect(a).rejects.toMatchObject({ category: "canceled" });
    await Promise.resolve();
    controller.abort();
    await canceled;
    expect(upstream?.aborted).toBe(true);
    gate.resolve("late answer");
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.snapshot().entries).toBe(0);
  });

  it("clear cancels every subscriber even when a custom provider ignores abort", async () => {
    const cache = new ModelResponseCache();
    const gate = deferred<string>();
    const a = cache.run("tenant", "key", () => gate.promise);
    const b = cache.run("tenant", "key", () => gate.promise);
    const canceled = Promise.all([
      expect(a).rejects.toMatchObject({ category: "canceled" }),
      expect(b).rejects.toMatchObject({ category: "canceled" }),
    ]);
    cache.clear({ cancelInflight: true });
    await canceled;
    gate.resolve("late");
    await Promise.resolve();
    expect(cache.snapshot().entries).toBe(0);
  });

  it("does not refill or reuse a stale request after invalidation", async () => {
    const cache = new ModelResponseCache();
    const gate = deferred<string>();
    const old = cache.run("tenant", "key", () => gate.promise);
    await Promise.resolve();
    cache.invalidateScope("tenant");
    const fresh = await cache.run("tenant", "key", async () => "fresh");
    gate.resolve("stale");
    await old;
    expect(fresh).toEqual({ value: "fresh", status: "miss" });
    expect((await cache.run("tenant", "key", async () => "wrong")).value).toBe(
      "fresh",
    );
  });

  it("honors expiry at the exact TTL boundary", async () => {
    let now = 0;
    const cache = new ModelResponseCache({ now: () => now, ttlMs: 10 });
    await cache.run("tenant", "key", async () => "first");
    now = 9;
    expect((await cache.run("tenant", "key", async () => "wrong")).status).toBe(
      "hit",
    );
    now = 10;
    expect(await cache.run("tenant", "key", async () => "second")).toEqual({
      value: "second",
      status: "miss",
    });
  });

  it("evicts the least recently used response when entry capacity is reached", async () => {
    const cache = new ModelResponseCache({ maxEntries: 2 });
    await cache.run("tenant", "a", async () => "a");
    await cache.run("tenant", "b", async () => "b");
    await cache.run("tenant", "a", async () => "wrong");
    await cache.run("tenant", "c", async () => "c");
    expect((await cache.run("tenant", "b", async () => "b2")).status).toBe(
      "miss",
    );
    expect(cache.snapshot().entries).toBe(2);
    expect(cache.snapshot().evictions).toBe(2);
  });

  it("bounds bytes and does not save one oversized response", async () => {
    const cache = new ModelResponseCache({ maxBytes: 10 });
    const result = await cache.run(
      "tenant",
      "key",
      async () => "a response larger than the cache",
    );
    expect(result.value).toContain("larger");
    expect(cache.snapshot()).toMatchObject({ entries: 0, bytes: 0 });
  });

  it("retains failed request capacity until it really finishes, including after clear", async () => {
    const cache = new ModelResponseCache({ maxInflight: 1 });
    const gate = deferred<string>();
    const pending = cache.run("tenant", "old", () => gate.promise);
    cache.clear();
    await expect(
      cache.run("tenant", "new", async () => "new"),
    ).rejects.toMatchObject({ category: "rate_limited" });
    gate.resolve("old");
    await pending;
    expect(cache.snapshot().inflight).toBe(0);
    expect((await cache.run("tenant", "new", async () => "new")).value).toBe(
      "new",
    );
  });

  it("does not cache failures and allows the next call to recover", async () => {
    const cache = new ModelResponseCache();
    await expect(
      cache.run("tenant", "key", async () => {
        throw new Error("failure");
      }),
    ).rejects.toThrow("failure");
    expect(
      (await cache.run("tenant", "key", async () => "recovered")).value,
    ).toBe("recovered");
  });

  it("supports deduplication without storing settled results", async () => {
    const cache = new ModelResponseCache({ ttlMs: 0 });
    await cache.run("tenant", "key", async () => "ok");
    expect(cache.snapshot().entries).toBe(0);
    expect((await cache.run("tenant", "key", async () => "again")).status).toBe(
      "miss",
    );
  });

  it("does not start already canceled work or accept invalid limits", async () => {
    const controller = new AbortController();
    controller.abort();
    const cache = new ModelResponseCache();
    let called = false;
    await expect(
      cache.run(
        "tenant",
        "key",
        async () => {
          called = true;
          return 1;
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ category: "canceled" });
    expect(called).toBe(false);
    expect(() => new ModelResponseCache({ maxBytes: 0 })).toThrow();
    expect(() => new ModelResponseCache({ ttlMs: -1 })).toThrow();
  });
});
