import { describe, expect, it } from "vitest";
import {
  ALLOWED_SETTING_KEYS,
  BOOLEAN_DEFAULTS,
  KNOWN_SETTING_KEYS,
  REPO_SCOPED_SETTING_KEYS,
  SECRET_SETTING_KEYS,
  SETTINGS_REGISTRY,
  getSettingSpec,
  isKnownSettingKey,
  parseBool,
  parseLogLevel,
  parseSpamHandling,
  validateSettingValue,
} from "./settings-registry.js";

describe("registry integrity", () => {
  it("has no duplicate keys", () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps the write allowlist and the GET list in sync", () => {
    // 这两份名单此前各写一处并已漂移：pr_check_run 一度在 GET 列表里、却不在写
    // 白名单，界面画得出开关但保存必然 unsupported_setting_key。
    expect([...KNOWN_SETTING_KEYS].sort()).toEqual(
      [...ALLOWED_SETTING_KEYS].sort(),
    );
  });

  it("marks every secret-looking key as secret", () => {
    for (const spec of SETTINGS_REGISTRY) {
      if (/secret|token|api_key|private_key/.test(spec.key)) {
        expect(spec.secret).toBe(true);
      }
    }
  });

  it("declares options for every enum/multicheck and none for other kinds", () => {
    for (const spec of SETTINGS_REGISTRY) {
      if (spec.kind === "enum" || spec.kind === "multicheck") {
        expect(spec.options?.length).toBeGreaterThan(0);
      } else {
        expect(spec.options).toBeUndefined();
      }
    }
  });

  it("gives every key a non-empty label and hint", () => {
    for (const spec of SETTINGS_REGISTRY) {
      expect(spec.label.trim().length).toBeGreaterThan(0);
      expect(spec.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it("only marks QQ settings as restart-required", () => {
    // 如实标注是重点：qq-bot 只在启动读一次，其余都是轮询热生效。谎报会让用户
    // 以为改了就生效。
    for (const spec of SETTINGS_REGISTRY) {
      if (spec.hotReload === "restart") expect(spec.group).toBe("qq");
    }
  });

  it("exposes exactly the per-repository keys", () => {
    // 与仓库级白名单一致，否则仓库覆盖会静默失效。
    expect([...REPO_SCOPED_SETTING_KEYS].sort()).toEqual([
      "issue_assignee",
      "issue_auto_assign",
      "issue_deep_analysis",
      "issue_reanalyze_min_change",
      "issue_rewrite_title",
      "issue_use_unified_sections",
      "issue_vision_enabled",
      "repo_rules_enabled",
      "repo_rules_url",
      "spam_handling",
    ]);
  });

  it("never marks a global-only setting as repo-scoped", () => {
    for (const key of [
      "log_level",
      "webui_api_token",
      "github_webhook_secret",
      "oauth_client_id",
      "embedding_api_key",
      "github_app_private_key",
      "pr_check_run",
      "scan_enabled",
    ]) {
      expect(getSettingSpec(key)?.repoScoped).toBe(false);
    }
  });

  it("recognizes known keys and rejects unknown ones", () => {
    expect(isKnownSettingKey("log_level")).toBe(true);
    expect(isKnownSettingKey("")).toBe(false);
    expect(isKnownSettingKey("__proto__")).toBe(false);
    expect(isKnownSettingKey("log_level ")).toBe(false);
  });

  it("covers every key that the secret set claims", () => {
    for (const key of SECRET_SETTING_KEYS) {
      expect(isKnownSettingKey(key)).toBe(true);
    }
  });
});

describe("parseBool + BOOLEAN_DEFAULTS pin current behaviour", () => {
  it("reproduces the default-off keys (previously === \"true\")", () => {
    for (const key of [
      "issue_auto_assign",
      "agent_team_enabled",
    ]) {
      const def = BOOLEAN_DEFAULTS[key]!;
      expect(def).toBe(false);
      expect(parseBool(undefined, def)).toBe(false);
      expect(parseBool("", def)).toBe(false);
      // 非 "true" 的任何值都不该开启。
      expect(parseBool("yes", def)).toBe(false);
      expect(parseBool("1", def)).toBe(false);
      expect(parseBool("true", def)).toBe(true);
    }
  });

  it("reproduces the default-on keys (previously !== \"false\")", () => {
    for (const key of [
      "issue_rewrite_title",
      "issue_deep_analysis",
      "pr_check_run",
      "pr_auto_review",
      "scan_enabled",
    ]) {
      const def = BOOLEAN_DEFAULTS[key]!;
      expect(def).toBe(true);
      expect(parseBool(undefined, def)).toBe(true);
      // 只有显式 "false" 才关闭。
      expect(parseBool("false", def)).toBe(false);
      expect(parseBool("true", def)).toBe(true);
      expect(parseBool("", def)).toBe(true);
    }
  });

  it("has a default for every boolean key in the registry", () => {
    for (const spec of SETTINGS_REGISTRY) {
      if (spec.kind !== "boolean") continue;
      // github_webhook_enabled 的默认是动态的（跟随是否配了签名密钥）。
      if (spec.key === "github_webhook_enabled") continue;
      expect(BOOLEAN_DEFAULTS[spec.key]).toBeTypeOf("boolean");
    }
  });
});

describe("parseSpamHandling", () => {
  it("accepts the three modes and defaults to close", () => {
    expect(parseSpamHandling("none")).toBe("none");
    expect(parseSpamHandling("close")).toBe("close");
    expect(parseSpamHandling("delete")).toBe("delete");
    // 缺省、空、非法一律 close —— 与替换前的 spamHandlingMode 一致。
    expect(parseSpamHandling(undefined)).toBe("close");
    expect(parseSpamHandling("")).toBe("close");
    expect(parseSpamHandling("DELETE")).toBe("close");
  });
});

describe("parseLogLevel", () => {
  it("accepts valid levels", () => {
    expect(parseLogLevel("debug", "info")).toBe("debug");
    expect(parseLogLevel("silent", "info")).toBe("silent");
  });

  it("rejects an invalid level instead of poisoning the logger", () => {
    // 之前 DB 里的值不经校验就赋给 logger.level，填 foo 会污染日志系统。
    expect(parseLogLevel("foo", "info")).toBe("info");
    expect(parseLogLevel("", "warn")).toBe("warn");
    expect(parseLogLevel(undefined, "warn")).toBe("warn");
    expect(parseLogLevel("DEBUG", "info")).toBe("info");
  });
});

describe("validateSettingValue", () => {
  it("rejects an unknown key", () => {
    expect(validateSettingValue("nope", "x")).toMatch(/未知/);
  });

  it("accepts only true/false for booleans", () => {
    expect(validateSettingValue("issue_rewrite_title", "true")).toBeNull();
    expect(validateSettingValue("issue_rewrite_title", "false")).toBeNull();
    // 之前无校验直存，界面之外的调用方可以写进任意字符串。
    expect(validateSettingValue("issue_rewrite_title", "yes")).not.toBeNull();
    expect(validateSettingValue("issue_rewrite_title", "")).not.toBeNull();
  });

  it("restricts enums to their declared options", () => {
    expect(validateSettingValue("log_level", "debug")).toBeNull();
    // 这条正是导致日志系统被污染的输入。
    expect(validateSettingValue("log_level", "foo")).not.toBeNull();
    expect(validateSettingValue("spam_handling", "close")).toBeNull();
    expect(validateSettingValue("spam_handling", "DELETE")).not.toBeNull();
  });

  it("bounds the reanalysis ratio to 0..1", () => {
    expect(validateSettingValue("issue_reanalyze_min_change", "0.25")).toBeNull();
    expect(validateSettingValue("issue_reanalyze_min_change", "0")).toBeNull();
    expect(validateSettingValue("issue_reanalyze_min_change", "1")).toBeNull();
    expect(
      validateSettingValue("issue_reanalyze_min_change", "1.5"),
    ).not.toBeNull();
    expect(
      validateSettingValue("issue_reanalyze_min_change", "-0.1"),
    ).not.toBeNull();
    expect(
      validateSettingValue("issue_reanalyze_min_change", "abc"),
    ).not.toBeNull();
  });

  it("requires a non-negative integer for QQ intents", () => {
    expect(validateSettingValue("qq_official_intents", "33554432")).toBeNull();
    expect(validateSettingValue("qq_official_intents", "-1")).not.toBeNull();
    expect(validateSettingValue("qq_official_intents", "1.5")).not.toBeNull();
  });

  it("requires the QQ protocol config to be a JSON object", () => {
    expect(
      validateSettingValue("qq_bot_protocols", '{"onebot11":{"baseUrl":"http://x"}}'),
    ).toBeNull();
    expect(validateSettingValue("qq_bot_protocols", "[]")).not.toBeNull();
    expect(validateSettingValue("qq_bot_protocols", "{oops")).not.toBeNull();
    // 空串表示清空，交给写入侧处理，不在这里拦。
    expect(validateSettingValue("qq_bot_protocols", "")).toBeNull();
  });

  it("does not constrain free-form strings and secrets", () => {
    expect(validateSettingValue("issue_assignee", "octocat")).toBeNull();
    expect(validateSettingValue("webui_api_token", "anything")).toBeNull();
    expect(validateSettingValue("embedding_base_url", "not-a-url")).toBeNull();
  });
});
