#!/usr/bin/env node
/**
 * AperturePrism 官网维护脚本。
 *
 * 目前职责：
 *  1) ensureSvgFit —— 给 website/diagrams/*.html 注入 SVG 自适应样式，
 *     使 archify 生成的图在 iframe / 任意容器内等比填满，避免拉伸或留白。
 *     幂等：已注入则跳过。
 *  2) buildChangelog —— 委托 scripts/gen-changelog.mjs 重新生成更新日志页。
 *
 * 用法：
 *   node scripts/site-build.mjs            # 全部（图自适应 + 更新日志）
 *   node scripts/site-build.mjs --diagrams # 仅图自适应
 *   node scripts/site-build.mjs --changelog
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIAGRAMS_DIR = path.join(ROOT, "website", "diagrams");

// 注入样式：
//  - 保留 archify 完整视图（含 toolbar 交互）；只清掉 body 默认边距、并让 SVG
//    按自身 viewBox 等比填充（宽 100%、高 auto），比例始终正确；
//  - 节点主/副标题向外偏移，加大节点内部上下间距。
//  - 注意：iframe 高度由架构页脚本按内容 scrollHeight 自适应，这里不设死。
// /AP-DIAG/ 作幂等标记。
const INJECT_STYLE =
  "<style>/*AP-DIAG*/" +
  "body{margin:0!important}" +
  "svg{width:100%!important;height:auto!important;display:block}" +
  "[data-node-label]{transform:translateY(-5px)}" +
  "[data-detail=\"context\"]{transform:translateY(5px)}" +
  "</style>";
const INJECT_MARK = "/*AP-DIAG*/";

function ensureSvgFit() {
  if (!fs.existsSync(DIAGRAMS_DIR)) {
    console.error(`未找到图目录: ${DIAGRAMS_DIR}`);
    return;
  }
  const files = fs
    .readdirSync(DIAGRAMS_DIR)
    .filter((n) => n.endsWith(".html"));
  for (const file of files) {
    const fp = path.join(DIAGRAMS_DIR, file);
    let html = fs.readFileSync(fp, "utf8");
    if (html.includes(INJECT_MARK)) {
      console.log(`[diagrams] ${file}: 已注入，跳过`);
      continue;
    }
    if (!html.includes("</head>")) {
      console.warn(`[diagrams] ${file}: 无 </head>，跳过`);
      continue;
    }
    html = html.replace("</head>", INJECT_STYLE + "\n</head>");
    fs.writeFileSync(fp, html, "utf8");
    console.log(`[diagrams] ${file}: 已注入 SVG 自适应 + 节点间距样式`);
  }
}

function buildChangelog() {
  const script = path.join(__dirname, "gen-changelog.mjs");
  const r = spawnSync(process.execPath, [script], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("[changelog] 生成失败");
    process.exitCode = r.status ?? 1;
  }
}

const onlyDiagrams = process.argv.includes("--diagrams");
const onlyChangelog = process.argv.includes("--changelog");

if (onlyChangelog) {
  buildChangelog();
} else if (onlyDiagrams) {
  ensureSvgFit();
} else {
  ensureSvgFit();
  buildChangelog();
}
console.log("site-build 完成");