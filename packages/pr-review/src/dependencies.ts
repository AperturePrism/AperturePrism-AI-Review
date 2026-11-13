/**
 * 依赖变更：对照 package.json 快照，列出新增、移除、版本范围和安装脚本变化。
 * 调用：comparePackageDependencies(oldPackageJson, newPackageJson)。
 * 不联网查询漏洞，不执行安装脚本；风险项用于决定需要补哪些验证。
 */
import { z } from "zod";

const dependencyMap = z.record(
  z.string().min(1).max(214),
  z.string().min(1).max(2_000),
);
const manifestSchema = z
  .object({
    name: z.string().optional(),
    version: z.string().optional(),
    dependencies: dependencyMap.optional(),
    devDependencies: dependencyMap.optional(),
    peerDependencies: dependencyMap.optional(),
    optionalDependencies: dependencyMap.optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    engines: z.record(z.string(), z.string()).optional(),
    packageManager: z.string().optional(),
  })
  .passthrough();

type Manifest = z.infer<typeof manifestSchema>;
export type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies"
  | "optionalDependencies";
export type DependencySource =
  "registry" | "git" | "url" | "local" | "workspace" | "alias";
export type DependencyChange = {
  name: string;
  section: DependencySection;
  action: "added" | "removed" | "updated";
  before: string | null;
  after: string | null;
  source: DependencySource;
  majorChange: boolean | null;
  warnings: readonly string[];
};
export type PackageDependencyChanges = {
  packageName: string | null;
  changes: readonly DependencyChange[];
  scripts: readonly {
    name: string;
    before: string | null;
    after: string | null;
    installLifecycle: boolean;
  }[];
  runtimeChanges: readonly {
    field: string;
    before: string | null;
    after: string | null;
  }[];
  reviewChecks: readonly string[];
};

/** 完整 JSON 在边界检查；非法文件不能悄悄变成空依赖表。 */
export function parsePackageManifest(text: string): Manifest {
  if (text.length > 2_000_000)
    throw new Error("package.json 超过 2 MB，未进行依赖对照");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("package.json 不是合法 JSON");
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `package.json 依赖字段无效：${parsed.error.issues.map((issue) => issue.path.join(".")).join("、")}`,
    );
  return parsed.data;
}

/** 识别依赖来源，避免把 URL 或 git 引用当普通 registry 版本。 */
export function dependencySource(version: string): DependencySource {
  if (/^workspace:/u.test(version)) return "workspace";
  if (/^(?:file:|link:|\.\.?\/)/u.test(version)) return "local";
  if (/^npm:/u.test(version)) return "alias";
  if (
    /^(?:git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|ssh:|git@)/u.test(
      version,
    ) ||
    /^[\w.-]+\/[\w.-]+(?:#.*)?$/u.test(version)
  )
    return "git";
  if (/^https?:/u.test(version)) return "url";
  return "registry";
}

/** 仅比较显式语义版本的主版本；复杂范围返回 unknown，而不是编造升级大小。 */
function majorVersion(version: string): number | null {
  const match = /^[~^=v\s]*(\d+)\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?\s*$/u.exec(
    version,
  );
  return match ? Number(match[1]) : null;
}

/** 对照依赖和安装生命周期；只输出可从两个快照直接确认的事实。 */
export function comparePackageDependencies(
  beforeText: string,
  afterText: string,
): PackageDependencyChanges {
  const before = parsePackageManifest(beforeText);
  const after = parsePackageManifest(afterText);
  const changes: DependencyChange[] = [];
  const sections: DependencySection[] = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ];
  for (const section of sections) {
    const oldVersions = before[section] ?? {};
    const newVersions = after[section] ?? {};
    const names = [
      ...new Set([...Object.keys(oldVersions), ...Object.keys(newVersions)]),
    ].sort();
    for (const name of names) {
      const oldVersion = oldVersions[name] ?? null;
      const newVersion = newVersions[name] ?? null;
      if (oldVersion === newVersion) continue;
      const source = dependencySource(newVersion ?? oldVersion!);
      const oldMajor = oldVersion ? majorVersion(oldVersion) : null;
      const newMajor = newVersion ? majorVersion(newVersion) : null;
      const majorChange =
        oldMajor !== null && newMajor !== null ? oldMajor !== newMajor : null;
      const warnings: string[] = [];
      if (majorChange)
        warnings.push("显式主版本变化，需要检查 API 与运行时兼容性");
      if (
        newVersion &&
        /^(?:\*|latest|next|canary|beta)$/u.test(newVersion.trim())
      )
        warnings.push("依赖使用浮动标签，复现安装时应核对锁文件");
      if (
        source === "git" &&
        newVersion &&
        !/#[a-f0-9]{40}$/iu.test(newVersion)
      )
        warnings.push("Git 依赖没有固定到完整提交 SHA");
      if (source === "url")
        warnings.push("依赖来自直接下载地址，需要检查来源和完整性");
      if (oldVersion && newVersion && dependencySource(oldVersion) !== source)
        warnings.push("依赖来源类别改变，需要确认这是有意切换");
      changes.push({
        name,
        section,
        action: !oldVersion ? "added" : !newVersion ? "removed" : "updated",
        before: oldVersion,
        after: newVersion,
        source,
        majorChange,
        warnings,
      });
    }
  }
  const scriptNames = [
    ...new Set([
      ...Object.keys(before.scripts ?? {}),
      ...Object.keys(after.scripts ?? {}),
    ]),
  ].sort();
  const scripts = scriptNames
    .filter((name) => before.scripts?.[name] !== after.scripts?.[name])
    .map((name) => ({
      name,
      before: before.scripts?.[name] ?? null,
      after: after.scripts?.[name] ?? null,
      installLifecycle: [
        "preinstall",
        "install",
        "postinstall",
        "prepare",
        "prepublish",
        "preprepare",
        "postprepare",
      ].includes(name),
    }));
  const runtimeChanges: {
    field: string;
    before: string | null;
    after: string | null;
  }[] = [];
  if (before.packageManager !== after.packageManager)
    runtimeChanges.push({
      field: "packageManager",
      before: before.packageManager ?? null,
      after: after.packageManager ?? null,
    });
  for (const name of [
    ...new Set([
      ...Object.keys(before.engines ?? {}),
      ...Object.keys(after.engines ?? {}),
    ]),
  ].sort()) {
    if (before.engines?.[name] !== after.engines?.[name])
      runtimeChanges.push({
        field: `engines.${name}`,
        before: before.engines?.[name] ?? null,
        after: after.engines?.[name] ?? null,
      });
  }
  const reviewChecks: string[] = [];
  if (changes.length)
    reviewChecks.push("核对锁文件更新与依赖变更一致，并执行受影响的构建/回归");
  if (changes.some((change) => change.majorChange))
    reviewChecks.push("阅读主版本迁移说明，确认没有依赖已移除 API");
  if (scripts.some((script) => script.installLifecycle))
    reviewChecks.push("安装生命周期脚本改变，在受控环境中检查其实际行为");
  if (runtimeChanges.length)
    reviewChecks.push("核对 CI、容器镜像和生产环境的 Node/包管理器版本");
  return {
    packageName: after.name ?? before.name ?? null,
    changes,
    scripts,
    runtimeChanges,
    reviewChecks,
  };
}
