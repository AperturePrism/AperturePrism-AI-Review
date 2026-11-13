/**
 * 审核规则：读取与维护仓库内的规则文件。
 * 调用示例：handleRepoRulesRequest(request, response, requestId)。
 * HTTP 路径保持兼容；跨文件依赖在下方显式列出。
 */
import { parseJsonObject } from "../utils/http.js";
import type { HttpRoute } from "../utils/routes.js";
import {
  repositories,
  getRepositorySettingsFor,
  loadSettings,
} from "../../../../packages/database/src/index.js";
import { REPO_RULES_DIR } from "../../../../packages/github-adapter/src/index.js";
import { githubClientPromise } from "../github.js";
import { visibleRepoScope, isAdminRequest } from "../identity.js";
import { database } from "../runtime.js";
import { json, UUID_PATTERN, readBody } from "../utils/http.js";
import { inArray, asc, eq } from "drizzle-orm";
import { type IncomingMessage, type ServerResponse } from "node:http";

/**
 * 仓库审核规则功能页（WebUI 独立「审核规则」菜单）：
 *
 *   GET    /repo-rules                          → 所有仓库 + 规则状态摘要
 *   GET    /repo-rules/:id                      → 单仓库规则文件列表 + 开关状态
 *   GET    /repo-rules/:id/file?path=…          → 读取单个规则文件内容
 *   PUT    /repo-rules/:id/file                 → 创建 / 更新规则文件（body: path/content/sha?）
 *   DELETE /repo-rules/:id/file?path=…          → 删除规则文件
 *   POST   /repo-rules/:id/from-url             → 从 URL 拉取内容写入规则文件（body: url/path）
 *
 * 所有写操作都是 best-effort：GitHub 侧失败（无写权限 / sha 冲突）返回 400 带原因，
 * 不抛 500。读取失败（仓库无 rules 目录等）降级为空列表。
 */
export async function handleRepoRulesRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://local");
  const path = url.pathname;
  const github = await githubClientPromise;

  // GET /repo-rules —— 所有仓库 + 规则状态。
  if (path === "/repo-rules" && request.method === "GET") {
    // 方向七：非 admin 仅能看到被授权仓库的规则状态。
    const scope = await visibleRepoScope(request);
    const repos = await database.db
      .select({
        id: repositories.id,
        owner: repositories.owner,
        name: repositories.name,
        installationId: repositories.installationId,
      })
      .from(repositories)
      .where(
        scope && scope.ids !== null
          ? inArray(repositories.id, [...scope.ids])
          : undefined,
      )
      .orderBy(asc(repositories.name));
    const items = await Promise.all(
      repos.map(async (repo) => {
        const enabled = await repoRulesEnabledFlag(repo.id);
        let hasRulesDir = false;
        let files: { name: string; path: string }[] = [];
        if (github && repo.installationId) {
          try {
            const entries = await github.listDirectory({
              installationId: repo.installationId,
              owner: repo.owner,
              name: repo.name,
              path: REPO_RULES_DIR,
              ref: "HEAD",
            });
            hasRulesDir = entries.length > 0;
            files = entries
              .filter((e) => e.type === "file" && e.name.endsWith(".md"))
              .map((e) => ({ name: e.name, path: e.path }));
          } catch {
            // 目录不存在或读取失败 → 视为没有规则目录。
          }
        }
        return {
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          fullName: `${repo.owner}/${repo.name}`,
          enabled,
          hasRulesDir,
          files,
        };
      }),
    );
    json(
      response,
      200,
      { githubConfigured: github !== null, items },
      requestId,
    );
    return;
  }

  // /repo-rules/:id/... —— 单仓库操作。
  if (path.startsWith("/repo-rules/")) {
    const rest = path.slice("/repo-rules/".length);
    const seg = rest.split("/");
    const repositoryId = decodeURIComponent(seg[0] ?? "").trim();
    const action = seg[1] ?? "";
    if (!repositoryId || !UUID_PATTERN.test(repositoryId)) {
      json(
        response,
        400,
        { status: "error", reason: "invalid repository id" },
        requestId,
      );
      return;
    }
    const repoRows = await database.db
      .select({
        id: repositories.id,
        owner: repositories.owner,
        name: repositories.name,
        installationId: repositories.installationId,
      })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .limit(1);
    const repo = repoRows[0];
    if (!repo) {
      json(
        response,
        404,
        { status: "error", reason: "repository_not_found" },
        requestId,
      );
      return;
    }
    if (!github || !repo.installationId) {
      json(
        response,
        400,
        { status: "error", reason: "github_not_configured" },
        requestId,
      );
      return;
    }
    const ghInput = {
      installationId: repo.installationId,
      owner: repo.owner,
      name: repo.name,
    };
    const repoInfo = {
      id: repo.id,
      owner: repo.owner,
      name: repo.name,
      fullName: `${repo.owner}/${repo.name}`,
    };

    // 获取默认分支。
    const defaultBranch = async (): Promise<string> => {
      try {
        const meta = await github.getRepository(ghInput);
        return meta?.defaultBranch ?? "main";
      } catch {
        return "main";
      }
    };

    // GET /repo-rules/:id —— 文件列表 + 开关。
    if (action === "" && request.method === "GET") {
      const enabled = await repoRulesEnabledFlag(repositoryId);
      const ref = await defaultBranch();
      let files: { name: string; path: string }[] = [];
      try {
        const entries = await github.listDirectory({
          ...ghInput,
          path: REPO_RULES_DIR,
          ref,
        });
        files = entries
          .filter(
            (e) => e.type === "file" && e.name.toLowerCase().endsWith(".md"),
          )
          .map((e) => ({ name: e.name, path: e.path }));
      } catch {
        // 目录不存在 → 空列表。
      }
      json(response, 200, { ...repoInfo, enabled, ref, files }, requestId);
      return;
    }

    // GET /repo-rules/:id/file?path=…
    if (action === "file" && request.method === "GET") {
      const filePath = decodeURIComponent(
        url.searchParams.get("path") ?? "",
      ).trim();
      if (!filePath) {
        json(
          response,
          400,
          { status: "error", reason: "path required" },
          requestId,
        );
        return;
      }
      const ref = await defaultBranch();
      const file = await github.getFileContents({
        ...ghInput,
        path: filePath,
        ref,
      });
      if (!file) {
        json(
          response,
          404,
          { status: "error", reason: "file_not_found" },
          requestId,
        );
        return;
      }
      json(response, 200, { path: filePath, content: file.content }, requestId);
      return;
    }

    // PUT /repo-rules/:id/file —— 创建 / 更新。
    if (action === "file" && request.method === "PUT") {
      if (!(await isAdminRequest(request))) {
        json(
          response,
          403,
          { status: "error", reason: "admin required" },
          requestId,
        );
        return;
      }
      const raw = await readBody(request);
      let parsed: { path?: unknown; content?: unknown; sha?: unknown };
      try {
        parsed = parseJsonObject(raw);
      } catch {
        json(
          response,
          400,
          { status: "error", reason: "invalid json" },
          requestId,
        );
        return;
      }
      const filePath = String(parsed.path ?? "").trim();
      const content = String(parsed.content ?? "");
      const sha =
        typeof parsed.sha === "string" && parsed.sha ? parsed.sha : undefined;
      if (!filePath) {
        json(
          response,
          400,
          { status: "error", reason: "path required" },
          requestId,
        );
        return;
      }
      const ref = await defaultBranch();
      const ok = await github.writeFileContents({
        ...ghInput,
        path: filePath,
        ref,
        content,
        ...(sha ? { sha } : {}),
      });
      if (!ok) {
        json(
          response,
          400,
          {
            status: "error",
            reason: "write_failed",
            detail: "文件已存在（更新需带 sha）或内容未变化",
          },
          requestId,
        );
        return;
      }
      json(response, 200, { status: "ok", path: filePath }, requestId);
      return;
    }

    // DELETE /repo-rules/:id/file?path=…
    if (action === "file" && request.method === "DELETE") {
      if (!(await isAdminRequest(request))) {
        json(
          response,
          403,
          { status: "error", reason: "admin required" },
          requestId,
        );
        return;
      }
      const filePath = decodeURIComponent(
        url.searchParams.get("path") ?? "",
      ).trim();
      if (!filePath) {
        json(
          response,
          400,
          { status: "error", reason: "path required" },
          requestId,
        );
        return;
      }
      const ref = await defaultBranch();
      // 需要当前 blob sha：先读文件。
      const file = await github.getFileContents({
        ...ghInput,
        path: filePath,
        ref,
      });
      if (!file || !file.sha) {
        json(
          response,
          404,
          { status: "error", reason: "file_not_found" },
          requestId,
        );
        return;
      }
      const ok = await github.deleteFileContents({
        ...ghInput,
        path: filePath,
        ref,
        sha: file.sha,
      });
      if (!ok) {
        json(
          response,
          400,
          { status: "error", reason: "delete_failed" },
          requestId,
        );
        return;
      }
      json(response, 200, { status: "ok", path: filePath }, requestId);
      return;
    }

    // POST /repo-rules/:id/from-url —— 从 URL 拉取内容写入。
    if (action === "from-url" && request.method === "POST") {
      if (!(await isAdminRequest(request))) {
        json(
          response,
          403,
          { status: "error", reason: "admin required" },
          requestId,
        );
        return;
      }
      const raw = await readBody(request);
      let parsed: { url?: unknown; path?: unknown };
      try {
        parsed = parseJsonObject(raw);
      } catch {
        json(
          response,
          400,
          { status: "error", reason: "invalid json" },
          requestId,
        );
        return;
      }
      const remoteUrl = String(parsed.url ?? "").trim();
      const filePath = String(parsed.path ?? "").trim();
      if (!remoteUrl || !filePath) {
        json(
          response,
          400,
          { status: "error", reason: "url and path required" },
          requestId,
        );
        return;
      }
      let remoteText: string;
      try {
        const res = await fetch(remoteUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          json(
            response,
            400,
            {
              status: "error",
              reason: "fetch_failed",
              detail: `URL 返回 ${res.status}`,
            },
            requestId,
          );
          return;
        }
        remoteText = await res.text();
      } catch (error) {
        json(
          response,
          400,
          {
            status: "error",
            reason: "fetch_failed",
            detail: error instanceof Error ? error.message : "URL 拉取失败",
          },
          requestId,
        );
        return;
      }
      const ref = await defaultBranch();
      const existing = await github.getFileContents({
        ...ghInput,
        path: filePath,
        ref,
      });
      const ok = await github.writeFileContents({
        ...ghInput,
        path: filePath,
        ref,
        content: remoteText,
        ...(existing?.sha ? { sha: existing.sha } : {}),
      });
      if (!ok) {
        json(
          response,
          400,
          { status: "error", reason: "write_failed" },
          requestId,
        );
        return;
      }
      json(response, 200, { status: "ok", path: filePath }, requestId);
      return;
    }

    json(
      response,
      405,
      { status: "error", reason: "method not allowed" },
      requestId,
    );
    return;
  }

  json(response, 404, { status: "error", reason: "not found" }, requestId);
}

/** 读取某仓库的 repo_rules_enabled 生效值（仓库覆盖 → 全局 → 默认 true）。 */
async function repoRulesEnabledFlag(repositoryId: string): Promise<boolean> {
  try {
    const repoOverrides = await getRepositorySettingsFor(
      database.db,
      repositoryId,
      ["repo_rules_enabled"],
    );
    const global = await loadSettings(database.db, ["repo_rules_enabled"]);
    const raw =
      repoOverrides.get("repo_rules_enabled") ??
      global.get("repo_rules_enabled");
    if (raw === undefined || raw === null || raw === "") return true;
    return raw === "true";
  } catch {
    return true;
  }
}

// HTTP 入口与业务放在同一处：新增同类入口只修改本文件。
export const routes = [
  { path: "/repo-rules", prefix: true, handle: handleRepoRulesRequest },
] satisfies readonly HttpRoute[];
