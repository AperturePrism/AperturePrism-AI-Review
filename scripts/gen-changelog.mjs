#!/usr/bin/env node
/**
 * 生成官网「更新日志」页 website/changelog.html。
 *
 * 数据 100% 来自 GitHub Releases（真实发布内容 + 发布时间），不做任何编造。
 * 用法：
 *   node scripts/gen-changelog.mjs                 # 默认仓库
 *   node scripts/gen-changelog.mjs owner/repo      # 指定仓库
 *   GITHUB_TOKEN=xxx node scripts/gen-changelog.mjs  # 提供 token 提高限流（CI 用）
 *
 * 输出：website/changelog.html（全量重建，幂等）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "website", "changelog.html");

const REPO = process.argv[2] || "AperturePrism/AperturePrism-AI-Review";
const TOKEN = process.env.GITHUB_TOKEN || "";

/** 最近 N 个版本默认展开，更早的折叠。 */
const OPEN = 12;

async function fetchReleases() {
  const headers = { Accept: "application/vnd.github+json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const all = [];
  let page = 1;
  for (;;) {
    const url = `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`GitHub API ${res.status} ${res.statusText}: ${url}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    page += 1;
  }
  if (all.length === 0) throw new Error("未获取到任何 release");
  return all;
}

/** UTC ISO → 北京时间字符串。 */
function bj(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** release body → 变更条目列表（过滤无信息行、剥掉 commit 前缀）。 */
function parseItems(body) {
  const out = [];
  for (const raw of String(body || "").split("\n")) {
    let t = raw.trimEnd();
    if (!t) continue;
    if (/^#{1,2}\s+v?\d/.test(t)) continue; // 版本主标题
    if (t.includes("镜像已推送 GHCR")) continue; // 镜像行
    t = t.replace(/^[0-9a-f]{7,}\s+/, ""); // 去掉 commit hash
    if (/^chore\(release\)|^chore:\s*发布\s*v?\d/.test(t)) continue; // 纯发布 commit
    t = t.replace(/^###\s*/, "");
    if (/^变更$/.test(t)) continue; // 「### 变更」固定标题
    t = t.replace(/^(feat|fix|docs|test|refactor|chore)(\([a-z-]+\))?:\s*/i, ""); // 类型前缀
    out.push(t);
  }
  return out;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const releases = await fetchReleases();

const head = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>更新日志 — AperturePrism</title>
  <meta name="description" content="AperturePrism 版本更新日志：每个版本的更新内容与发布时间，来自 GitHub Releases。" />
  <meta property="og:title" content="更新日志 — AperturePrism" />
  <meta property="og:image" content="assets/og-image.jpg" />
  <meta property="og:locale" content="zh_CN" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" type="image/png" href="assets/favicon.png" />
  <link rel="apple-touch-icon" href="assets/favicon.png" />
  <link rel="preload" href="assets/fonts/cabinet-800.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="assets/fonts/geist.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="preload" href="assets/fonts/geist-mono.woff2" as="font" type="font/woff2" crossorigin />
  <link rel="stylesheet" href="assets/style.css?v=13" />
</head>
<body>
  <a class="skip-link" href="#main">跳到正文</a>

  <header class="nav" id="nav">
    <div class="container nav__inner">
      <a class="brand" href="index.html" aria-label="AperturePrism 首页">
        <img class="brand__mark" src="assets/logo.png" alt="AperturePrism" />
      </a>
      <nav class="nav__links" aria-label="主导航">
        <a href="index.html">官网</a>
        <a href="index.html#capabilities">核心能力</a>
        <a href="index.html#architecture">系统架构</a>
        <a href="index.html#console">控制台</a>
        <a href="guide.html">配置教程</a>
        <a href="#timeline" class="active">更新日志</a>
        <a href="architecture.html">架构</a>
      </nav>
      <div class="nav__actions">
        <a class="btn btn--ghost" href="https://github.com/AperturePrism/AperturePrism-AI-Review" target="_blank" rel="noreferrer">GitHub</a>
        <a class="btn btn--primary" href="index.html#quickstart">开始部署</a>
        <button class="nav__toggle" id="navToggle" aria-label="打开菜单" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
      </div>
    </div>
  </header>

  <div class="drawer" id="drawer" aria-hidden="true">
    <nav class="drawer__links" aria-label="移动端导航">
      <a href="index.html">官网</a>
      <a href="index.html#capabilities">核心能力</a>
      <a href="index.html#architecture">系统架构</a>
      <a href="index.html#console">控制台</a>
      <a href="guide.html">配置教程</a>
      <a href="#timeline">更新日志</a>
      <a href="architecture.html">架构</a>
      <a href="https://github.com/AperturePrism/AperturePrism-AI-Review" target="_blank" rel="noreferrer">GitHub ↗</a>
    </nav>
  </div>

  <main id="main">
    <div class="guide-hero">
      <div class="container">
        <p class="hero__eyebrow mono">CHANGELOG · 版本更新</p>
        <h1 class="guide-hero__title">更新日志</h1>
        <p class="guide-hero__sub">每个版本的更新内容与发布时间，直接来自 GitHub Releases。最近 ${OPEN} 个版本默认展开，更早的可点击展开。</p>
      </div>
    </div>

    <div class="container">
      <div class="chlog__meta mono">
        <span>当前最新 <strong>${esc(releases[0].tag_name)}</strong></span>
        <i></i>
        <span>共 ${releases.length} 个版本</span>
        <i></i>
        <span>起始 ${bj(releases[releases.length - 1].published_at)}</span>
      </div>

      <div class="timeline" id="timeline">
`;

let itemsHtml = "";
releases.forEach((r, idx) => {
  const items = parseItems(r.body);
  const date = bj(r.published_at);
  const open = idx < OPEN ? " open" : "";
  const latest = idx === 0 ? ' data-latest=""' : "";
  const rows = items
    .map((it) => {
      const cls = /^feat/.test(it) ? "feat" : /^fix/.test(it) ? "fix" : /^docs|^文档/.test(it) ? "docs" : /^test/.test(it) ? "test" : "misc";
      return `<li class="cl-${cls}"><span class="cl-tag">${cls}</span><span>${esc(it)}</span></li>`;
    })
    .join("");
  itemsHtml += `        <details class="ver"${open}${latest}>
          <summary>
            <span class="ver__tag">${esc(r.tag_name)}</span>
            <span class="ver__date mono">${date}</span>
            <span class="ver__count mono">${items.length} 项</span>
          </summary>
          <ul class="ver__items">${rows || "<li class='cl-misc'><span class='cl-tag'>chore</span><span>构建 / 发布调整</span></li>"}</ul>
        </details>
`;
});

const foot = `      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="container footer__inner">
      <div class="footer__brand">
        <img class="footer__mark" src="assets/logo.png" alt="AperturePrism" />
        <p>把 AI 代码审查做成一条可落地的产品链路。</p>
      </div>
      <div class="footer__links">
        <a href="index.html">官网</a>
        <a href="index.html#capabilities">核心能力</a>
        <a href="index.html#architecture">系统架构</a>
        <a href="#timeline">更新日志</a>
      </div>
      <div class="footer__links">
        <a href="guide.html">完整配置教程 ↗</a>
        <a href="architecture.html">架构与流程 ↗</a>
        <a href="index.html#quickstart">快速开始</a>
        <a href="index.html#console">控制台</a>
      </div>
      <p class="footer__copy mono">APERTUREPRISM © <span id="year"></span> · 开源 · MIT License</p>
    </div>
  </footer>

  <script src="assets/app.js?v=13"></script>
</body>
</html>
`;

fs.writeFileSync(OUT, head + itemsHtml + foot, "utf8");
console.error(`已生成 ${OUT}：${releases.length} 个版本，最新 ${releases[0].tag_name}`);



