/** 主动探测受正常配额约束，只读健康报告不发模型请求。 */
import { describe, expect, it } from "vitest";
import {
  ModelInvocationError,
  type ModelProviderAdapter,
} from "../../domain/src/index.js";
import { ModelTraffic } from "./traffic.js";
import { modelHealthReport, probeModelCandidates } from "./health.js";

const candidate = { provider: "a", model: "m", accountName: "one" };
const request = {
  messages: [{ role: "user" as const, content: "private source text" }],
};

describe("model health", () => {
  it("does not infer health from configuration alone", () => {
    const traffic = new ModelTraffic();
    expect(modelHealthReport([candidate], traffic)).toMatchObject({
      status: "unknown",
      processLocal: true,
      candidates: [{ status: "unknown", recent: { requests: 0 } }],
    });
  });

  it("reports observed success, latency and tokens without keeping content", async () => {
    let now = 100;
    const traffic = new ModelTraffic({ now: () => now });
    await traffic.run(
      candidate,
      request,
      new AbortController().signal,
      1_000,
      async () => {
        now = 120;
        return {
          content: "private answer",
          usage: { inputTokens: 7, outputTokens: 2 },
        };
      },
    );
    const report = modelHealthReport([candidate, candidate], traffic, { now });
    expect(report.status).toBe("healthy");
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]!.recent).toMatchObject({
      requests: 1,
      successRate: 1,
      averageDurationMs: 20,
      inputTokens: 7,
    });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(
      modelHealthReport([candidate], traffic, { now: 1_000, windowMs: 10 })
        .status,
    ).toBe("unknown");
  });

  it("classifies authentication errors and open circuits as unavailable", async () => {
    const traffic = new ModelTraffic({ circuit: { failureThreshold: 1 } });
    await expect(
      traffic.run(
        candidate,
        request,
        new AbortController().signal,
        1_000,
        async () => {
          throw new ModelInvocationError("authentication_failed", "no key");
        },
      ),
    ).rejects.toThrow();
    expect(modelHealthReport([candidate], traffic).candidates[0]!.status).toBe(
      "unavailable",
    );
    await expect(
      traffic.run(
        candidate,
        request,
        new AbortController().signal,
        1_000,
        async () => {
          throw new ModelInvocationError("server_error", "outage");
        },
      ),
    ).rejects.toThrow();
    expect(
      modelHealthReport([candidate], traffic).candidates[0]!.availability
        .reason,
    ).toBe("circuit_open");
  });

  it("deduplicates active probes and sends a small neutral prompt without tools", async () => {
    let calls = 0;
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: async (_candidate, invocation) => {
        calls += 1;
        expect(invocation.maxOutputTokens).toBe(8);
        expect(invocation.tools).toBeUndefined();
        expect(invocation.messages[0]!.content).toBe("Respond with OK.");
        return { content: "OK", usage: { inputTokens: 4, outputTokens: 1 } };
      },
    };
    const results = await probeModelCandidates(new Map([["a", adapter]]), [
      candidate,
      candidate,
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      outcome: "healthy",
      usage: { inputTokens: 4, outputTokens: 1 },
    });
    expect(calls).toBe(1);
  });

  it("returns classified failures without copying upstream body", async () => {
    const adapter: ModelProviderAdapter = {
      provider: "a",
      invoke: async () => {
        throw new ModelInvocationError("server_error", "secret upstream text");
      },
    };
    const results = await probeModelCandidates(new Map([["a", adapter]]), [
      candidate,
    ]);
    expect(results[0]).toMatchObject({
      outcome: "failed",
      errorCategory: "server_error",
    });
    expect(JSON.stringify(results)).not.toContain("secret");
  });

  it("marks unstarted probes canceled without sending any model calls", async () => {
    const controller = new AbortController();
    controller.abort();
    const results = await probeModelCandidates(new Map(), [candidate], {
      signal: controller.signal,
    });
    expect(results[0]).toMatchObject({
      outcome: "canceled",
      errorCategory: "canceled",
      durationMs: 0,
    });
  });
});
