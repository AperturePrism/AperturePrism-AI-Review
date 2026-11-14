/**
 * 请求缓存：显式选择复用结果时，合并相同的在途请求并保留有限的短期结果。
 *
 * @example
 * const cache = new ModelResponseCache({ ttlMs: 10_000, maxBytes: 8_000_000 });
 * await routeModelInvocation(adapters, { ...input, cache, cacheScope: "tenant-7:policy-v2" });
 *
 * 共享范围由 cacheScope 明确指定，必须包含租户与生效策略版本。
 * 默认路由不开缓存，随机采样或有副作用的工具调用也不会自动缓存。
 */
import { createHash } from "node:crypto";
import { serialize } from "node:v8";
import { ModelInvocationError } from "../../domain/src/index.js";

export type CacheStatus = "miss" | "hit" | "coalesced";
export type CachedResponse<T> = { value: T; status: CacheStatus };
export type ModelCacheOptions = {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxInflight?: number;
  now?: () => number;
};

type SavedEntry = {
  value: unknown;
  expiresAt: number;
  bytes: number;
  scope: string;
};

type PendingEntry = {
  promise: Promise<unknown>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  scope: string;
};

export type CacheSnapshot = {
  entries: number;
  bytes: number;
  inflight: number;
  waiters: number;
  hits: number;
  misses: number;
  coalesced: number;
  evictions: number;
};

/** 把对象键按字母排列，避免同一请求因为属性插入顺序不同而错过缓存。 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .filter((key) => object[key] !== undefined)
        .map((key) => [key, canonicalValue(object[key])]),
    );
  }
  return value;
}

/** 返回哈希而不是提示词；缓存键和诊断信息里不会出现源代码正文。 */
export function modelRequestCacheKey(scope: string, request: unknown): string {
  if (!scope.trim())
    throw new RangeError("cacheScope is required to isolate response reuse");
  return createHash("sha256")
    .update(JSON.stringify([scope, canonicalValue(request)]))
    .digest("hex");
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

export class ModelResponseCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly maxInflight: number;
  private readonly now: () => number;
  private readonly saved = new Map<string, SavedEntry>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly inflight = new Set<PendingEntry>();
  private generation = 0;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private evictions = 0;

  constructor(options: ModelCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 0)
      throw new RangeError("ttlMs must be a non-negative safe integer");
    this.maxEntries = positiveLimit(options.maxEntries ?? 200, "maxEntries");
    this.maxBytes = positiveLimit(options.maxBytes ?? 8_000_000, "maxBytes");
    this.maxInflight = positiveLimit(options.maxInflight ?? 200, "maxInflight");
    this.now = options.now ?? Date.now;
  }

  /** 每个订阅者可以独立取消；所有订阅者都走开后才取消共享上游请求。 */
  async run<T>(
    scope: string,
    keyInput: unknown,
    invoke: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<CachedResponse<T>> {
    if (signal?.aborted)
      throw new ModelInvocationError(
        "canceled",
        "cached model request was canceled",
      );
    const key = modelRequestCacheKey(scope, keyInput);
    this.prune();
    const cached = this.saved.get(key);
    if (cached) {
      this.saved.delete(key); // 最近使用的结果移到末尾，容量不足时先淘汰最久未用的。
      this.saved.set(key, cached);
      this.hits += 1;
      return { value: structuredClone(cached.value) as T, status: "hit" };
    }
    let active = this.pending.get(key);
    let status: CacheStatus = "coalesced";
    if (active?.controller.signal.aborted) active = undefined;
    if (!active) {
      if (this.inflight.size >= this.maxInflight)
        throw new ModelInvocationError(
          "rate_limited",
          "model cache in-flight capacity is full",
        );
      const generation = this.generation;
      const controller = new AbortController();
      const current: PendingEntry = {
        promise: Promise.resolve(),
        controller,
        waiters: 0,
        settled: false,
        scope,
      };
      current.promise = Promise.resolve().then(() => {
        if (controller.signal.aborted)
          throw new ModelInvocationError(
            "canceled",
            "cached model request was canceled before sending",
          );
        return invoke(controller.signal);
      });
      active = current;
      this.pending.set(key, current);
      this.inflight.add(current);
      this.misses += 1;
      status = "miss";
      void current.promise.then(
        (value) => {
          current.settled = true;
          this.inflight.delete(current);
          if (this.pending.get(key) === current) this.pending.delete(key);
          if (!controller.signal.aborted && generation === this.generation)
            this.save(key, scope, value);
        },
        () => {
          current.settled = true;
          this.inflight.delete(current);
          if (this.pending.get(key) === current) this.pending.delete(key);
        },
      );
    } else {
      this.coalesced += 1;
    }
    const value = await this.subscribe(active, signal);
    return { value: structuredClone(value) as T, status };
  }

  /** 清掉已存结果；策略/权限改变时应使用新 scope 或主动调用 clear。 */
  clear(options: { cancelInflight?: boolean } = {}): void {
    this.saved.clear();
    this.bytes = 0;
    this.generation += 1; // 已经开始的旧请求结束时不能把旧策略结果重新写回来。
    if (options.cancelInflight) {
      for (const active of this.inflight) active.controller.abort();
    }
    this.pending.clear(); // 新订阅不能再次合并到已经失效的旧请求。
  }

  /** 只删除指定隔离范围，不影响同进程其他租户的缓存。 */
  invalidateScope(scope: string): number {
    let count = 0;
    for (const [key, entry] of this.saved) {
      if (entry.scope !== scope) continue;
      this.remove(key, entry);
      count += 1;
    }
    this.generation += 1; // 即使旧结果尚在请求中，也不能再次填充已失效的缓存。
    for (const [key, active] of this.pending)
      if (active.scope === scope) this.pending.delete(key);
    return count;
  }

  snapshot(): CacheSnapshot {
    this.prune();
    return {
      entries: this.saved.size,
      bytes: this.bytes,
      inflight: this.inflight.size,
      waiters: [...this.inflight].reduce(
        (count, active) => count + active.waiters,
        0,
      ),
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      evictions: this.evictions,
    };
  }

  private subscribe(
    active: PendingEntry,
    signal?: AbortSignal,
  ): Promise<unknown> {
    active.waiters += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (action: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        active.controller.signal.removeEventListener("abort", onUpstreamAbort);
        active.waiters -= 1;
        if (active.waiters === 0 && !active.settled) active.controller.abort();
        action();
      };
      const onAbort = () =>
        finish(() =>
          reject(
            new ModelInvocationError(
              "canceled",
              "cached model subscriber was canceled",
            ),
          ),
        );
      const onUpstreamAbort = () =>
        finish(() =>
          reject(
            new ModelInvocationError(
              "canceled",
              "cached model request was cleared",
            ),
          ),
        );
      signal?.addEventListener("abort", onAbort, { once: true });
      active.controller.signal.addEventListener("abort", onUpstreamAbort, {
        once: true,
      });
      active.promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
      if (signal?.aborted) onAbort(); // 订阅前后发生的取消也不能漏掉。
    });
  }

  private save(key: string, scope: string, value: unknown): void {
    if (this.ttlMs === 0) return;
    let copy: unknown;
    let bytes: number;
    try {
      copy = structuredClone(value);
      bytes = serialize(copy).byteLength; // Map、Date 等结构也按实际序列化内容计量，不能用 JSON 的 {} 绕过容量。
    } catch {
      return; // 缓存是可选优化，无法保存的值仍会正常交给当前调用者。
    }
    if (bytes > this.maxBytes) return; // 单个巨型响应不能挤掉整个缓存后仍塞不进去。
    const old = this.saved.get(key);
    if (old) this.remove(key, old);
    while (
      this.saved.size >= this.maxEntries ||
      this.bytes + bytes > this.maxBytes
    ) {
      const first = this.saved.entries().next().value;
      if (!first) break;
      this.remove(first[0], first[1]);
      this.evictions += 1;
    }
    this.saved.set(key, {
      value: copy,
      scope,
      bytes,
      expiresAt: this.now() + this.ttlMs,
    });
    this.bytes += bytes;
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.saved) {
      if (entry.expiresAt <= now) this.remove(key, entry);
    }
  }

  private remove(key: string, entry: SavedEntry): void {
    this.saved.delete(key);
    this.bytes -= entry.bytes;
  }
}
