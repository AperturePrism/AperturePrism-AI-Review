/**
 * 浏览器中的发现导入边界：读取 SARIF 2.1.0 或工作台 JSON，不执行内容中的任何代码。
 * @example const preview = parseFindingImport(fileText, 'sarif', 'main');
 * const saved = await workbench.importFindings(repository, preview.findings);
 */
import type { Severity } from "./workbench";
export type ImportedFinding = {
  title: string;
  description: string;
  ruleId: string;
  path: string;
  line: number;
  endLine: number;
  severity: Severity;
  confidence: number;
  source: string;
  reference: string;
  tags: string[];
  fingerprint?: string;
};
export type ImportPreview = {
  findings: ImportedFinding[];
  warnings: string[];
  skipped: number;
};
const LEVELS: Record<string, Severity> = {
  error: "high",
  warning: "medium",
  note: "low",
  none: "info",
};
const SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);
const MAX_FINDINGS = 5_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function records(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}
function optionalRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}
function line(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("发现行号必须是正整数");
  return Number(value);
}
function filePath(value: unknown): string {
  let path = text(value);
  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error("文件路径包含无效 URI 编码");
  }
  path = path.replace(/\\/g, "/").replace(/^\.\//, "");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(path) ||
    path.split("/").some((part) => part === ".." || !part) ||
    // 显式拒绝路径中的控制字符，防止导入产生不可见或截断的文件名。
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f]/.test(path)
  ) {
    throw new Error("发现必须使用仓库内相对文件路径");
  }
  return path;
}
function severity(
  properties: Record<string, unknown>,
  fallback: Severity,
): Severity {
  const direct = text(properties.severity).toLowerCase();
  if (SEVERITIES.has(direct)) return direct as Severity;
  const securityScore = Number(properties["security-severity"]);
  if (
    Number.isFinite(securityScore) &&
    properties["security-severity"] !== undefined
  ) {
    if (securityScore >= 9) return "critical";
    if (securityScore >= 7) return "high";
    if (securityScore >= 4) return "medium";
    if (securityScore > 0) return "low";
  }
  return fallback;
}
function confidence(value: unknown): number {
  if (value === undefined) return 1;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new Error("置信度必须在 0 到 1 之间");
  return value;
}
function fingerprint(value: unknown): string | undefined {
  const fingerprints = optionalRecord(value);
  const own = text(fingerprints["apertureprism/v1"]);
  return own || undefined; // 其他工具的指纹算法不同，交给后端按同一算法重新计算。
}
function sarifFindings(
  root: Record<string, unknown>,
  reference: string,
): ImportPreview {
  if (root.version !== "2.1.0") throw new Error("只支持 SARIF 2.1.0");
  const findings: ImportedFinding[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (const [runIndex, run] of records(root.runs, "runs").entries()) {
    const driver = optionalRecord(optionalRecord(run.tool).driver);
    const rules = Array.isArray(driver.rules)
      ? records(driver.rules, "tool.driver.rules")
      : [];
    const artifacts = Array.isArray(run.artifacts)
      ? records(run.artifacts, "artifacts")
      : [];
    for (const [resultIndex, result] of records(
      run.results ?? [],
      "results",
    ).entries()) {
      const label = `run ${runIndex + 1} / result ${resultIndex + 1}`;
      if (!Array.isArray(result.locations) || result.locations.length === 0) {
        skipped += 1;
        warnings.push(`${label} 没有文件位置，未导入`);
        continue;
      }
      const location = optionalRecord(result.locations[0]);
      const physical = optionalRecord(location.physicalLocation);
      const artifact = optionalRecord(physical.artifactLocation);
      const indexed = Number.isSafeInteger(artifact.index)
        ? optionalRecord(artifacts[Number(artifact.index)]?.location)
        : {};
      const region = optionalRecord(physical.region);
      const rule = Number.isSafeInteger(result.ruleIndex)
        ? (rules[Number(result.ruleIndex)] ?? {})
        : {};
      const ruleId =
        text(result.ruleId) || text(rule.id) || text(driver.name, "sarif");
      const properties = {
        ...optionalRecord(rule.properties),
        ...optionalRecord(result.properties),
      };
      const message = optionalRecord(result.message);
      const description = text(message.text) || text(message.markdown);
      if (!description) {
        skipped += 1;
        warnings.push(`${label} 没有问题说明，未导入`);
        continue;
      }
      const start = line(region.startLine, 1);
      const end = line(region.endLine, start);
      if (end < start) throw new Error(`${label} 的结束行早于起始行`);
      const stable = fingerprint(result.partialFingerprints);
      findings.push({
        title: description.split("\n")[0]!.slice(0, 500),
        description: description.slice(0, 20_000),
        ruleId,
        path: filePath(artifact.uri ?? indexed.uri),
        line: start,
        endLine: end,
        severity: severity(properties, LEVELS[text(result.level)] ?? "medium"),
        confidence: confidence(properties.confidence),
        source: text(driver.name, "sarif"),
        reference: reference || text(properties.reference),
        tags: ["sarif-import"],
        ...(stable ? { fingerprint: stable } : {}),
      });
      if (findings.length > MAX_FINDINGS)
        throw new Error(`一次最多导入 ${MAX_FINDINGS} 个发现`);
      if (Array.isArray(result.suppressions) && result.suppressions.length)
        warnings.push(`${label} 含外部抑制说明；不会自动转为本仓库的抑制规则`);
    }
  }
  return { findings, warnings, skipped };
}
function jsonFindings(value: unknown, reference: string): ImportPreview {
  const root = Array.isArray(value) ? value : optionalRecord(value).findings;
  const findings = records(root, "findings").map((item): ImportedFinding => {
    const title = text(item.title);
    const ruleId = text(item.ruleId);
    if (!title || !ruleId) throw new Error("每个发现均需 title 和 ruleId");
    const start = line(item.line, 1);
    const end = line(item.endLine, start);
    if (end < start) throw new Error("发现结束行不能早于起始行");
    const level = text(item.severity, "medium");
    if (!SEVERITIES.has(level)) throw new Error(`未知发现级别：${level}`);
    const tags = Array.isArray(item.tags)
      ? item.tags.map((tag) => text(tag)).filter(Boolean)
      : [];
    const stable = text(item.fingerprint);
    return {
      title,
      description: text(item.description),
      ruleId,
      path: filePath(item.path),
      line: start,
      endLine: end,
      severity: level as Severity,
      confidence: confidence(item.confidence),
      source: text(item.source, "json-import"),
      reference: reference || text(item.reference),
      tags,
      ...(stable ? { fingerprint: stable } : {}),
    };
  });
  if (findings.length > MAX_FINDINGS)
    throw new Error(`一次最多导入 ${MAX_FINDINGS} 个发现`);
  return { findings, warnings: [], skipped: 0 };
}

/**
 * 先完整验证，再给出预览。任何无效文件路径或范围都会阻止整个导入。
 * SARIF 位置缺失单独列为跳过，只有用户看过预览后才允许提交。
 */
export function parseFindingImport(
  content: string,
  format: "sarif" | "json",
  reference = "",
): ImportPreview {
  if (new TextEncoder().encode(content).byteLength > 2 * 1024 * 1024)
    throw new Error("导入文本不得超过 2 MiB");
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("导入内容不是合法 JSON");
  }
  const preview =
    format === "sarif"
      ? sarifFindings(record(value, "SARIF"), reference.trim())
      : jsonFindings(value, reference.trim());
  const unique = new Map<string, ImportedFinding>();
  for (const finding of preview.findings) {
    const key =
      finding.fingerprint ??
      JSON.stringify([
        finding.ruleId.toLowerCase(),
        finding.path,
        finding.title.toLowerCase().replace(/\s+/g, " "),
      ]);
    if (unique.has(key)) {
      preview.skipped += 1;
      preview.warnings.push(`重复发现已合并：${finding.title}`);
    } else unique.set(key, finding);
  }
  preview.findings = [...unique.values()];
  return preview;
}
