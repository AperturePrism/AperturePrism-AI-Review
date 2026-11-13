/** 自动化生成报告只按纯文本预览和下载；不把报告正文作为 HTML 注入页面。 */
import { useState } from "react";
import { AutomationPager } from "../../components/automation";
import {
  CollectionState,
  DefinitionList,
  MutationNotice,
  WorkbenchSection,
  formatDate,
} from "../../components/workbench";
import { useAutomationRows } from "../../hooks/useAutomation";
import { useWorkbenchMutation } from "../../hooks/useWorkbench";
import {
  automation,
  saveAutomationFile,
  type AutomationArtifact,
  type AutomationPageContext,
} from "../../lib/automation";
export function AutomationReports(context: AutomationPageContext) {
  const list = useAutomationRows("artifacts", context.repository);
  const [selected, setSelected] = useState<AutomationArtifact | null>(null);
  const mutation = useWorkbenchMutation();
  return (
    <WorkbenchSection
      title="自动化生成的报告"
      description="报告来自实际完成的 report.create 步骤；创建规则本身不会预生成报告。"
      actions={
        <button className="btn" disabled={list.loading} onClick={list.refresh}>
          刷新报告
        </button>
      }
    >
      <MutationNotice {...mutation} />
      <CollectionState
        {...list}
        count={list.items.length}
        empty="暂无已生成的报告"
        hint="包含生成报告动作的规则完成后，结果会显示在这里。"
      >
        {list.items.map((artifact) => (
          <article className="wb-record" key={artifact.id}>
            <div className="wb-record-head">
              <div>
                <h3>{artifact.format.toUpperCase()} 审查报告</h3>
                <p>运行 {artifact.runId}</p>
              </div>
              <span className="chip">{formatDate(artifact.createdAt)}</span>
            </div>
            <div className="actions">
              <button
                className="btn"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(
                    async () =>
                      setSelected(
                        await automation.artifact(
                          context.repository,
                          artifact.id,
                        ),
                      ),
                    "报告已加载",
                  )
                }
              >
                纯文本预览
              </button>
              <button
                className="btn btn-primary"
                disabled={mutation.busy}
                onClick={() =>
                  void mutation.run(async () => {
                    const full = await automation.artifact(
                      context.repository,
                      artifact.id,
                    );
                    const extension =
                      full.format === "markdown"
                        ? "md"
                        : full.format === "sarif"
                          ? "sarif.json"
                          : /^(json|csv|txt)$/.test(full.format)
                            ? full.format
                            : "txt";
                    saveAutomationFile(
                      full.content,
                      `automation-${full.id}.${extension}`,
                      full.mediaType,
                    );
                  }, "报告已下载")
                }
              >
                下载报告
              </button>
            </div>
          </article>
        ))}
      </CollectionState>
      <AutomationPager {...list} />
      {selected ? (
        <section className="auto-report-preview">
          <div className="wb-record-head">
            <h3>报告纯文本预览</h3>
            <button className="btn" onClick={() => setSelected(null)}>
              关闭预览
            </button>
          </div>
          <DefinitionList
            values={[
              ["报告 ID", selected.id],
              ["格式", selected.format],
              ["生成时间", formatDate(selected.createdAt)],
            ]}
          />
          <pre className="wb-json">{selected.content}</pre>
        </section>
      ) : null}
    </WorkbenchSection>
  );
}
