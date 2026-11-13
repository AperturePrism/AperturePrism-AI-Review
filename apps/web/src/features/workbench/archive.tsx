/** 仓库备份：先预览校验和与影响，再由管理员明确恢复；界面不自动写入。 */
import { useState } from "react";
import {
  ConfirmAction,
  DefinitionList,
  Field,
  MutationNotice,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";
import {
  downloadArchive,
  explainWorkbenchError,
  workbench,
  type ArchivePreview,
} from "../../lib/workbench";
import type { WorkbenchTab } from "../../lib/workbench-tabs";
export const tab: WorkbenchTab = {
  id: "archive",
  label: "备份归档",
  description: "下载完整仓库工作台归档，恢复前验证 SHA-256 和替换范围。",
  order: 110,
  render: ({ repository }) => <Archives repository={repository} />,
};
const COLLECTION_LABELS: Record<string, string> = {
  policies: "策略",
  baselines: "基线",
  findings: "发现",
  suppressions: "抑制规则",
  batches: "批次",
  feedback: "人工反馈",
  budgets: "预算",
  reservations: "预算预占",
  evaluations: "评估",
  reviews: "审查交付",
  audit: "原始审计证据",
};
export function Archives({ repository }: { repository: string }) {
  const [archive, setArchive] = useState<unknown>(null);
  const [filename, setFilename] = useState("");
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [checksum, setChecksum] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const mutation = useWorkbenchMutation();
  const download = useWorkbenchMutation();
  return (
    <>
      <WorkbenchSection
        title="下载当前仓库归档"
        description="归档包含当前仓库的策略、发现、批次、预算、评估和审计证据；请保存在可信位置。"
      >
        <button
          className="btn btn-primary"
          type="button"
          disabled={download.busy}
          onClick={() =>
            void download.run(
              () => downloadArchive(repository),
              "仓库归档已下载",
            )
          }
        >
          下载仓库备份
        </button>
        <MutationNotice {...download} />
      </WorkbenchSection>
      <WorkbenchSection
        title="校验与恢复归档"
        description="恢复会替换当前仓库工作台记录。其他仓库和当前审计历史会保留，原始归档审计仅作为证据保存。"
      >
        <label className="wb-file-input">
          选择工作台归档（JSON，最多 32 MiB）
          <input
            type="file"
            accept="application/json,.json"
            disabled={mutation.busy || reading}
            onChange={(event) => {
              const file = event.target.files?.[0];
              setPreview(null);
              setArchive(null);
              setChecksum("");
              setConfirmed(false);
              setError(null);
              mutation.clear();
              if (!file) return;
              if (file.size > 32 * 1024 * 1024) {
                setError("归档文件不得超过 32 MiB");
                return;
              }
              setReading(true);
              setFilename(file.name);
              void file
                .text()
                .then((text) => {
                  const data: unknown = JSON.parse(text);
                  if (
                    !data ||
                    typeof data !== "object" ||
                    Array.isArray(data) ||
                    !("format" in data) ||
                    data.format !== "apertureprism-workbench-archive"
                  )
                    throw new Error("这不是有效的工作台归档文件");
                  setArchive(data);
                })
                .catch((reason) => setError(explainWorkbenchError(reason)))
                .finally(() => setReading(false));
            }}
          />
        </label>
        {reading ? (
          <p role="status">读取归档中…</p>
        ) : filename && archive ? (
          <p className="wb-help">已选择 {filename}</p>
        ) : null}
        <button
          type="button"
          className="btn"
          disabled={!archive || reading || mutation.busy}
          onClick={() =>
            void mutation.run(async () => {
              const result = await workbench.previewArchive(
                repository,
                archive,
              );
              setPreview(result);
              setChecksum("");
              setConfirmed(false);
            }, "归档校验与影响预览已完成")
          }
        >
          校验并预览影响
        </button>
        <MutationNotice {...mutation} />
        {error ? (
          <p className="wb-notice wb-notice-error" role="alert">
            {error}
          </p>
        ) : null}
        {preview ? (
          <div className="wb-archive-preview">
            <DefinitionList
              values={[
                ["目标仓库", preview.repository],
                ["归档创建时间", formatDate(preview.createdAt)],
                [
                  "SHA-256 校验和",
                  <code className="wb-hash">{preview.checksum}</code>,
                ],
              ]}
            />
            <div className="tablewrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>记录</th>
                    <th>当前数量</th>
                    <th>恢复后数量</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(preview.counts).map(([key, count]) => (
                    <tr key={key}>
                      <td>{COLLECTION_LABELS[key] ?? key}</td>
                      <td>
                        {
                          preview.currentCounts[
                            key as keyof typeof preview.currentCounts
                          ]
                        }
                      </td>
                      <td>{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.warnings.length ? (
              <ul className="wb-import-warnings">
                {preview.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {!preview.canRestore ? (
              <p className="wb-notice wb-notice-warning">
                当前账号可以预览归档。只有管理员可以执行恢复。
              </p>
            ) : (
              <>
                <Field
                  label="确认校验和"
                  required
                  help="将上方完整 SHA-256 校验和粘贴到这里，确认恢复的是这份归档。"
                >
                  <input
                    className="input wb-code"
                    value={checksum}
                    onChange={(event) => setChecksum(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>
                <label className="wb-inline-label">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) => setConfirmed(event.target.checked)}
                  />
                  我已备份当前数据，并理解这将替换当前仓库记录
                </label>
                <ConfirmAction
                  label="恢复当前仓库"
                  dangerous
                  message={`确认使用「${filename}」替换 ${repository} 的工作台记录？此操作不会自动保留被替换的当前记录。`}
                  disabled={
                    !confirmed ||
                    checksum.trim() !== preview.checksum ||
                    mutation.busy
                  }
                  onConfirm={() =>
                    void mutation.run(async () => {
                      await workbench.restoreArchive(
                        repository,
                        archive,
                        checksum.trim(),
                      );
                      setPreview(null);
                      setArchive(null);
                      setConfirmed(false);
                      setChecksum("");
                    }, "仓库归档已恢复，请刷新其他工作台页面")
                  }
                />
              </>
            )}
          </div>
        ) : null}
      </WorkbenchSection>
    </>
  );
}
