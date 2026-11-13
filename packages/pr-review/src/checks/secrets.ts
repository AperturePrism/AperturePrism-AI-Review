/** 秘密形状检查：只输出脱敏证据，匹配样式不等于确认令牌有效。 */
import {
  redactCheckEvidence,
  type ReviewCheck,
  type CheckObservationInput,
} from "../checks.js";

const check: ReviewCheck = {
  description: "检查新增文本中的令牌形状和私钥头，证据统一脱敏",
  matches: (path) =>
    !/(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(path),
  run(file) {
    const result: CheckObservationInput[] = [];
    for (const line of file.lines) {
      if (!line.changed) continue;
      const token =
        /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/u.exec(
          line.text,
        );
      const privateKey =
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(line.text);
      if (!token && !privateKey) continue;
      result.push({
        path: file.path,
        line: line.number,
        level: "warning",
        category: "secret",
        nature: "heuristic",
        title: privateKey ? "新增内容包含私钥头" : "新增内容匹配常见令牌形状",
        message:
          "匹配仅说明文本形状，未尝试认证或验证有效性。报告不会保存匹配到的秘密原文。",
        evidence: redactCheckEvidence(line.text),
        recommendation:
          "确认是否为测试样例；若是真实秘密，立即轮换并按仓库流程清理历史，不要只删除当前行。",
      });
    }
    return result;
  },
};
export default check;
