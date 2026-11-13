import { useEffect, useMemo, useRef, useState } from "react";
import { useSse } from "./hooks/useSse";
import { navigate, tabOf, useHashRoute } from "./hooks/useHash";
import { useTheme } from "./hooks/useTheme";
import { useToast } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { eventsUrl, getToken, onUnauthorized, setToken } from "./lib/auth";
import { fetchSetupStatus } from "./lib/api";
import { Login } from "./pages/Login";
import { SetupPage } from "./pages/SetupPage";
import { NAV, renderConsolePage, routeGroupTitle } from "./lib/navigation";
export { NAV, routeGroupTitle } from "./lib/navigation";
export type { NavGroup } from "./lib/navigation";
import { LogoutIcon, MenuIcon, MoonIcon, SunIcon, UserCircleIcon } from "./components/icons";

const STATUS_TEXT: Record<string, string> = {
  connecting: "连接中",
  online: "实时连接",
  offline: "已断开",
};

export function App() {
  const [token, setTokenState] = useState<string>(() => getToken());
  const route = useHashRoute();
  const toast = useToast();
  const showSetup = route === "/setup";
  // Install state: `null` = still probing; `false` = not initialized (wizard
  // is public); `true` = already installed (wizard requires auth / is hidden).
  const [setupInstalled, setSetupInstalled] = useState<boolean | null>(null);

  // On the setup route, decide whether the wizard may be shown without auth.
  // A fresh install keeps it public; once initialized it must be gated behind
  // the WebUI token so the wizard is hidden by default.
  useEffect(() => {
    if (!showSetup) return;
    fetchSetupStatus()
      .then((s) => setSetupInstalled(s.initialized))
      .catch(() => setSetupInstalled(true)); // unknown → treat as installed
  }, [showSetup]);

  // Consume the OAuth callback result carried in the hash (#/?token=… | oauth_error).
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === "/setup") return;
    const queryIdx = hash.indexOf("?");
    if (queryIdx === -1) return;
    const params = new URLSearchParams(hash.slice(queryIdx + 1));
    const oauthToken = params.get("token");
    if (oauthToken) {
      setToken(oauthToken);
      setTokenState(oauthToken);
      window.history.replaceState(null, "", "#/");
    } else if (params.get("oauth_error")) {
      toast.error(`GitHub 登录失败：${params.get("oauth_error")}`);
      window.history.replaceState(null, "", "#/");
    }
  }, [toast]);

  // 令牌失效（任一 API 401）→ 清空会话回到登录页：真正的密码门禁。
  useEffect(() => {
    onUnauthorized(() => {
      setToken("");
      setTokenState("");
      navigate("/");
    });
  }, [navigate]);

  const loginGate = (
    <Login
      onAuthenticated={(value) => {
        setToken(value);
        setTokenState(value);
      }}
    />
  );

  if (showSetup) {
    if (setupInstalled === null) return null; // probing install state
    // Already installed → the wizard is hidden by default and gated behind
    // the WebUI token; unauthenticated visitors land on the login screen.
    if (setupInstalled && !token) return loginGate;
    return <SetupPage />;
  }

  if (!token) return loginGate;

  return (
    <AuthedConsole
      onLogout={() => {
        setToken("");
        setTokenState("");
        navigate("/");
      }}
    />
  );
}

function AuthedConsole(props: { onLogout: () => void }) {
  const route = useHashRoute();
  const active = tabOf(route);
  const sse = useSse(eventsUrl());
  const { theme, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  // Route change always collapses the mobile drawer.
  useEffect(() => setDrawerOpen(false), [route]);

  // 打开抽屉时锁定背景滚动，关闭时恢复；同时把抽屉内容滚回顶部，
  // 避免抽屉停留在上次滚动位置造成“上滑/错位”的观感。
  useEffect(() => {
    if (!drawerOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    navRef.current?.scrollTo({ top: 0 });
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen]);

  const closeDrawer = () => setDrawerOpen(false);

  const pageTitle = useMemo(() => {
    if (route.startsWith("/tasks/") && route.length > "/tasks/".length) {
      return { eyebrow: "审查队列", title: `任务 #${route.slice("/tasks/".length).slice(0, 8)}` };
    }
    const match = NAV.flatMap((g) => g.items).find((i) => i.path === active);
    if (match) return { eyebrow: routeGroupTitle(active) ?? "工作台", title: match.label };
    return { eyebrow: "工作台", title: "关于" };
  }, [route, active]);

  let page = renderConsolePage(active || "/", { route, sse });

  // ErrorBoundary 按路由 key 重置：切页自动清除上一次的错误态，页面组件抛错
  // 时只替换内容区，侧栏 / 登录态保持可用。
  page = <ErrorBoundary key={active}>{page}</ErrorBoundary>;

  return (
    <div className="shell">
      <aside className={drawerOpen ? "sidebar drawer-open" : "sidebar"}>
        <div>
          <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); navigate("/"); }}>
            <img src="/aprism-logo.png" alt="AperturePrism" className="brand-logo" />
            <span>AperturePrism</span>
          </a>
          <div className="brand-sub">AI Code Review</div>
        </div>

        <nav className="nav" ref={navRef}>
          {NAV.map((group, gi) => (
            <div key={gi} className="nav-group">
              {group.title ? <div className="nav-title">{group.title}</div> : null}
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = active === item.path;
                return (
                  <a
                    key={item.path}
                    href={`#${item.path}`}
                    className={isActive ? "nav-item nav-item-active" : "nav-item"}
                    aria-current={isActive ? "page" : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      navigate(item.path);
                      closeDrawer();
                    }}
                  >
                    <Icon size={16} />
                    {item.label}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="side-foot">
          <a
            className="account-entry"
            href="#/account"
            aria-current={active === "/account" ? "page" : undefined}
            onClick={(event) => {
              event.preventDefault();
              navigate("/account");
              closeDrawer();
            }}
          >
            <UserCircleIcon size={18} />
            <span>个人设置</span>
          </a>
          <button className="btn btn-ghost" onClick={props.onLogout}>
            <LogoutIcon size={16} />
            退出登录
          </button>
        </div>
      </aside>

      {drawerOpen ? (
        <div className="nav-backdrop" onClick={closeDrawer} aria-hidden="true" />
      ) : null}

      <main className="main" id="main">
        <div className="topbar">
          <button
            type="button"
            className="nav-burger"
            onClick={() => setDrawerOpen(true)}
            aria-label="打开菜单"
            aria-expanded={drawerOpen}
          >
            <MenuIcon size={18} />
          </button>
          <div className="topbar-meta">
            <span className="topbar-eyebrow">{pageTitle.eyebrow}</span>
            <span className="topbar-dot" aria-hidden="true" />
            <span className="topbar-title">{pageTitle.title}</span>
          </div>
          <div className="topbar-actions">
            <span className={`status-badge status-${sse.status} status-pill-compact`}>
              <span className="dot-pulse" />
              {STATUS_TEXT[sse.status]}
            </span>
            <button
              className="theme-toggle"
              onClick={toggle}
              aria-label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
              title={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            >
              {theme === "dark" ? <SunIcon size={13} /> : <MoonIcon size={13} />}
              {theme === "dark" ? "浅色" : "深色"}
            </button>
          </div>
        </div>
        {page}
      </main>
    </div>
  );
}
