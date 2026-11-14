import { CpuIcon as PageIcon } from "../components/icons";
import type { ConsolePage } from "../lib/navigation";

/** 本页的位置与入口同处维护；导航由页面目录自动读取。 */
export const consolePages: ConsolePage[] = [
  {
    path: "/provider",
    label: "模型路由",
    group: "identity",
    order: 32,
    icon: PageIcon,
    render: () => <ProviderPage />,
  },
];

import { useCallback, useEffect, useId, useState } from "react";
import {
  bumpCache,
  deleteProvider,
  fetchModels,
  fetchProviders,
  saveProvider,
  type ProviderAccount,
  type ProviderOverview,
} from "../lib/api";
import {
  GearIcon,
  RefreshIcon,
  TrashIcon,
  PencilIcon,
} from "../components/icons";
import { ErrorPanel, LoadingRows } from "../components/ui";
import { explainUnknown } from "../lib/errors";
import { modelRoleLabel } from "../lib/labels";
import { SettingsSection } from "../components/SettingsSection";
import { useToast } from "../components/Toast";

// 固定长度的已保存状态标记，不是原密钥，也不能作为凭据提交。
const SAVED_API_KEY_MASK = "••••••••••••••••";

/** 与服务端一致地比较 Base URL（忽略空白与尾斜杠）。 */
const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

/**
 * 新增/编辑模型的表单。此前模型配置只能在安装向导里做一次，装完之后本页是纯只读，
 * 用户「点进模型路由却找不到配置的地方」（issue #2）。后端 /setup/provider 只要求
 * 管理员、不要求未初始化，因此这里直接复用它。支持编辑已有账户（issue #58）：
 * apiKey 留空时保留旧密钥。
 */
function AddProviderForm({
  onSaved,
  onCancel,
  initial,
}: {
  onSaved: () => void;
  onCancel?: () => void;
  initial?: ProviderAccount;
}) {
  const toast = useToast();
  const apiKeyId = useId();
  const [open, setOpen] = useState(!!initial);
  const [provider, setProvider] = useState(initial?.provider ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState("");
  const [accountName, setAccountName] = useState(initial?.name ?? "");
  const [models, setModels] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setProvider("");
    setBaseUrl("");
    setApiKey("");
    setReplacingKey(false);
    setShowApiKey(false);
    setModel("");
    setAccountName("");
    setModels([]);
    setOpen(false);
  };

  // 编辑模式下账号名不可改（provider+name 是唯一键，改了等于新建）。
  const editing = !!initial;
  const keepingSavedKey = editing && !replacingKey;
  // 已保存标记只用于展示；后端用空串保留原密文，绝不发送掩码。
  const submittedApiKey = keepingSavedKey ? "" : apiKey.trim();
  // 服务端只允许用已存密钥访问已保存的 Base URL（saved_provider_url_changed）。
  // 编辑时改了地址又沿用旧密钥，必须先保存或用新密钥验证，这里提前拦住。
  const savedUrlChanged =
    editing && normalizeBaseUrl(baseUrl) !== normalizeBaseUrl(initial?.baseUrl ?? "");
  const mustSaveBeforeProbe = savedUrlChanged && keepingSavedKey;

  // 拉取模型列表既是便利，也是对 baseUrl/apiKey 的一次连通性验证。
  const probeModels = async () => {
    if (!baseUrl.trim()) {
      toast.error("请先填写 Base URL");
      return;
    }
    if (mustSaveBeforeProbe) {
      toast.error("Base URL 已修改，请先保存，或输入新 API Key 后再获取模型");
      return;
    }
    if (!submittedApiKey && !keepingSavedKey) {
      toast.error(
        editing
          ? "请填写新 API Key，或点击「保留原密钥」后获取模型"
          : "请先填写 API Key",
      );
      return;
    }
    setProbing(true);
    try {
      const list =
        keepingSavedKey && initial
          ? await fetchModels(baseUrl.trim(), "", {
              provider: initial.provider,
              accountName: initial.name,
            })
          : await fetchModels(baseUrl.trim(), submittedApiKey);
      setModels(list);
      if (list.length === 0) toast.info("连接成功，但该地址未返回可用模型");
      else {
        toast.success(`已获取 ${list.length} 个模型`);
        setModel((current) => current || (list[0] ?? ""));
      }
    } catch (err) {
      toast.error(`获取模型列表失败：${explainUnknown(err)}`);
    } finally {
      setProbing(false);
    }
  };

  const submit = async () => {
    const payload = {
      provider: provider.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: submittedApiKey,
      model: model.trim() || (models[0] ?? ""),
      ...(accountName.trim() ? { accountName: accountName.trim() } : {}),
    };
    if (!payload.provider || !payload.baseUrl || !payload.model) {
      toast.error("Provider、Base URL 与模型均为必填");
      return;
    }
    if (!editing && !payload.apiKey) {
      toast.error("新增时 API Key 为必填");
      return;
    }
    setSaving(true);
    try {
      const result = await saveProvider(payload);
      toast.success(
        `已保存 ${result.provider}/${result.model}，已接入 ${result.policiesUpdated} 个角色策略`,
      );
      reset();
      bumpCache();
      onSaved();
    } catch (err) {
      toast.error(`保存失败：${explainUnknown(err)}`);
    } finally {
      setShowApiKey(false);
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        <GearIcon size={16} />
        添加模型
      </button>
    );
  }

  return (
    <section className="panel" aria-label={editing ? "编辑模型" : "添加模型"}>
      <div className="panel-title">
        <h2>{editing ? "编辑模型" : "添加模型"}</h2>
        <span className="count">
          {editing
            ? "更新 baseUrl/模型，默认保留原密钥"
            : "保存后自动接入全部分析角色"}
        </span>
      </div>
      <div className="stack" style={{ gap: 10 }}>
        <div className="filters">
          <input
            className="input"
            placeholder="Provider 标识，如 newapi"
            value={provider}
            disabled={editing || saving || probing}
            onChange={(e) => setProvider(e.target.value)}
          />
          <input
            className="input"
            style={{ flex: "1 1 260px" }}
            placeholder="Base URL，如 https://api.example.com/v1"
            value={baseUrl}
            disabled={saving || probing}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
        <div className="filters">
          {keepingSavedKey ? (
            <>
              <input
                className="input"
                style={{ flex: "1 1 260px" }}
                type="password"
                aria-label="API Key（已保存）"
                aria-describedby={`${apiKeyId}-hint`}
                value={SAVED_API_KEY_MASK}
                readOnly
                autoComplete="off"
                data-lpignore="true"
              />
              <button
                className="btn"
                disabled={saving || probing}
                onClick={() => setReplacingKey(true)}
              >
                替换密钥
              </button>
            </>
          ) : (
            <>
              <input
                id={apiKeyId}
                className="input"
                style={{ flex: "1 1 260px" }}
                type={showApiKey ? "text" : "password"}
                aria-label={editing ? "新 API Key" : "API Key"}
                aria-describedby={editing ? `${apiKeyId}-hint` : undefined}
                placeholder={
                  editing ? "新 API Key（留空保留原密钥）" : "API Key"
                }
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (!e.target.value) setShowApiKey(false);
                }}
                disabled={saving || probing}
                autoComplete="new-password"
                data-lpignore="true"
              />
              <button
                className="btn"
                aria-controls={apiKeyId}
                aria-pressed={showApiKey}
                disabled={!apiKey || saving || probing}
                onClick={() => setShowApiKey((shown) => !shown)}
              >
                {showApiKey ? "隐藏新密钥" : "显示新密钥"}
              </button>
              {editing ? (
                <button
                  className="btn"
                  disabled={saving || probing}
                  onClick={() => {
                    setApiKey("");
                    setShowApiKey(false);
                    setReplacingKey(false);
                  }}
                >
                  保留原密钥
                </button>
              ) : null}
            </>
          )}
          <button
            className="btn"
            onClick={probeModels}
            disabled={probing || saving || mustSaveBeforeProbe}
            title={
              mustSaveBeforeProbe
                ? "Base URL 已修改，请先保存，或输入新 API Key 后获取"
                : undefined
            }
          >
            {probing ? "获取中…" : "获取模型列表"}
          </button>
        </div>
        {editing ? (
          <p
            id={`${apiKeyId}-hint`}
            className="faint"
            style={{ margin: 0, fontSize: 12 }}
          >
            {keepingSavedKey
              ? mustSaveBeforeProbe
                ? "Base URL 已修改：请先点「保存修改」，或输入新 API Key 后再获取模型列表。"
                : "已保存 API Key，将保留原密钥。可直接获取模型列表；原密钥不会回传，仅由服务端使用；如需更换请点「替换密钥」。"
              : "仅显示本次输入的新密钥；留空或点「保留原密钥」不会修改已保存的密钥。"}
          </p>
        ) : null}
        <div className="filters">
          {models.length > 0 ? (
            <select
              className="input"
              style={{ flex: "1 1 260px" }}
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="input"
              style={{ flex: "1 1 260px" }}
              placeholder="模型名，如 gpt-4o-mini（也可先获取列表）"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          )}
          <input
            className="input"
            placeholder="账户名（可留空，默认 <provider>-main）"
            value={accountName}
            disabled={editing}
            onChange={(e) => setAccountName(e.target.value)}
          />
        </div>
        <div className="filters">
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={saving || probing}
          >
            {saving ? "保存中…" : editing ? "保存修改" : "保存并接入"}
          </button>
          <button
            className="btn"
            onClick={() => {
              reset();
              onCancel?.();
            }}
            disabled={saving || probing}
          >
            取消
          </button>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          API Key 加密保存，仅由服务端连接供应商使用，不会回传浏览器。同一
          Provider
          与账户名重复保存会覆盖旧密钥。新模型会被放在各角色候选的首位，原有
          候选保留为故障转移备选。
        </p>
      </div>
    </section>
  );
}

export function ProviderPage() {
  const [data, setData] = useState<ProviderOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ProviderAccount | null>(null);
  const toast = useToast();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchProviders()
      .then(setData)
      .catch((err: unknown) => {
        setError(explainUnknown(err));
        setData(null);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-title">模型路由</h1>
          <p className="page-desc">各分析角色的模型候选策略与已配置账户</p>
        </div>
        <div className="actions">
          <AddProviderForm onSaved={load} />
          <button
            className="btn"
            onClick={() => {
              bumpCache();
              load();
            }}
            disabled={loading}
          >
            <RefreshIcon size={16} />
            刷新
          </button>
        </div>
      </div>

      <section className="panel">
        <div className="panel-title">
          <h2>模型策略</h2>
          <span className="count">{data?.policies.length ?? "–"} roles</span>
        </div>

        {error ? (
          <ErrorPanel error={error} onRetry={load} />
        ) : loading ? (
          <LoadingRows />
        ) : !data ? (
          <p className="state state-empty">暂无数据</p>
        ) : data.policies.length === 0 ? (
          <p className="state state-empty">
            尚未配置模型策略。点击右上角「添加模型」填写 Provider 与 API Key
            即可接入。
          </p>
        ) : (
          <div className="tablewrap">
            <table className="table">
              <thead>
                <tr>
                  <th>角色</th>
                  <th>版本</th>
                  <th>候选模型</th>
                </tr>
              </thead>
              <tbody>
                {data.policies.map((policy) => (
                  <tr key={policy.role}>
                    <td>
                      <span className="chip">
                        {modelRoleLabel(policy.role)}
                      </span>
                    </td>
                    <td>
                      <span className="chip mono">{policy.version}</span>
                    </td>
                    <td>
                      <span className="tag-row">
                        {policy.candidates.map((c, i) => (
                          <span key={i} className="tag">
                            {c.provider}/{c.model} @ {c.accountName}
                          </span>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <h2>Provider 账户</h2>
          <span className="count">{data?.accounts.length ?? "–"}</span>
        </div>
        {data && data.accounts.length > 0 ? (
          <div className="tag-row" style={{ flexWrap: "wrap", gap: 8 }}>
            {data.accounts.map((account) => (
              <span key={`${account.provider}:${account.name}`} className="tag">
                {account.provider}/{account.name}
                <button
                  className="iconbtn"
                  title="编辑"
                  aria-label={`编辑 ${account.provider}/${account.name}`}
                  onClick={() => setEditing(account)}
                >
                  <PencilIcon size={14} />
                </button>
                <button
                  className="iconbtn danger"
                  title="删除"
                  aria-label={`删除 ${account.provider}/${account.name}`}
                  onClick={async () => {
                    if (
                      !window.confirm(
                        `确定要删除账户 ${account.provider}/${account.name} 吗？该账户将从全部角色策略候选与凭据库中移除。`,
                      )
                    )
                      return;
                    try {
                      await deleteProvider({
                        provider: account.provider,
                        accountName: account.name,
                      });
                      bumpCache();
                      load();
                    } catch (err) {
                      toast.error(`删除失败：${explainUnknown(err)}`);
                    }
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="state state-empty">无账户</p>
        )}
        <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
          凭据已加密保存，仅在服务端使用，不会回传浏览器。
        </p>
      </section>

      {editing ? (
        <AddProviderForm
          key={`edit:${editing.provider}:${editing.name}`}
          initial={editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}

      <SettingsSection
        keys={["embedding_base_url", "embedding_api_key", "embedding_model"]}
        title="Embedding（向量索引）"
        desc="重复检测与相似 issue 召回所用的嵌入服务；留空则用环境变量"
      />
    </div>
  );
}
