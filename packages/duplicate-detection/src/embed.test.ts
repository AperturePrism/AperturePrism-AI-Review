import { describe, expect, it } from "vitest";
import { EMBEDDING_DIMENSION, embedTexts } from "./embed.js";

function vector(seed: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSION }, (_, i) =>
    i === 0 ? seed : 0,
  );
}

type Call = { url: string; init: RequestInit };

function embedWith(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, fn };
}

describe("embedTexts", () => {
  it("posts to /embeddings with model + input and returns 1024-d vectors", async () => {
    const { calls, fn } = embedWith(() => {
      return new Response(
        JSON.stringify({
          data: [{ embedding: vector(0.5) }, { embedding: vector(-0.5) }],
          usage: { prompt_tokens: 12, total_tokens: 12 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await embedTexts({
      baseUrl: "https://cf-free.binbim.locker/v1",
      apiKey: "k",
      texts: ["a", "b"],
      fetchImpl: fn,
    });

    expect(calls[0]?.url).toBe("https://cf-free.binbim.locker/v1/embeddings");
    const parsed = JSON.parse(String(calls[0]?.init.body)) as {
      model: string;
      input: string[];
    };
    expect(parsed.model).toBe("text-embedding-3-small");
    expect(parsed.input).toEqual(["a", "b"]);
    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSION);
    expect(result.usage.totalTokens).toBe(12);
  });

  it("rejects a response with mismatched dimension", async () => {
    const { fn } = embedWith(
      () =>
        new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      embedTexts({
        baseUrl: "https://x/v1",
        apiKey: "k",
        texts: ["a"],
        fetchImpl: fn,
      }),
    ).rejects.toThrow(/dimension mismatch/);
  });
});
