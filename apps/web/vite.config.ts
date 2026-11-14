import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const proxyTarget = process.env.VITE_PROXY_TARGET ?? "http://127.0.0.1:30001";

// 前端构建版本：构建时从 package.json 读出，注入到 __APP_VERSION__，
// 供「关于」页展示。配合 index.html no-cache，可在强刷后核验是否拿到新前端。
const webPkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version?: string };

// The web dev server proxies API + SSE traffic to the API app so the browser
// only talks to one origin (no CORS, and EventSource works cleanly).
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(webPkg.version ?? "dev"),
  },
  plugins: [react()],
  server: {
    port: 5173,
    // SMB does not support inotify-style watchers; poll instead.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": proxyTarget,
      "/exports": proxyTarget,
      "/openapi.json": proxyTarget,
      "/auth": proxyTarget,
      "/setup": proxyTarget,
      "/health": proxyTarget,
      "/tasks": proxyTarget,
      "/summary": proxyTarget,
      "/results": proxyTarget,
      "/providers": proxyTarget,
      "/repositories": proxyTarget,
      "/repo-rules": proxyTarget,
      "/logs": proxyTarget,
      "/vector": proxyTarget,
      "/config": proxyTarget,
      "/settings": proxyTarget,
      "/memory": proxyTarget,
      "/users": proxyTarget,
      "/audit": proxyTarget,
      "/capabilities": proxyTarget,
      "/label-rules": proxyTarget,
      "/backup": proxyTarget,
      "/index": proxyTarget,
      "/update": proxyTarget,
      "/scans": proxyTarget,
      "/events": { target: proxyTarget, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    css: false,
  },
});
