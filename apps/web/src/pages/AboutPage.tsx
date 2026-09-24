import { useCallback, useEffect, useState } from "react";
import { BugIcon, InfoIcon } from "../components/icons";
import { fetchUpdateStatus } from "../lib/api";

// 构建时由 Vite 注入（vite.config.ts define），用于核验前端是否已更新到新版本。
declare const __APP_VERSION__: string;

const MODULES = [
  { name: "Webhook 接入", desc: "GitHub 事件签名校验、规范化与任务映射（M2）" },
  { name: "任务引擎", desc: "持久任务状态机、租约、幂等、重试（M3）" },
  { name: "多模型路由", desc: "统一 deadline、故障转移、用量统计（M4）" },
  { name: "Issue 分析", desc: "上下文、提示词、受限修复、幂等评论（M5）" },
  { name: "重复检测", desc: "全文 + 信号 + 向量召回，服务端裁决（M6）" },
  { name: "PR 审查", desc: "diff 解析、大小降级、断言、幂等发布（M7）" },
  { name: "WebUI + SSE", desc: "Bearer 认证、实时事件流、数据可视化（M8）" },
  { name: "QQ 渠道", desc: "NTQQ（OneBot/Satori/Milky）与官方开放平台（M10）" },
] as const;

const NOT_IN_SCOPE = [
  "Agent 专家团队 / Agent Skills",
  "Sakura 记忆管理（跨 Agent 记忆本体）",
  "多用户账号体系（当前为 Bearer 单令牌访问）",
  "由 WebUI 直接修改数据库 / 模型配置（读写走 API / 迁移）",
];

export function AboutPage() {
  // 后端运行版本（/update/status，需登录）。拿不到就显示「未知」——版本核验是辅助，
  // 不能因为接口失败把整个页面拖垮。
  const [backendVersion, setBackendVersion] = useState<string | null>(null);

  const loadBackend = useCallback(() => {
    fetchUpdateStatus()
      .then((status) => setBackendVersion(status.current.version || "unknown"))
      .catch(() => setBackendVersion(null));
  }, []);

  useEffect(() => {
    loadBackend();
  }, [loadBackend]);

  const frontendVersion = `v${__APP_VERSION__}`;
  const versionMismatch =
    backendVersion !== null && backendVersion !== frontendVersion;

  return (
    <div className="stack">
      <div className="page-head">
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <img src="/aprism-logo.png" alt="AperturePrism" className="logo-img-lg" />
          <div>
            <h1 className="page-title">关于</h1>
            <p className="page-desc">AperturePrism — 独立开发的 GitHub Issue 分析与 PR 审查平台</p>
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title"><h2>功能模块</h2></div>
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(240px,1fr))" }}>
          {MODULES.map((m) => (
            <div key={m.name} className="result-card">
              <div className="result-title" style={{ marginBottom: 6 }}>
                <BugIcon size={15} /> {m.name}
              </div>
              <p className="result-summary" style={{ fontSize: 12 }}>{m.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>官网与项目</h2></div>
        <div className="kpi-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))" }}>
          <a className="result-card" href="https://www.aprism.top" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div className="result-title" style={{ marginBottom: 6 }}>团队官网 ↗</div>
            <p className="result-summary mono" style={{ fontSize: 12.5 }}>https://www.aprism.top</p>
          </a>
          <a className="result-card" href="https://github.com/AperturePrism/AperturePrism-AI-Review" target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div className="result-title" style={{ marginBottom: 6 }}>GitHub 仓库 ↗</div>
            <p className="result-summary mono" style={{ fontSize: 12.5 }}>AperturePrism/AperturePrism-AI-Review</p>
          </a>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>版本</h2></div>
        <dl className="kv">
          <dt>前端构建</dt><dd className="mono">{frontendVersion}</dd>
          <dt>后端运行</dt>
          <dd className="mono">
            {backendVersion === null ? "未知" : backendVersion}
          </dd>
        </dl>
        {versionMismatch ? (
          <p className="faint" style={{ margin: "8px 0 0", fontSize: 12, color: "var(--warn)" }}>
            前端（{frontendVersion}）与后端（{backendVersion}）版本不一致：
            请强刷页面（Ctrl+F5）获取最新前端；若仍不一致，请到「系统配置 → 在线更新」升级后端。
          </p>
        ) : (
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            若此处版本落后于最新发布，请强刷页面（Ctrl+F5）以获取最新前端。
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panel-title"><h2>设计参考</h2></div>
        <dl className="kv">
          <dt>总体设计</dt><dd className="mono">docs/APERTUREPRISM_AI_REVIEW_PROJECT_DESIGN.md</dd>
          <dt>开发计划</dt><dd className="mono">docs/APERTUREPRISM_MODULAR_DEVELOPMENT_PLAN.md</dd>
        </dl>
      </section>

      <section className="panel">
        <div className="panel-title"><h2><InfoIcon size={14} /> 范围说明</h2></div>
        <p className="result-summary">
          对比参考项目 Sakura-AI，以下能力在本项目暂不在范围，或由更底层的机制替代，不强行伪列出页面：
        </p>
        <ul className="missing-list" style={{ marginTop: 8 }}>
          {NOT_IN_SCOPE.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}