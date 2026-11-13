/**
 * 登录、账号资料、密码与用户角色。
 * 本文件保留原有请求路径与返回契约；认证和 GET 缓存由 http.ts 统一提供。
 * @example import { fetchOAuthStatus } from './api/account';
 */
import { authHeaders } from "../auth";
import { getJson } from "./http";

export type OAuthStatus = { oauthConfigured: boolean };

/** Whether GitHub OAuth login is wired up (unauthenticated endpoint). */
export async function fetchOAuthStatus(): Promise<OAuthStatus> {
  const response = await fetch("/auth/status", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) return { oauthConfigured: false };
  return (await response.json()) as OAuthStatus;
}

export type AccountInfo = {
  login: string | null;
  displayName: string | null;
  isAdmin: boolean;
  isReadOnly: boolean;
  hasPassword: boolean;
  needsBootstrap?: boolean;
  authMethod: "oauth" | "bearer" | "password";
};

/** Current account: the OAuth login, a password-login session, or a bearer token. */
export async function fetchMe(): Promise<AccountInfo> {
  return (await getJson("/auth/me")) as AccountInfo;
}

/** 本地密码登录（方向一）：返回会话 token 与用户信息。 */
export async function loginLocal(input: {
  username: string;
  password: string;
}): Promise<{ token: string; user: AccountInfo }> {
  const response = await fetch("/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    reason?: string;
    token?: string;
    user?: AccountInfo;
  };
  if (!response.ok || !data.token || !data.user) {
    const reason =
      data.reason === "invalid_credentials"
        ? "用户名或密码错误"
        : (data.reason ?? "登录失败");
    throw new Error(reason);
  }
  return { token: data.token, user: data.user };
}

/** 引导创建首个本地管理员（无本地 admin 时开放）。 */
export async function registerLocal(input: {
  username: string;
  password: string;
}): Promise<{ token: string; user: AccountInfo }> {
  const response = await fetch("/auth/register", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await response.json().catch(() => ({}))) as {
    status?: string;
    reason?: string;
    token?: string;
    user?: AccountInfo;
  };
  if (!response.ok || !data.token || !data.user)
    throw new Error(data.reason ?? "创建管理员失败");
  return { token: data.token, user: data.user };
}

/** 登出：吊销当前会话。 */
export async function logoutLocal(): Promise<void> {
  await fetch("/auth/logout", {
    method: "POST",
    credentials: "same-origin",
    headers: authHeaders(),
  });
}

/** 改密：本地账号。返回是否成功（旧密错误时抛错）。 */
export async function changePassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const response = await fetch("/auth/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as {
      reason?: string;
    };
    throw new Error(data.reason ?? "修改密码失败");
  }
}

/** Updates the display name of the OAuth user. */
export async function saveMe(displayName: string): Promise<AccountInfo> {
  const response = await fetch("/auth/me", {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ displayName }),
  });
  if (!response.ok) throw new Error(`save account ${response.status}`);
  return (await response.json()) as AccountInfo;
}

export type UserRow = {
  login: string;
  displayName: string;
  isAdmin: boolean;
  /** 只读操作员：可查看，禁止写操作。 */
  isReadOnly: boolean;
};

/** Lists known users (admin only). */
export async function fetchUsers(): Promise<UserRow[]> {
  const result = (await getJson("/users")) as { items: UserRow[] };
  return result.items;
}

/** 更新用户角色位（管理员 / 只读操作员）。 */
export async function setUserRoles(
  login: string,
  roles: { isAdmin?: boolean; isReadOnly?: boolean },
): Promise<UserRow> {
  const response = await fetch(`/users/${encodeURIComponent(login)}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(roles),
  });
  if (!response.ok) throw new Error(`set user roles ${response.status}`);
  return (await response.json()) as UserRow;
}
