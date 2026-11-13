import { describe, expect, it, vi } from "vitest";
import type { IssueContext } from "./context.js";
import { collectIssueImages, extractImageUrls } from "./images.js";

function ctx(body: string, commentBodies: string[] = []): Pick<IssueContext, "issue" | "comments"> {
  return {
    issue: { body } as unknown as IssueContext["issue"],
    comments: commentBodies.map((b, i) => ({
      author: `u${i}`,
      body: b,
      createdAt: `2026-08-24T00:0${i}:00Z`,
    })),
  };
}

/** 最小合法 PNG 文件头（用于命中 sniffMime）。 */
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

function bytesResponse(bytes: number[], status = 200): Response {
  return new Response(new Uint8Array(bytes).buffer, { status });
}

describe("extractImageUrls", () => {
  it("extracts markdown image URLs from body and comments, deduplicated", () => {
    const c = ctx("![a](https://x.com/1.png) hello ![b](https://x.com/2.jpg)", [
      "see ![c](https://x.com/3.webp) and again ![a](https://x.com/1.png)",
    ]);
    expect(extractImageUrls(c)).toEqual([
      "https://x.com/1.png",
      "https://x.com/2.jpg",
      "https://x.com/3.webp",
    ]);
  });

  it("ignores non-image and unsupported URL forms", () => {
    expect(extractImageUrls(ctx("no image here\nhttps://plain.com/img.png"))).toEqual([]);
  });
});

describe("collectIssueImages", () => {
  it("downloads valid PNG and emits a data URL part", async () => {
    const result = await collectIssueImages(
      ctx("![p](https://x.com/a.png)"),
      {
        fetchImpl: async (url) => {
          expect(url).toBe("https://x.com/a.png");
          return bytesResponse(PNG_HEADER);
        },
      },
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.type).toBe("image_url");
    expect(result.images[0]!.image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(result.degraded).toHaveLength(0);
  });

  it("falls back to the raw image URL when download/validation fails (方案 A)", async () => {
    const calls = new Map<string, Response>([
      ["https://x.com/bad.gif", bytesResponse([0x47, 0x49, 0x46] /* gif */)],
    ]);
    const result = await collectIssueImages(
      ctx("![g](https://x.com/bad.gif) ![missing](https://x.com/nope.png)"),
      {
        fetchImpl: async (url) => {
          const r = calls.get(url);
          if (!r) return bytesResponse([], 404);
          return r;
        },
      },
    );
    // 失败的图不再丢弃，而是以原始 URL 交给模型网关抓取。
    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.image_url.url).toBe("https://x.com/bad.gif");
    expect(result.images[1]!.image_url.url).toBe("https://x.com/nope.png");
    expect(result.degraded.join(",")).toContain("image_via_url:unsupported_format");
    expect(result.degraded.join(",")).toContain("image_via_url:fetch_failed");
  });

  it("caps how many images are sent", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://x.com/${i}.png`);
    const body = urls.map((u) => `![${u}](${u})`).join(" ");
    const result = await collectIssueImages(ctx(body), {
      limits: { maxImages: 2 },
      fetchImpl: async () => bytesResponse(PNG_HEADER),
    });
    expect(result.images).toHaveLength(2);
  });
});

describe("image response body deadline", () => {
  it("keeps the timeout active until the response body is consumed", async () => {
    vi.useFakeTimers();
    try {
      let downloadSignal: AbortSignal | undefined;
      let readingBody = false;
      const resultPromise = collectIssueImages(
        ctx("![p](https://x.com/stalled.png)"),
        {
          limits: { fetchTimeoutMs: 30, downloadAttempts: 1 },
          fetchImpl: async (_url, init) => {
            downloadSignal = init?.signal;
            return {
              ok: true,
              arrayBuffer: () => {
                readingBody = true;
                return new Promise<ArrayBuffer>((_resolve, reject) => {
                  init?.signal?.addEventListener(
                    "abort",
                    () =>
                      reject(
                        new DOMException("download timed out", "AbortError"),
                      ),
                    { once: true },
                  );
                });
              },
            } as Response;
          },
        },
      );
      await vi.advanceTimersByTimeAsync(30);
      expect(readingBody).toBe(true);
      expect(downloadSignal?.aborted).toBe(true);
      const result = await resultPromise;
      expect(result.images[0]?.image_url.url).toBe("https://x.com/stalled.png");
      expect(result.degraded.join(",")).toContain("image_via_url:fetch_failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
