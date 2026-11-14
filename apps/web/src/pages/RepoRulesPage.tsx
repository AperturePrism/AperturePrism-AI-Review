import { ShieldIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [{ path: "/repo-rules", label: "审核规则", group: "data", order: 43, icon: PageIcon, render: () => <RepoRulesPage /> }];

import { useCallback, useEffect, useRef, useState } from "react";
import {
  bumpCache,
  deleteRepoRulesFile,
  fetchRepoRulesDetail,
  fetchRepoRulesFile,
  fetchRepoRulesList,
  importRepoRulesFromUrl,
  saveRepoRulesFile,
  saveRepositorySetting,
  type RepoRulesItem,
  type RepoRulesDetail,
} from "../lib/api";
import { useToast } from "../components/Toast";
import {
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  LinkIcon,
  ShieldIcon,
  UploadIcon,
  XCircleIcon,
} from "../components/icons";
import { Empty, ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { GlobalRulesEditor } from "../components/GlobalRulesEditor";
import { SettingsSection } from "../components/SettingsSection";

/**
 * 仓库审核规则功能页：集中查看每个仓库的 .apertureprism/rules/ 状态，切换开关，
 * 在线增删改查规则文件，支持本地上传与从 URL 拉取导入。
 */
export function RepoRulesPage() {
  const toast = useToast();
  const [items, setItems] = useState<RepoRulesItem[]>([]);
  const [githubConfigured, setGithubConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRepoRulesList()
      .then((result) => {
        setItems(result.items);
        setGithubConfigured(result.githubConfigured ?? true);
      })
      .catch((err: unknown) => setError(explainUnknown(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const toggleEnabled = async (item: RepoRulesItem, next: boolean) => {
    setBusyKey(`sw-${item.id}`);
    try {
      await saveRepositorySetting(item.id, "repo_rules_enabled", next ? "true" : "false");
      bumpCache();
      toast.success(next ? "已开启该仓库审核规则" : "已关闭该仓库审核规则");
      const fresh = await fetchRepoRulesList();
      setItems(fresh.items);
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">审核规则</h1>
          <p className="page-desc">
            集中管理全局审核规则、文件与链接导入，以及各仓库的规则文件。
          </p>
        </div>
        <button className="btn" disabled={loading} onClick={load}>
          <ArrowPathIcon size={14} /> 刷新仓库列表
        </button>
      </div>

      <GlobalRulesEditor />

      <SettingsSection
        keys={["repo_rules_enabled"]}
        title="仓库规则全局默认"
        desc="此开关只控制仓库目录和外部链接规则；各仓库可以单独覆盖，关闭不影响上面的全局规则。"
      />

      <section className="panel">
        <h2>仓库审核规则</h2>
        <p className="faint">各仓库的 <code>.apertureprism/rules/</code> 目录与规则开关；会与上面的全局规则共同应用。</p>
      </section>

      {error ? (
        <ErrorPanel error={error} onRetry={load} />
      ) : loading ? (
        <LoadingRows />
      ) : items.length === 0 ? (
        <Empty
          icon={<ShieldIcon size={32} />}
          title={githubConfigured ? "还没有已安装的仓库" : "GitHub App 尚未配置"}
          hint={
            githubConfigured
              ? "在「已安装仓库」页同步仓库后，即可在此管理各仓库的审核规则"
              : "先在「GitHub 接入」页配置 GitHub App，才能管理仓库内的规则文件；全局规则不依赖 GitHub"
          }
        />
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          {items.map((item) => (
            <RepoRulesCard
              key={item.id}
              item={item}
              busy={busyKey === `sw-${item.id}`}
              onToggle={(next) => toggleEnabled(item, next)}
              onChanged={() => {
                bumpCache();
                load();
              }}
              toast={toast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

type Toast = ReturnType<typeof useToast>;

function RepoRulesCard({
  item,
  busy,
  onToggle,
  onChanged,
  toast,
}: {
  item: RepoRulesItem;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onChanged: () => void;
  toast: Toast;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<RepoRulesDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 编辑器状态
  const [editing, setEditing] = useState<{ path: string; content: string; sha?: string } | null>(null);
  const [newPath, setNewPath] = useState("");
  const [busyEdit, setBusyEdit] = useState(false);
  // 从 URL 拉取
  const [importOpen, setImportOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [importPath, setImportPath] = useState("");
  const [busyImport, setBusyImport] = useState(false);
  // 上传本地文件
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadDetail = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchRepoRulesDetail(item.id)
      .then((data) => setDetail(data))
      .catch((err: unknown) => setError(explainUnknown(err)))
      .finally(() => setLoading(false));
  }, [item.id]);

  useEffect(() => {
    if (open && detail === null && !loading && !error) loadDetail();
  }, [open, detail, loading, error, loadDetail]);

  const openEditor = async (path: string) => {
    setBusyEdit(true);
    try {
      const file = await fetchRepoRulesFile(item.id, path);
      setEditing({ path: file.path, content: file.content });
      setNewPath("");
    } catch (err) {
      toast.error(`读取失败：${explainUnknown(err)}`);
    } finally {
      setBusyEdit(false);
    }
  };

  const saveEditor = async () => {
    if (!editing) return;
    setBusyEdit(true);
    try {
      await saveRepoRulesFile(item.id, editing.path, editing.content, editing.sha);
      toast.success("已保存规则文件");
      setEditing(null);
      onChanged();
      loadDetail();
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setBusyEdit(false);
    }
  };

  const createNew = async () => {
    const path = newPath.trim();
    if (!path) {
      toast.error("请填写规则文件名（如 hard-rules.md）");
      return;
    }
    setBusyEdit(true);
    try {
      await saveRepoRulesFile(item.id, path, "# 审核规则\n\n在这里编写你的仓库规则…\n");
      toast.success("已创建规则文件");
      setNewPath("");
      onChanged();
      loadDetail();
    } catch (err) {
      toast.error(`创建失败：${explainUnknown(err)}`);
    } finally {
      setBusyEdit(false);
    }
  };

  const remove = async (path: string) => {
    if (!window.confirm(`确认删除规则文件 ${path} 吗？`)) return;
    setBusyEdit(true);
    try {
      await deleteRepoRulesFile(item.id, path);
      toast.success("已删除规则文件");
      onChanged();
      loadDetail();
    } catch (err) {
      toast.error(`删除失败：${explainUnknown(err)}`);
    } finally {
      setBusyEdit(false);
    }
  };

  const doImport = async () => {
    const url = importUrl.trim();
    const path = importPath.trim();
    if (!url || !path) {
      toast.error("请填写 URL 与目标文件名");
      return;
    }
    setBusyImport(true);
    try {
      await importRepoRulesFromUrl(item.id, url, path);
      toast.success("已从 URL 导入规则文件");
      setImportOpen(false);
      setImportUrl("");
      setImportPath("");
      onChanged();
      loadDetail();
    } catch (err) {
      toast.error(`导入失败：${explainUnknown(err)}`);
    } finally {
      setBusyImport(false);
    }
  };

  const onUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result ?? "");
      const baseName = file.name.endsWith(".md") ? file.name : `${file.name}.md`;
      const path = `${baseName}`;
      setEditing({ path, content });
      setNewPath("");
    };
    reader.readAsText(file);
  };

  const files = detail?.files ?? item.files ?? [];

  return (
    <div className="panel">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          className="btn btn-ghost"
          style={{ padding: "2px 6px" }}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
        </button>
        <strong>{item.fullName}</strong>
        {item.hasRulesDir ? (
          <span className="tag" style={{ fontSize: 11 }}>有规则目录</span>
        ) : (
          <span className="tag" style={{ fontSize: 11, opacity: 0.6 }}>无规则目录</span>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          {files.length} 个规则文件
        </span>
        <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={item.enabled}
            disabled={busy}
            onChange={(e) => onToggle(e.target.checked)}
          />
          注入规则
        </label>
      </div>

      {open ? (
        <div style={{ marginTop: 12 }}>
          {error ? <ErrorPanel error={error} onRetry={loadDetail} /> : null}
          {loading ? <LoadingRows /> : null}
          {!loading && detail !== null ? (
            <>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
                <input
                  className="input"
                  placeholder="新规则文件名，如 hard-rules.md"
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  style={{ flex: 1, minWidth: 200 }}
                />
                <button className="btn" disabled={busyEdit} onClick={createNew}>
                  ＋ 新建
                </button>
                <button className="btn" onClick={() => fileInputRef.current?.click()}>
                  <UploadIcon size={14} /> 上传文件
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".md,.markdown,.txt"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUpload(f);
                    e.target.value = "";
                  }}
                />
                <button className="btn" onClick={() => setImportOpen((v) => !v)}>
                  <LinkIcon size={14} /> 从 URL 导入
                </button>
              </div>

              {importOpen ? (
                <div className="stack" style={{ gap: 8, padding: "0 0 10px" }}>
                  <input
                    className="input"
                    placeholder="规则文件 URL（如 https://…/rules.md）"
                    value={importUrl}
                    onChange={(e) => setImportUrl(e.target.value)}
                  />
                  <input
                    className="input"
                    placeholder="目标文件名（如 imported-rules.md）"
                    value={importPath}
                    onChange={(e) => setImportPath(e.target.value)}
                  />
                  <button className="btn btn-primary" disabled={busyImport} onClick={doImport}>
                    {busyImport ? "导入中…" : "拉取并写入"}
                  </button>
                </div>
              ) : null}

              {editing ? (
                <div className="stack" style={{ gap: 8, marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <strong style={{ fontSize: 13 }}>{editing.path}</strong>
                    <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => setEditing(null)}>
                      <XCircleIcon size={14} /> 取消
                    </button>
                  </div>
                  <textarea
                    className="input mono"
                    rows={10}
                    value={editing.content}
                    onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                    style={{ fontFamily: "monospace", width: "100%" }}
                  />
                  <button className="btn btn-primary" disabled={busyEdit} onClick={saveEditor}>
                    {busyEdit ? "保存中…" : "保存"}
                  </button>
                </div>
              ) : null}

              {files.length === 0 ? (
                <p className="faint" style={{ fontSize: 13 }}>该仓库还没有规则文件，可新建、上传或从 URL 导入。</p>
              ) : (
                <ul className="stack" style={{ gap: 6 }}>
                  {files.map((f) => (
                    <li key={f.path} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 13, flex: 1 }}>{f.path}</span>
                      <button className="btn" style={{ fontSize: 12 }} onClick={() => openEditor(f.path)}>
                        编辑
                      </button>
                      <button
                        className="btn"
                        style={{ fontSize: 12, color: "var(--danger, #c0392b)" }}
                        disabled={busyEdit}
                        onClick={() => remove(f.path)}
                      >
                        删除
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
