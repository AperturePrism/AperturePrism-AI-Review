/** 敏感路径提醒：不推断鉴权漏洞，明确指出需要额外核对的权限相关改动。 */
import type { ReviewCheck, CheckObservationInput } from "../checks.js";

const check: ReviewCheck = {
  description: "提醒核对认证、权限、会话和支付路径中的实际变更",
  matches: (path) =>
    /(^|\/)(?:auth[^/]*|permissions?[^/]*|sessions?[^/]*|credentials?[^/]*|payments?[^/]*)(\/|\.)/iu.test(
      path,
    ),
  run(file) {
    const line = file.lines.find(
      (entry) =>
        entry.changed &&
        entry.text.trim() &&
        !/^\s*(?:\/\/|#|\*)/u.test(entry.text),
    );
    if (!line) return [];
    const result: CheckObservationInput = {
      path: file.path,
      line: line.number,
      level: "info",
      category: "access",
      nature: "review_reminder",
      title: "认证、权限或其他敏感路径发生变化",
      message:
        "路径名称提示此处可能影响身份或权限；文件名不能证明存在缺陷，需检查真实调用路径。",
      evidence: line.text,
      recommendation:
        "核对未认证、普通用户、跨账户/跨仓库和管理员场景，以及会话失效、角色降级和失败路径。",
    };
    return [result];
  },
};
export default check;
