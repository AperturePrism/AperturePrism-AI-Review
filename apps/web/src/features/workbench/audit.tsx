/** 工作台审计只读查看；不提供在界面篡改或清空历史的入口。 */
import { useState } from "react";
import {
  CollectionState,
  DefinitionList,
  PagedList,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useWorkbenchCollection } from "../../hooks/useWorkbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "audit",
  label: "操作审计",
  description: "核查谁在何时修改了什么，沿哈希链追溯工作台操作。",
  order: 90,
  render: ({ repository }) => <Audit repository={repository} />,
};
export function Audit({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("audit", repository);
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const actions = [...new Set(list.items.map((item) => item.action))].sort();
  const shown = [...list.items]
    .reverse()
    .filter(
      (item) =>
        (!actor.trim() ||
          item.actor
            .toLocaleLowerCase()
            .includes(actor.trim().toLocaleLowerCase())) &&
        (!action || item.action === action) &&
        (!from || Date.parse(item.at) >= Date.parse(from)) &&
        (!to || Date.parse(item.at) <= Date.parse(to)),
    );
  return (
    <WorkbenchSection
      title="仓库操作审计"
      description="记录按时间倒序展示。哈希和上一条哈希可用于导出后独立核查，页面不把有哈希等同于已经验证完整性。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新审计
        </button>
      }
    >
      <div className="wb-filters">
        <label>
          操作者
          <input
            className="input"
            value={actor}
            onChange={(event) => setActor(event.target.value)}
          />
        </label>
        <label>
          操作类型
          <select
            className="input"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            <option value="">全部操作</option>
            {actions.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label>
          开始时间
          <input
            className="input"
            type="datetime-local"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label>
          结束时间
          <input
            className="input"
            type="datetime-local"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
        </label>
        <button
          className="btn"
          onClick={() => {
            setActor("");
            setAction("");
            setFrom("");
            setTo("");
          }}
        >
          清除筛选
        </button>
      </div>
      <CollectionState
        {...list}
        count={shown.length}
        empty={list.items.length ? "没有匹配的审计记录" : "尚无工作台操作"}
        hint="创建、修改和处置会自动生成审计记录。"
      >
        <PagedList
          items={shown}
          label="审计记录"
          searchText={(item) =>
            `${item.action} ${item.actor} ${item.target} ${item.hash}`
          }
          render={(record) => (
            <article className="wb-record" key={record.id}>
              <div className="wb-record-head">
                <div>
                  <h3>{record.action}</h3>
                  <p>
                    {record.actor} · {formatDate(record.at)}
                  </p>
                </div>
                <code className="wb-record-id">{record.target}</code>
              </div>
              <details className="wb-subdetails">
                <summary>记录详情与哈希</summary>
                <pre className="wb-json">
                  {JSON.stringify(record.details, null, 2)}
                </pre>
                <DefinitionList
                  values={[
                    ["记录 ID", <code>{record.id}</code>],
                    [
                      "上一条哈希",
                      <code className="wb-hash">
                        {record.previousHash || "首条记录"}
                      </code>,
                    ],
                    [
                      "当前哈希",
                      <code className="wb-hash">{record.hash}</code>,
                    ],
                  ]}
                />
              </details>
            </article>
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
