/** 后台仓库规则保留原有截断语义；共享下载器负责所有 URL 与传输校验。 */
import { fetchPublicRuleSourceText } from "../../../packages/github-adapter/src/rule-source.js";

export async function fetchExternalRepoRulesText(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await fetchPublicRuleSourceText(rawUrl, {
    ...(signal ? { signal } : {}),
    maxBytes: 256_000,
    strictUtf8: false,
    rejectTruncation: false,
  });
  if (!result.content.trim()) return undefined;
  return result.truncated
    ? `${result.content}\n\n（内容过长，已截断）`
    : result.content;
}
