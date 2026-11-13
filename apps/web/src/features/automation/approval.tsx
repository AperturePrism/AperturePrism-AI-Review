/** 审批能力来自宿主 viewer；自行审批和只读账号在界面及服务端同时受限。 */
import { useState } from "react";
import { AutomationPager } from "../../components/automation";
import {
  CollectionState,
  ConfirmAction,
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
  type Approval,
  type AutomationPageContext,
} from "../../lib/automation";
export function AutomationApprovals(context: AutomationPageContext) {
  const [state, setState] = useState("pending");
  const list = useAutomationRows("approvals", context.repository, state);
  return (
    <WorkbenchSection
      title="人工审批"
      description="需要独立审批人的步骤，必须由另一位有管理权限的管理员确认；共享管理员令牌使用同一操作者身份。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新审批
        </button>
      }
    >
      <label className="wb-inline-label">
        审批状态
        <select
          className="input"
          value={state}
          onChange={(event) => setState(event.target.value)}
        >
          <option value="pending">等待审批</option>
          <option value="approved">已同意</option>
          <option value="rejected">已拒绝</option>
          <option value="">全部</option>
        </select>
      </label>
      <CollectionState
        {...list}
        count={list.items.length}
        empty="没有匹配的审批请求"
      >
        {list.items.map((approval) => (
          <ApprovalCard
            key={`${approval.id}:${approval.state}`}
            {...context}
            approval={approval}
            onSaved={() => {
              list.refresh();
              context.onChanged();
            }}
          />
        ))}
      </CollectionState>
      <AutomationPager {...list} />
    </WorkbenchSection>
  );
}
export function ApprovalCard(
  context: AutomationPageContext & { approval: Approval; onSaved: () => void },
) {
  const { approval, viewer } = context;
  const [note, setNote] = useState("");
  const mutation = useWorkbenchMutation(context.onSaved);
  const selfBlocked =
    approval.requireDifferentActor && approval.requestedBy === viewer.userId;
  const allowed =
    viewer.canWrite &&
    viewer.isAdmin &&
    !selfBlocked &&
    approval.state === "pending";
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{approval.title}</h3>
          <p>{approval.reason}</p>
        </div>
        <span
          className={`pill ${approval.state === "approved" ? "pill-ok" : approval.state === "rejected" ? "pill-err" : "pill-warn"}`}
        >
          {approval.state === "pending"
            ? "待审批"
            : approval.state === "approved"
              ? "已同意"
              : "已拒绝"}
        </span>
      </div>
      <DefinitionList
        values={[
          ["请求人", approval.requestedBy],
          ["请求时间", formatDate(approval.createdAt)],
          ["运行 ID", <code>{approval.runId}</code>],
          [
            "独立审批人",
            approval.requireDifferentActor ? "必须与请求人不同" : "未要求",
          ],
        ]}
      />
      {approval.state !== "pending" ? (
        <div className="wb-resolution">
          <strong>审批结论</strong>
          <p>{approval.note || "未填写附言"}</p>
          <small>
            {approval.decidedBy} · {formatDate(approval.decidedAt)}
          </small>
        </div>
      ) : (
        <>
          {selfBlocked ? (
            <p className="wb-notice wb-notice-warning">
              你是此步骤的请求人，需要另一位管理员审批。
            </p>
          ) : !viewer.isAdmin ? (
            <p className="wb-help">只有管理员可以作出审批决定。</p>
          ) : !viewer.canWrite ? (
            <p className="wb-help">当前账号为只读，不能作出审批决定。</p>
          ) : null}
          <Field label="审批附言" help="记录本次决定的依据，最多 2000 字。">
            <textarea
              className="input"
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
              disabled={!allowed || mutation.busy}
            />
          </Field>
          <div className="actions">
            <ConfirmAction
              label="同意审批"
              message="同意后可在执行记录继续运行。请确认已核查事件和执行计划。"
              disabled={!allowed || mutation.busy}
              onConfirm={() =>
                void mutation.run(
                  () =>
                    automation.decide(
                      context.repository,
                      approval.id,
                      true,
                      note.trim(),
                    ),
                  "审批已同意，可在执行记录继续运行",
                )
              }
            />
            <ConfirmAction
              label="拒绝执行"
              dangerous
              message="拒绝后此运行会失败，后续步骤不会继续执行。"
              disabled={!allowed || mutation.busy}
              onConfirm={() =>
                void mutation.run(
                  () =>
                    automation.decide(
                      context.repository,
                      approval.id,
                      false,
                      note.trim(),
                    ),
                  "已拒绝此运行",
                )
              }
            />
          </div>
        </>
      )}
      <MutationNotice {...mutation} />
    </article>
  );
}
