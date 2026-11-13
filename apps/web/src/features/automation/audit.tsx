/** 自动化审计只读呈现规则修改、事件派发、审批和每步执行的真实记录。 */
import { AutomationPager } from "../../components/automation";
import {
  CollectionState,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useAutomationRows } from "../../hooks/useAutomation";
import type { AutomationPageContext } from "../../lib/automation";
export function AutomationAuditPage(context: AutomationPageContext) {
  const list = useAutomationRows("audit", context.repository);
  return (
    <WorkbenchSection
      title="自动化操作审计"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新自动化审计
        </button>
      }
    >
      <CollectionState
        {...list}
        count={list.items.length}
        empty="尚无自动化操作记录"
      >
        {list.items.map((record) => (
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
            <details>
              <summary>操作详情</summary>
              <pre className="wb-json">
                {JSON.stringify(record.detail, null, 2)}
              </pre>
            </details>
          </article>
        ))}
      </CollectionState>
      <AutomationPager {...list} />
    </WorkbenchSection>
  );
}
