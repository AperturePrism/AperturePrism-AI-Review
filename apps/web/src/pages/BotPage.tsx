import { BotIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/bot", label: "机器人", group: "identity", order: 31, icon: PageIcon, render: () => <BotPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchBotStatus,
  fetchConfig,
  fetchSettings,
  saveSetting,
  startBot,
  stopBot,
  type BotStatus,
  type RuntimeConfig,
} from "../lib/api";
import {
  BotIcon,
  CheckCircleIcon,
  InfoIcon,
  RefreshIcon,
  XCircleIcon,
} from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { useToast } from "../components/Toast";

/** 支持的第三方协议及其说明（与后端 channel-adapters 一致）。 */
const PROTOCOL_META: Record<string, { label: string; desc: string }> = {
  onebot11: {
    label: "OneBot 11",
    desc: "通用 OneBot 11 正向 WebSocket（NapCat / LLOneBot / Lagrange 等）",
  },
  satori: {
    label: "Satori",
    desc: "Satori 协议（Chronocat / Koishi 等）",
  },
  milky: {
    label: "Milky",
    desc: "Milky 协议（MilkyChat 等社区客户端）",
  },
};
const PROTOCOL_KEYS = ["onebot11", "satori", "milky"] as const;

type ProtocolDraft = {
  enabled: boolean;
  baseUrl: string;
  accessToken: string;
  gatewayUrl: string;
};

type OfficialDraft = {
  appId: string;
  appSecret: string;
  gateway: string;
  intents: string;
};

const DEFAULT_GATEWAY = "wss://api.sgroup.qq.com/websocket";
const DEFAULT_INTENTS = String(1 << 25);

const BOT_COMMANDS = [
  { cmd: "/analyze <Issue 链接>", desc: "分析一个 GitHub Issue（创建分析任务）" },
  { cmd: "/review <PR 链接>", desc: "审查一个 GitHub Pull Request（创建审查任务）" },
  { cmd: "/status <任务ID>", desc: "查看任务执行状态与结果" },
  { cmd: "/retry <任务ID>", desc: "重跑失败 / 已取消的任务" },
  { cmd: "/prism help", desc: "显示命令帮助" },
];

function emptyDrafts(): Record<string, ProtocolDraft> {
  const out: Record<string, ProtocolDraft> = {};
  for (const key of PROTOCOL_KEYS) {
    out[key] = { enabled: false, baseUrl: "", accessToken: "", gatewayUrl: "" };
  }
  return out;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 12 }}>
      <span style={{ fontWeight: 600, fontSize: 13, display: "block", marginBottom: 6 }}>{label}</span>
      {children}
      {hint ? <span className="faint" style={{ display: "block", fontSize: 12, marginTop: 4 }}>{hint}</span> : null}
    </label>
  );
}

export function BotPage() {
  const toast = useToast();
  const [cfg, setCfg] = useState<RuntimeConfig | null>(null);
  const [official, setOfficial] = useState<OfficialDraft>({
    appId: "",
    appSecret: "",
    gateway: DEFAULT_GATEWAY,
    intents: DEFAULT_INTENTS,
  });
  const [protocols, setProtocols] = useState<Record<string, ProtocolDraft>>(emptyDrafts);
  const [saving, setSaving] = useState<string | null>(null);
  const [secretConfigured, setSecretConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bot, setBot] = useState<BotStatus | null>(null);
  const [botBusy, setBotBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchConfig(), fetchSettings(), fetchBotStatus()])
      .then(([c, s, b]) => {
        setCfg(c);
        const map = new Map(s.items.map((it) => [it.key, it.value]));
        const secretHasValue = Boolean(map.get("qq_official_app_secret"));
        setOfficial({
          appId: map.get("qq_official_app_id") ?? "",
          appSecret: "",
          gateway: map.get("qq_official_gateway_url") ?? DEFAULT_GATEWAY,
          intents: map.get("qq_official_intents") ?? DEFAULT_INTENTS,
        });
        setProtocols(parseProtocols(map.get("qq_bot_protocols")));
        // 记录是否有已设置的密钥，用于提示「留空保留」
        setSecretConfigured(secretHasValue);
        setBot(b);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load bot config");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  // qq-bot 容器启动 / 停止（管理员）。
  const toggleBot = async (action: "start" | "stop") => {
    setBotBusy(true);
    try {
      if (action === "start") {
        await startBot();
        toast.success("qq-bot 已启动，正在连接官方网关…");
      } else {
        await stopBot();
        toast.success("qq-bot 已停止");
      }
      bumpCache();
      const fresh = await fetchBotStatus();
      setBot(fresh);
    } catch (err) {
      toast.error(`操作失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setBotBusy(false);
    }
  };

  // 每 15s 自动刷新容器状态（启停后状态变化可自动更新）。
  useEffect(() => {
    const timer = setInterval(() => {
      fetchBotStatus()
        .then(setBot)
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, []);

  const saveOfficial = async () => {
    setSaving("official");
    try {
      const updates: Array<[string, string]> = [
        ["qq_official_app_id", official.appId.trim()],
        ["qq_official_gateway_url", official.gateway.trim()],
        ["qq_official_intents", official.intents.trim()],
      ];
      // 密钥只在新输入时才覆盖，避免误清已保存的 AppSecret
      if (official.appSecret.trim()) {
        updates.push(["qq_official_app_secret", official.appSecret.trim()]);
      }
      for (const [key, value] of updates) {
        await saveSetting(key, value);
      }
      toast.success("官方 QQ 配置已保存；重启 qq-bot 容器后生效");
      const fresh = await fetchSettings();
      setOfficial((prev) => ({ ...prev, appSecret: "" }));
      setSecretConfigured(fresh.items.some((it) => it.key === "qq_official_app_secret" && it.hasValue));
      bumpCache();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setSaving(null);
    }
  };

  const saveProtocols = async () => {
    const enabled = PROTOCOL_KEYS.filter((key) => protocols[key]?.enabled);
    for (const key of enabled) {
      const d = protocols[key]!;
      if (!d.gatewayUrl.trim() || !d.baseUrl.trim()) {
        toast.error(`${PROTOCOL_META[key]!.label} 已启用但缺少 baseUrl / gatewayUrl`);
        return;
      }
    }
    setSaving("protocols");
    try {
      const payload: Record<string, unknown> = {};
      for (const key of enabled) {
        const d = protocols[key]!;
        const entry: Record<string, string> = {
          baseUrl: d.baseUrl.trim(),
          gatewayUrl: d.gatewayUrl.trim(),
        };
        if (d.accessToken.trim()) entry.accessToken = d.accessToken.trim();
        payload[key] = entry;
      }
      await saveSetting("qq_bot_protocols", JSON.stringify(payload));
      toast.success("第三方协议配置已保存；重启 qq-bot 容器后生效");
      bumpCache();
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : err}`);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">机器人</h1>
          <p className="page-desc">配置官方 QQ 开放平台机器人与第三方协议网关，直接收发群 / 私聊命令</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading ? (
        <div className="panel"><LoadingRows /></div>
      ) : (
        <div className="stack">
          {/* 接入状态 */}
          <section className="panel">
            <div className="panel-title"><h2><BotIcon size={14} /> 接入状态</h2></div>
            <div className="dist" style={{ marginTop: 6 }}>
              <div className="dist-row">
                <span className="dist-label">官方 QQ 开放平台</span>
                <span>
                  {cfg?.qqOfficialConfigured ? (
                    <span className="pill pill-ok"><CheckCircleIcon size={12} /> 已配置</span>
                  ) : (
                    <span className="pill pill-dim"><XCircleIcon size={12} /> 未配置</span>
                  )}
                  <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                    api-v2（AppID + AppSecret）
                  </span>
                </span>
              </div>
              <div className="dist-row">
                <span className="dist-label">第三方协议</span>
                <span>
                  {cfg && cfg.qqBotProtocols.length > 0 ? (
                    <span className="tag-row">
                      {cfg.qqBotProtocols.map((p) => (
                        <span key={p} className="tag">{PROTOCOL_META[p]?.label ?? p}</span>
                      ))}
                    </span>
                  ) : (
                    <span className="faint" style={{ fontSize: 12 }}>未配置（OneBot 11 / Satori / Milky）</span>
                  )}
                </span>
              </div>
              <div className="dist-row">
                <span className="dist-label">qq-bot 容器</span>
                <span>
                  {bot ? (
                    bot.status === "running" ? (
                      <span className="pill pill-ok"><CheckCircleIcon size={12} /> 运行中</span>
                    ) : bot.status === "absent" ? (
                      <span className="pill pill-dim"><XCircleIcon size={12} /> 未创建</span>
                    ) : (
                      <span className="pill pill-warn"><XCircleIcon size={12} /> 已停止（{bot.status}）</span>
                    )
                  ) : (
                    <span className="pill pill-dim">未知</span>
                  )}
                  <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>
                    {cfg?.qqOfficialConfigured ? "已配置凭据" : "未配置凭据"}
                  </span>
                </span>
              </div>
            </div>
            <div className="actions" style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                disabled={botBusy || bot?.status === "running"}
                onClick={() => toggleBot("start")}
              >
                {botBusy ? "处理中…" : "启动机器人"}
              </button>
              <button
                className="btn"
                disabled={botBusy || bot?.status !== "running"}
                onClick={() => toggleBot("stop")}
              >
                {botBusy ? "处理中…" : "停止机器人"}
              </button>
            </div>
            <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
              配置保存在数据库（覆盖环境变量）。启动/停止会操作 qq-bot 容器（compose --profile qq），
              配置变更后建议「停止 → 启动」一次以加载最新配置。
            </p>
          </section>

          {/* 官方 QQ */}
          <section className="panel">
            <div className="panel-title">
              <h2>官方 QQ 开放平台</h2>
              <span className="count">api-v2 机器人</span>
            </div>
            <div className="grid2" style={{ marginTop: 6 }}>
              <Field label="AppID" hint="开放平台机器人 AppID；留空则回退到环境变量 QQ_OFFICIAL_APP_ID">
                <input
                  className="input"
                  value={official.appId}
                  onChange={(e) => setOfficial((p) => ({ ...p, appId: e.target.value }))}
                  placeholder="QQ_OFFICIAL_APP_ID"
                  data-lpignore="true"
                />
              </Field>
              <Field label="AppSecret" hint={secretConfigured ? "已设置密钥；留空保留当前值" : "开放平台机器人 AppSecret，用于换取访问令牌"}>
                <input
                  className="input"
                  type="password"
                  value={official.appSecret}
                  onChange={(e) => setOfficial((p) => ({ ...p, appSecret: e.target.value }))}
                  placeholder={secretConfigured ? "••••••••（已设置）" : "QQ_OFFICIAL_APP_SECRET"}
                  data-lpignore="true"
                />
              </Field>
              <Field label="网关地址" hint="默认官方 WebSocket 网关；沙箱 / 企业环境可覆盖">
                <input
                  className="input"
                  value={official.gateway}
                  onChange={(e) => setOfficial((p) => ({ ...p, gateway: e.target.value }))}
                  placeholder={DEFAULT_GATEWAY}
                />
              </Field>
              <Field label="订阅 Intents" hint={`事件位掩码，默认 ${DEFAULT_INTENTS}（C2C 私聊 + 群 @）`}>
                <input
                  className="input"
                  value={official.intents}
                  onChange={(e) => setOfficial((p) => ({ ...p, intents: e.target.value }))}
                  placeholder={DEFAULT_INTENTS}
                />
              </Field>
            </div>
            <div className="actions" style={{ marginTop: 4 }}>
              <button className="btn btn-primary" onClick={saveOfficial} disabled={saving === "official"}>
                {saving === "official" ? "保存中…" : "保存官方配置"}
              </button>
            </div>
          </section>

          {/* 第三方协议 */}
          <section className="panel">
            <div className="panel-title">
              <h2>第三方协议</h2>
              <span className="count">OneBot 11 / Satori / Milky</span>
            </div>
            <p className="faint" style={{ margin: "0 0 12px", fontSize: 12 }}>
              开启后请填写网关地址与基础地址；无需手写 JSON，保存时自动生成 <code className="mono">qq_bot_protocols</code>。
            </p>
            <div className="stack">
              {PROTOCOL_KEYS.map((key) => {
                const meta = PROTOCOL_META[key]!;
                const d = protocols[key]!;
                return (
                  <div key={key} className="result-card" style={{ borderStyle: d.enabled ? "solid" : "dashed" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={d.enabled}
                          onChange={(e) =>
                            setProtocols((prev) => ({ ...prev, [key]: { ...prev[key]!, enabled: e.target.checked } }))
                          }
                        />
                        {meta.label}
                      </label>
                      {d.enabled ? <span className="pill pill-info">已启用</span> : <span className="pill pill-dim">未启用</span>}
                    </div>
                    <p className="faint" style={{ margin: "6px 0 10px", fontSize: 12 }}>{meta.desc}</p>
                    <div className="grid3" style={{ alignItems: "end", gap: 10 }}>
                      <Field label="网关地址（WebSocket）" hint="bot 连接该网关接收消息，必填">
                        <input
                          className="input"
                          value={d.gatewayUrl}
                          disabled={!d.enabled}
                          onChange={(e) =>
                            setProtocols((prev) => ({ ...prev, [key]: { ...prev[key]!, gatewayUrl: e.target.value } }))
                          }
                          placeholder="ws://127.0.0.1:3001"
                        />
                      </Field>
                      <Field label="基础地址（API）" hint="发送消息用的 HTTP 地址，必填">
                        <input
                          className="input"
                          value={d.baseUrl}
                          disabled={!d.enabled}
                          onChange={(e) =>
                            setProtocols((prev) => ({ ...prev, [key]: { ...prev[key]!, baseUrl: e.target.value } }))
                          }
                          placeholder="http://127.0.0.1:3000"
                        />
                      </Field>
                      <Field label="访问令牌" hint="网关要求的 accessToken，无则留空">
                        <input
                          className="input"
                          value={d.accessToken}
                          disabled={!d.enabled}
                          onChange={(e) =>
                            setProtocols((prev) => ({ ...prev, [key]: { ...prev[key]!, accessToken: e.target.value } }))
                          }
                          placeholder="accessToken"
                          data-lpignore="true"
                        />
                      </Field>
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="actions" style={{ marginTop: 12 }}>
              <button className="btn btn-primary" onClick={saveProtocols} disabled={saving === "protocols"}>
                {saving === "protocols" ? "保存中…" : "保存第三方协议"}
              </button>
            </div>
          </section>

          {/* 机器人命令 */}
          <section className="panel">
            <div className="panel-title">
              <h2><InfoIcon size={14} /> 机器人命令</h2>
              <span className="count">群内 @ 机器人或私聊发送</span>
            </div>
            <p className="faint" style={{ margin: "0 0 10px", fontSize: 12 }}>
              配置并重启 qq-bot 后，机器人会自动执行任务并回复任务 ID，可用 /status 跟进、/retry 重跑。
            </p>
            <div className="dist" style={{ marginTop: 4 }}>
              {BOT_COMMANDS.map((item) => (
                <div key={item.cmd} className="dist-row">
                  <span className="dist-label"><code className="mono">{item.cmd}</code></span>
                  <span className="faint" style={{ fontSize: 13 }}>{item.desc}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function parseProtocols(raw: string | undefined): Record<string, ProtocolDraft> {
  const drafts = emptyDrafts();
  if (!raw || raw.trim().length === 0) return drafts;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return drafts;
    const record = parsed as Record<string, unknown>;
    for (const key of PROTOCOL_KEYS) {
      const entry = record[key];
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      drafts[key] = {
        enabled: Boolean(e.gatewayUrl),
        baseUrl: typeof e.baseUrl === "string" ? e.baseUrl : "",
        accessToken: typeof e.accessToken === "string" ? e.accessToken : "",
        gatewayUrl: typeof e.gatewayUrl === "string" ? e.gatewayUrl : "",
      };
    }
  } catch {
    // 保持空表单，用户可重新填写
  }
  return drafts;
}
