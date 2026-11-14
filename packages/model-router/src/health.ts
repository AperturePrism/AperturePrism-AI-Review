/**
 * 模型健康：只读近期调用判断与显式主动探测，不保存供应商正文。
 * @example
 * const traffic = getModelTraffic(adapters);
 * const report = modelHealthReport(candidates, traffic);
 * // 主动探测真实调用模型并消耗供应商额度，只有管理命令明确请求时才调用。
 * const probe = await probeModelCandidates(adapters, candidates, { deadlineMs: 3000 });
 */
import {
  type ModelCandidate,
  type ModelErrorCategory,
  type ModelProviderAdapter,
  type ModelUsage,
} from "../../domain/src/index.js";
import {
  ModelTraffic,
  type ModelAvailability,
  type TrafficRecord,
} from "./traffic.js";
import { ModelRoutingFailedError, routeModelInvocation } from "./index.js";

export type CandidateHealth = {
  candidate: ModelCandidate;
  status: "healthy" | "degraded" | "unavailable" | "unknown";
  availability: ModelAvailability;
  recent: {
    requests: number;
    successes: number;
    failures: number;
    canceled: number;
    successRate: number | null;
    averageDurationMs: number | null;
    p95DurationMs: number | null;
    inputTokens: number;
    outputTokens: number;
  };
  lastOutcome: TrafficRecord["outcome"] | null;
  lastObservedAt: number | null;
  reasons: string[];
};

export type ModelHealthReport = {
  observedAt: number;
  status: CandidateHealth["status"];
  processLocal: true;
  candidates: CandidateHealth[];
  capacity: { running: number; queued: number };
};

function identity(candidate: ModelCandidate): string {
  return JSON.stringify([
    candidate.provider,
    candidate.model,
    candidate.accountName,
  ]);
}

/** 保持管理端给出的候选顺序，同时移除重复项，避免主动探测重复收费。 */
function uniqueCandidates(
  candidates: readonly ModelCandidate[],
): ModelCandidate[] {
  const result = new Map<string, ModelCandidate>();
  for (const candidate of candidates)
    if (!result.has(identity(candidate)))
      result.set(identity(candidate), { ...candidate });
  return [...result.values()];
}

/** 只读本进程近期样本；没有真实调用的账号显示 unknown，不能凭配置宣称健康。 */
export function modelHealthReport(
  candidates: readonly ModelCandidate[],
  traffic: ModelTraffic,
  options: { now?: number; windowMs?: number } = {},
): ModelHealthReport {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? 5 * 60_000;
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs <= 0)
    throw new RangeError("health window must be positive and finite");
  const history = traffic
    .history()
    .filter((record) => record.at >= now - windowMs && record.at <= now);
  const health = uniqueCandidates(candidates).map(
    (candidate): CandidateHealth => {
      const samples = history.filter(
        (record) => identity(record.candidate) === identity(candidate),
      );
      const successes = samples.filter(
        (record) => record.outcome === "success",
      );
      const failures = samples.filter(
        (record) =>
          record.outcome !== "success" && record.outcome !== "canceled",
      );
      const latency = samples
        .filter((record) => record.outcome !== "canceled")
        .map((record) => record.durationMs)
        .sort((left, right) => left - right);
      const availability = traffic.availability(candidate);
      const last = samples.at(-1);
      const reasons: string[] = [];
      let status: CandidateHealth["status"] = "unknown";
      if (
        availability.reason === "circuit_open" ||
        availability.reason === "probe_busy"
      ) {
        status = "unavailable";
        reasons.push(availability.reason);
      } else if (
        last?.outcome === "authentication_failed" ||
        last?.outcome === "model_not_found"
      ) {
        status = "unavailable";
        reasons.push(last.outcome);
      } else if (successes.length || failures.length) {
        status = failures.length ? "degraded" : "healthy";
        if (failures.length) reasons.push("recent_failures");
      } else reasons.push("no_recent_completed_calls");
      if (!availability.available && status === "healthy") {
        status = "degraded";
        reasons.push(availability.reason);
      }
      return {
        candidate,
        status,
        availability,
        recent: {
          requests: samples.length,
          successes: successes.length,
          failures: failures.length,
          canceled: samples.length - successes.length - failures.length,
          successRate:
            successes.length + failures.length
              ? successes.length / (successes.length + failures.length)
              : null,
          averageDurationMs: latency.length
            ? latency.reduce((sum, value) => sum + value, 0) / latency.length
            : null,
          p95DurationMs: latency.length
            ? latency[Math.max(0, Math.ceil(latency.length * 0.95) - 1)]!
            : null,
          inputTokens: successes.reduce(
            (sum, record) => sum + (record.usage?.inputTokens ?? 0),
            0,
          ),
          outputTokens: successes.reduce(
            (sum, record) => sum + (record.usage?.outputTokens ?? 0),
            0,
          ),
        },
        lastOutcome: last?.outcome ?? null,
        lastObservedAt: last?.at ?? null,
        reasons,
      };
    },
  );
  const snapshot = traffic.snapshot();
  const statuses = health.map((candidate) => candidate.status);
  const status =
    statuses.length === 0 || statuses.every((item) => item === "unknown")
      ? "unknown"
      : statuses.every((item) => item === "unavailable")
        ? "unavailable"
        : statuses.every((item) => item === "healthy")
          ? "healthy"
          : "degraded";
  return {
    observedAt: now,
    status,
    processLocal: true,
    candidates: health,
    capacity: { running: snapshot.running, queued: snapshot.queued },
  };
}

export type CandidateProbe = {
  candidate: ModelCandidate;
  outcome: "healthy" | "failed" | "canceled";
  errorCategory: ModelErrorCategory | null;
  durationMs: number;
  usage: ModelUsage;
};

export type ProbeOptions = {
  signal?: AbortSignal;
  deadlineMs?: number;
  concurrency?: number;
  traffic?: ModelTraffic;
  now?: () => number;
};

/** 主动探测不带仓库正文，最多生成 8 token，不重试，仍经过正常流量和熔断。 */
export async function probeModelCandidates(
  adapters: ReadonlyMap<string, ModelProviderAdapter>,
  candidates: readonly ModelCandidate[],
  options: ProbeOptions = {},
): Promise<CandidateProbe[]> {
  const concurrency = options.concurrency ?? 2;
  const deadlineMs = options.deadlineMs ?? 5_000;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new RangeError("probe concurrency must be between 1 and 32");
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0 || deadlineMs > 60_000)
    throw new RangeError("probe deadline must be between 0 and 60000ms");
  const list = uniqueCandidates(candidates);
  const results: CandidateProbe[] = new Array(list.length);
  const now = options.now ?? Date.now;
  let cursor = 0;
  const work = async () => {
    while (cursor < list.length) {
      const index = cursor++;
      const candidate = list[index]!;
      const startedAt = now();
      if (options.signal?.aborted) {
        results[index] = {
          candidate,
          outcome: "canceled",
          errorCategory: "canceled",
          durationMs: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
        continue;
      }
      try {
        const result = await routeModelInvocation(adapters, {
          candidates: [candidate],
          request: {
            messages: [{ role: "user", content: "Respond with OK." }],
            maxOutputTokens: 8,
            temperature: 0,
          },
          deadlineMs,
          retryPolicy: {
            maxAttemptsPerCandidate: 1,
            baseDelayMs: 0,
            maxDelayMs: 0,
          },
          ...(options.traffic ? { traffic: options.traffic } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        results[index] = {
          candidate,
          outcome: "healthy",
          errorCategory: null,
          durationMs: Math.max(0, now() - startedAt),
          usage: { ...result.response.usage },
        };
      } catch (error) {
        const category =
          error instanceof ModelRoutingFailedError
            ? error.lastCategory
            : options.signal?.aborted
              ? "canceled"
              : "unknown";
        results[index] = {
          candidate,
          outcome: category === "canceled" ? "canceled" : "failed",
          errorCategory: category,
          durationMs: Math.max(0, now() - startedAt),
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, work),
  );
  return results;
}
