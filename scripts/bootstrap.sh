#!/usr/bin/env bash
# AperturePrism 一键安装 - GitHub 直跑入口（单文件，可 curl | bash）
#
# 用法：
#   # 直跑（拉取最新 main 源码到本地目录再安装）：
#   curl -fsSL https://raw.githubusercontent.com/AperturePrism/AperturePrism-AI-Review/main/scripts/bootstrap.sh | bash
#   # 传参（例如跳过容器/跳过构建）：
#   curl -fsSL .../scripts/bootstrap.sh | bash -s -- --skip-docker
#   # 本地已检出仓库时直接调用本文件，等价于执行 ./scripts/install.sh：
#   ./scripts/bootstrap.sh --help
#
# 环境变量覆盖：
#   APERTUREPRISM_REPO_URL  仓库地址（默认 https://github.com/AperturePrism/AperturePrism-AI-Review.git）
#   APERTUREPRISM_REF       分支或标签（默认 main）
#   APERTUREPRISM_SRC_DIR   本地安装源码目录（默认 $HOME/.apertureprism/AperturePrism-AI-Review）
set -euo pipefail

REPO_URL="${APERTUREPRISM_REPO_URL:-https://github.com/AperturePrism/AperturePrism-AI-Review.git}"
REF="${APERTUREPRISM_REF:-main}"
SRC_DIR="${APERTUREPRISM_SRC_DIR:-$HOME/.apertureprism/AperturePrism-AI-Review}"

# 已在本地检出时直接复用（等价于本地跑 install.sh），避免重复下载。
is_local_checkout() {
  local source_file="${BASH_SOURCE[0]:-}"
  [[ -n "$source_file" && -f "$source_file" ]] || return 1
  local root
  root="$(cd "$(dirname "$source_file")/.." 2>/dev/null && pwd)" || return 1
  [[ -f "$root/package.json" && -f "$root/scripts/install.sh" ]]
}

# 从 GitHub 拉取源码到稳定目录；已存在合法检出时自动快进同步到最新，避免复用旧版本。
acquire() {
  if [[ -f "$SRC_DIR/package.json" && -f "$SRC_DIR/scripts/install.sh" ]]; then
    echo "[INFO] 复用本地源码并刷新: $SRC_DIR (ref=$REF)"
    if command -v git >/dev/null 2>&1 && git -C "$SRC_DIR" rev-parse --git-dir >/dev/null 2>&1; then
      if git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$REF" \
        && git -C "$SRC_DIR" reset --quiet --hard "origin/$REF"; then
        echo "[OK] 本地源码已同步到 $REF"
      else
        # fetch/reset 失败（如本地有冲突、断网）时降级复用现有版本，不阻断安装。
        echo "[WARN] 本地源码刷新失败，继续使用现有版本" >&2
      fi
    else
      echo "[INFO] 无 git / 非 git 目录，复用现有本地源码"
    fi
    return 0
  fi
  echo "[INFO] 下载 AperturePrism 源码 → $SRC_DIR (ref=$REF)"
  local parent
  parent="$(dirname "$SRC_DIR")"
  mkdir -p "$parent"
  rm -rf "$SRC_DIR.tmp"
  if command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC_DIR.tmp" \
      || { rm -rf "$SRC_DIR.tmp"; return 1; }
  else
    # 无 git 时回退到 codeload tarball（REF 需为分支名）。
    local archive
    archive="https://codeload.github.com/AperturePrism/AperturePrism-AI-Review/tar.gz/refs/heads/$REF"
    mkdir -p "$SRC_DIR.tmp"
    curl -fsSL "$archive" | tar -xz --strip-components=1 -C "$SRC_DIR.tmp" \
      || { rm -rf "$SRC_DIR.tmp"; return 1; }
  fi
  if [[ ! -f "$SRC_DIR.tmp/scripts/install.sh" ]]; then
    echo "[FAIL] 拉取的源码缺少 scripts/install.sh" >&2
    rm -rf "$SRC_DIR.tmp"
    return 1
  fi
  rm -rf "$SRC_DIR"
  mv "$SRC_DIR.tmp" "$SRC_DIR"
  return 0
}

# 确保 Node >= 22 存在。bootstrap 阶段还没有 Node，无法运行 .mjs，只能在 bash 层处理：
# 缺 Node 或版本过低时，若传了 --auto-install（或 APERTUREPRISM_AUTO_INSTALL=1）则自动安装，
# 否则给出明确提示。
ensure_node() {
  local major=0
  if command -v node >/dev/null 2>&1; then
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  fi
  [[ "$major" -ge 22 ]] && return 0
  local auto="${APERTUREPRISM_AUTO_INSTALL:-0}"
  for a in "$@"; do
    [[ "$a" = "--auto-install" ]] && auto=1
  done
  if [[ "$auto" != "1" ]]; then
    if command -v node >/dev/null 2>&1; then
      echo "[FAIL] 需要 Node.js >= 22（当前 $(node -v)）。可加 --auto-install 自动安装，或手动安装 https://nodejs.org/" >&2
    else
      echo "[FAIL] 未检测到 Node.js。可加 --auto-install 自动安装，或手动安装 https://nodejs.org/" >&2
    fi
    exit 1
  fi
  echo "[INFO] 未检测到满足要求的 Node.js，尝试自动安装…"
  if [[ "$(id -u)" != "0" && "$(uname)" != "Darwin" ]]; then
    echo "[FAIL] 自动安装 Node 需要 root/sudo 权限" >&2
    exit 1
  fi
  if command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    local ver arch
    ver="$(curl -fsSL --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null \
      | grep -o '"v22\.[0-9]*\.[0-9]*"' | head -1 | tr -d '"')"
    [[ -n "$ver" ]] || ver="v22.14.0"
    arch="linux-x64"; [[ "$(uname -m)" = "aarch64" ]] && arch="linux-arm64"
    echo "[INFO] 下载 node-$ver-$arch"
    curl -fsSL "https://nodejs.org/dist/$ver/node-$ver-$arch.tar.xz" -o /tmp/node-install.tar.xz \
      || { echo "[FAIL] Node 下载失败" >&2; exit 1; }
    tar -xJf /tmp/node-install.tar.xz -C /usr/local --strip-components=1 \
      || { echo "[FAIL] Node 解压失败" >&2; exit 1; }
    rm -f /tmp/node-install.tar.xz
  else
    echo "[FAIL] 未能自动安装 Node，请手动安装 https://nodejs.org/" >&2
    exit 1
  fi
  command -v node >/dev/null 2>&1 || { echo "[FAIL] Node 安装后仍不可用，请重开终端再试" >&2; exit 1; }
}

main() {
  ensure_node "$@"
  if is_local_checkout; then
    local root
    root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
    cd "$root"
    exec bash ./scripts/install.sh "$@"
  fi
  acquire || { echo "[FAIL] 源码下载失败，请检查网络与仓库地址" >&2; exit 1; }
  cd "$SRC_DIR"
  exec bash ./scripts/install.sh "$@"
}

main "$@"
