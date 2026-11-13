/** 导入必须经过预览，提交由后端单一事务完成；无效项不会留下部分发现。 */
import { useState } from "react";
import {
  Field,
  MutationNotice,
  PagedList,
  SeverityBadge,
  WorkbenchSection,
} from "../../components/workbench";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";
import {
  parseFindingImport,
  type ImportPreview,
} from "../../lib/finding-import";
import { workbench } from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "intake",
  label: "导入发现",
  description:
    "将 SARIF 或审查 JSON 的真实结果导入当前仓库，先预览再整批提交。",
  order: 35,
  render: ({ repository }) => <Intake repository={repository} />,
};
export function Intake({ repository }: { repository: string }) {
  const [format, setFormat] = useState<"sarif" | "json">("sarif");
  const [content, setContent] = useState("");
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useWorkbenchMutation();
  const reset = () => {
    setPreview(null);
    setConfirmed(false);
    mutation.clear();
  };
  return (
    <WorkbenchSection
      title="导入审查发现"
      description="支持 SARIF 2.1.0 和工作台 findings JSON。文件内容只用于解析数据，不执行脚本，不自动接纳外部抑制。"
    >
      <form
        className="wb-form"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          mutation.clear();
          try {
            setPreview(parseFindingImport(content, format, reference));
            setConfirmed(false);
          } catch (reason) {
            setPreview(null);
            setError(
              reason instanceof Error ? reason.message : "无法读取导入内容",
            );
          }
        }}
      >
        <Field label="导入格式">
          <select
            className="input"
            value={format}
            onChange={(event) => {
              setFormat(event.target.value as "sarif" | "json");
              reset();
            }}
          >
            <option value="sarif">SARIF 2.1.0</option>
            <option value="json">发现 JSON</option>
          </select>
        </Field>
        <Field
          label="关联引用"
          help="为本次导入统一指定提交、分支或标签；留空保留报告中的引用。"
        >
          <input
            className="input wb-code"
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
              reset();
            }}
            maxLength={500}
          />
        </Field>
        <Field
          label="报告内容"
          wide
          required
          help="JSON 格式接受对象数组，或包含 findings 数组的对象。"
        >
          <textarea
            className="input wb-code"
            rows={10}
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              reset();
            }}
            required
            spellCheck={false}
          />
        </Field>
        <label className="wb-file-input">
          从报告文件读取（最多 2 MiB）
          <input
            type="file"
            accept=".json,.sarif,application/json,application/sarif+json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              reset();
              setError(null);
              if (file.size > 2 * 1024 * 1024) {
                setError("导入文件不得超过 2 MiB");
                return;
              }
              void file
                .text()
                .then(setContent)
                .catch(() => setError("文件读取失败"));
            }}
          />
        </label>
        <div className="wb-form-footer">
          <button
            className="btn btn-primary"
            type="submit"
            disabled={mutation.busy}
          >
            验证并预览
          </button>
        </div>
      </form>
      {error ? (
        <p className="wb-notice wb-notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <MutationNotice {...mutation} />
      {preview ? (
        <div className="wb-import-preview">
          <h3>导入预览：{preview.findings.length} 个发现</h3>
          <p className="wb-help">
            目标仓库 <strong>{repository}</strong>；跳过或合并 {preview.skipped}{" "}
            项。同一稳定指纹会更新现有发现，而不是重复新增。
          </p>
          {preview.warnings.length ? (
            <details className="wb-subdetails">
              <summary>查看 {preview.warnings.length} 条导入提示</summary>
              <ul className="wb-import-warnings">
                {preview.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <PagedList
            items={preview.findings}
            label="待导入发现"
            pageSize={10}
            searchText={(item) => `${item.title} ${item.path} ${item.ruleId}`}
            render={(item) => (
              <article
                className="wb-mini-record"
                key={`${item.ruleId}:${item.path}:${item.title}`}
              >
                <div className="wb-record-head">
                  <strong>{item.title}</strong>
                  <SeverityBadge severity={item.severity} />
                </div>
                <p>
                  <code>
                    {item.path}:{item.line}
                  </code>{" "}
                  · {item.ruleId}
                </p>
                <p className="wb-help">
                  来源：{item.source} · 置信度{" "}
                  {Math.round(item.confidence * 100)}%
                </p>
              </article>
            )}
          />
          <label className="wb-inline-label">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已核对仓库范围和导入内容
          </label>
          <div className="wb-form-footer">
            <button
              className="btn btn-primary"
              type="button"
              disabled={mutation.busy || !confirmed || !preview.findings.length}
              onClick={() =>
                void mutation.run(async () => {
                  await workbench.importFindings(
                    repository,
                    preview.findings.map((finding) => ({ ...finding })),
                  );
                  setPreview(null);
                  setConfirmed(false);
                }, "发现已整批导入，可在发现与处置页查看")
              }
            >
              {mutation.busy
                ? "导入中…"
                : `导入 ${preview.findings.length} 个发现`}
            </button>
          </div>
        </div>
      ) : null}
    </WorkbenchSection>
  );
}
