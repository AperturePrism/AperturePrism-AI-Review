import { describe, expect, it } from "vitest";
import { REPO_SCOPED_SETTING_KEYS } from "../../config/src/settings-registry.js";
import {
  isRepositorySettingKey,
  REPOSITORY_SETTING_KEYS,
  resolveSetting,
} from "./repository-settings-keys.js";

describe("isRepositorySettingKey", () => {
  it("matches the setting registry so repository controls cannot silently fail", () => {
    expect([...REPOSITORY_SETTING_KEYS].sort()).toEqual(
      [...REPO_SCOPED_SETTING_KEYS].sort(),
    );
  });
  it("accepts every per-repository key", () => {
    for (const key of REPOSITORY_SETTING_KEYS) {
      expect(isRepositorySettingKey(key)).toBe(true);
    }
  });

  it("rejects global-only settings", () => {
    // 这些是进程级或账户级的：按仓库覆盖不会生效，只会给出「我改了却没用」的
    // 错觉，所以必须在写入闸口就拒掉。
    for (const key of [
      "log_level",
      "webui_api_token",
      "github_webhook_secret",
      "github_webhook_enabled",
      "oauth_client_id",
      "oauth_client_secret",
      "embedding_base_url",
      "embedding_api_key",
      "github_app_id",
      "github_app_private_key",
      "pr_check_run",
      "pr_auto_review",
    ]) {
      expect(isRepositorySettingKey(key)).toBe(false);
    }
  });

  it("rejects unknown and empty keys", () => {
    expect(isRepositorySettingKey("")).toBe(false);
    expect(isRepositorySettingKey("issue_rewrite_title ")).toBe(false);
    expect(isRepositorySettingKey("__proto__")).toBe(false);
    expect(isRepositorySettingKey("constructor")).toBe(false);
  });
});

describe("resolveSetting", () => {
  it("prefers the repository override over the global value", () => {
    const repo = new Map([["issue_rewrite_title", "false"]]);
    const globals = new Map([["issue_rewrite_title", "true"]]);
    expect(resolveSetting(repo, globals, "issue_rewrite_title")).toBe("false");
  });

  it("falls back to the global value when the repository has no override", () => {
    const globals = new Map([["issue_rewrite_title", "true"]]);
    expect(resolveSetting(new Map(), globals, "issue_rewrite_title")).toBe(
      "true",
    );
  });

  it("returns undefined when neither level configured the key", () => {
    // 这一层不猜默认值：标题改写默认开、深度分析默认关，只有调用方知道。
    expect(resolveSetting(new Map(), new Map(), "issue_deep_analysis")).toBe(
      undefined,
    );
  });

  it("treats an empty override as a real value, not as absent", () => {
    // 「清空指派对象」和「跟随全局」是两种意图；用空串表示后者就没法区分了，
    // 所以清除覆盖走的是删除行，而不是写入空串。
    const repo = new Map([["issue_assignee", ""]]);
    const globals = new Map([["issue_assignee", "octocat"]]);
    expect(resolveSetting(repo, globals, "issue_assignee")).toBe("");
  });
});
