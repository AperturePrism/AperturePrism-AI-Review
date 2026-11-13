/** 离线评估用明确的期望与观察标签计算精确率、召回率和 F1，不调用付费模型。 */
import { useEffect, useState } from "react";
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
  parseJsonArray,
  workbench,
  explainWorkbenchError,
  type Evaluation,
  type EvaluationResult,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "evaluations",
  label: "质量评估",
  description: "对照人工标注检查误报与漏报，用同一组指标比较审查质量。",
  order: 80,
  render: ({ repository }) => <Evaluations repository={repository} />,
};
export function Evaluations({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("evaluations", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [cases, setCases] = useState("[]");
  const [error, setError] = useState<string | null>(null);
  return (
    <WorkbenchSection
      title="离线审查评估"
      description="填写已经取得的审查结果与人工期望；创建评估不会发起模型调用或产生模型费用。"
      actions={
        <button className="btn" onClick={list.refresh} disabled={list.loading}>
          刷新评估
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CreationForm title="创建评估记录">
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            const submit = async () => {
              try {
                if (!name.trim() || !model.trim())
                  throw new Error("请填写评估名称和模型标识");
                const items = parseJsonArray(cases, "评估样本");
                if (!items.length) throw new Error("评估至少需要一个样本");
                const result = await mutation.run(
                  () =>
                    workbench.create("evaluations", repository, {
                      name: name.trim(),
                      model: model.trim(),
                      reference: reference.trim(),
                      note: note.trim(),
                      cases: items,
                    }),
                  "评估记录已保存",
                );
                if (result) setName("");
              } catch (reason) {
                setError(
                  reason instanceof Error ? reason.message : "评估填写有误",
                );
              }
            };
            void submit();
          }}
        >
          <Field label="评估名称" required>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={160}
            />
          </Field>
          <Field label="模型或运行标识" required>
            <input
              className="input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              required
              maxLength={300}
            />
          </Field>
          <Field label="代码引用">
            <input
              className="input wb-code"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              maxLength={300}
            />
          </Field>
          <Field label="备注">
            <input
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
            />
          </Field>
          <Field
            label="评估样本 JSON"
            required
            wide
            help="每项包含 id、name、expected（期望规则标签）、observed（实际规则标签）、weight（正数权重）。"
          >
            <textarea
              className="input wb-code"
              rows={10}
              value={cases}
              onChange={(event) => setCases(event.target.value)}
              required
              spellCheck={false}
            />
          </Field>
          {error ? (
            <p className="wb-notice wb-notice-error wb-field-wide" role="alert">
              {error}
            </p>
          ) : null}
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={mutation.busy}
            >
              {mutation.busy ? "保存中…" : "保存并评估"}
            </button>
          </div>
        </form>
      </CreationForm>
      <CollectionState
        {...list}
        count={list.items.length}
        empty="还没有评估记录"
        hint="使用相同样本分别记录不同模型或策略的观察结果，再比较指标。"
      >
        <PagedList
          items={list.items}
          label="评估"
          pageSize={10}
          searchText={(item) =>
            `${item.name} ${item.model} ${item.reference} ${item.note}`
          }
          render={(evaluation) => (
            <EvaluationCard
              key={evaluation.id}
              evaluation={evaluation}
              repository={repository}
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
function EvaluationCard({
  evaluation,
  repository,
}: {
  evaluation: Evaluation;
  repository: string;
}) {
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    workbench
      .evaluate(evaluation.id, repository)
      .then((value) => {
        if (active) setResult(value);
      })
      .catch((reason) => {
        if (active) setError(explainWorkbenchError(reason));
      });
    return () => {
      active = false;
    };
  }, [evaluation.id, repository]);
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{evaluation.name}</h3>
          <p>
            {evaluation.model} · {evaluation.reference || "未指定引用"}
          </p>
        </div>
        <span className="chip">{evaluation.cases.length} 个样本</span>
      </div>
      <p>{evaluation.note}</p>
      {error ? (
        <p className="wb-notice wb-notice-error" role="alert">
          {error}
        </p>
      ) : result ? (
        <>
          <div className="wb-metrics">
            {(
              [
                ["精确率", result.precision],
                ["召回率", result.recall],
                ["F1", result.f1],
                ["加权通过率", result.weightedScore],
              ] as [string, number][]
            ).map(([label, value]) => (
              <div className="wb-metric" key={label}>
                <span>{label}</span>
                <strong>
                  {(value * 100).toFixed(1)}
                  <small>%</small>
                </strong>
              </div>
            ))}
          </div>
          <DefinitionList
            values={[
              ["正确发现", result.truePositive],
              ["误报", result.falsePositive],
              ["漏报", result.falseNegative],
              ["通过样本", `${result.passedCases} / ${result.totalCases}`],
              ["创建时间", formatDate(evaluation.createdAt)],
            ]}
          />
          <details className="wb-subdetails">
            <summary>逐样本结果</summary>
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>样本</th>
                    <th>结果</th>
                    <th>命中</th>
                    <th>多报</th>
                    <th>遗漏</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cases.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {evaluation.cases.find(
                          (sample) => sample.id === item.id,
                        )?.name ?? item.id}
                      </td>
                      <td>
                        <span
                          className={`pill ${item.passed ? "pill-ok" : "pill-err"}`}
                        >
                          {item.passed ? "通过" : "未通过"}
                        </span>
                      </td>
                      <td>{item.matched.join(", ") || "无"}</td>
                      <td>{item.extra.join(", ") || "无"}</td>
                      <td>{item.missed.join(", ") || "无"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <p role="status" className="wb-help">
          计算指标中…
        </p>
      )}
    </article>
  );
}
