/** 全局审核规则：沿用已保存内容，文件与 URL 先预览，带版本保存才生效。 */
import { useEffect, useId, useState } from "react";
import {
  fetchGlobalRules,
  GlobalRulesError,
  previewGlobalRulesUrl,
  saveGlobalRules,
  type GlobalRulesSnapshot,
} from "../lib/api/global-rules";
import { explainUnknown } from "../lib/errors";
import { SettingsSection } from "./SettingsSection";
import { ErrorPanel, fmtTime, LoadingRows } from "./ui";

type ImportPreview = { content: string; source: string };
type Limits = Pick<GlobalRulesSnapshot, "maxChars" | "maxBytes">;

function validateText(content: string, limits: Limits): void {
  if (content.length > limits.maxChars)
    throw new Error(`全局规则最多 ${limits.maxChars.toLocaleString()} 个字符`);
  if (new TextEncoder().encode(content).byteLength > limits.maxBytes)
    throw new Error(
      `全局规则最多 ${limits.maxBytes.toLocaleString()} 个 UTF-8 字节`,
    );
  for (const character of content) {
    const code = character.charCodeAt(0);
    if ((code < 32 && ![9, 10, 13].includes(code)) || code === 127)
      throw new Error("规则文本不能包含二进制控制字符");
  }
}

/** FileReader 在浏览器及 DOM 测试中都按字节读取，拒绝坏 UTF-8 而非悄悄替换。 */
async function readRuleFile(file: File, limits: Limits): Promise<string> {
  if (!/\.(md|markdown|txt)$/i.test(file.name))
    throw new Error("请选择 .md、.markdown 或 .txt 规则文件");
  if (file.size > limits.maxBytes)
    throw new Error(`规则文件最多 ${limits.maxBytes.toLocaleString()} 字节`);
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result === null || typeof reader.result === "string")
        reject(new Error("无法读取规则文件"));
      else resolve(reader.result);
    };
    reader.onerror = () => reject(new Error("无法读取规则文件"));
    reader.onabort = () => reject(new Error("文件读取已取消"));
    reader.readAsArrayBuffer(file);
  });
  if (bytes.byteLength > limits.maxBytes)
    throw new Error(`规则文件最多 ${limits.maxBytes.toLocaleString()} 字节`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(
      new Uint8Array(bytes),
    );
  } catch {
    throw new Error("规则文件不是有效的 UTF-8 文本，请转换编码后再上传");
  }
  if (!content.trim())
    throw new Error("规则文件为空，请选择包含规则的文本文件");
  validateText(content, limits);
  return content;
}

export function GlobalRulesEditor() {
  const id = useId();
  const [snapshot, setSnapshot] = useState<GlobalRulesSnapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const dirty = snapshot !== null && draft !== snapshot.content;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetchGlobalRules(controller.signal)
      .then((value) => {
        if (!active) return;
        setSnapshot(value);
        setDraft(value.content);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof GlobalRulesError && reason.status === 403)
          setForbidden(true);
        else setError(explainUnknown(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const reload = async (discardDraft = false) => {
    if ((dirty || preview) && !discardDraft) {
      setNotice(
        "当前有未保存的修改，草稿不会被刷新覆盖。保存后再刷新，或明确放弃修改并重新加载。",
      );
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const value = await fetchGlobalRules();
      setSnapshot(value);
      setDraft(value.content);
      setPreview(null);
      setForbidden(false);
    } catch (reason) {
      if (reason instanceof GlobalRulesError && reason.status === 403) {
        setForbidden(true);
        setSnapshot(null);
      } else setError(explainUnknown(reason));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!snapshot?.canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      validateText(draft, snapshot);
      const value = await saveGlobalRules(draft, snapshot.contentHash);
      setSnapshot(value);
      setDraft(value.content);
      setNotice("全局审核规则已保存，对后续 Issue / PR 分析生效。");
    } catch (reason) {
      setError(explainUnknown(reason));
    } finally {
      setBusy(false);
    }
  };

  const selectFile = async (file: File | undefined) => {
    if (!file || !snapshot?.canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setPreview({
        content: await readRuleFile(file, snapshot),
        source: file.name,
      });
    } catch (reason) {
      setError(explainUnknown(reason));
    } finally {
      setBusy(false);
    }
  };

  const importUrl = async () => {
    if (!snapshot?.canManage) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let parsed: URL;
      try {
        parsed = new URL(url.trim());
      } catch {
        throw new Error("请填写有效的 HTTP 或 HTTPS 规则链接");
      }
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error("请填写不含账号密码的 HTTP 或 HTTPS 规则链接");
      const value = await previewGlobalRulesUrl(parsed.href);
      if (!value.content.trim()) throw new Error("链接返回的规则文本为空");
      validateText(value.content, snapshot);
      setPreview({ content: value.content, source: value.sourceUrl });
    } catch (reason) {
      setError(explainUnknown(reason));
    } finally {
      setBusy(false);
    }
  };

  const applyImport = (replace: boolean) => {
    if (!preview || !snapshot?.canManage) return;
    const value =
      replace || !draft
        ? preview.content
        : `${draft}${draft.endsWith("\n\n") ? "" : "\n\n"}${preview.content}`;
    try {
      validateText(value, snapshot);
      setDraft(value);
      setPreview(null);
      setError(null);
      setNotice("导入内容已放入草稿，点击「保存全局规则」后才会生效。");
    } catch (reason) {
      setError(explainUnknown(reason));
    }
  };

  return (
    <>
      <section className="panel" aria-labelledby={`${id}-title`}>
        <div className="panel-title">
          <h2 id={`${id}-title`}>全局审核规则</h2>
          {!forbidden && (
            <button
              className="btn"
              disabled={loading || busy}
              onClick={() => void reload()}
            >
              刷新已保存规则
            </button>
          )}
        </div>
        <p id={`${id}-help`} className="faint">
          统一应用于所有 Issue / PR 分析及 PR
          专家团队，与仓库目录和外部链接规则叠加。旧的全局规则会继续沿用。
        </p>
        {forbidden ? (
          <p className="faint">
            全局审核规则由管理员维护，已保存规则会自动应用到审查。
          </p>
        ) : loading ? (
          <LoadingRows />
        ) : snapshot ? (
          <div className="stack" style={{ gap: 12 }}>
            {!snapshot.canManage && (
              <p className="faint">当前账号为只读，不能修改或导入全局规则。</p>
            )}
            <label htmlFor={`${id}-content`}>全局审核规则</label>
            <textarea
              id={`${id}-content`}
              className="input"
              value={draft}
              rows={12}
              maxLength={snapshot.maxChars}
              readOnly={!snapshot.canManage}
              disabled={busy}
              aria-describedby={`${id}-help ${id}-limit`}
              spellCheck={false}
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice(null);
              }}
              style={{
                fontFamily: "var(--font-mono, monospace)",
                resize: "vertical",
              }}
            />
            <p id={`${id}-limit`} className="faint" style={{ margin: 0 }}>
              {draft.length.toLocaleString()} /{" "}
              {snapshot.maxChars.toLocaleString()} 字符；UTF-8 文本最多{" "}
              {snapshot.maxBytes.toLocaleString()} 字节。
              {snapshot.updatedAt
                ? ` 最近保存：${fmtTime(snapshot.updatedAt)}`
                : " 尚未保存全局规则。"}
            </p>
            {snapshot.canManage && (
              <>
                <div className="actions" style={{ flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary"
                    disabled={busy || !dirty}
                    onClick={() => void save()}
                  >
                    {busy ? "处理中…" : "保存全局规则"}
                  </button>
                  {(dirty || preview) && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() => void reload(true)}
                    >
                      放弃修改并重新加载
                    </button>
                  )}
                  <span className="faint">
                    {dirty ? "有未保存的修改" : "内容与已保存版本一致"}
                  </span>
                </div>
                <div className="result-card">
                  <h3>导入全局规则</h3>
                  <p className="faint">
                    文件和链接先进入预览，追加或替换草稿后，再保存生效。
                  </p>
                  <label htmlFor={`${id}-file`}>选择全局规则文件</label>
                  <input
                    id={`${id}-file`}
                    className="input"
                    type="file"
                    accept=".md,.markdown,.txt,text/plain,text/markdown"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      void selectFile(file);
                    }}
                  />
                  <p className="faint">
                    支持 UTF-8 编码的 .md、.markdown、.txt 文件。
                  </p>
                  <label htmlFor={`${id}-url`}>全局规则 URL</label>
                  <input
                    id={`${id}-url`}
                    className="input"
                    type="url"
                    value={url}
                    disabled={busy}
                    placeholder="https://example.com/rules.md"
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <button
                    className="btn"
                    disabled={busy || !url.trim()}
                    onClick={() => void importUrl()}
                    style={{ marginTop: 8 }}
                  >
                    预览 URL 规则
                  </button>
                </div>
                {preview && (
                  <section className="result-card" aria-label="导入预览">
                    <h3>导入预览</h3>
                    <p className="faint" style={{ overflowWrap: "anywhere" }}>
                      {preview.source}
                    </p>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        overflowWrap: "anywhere",
                        maxHeight: 300,
                        overflow: "auto",
                      }}
                    >
                      {preview.content}
                    </pre>
                    <div className="actions" style={{ flexWrap: "wrap" }}>
                      <button
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => applyImport(false)}
                      >
                        追加到草稿
                      </button>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => applyImport(true)}
                      >
                        替换草稿
                      </button>
                      <button
                        className="btn"
                        disabled={busy}
                        onClick={() => setPreview(null)}
                      >
                        取消导入
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        ) : null}
        {error && (
          <div style={{ marginTop: 12 }}>
            {snapshot ? (
              <p className="wb-notice wb-notice-error" role="alert">
                {error}
              </p>
            ) : (
              <ErrorPanel error={error} onRetry={() => void reload()} />
            )}
          </div>
        )}
        {notice && (
          <p role="status" className="wb-notice" style={{ marginTop: 12 }}>
            {notice}
          </p>
        )}
      </section>
      {snapshot?.canManage && !forbidden && (
        <SettingsSection
          keys={["repo_rules_enabled"]}
          title="仓库规则全局默认"
          desc="此开关只控制仓库目录和外部链接规则；各仓库可以单独覆盖，关闭不影响上面的全局规则。"
        />
      )}
    </>
  );
}
