import { SlidersIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/analysis", label: "分析设置", group: "data", order: 42, icon: PageIcon, render: () => <AnalysisSettingsPage /> }];

import { navigate } from "../hooks/useHash";
import { SettingsSection } from "../components/SettingsSection";

/** Issue / PR 分析行为的全局默认，单一归属。仓库级覆盖在「已安装仓库」页。 */
export function AnalysisSettingsPage() {
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">分析设置</h1>
          <p className="page-desc">Issue 分析与 PR 审查的全局默认行为</p>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title"><h2>审核规则</h2></div>
        <p className="faint">全局审核规则、文件与链接导入，以及仓库规则默认开关已集中到「审核规则」页管理。</p>
        <button className="btn" onClick={() => navigate("/repo-rules")}>前往「审核规则」</button>
      </section>

      <SettingsSection
        keys={[
          "spam_handling",
          "issue_auto_assign",
          "issue_assignee",
          "issue_rewrite_title",
          "issue_deep_analysis",
          "issue_use_unified_sections",
          "issue_vision_enabled",
          "issue_reanalyze_min_change",
          "issue_prompt_version",
          "issue_prompt_mode",
          "issue_result_sections",
          "issue_result_sections_bug",
          "issue_result_sections_feature",
        ]}
        title="Issue 分析"
        desc="此处为全部 Issue 分析项的全局默认，一处配置、所有仓库生效；如需某一仓库单独覆盖，可在「已安装仓库」页针对该仓库调整"
      />

      <SettingsSection
        keys={["pr_check_run", "pr_auto_review"]}
        title="PR 审查"
        desc="审查结果如何回写到 Pull Request"
      />

      <section className="panel">
        <div className="panel-title">
          <h2>仓库级覆盖</h2>
          <span className="count">按仓库粒度</span>
        </div>
        <p className="faint" style={{ margin: "0 0 8px", fontSize: 12 }}>
          协作仓库可能需要不同的行为（例如不自动改标题、不自动指派）。在
          「已安装仓库」页打开某个仓库的「分析设置」即可单独覆盖，未覆盖时跟随上面的全局默认。
        </p>
        <button className="btn" onClick={() => navigate("/repos")}>
          前往「已安装仓库」
        </button>
      </section>
    </div>
  );
}
