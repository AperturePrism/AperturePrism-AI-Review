import { LayersIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/agent", label: "Agent 能力", group: "data", order: 48, icon: PageIcon, render: () => <AgentPage /> }];

import { useCallback, useEffect, useState } from "react";
import {
  bumpCache,
  fetchCapabilities,
  fetchMe,
  setExpertTeamEnabled,
  type Capabilities,
} from "../lib/api";
import { RefreshIcon, SparkleIcon } from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { useToast } from "../components/Toast";

export function AgentPage() {
  const toast = useToast();
  const [data, setData] = useState<Capabilities | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([fetchMe().catch(() => null), fetchCapabilities()])
      .then(([me, capabilities]) => {
        setIsAdmin(me ? me.isAdmin || me.authMethod === "bearer" : false);
        setData(capabilities);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "failed to load capabilities");
        setData(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const toggle = async () => {
    if (!data) return;
    const next = !data.enabled;
    setBusy(true);
    try {
      await setExpertTeamEnabled(next);
      toast.success(
        next ? "专家团队已启用：PR 审查将走多专家管线。" : "专家团队已停用：PR 审查恢复单模型管线。",
      );
      setData((prev) => (prev ? { ...prev, enabled: next } : prev));
    } catch (err) {
      const text = err instanceof Error ? err.message : "切换失败";
      if (text.includes("403")) toast.error("需要管理员权限（403）。");
      else toast.error(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">
            <SparkleIcon size={18} /> Agent 专家团队
          </h1>
          <p className="page-desc">
            Agent Skills 技能注册表与多专家编排管线：PR 审查由多位专家并行评审、主编合并
          </p>
        </div>
        <div className="actions">
          {isAdmin ? (
            <button
              className={`btn ${data?.enabled ? "btn-danger" : "btn-primary"}`}
              onClick={toggle}
              disabled={busy || loading || !data}
            >
              {busy ? "切换中…" : data?.enabled ? "停用专家团队" : "启用专家团队"}
            </button>
          ) : null}
          <button className="btn" onClick={() => { bumpCache(); load(); }} disabled={loading}>
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>专家团队状态</h2>
          <span className={`pill ${data?.enabled ? "pill-ok" : "pill-dim"}`}>
            {data?.enabled ? "已启用" : "已停用"}
          </span>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          启用后，PR 审查任务会为每位适用专家并行调用模型，再由主编（lead）把各专家结论合并为最终审查报告；
          需先在模型路由中配置 <span className="mono">expert_review</span> 角色策略，否则 worker 降级使用{" "}
          <span className="mono">pr_review</span> 候选。
          {!isAdmin ? "（切换需要管理员权限）" : ""}
        </p>
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>技能目录</h2>
          <span className="count">{data?.skills.length ?? "–"} skills</span>
        </div>
        {error ? (
          <ErrorPanel error={error} onRetry={load} />
        ) : loading ? (
          <LoadingRows />
        ) : !data || data.skills.length === 0 ? (
          <p className="state state-empty">暂无技能</p>
        ) : (
          <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {data.skills.map((skill) => (
              <div className="result-card" key={skill.id}>
                <div className="result-top">
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {skill.name}
                  </span>
                  <span className={`chip ${skill.appliesTo === "pr" ? "chip-type" : ""}`}>
                    {skill.appliesTo}
                  </span>
                </div>
                <div className="result-body">
                  <p className="faint" style={{ margin: 0, fontSize: 12 }}>
                    {skill.description}
                  </p>
                  <div className="mono" style={{ marginTop: 8, fontSize: 12, color: "var(--faint)" }}>
                    {skill.id}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>专家团队</h2>
          <span className="count">{data?.experts.length ?? "–"} experts</span>
        </div>
        {error ? (
          <ErrorPanel error={error} onRetry={load} />
        ) : loading ? (
          <LoadingRows />
        ) : !data || data.experts.length === 0 ? (
          <p className="state state-empty">暂无专家</p>
        ) : (
          <div className="grid2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {data.experts.map((expert) => (
              <div className="result-card" key={expert.id}>
                <div className="result-top">
                  <span className="mono" style={{ fontWeight: 600 }}>
                    {expert.name}
                  </span>
                  <span className={`chip ${expert.appliesTo === "pr" ? "chip-type" : ""}`}>
                    {expert.appliesTo}
                  </span>
                </div>
                <div className="result-body">
                  <div className="mono" style={{ fontSize: 12, color: "var(--faint)" }}>
                    {expert.id}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
