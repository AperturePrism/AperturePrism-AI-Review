import type { ModelImagePart } from "../../../packages/domain/src/index.js";
import type { IssueContext } from "./context.js";

/**
 * Issue 多模态图片采集（Phase 1，基于 Sakura-AI PR #545 的图片多模态能力思路）。
 *
 * 仅做"下载 → 校验格式/大小 → 转 base64 data URL"，不引入 sharp 压缩（压缩属于
 * Phase 2）。超过单张 / 总量上限、或格式不受支持、或下载失败的图片一律跳过并记入
 * degraded，绝不因为某张图失败而打断整个分析 —— 文本分析总能继续。
 */

export const ISSUE_IMAGE_LIMITS = {
  /** 单个 Issue 最多采集的图片数。 */
  maxImages: 20,
  /** 全部图片 base64 前原始字节的总量上限（≈15 MiB）。 */
  maxTotalBytes: 15 * 1024 * 1024,
  /** 单张图片的字节上限（≈5 MiB）；超过则跳过，Phase 2 才做压缩。 */
  maxSingleBytes: 5 * 1024 * 1024,
  /** 每张图片下载的硬超时。 */
  fetchTimeoutMs: 10_000,
  /** 单张图片直接下载的最大尝试次数（github.com 访问常间歇性被墙，重试一次）。 */
  downloadAttempts: 3,
} as const;

export type CollectedImages = {
  images: readonly ModelImagePart[];
  degraded: readonly string[];
};

type ImageFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

/** 采集上限参数（可覆盖），数值一律按 number，便于测试传任意小上限。 */
export type IssueImageLimits = {
  maxImages: number;
  maxTotalBytes: number;
  maxSingleBytes: number;
  fetchTimeoutMs: number;
  downloadAttempts: number;
};

/** 匹配 markdown 图片 `![alt](https://...)`，Phase 1 只处理 http(s) 外链图。 */
const IMAGE_URL_RE = /!\[[^\]]*]\(\s*(https?:\/\/[^)\s]+)\s*\)/g;

function addUrls(target: string[], text: string): void {
  for (const match of text.matchAll(IMAGE_URL_RE)) {
    const url = match[1];
    if (url && !target.includes(url)) target.push(url);
  }
}

/** 从 Issue 正文 + 评论里提取所有 markdown 图片 URL（去重，保序）。 */
export function extractImageUrls(
  context: Pick<IssueContext, "issue" | "comments">,
): string[] {
  const urls: string[] = [];
  addUrls(urls, context.issue.body ?? "");
  for (const comment of context.comments) addUrls(urls, comment.body);
  return urls;
}

/** 仅凭字节魔数识别 JPEG / PNG / WebP；不命中返回 null（视为不支持格式）。 */
function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  )
    return "image/webp";
  return null;
}

function shortUrl(url: string): string {
  return url.length <= 48 ? url : `${url.slice(0, 24)}…${url.slice(-20)}`;
}

/**
 * 下载并校验 Issue 中的图片，转成 OpenAI image_url data URL 块。
 * 任何失败都被降级（记入 degraded）而非抛出，保证分析不受单张图影响。
 */
export async function collectIssueImages(
  context: Pick<IssueContext, "issue" | "comments">,
  opts: {
    fetchImpl?: ImageFetch;
    limits?: Partial<IssueImageLimits>;
  } = {},
): Promise<CollectedImages> {
  const limits = { ...ISSUE_IMAGE_LIMITS, ...(opts.limits ?? {}) } as IssueImageLimits;
  const fetchImpl: ImageFetch = opts.fetchImpl ?? fetch;
  const images: ModelImagePart[] = [];
  const degraded: string[] = [];
  let totalBytes = 0;

  const urls = extractImageUrls(context).slice(0, limits.maxImages);
  for (const url of urls) {
    if (images.length >= limits.maxImages) break;
    if (totalBytes >= limits.maxTotalBytes) {
      degraded.push("image_total_too_large");
      break;
    }
    // 方案 A：本地能下载并校验就用 data URL（可控大小/格式）；下载或校验失败的
    // 图片不再丢弃，而是把原始 URL 直接交给模型网关去抓取（image_url 支持 http）
    // —— 解决容器无法访问 github.com 等图片宿主时图片完全用不上的问题。原始 URL
    // 无法计量字节，只按张数计入 maxImages。
    const fallbackToUrl = (reason: string) => {
      images.push({ type: "image_url", image_url: { url } });
      degraded.push(`image_via_url:${reason}:${shortUrl(url)}`);
    };
    // 先尝试直接下载（github.com 访问间歇被墙，重试几次）；多次失败才回退 URL。
    let buffer: Uint8Array | null = null;
    let downloadResult: "ok" | "fetch_failed" = "fetch_failed";
    for (
      let attempt = 0;
      attempt < limits.downloadAttempts && buffer === null;
      attempt += 1
    ) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, { signal: controller.signal });
        if (response.ok) {
          buffer = new Uint8Array(await response.arrayBuffer());
          downloadResult = "ok";
        }
      } catch {
        // transient; retry
      } finally {
        // fetch resolves at headers; keep the deadline while reading the body.
        clearTimeout(timer);
      }
    }
    if (!buffer) {
      fallbackToUrl(downloadResult);
      continue;
    }
    if (buffer.length > limits.maxSingleBytes) {
      fallbackToUrl("too_large");
      continue;
    }
    if (totalBytes + buffer.length > limits.maxTotalBytes) {
      degraded.push("image_total_too_large");
      break;
    }
    const mime = sniffMime(buffer);
    if (!mime) {
      fallbackToUrl("unsupported_format");
      continue;
    }
    const base64 = Buffer.from(buffer).toString("base64");
    images.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    });
    totalBytes += buffer.length;
  }

  return { images, degraded };
}