/**
 * Issue 分诊：从实际文字提取复现完整度、环境和待补信息，输出可解释的人工队列。
 * 用法：const triage = assessIssueTriage(context); renderIssueTriage(triage)。
 * 评分衡量报告可操作性，不代表缺陷严重度，也不自动关闭或指派 Issue。
 */
import type { IssueContext } from "./context.js";

export type TriageField =
  | "reproduction"
  | "expected"
  | "actual"
  | "environment"
  | "version"
  | "diagnostic";
export type TriageFact = {
  field: TriageField;
  found: boolean;
  excerpt: string | null;
  source: string | null;
};
export type TriageRule = {
  id: string;
  labels?: readonly string[];
  words?: readonly string[];
  queue: string;
  /** 所有命中规则中较大的数先排，数值相同时保持配置顺序。 */
  priority?: number;
};
export type IssueTriagePolicy = {
  requiredFields?: readonly TriageField[];
  rules?: readonly TriageRule[];
  maxExcerptChars?: number;
};
export type IssueTriage = {
  version: "issue-triage/v1";
  score: number;
  readiness: "ready" | "needs_information";
  facts: TriageFact[];
  missing: TriageField[];
  questions: string[];
  queue: string;
  matchedRules: string[];
  sensitive: boolean;
  warnings: string[];
};

const fieldRules: readonly {
  field: TriageField;
  pattern: RegExp;
  question: string;
  weight: number;
}[] = [
  {
    field: "reproduction",
    pattern:
      /(?:steps?\s+to\s+repro(?:duce)?|reproduction|复现(?:步骤|方法)|重现(?:步骤|方法)|^\s*1[.)、]\s*\S)/imu,
    question: "请提供从初始状态开始、可以重复执行的复现步骤。",
    weight: 25,
  },
  {
    field: "expected",
    pattern:
      /(?:expected\s+(?:behaviou?r|result|output)|预期(?:行为|结果|输出)|期望(?:行为|结果))/iu,
    question: "按相同步骤操作时，你预期得到什么结果？",
    weight: 15,
  },
  {
    field: "actual",
    pattern:
      /(?:actual\s+(?:behaviou?r|result|output)|实际(?:行为|结果|输出)|unexpected|报错|崩溃|crash(?:es|ed)?|error\s*[:：])/iu,
    question: "实际发生了什么？请粘贴完整错误文字。",
    weight: 20,
  },
  {
    field: "environment",
    pattern:
      /(?:\b(?:windows|linux|macos|android|ios|ubuntu|debian|docker|chrome|firefox|safari)\b|操作系统|运行环境)/iu,
    question: "请提供操作系统、运行方式和有关的浏览器或运行时版本。",
    weight: 10,
  },
  {
    field: "version",
    pattern:
      /(?:\bv?\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\b|版本\s*[:：]\s*\S|commit\s*[:：]?\s*[a-f0-9]{7,40}\b)/iu,
    question: "请提供应用版本或提交号，并说明是否也能在当前版本复现。",
    weight: 10,
  },
  {
    field: "diagnostic",
    pattern:
      /(?:```[\s\S]*?```|stack\s*trace|traceback|堆栈|日志\s*[:：]|\bat\s+[\w./$]+\s*\()/iu,
    question: "请补充脱敏后的错误日志、堆栈或最小复现，避免发送令牌和密码。",
    weight: 20,
  },
];

function validatePolicy(policy: IssueTriagePolicy): void {
  if (
    policy.maxExcerptChars !== undefined &&
    (!Number.isInteger(policy.maxExcerptChars) ||
      policy.maxExcerptChars < 20 ||
      policy.maxExcerptChars > 2000)
  ) {
    throw new Error("maxExcerptChars must be an integer between 20 and 2000");
  }
  const fields = new Set(fieldRules.map((rule) => rule.field));
  for (const field of policy.requiredFields ?? [])
    if (!fields.has(field)) throw new Error(`Unknown triage field: ${field}`);
  const ids = new Set<string>();
  for (const rule of policy.rules ?? []) {
    if (!rule.id.trim() || !rule.queue.trim() || ids.has(rule.id))
      throw new Error("Triage rules need a unique id and a non-empty queue");
    if (rule.priority !== undefined && !Number.isFinite(rule.priority))
      throw new Error("Triage priority must be finite");
    if (
      ![...(rule.labels ?? []), ...(rule.words ?? [])].some(
        (value) => value.trim().length > 0,
      )
    )
      throw new Error("Triage rule needs labels or words");
    ids.add(rule.id);
  }
}

/**
 * 只采纳有内容的模板节：例如空的「### 复现步骤」不能计为已经提供复现。
 * HTML 注释与模板中的 no response 也先去掉，避免模板噪声抬高分数。
 */
export function issueTriageText(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/gu, "")
    .split(/\r?\n/u)
    .filter((line, index, lines) => {
      if (/^\s*(?:_?no response_?|n\/?a|无|暂无|未提供)\s*$/iu.test(line))
        return false;
      if (!/^\s*#{1,6}\s/u.test(line)) return true;
      const nextHeading = lines.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && /^\s*#{1,6}\s/u.test(candidate),
      );
      const section = lines
        .slice(index + 1, nextHeading < 0 ? undefined : nextHeading)
        .join("\n")
        .trim();
      return (
        section.length > 0 &&
        !/^(?:_?no response_?|n\/?a|无|暂无|未提供)$/iu.test(section)
      );
    })
    .join("\n");
}

/** 规则只接受标签/字词，不执行正则或脚本，配置无法拖住服务线程。 */
export function assessIssueTriage(
  context: IssueContext,
  policy: IssueTriagePolicy = {},
): IssueTriage {
  validatePolicy(policy); // 配置是系统边界，集中校验一次。
  const documents = [
    {
      source: "issue",
      text: issueTriageText(`${context.issue.title}\n${context.issue.body}`),
    },
    ...context.comments.map((comment, index) => ({
      source: `comment:${index + 1}`,
      text: issueTriageText(comment.body),
    })),
  ];
  const facts = fieldRules.map((rule): TriageFact => {
    for (const document of documents) {
      const match = rule.pattern.exec(document.text);
      if (!match) continue;
      const lineStart = document.text.lastIndexOf("\n", match.index) + 1;
      const lineEnd = document.text.indexOf("\n", match.index);
      const excerpt = document.text
        .slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
        .slice(0, policy.maxExcerptChars ?? 200)
        .trim();
      return {
        field: rule.field,
        found: true,
        excerpt,
        source: document.source,
      };
    }
    return { field: rule.field, found: false, excerpt: null, source: null };
  });
  const required = policy.requiredFields ?? [
    "reproduction",
    "expected",
    "actual",
  ];
  const missing = [...new Set(required)].filter(
    (field) => !facts.some((fact) => fact.field === field && fact.found),
  );
  const text = documents
    .map((document) => document.text)
    .join("\n")
    .toLowerCase();
  const labels = new Set(
    context.issue.labels.map((label) => label.toLowerCase()),
  );
  const matched = (policy.rules ?? [])
    .filter(
      (rule) =>
        (rule.labels ?? []).some((label) =>
          labels.has(label.trim().toLowerCase()),
        ) ||
        (rule.words ?? []).some(
          (word) =>
            word.trim().length > 0 && text.includes(word.trim().toLowerCase()),
        ),
    )
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
  const sensitive =
    /(?:\b(?:credential|password|token|secret|vulnerability|exploit|cve-\d{4})\b|凭据|密码|令牌|漏洞|私钥)/iu.test(
      text,
    );
  const score = facts.reduce(
    (sum, fact) =>
      sum +
      (fact.found
        ? fieldRules.find((rule) => rule.field === fact.field)!.weight
        : 0),
    0,
  );
  return {
    version: "issue-triage/v1",
    score,
    readiness: missing.length === 0 ? "ready" : "needs_information",
    facts,
    missing,
    questions: missing.map(
      (field) => fieldRules.find((rule) => rule.field === field)!.question,
    ),
    queue: matched[0]?.queue ?? (sensitive ? "security-triage" : "general"),
    matchedRules: matched.map((rule) => rule.id),
    sensitive,
    warnings: [
      ...(context.degraded.length > 0
        ? ["输入经过裁剪；未命中只表示本次上下文未包含相关内容。"]
        : []),
      ...(sensitive
        ? ["涉及凭据或安全内容，公开回复前请人工确认脱敏和披露范围。"]
        : []),
      "完整度来自文字线索，不能代替复现或作为严重度依据。",
    ],
  };
}

/** 给人工分诊页/离线 CLI 复用的简短 Markdown，不生成自动关闭或指派动作。 */
export function renderIssueTriage(triage: IssueTriage): string {
  const lines = [
    `### 报告完整度：${triage.score}/100`,
    `分诊队列：${triage.queue.replace(/[\r\n]/gu, " ")}`,
  ];
  if (triage.questions.length > 0)
    lines.push(
      "",
      "待补信息：",
      ...triage.questions.map((question) => `- ${question}`),
    );
  lines.push("", ...triage.warnings.map((warning) => `> ${warning}`));
  return lines.join("\n");
}
