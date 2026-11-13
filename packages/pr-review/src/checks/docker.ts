/** 容器构建检查：只对新增 Dockerfile 指令作提醒，证据在公共入口统一脱敏。 */
import type { ReviewCheck, CheckObservationInput } from "../checks.js";

const check: ReviewCheck = {
  description: "核对 Dockerfile 中凭据、远程 ADD 和过宽的文件复制",
  matches: (path) =>
    /(^|\/)(?:Dockerfile(?:\.[^/]+)?|[^/]+\.Dockerfile)$/iu.test(path),
  run(file) {
    const results: CheckObservationInput[] = [];
    for (const line of file.lines) {
      if (!line.changed || /^\s*#/u.test(line.text)) continue;
      const instruction = /^\s*([A-Z]+)\s+(.+)$/iu.exec(line.text);
      if (!instruction) continue;
      const name = instruction[1]!.toUpperCase();
      const value = instruction[2]!;
      if (
        (name === "ARG" || name === "ENV") &&
        /\b(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|PRIVATE_KEY|API_KEY)[A-Z0-9_]*)\s*(?:=\s*[^\s]+|\s+[^\s]+)/iu.test(
          value,
        )
      ) {
        results.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "container",
          nature: "heuristic",
          title: "构建参数或环境变量包含敏感名称及字面值",
          message:
            "ARG/ENV 可能进入镜像元数据、层历史或构建日志；敏感名称不证明该值一定是真实凭据。",
          evidence: line.text,
          recommendation:
            "确认值是否为真实秘密；构建时使用 BuildKit secret mount，运行时由部署系统注入凭据。",
        });
      }
      if (
        name === "ADD" &&
        /\bhttps?:\/\//iu.test(value) &&
        !/--checksum(?:=|\s)/u.test(value)
      ) {
        results.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "container",
          nature: "configuration_fact",
          title: "远程 ADD 没有声明内容校验",
          message:
            "远程下载内容不带显式 checksum；同一 Dockerfile 在不同时间可能得到不同的构建输入。",
          evidence: line.text,
          recommendation:
            "使用受支持的 ADD --checksum，或先下载并核验固定摘要；核对 Dockerfile frontend 版本。",
        });
      }
      if (
        (name === "COPY" || name === "ADD") &&
        /(?:^|\s)(?:\.env(?:\.[^\s]+)?|[^\s]*\.(?:pem|key)|id_rsa)(?:\s|$)/u.test(
          value,
        )
      ) {
        results.push({
          path: file.path,
          line: line.number,
          level: "warning",
          category: "container",
          nature: "heuristic",
          title: "镜像复制了可能含凭据的文件",
          message:
            "新增复制源包含 .env、私钥后缀或常见 SSH 私钥名，需要确认其内容和最终镜像阶段。",
          evidence: line.text,
          recommendation:
            "把运行时秘密留在镜像之外，检查 .dockerignore、多阶段构建和发布层中的实际内容。",
        });
      }
    }
    return results;
  },
};
export default check;
