/** 人工反馈保留原始判断；解决反馈仅附加处置说明，不覆盖用户的原话。 */
import { useMemo, useState } from "react";
import {
  CollectionState,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  PagedList,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import {
  useWorkbenchCollection,
  useWorkbenchMutation,
} from "../../hooks/useWorkbench";
import {
  workbench,
  type Feedback,
  type FeedbackVerdict,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "feedback",
  label: "人工反馈",
  description: "收集审查价值与误报反馈，留下可追踪的处理结论。",
  order: 60,
  render: ({ repository }) => <FeedbackPage repository={repository} />,
};
const VERDICTS: Record<FeedbackVerdict, string> = {
  useful: "有帮助",
  false_positive: "误报",
  missed_issue: "漏报",
  unclear: "解释不清",
};
export function FeedbackPage({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("feedback", repository);
  const findings = useWorkbenchCollection("findings", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [filter, setFilter] = useState("pending");
  const [verdict, setVerdict] = useState<FeedbackVerdict>("useful");
  const [findingId, setFindingId] = useState("");
  const [comment, setComment] = useState("");
  const items = list.items.filter(
    (item) =>
      filter === "all" ||
      (filter === "pending" ? !item.resolved : item.resolved),
  );
  const names = useMemo(
    () => new Map(findings.items.map((finding) => [finding.id, finding.title])),
    [findings.items],
  );
  const counts = Object.keys(VERDICTS).map((key) => ({
    verdict: key as FeedbackVerdict,
    count: list.items.filter((item) => item.verdict === key).length,
  }));
  return (
    <WorkbenchSection
      title="审查反馈"
      actions={
        <button className="btn" onClick={list.refresh} disabled={list.loading}>
          刷新反馈
        </button>
      }
    >
      <div className="wb-metrics">
        {counts.map(({ verdict, count }) => (
          <div className="wb-metric" key={verdict}>
            <span>{VERDICTS[verdict]}</span>
            <strong>{count}</strong>
            <small>当前仓库累计反馈</small>
          </div>
        ))}
      </div>
      <MutationNotice {...mutation} />
      <CreationForm title="提交人工反馈">
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(async () => {
              if (!findingId) throw new Error("请选择关联的发现");
              if (!comment.trim())
                throw new Error("请说明反馈依据，便于后续核查");
              await workbench.create("feedback", repository, {
                findingId,
                verdict,
                comment: comment.trim(),
              });
              setComment("");
            }, "反馈已提交");
          }}
        >
          <Field label="关联发现" required>
            <select
              className="input"
              value={findingId}
              onChange={(event) => setFindingId(event.target.value)}
              required
            >
              <option value="">选择一个发现</option>
              {findings.items.map((finding) => (
                <option key={finding.id} value={finding.id}>
                  {finding.title} · {finding.path}:{finding.line}
                </option>
              ))}
            </select>
            {findings.error ? (
              <small role="alert">{findings.error}</small>
            ) : null}
          </Field>
          <Field label="判断">
            <select
              className="input"
              value={verdict}
              onChange={(event) =>
                setVerdict(event.target.value as FeedbackVerdict)
              }
            >
              {Object.entries(VERDICTS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="反馈依据" required wide>
            <textarea
              className="input"
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              required
              rows={3}
              maxLength={10000}
            />
          </Field>
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={mutation.busy || findings.loading}
            >
              {mutation.busy ? "提交中…" : "提交反馈"}
            </button>
          </div>
        </form>
      </CreationForm>
      <label className="wb-inline-label">
        处理状态{" "}
        <select
          className="input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="pending">待处理</option>
          <option value="resolved">已处理</option>
          <option value="all">全部反馈</option>
        </select>
      </label>
      <CollectionState
        {...list}
        count={items.length}
        empty={filter === "pending" ? "当前没有待处理反馈" : "暂无反馈"}
        hint="人工确认审查结果后，在这里记录有帮助、误报或漏报的依据。"
      >
        <PagedList
          items={items}
          label="反馈"
          searchText={(item) =>
            `${item.comment} ${item.resolution} ${names.get(item.findingId) ?? item.findingId}`
          }
          render={(item) => (
            <FeedbackCard
              key={item.id}
              feedback={item}
              findingName={names.get(item.findingId) ?? item.findingId}
              repository={repository}
              refresh={list.refresh}
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
function FeedbackCard({
  feedback,
  findingName,
  repository,
  refresh,
}: {
  feedback: Feedback;
  findingName: string;
  repository: string;
  refresh: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  const [resolution, setResolution] = useState("");
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{findingName}</h3>
          <p>{VERDICTS[feedback.verdict]}</p>
        </div>
        <span className={`pill ${feedback.resolved ? "pill-ok" : "pill-warn"}`}>
          {feedback.resolved ? "已处理" : "待处理"}
        </span>
      </div>
      <p className="wb-preserve-text">{feedback.comment}</p>
      <DefinitionList
        values={[
          ["提交人", feedback.createdBy],
          ["提交时间", formatDate(feedback.createdAt)],
        ]}
      />
      {feedback.resolved ? (
        <div className="wb-resolution">
          <strong>处理结论</strong>
          <p>{feedback.resolution}</p>
          <small>
            {feedback.resolvedBy} · {formatDate(feedback.resolvedAt)}
          </small>
        </div>
      ) : (
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            void mutation.run(async () => {
              if (!resolution.trim()) throw new Error("请填写处理结论");
              await workbench.action(
                "feedback",
                feedback.id,
                "resolve",
                repository,
                { resolution: resolution.trim() },
              );
            }, "反馈已处理");
          }}
        >
          <Field label="处理结论" required wide>
            <textarea
              className="input"
              rows={2}
              required
              value={resolution}
              onChange={(event) => setResolution(event.target.value)}
              maxLength={10000}
            />
          </Field>
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              disabled={mutation.busy}
              type="submit"
            >
              保存处理结论
            </button>
          </div>
        </form>
      )}
      <MutationNotice {...mutation} />
    </article>
  );
}
