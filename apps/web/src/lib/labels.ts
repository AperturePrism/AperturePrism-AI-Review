/**
 * 界面展示用的中文文案映射（仅用于显示，不改变存储/传输值）。
 *
 * 角色名、枚举选项值、Issue 分类等在系统里是稳定英文字面量（写库/写 GitHub 标签
 * 都用它们），但直接上屏太英文。这里统一放一份"英文值 → 中文展示"的映射，
 * 替换时 guarantee 值不变、只改显示。
 */

export const MODEL_ROLE_LABELS: Record<string, string> = {
  issue_analysis: "Issue 分析",
  pr_review: "PR 审查",
  spam_detection: "广告/垃圾检测",
  duplicate_judgment: "重复判断",
  memory_consolidation: "记忆整合",
  expert_review: "专家复核",
  issue_analysis_vision: "Issue 图片多模态",
};

export function modelRoleLabel(role: string): string {
  return MODEL_ROLE_LABELS[role] ?? role;
}

/** 枚举设置项：值 → 中文展示。键位与 settings-registry 的 options 对应。 */
const ENUM_OPTION_LABELS: Record<string, Record<string, string>> = {
  spam_handling: { none: "不处理", close: "关闭", delete: "删除" },
  issue_prompt_mode: { adaptive: "自适应", light: "轻量", full: "全量" },
  repo_sync_scope: {
    metadata: "仅元数据",
    issues_pr: "元数据 + Issue/PR",
    full: "全量含源码",
  },
  log_level: {
    fatal: "致命",
    error: "错误",
    warn: "警告",
    info: "信息",
    debug: "调试",
    trace: "跟踪",
    silent: "静默",
  },
  scan_mode: { full: "全量", history: "增量" },
  agent_plan_mode: { auto: "自动", manual: "手动" },
  review_rules_global_tier: {
    standard: "标准 · 16000 字符",
    extended: "扩展 · 32000 字符",
    large: "大型 · 64000 字符",
  },
};

export function enumOptionLabel(settingKey: string, value: string): string {
  return ENUM_OPTION_LABELS[settingKey]?.[value] ?? value;
}

/** Issue 分类值 → 中文展示（结果卡/过滤用，不改变 category 存储）。 */
export const ISSUE_CATEGORY_LABELS: Record<string, string> = {
  bug: "缺陷",
  feature: "功能请求",
  security: "安全",
  performance: "性能",
  question: "提问",
  documentation: "文档",
  other: "其他",
};

export function issueCategoryLabel(category: string): string {
  return ISSUE_CATEGORY_LABELS[category] ?? category;
}

/**
 * 常用建议标签显示名（展示专用，不改变落库/贴到 GitHub 的标签字面量）。
 * 仅覆盖已知的常用标签；未知的一律原样展示，避免误导。
 */
export const SUGGESTED_LABEL_LABELS: Record<string, string> = {
  bug: "缺陷",
  feature: "功能请求",
  security: "安全",
  performance: "性能",
  question: "提问",
  documentation: "文档",
  dependency: "依赖",
  testing: "测试",
  refactor: "重构",
  enhancement: "增强",
  s1: "严重",
  s2: "中等",
  s3: "轻微",
};

export function suggestedLabelLabel(name: string): string {
  return SUGGESTED_LABEL_LABELS[name.toLowerCase()] ?? name;
}