/**
 * 审查工作台入口：选择仓库，进入对应主体；持久数据全部交给受认证的 HTTP API。
 * @example navigate('/workbench/findings?repository=owner%2Frepo');
 */
import { useEffect, useState } from "react";
import { ShieldIcon } from "../components/icons";
import { fetchRepositories } from "../lib/api";
import type { ConsolePage } from "../lib/navigation";
import { normalizeRepository } from "../lib/workbench";
import { WORKBENCH_TABS } from "../lib/workbench-tabs";
import { navigate, useHashRoute } from "../hooks/useHash";

export const consolePages: ConsolePage[] = [
  {
    path: "/workbench",
    label: "审查工作台",
    group: "analysis",
    order: 23,
    icon: ShieldIcon,
    render: () => <WorkbenchPage />,
  },
];
const REPOSITORY_KEY = "apertureprism.workbench.repository";
function savedRepository(): string {
  try {
    return localStorage.getItem(REPOSITORY_KEY) ?? "";
  } catch {
    return "";
  }
}

export function WorkbenchPage() {
  const route = useHashRoute();
  const [repository, setRepository] = useState(() => {
    const query = new URLSearchParams(route.split("?")[1] ?? "");
    return query.get("repository") ?? savedRepository();
  });
  const [draft, setDraft] = useState(repository);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tabId = (route.split("?")[0] ?? "").split("/")[2] ?? "summary";
  const selected =
    WORKBENCH_TABS.find((tab) => tab.id === tabId) ?? WORKBENCH_TABS[0];

  useEffect(() => {
    let active = true;
    fetchRepositories()
      .then((result) => {
        if (active) setSuggestions(result.items.map((item) => item.fullName));
      })
      .catch(() => {
        // 仓库列表可能暂时不可用；用户仍可显式输入已有授权仓库，不伪造选项。
      });
    return () => {
      active = false;
    };
  }, []);

  const chooseRepository = () => {
    try {
      const normalized = normalizeRepository(draft);
      setRepository(normalized);
      setDraft(normalized);
      setError(null);
      try {
        localStorage.setItem(REPOSITORY_KEY, normalized);
      } catch {
        /* 无存储权限时本次会话仍可使用。 */
      }
      navigate(
        `/workbench/${selected?.id ?? "summary"}?repository=${encodeURIComponent(normalized)}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "仓库名称无效");
    }
  };

  // 浏览器前进/后退可能带来另一个仓库，必须把正在看的范围一并切换。
  useEffect(() => {
    const value = new URLSearchParams(route.split("?")[1] ?? "").get(
      "repository",
    );
    if (!value) return;
    try {
      const normalized = normalizeRepository(value);
      setRepository(normalized);
      setDraft(normalized);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "仓库名称无效");
    }
  }, [route]);

  return (
    <div className="stack wb-page">
      <div className="page-head">
        <div>
          <h1 className="page-title">审查工作台</h1>
          <p className="page-desc">
            从规则、发现到质量门禁，在同一仓库范围内管理审查生命周期。
          </p>
        </div>
        <span className="chip">Repository workspace</span>
      </div>
      <section className="panel wb-scope" aria-label="工作台仓库范围">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            chooseRepository();
          }}
        >
          <label htmlFor="workbench-repository">当前仓库</label>
          <div className="wb-scope-input">
            <input
              id="workbench-repository"
              className="input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              list="workbench-repositories"
              placeholder="owner/repository"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
            <button type="submit" className="btn btn-primary">
              进入仓库
            </button>
          </div>
          <datalist id="workbench-repositories">
            {suggestions.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </form>
        <p className="wb-help">
          所有记录、导出和操作都限定在当前仓库；服务端逐次检查访问权限。
        </p>
        {error ? (
          <p className="wb-notice wb-notice-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>
      <nav className="wb-tabs" aria-label="审查工作台功能">
        {WORKBENCH_TABS.map((tab) => (
          <a
            key={tab.id}
            href={`#/workbench/${tab.id}${repository ? `?repository=${encodeURIComponent(repository)}` : ""}`}
            className={
              selected?.id === tab.id ? "wb-tab wb-tab-active" : "wb-tab"
            }
            aria-current={selected?.id === tab.id ? "page" : undefined}
          >
            {tab.label}
          </a>
        ))}
      </nav>
      {!repository ? (
        <div className="panel wb-welcome">
          <ShieldIcon size={34} />
          <h2>先选择需要管理的仓库</h2>
          <p>
            输入上方仓库名称，查看实际策略、发现、批次和预算。首次进入时可以从创建策略开始。
          </p>
        </div>
      ) : selected ? (
        <div key={`${repository}:${selected.id}`} className="wb-tab-content">
          <div className="wb-tab-heading">
            <h2>{selected.label}</h2>
            <p>{selected.description}</p>
          </div>
          {selected.render({ repository })}
        </div>
      ) : null}
    </div>
  );
}
