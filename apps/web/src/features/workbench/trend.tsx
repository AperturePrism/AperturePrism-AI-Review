/** 趋势直接来自真实交付账本；日桶使用 UTC，避免把本地日期误当成服务端日期。 */
import { useEffect, useState } from "react";
import {
  DefinitionList,
  PagedList,
  WorkbenchSection,
} from "../../components/workbench";
import {
  workbench,
  explainWorkbenchError,
  type WorkbenchTrends,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "trends",
  label: "趋势与健康",
  description: "按真实审查交付记录分析结果趋势、规则信号和未解决问题的年龄。",
  order: 100,
  render: ({ repository }) => <Trends repository={repository} />,
};
export function Trends({ repository }: { repository: string }) {
  const [days, setDays] = useState(30);
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<WorkbenchTrends | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<"reviews" | "imported" | "resolved">(
    "reviews",
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    workbench
      .trends(repository, days, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(explainWorkbenchError(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repository, days, revision]);
  const maximum = data
    ? Math.max(1, ...data.daily.map((item) => item[metric]))
    : 1;
  return (
    <WorkbenchSection
      title="审查趋势与规则健康"
      description="所有日桶按 UTC 日期归档。没有真实审查交付时显示 0，不从任务计划或模拟数据推断吞吐。"
      actions={
        <>
          <label className="wb-inline-label">
            窗口{" "}
            <select
              className="input"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={7}>最近 7 天</option>
              <option value={30}>最近 30 天</option>
              <option value={90}>最近 90 天</option>
            </select>
          </label>
          <button
            className="btn"
            disabled={loading}
            onClick={() => setRevision((value) => value + 1)}
          >
            刷新趋势
          </button>
        </>
      }
    >
      {loading ? (
        <p role="status">加载真实账本统计中…</p>
      ) : error ? (
        <p role="alert" className="wb-notice wb-notice-error">
          {error}
        </p>
      ) : data ? (
        <>
          <div className="wb-metrics">
            {(
              [
                ["完成审查", data.totals.reviews],
                ["导入发现", data.totals.imported],
                ["解决发现", data.totals.resolved],
                ["重新出现", data.totals.reopenedFindings],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div className="wb-metric" key={label}>
                <span>{label}</span>
                <strong>{value.toLocaleString()}</strong>
              </div>
            ))}
          </div>
          <DefinitionList
            values={[
              ["门禁失败率", `${(data.totals.failRate * 100).toFixed(1)}%`],
              ["已修复发现", data.totals.fixedFindings],
              [
                "统计范围（UTC）",
                `${data.since.slice(0, 10)} — ${data.until.slice(0, 10)}`,
              ],
            ]}
          />
          <label className="wb-inline-label">
            每日指标{" "}
            <select
              className="input"
              value={metric}
              onChange={(event) =>
                setMetric(event.target.value as typeof metric)
              }
            >
              <option value="reviews">完成审查</option>
              <option value="imported">导入发现</option>
              <option value="resolved">解决发现</option>
            </select>
          </label>
          <div
            className="wb-trend-chart"
            role="img"
            aria-label={`每日${metric === "reviews" ? "完成审查" : metric === "imported" ? "导入发现" : "解决发现"}，完整数字见下方表格`}
          >
            {data.daily.map((day) => (
              <div
                className="wb-trend-column"
                key={day.date}
                title={`${day.date}：${day[metric]}`}
              >
                <span style={{ height: `${(day[metric] / maximum) * 100}%` }} />
                <small>{day.date.slice(5)}</small>
              </div>
            ))}
          </div>
          <details className="wb-subdetails">
            <summary>每日完整数据</summary>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>UTC 日期</th>
                    <th>完成审查</th>
                    <th>导入</th>
                    <th>解决</th>
                    <th>门禁通过</th>
                    <th>门禁提醒</th>
                    <th>门禁失败</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((day) => (
                    <tr key={day.date}>
                      <td>{day.date}</td>
                      <td>{day.reviews}</td>
                      <td>{day.imported}</td>
                      <td>{day.resolved}</td>
                      <td>{day.gatePass}</td>
                      <td>{day.gateWarn}</td>
                      <td>{day.gateFail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <h3 className="wb-subheading">未解决发现年龄</h3>
          <div className="wb-metrics">
            {(
              [
                ["不足 7 天", data.aging.under7Days],
                ["7–30 天", data.aging.days7To30],
                ["30–90 天", data.aging.days30To90],
                ["超过 90 天", data.aging.over90Days],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div className="wb-metric" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
          <h3 className="wb-subheading">规则健康</h3>
          <PagedList
            items={data.rules}
            label="规则"
            searchText={(rule) => rule.ruleId}
            pageSize={10}
            render={(rule) => (
              <article className="wb-mini-record" key={rule.ruleId}>
                <strong>{rule.ruleId}</strong>
                <DefinitionList
                  values={[
                    ["未解决", rule.open],
                    ["已修复", rule.fixed],
                    ["误报", rule.falsePositive],
                    ["接受风险", rule.acceptedRisk],
                    ["人工反馈", rule.feedback],
                    ["有用反馈", rule.usefulFeedback],
                    [
                      "中位修复时间",
                      rule.medianFixHours === null
                        ? "暂无已修复样本"
                        : `${rule.medianFixHours.toFixed(1)} 小时`,
                    ],
                  ]}
                />
              </article>
            )}
          />
          <h3 className="wb-subheading">问题负责人</h3>
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>负责人</th>
                  <th>未解决</th>
                  <th>严重</th>
                  <th>高危</th>
                  <th>最久未解决</th>
                </tr>
              </thead>
              <tbody>
                {data.owners.map((owner) => (
                  <tr key={owner.assignee}>
                    <td>{owner.assignee || "尚未分配"}</td>
                    <td>{owner.open}</td>
                    <td>{owner.critical}</td>
                    <td>{owner.high}</td>
                    <td>{owner.oldestDays} 天</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </WorkbenchSection>
  );
}
