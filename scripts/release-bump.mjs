#!/usr/bin/env node
/**
 * 版本发布一键脚本（替代此前每次手动的正则替换 + 手动 tag）：
 *
 *   node scripts/release-bump.mjs patch        # 1.0.63 -> 1.0.64
 *   node scripts/release-bump.mjs minor        # 1.0.x -> 1.1.0
 *   node scripts/release-bump.mjs major        # 1.0.x -> 2.0.0
 *   node scripts/release-bump.mjs 1.2.3        # 指定版本号
 *
 * 步骤：读根 package.json 当前版本 → 计算新版本 → 重写所有 workspace
 * package.json 与 lock → `npm install --package-lock-only` 校准 lock →
 * git add + commit + tag。push 由调用方自行执行（此处不越权推远端）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function bump(version, part) {
  const [major, minor, patch] = version.split(".").map((n) => Number(n) || 0);
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "major") return `${major + 1}.0.0`;
  // 允许预发布后缀（如 1.3.0-beta），便于灰度版本直接指定。
  if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(part)) return part;
  throw new Error(`无效的版本参数：${part}（可用 patch/minor/major 或 x.y.z）`);
}

/** 跳过 node_modules / archive / dist 的 package.json 收集器。 */
function collectPackageJsons(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue; // 符号链接悬空等情形直接忽略。
    }
    if (!stat.isDirectory()) {
      if (name === "package.json") out.push(full);
      continue;
    }
    if (["node_modules", "archive", "dist", ".git"].includes(name)) continue;
    collectPackageJsons(full, out);
  }
  return out;
}

const arg = process.argv[2];
if (!arg) {
  console.error("用法: node scripts/release-bump.mjs <patch|minor|major|x.y.z>");
  process.exit(1);
}

const rootPkgPath = join(root, "package.json");
const current = JSON.parse(readFileSync(rootPkgPath, "utf8")).version;
const next = bump(current, arg);
console.log(`${current} -> ${next}`);

// 1) 全部 workspace package.json：自身版本与对内依赖引用一并替换。
const pkgFiles = collectPackageJsons(root);
for (const file of pkgFiles) {
  const raw = readFileSync(file, "utf8");
  const updated = raw.split(`"${current}"`).join(`"${next}"`);
  if (updated !== raw) writeFileSync(file, updated);
}
console.log(`已更新 ${pkgFiles.length} 个 package.json`);

// 2) lock 同步 + 校准（--package-lock-only 不装依赖，快且不会触发 postinstall）。
// Windows 下 npm 是 npm.cmd，直接 spawn 会 ENOENT；shell:true 兼容两平台。
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});

// 3) 提交 + 打 tag。
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
git("add", "-A");
git("commit", "-m", `chore(release): v${next}`);
git("tag", `v${next}`);
console.log(`完成：本地 commit + tag v${next} 已就绪`);
console.log(`下一步: git push origin main --tags && 等待 Docker CI/CD 构建后部署`);
