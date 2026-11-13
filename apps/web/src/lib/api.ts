/**
 * 兼容既有页面的 API 出口；业务定义按主体放在 api/。
 * 新代码可直接从 api/task、api/repository 等主体导入。
 * 缓存始终由 api/http.ts 单独持有，拆分后不会产生第二份缓存。
 */
export { bumpCache } from "./api/http";
export { fetchHealth } from "./api/health";
export type { HealthDependency, ReadyHealth, HealthResult } from "./api/health";
export {
  fetchTasks,
  fetchTaskDetail,
  fetchTaskCheckRun,
  rerunTasks,
  cancelTasks,
  triggerManualTask,
} from "./api/task";
export type {
  TaskSummary,
  TaskList,
  TaskEvent,
  TaskAttempt,
  Publication,
  TaskDetail,
  RerunResult,
  CheckRunStatus,
  TaskCheckRunResult,
  CancelResult,
  ManualTriggerInput,
  ManualTriggerResult,
} from "./api/task";
export {
  fetchModels,
  saveProvider,
  deleteProvider,
  fetchProviders,
} from "./api/provider";
export type {
  ModelPolicy,
  ProviderOverview,
  ProviderAccount,
  ProviderSaveResult,
} from "./api/provider";
export { STATUS_ORDER, fetchSummary } from "./api/overview";
export type { Summary } from "./api/overview";
export {
  syncRepositories,
  fetchRepositories,
  fetchRepoSubjects,
  fetchRepositorySettings,
  saveRepositorySetting,
} from "./api/repository";
export type {
  Repository,
  RepositoryList,
  RepoSyncResult,
  RepoSubjectItem,
  RepositorySettingItem,
  RepositorySettings,
} from "./api/repository";
export { fetchLogs, fetchLogHistory, fetchLogsSince } from "./api/log";
export type { LogEvent, DeliveryEntry, AuditLog, HistoryPage } from "./api/log";
export {
  fetchVectorStats,
  triggerIndexRun,
  fetchIndexStatus,
  rebuildIndex,
  fetchRelatedIssues,
  saveEmbedding,
} from "./api/vector";
export type {
  VectorStats,
  IndexPassSummary,
  IndexStatus,
  RelatedIssue,
} from "./api/vector";
export {
  fetchConfig,
  fetchSettings,
  fetchSettingsBootstrap,
  clearSetting,
  saveSetting,
} from "./api/settings";
export type {
  RuntimeConfig,
  SettingSource,
  SettingItem,
  SettingsList,
  BootstrapItem,
  BootstrapStatus,
} from "./api/settings";
export {
  fetchRepoRulesList,
  fetchRepoRulesDetail,
  fetchRepoRulesFile,
  saveRepoRulesFile,
  deleteRepoRulesFile,
  importRepoRulesFromUrl,
} from "./api/rules";
export type {
  RepoRulesItem,
  RepoRulesList,
  RepoRulesDetail,
} from "./api/rules";
export { fetchCapabilities, setExpertTeamEnabled } from "./api/capability";
export type {
  CapabilitySkill,
  CapabilityExpert,
  Capabilities,
} from "./api/capability";
export { fetchBackup, importBackup } from "./api/backup";
export type {
  BackupSetting,
  BackupPolicy,
  BackupSnapshot,
  BackupImportResult,
} from "./api/backup";
export { fetchLabelRules, saveLabelRule, deleteLabelRule } from "./api/label";
export type { LabelRuleItem, LabelRulesResult } from "./api/label";
export {
  fetchRepoMemory,
  createRepoMemory,
  triggerMemoryConsolidation,
  deleteRepoMemory,
} from "./api/memory";
export type {
  RepoMemoryKind,
  RepoMemoryItem,
  RepoMemoryList,
  MemoryFilter,
  MemoryConsolidationResult,
} from "./api/memory";
export {
  fetchOAuthStatus,
  fetchMe,
  loginLocal,
  registerLocal,
  logoutLocal,
  changePassword,
  saveMe,
  fetchUsers,
  setUserRoles,
} from "./api/account";
export type { OAuthStatus, AccountInfo, UserRow } from "./api/account";
export { fetchGrants, setGrant, deleteGrant } from "./api/grant";
export type { GrantAccess, RepoGrant, RepoGrantList } from "./api/grant";
export { fetchAuditLog } from "./api/audit";
export type { AuditEntry } from "./api/audit";
export { fetchMetrics, fetchAlerts } from "./api/metrics";
export type {
  MetricsDurationBucket,
  MetricsSnapshot,
  AlertRecord,
} from "./api/metrics";
export {
  fetchSetupStatus,
  setupInit,
  genWebhookSecret,
  saveOAuth,
  saveGithubApp,
} from "./api/setup";
export type { SetupStatus, SetupInitResult } from "./api/setup";
export {
  fetchUpdateStatus,
  fetchUpdateHistory,
  applyUpdate,
} from "./api/update";
export type { UpdateStatus, UpdateHistoryEntry } from "./api/update";
export { revokeSubject, fetchResults, deleteResults } from "./api/result";
export type {
  RevokeResult,
  SubjectResult,
  ResultList,
  ResultsDeleteResult,
} from "./api/result";
export {
  fetchScansConfig,
  saveScansConfig,
  triggerScan,
  fetchScanRuns,
} from "./api/scan";
export type {
  ScanConfigItem,
  ScansConfig,
  ScanRun,
  ScanRunsResult,
} from "./api/scan";
export { fetchBotStatus, startBot, stopBot } from "./api/bot";
export type { BotStatus, BotActionResult } from "./api/bot";
export { runWebhookSelfTest } from "./api/webhook";
export type { WebhookSelfTestResult } from "./api/webhook";
