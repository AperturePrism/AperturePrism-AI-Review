/** 事件记录保留去重结果和每条未匹配规则的解释；派发与只读预览明确区分。 */
import { useState } from "react";
import { AutomationPager, ExplanationTree } from "../../components/automation";
import {
  CollectionState,
  ConfirmAction,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useAutomationRows } from "../../hooks/useAutomation";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";
import {
  automation,
  parseAutomationObject,
  type AutomationPageContext,
} from "../../lib/automation";
export function AutomationEvents(context: AutomationPageContext) {
  const list = useAutomationRows("events", context.repository);
  const [content, setContent] = useState("");
  const [validated, setValidated] = useState<Record<string, unknown> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const mutation = useWorkbenchMutation(() => {
    list.refresh();
    context.onChanged();
  });
  return (
    <WorkbenchSection
      title="审查事件记录"
      description="相同事件 ID 和内容只派发一次；同一 ID 的内容变化会被拒绝，避免重复执行。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新事件
        </button>
      }
    >
      {context.viewer.canWrite ? (
        <CreationForm title="手动派发事件">
          <p className="wb-notice wb-notice-warning">
            这里会真正执行匹配规则，包括生成报告和请求审批。只检查条件时请使用规则页的「只读试跑」。
          </p>
          <Field label="派发事件 JSON">
            <textarea
              className="input wb-code"
              rows={8}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setValidated(null);
              }}
              placeholder="粘贴经过核实的事件对象"
            />
          </Field>
          <button
            className="btn"
            type="button"
            disabled={mutation.busy}
            onClick={() => {
              try {
                const event = parseAutomationObject(content, "事件");
                if (
                  typeof event.id !== "string" ||
                  !event.id.trim() ||
                  typeof event.type !== "string"
                )
                  throw new Error("事件必须包含 id 和 type");
                if (
                  typeof event.repository !== "string" ||
                  event.repository.toLowerCase() !==
                    context.repository.toLowerCase()
                )
                  throw new Error("事件 repository 必须与当前仓库一致");
                setValidated(event);
                setError(null);
              } catch (reason) {
                setValidated(null);
                setError(reason instanceof Error ? reason.message : "事件无效");
              }
            }}
          >
            检查派发范围
          </button>
          {validated ? (
            <div className="wb-notice">
              <p>
                即将向 <strong>{context.repository}</strong> 派发事件{" "}
                <code>{String(validated.id)}</code>。
              </p>
              <ConfirmAction
                label="派发并执行匹配规则"
                dangerous
                message="确认派发此事件并真正执行匹配规则中的动作？事件不会自动撤回，执行记录将保留。"
                disabled={mutation.busy}
                onConfirm={() =>
                  void mutation.run(async () => {
                    const data = await automation.dispatch(
                      context.repository,
                      validated,
                    );
                    setResult(
                      `${data.replayed ? "已有事件重放" : "事件已派发"}：${data.runs.length} 次运行，${data.skipped.length} 条规则未执行`,
                    );
                    setValidated(null);
                  }, "事件派发已完成")
                }
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="wb-notice wb-notice-error">
              {error}
            </p>
          ) : null}
        </CreationForm>
      ) : null}
      <MutationNotice {...mutation} />
      {result ? (
        <p className="wb-notice" role="status">
          {result}
        </p>
      ) : null}
      <CollectionState
        {...list}
        count={list.items.length}
        empty="尚未收到审查事件"
        hint="真实审查交付或手动派发完成后，可在此核查匹配结果。"
      >
        {list.items.map((stored) => (
          <article className="wb-record" key={stored.id}>
            <div className="wb-record-head">
              <div>
                <h3>{stored.event.type}</h3>
                <p>{stored.id}</p>
              </div>
              <span className="chip">{stored.runIds.length} 次运行</span>
            </div>
            <DefinitionList
              values={[
                ["事件发生", formatDate(stored.event.occurredAt)],
                ["收到时间", formatDate(stored.receivedAt)],
                ["门禁结果", stored.event.gate ?? "未提供"],
                ["风险", stored.event.risk ?? "未提供"],
                [
                  "对象",
                  stored.event.subject
                    ? `${stored.event.subject.kind} #${stored.event.subject.number}`
                    : "未提供",
                ],
                ["未执行规则", stored.skipped.length],
              ]}
            />
            <details className="wb-subdetails">
              <summary>事件内容与匹配结果</summary>
              <pre className="wb-json">
                {JSON.stringify(stored.event, null, 2)}
              </pre>
              <p className="wb-help">
                内容哈希：<code className="wb-hash">{stored.hash}</code>
              </p>
              {stored.runIds.length ? (
                <p>运行 ID：{stored.runIds.join(", ")}</p>
              ) : null}
              {stored.skipped.map((skipped, index) => (
                <div
                  key={`${skipped.ruleId}:${index}`}
                  className="auto-event-skip"
                >
                  <strong>
                    {skipped.ruleId} · {skipped.reason}
                  </strong>
                  <ExplanationTree explanation={skipped.explanation} />
                </div>
              ))}
            </details>
          </article>
        ))}
      </CollectionState>
      <AutomationPager {...list} />
    </WorkbenchSection>
  );
}
