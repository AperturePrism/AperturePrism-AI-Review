/**
 * 设置注册表：所有可配置运行时设置的唯一事实源。
 *
 * 零 drizzle 依赖 —— 6 个进程与 WebUI 类型都要引用它，也要能在本机（SMB 上装
 * 不了依赖）单测。数据库读写在 packages/database 的 settings-store。
 *
 * 每个键在这里声明一次：分组、类型、默认值、是否可按仓库覆盖、env 兜底名、是否
 * 密钥、热更新方式、中文文案、解析规则。四份名单（写白名单 / 密钥集 / GET 列表 /
 * 仓库级白名单）全部由它派生 —— 此前它们各写一处、已经漂移（pr_check_run 一度
 * 能画开关却存不了就是症状）。
 */

/** 设置值的形态，驱动 WebUI 用什么控件渲染。 */
export type SettingKind =
  | "boolean"
  | "string"
  | "secret"
  | "enum"
  | "number"
  | "multicheck";

/**
 * 热更新方式，如实告诉用户改完要不要重启。
 * - `poll`：api 每 8 秒轮询，或 worker 每轮 pass 重新读，保存即近实时生效。
 * - `restart`：进程只在启动时读一次，改完必须重启对应容器。
 */
export type SettingHotReload = "poll" | "restart";

export type SettingGroup =
  | "github"
  | "auth"
  | "issue"
  | "pr"
  | "embedding"
  | "qq"
  | "ops";

export type SettingSpec = {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  /** 是否密钥：驱动 GET 掩码与备份排除。 */
  secret: boolean;
  /** 是否可按仓库覆盖。 */
  repoScoped: boolean;
  /** 引导期兜底的 env 变量名；null 表示没有 env 对应项。 */
  envVar: string | null;
  hotReload: SettingHotReload;
  label: string;
  hint: string;
  /** enum / multicheck 的合法取值（仅这两种 kind 有意义）。 */
  options?: readonly string[];
};

/**
 * 注册表本体。顺序即 WebUI 内分组内的展示顺序。
 *
 * 默认值不写在这里，而是各类型解析函数的第三参数 —— 因为默认值的语义和类型强
 * 绑定（布尔默认开还是关、数字默认阈值多少），集中在解析函数里更不容易和读取点
 * 分叉。见文件末尾 DEFAULTS。
 */
export const SETTINGS_REGISTRY: readonly SettingSpec[] = [
  // ── GitHub 接入 ──
  {
    key: "github_webhook_enabled",
    group: "github",
    kind: "boolean",
    secret: false,
    repoScoped: false,
    envVar: null, // 无直接 env；未覆盖时默认跟随「是否配了 webhook secret」
    hotReload: "poll",
    label: "Webhook 开关",
    hint: "启用 / 停用 GitHub 事件入口；未覆盖时跟随是否配置了签名密钥",
  },
  {
    key: "github_webhook_secret",
    group: "github",
    kind: "secret",
    secret: true,
    repoScoped: false,
    envVar: "GITHUB_WEBHOOK_SECRET",
    hotReload: "poll",
    label: "Webhook 签名密钥",
    hint: "留空则回退到环境变量；保存后无需重启即生效",
  },
  {
    key: "github_app_id",
    group: "github",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "GITHUB_APP_ID",
    hotReload: "poll",
    label: "GitHub App ID",
    hint: "一串数字（App 设置页顶部，不是 Client ID）；建议用「配置 GitHub App」表单一并保存并验证",
  },
  {
    key: "github_app_private_key",
    group: "github",
    kind: "secret",
    secret: true,
    repoScoped: false,
    envVar: "GITHUB_APP_PRIVATE_KEY_PATH", // env 存路径，DB 存 AES-GCM 密文
    hotReload: "poll",
    label: "GitHub App 私钥",
    hint: "AES-GCM 加密存储，仅进程内解密；请用「配置 GitHub App」表单粘贴 .pem 全文",
  },
  {
    key: "repo_sync_scope",
    group: "github",
    kind: "enum",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "同步范围",
    hint: "同步仓库时拉取的数据深度：仅元数据 / 元数据+Issue+PR（触发一次扫描）/ 全量含源码（再触发索引）",
    options: ["metadata", "issues_pr", "full"],
  },
  // ── WebUI 认证 ──
  {
    key: "webui_api_token",
    group: "auth",
    kind: "secret",
    secret: true,
    repoScoped: false,
    envVar: "WEBUI_API_TOKEN",
    hotReload: "poll",
    label: "WebUI 访问令牌",
    hint: "留空则用环境变量；改为新值后本次会话会被登出，下次用新 token 进入",
  },
  {
    key: "oauth_client_id",
    group: "auth",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "GITHUB_OAUTH_CLIENT_ID",
    hotReload: "poll",
    label: "GitHub OAuth Client ID",
    hint: "仅用于 WebUI 登录，与仓库访问用的 GitHub App 无关；留空则用环境变量",
  },
  {
    key: "oauth_client_secret",
    group: "auth",
    kind: "secret",
    secret: true,
    repoScoped: false,
    envVar: "GITHUB_OAUTH_CLIENT_SECRET",
    hotReload: "poll",
    label: "GitHub OAuth Client Secret",
    hint: "留空则用环境变量；可在安装向导的 GitHub 接入步骤自动生成",
  },
  // ── Issue 分析 ──
  {
    key: "repo_rules_enabled",
    group: "issue",
    kind: "boolean",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "仓库审核规则",
    hint: "开启后读取仓库 .apertureprism/rules/ 目录下的规则文件并注入 Issue/PR 分析；仓库首次分析时若目录不存在会自动创建示例规则文件。可在此设全局默认，也可在「已安装仓库」页按仓库单独覆盖",
  },
  {
    key: "spam_handling",
    group: "issue",
    kind: "enum",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "广告 Issue 处理",
    hint: "none 不处理 / close 关闭 / delete 删除；分析前自识别广告类 Issue。可在此设全局默认，也可在「已安装仓库」页按仓库单独覆盖",
    options: ["none", "close", "delete"],
  },
  {
    key: "issue_auto_assign",
    group: "issue",
    kind: "boolean",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "Issue 自动指派",
    hint: "分析完成后自动指派；留空指派对象时默认仓库所有者与协作者，并跳过作者本人",
  },
  {
    key: "issue_assignee",
    group: "issue",
    kind: "string",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "Issue 指派对象",
    hint: "GitHub 用户名；留空则默认指派给仓库所有者与协作者",
  },
  {
    key: "issue_rewrite_title",
    group: "issue",
    kind: "boolean",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "Issue 标题改写",
    hint: "把含糊标题改写为 [标签][重要度]清晰标题，方便在列表页判断内容；默认开启",
  },
  {
    key: "issue_deep_analysis",
    group: "issue",
    kind: "boolean",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "Issue 深度分析（读取源码）",
    hint: "读取仓库源码定位问题，给出到文件的修复建议；明显增加用时与 token，且需模型网关支持 tools/function calling",
  },
  {
    key: "issue_use_unified_sections",
    group: "issue",
    kind: "boolean",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "Issue 通用区块（统一结果区块）",
    hint: "开启后该仓库所有 Issue 一律使用「分析设置 → Issue 结果区块（通用）」这一组，不再按功能请求 / 缺陷分类区分；默认关闭，维持按分类选择",
  },
  {
    key: "issue_vision_enabled",
    group: "issue",
    kind: "boolean",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "Issue 图片多模态分析",
    hint: "把 Issue 正文 / 评论里 markdown 图片下载后随分析一起发给模型（需模型支持视觉）。默认开启；开启会显著增加 token 与耗时",
  },
  {
    key: "issue_reanalyze_min_change",
    group: "issue",
    kind: "number",
    secret: false,
    repoScoped: true,
    envVar: null,
    hotReload: "poll",
    label: "重新分析的最小变化幅度",
    hint: "编辑 Issue 后正文变化低于该比例就不重新分析（0-1，默认 0.1）；新开 / 重开 / 手动触发不受限",
  },
  {
    key: "issue_prompt_version",
    group: "issue",
    kind: "enum",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "Issue 提示词版本",
    hint: "在线切换 Issue 分析的系统提示词版本；新版翻车时可改回历史版本回滚，无需重新部署",
    options: ["v4", "v5", "v6", "v7", "v8", "v9"],
  },
  {
    key: "issue_prompt_mode",
    group: "issue",
    kind: "enum",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "Issue 提示词模式",
    hint: "自适应（feature 轻量、缺陷全量）/ 轻量（所有类型都轻量）/ 全量（所有类型深度分析、用足仓库上下文）",
    options: ["adaptive", "light", "full"],
  },
  {
    key: "issue_result_sections",
    group: "issue",
    kind: "multicheck",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "Issue 结果区块（通用）",
    hint: "兜底的一组区块：作为非 bug/feature 类 Issue（question/security/performance/…）与未单独配置分类时使用的默认组。勾选的分析结果区块会展示，未勾选的不输出",
    // 取值与 issue-analysis 的 ISSUE_RESULT_SECTIONS 保持一致（逗号分隔多选）。
    options: [
      "summary",
      "suggested_title",
      "probable_cause",
      "troubleshooting",
      "evidence",
      "missing_information",
      "suggested_labels",
      "proposed_changes",
      "suggested_actions",
      "suggested_assignee",
    ],
  },
  {
    key: "issue_result_sections_bug",
    group: "issue",
    kind: "multicheck",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "Issue 结果区块（缺陷类）",
    hint: "仅针对 bug / security / performance 等缺陷类 Issue 生效的区块组；留空则用「通用」组。feature 类单独在下一组配置",
    options: [
      "summary",
      "suggested_title",
      "probable_cause",
      "troubleshooting",
      "evidence",
      "missing_information",
      "suggested_labels",
      "proposed_changes",
      "suggested_actions",
      "suggested_assignee",
    ],
  },
  {
    key: "issue_result_sections_feature",
    group: "issue",
    kind: "multicheck",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "Issue 结果区块（功能请求）",
    hint: "仅针对 feature 类 Issue 生效的区块组；留空则用「通用」组。例如 feature 类通常关闭「排查步骤」「缺失信息」，聚焦「建议改动」「建议指派人」",
    options: [
      "summary",
      "suggested_title",
      "probable_cause",
      "troubleshooting",
      "evidence",
      "missing_information",
      "suggested_labels",
      "proposed_changes",
      "suggested_actions",
      "suggested_assignee",
    ],
  },
  // ── PR 审查 ──
  {
    key: "pr_check_run",
    group: "pr",
    kind: "boolean",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "PR Check Run 可视化",
    hint: "在 PR 页显示 AI 审查的 Check（需 GitHub App 授予 checks: write；无权限时自动跳过）",
  },
  {
    key: "pr_auto_review",
    group: "pr",
    kind: "boolean",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "PR 自动提交 Review",
    hint: "开启则审查完成后提交正式 Review（含行内评论）；关闭则只发一条摘要评论",
  },
  // ── Embedding ──
  {
    key: "embedding_base_url",
    group: "embedding",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "EMBEDDING_BASE_URL",
    hotReload: "poll",
    label: "Embedding Base URL",
    hint: "留空则用 EMBEDDING_BASE_URL；保存后索引任务自动生效",
  },
  {
    key: "embedding_api_key",
    group: "embedding",
    kind: "secret",
    secret: true,
    repoScoped: false,
    envVar: "EMBEDDING_API_KEY",
    hotReload: "poll",
    label: "Embedding API Key",
    hint: "留空则用 EMBEDDING_API_KEY；保存后索引任务自动生效",
  },
  {
    key: "embedding_model",
    group: "embedding",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "EMBEDDING_MODEL",
    hotReload: "poll",
    label: "Embedding 模型",
    hint: "留空则用 EMBEDDING_MODEL（默认 text-embedding-3-small，1024 维）",
  },
  // ── QQ 机器人（在「机器人」页维护；仅启动时读一次，改完需重启 qq-bot）──
  {
    key: "qq_bot_protocols",
    group: "qq",
    kind: "secret", // JSON 内含 accessToken，按密钥处理
    secret: true,
    repoScoped: false,
    envVar: "QQ_BOT_PROTOCOLS",
    hotReload: "restart",
    label: "NTQQ 第三方协议",
    hint: "OneBot11 / Satori / Milky 网关的 JSON 配置；含访问令牌，保存后需重启 qq-bot 容器",
  },
  {
    key: "qq_official_app_id",
    group: "qq",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "QQ_OFFICIAL_APP_ID",
    hotReload: "restart",
    label: "官方 QQ AppID",
    hint: "QQ 开放平台机器人 AppID；保存后需重启 qq-bot 容器",
  },
  {
    key: "qq_official_app_secret",
    group: "qq",
    kind: "secret",
    secret: true,
    repoScoped: false,
    envVar: "QQ_OFFICIAL_APP_SECRET",
    hotReload: "restart",
    label: "官方 QQ AppSecret",
    hint: "用于刷新访问令牌；保存后需重启 qq-bot 容器",
  },
  {
    key: "qq_official_gateway_url",
    group: "qq",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "QQ_OFFICIAL_GATEWAY_URL",
    hotReload: "restart",
    label: "官方 QQ 网关",
    hint: "官方 WebSocket 网关地址；保存后需重启 qq-bot 容器",
  },
  {
    key: "qq_official_intents",
    group: "qq",
    kind: "number",
    secret: false,
    repoScoped: false,
    envVar: "QQ_OFFICIAL_INTENTS",
    hotReload: "restart",
    label: "官方 QQ Intents",
    hint: "订阅的事件位掩码（默认 33554432，即 1<<25）；保存后需重启 qq-bot 容器",
  },
  // ── 运维 ──
  {
    key: "log_level",
    group: "ops",
    kind: "enum",
    secret: false,
    repoScoped: false,
    envVar: "LOG_LEVEL",
    hotReload: "poll",
    label: "日志级别",
    hint: "保存后约 8 秒内生效",
    options: ["fatal", "error", "warn", "info", "debug", "trace", "silent"],
  },
  {
    key: "agent_team_enabled",
    group: "ops",
    kind: "boolean",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "Agent 专家团队",
    hint: "启用后 PR 审查走多角色专家流程；还需配置 expert_review 模型策略",
  },
  {
    key: "scan_enabled",
    group: "ops",
    kind: "boolean",
    secret: false,
    repoScoped: false,
    envVar: null,
    hotReload: "poll",
    label: "定时扫描总开关",
    hint: "关闭后停止所有仓库的周期扫描；单仓库扫描配置在「仓库扫描」页",
  },
  {
    key: "alert_webhook_url",
    group: "ops",
    kind: "string",
    secret: false,
    repoScoped: false,
    envVar: "ALERT_WEBHOOK_URL",
    hotReload: "poll",
    label: "告警 Webhook URL",
    hint: "告警触发/恢复时 POST JSON 通知（如飞书/钉钉/自定义）；留空则不推送",
  },
  {
    key: "alert_queue_backlog_threshold",
    group: "ops",
    kind: "number",
    secret: false,
    repoScoped: false,
    envVar: "ALERT_QUEUE_BACKLOG_THRESHOLD",
    hotReload: "poll",
    label: "队列积压告警阈值",
    hint: "待处理任务数达到该值触发「队列积压」告警（默认 20）",
  },
  {
    key: "alert_failed_tasks_threshold",
    group: "ops",
    kind: "number",
    secret: false,
    repoScoped: false,
    envVar: "ALERT_FAILED_TASKS_THRESHOLD",
    hotReload: "poll",
    label: "失败任务告警阈值",
    hint: "失败（死信）任务数达到该值触发告警（默认 1）",
  },
  {
    key: "alert_stale_tasks_threshold",
    group: "ops",
    kind: "number",
    secret: false,
    repoScoped: false,
    envVar: "ALERT_STALE_TASKS_THRESHOLD",
    hotReload: "poll",
    label: "滞留任务告警阈值",
    hint: "心跳超时（疑似 worker 已死）任务数达到该值触发告警（默认 1）",
  },
];

const byKey = new Map(SETTINGS_REGISTRY.map((spec) => [spec.key, spec]));

export function getSettingSpec(key: string): SettingSpec | undefined {
  return byKey.get(key);
}

export function isKnownSettingKey(key: string): boolean {
  return byKey.has(key);
}

/**
 * PUT /settings 的写白名单：全局可写的键。仓库级键不在此列 —— 它们走
 * /repositories/:id/settings。
 */
export const ALLOWED_SETTING_KEYS: readonly string[] = SETTINGS_REGISTRY.map(
  (spec) => spec.key,
);

/** GET /settings 的展示列表；目前与写白名单一致。 */
export const KNOWN_SETTING_KEYS = ALLOWED_SETTING_KEYS;

/** 密钥集：驱动 GET 掩码。备份脱敏另有默认拒绝的白名单，见 backup-redact。 */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(
  SETTINGS_REGISTRY.filter((spec) => spec.secret).map((spec) => spec.key),
);

/** 可按仓库覆盖的键。 */
export const REPO_SCOPED_SETTING_KEYS: readonly string[] =
  SETTINGS_REGISTRY.filter((spec) => spec.repoScoped).map((spec) => spec.key);

/**
 * ── 解析函数：读取点的唯一入口 ──
 *
 * 每个函数接受「解析后拿到的原始字符串或 undefined」，undefined 表示 DB / env
 * 都没有覆盖，此时套用应用默认。默认值集中在这里，消除各进程各写一份 `=== "true"`
 * / `!== "false"` / `Number()` 造成的分叉。
 */

/**
 * 布尔解析：显式 "true"/"false" 按字面，其余（含空串、非法值、缺省）回落到
 * 该键的默认值。这样既能复现「默认开」键的 `!== "false"`，也能复现「默认关」键的
 * `=== "true"` —— 两者只差在默认值。
 */
export function parseBool(
  raw: string | undefined,
  defaultOn: boolean,
): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return defaultOn;
}

/** 各布尔键的应用默认（唯一来源）。 */
export const BOOLEAN_DEFAULTS: Readonly<Record<string, boolean>> = {
  issue_auto_assign: false,
  issue_rewrite_title: true,
  issue_deep_analysis: true,
  issue_use_unified_sections: false,
  issue_vision_enabled: true,
  repo_rules_enabled: true,
  pr_check_run: true,
  pr_auto_review: true,
  agent_team_enabled: false,
  scan_enabled: true,
  // github_webhook_enabled 的默认是动态的（跟随是否配了 webhook secret），
  // 由 API 单独计算，不在这里给死。
};

/** `spam_handling`：只接受三个值，其余（含缺省 / 非法 / 读失败）回落 close。 */
export function parseSpamHandling(
  raw: string | undefined,
): "none" | "close" | "delete" {
  if (raw === "none" || raw === "close" || raw === "delete") return raw;
  return "close";
}

/** `log_level`：非法值回落到给定默认（通常是 env 的 LOG_LEVEL 或 "info"）。 */
const LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);
export function parseLogLevel(
  raw: string | undefined,
  fallback: string,
): string {
  if (raw !== undefined && LOG_LEVELS.has(raw)) return raw;
  return fallback;
}

/**
 * 保存前校验一个设置值。返回 null 表示合法，返回字符串表示不合法的原因（供界面
 * 显示）。此前 PUT 无校验直存，log_level 填 foo 会存进去并污染日志系统。
 *
 * 只做「显然非法」的拦截，不做业务级校验（比如 URL 能不能连通）—— 那些留给各自
 * 的保存流程（如 GitHub App 的实调验证）。
 */
export function validateSettingValue(
  key: string,
  value: string,
): string | null {
  const spec = getSettingSpec(key);
  if (!spec) return "未知设置键";

  if (spec.kind === "boolean") {
    if (value !== "true" && value !== "false")
      return '布尔项只能是 "true" 或 "false"';
    return null;
  }

  if (spec.kind === "enum") {
    if (!spec.options || !spec.options.includes(value))
      return `只能取以下值之一：${spec.options?.join(" / ") ?? ""}`;
    return null;
  }

  if (spec.kind === "multicheck") {
    // 逗号分隔的多选；空值由写入侧当作「回落默认」处理，不在这里拦。
    if (value.trim().length === 0) return null;
    const parts = value.split(",").map((s) => s.trim());
    if (parts.length === 0) return null;
    const valid = new Set(spec.options ?? []);
    for (const part of parts) {
      if (!valid.has(part)) return `未知区块：${part}`;
    }
    return null;
  }

  if (spec.kind === "number") {
    // 空串在写入侧被当作「清空」，不在这里拦；真正拦的是非数字。
    if (value.trim().length === 0) return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return "必须是数字";
    // 变化幅度是比例，限定 [0,1]。
    if (key === "issue_reanalyze_min_change" && (n < 0 || n > 1))
      return "变化幅度需在 0 到 1 之间";
    if (key === "qq_official_intents" && (n < 0 || !Number.isInteger(n)))
      return "Intents 必须是非负整数";
    return null;
  }

  if (key === "qq_bot_protocols" && value.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        return "协议配置必须是 JSON 对象";
    } catch {
      return "协议配置不是合法 JSON";
    }
    return null;
  }

  // string / secret：不做格式限制。
  return null;
}
