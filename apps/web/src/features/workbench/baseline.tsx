/** 基线保存一组被认可的历史发现；激活新基线会替换当前对照，不删除历史。 */
import { useMemo, useState } from "react";
import {
  CollectionState,
  ConfirmAction,
  CreationForm,
  DefinitionList,
  Field,
  MutationNotice,
  PagedList,
  SeverityBadge,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import {
  useWorkbenchCollection,
  useWorkbenchMutation,
} from "../../hooks/useWorkbench";
import { parseJsonArray, workbench, type Baseline } from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";

export const tab: WorkbenchTab = {
  id: "baselines",
  label: "审查基线",
  description: "保存历史发现作为对照，明确区分已有问题与新引入的问题。",
  order: 20,
  render: ({ repository }) => <Baselines repository={repository} />,
};
export function Baselines({ repository }: { repository: string }) {
  const list = useWorkbenchCollection("baselines", repository);
  const findings = useWorkbenchCollection("findings", repository);
  const mutation = useWorkbenchMutation(list.refresh);
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"current" | "json">("current");
  const [json, setJson] = useState("[]");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const current = findings.items.filter(
    (finding) => !["fixed", "false_positive"].includes(finding.status),
  );
  const compared = useMemo(() => {
    const [left, right] = selected.map((id) =>
      list.items.find((item) => item.id === id),
    );
    if (!left || !right) return null;
    const old = new Set(left.findings.map((finding) => finding.fingerprint));
    const next = new Set(right.findings.map((finding) => finding.fingerprint));
    return {
      left,
      right,
      added: right.findings.filter((finding) => !old.has(finding.fingerprint)),
      removed: left.findings.filter(
        (finding) => !next.has(finding.fingerprint),
      ),
      kept: [...next].filter((fingerprint) => old.has(fingerprint)).length,
    };
  }, [selected, list.items]);
  return (
    <WorkbenchSection
      title="仓库审查基线"
      description="基线不是忽略清单：它记录已有问题，新增问题仍由质量门禁决定。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新基线
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CreationForm title="创建基线快照">
        <form
          className="wb-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            void mutation.run(async () => {
              if (!name.trim()) throw new Error("请填写基线名称");
              if (!reference.trim()) throw new Error("请填写提交或分支引用");
              if (source === "current" && (findings.loading || findings.error))
                throw new Error("当前发现尚未成功加载，请刷新或改用 JSON 导入");
              const data =
                source === "current"
                  ? { fromCurrentFindings: true }
                  : { findings: parseJsonArray(json, "基线发现") };
              await workbench.create("baselines", repository, {
                name: name.trim(),
                reference: reference.trim(),
                note: note.trim(),
                ...data,
              });
              setName("");
              setReference("");
              setNote("");
            }, "基线已保存；需要对照时请显式激活");
          }}
        >
          <Field label="基线名称" required>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={160}
              required
            />
          </Field>
          <Field
            label="提交或分支引用"
            required
            help="建议填写完整提交 SHA，方便日后追溯。"
          >
            <input
              className="input wb-code"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              required
              maxLength={300}
            />
          </Field>
          <Field label="发现来源">
            <select
              className="input"
              value={source}
              onChange={(event) =>
                setSource(event.target.value as "current" | "json")
              }
            >
              <option value="current">服务端当前全部未解决发现</option>
              <option value="json">导入 JSON 对象数组</option>
            </select>
          </Field>
          <Field label="说明">
            <input
              className="input"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
            />
          </Field>
          {source === "json" ? (
            <Field
              label="基线发现 JSON"
              wide
              required
              help="每项包含 fingerprint、ruleId、path、line、severity、title。"
            >
              <textarea
                className="input wb-code"
                rows={8}
                value={json}
                onChange={(event) => setJson(event.target.value)}
                required
                spellCheck={false}
              />
              <label className="wb-file-input">
                从文件读取
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2 * 1024 * 1024) {
                      setError("导入文件不得超过 2 MiB");
                      return;
                    }
                    void file
                      .text()
                      .then(setJson)
                      .catch(() => setError("文件读取失败"));
                  }}
                />
              </label>
            </Field>
          ) : (
            <p className="wb-help wb-field-wide">
              将在服务端读取全部未解决发现并保存。页面已加载其中{" "}
              {current.length} 个供参考；已修复或误报记录不会重新带入基线。
            </p>
          )}
          {error ? (
            <p role="alert" className="wb-notice wb-notice-error">
              {error}
            </p>
          ) : null}
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              disabled={
                mutation.busy || (source === "current" && findings.loading)
              }
              type="submit"
            >
              {mutation.busy ? "保存中…" : "保存基线快照"}
            </button>
          </div>
        </form>
      </CreationForm>
      {selected.length === 2 ? (
        <div className="wb-comparison" aria-live="polite">
          {compared ? (
            <>
              <h3>
                对比：{compared.left.name} → {compared.right.name}
              </h3>
              <div className="wb-gate-counts">
                <span>
                  新增 <strong>{compared.added.length}</strong>
                </span>
                <span>
                  移除 <strong>{compared.removed.length}</strong>
                </span>
                <span>
                  保留 <strong>{compared.kept}</strong>
                </span>
              </div>
              <div className="wb-two-columns">
                <div>
                  <h4>新增发现</h4>
                  {compared.added.map((finding) => (
                    <p key={finding.fingerprint}>
                      <SeverityBadge severity={finding.severity} />{" "}
                      {finding.title}{" "}
                      <code>
                        {finding.path}:{finding.line}
                      </code>
                    </p>
                  ))}
                </div>
                <div>
                  <h4>移除发现</h4>
                  {compared.removed.map((finding) => (
                    <p key={finding.fingerprint}>
                      {finding.title}{" "}
                      <code>
                        {finding.path}:{finding.line}
                      </code>
                    </p>
                  ))}
                </div>
              </div>
            </>
          ) : null}
          <button className="btn" onClick={() => setSelected([])}>
            结束对比
          </button>
        </div>
      ) : null}
      <CollectionState
        {...list}
        count={list.items.length}
        empty="还没有基线"
        hint="从当前发现创建一份快照，或导入已保存的发现 JSON。"
      >
        <PagedList
          items={list.items}
          label="基线"
          searchText={(item) => `${item.name} ${item.reference} ${item.note}`}
          render={(baseline) => (
            <BaselineCard
              key={baseline.id}
              baseline={baseline}
              repository={repository}
              refresh={list.refresh}
              selected={selected.includes(baseline.id)}
              onSelect={() =>
                setSelected((previous) =>
                  previous.includes(baseline.id)
                    ? previous.filter((id) => id !== baseline.id)
                    : [...previous.slice(-1), baseline.id],
                )
              }
            />
          )}
        />
      </CollectionState>
    </WorkbenchSection>
  );
}
function BaselineCard({
  baseline,
  repository,
  refresh,
  selected,
  onSelect,
}: {
  baseline: Baseline;
  repository: string;
  refresh: () => void;
  selected: boolean;
  onSelect: () => void;
}) {
  const mutation = useWorkbenchMutation(refresh);
  return (
    <article className="wb-record">
      <div className="wb-record-head">
        <div>
          <h3>{baseline.name}</h3>
          <p>{baseline.note || "未填写说明"}</p>
        </div>
        <span className={`pill ${baseline.active ? "pill-ok" : "pill-dim"}`}>
          {baseline.active ? "当前对照" : "历史快照"}
        </span>
      </div>
      <DefinitionList
        values={[
          ["引用", <code>{baseline.reference}</code>],
          ["发现数量", baseline.findings.length],
          ["创建时间", formatDate(baseline.createdAt)],
        ]}
      />
      <div className="actions">
        <ConfirmAction
          label="设为当前基线"
          message={`将「${baseline.name}」设为当前对照，替换此前生效的基线。`}
          disabled={mutation.busy || baseline.active || baseline.archived}
          onConfirm={() =>
            void mutation.run(
              () =>
                workbench.action(
                  "baselines",
                  baseline.id,
                  "activate",
                  repository,
                ),
              "生效基线已更新",
            )
          }
        />
        <label className="wb-inline-label">
          <input type="checkbox" checked={selected} onChange={onSelect} />
          加入对比
        </label>
      </div>
      <MutationNotice {...mutation} />
      <details className="wb-subdetails">
        <summary>查看基线中的发现（{baseline.findings.length}）</summary>
        <div className="tablewrap">
          <table className="table">
            <thead>
              <tr>
                <th>级别</th>
                <th>发现</th>
                <th>位置</th>
                <th>规则</th>
              </tr>
            </thead>
            <tbody>
              {baseline.findings.slice(0, 200).map((finding) => (
                <tr key={finding.fingerprint}>
                  <td>
                    <SeverityBadge severity={finding.severity} />
                  </td>
                  <td>{finding.title}</td>
                  <td>
                    <code>
                      {finding.path}:{finding.line}
                    </code>
                  </td>
                  <td>{finding.ruleId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {baseline.findings.length > 200 ? (
          <p className="wb-help">
            为保持页面流畅，仅展示前 200 个；完整内容可通过报告导出查看。
          </p>
        ) : null}
      </details>
    </article>
  );
}
