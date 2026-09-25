#!/usr/bin/env bash
# ==============================================================================
# deploy.sh —— Kepler 对象存储管理系统 · 一键部署脚本
#
# 目标：在一台全新的 Linux 服务器上，只执行一条命令即可完成部署：
#   bash deploy.sh --domain cos.example.com
#
# 脚本会依次完成：
#   1) 环境检测（操作系统 / 包管理器 / CPU 架构）+ root 权限与必要命令检查
#   2) 安装运行时（Node.js ≥ 18）与依赖（npm 生产依赖）
#   3) 安装并配置 Nginx 反向代理
#   4) 生成 .env 环境变量文件
#   5) 进程守护：systemd 服务（默认）或 docker compose
#   6) HTTPS：Let's Encrypt 自动签发（失败自动回退自签名证书）
#   7) 健康检查 + 输出访问地址与常用维护命令
#
# 设计约束：
#   - 幂等：可反复执行。已存在且内容一致的文件不重写；配置变更会先备份旧文件。
#   - 只问最基础的信息：域名（必填）、对外 HTTPS 端口、部署方式；其余全部取默认值。
#   - 非交互：所有交互项都可用命令行参数或环境变量传入（见 usage）。
#
# 用法：
#   bash deploy.sh --domain cos.example.com [选项]
#   curl -fsSL <raw-url>/deploy.sh | bash -s -- --domain cos.example.com
#
# 选项：
#   --domain <域名|IP>      部署域名或服务器 IP（必填；IP 时只能自签名证书）
#   --port <端口>           应用内部监听端口（默认 3000，由 Nginx 反代，不对外暴露）
#   --https-port <端口>     Nginx 对外 HTTPS 端口（默认 443）
#   --http-port <端口>      Nginx 对外 HTTP 端口（默认 80，用于跳转与 ACME 校验）
#   --dir <路径>            安装目录（默认 /opt/kepler）
#   --data-dir <路径>       数据目录（默认 <安装目录>/data；含密钥，务必备份）
#   --mode <systemd|docker> 进程守护方式（默认 systemd）
#   --tls <auto|letsencrypt|selfsigned|none>  证书方式（默认 auto）
#   --email <邮箱>          Let's Encrypt 通知邮箱（默认 admin@<域名>）
#   --path <路径>           服务路径前缀（默认 /，推荐根路径；子路径为尽力而为模式）
#   --repo <git-url>        脚本独立运行时用于拉取源码的仓库地址
#   --node-version <版本>   指定 Node.js 版本（默认解析最新的 20.x LTS）
#   --mirror <auto|cn|official> 下载镜像：cn 走 npmmirror 加速；auto 先走官方源，失败自动改走国内
#   --staging               使用 Let's Encrypt 测试环境（避免正式证书频次限制）
#   -y, --yes               非交互模式：全部使用默认值（域名仍需提供）
#   --verbose               显示子命令的完整输出（默认只写日志文件）
#   --uninstall             卸载服务与 Nginx 配置（保留数据目录）
#   -h, --help              显示帮助
#
# 环境变量（与命令行参数等价，参数优先级更高）：
#   DOMAIN APP_PORT HTTPS_PORT HTTP_PORT INSTALL_DIR DATA_DIR MODE TLS_MODE
#   EMAIL SUB_PATH REPO_URL NODE_VERSION MIRROR STAGING ASSUME_YES VERBOSE
# ==============================================================================

set -Eeuo pipefail

# ------------------------------------------------------------------------------
# 0. 基础设置与日志工具
# ------------------------------------------------------------------------------
readonly SCRIPT_NAME="deploy.sh"
readonly SERVICE_NAME="kepler"
readonly RUN_USER="kepler"
readonly LOG_FILE="/var/log/${SERVICE_NAME}-deploy.log"
readonly WEBROOT="/var/www/html"
readonly LOCK_FILE="/var/lock/${SERVICE_NAME}-deploy.lock"

STEP_NO=0
VERBOSE="${VERBOSE:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
INIT_SYSTEM=""
NGINX_CONF=""
NGINX_LINK=""

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'; C_CYAN=$'\033[36m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_CYAN=""
fi

log()  { printf '%s\n' "$*"; }
info() { printf '%s[信息]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[完成]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[警告]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
err()  { printf '%s[错误]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; err "部署中断。详细日志：${LOG_FILE}"; exit 1; }
step() { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%s/%s]%s %s%s%s\n' "$C_BLUE" "$STEP_NO" "$TOTAL_STEPS" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }

# 执行子命令：正常输出写日志，失败时回显尾部日志并返回真实退出码
run() {
  local rc=0
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
  if [[ "$VERBOSE" == "1" ]]; then
    "$@" 2>&1 | tee -a "$LOG_FILE" || rc=${PIPESTATUS[0]}
  else
    "$@" >>"$LOG_FILE" 2>&1 || rc=$?
  fi
  if ((rc != 0)); then
    err "命令执行失败（退出码 ${rc}）：$*"
    err "—— 日志尾部（${LOG_FILE}）——"
    tail -n 30 "$LOG_FILE" >&2 || true
  fi
  return "$rc"
}

# 执行子命令：允许失败（返回码被忽略），输出写日志
run_soft() {
  if [[ "$VERBOSE" == "1" ]]; then
    "$@" 2>&1 | tee -a "$LOG_FILE" || true
  else
    "$@" >>"$LOG_FILE" 2>&1 || true
  fi
}

have() { command -v "$1" >/dev/null 2>&1; }

# 版本比较：version_ge 20.19.0 18 → 0（真）。纯 bash 实现，不依赖 sort -V
version_ge() {
  local a="$1" b="$2" i x y
  local -a A B
  IFS='.' read -r -a A <<<"$a"
  IFS='.' read -r -a B <<<"$b"
  for i in 0 1 2; do
    x="${A[i]:-0}"; y="${B[i]:-0}"
    [[ "$x" =~ ^[0-9]+$ ]] || x=0
    [[ "$y" =~ ^[0-9]+$ ]] || y=0
    ((10#$x > 10#$y)) && return 0
    ((10#$x < 10#$y)) && return 1
  done
  return 0
}

# 写文件（内容相同则跳过，已存在且不同则先备份）——保证幂等
write_file() {
  local path="$1" content="$2" mode="${3:-0644}"
  local dir; dir="$(dirname "$path")"
  mkdir -p "$dir"
  if [[ -f "$path" ]] && [[ "$(cat "$path")" == "$content" ]]; then
    info "配置未变化，跳过写入：$path"
    chmod "$mode" "$path"
    return 0
  fi
  if [[ -f "$path" ]]; then
    local bak="${path}.bak.$(date +%Y%m%d%H%M%S)"
    cp -a "$path" "$bak"
    info "已备份旧配置 → $bak"
  fi
  printf '%s\n' "$content" > "$path"
  chmod "$mode" "$path"
  ok "已写入：$path"
}

on_error() {
  local rc=$1 line=$2
  err "第 ${line} 行执行失败（退出码 ${rc}）。"
  err "详细日志：${LOG_FILE}"
  exit "$rc"
}
trap 'on_error "$?" "$LINENO"' ERR

# ------------------------------------------------------------------------------
# 1. 参数与默认值
# ------------------------------------------------------------------------------
DOMAIN="${DOMAIN:-}"
APP_PORT="${APP_PORT:-3000}"
HTTPS_PORT="${HTTPS_PORT:-443}"
HTTP_PORT="${HTTP_PORT:-80}"
INSTALL_DIR="${INSTALL_DIR:-/opt/kepler}"
DATA_DIR="${DATA_DIR:-}"
MODE="${MODE:-systemd}"
TLS_MODE="${TLS_MODE:-auto}"
EMAIL="${EMAIL:-}"
SUB_PATH="${SUB_PATH:-/}"
REPO_URL="${REPO_URL:-https://github.com/xingsem2005/bucket-manager.git}"
NODE_VERSION="${NODE_VERSION:-}"
MIRROR="${MIRROR:-auto}"
STAGING="${STAGING:-0}"
UNINSTALL=0
SRC_DIR=""          # 源码来源目录（自动探测）
SRC_TMP_DIR=""      # 若源码来自临时克隆，复制完成后清理
APP_VERSION="1.0.0"
NODE_BIN=""

usage() { sed -n '2,49p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain)       DOMAIN="${2:-}"; shift 2 ;;
      --port)         APP_PORT="${2:-}"; shift 2 ;;
      --https-port)   HTTPS_PORT="${2:-}"; shift 2 ;;
      --http-port)    HTTP_PORT="${2:-}"; shift 2 ;;
      --dir)          INSTALL_DIR="${2:-}"; shift 2 ;;
      --data-dir)     DATA_DIR="${2:-}"; shift 2 ;;
      --mode)         MODE="${2:-}"; shift 2 ;;
      --tls)          TLS_MODE="${2:-}"; shift 2 ;;
      --email)        EMAIL="${2:-}"; shift 2 ;;
      --path)         SUB_PATH="${2:-}"; shift 2 ;;
      --repo)         REPO_URL="${2:-}"; shift 2 ;;
      --node-version) NODE_VERSION="${2:-}"; shift 2 ;;
      --mirror)       MIRROR="${2:-}"; shift 2 ;;
      --staging)      STAGING=1; shift ;;
      -y|--yes)       ASSUME_YES=1; shift ;;
      --verbose)      VERBOSE=1; shift ;;
      --uninstall)    UNINSTALL=1; shift ;;
      -h|--help)      usage ;;
      *)              die "未知参数：$1（使用 --help 查看用法）" ;;
    esac
  done
}
parse_args "$@"

# ------------------------------------------------------------------------------
# 2. 前置检查：root、锁、必要命令、操作系统与包管理器
# ------------------------------------------------------------------------------
detect_env() {
  [[ "$(id -u)" -eq 0 ]] || die "请以 root 身份运行：sudo bash ${SCRIPT_NAME} --domain <域名>"

  mkdir -p "$(dirname "$LOG_FILE")"
  : >>"$LOG_FILE" || die "无法写入日志文件 ${LOG_FILE}"
  chmod 0600 "$LOG_FILE"
  info "详细日志：${LOG_FILE}"

  # 单实例锁，避免并发执行互相踩踏
  mkdir -p "$(dirname "$LOCK_FILE")"
  if ! (set -o noclobber; printf '%s\n' "$$" > "$LOCK_FILE") 2>/dev/null; then
    die "检测到另一个部署进程正在运行（锁文件 ${LOCK_FILE}）。若确认已退出，请删除该锁文件后重试。"
  fi
  trap 'rm -f "$LOCK_FILE"' EXIT

  for cmd in curl tar sed awk grep mktemp date head tail mkdir id chmod; do
    have "$cmd" || die "缺少必要命令：$cmd"
  done

  OS_ID=""; OS_LIKE=""; OS_NAME="unknown"; PM=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"; OS_NAME="${PRETTY_NAME:-${OS_ID}}"
  fi
  if   have apt-get; then PM="apt"
  elif have dnf;      then PM="dnf"
  elif have yum;      then PM="yum"
  elif have apk;      then PM="apk"
  elif have zypper;   then PM="zypper"
  fi
  [[ -n "$PM" ]] || die "未能识别包管理器（未找到 apt-get/dnf/yum/apk/zypper）。本脚本支持 Debian/Ubuntu、RHEL/CentOS/Rocky/Alma、Alpine、openSUSE。"

  ARCH_RAW="$(uname -m)"
  case "$ARCH_RAW" in
    x86_64|amd64) NODE_ARCH="x64" ;;
    aarch64|arm64) NODE_ARCH="arm64" ;;
    armv7l) NODE_ARCH="armv7l" ;;
    *) die "不支持的 CPU 架构：${ARCH_RAW}" ;;
  esac

  INIT_SYSTEM="unknown"
  if [[ -d /run/systemd/system ]] && have systemctl; then INIT_SYSTEM="systemd"; fi

  ok "操作系统：${OS_NAME}"
  ok "包管理器：${PM} ｜ 架构：${ARCH_RAW} ｜ 初始化系统：${INIT_SYSTEM}"
}

pkg_install() {
  local pkgs=("$@")
  [[ ${#pkgs[@]} -gt 0 ]] || return 0
  info "安装软件包：${pkgs[*]}"
  case "$PM" in
    apt)
      run_soft bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq'
      run bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs[*]}" ;;
    dnf|yum)
      run "$PM" install -y "${pkgs[@]}" ;;
    apk)
      run apk add --no-cache "${pkgs[@]}" ;;
    zypper)
      run zypper --non-interactive install "${pkgs[@]}" ;;
  esac
}

need_pkgs_base() {
  local to_install=()
  for c in ca-certificates tar gzip; do
    have "$c" || to_install+=("$c")
  done
  ((${#to_install[@]})) && pkg_install "${to_install[@]}" || true
  return 0
}

# ------------------------------------------------------------------------------
# 3. 交互采集（只在缺少参数且是终端时提问）
# ------------------------------------------------------------------------------
ask() {
  # ask <变量名> <提示> <默认值>
  local var="$1" prompt="$2" default="${3:-}" answer=""
  if [[ "$ASSUME_YES" == "1" || ! -t 0 ]]; then
    printf -v "$var" '%s' "$default"
    return 0
  fi
  read -r -p "$(printf '%s%s%s [%s]: ' "$C_BOLD" "$prompt" "$C_RESET" "$default")" answer || true
  printf -v "$var" '%s' "${answer:-$default}"
}

is_ip_addr() {
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || [[ "$1" == *:* ]]
}

is_valid_domain() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]
}

collect_config() {
  # 域名（必填）
  if [[ -z "$DOMAIN" ]]; then
    [[ -t 0 ]] || die "未指定部署域名：非交互环境请用 --domain <域名> 传入（或设置环境变量 DOMAIN）。"
    while true; do
      read -r -p "$(printf '%s部署域名或公网 IP（必填，如 cos.example.com）%s: ' "$C_BOLD" "$C_RESET")" DOMAIN \
        || die "无法读取输入，请用 --domain <域名> 指定。"
      DOMAIN="${DOMAIN// /}"
      [[ -n "$DOMAIN" ]] || { warn "域名不能为空，请重新输入。"; continue; }
      break
    done
  fi
  DOMAIN="${DOMAIN,,}"
  DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"
  DOMAIN="${DOMAIN%%/*}"
  if ! is_valid_domain "$DOMAIN" && ! is_ip_addr "$DOMAIN"; then
    die "域名格式不合法：$DOMAIN"
  fi

  # 其余项：有默认值，回车即用默认
  ask HTTPS_PORT "Nginx 对外 HTTPS 端口" "$HTTPS_PORT"
  ask HTTP_PORT  "Nginx 对外 HTTP 端口（用于跳转与证书校验）" "$HTTP_PORT"
  ask APP_PORT   "应用内部监听端口（由 Nginx 反代，不直接对外）" "$APP_PORT"
  ask MODE       "进程守护方式（systemd / docker）" "$MODE"
  ask INSTALL_DIR "安装目录" "$INSTALL_DIR"

  MODE="${MODE,,}"
  [[ "$MODE" == "systemd" || "$MODE" == "docker" || "$MODE" == "compose" ]] || die "MODE 只支持 systemd 或 docker，当前：$MODE"
  [[ "$MODE" == "compose" ]] && MODE="docker"
  for p in "$APP_PORT" "$HTTP_PORT" "$HTTPS_PORT"; do
    [[ "$p" =~ ^[0-9]+$ ]] && ((p >= 1 && p <= 65535)) || die "端口不合法：$p"
  done
  # 内部端口不能与 Nginx 对外端口冲突（否则 Nginx 抢不到端口）
  if [[ "$APP_PORT" == "$HTTP_PORT" || "$APP_PORT" == "$HTTPS_PORT" ]]; then
    die "应用内部端口（${APP_PORT}）不能与 Nginx 对外端口（${HTTP_PORT}/${HTTPS_PORT}）相同。"
  fi
  # 应用自身还会占用 3443（内置 HTTPS）与 8443（WebDAV），内部端口不要撞上
  if [[ "$APP_PORT" == "3443" ]]; then
    die "应用内部端口不能是 3443（应用内置 HTTPS 端口）。"
  fi
  if [[ "$HTTPS_PORT" == "8443" ]]; then
    warn "对外 HTTPS 端口 8443 与应用内置 WebDAV 默认端口相同，开启 WebDAV 后会冲突（可用 WEBDAV_PORT 环境变量改端口）。"
  fi
  [[ "$DATA_DIR" ]] || DATA_DIR="${INSTALL_DIR}/data"
  [[ "$EMAIL" ]] || EMAIL="admin@${DOMAIN}"
  # 归一化服务路径：空 → /；其它 → 去掉首尾多余的斜杠
  SUB_PATH="${SUB_PATH:-/}"
  if [[ "$SUB_PATH" != "/" ]]; then
    SUB_PATH="/${SUB_PATH#/}"
    SUB_PATH="${SUB_PATH%/}"
    [[ -n "$SUB_PATH" ]] || SUB_PATH="/"
  fi

  TLS_MODE="${TLS_MODE,,}"
  case "$TLS_MODE" in
    auto|letsencrypt|le|selfsigned|self|none) : ;;
    *) die "TLS 方式不合法：$TLS_MODE（可选 auto/letsencrypt/selfsigned/none）" ;;
  esac
  [[ "$TLS_MODE" == "le" ]] && TLS_MODE="letsencrypt"
  [[ "$TLS_MODE" == "self" ]] && TLS_MODE="selfsigned"
  if is_ip_addr "$DOMAIN" && [[ "$TLS_MODE" == "letsencrypt" ]]; then
    warn "IP 地址无法签发 Let's Encrypt 证书，已切换为自签名证书。"
    TLS_MODE="selfsigned"
  fi

  log ""
  log "${C_BOLD}部署参数确认${C_RESET}"
  log "  域名          : ${DOMAIN}"
  log "  访问地址      : https://${DOMAIN}$([[ "$HTTPS_PORT" == "443" ]] && echo "" || echo ":$HTTPS_PORT")${SUB_PATH}"
  log "  部署方式      : ${MODE}"
  log "  安装目录      : ${INSTALL_DIR}"
  log "  数据目录      : ${DATA_DIR}"
  log "  内部端口      : ${APP_PORT}"
  log "  证书方式      : ${TLS_MODE}$([[ "$TLS_MODE" == "auto" || "$TLS_MODE" == "letsencrypt" ]] && echo "（Let's Encrypt，失败自动回退自签名）")"
  log ""
}

# ------------------------------------------------------------------------------
# 4. 安装 Node.js
# ------------------------------------------------------------------------------
resolve_node_version() {
  if [[ -n "$NODE_VERSION" ]]; then printf '%s' "${NODE_VERSION#v}"; return 0; fi
  local v=""
  v="$(curl -fsSL --max-time 15 https://nodejs.org/dist/index.json 2>/dev/null \
        | grep -o '"version":"v20\.[0-9.]*"' | head -n1 | sed 's/.*:"v//;s/"//' || true)"
  [[ -n "$v" ]] && { printf '%s' "$v"; return 0; }
  printf '%s' "20.19.0"   # 兜底：确定存在的 LTS 版本
}

node_tarball_base() {
  if [[ "$MIRROR" == "cn" ]]; then printf '%s' "https://registry.npmmirror.com/-/binary/node"; else printf '%s' "https://nodejs.org/dist"; fi
}

install_node() {
  local required="18"
  NODE_BIN="$(command -v node || true)"
  if [[ -n "$NODE_BIN" ]]; then
    local cur; cur="$("$NODE_BIN" -v | sed 's/^v//')"
    if version_ge "$cur" "$required"; then
      ok "Node.js 已安装：v${cur}（$NODE_BIN）"
      return 0
    fi
    info "已安装 Node.js v${cur}，低于要求 v${required}，将升级。"
  fi

  # 4.1 优先尝试系统包
  info "尝试通过 ${PM} 安装 Node.js…"
  case "$PM" in
    apt) run_soft bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm' ;;
    dnf|yum) run_soft "$PM" install -y nodejs npm ;;
    apk) run_soft apk add --no-cache nodejs npm ;;
    zypper) run_soft zypper --non-interactive install nodejs npm ;;
  esac
  NODE_BIN="$(command -v node || true)"
  if [[ -n "$NODE_BIN" ]] && version_ge "$("$NODE_BIN" -v | sed 's/^v//')" "$required"; then
    ok "Node.js 安装完成：$("$NODE_BIN" -v)"
    return 0
  fi

  # 4.2 NodeSource 仓库（Debian / RHEL 系）
  if [[ "$PM" == "apt" || "$PM" == "dnf" || "$PM" == "yum" ]]; then
    local major="$NODE_VERSION"; [[ -n "$major" ]] || major="20"
    major="${major%%.*}"
    info "尝试 NodeSource 仓库（Node ${major}.x）…"
    if [[ "$PM" == "apt" ]]; then
      run_soft bash -c "curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash -" \
        && run_soft bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs'
    else
      run_soft bash -c "curl -fsSL https://rpm.nodesource.com/setup_${major}.x | bash -" \
        && run_soft "$PM" install -y nodejs
    fi
    NODE_BIN="$(command -v node || true)"
    if [[ -n "$NODE_BIN" ]] && version_ge "$("$NODE_BIN" -v | sed 's/^v//')" "$required"; then
      ok "Node.js 安装完成（NodeSource）：$("$NODE_BIN" -v)"
      return 0
    fi
  fi

  # 4.3 官方二进制包（通用兜底，支持 cn 镜像）
  local ver base url tmp
  ver="$(resolve_node_version)"
  base="$(node_tarball_base)"
  # 用 .tar.gz 而非 .tar.xz：gzip 是标配，部分精简镜像的 tar 不带 xz 支持
  url="${base}/v${ver}/node-v${ver}-linux-${NODE_ARCH}.tar.gz"
  info "下载 Node.js v${ver}（${url}）…"
  tmp="$(mktemp -d)"
  if ! run curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "${tmp}/node.tar.gz" "$url"; then
    if [[ "$MIRROR" != "cn" ]]; then
      warn "官方源下载失败，改用国内镜像重试…"
      url="https://registry.npmmirror.com/-/binary/node/v${ver}/node-v${ver}-linux-${NODE_ARCH}.tar.gz"
      run curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "${tmp}/node.tar.gz" "$url"
    else
      die "Node.js 下载失败：${url}"
    fi
  fi
  run tar -xzf "${tmp}/node.tar.gz" -C /usr/local --strip-components=1
  rm -rf "$tmp"
  if have ldconfig; then run_soft ldconfig; fi
  NODE_BIN="$(command -v node || true)"
  [[ -n "$NODE_BIN" ]] && version_ge "$("$NODE_BIN" -v | sed 's/^v//')" "$required" \
    || die "Node.js 安装失败，请手动安装 v${required}+ 后重跑本脚本。"
  ok "Node.js 安装完成（二进制包）：$("$NODE_BIN" -v) → ${NODE_BIN}"
}

npm_registry_args() {
  if [[ "$MIRROR" == "cn" ]]; then printf '%s' "--registry=https://registry.npmmirror.com"; fi
}

# ------------------------------------------------------------------------------
# 5. 部署源码
# ------------------------------------------------------------------------------
prepare_source() {
  local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "${script_dir}/package.json" && -d "${script_dir}/server" ]]; then
    SRC_DIR="$script_dir"
    info "检测到本地源码目录：${SRC_DIR}"
    return 0
  fi
  # 独立运行（如 curl ... | bash）：克隆仓库
  have git || pkg_install git
  local tmp; tmp="$(mktemp -d)"
  info "未发现本地源码，从仓库拉取：${REPO_URL}"
  if ! run git clone --depth 1 "$REPO_URL" "${tmp}/src"; then
    rm -rf "$tmp"
    die "源码拉取失败。可先将项目上传至服务器，再在该目录内执行本脚本；或用 --repo 指定可访问的仓库地址。"
  fi
  SRC_DIR="${tmp}/src"
  SRC_TMP_DIR="$tmp"   # 复制完成后清理
}

install_app() {
  mkdir -p "$INSTALL_DIR" "$DATA_DIR"
  info "同步源码 → ${INSTALL_DIR}（排除 data/node_modules/.git，绝不覆盖数据目录）"
  # tar 管道复制：每次覆盖同名文件，保持幂等（重复执行即升级）
  if ! run bash -c "cd '$SRC_DIR' && tar --exclude=./data --exclude=./node_modules --exclude=./.git --exclude=./.deploy.conf -cf - . | tar -xf - -C '$INSTALL_DIR'"; then
    warn "tar 同步失败（可能是 busybox tar 不支持 --exclude），改用逐项复制…"
    for item in package.json package-lock.json server public scripts Dockerfile; do
      [[ -e "${SRC_DIR}/${item}" ]] || continue
      run cp -a "${SRC_DIR}/${item}" "${INSTALL_DIR}/"
    done
  fi
  if [[ -f "${INSTALL_DIR}/package.json" ]]; then
    APP_VERSION="$(grep -m1 '"version"' "${INSTALL_DIR}/package.json" | sed 's/.*: *"//;s/".*//')"
  else
    warn "安装目录中未找到 package.json，请确认源码同步是否完整。"
  fi
  if [[ -n "$SRC_TMP_DIR" ]]; then rm -rf "$SRC_TMP_DIR"; fi
  ok "源码已部署：${INSTALL_DIR}（版本 ${APP_VERSION}）"
}

npm_install_deps() {
  info "安装生产依赖（npm ci --omit=dev）…"
  if ! run bash -c "cd '$INSTALL_DIR' && npm ci --omit=dev --no-audit --no-fund $(npm_registry_args)"; then
    warn "npm ci 失败（可能缺少 package-lock.json 或网络受限），尝试 npm install…"
    if ! run bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund $(npm_registry_args)"; then
      if [[ "$MIRROR" != "cn" ]]; then
        warn "默认 registry 安装失败，改用国内镜像重试…"
        run bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com"
      else
        die "依赖安装失败，请检查网络后重跑本脚本。"
      fi
    fi
  fi
  ok "依赖安装完成"
}

# ------------------------------------------------------------------------------
# 6. 运行用户与环境变量文件
# ------------------------------------------------------------------------------
create_user() {
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    info "系统用户 ${RUN_USER} 已存在，跳过创建"
  else
    if have useradd; then
      run useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER"
    else
      run adduser -S -D -H -s /sbin/nologin "$RUN_USER"
    fi
    ok "已创建系统用户：${RUN_USER}"
  fi
}

gen_env_file() {
  local env_path="${INSTALL_DIR}/.env"
  local port="$APP_PORT" data_dir="$DATA_DIR"
  if [[ "$MODE" == "docker" ]]; then
    port=3000          # 容器内固定监听 3000，宿主机端口由 compose 映射
    data_dir="/app/data"
  fi
  local content
  # 注：本文件内容不含时间戳 —— 保证重复执行时判定为「未变化」，不产生无意义备份
  content="# Kepler 运行环境（由 ${SCRIPT_NAME} 生成）
# 修改后执行：systemctl restart ${SERVICE_NAME}（docker 方式：docker compose restart）
NODE_ENV=production
HOST=0.0.0.0
PORT=${port}
HTTPS_PORT=3443
WEBDAV_PORT=8443
# 数据目录：保存加密主密钥、账户、配置与统计，务必定期备份
COS_DATA_DIR=${data_dir}
# 位于 Nginx 之后：信任 X-Forwarded-*，使「部署模式」下的 HTTPS 判定正确
TRUST_PROXY=1
# 注：应用遇到未捕获异常会主动退出，由进程管理器（systemd Restart=always /
# docker restart: unless-stopped）负责拉起，无需额外配置。"
  write_file "$env_path" "$content" 0640
  if [[ "$MODE" == "systemd" ]]; then
    chown "root:${RUN_USER}" "$env_path" 2>/dev/null || true
  fi
}

# ------------------------------------------------------------------------------
# 7. Nginx
# ------------------------------------------------------------------------------
install_nginx() {
  if have nginx; then
    ok "Nginx 已安装：$(nginx -v 2>&1 | sed 's/.*nginx\///')"
  else
    info "安装 Nginx…"
    pkg_install nginx
    if ! have nginx && [[ "$PM" == "dnf" || "$PM" == "yum" ]]; then
      # RHEL 系的 nginx 在 EPEL 源里
      info "未找到 nginx，尝试启用 EPEL 源后重试…"
      run_soft "$PM" install -y epel-release
      pkg_install nginx
    fi
    have nginx || die "Nginx 安装失败（可手动安装 Nginx 后重跑本脚本）。"
    ok "Nginx 安装完成"
  fi
  mkdir -p "$WEBROOT/.well-known/acme-challenge"
  # Debian 系用 sites-available/sites-enabled，RHEL 系用 conf.d
  if [[ -d /etc/nginx/sites-enabled ]]; then
    NGINX_CONF="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
    NGINX_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  else
    NGINX_CONF="/etc/nginx/conf.d/${SERVICE_NAME}.conf"
    NGINX_LINK=""
  fi
}

nginx_http2_directive() {
  # nginx ≥ 1.25.1 使用独立指令 http2 on; 旧版本写在 listen 行内
  local v; v="$(nginx -v 2>&1 | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+' | head -n1)"
  if [[ -n "$v" ]] && version_ge "$v" "1.25.1"; then printf 'http2 on;'; else printf ''; fi
}

write_nginx_conf() {
  local with_tls="$1" cert_fullchain="$2" cert_key="$3"
  # HTTP/2 写法随版本不同：≥1.25.1 用独立指令，旧版本写在 listen 行内
  local h2; h2="$(nginx_http2_directive)"
  local listen_tls
  if [[ -n "$h2" ]]; then listen_tls="listen ${HTTPS_PORT} ssl;"; else listen_tls="listen ${HTTPS_PORT} ssl http2;"; fi
  local ipv6=""
  if [[ -f /proc/net/if_inet6 ]]; then
    if [[ -n "$h2" ]]; then ipv6="listen [::]:${HTTPS_PORT} ssl;"; else ipv6="listen [::]:${HTTPS_PORT} ssl http2;"; fi
  fi

  # —— 反代片段：所有 location 共用 ——
  local proxy_snippet
  proxy_snippet="        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Requested-With \$http_x_requested_with;
        proxy_connect_timeout 60s;
        proxy_send_timeout 3600s;
        proxy_read_timeout 3600s;
        proxy_buffering off;            # 大文件下载/上传必须关闭缓冲，避免整文件落内存
        proxy_request_buffering off;
        proxy_hide_header Strict-Transport-Security;"

  local acme_block="    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type \"text/plain\";
    }"

  local http_server="server {
    listen ${HTTP_PORT};
    server_name __DOMAIN__;

${acme_block}

    # 未启用 HTTPS 时直接提供反代；启用后改为 301 跳转
__HTTP_LOCATION__
}"

  local http_location
  if [[ "$with_tls" == "1" ]]; then
    http_location="    location / { return 301 https://\$host__EXT_PORT__\$request_uri; }"
  else
    http_location="    location / {
        proxy_pass http://127.0.0.1:__APP_PORT__;
${proxy_snippet}
    }"
  fi

  local content="$http_server"

  if [[ "$with_tls" == "1" ]]; then
    local root_loc
    if [[ "$SUB_PATH" == "/" ]]; then
      root_loc="    location / {
        proxy_pass http://127.0.0.1:__APP_PORT__;
${proxy_snippet}
    }"
    else
      # 子路径（尽力而为）：前端资源相对路径可用，但前端对 /api、/s 使用绝对路径，
      # 因此额外在根路径上补这两段反代；分享链接仍会以根路径生成，建议尽量用独立域名。
      root_loc="    location = / { return 302 https://\$host__EXT_PORT____SUB_PATH__/; }
    location ^~ /api/ {
        proxy_pass http://127.0.0.1:__APP_PORT__;
${proxy_snippet}
    }
    location ^~ /s/ {
        proxy_pass http://127.0.0.1:__APP_PORT__;
${proxy_snippet}
    }
    location __SUB_PATH__/ {
        proxy_pass http://127.0.0.1:__APP_PORT__/;
${proxy_snippet}
    }"
    fi

    content="${content}

server {
    ${listen_tls}
    ${ipv6}
    ${h2}
    server_name __DOMAIN__;

    ssl_certificate     ${cert_fullchain};
    ssl_certificate_key ${cert_key};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:KeplerSSL:10m;
    ssl_session_timeout 1d;

    add_header Strict-Transport-Security \"max-age=31536000; includeSubDomains\" always;
    add_header X-Content-Type-Options nosniff always;

    # 上传大文件：交由应用自身分片，此处不做体积限制
    client_max_body_size 0;
    # 反代超时放宽，避免大文件列举/打包下载被中途掐断
    keepalive_timeout 65s;

${acme_block}

${root_loc}

    # 可选：WebDAV（应用内开启后，取消注释并把 8443 放行到 Nginx）
    # location ^~ /dav/ {
    #     proxy_pass https://127.0.0.1:8443;
    #     proxy_ssl_verify off;
    #     proxy_set_header Host \$host;
    #     proxy_set_header Authorization \$http_authorization;
    #     proxy_buffering off;
    #     proxy_request_buffering off;
    # }
}"
  fi

  content="${content//__HTTP_LOCATION__/$http_location}"
  local ext_port=""; [[ "$HTTPS_PORT" == "443" ]] || ext_port=":${HTTPS_PORT}"
  content="${content//__DOMAIN__/$DOMAIN}"
  content="${content//__APP_PORT__/$APP_PORT}"
  content="${content//__EXT_PORT__/$ext_port}"
  content="${content//__SUB_PATH__/$SUB_PATH}"

  write_file "$NGINX_CONF" "$content" 0644
  if [[ -n "$NGINX_LINK" && ! -e "$NGINX_LINK" ]]; then
    ln -s "$NGINX_CONF" "$NGINX_LINK"
    ok "已启用站点：${NGINX_LINK}"
  fi
}

nginx_apply() {
  if ! nginx -t >>"$LOG_FILE" 2>&1; then
    err "Nginx 配置校验失败："
    nginx -t >&2 || true
    die "请检查 ${NGINX_CONF}"
  fi
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    run systemctl enable nginx
    if systemctl is-active --quiet nginx; then run systemctl reload nginx; else run systemctl start nginx; fi
  else
    run_soft nginx -s reload || run_soft bash -c 'nginx'
    pgrep -x nginx >/dev/null 2>&1 || run_soft bash -c 'nginx'
  fi
  ok "Nginx 已应用配置并运行"
}

# ------------------------------------------------------------------------------
# 8. HTTPS 证书
# ------------------------------------------------------------------------------
SELF_SIGNED_DIR="/etc/${SERVICE_NAME}/ssl"
CERT_FULLCHAIN=""
CERT_KEY=""

gen_self_signed() {
  mkdir -p "$SELF_SIGNED_DIR"
  local key="${SELF_SIGNED_DIR}/privkey.pem" crt="${SELF_SIGNED_DIR}/fullchain.pem"
  if [[ -s "$key" && -s "$crt" ]]; then
    info "已存在自签名证书，复用：${crt}"
  else
    have openssl || pkg_install openssl
    info "生成自签名证书（有效期 825 天）…"
    run openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$key" -out "$crt" -subj "/CN=${DOMAIN}" \
      -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1"
  fi
  chmod 0600 "$key"; chmod 0644 "$crt"
  CERT_FULLCHAIN="$crt"; CERT_KEY="$key"
  ok "自签名证书就绪：${crt}"
}

ensure_certbot() {
  if have certbot; then ok "certbot 已安装：$(certbot --version 2>/dev/null | head -n1)"; return 0; fi
  info "安装 certbot…"
  case "$PM" in
    apt) run_soft bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot' ;;
    dnf|yum)
      run_soft "$PM" install -y epel-release
      run_soft "$PM" install -y certbot ;;
    apk) run_soft apk add --no-cache certbot ;;
    zypper) run_soft zypper --non-interactive install certbot ;;
  esac
  if ! have certbot && have snap; then
    run_soft snap install --classic certbot
    [[ -e /usr/bin/certbot ]] || ln -sf /snap/bin/certbot /usr/bin/certbot 2>/dev/null || true
  fi
  have certbot
}

domain_resolves_here() {
  local ip="" pub=""
  if have getent; then ip="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -n1)"; fi
  [[ -z "$ip" ]] && have dig && ip="$(dig +short A "$DOMAIN" 2>/dev/null | head -n1)"
  [[ -z "$ip" ]] && have nslookup && ip="$(nslookup "$DOMAIN" 2>/dev/null | awk '/^Address: /{print $2}' | tail -n1)"
  [[ -z "$ip" ]] && return 2                     # 无法解析（未知）
  pub="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
  [[ -z "$pub" ]] && pub="$(curl -fsS --max-time 8 http://ifconfig.me 2>/dev/null || true)"
  if [[ -n "$pub" && "$ip" != "$pub" ]]; then
    warn "域名 ${DOMAIN} 解析到 ${ip}，但本机公网 IP 为 ${pub}，Let's Encrypt 校验可能失败。"
    return 1
  fi
  return 0
}

issue_letsencrypt() {
  info "准备通过 Let's Encrypt 签发证书…"
  domain_resolves_here || warn "域名解析检测未通过，仍会尝试签发（HTTP-01 需要 80 端口可被外网访问）。"

  if ! ensure_certbot; then
    warn "certbot 不可用，改用 acme.sh 申请证书…"
    issue_acme_sh
    return $?
  fi

  local args=(certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos
              -m "$EMAIL" --keep-until-expiring --cert-name "$DOMAIN")
  [[ "$STAGING" == "1" ]] && args+=(--staging)
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    args+=(--deploy-hook "systemctl reload nginx")
  else
    args+=(--deploy-hook "nginx -s reload")
  fi

  if ! run certbot "${args[@]}"; then
    warn "Let's Encrypt 签发失败（常见原因：80 端口未放行 / 域名未解析到本机 / 频次限制）。"
    return 1
  fi
  local live="/etc/letsencrypt/live/${DOMAIN}"
  [[ -s "${live}/fullchain.pem" && -s "${live}/privkey.pem" ]] || { warn "证书文件缺失：${live}"; return 1; }
  CERT_FULLCHAIN="${live}/fullchain.pem"; CERT_KEY="${live}/privkey.pem"

  # 自动续期：certbot 包通常自带 timer/cron，这里显式确认一次
  if [[ "$INIT_SYSTEM" == "systemd" ]] && systemctl list-unit-files 2>/dev/null | grep -q 'certbot.timer'; then
    run_soft systemctl enable --now certbot.timer
    ok "已启用 certbot.timer 自动续期"
  else
    if ! grep -rq 'certbot' /etc/crontab /etc/cron.d 2>/dev/null; then
      printf '0 3 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx" >/dev/null 2>&1\n' \
        > "/etc/cron.d/${SERVICE_NAME}-certbot"
      chmod 0644 "/etc/cron.d/${SERVICE_NAME}-certbot"
      ok "已添加每日续期定时任务：/etc/cron.d/${SERVICE_NAME}-certbot"
    fi
  fi
  ok "Let's Encrypt 证书签发成功：${CERT_FULLCHAIN}"
  return 0
}

issue_acme_sh() {
  have curl || return 1
  local acme_home="/root/.acme.sh"
  if [[ ! -s "${acme_home}/acme.sh" ]]; then
    if ! run bash -c "curl -fsSL https://get.acme.sh | sh -s email=${EMAIL}"; then
      warn "acme.sh 安装失败。"
      return 1
    fi
  fi
  local acme="${acme_home}/acme.sh"
  local args=(--issue -d "$DOMAIN" --webroot "$WEBROOT" --keylength 2048)
  [[ "$STAGING" == "1" ]] && args+=(--staging)
  if ! run "$acme" "${args[@]}"; then warn "acme.sh 签发失败。"; return 1; fi
  local dir="${acme_home}/${DOMAIN}"
  [[ -s "${dir}/fullchain.cer" && -s "${dir}/${DOMAIN}.key" ]] || return 1
  CERT_FULLCHAIN="${dir}/fullchain.cer"; CERT_KEY="${dir}/${DOMAIN}.key"
  ok "acme.sh 证书签发成功（已自动注册续期任务）：${CERT_FULLCHAIN}"
  return 0
}

setup_tls() {
  case "$TLS_MODE" in
    none)
      warn "已指定 --tls none：不启用 HTTPS，Nginx 直接以 HTTP 反代（不建议用于公网）。"
      write_nginx_conf 0 "" ""
      nginx_apply
      return 0 ;;
    selfsigned)
      gen_self_signed ;;
    auto|letsencrypt)
      # 先写入「仅 HTTP」配置并启动 Nginx，让 ACME 的 HTTP-01 校验能通过
      write_nginx_conf 0 "" ""
      nginx_apply
      if issue_letsencrypt; then :; else
        warn "回退：改用自签名证书（浏览器会提示不安全，可在网络就绪后重跑本脚本自动升级为 LE 证书）。"
        gen_self_signed
      fi ;;
  esac
  write_nginx_conf 1 "$CERT_FULLCHAIN" "$CERT_KEY"
  nginx_apply
}

# ------------------------------------------------------------------------------
# 9. 进程守护：systemd / docker compose
# ------------------------------------------------------------------------------
setup_systemd_service() {
  [[ "$INIT_SYSTEM" == "systemd" ]] || die "未检测到 systemd。请改用 --mode docker，或在 systemd 环境中运行。"
  chown -R "${RUN_USER}:${RUN_USER}" "$INSTALL_DIR" "$DATA_DIR" 2>/dev/null || true
  chmod 0750 "$DATA_DIR" || true

  local unit="/etc/systemd/system/${SERVICE_NAME}.service"
  # 若安装目录/数据目录位于家目录下，ProtectHome 会把它们变成只读，需要关掉
  local protect_home="ProtectHome=true"
  case "${INSTALL_DIR}${DATA_DIR}" in
    /home/*|/root/*) protect_home="# ProtectHome=true（安装目录位于家目录下，已关闭）" ;;
  esac
  local content="[Unit]
Description=Kepler 对象存储管理系统
Documentation=https://github.com/xingsem2005/bucket-manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} ${INSTALL_DIR}/server/index.js
Restart=always
RestartSec=5
TimeoutStopSec=30
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
${protect_home}
ReadWritePaths=${DATA_DIR} ${INSTALL_DIR}

[Install]
WantedBy=multi-user.target"
  write_file "$unit" "$content" 0644
  run systemctl daemon-reload
  run systemctl enable "$SERVICE_NAME"
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    run systemctl restart "$SERVICE_NAME"
  else
    run systemctl start "$SERVICE_NAME"
  fi
  ok "systemd 服务已启动：${SERVICE_NAME}.service"
}

ensure_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then
    ok "docker 与 compose 插件已就绪"
    return 0
  fi
  if ! have docker; then
    info "安装 Docker…"
    case "$PM" in
      apt) run_soft bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-plugin' ;;
      dnf|yum) run_soft "$PM" install -y docker docker-compose-plugin ;;
      apk) run_soft apk add --no-cache docker docker-cli-compose ;;
      zypper) run_soft zypper --non-interactive install docker docker-compose ;;
    esac
    if ! have docker; then
      info "使用官方脚本安装 Docker…"
      have curl || pkg_install curl
      if [[ "$MIRROR" == "cn" ]]; then
        run_soft bash -c 'curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun'
      else
        run_soft bash -c 'curl -fsSL https://get.docker.com | sh'
      fi
    fi
  fi
  have docker || die "Docker 安装失败。可改用默认方式部署：bash ${SCRIPT_NAME} --domain ${DOMAIN} --mode systemd"
  if ! docker compose version >/dev/null 2>&1; then
    info "安装 docker compose 插件…"
    run_soft "$PM" install -y docker-compose-plugin
    if ! docker compose version >/dev/null 2>&1; then
      local plugin_dir="/usr/local/lib/docker/cli-plugins"
      mkdir -p "$plugin_dir"
      run curl -fsSL --retry 3 --max-time 300 \
        -o "${plugin_dir}/docker-compose" \
        "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH_RAW}"
      chmod +x "${plugin_dir}/docker-compose"
    fi
  fi
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    run_soft systemctl enable --now docker
  else
    run_soft bash -c 'service docker start || true'
  fi
  docker compose version >/dev/null 2>&1 || die "docker compose 不可用。"
  ok "Docker 环境就绪：$(docker compose version --short 2>/dev/null || echo compose)"
}

setup_docker_service() {
  ensure_docker
  local compose_file="${INSTALL_DIR}/docker-compose.yml"
  local content="# 由 ${SCRIPT_NAME} 生成 —— 数据目录挂载保存密钥与配置，切勿删除
services:
  ${SERVICE_NAME}:
    build:
      context: .
      dockerfile: Dockerfile
    image: ${SERVICE_NAME}:${APP_VERSION}
    container_name: ${SERVICE_NAME}
    restart: unless-stopped
    env_file:
      - .env
    volumes:
      # 宿主数据目录 → 容器内 /app/data（密钥与配置所在，切勿删除）
      - ${DATA_DIR}:/app/data
    ports:
      # 只绑定回环地址，外部访问一律经 Nginx 反代
      - \"127.0.0.1:${APP_PORT}:3000\"
    logging:
      driver: json-file
      options:
        max-size: \"20m\"
        max-file: \"5\""
  write_file "$compose_file" "$content" 0644

  # 容器内以 uid/gid 1000（node 用户）运行，宿主数据目录需对齐权限，否则无法写入
  mkdir -p "$DATA_DIR"
  run_soft chown -R 1000:1000 "$DATA_DIR"
  chmod 0770 "$DATA_DIR" || true

  info "构建镜像并启动容器（首次稍慢）…"
  if ! run bash -c "cd '$INSTALL_DIR' && docker compose up -d --build"; then
    die "容器启动失败，查看日志：cd ${INSTALL_DIR} && docker compose logs --tail=100"
  fi

  # 开机自启：docker 自带 restart 策略，再用 systemd 兜底拉起 compose
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    local unit="/etc/systemd/system/${SERVICE_NAME}-docker.service"
    write_file "$unit" "[Unit]
Description=Kepler (docker compose)
Requires=docker.service
After=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(command -v docker) compose up -d
ExecStop=$(command -v docker) compose down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target" 0644
    run systemctl daemon-reload
    run systemctl enable "${SERVICE_NAME}-docker"
  fi
  ok "docker compose 已启动：${INSTALL_DIR}/docker-compose.yml"
}

# ------------------------------------------------------------------------------
# 10. 防火墙（尽力而为，失败不影响部署）
# ------------------------------------------------------------------------------
setup_firewall() {
  if have ufw && ufw status 2>/dev/null | grep -qi '^Status: active'; then
    run_soft ufw allow "${HTTP_PORT}/tcp"
    run_soft ufw allow "${HTTPS_PORT}/tcp"
    ok "ufw 已放行 ${HTTP_PORT}/${HTTPS_PORT}"
  elif have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_soft firewall-cmd --permanent --add-port="${HTTP_PORT}/tcp"
    run_soft firewall-cmd --permanent --add-port="${HTTPS_PORT}/tcp"
    run_soft firewall-cmd --reload
    ok "firewalld 已放行 ${HTTP_PORT}/${HTTPS_PORT}"
  else
    info "未发现启用中的 ufw/firewalld，请自行确认云安全组已放行 ${HTTP_PORT}、${HTTPS_PORT} 端口。"
  fi
}

# ------------------------------------------------------------------------------
# 11. 健康检查
# ------------------------------------------------------------------------------
wait_for_service() {
  local url="http://127.0.0.1:${APP_PORT}/"
  local i code
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$code" == "200" || "$code" == "302" || "$code" == "301" ]]; then
      ok "应用已就绪（本地 ${url} 返回 ${code}）"
      return 0
    fi
    sleep 1
  done
  warn "30 秒内未探测到本地服务（${url}）。请查看日志排查："
  if [[ "$MODE" == "systemd" ]]; then
    warn "  journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
  else
    warn "  cd ${INSTALL_DIR} && docker compose logs --tail=100"
  fi
  return 0
}

external_check() {
  local scheme="https"; [[ "$TLS_MODE" == "none" ]] && scheme="http"
  local port_part=""; [[ ("$scheme" == "https" && "$HTTPS_PORT" != "443") || ("$scheme" == "http" && "$HTTP_PORT" != "80") ]] \
    && port_part=":$( [[ "$scheme" == "https" ]] && echo "$HTTPS_PORT" || echo "$HTTP_PORT" )"
  local url="${scheme}://${DOMAIN}${port_part}${SUB_PATH}"
  local code
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -k "$url" 2>/dev/null || echo "000")"
  if [[ "$code" == "200" || "$code" == "301" || "$code" == "302" ]]; then
    ok "外网访问探测成功：${url}（HTTP ${code}）"
  else
    warn "外网探测未通过（${url}，HTTP ${code}）。常见原因：DNS 未生效、云安全组未放行端口、Nginx 未监听。"
  fi
}

# ------------------------------------------------------------------------------
# 12. 卸载
# ------------------------------------------------------------------------------
do_uninstall() {
  local ans=""
  warn "即将停止服务并移除 Nginx 配置（数据目录 ${DATA_DIR:-${INSTALL_DIR}/data} 会保留）。"
  if [[ "$ASSUME_YES" != "1" && -t 0 ]]; then
    read -r -p "确认卸载？输入 yes 继续: " ans || true
    [[ "$ans" == "yes" ]] || { log "已取消。"; exit 0; }
  fi
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    run_soft systemctl stop "${SERVICE_NAME}"
    run_soft systemctl disable "${SERVICE_NAME}"
    run_soft systemctl stop "${SERVICE_NAME}-docker"
    run_soft systemctl disable "${SERVICE_NAME}-docker"
    rm -f "/etc/systemd/system/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}-docker.service"
    run_soft systemctl daemon-reload
  fi
  if have docker; then run_soft bash -c "cd '${INSTALL_DIR}' && docker compose down"; fi
  local conf="/etc/nginx/conf.d/${SERVICE_NAME}.conf" link="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  rm -f "$conf" "$link" "/etc/nginx/sites-available/${SERVICE_NAME}.conf"
  if have nginx; then run_soft nginx -s reload; fi
  ok "卸载完成。安装目录 ${INSTALL_DIR} 与数据已保留，可手工删除。"
}

# ------------------------------------------------------------------------------
# 13. 主流程
# ------------------------------------------------------------------------------
TOTAL_STEPS=9

print_summary() {
  local scheme="https"; [[ "$TLS_MODE" == "none" ]] && scheme="http"
  local ext_port="$HTTPS_PORT"; [[ "$scheme" == "http" ]] && ext_port="$HTTP_PORT"
  local port_part=""; [[ ("$scheme" == "https" && "$ext_port" != "443") || ("$scheme" == "http" && "$ext_port" != "80") ]] && port_part=":${ext_port}"
  local url="${scheme}://${DOMAIN}${port_part}${SUB_PATH}"

  log ""
  log "${C_GREEN}${C_BOLD}================ 部署完成 ================${C_RESET}"
  log ""
  log "  ${C_BOLD}访问地址${C_RESET}：${C_CYAN}${url}${C_RESET}"
  log ""
  log "  ${C_BOLD}常用维护命令${C_RESET}"
  if [[ "$MODE" == "systemd" ]]; then
    log "    启动    systemctl start   ${SERVICE_NAME}"
    log "    停止    systemctl stop    ${SERVICE_NAME}"
    log "    重启    systemctl restart ${SERVICE_NAME}"
    log "    状态    systemctl status  ${SERVICE_NAME} --no-pager"
    log "    日志    journalctl -u ${SERVICE_NAME} -f --no-pager"
    log "    开机自启 systemctl enable  ${SERVICE_NAME}（部署时已启用）"
  else
    log "    启动    cd ${INSTALL_DIR} && docker compose up -d"
    log "    停止    cd ${INSTALL_DIR} && docker compose down"
    log "    重启    cd ${INSTALL_DIR} && docker compose restart"
    log "    状态    cd ${INSTALL_DIR} && docker compose ps"
    log "    日志    cd ${INSTALL_DIR} && docker compose logs -f --tail=100"
  fi
  log "    环境变量 ${INSTALL_DIR}/.env（改后需重启服务）"
  log "    Nginx 配置 ${NGINX_CONF}"
  log "    Nginx 校验 nginx -t && systemctl reload nginx"
  if [[ "$TLS_MODE" != "none" && -n "$CERT_FULLCHAIN" ]]; then
    if [[ "$CERT_FULLCHAIN" == /etc/letsencrypt/* || "$CERT_FULLCHAIN" == */.acme.sh/* ]]; then
      log "    证书     ${CERT_FULLCHAIN}（到期自动续期）"
      log "    手动续期 certbot renew --force-renewal && systemctl reload nginx"
    else
      log "    证书     ${CERT_FULLCHAIN}（自签名，浏览器会提示不安全）"
      log "    换正式证书 网络与 DNS 就绪后重跑：bash ${SCRIPT_NAME} --domain ${DOMAIN} --tls letsencrypt"
    fi
  fi
  log ""
  log "  ${C_BOLD}后续说明${C_RESET}"
  log "    1. 首次打开页面会进入初始化流程，创建${C_BOLD}管理员账号${C_RESET}并登录。"
  log "    2. 在「系统设置 → 访问密钥管理」选择服务商并填入密钥，再到「存储桶」添加桶。"
  log "    3. ${C_BOLD}务必定期备份数据目录${C_RESET}：${DATA_DIR}"
  log "       其中含 AES 主密钥与全部云厂商密钥 —— 丢失后已加密文件无法解密，且不可恢复。"
  log "       备份示例：tar -czf kepler-data-\$(date +%F).tar.gz -C ${DATA_DIR} ."
  log "    4. 本服务为${C_BOLD}单实例${C_RESET}设计（data/ 目录有单实例锁），请勿同时运行多个实例。"
  log "    5. 应用内开启 WebDAV 后需放行 ${SERVICE_NAME} 的 8443 端口，并在 Nginx 中启用 /dav/ 反代（配置内已给出注释模板）。"
  log "    6. 重新执行本脚本可升级部署：源码与配置会被同步覆盖，数据目录不会被触碰。"
  log ""
  log "  详细日志：${LOG_FILE}"
  log ""
}

main() {
  log "${C_BOLD}Kepler 对象存储管理系统 —— 一键部署${C_RESET}"
  log "${C_DIM}（Ctrl+C 可随时中断；脚本可重复执行，重复执行等价于升级/修复）${C_RESET}"

  if [[ "$UNINSTALL" == "1" ]]; then
    detect_env
    do_uninstall
    exit 0
  fi

  step "环境检测（权限 / 系统 / 包管理器）"
  detect_env
  need_pkgs_base

  step "部署参数确认"
  collect_config

  step "安装 Node.js 运行时"
  install_node

  step "准备源码并安装依赖"
  prepare_source
  install_app
  npm_install_deps

  step "生成环境变量与运行用户"
  create_user
  gen_env_file

  step "配置进程守护（${MODE}）"
  if [[ "$MODE" == "docker" ]]; then setup_docker_service; else setup_systemd_service; fi

  step "安装并配置 Nginx 反向代理"
  install_nginx
  setup_firewall

  step "申请并配置 HTTPS 证书（${TLS_MODE}）"
  setup_tls

  step "健康检查"
  wait_for_service
  external_check

  print_summary
}

main "$@"
