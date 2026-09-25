#!/usr/bin/env bash
# ==============================================================================
# deploy.sh —— Kepler 对象存储管理系统 · 一键部署脚本
#
# 目标：在一台全新的 Linux 服务器上，只执行一条命令即可完成部署：
#   curl -fsSL https://raw.githubusercontent.com/xingsenfirst/Kepler/main/deploy.sh | sudo bash -s -- --domain cos.example.com
#
# 脚本会依次完成：
#   1) 自动识别包管理器并安装 git、curl、ca-certificates、tar 等基础工具
#   2) 自动拉取 https://github.com/xingsenfirst/Kepler.git 源码
#   3) 安装运行时（Node.js ≥ 18）与依赖（npm 生产依赖）
#   4) 安装并配置 Nginx 反向代理
#   5) 生成 .env 环境变量文件并注册进程守护
#   6) HTTPS：Let's Encrypt 自动签发（失败自动回退自签名证书）
#   7) 注册全局 kepler 管理命令、保存部署状态并执行健康检查
#
# 设计约束：
#   - 幂等：可反复执行。已存在且内容一致的文件不重写；配置变更会先备份旧文件。
#   - 只问最基础的信息：域名（必填）、对外 HTTPS 端口、部署方式；其余全部取默认值。
#   - 非交互：所有交互项都可用命令行参数或环境变量传入（见 usage）。
#   - 失败可读：任何失败都给出「原因判断 + 可敲的修复命令 + 手动装完用哪个跳过参数重跑」，
#     而不是只甩一段日志。装不了的东西（Node/Nginx/依赖）都能用 --skip-* 跳过。
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/xingsenfirst/Kepler/main/deploy.sh | sudo bash -s -- --domain cos.example.com
#   sudo bash deploy.sh --domain cos.example.com [选项]
#   kepler                    # 安装完成后的交互式管理菜单
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
#   --skip-node             跳过 Node.js 安装（只校验版本；适合用 nvm/自建运行时的人）
#   --skip-deps             跳过 npm 依赖安装
#   --skip-nginx            跳过 Nginx 安装与反代配置（自行用 Caddy/Nginx 反代）
#   --skip-service          跳过 systemd/docker 服务创建（自行用 pm2/supervisor 守护）
#   -y, --yes               非交互模式：全部使用默认值（域名仍需提供）
#   --verbose               显示子命令的完整输出（默认只写日志文件）
#   --reinstall             按已保存配置重新拉取源码并安装（保留数据）
#   --manage                打开交互式管理菜单（通常直接执行 kepler）
#   --uninstall             卸载服务、应用、数据、证书与全局命令
#   -h, --help              显示帮助
#
# 安装后的全局命令：
#   kepler                   编号菜单：重装、改管理员用户名/密码、改端口、卸载、退出
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
readonly STATE_DIR="/etc/${SERVICE_NAME}"
readonly STATE_FILE="${STATE_DIR}/deploy.conf"
readonly GLOBAL_COMMAND="/usr/local/bin/${SERVICE_NAME}"
readonly DEFAULT_REPO_URL="https://github.com/xingsenfirst/Kepler.git"

STEP_NO=0
VERBOSE="${VERBOSE:-0}"
ASSUME_YES="${ASSUME_YES:-0}"
ORIG_ARGS="$*"          # 保存原始命令行，失败提示里给出「原样重跑」命令
ORIGINAL_ARGV=("$@")
INIT_SYSTEM=""
NGINX_CONF=""
NGINX_LINK=""
SKIP_NODE="${SKIP_NODE:-0}"       # 跳过 Node.js 安装（用户自行管理运行时）
SKIP_DEPS="${SKIP_DEPS:-0}"       # 跳过 npm 依赖安装
SKIP_NGINX="${SKIP_NGINX:-0}"     # 跳过 Nginx 安装与反代配置（用户自建反代）
SKIP_SERVICE="${SKIP_SERVICE:-0}" # 跳过服务创建（用户用 pm2/supervisor 等自行守护）
SERVICE_READY=0            # 健康检查：本地应用是否就绪
EXT_OK=0                   # 健康检查：外网访问是否通过
NGINX_OK=1                 # Nginx 是否已配置成功
MANAGE=0                   # 打开 kepler 管理菜单
REINSTALL=0                # 强制从远程仓库重新获取源码
STATE_LOADED=0

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
    err "—— 本次操作的日志（完整日志：${LOG_FILE}）——"
    log_since_mark | tail -n 30 >&2 || true
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

# ------------------------------------------------------------------------------
# 0.1 失败诊断与「可操作」提示
#
# 原则：任何失败都不能只甩一段日志就退出。必须回答三件事——
#   ① 大概是哪种原因（从日志关键字自动判断）
#   ② 具体可以敲哪些命令修复
#   ③ 想自己装的话，装完用哪个跳过参数重跑
# ------------------------------------------------------------------------------

# 提示正文（走 stderr，保证与错误行顺序一致，不被 stdout 缓冲打乱）
plain() { printf '%s\n' "$*" >&2; }

# LOG_MARK：关键操作前记下日志行数，诊断时只看「本次」新增的日志，避免串台
LOG_MARK=0
mark_log() {
  if [[ -f "$LOG_FILE" ]] && have wc; then
    LOG_MARK=$(( $(wc -l <"$LOG_FILE" 2>/dev/null || echo 0) + 1 ))
  else
    LOG_MARK=0
  fi
}

# 取「本次操作以来」的日志
log_since_mark() {
  have tail || return 0
  if ((LOG_MARK > 1)); then
    tail -n "+${LOG_MARK}" "$LOG_FILE" 2>/dev/null || true
  else
    tail -n 60 "$LOG_FILE" 2>/dev/null || true
  fi
}

# 从日志里抽取最可能有用的错误行（去空、最多 n 行）
log_key_lines() {
  local n="${1:-6}"
  log_since_mark \
    | grep -iE 'error|failed|fatal|denied|refused|unable|no space|E: |W: |Err' \
    | grep -viE '^\s*$' | tail -n "$n" || true
}

# 打印「日志关键行」小节
show_log_key_lines() {
  local lines; lines="$(log_key_lines 6)"
  if [[ -n "$lines" ]]; then
    plain "  日志里的关键行："
    while IFS= read -r l; do plain "    | ${l}"; done <<<"$lines"
  else
    plain "  完整日志：tail -n 60 ${LOG_FILE}"
  fi
}

# 交互环境下询问「是否已手动处理并继续」，非交互直接返回 1（退出）
confirm_continue() {
  local ans=""
  if [[ "$ASSUME_YES" == "1" || ! -t 0 ]]; then return 1; fi
  read -r -p "$(printf '%s  ↳ 若你已手工处理完，可直接继续 [y/N]: %s' "$C_YELLOW" "$C_RESET")" ans || true
  [[ "${ans,,}" == "y" || "${ans,,}" == "yes" ]]
}

# 重跑命令（保留用户原本传的全部参数，再追加跳过的开关）
rerun_cmd() {
  local extra="$*" self="$SCRIPT_NAME"
  [[ -f "${0:-}" ]] && self="$0"      # 脚本在本地就给出可复制的真实路径
  if [[ -n "$ORIG_ARGS" ]]; then
    printf 'bash %s %s%s' "$self" "$ORIG_ARGS" "${extra:+ $extra}"
  else
    printf 'bash %s --domain %s%s' "$self" "${DOMAIN:-<域名>}" "${extra:+ $extra}"
  fi
}

# 统一的失败出口：die_with_hint <标题> <提示行...>
die_with_hint() {
  local title="$1"; shift
  plain ""
  err "$title"
  plain ""
  local line
  for line in "$@"; do plain "  $line"; done
  plain ""
  plain "  完整日志：${LOG_FILE}"
  plain "  修复后重跑（脚本幂等，已完成的步骤不会重复执行）："
  plain "    $(rerun_cmd)"
  plain ""
  exit 1
}

# 非致命失败：warn_with_hint <标题> <提示行...>
warn_with_hint() {
  local title="$1"; shift
  warn "$title"
  local line
  for line in "$@"; do plain "  $line"; done
}

on_error() {
  local rc=$1 line=$2
  LOG_MARK=0   # 意外失败时看完整上下文，而不是上一次 mark 之后的部分
  plain ""
  err "脚本在第 ${line} 行意外失败（退出码 ${rc}）。"
  plain ""
  show_log_key_lines
  plain ""
  plain "  详细日志：${LOG_FILE}"
  plain "  修复后可原样重跑（幂等）：$(rerun_cmd)"
  plain ""
  exit "$rc"
}
trap 'on_error "$?" "$LINENO"' ERR

# ------------------------------------------------------------------------------
# 1. 参数、持久化状态与默认值
# ------------------------------------------------------------------------------
# 先保存调用者显式提供的环境变量；部署状态随后加载，但显式环境变量与命令行仍优先。
ENV_DOMAIN="${DOMAIN-}"
ENV_APP_PORT="${APP_PORT-}"
ENV_HTTPS_PORT="${HTTPS_PORT-}"
ENV_HTTP_PORT="${HTTP_PORT-}"
ENV_INSTALL_DIR="${INSTALL_DIR-}"
ENV_DATA_DIR="${DATA_DIR-}"
ENV_MODE="${MODE-}"
ENV_TLS_MODE="${TLS_MODE-}"
ENV_EMAIL="${EMAIL-}"
ENV_SUB_PATH="${SUB_PATH-}"
ENV_REPO_URL="${REPO_URL-}"
ENV_NODE_VERSION="${NODE_VERSION-}"
ENV_MIRROR="${MIRROR-}"
ENV_STAGING="${STAGING-}"

DOMAIN=""
APP_PORT="3000"
HTTPS_PORT="443"
HTTP_PORT="80"
INSTALL_DIR="/opt/kepler"
DATA_DIR=""
MODE="systemd"
TLS_MODE="auto"
EMAIL=""
SUB_PATH="/"
REPO_URL="$DEFAULT_REPO_URL"
NODE_VERSION=""
MIRROR="auto"
STAGING="0"
UNINSTALL=0
SRC_DIR=""          # 源码来源目录（自动探测）
SRC_TMP_DIR=""      # 若源码来自临时克隆，复制完成后清理
APP_VERSION="1.0.0"
NODE_BIN=""
CERT_FULLCHAIN=""
CERT_KEY=""

usage() {
  local source="${BASH_SOURCE[0]:-$0}"
  if [[ -r "$source" ]]; then sed -n '2,60p' "$source" | sed 's/^# \{0,1\}//'; else log "Kepler 一键部署：请使用 --domain <域名>，安装后执行 kepler 管理。"; fi
  exit 0
}

function load_state() {
  [[ -r "$STATE_FILE" ]] || return 0
  local key value
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    [[ -n "$key" && "$key" != \#* ]] || continue
    case "$key" in
      DOMAIN) DOMAIN="$value" ;;
      APP_PORT) APP_PORT="$value" ;;
      HTTPS_PORT) HTTPS_PORT="$value" ;;
      HTTP_PORT) HTTP_PORT="$value" ;;
      INSTALL_DIR) INSTALL_DIR="$value" ;;
      DATA_DIR) DATA_DIR="$value" ;;
      MODE) MODE="$value" ;;
      TLS_MODE) TLS_MODE="$value" ;;
      EMAIL) EMAIL="$value" ;;
      SUB_PATH) SUB_PATH="$value" ;;
      REPO_URL) REPO_URL="$value" ;;
      NODE_VERSION) NODE_VERSION="$value" ;;
      MIRROR) MIRROR="$value" ;;
      STAGING) STAGING="$value" ;;
      SKIP_NODE) SKIP_NODE="$value" ;;
      SKIP_DEPS) SKIP_DEPS="$value" ;;
      SKIP_NGINX) SKIP_NGINX="$value" ;;
      SKIP_SERVICE) SKIP_SERVICE="$value" ;;
      NODE_BIN) NODE_BIN="$value" ;;
      NGINX_CONF) NGINX_CONF="$value" ;;
      NGINX_LINK) NGINX_LINK="$value" ;;
      CERT_FULLCHAIN) CERT_FULLCHAIN="$value" ;;
      CERT_KEY) CERT_KEY="$value" ;;
    esac
  done < "$STATE_FILE"
  STATE_LOADED=1
}

function apply_env_overrides() {
  [[ -n "$ENV_DOMAIN" ]] && DOMAIN="$ENV_DOMAIN"
  [[ -n "$ENV_APP_PORT" ]] && APP_PORT="$ENV_APP_PORT"
  [[ -n "$ENV_HTTPS_PORT" ]] && HTTPS_PORT="$ENV_HTTPS_PORT"
  [[ -n "$ENV_HTTP_PORT" ]] && HTTP_PORT="$ENV_HTTP_PORT"
  [[ -n "$ENV_INSTALL_DIR" ]] && INSTALL_DIR="$ENV_INSTALL_DIR"
  [[ -n "$ENV_DATA_DIR" ]] && DATA_DIR="$ENV_DATA_DIR"
  [[ -n "$ENV_MODE" ]] && MODE="$ENV_MODE"
  [[ -n "$ENV_TLS_MODE" ]] && TLS_MODE="$ENV_TLS_MODE"
  [[ -n "$ENV_EMAIL" ]] && EMAIL="$ENV_EMAIL"
  [[ -n "$ENV_SUB_PATH" ]] && SUB_PATH="$ENV_SUB_PATH"
  [[ -n "$ENV_REPO_URL" ]] && REPO_URL="$ENV_REPO_URL"
  [[ -n "$ENV_NODE_VERSION" ]] && NODE_VERSION="$ENV_NODE_VERSION"
  [[ -n "$ENV_MIRROR" ]] && MIRROR="$ENV_MIRROR"
  [[ -n "$ENV_STAGING" ]] && STAGING="$ENV_STAGING"
}

function save_state() {
  local value
  for value in "$DOMAIN" "$APP_PORT" "$HTTPS_PORT" "$HTTP_PORT" "$INSTALL_DIR" "$DATA_DIR" "$MODE" "$TLS_MODE" "$EMAIL" "$SUB_PATH" "$REPO_URL" "$NODE_VERSION" "$MIRROR" "$NODE_BIN" "$NGINX_CONF" "$NGINX_LINK" "$CERT_FULLCHAIN" "$CERT_KEY"; do
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || die "部署配置包含非法换行，拒绝保存状态。"
  done
  local content="# Kepler 部署状态（由 ${SCRIPT_NAME} 管理，请勿手工写入密钥）
STATE_VERSION=1
DOMAIN=${DOMAIN}
APP_PORT=${APP_PORT}
HTTPS_PORT=${HTTPS_PORT}
HTTP_PORT=${HTTP_PORT}
INSTALL_DIR=${INSTALL_DIR}
DATA_DIR=${DATA_DIR}
MODE=${MODE}
TLS_MODE=${TLS_MODE}
EMAIL=${EMAIL}
SUB_PATH=${SUB_PATH}
REPO_URL=${REPO_URL}
NODE_VERSION=${NODE_VERSION}
MIRROR=${MIRROR}
STAGING=${STAGING}
SKIP_NODE=${SKIP_NODE}
SKIP_DEPS=${SKIP_DEPS}
SKIP_NGINX=${SKIP_NGINX}
SKIP_SERVICE=${SKIP_SERVICE}
NODE_BIN=${NODE_BIN}
NGINX_CONF=${NGINX_CONF}
NGINX_LINK=${NGINX_LINK}
CERT_FULLCHAIN=${CERT_FULLCHAIN}
CERT_KEY=${CERT_KEY}"
  mkdir -p "$STATE_DIR"
  write_file "$STATE_FILE" "$content" 0600
}

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
      --skip-node)    SKIP_NODE=1; shift ;;
      --skip-deps)    SKIP_DEPS=1; shift ;;
      --skip-nginx)   SKIP_NGINX=1; shift ;;
      --skip-service) SKIP_SERVICE=1; shift ;;
      --reinstall)    REINSTALL=1; ASSUME_YES=1; shift ;;
      --manage)       MANAGE=1; shift ;;
      -y|--yes)       ASSUME_YES=1; shift ;;
      --verbose)      VERBOSE=1; shift ;;
      --uninstall)    UNINSTALL=1; shift ;;
      -h|--help)      usage ;;
      *)              die "未知参数：$1（使用 --help 查看用法）" ;;
    esac
  done
}

# 优先级：内置默认值 < 已保存部署状态 < 显式环境变量 < 命令行参数。
# 被 source 时（自检 / 复用函数）不解析调用方的参数，也不自动执行部署。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  load_state
  apply_env_overrides
  parse_args "$@"
fi

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

  # 这里只校验无法通过包管理器可靠补齐的最小系统命令；git/curl/tar 等在下一步自动安装。
  for cmd in mkdir id chmod uname; do
    have "$cmd" || die "基础系统缺少必要命令：$cmd（当前镜像过于精简，无法安全启动自动安装）。"
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

# 包管理器的「安装」命令原文（提示里给用户直接复制用）
pm_install_cmd() {
  case "$PM" in
    apt)     printf 'apt-get install -y' ;;
    dnf|yum) printf '%s install -y' "$PM" ;;
    apk)     printf 'apk add' ;;
    *)       printf 'zypper --non-interactive install' ;;
  esac
}

# EPEL 直装命令（RHEL 系常用兜底）
epel_rpm_cmd() {
  local major="${VERSION_ID:-}"
  major="${major%%.*}"
  case "$major" in
    7|8|9) printf 'rpm -Uvh https://dl.fedoraproject.org/pub/epel/epel-release-latest-%s.noarch.rpm' "$major" ;;
    *)     printf '%s install -y epel-release' "$PM" ;;
  esac
}

# 按包名推断「装不了就跳过」的开关，便于用户自行安装后重跑
skip_flag_for_pkgs() {
  local list="$1"
  case "$list" in
    *nodejs*|*node*)  printf -- '--skip-node' ;;
    *nginx*)          printf -- '--skip-nginx' ;;
    *certbot*)        printf -- '--tls selfsigned' ;;
    *docker*)         printf -- '--mode systemd' ;;
    *)                printf -- '' ;;
  esac
}

# 真正调用包管理器（不做失败处理）
pkg_run_pm() {
  local pkgs=("$@")
  local rc=0
  mark_log
  info "安装软件包：${pkgs[*]}"
  case "$PM" in
    apt)
      run_soft bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq'
      run bash -c "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkgs[*]}" || rc=$? ;;
    dnf|yum)
      run "$PM" install -y "${pkgs[@]}" || rc=$? ;;
    apk)
      run_soft apk update
      run apk add --no-cache "${pkgs[@]}" || rc=$? ;;
    zypper)
      run zypper --non-interactive install "${pkgs[@]}" || rc=$? ;;
  esac
  return "$rc"
}

# 包安装失败：判断原因 → 给出可敲的修复命令 → 询问/退出
# 用法：on_pkg_failure <包名列表> <1=可选依赖(仅警告) | 0=必需>
HINTS=()
add_hint() { HINTS+=("$1"); }

on_pkg_failure() {
  local pkg_list="$1" optional="${2:-0}"
  local tail_log; tail_log="$(log_since_mark)"

  HINTS=()
  add_hint "失败的包：${pkg_list}"
  add_hint ""
  local l
  while IFS= read -r l; do [[ -n "$l" ]] && add_hint "  日志 | ${l}"; done <<<"$(log_key_lines 5)"
  add_hint ""

  if grep -qiE 'could not resolve|temporary failure resolving|failed to fetch|could not connect|network is unreachable|no route to host|timed out|connection refused|无法连接|超时' <<<"$tail_log"; then
    add_hint "【判断】网络 / DNS 不可达，或软件源超时。"
    add_hint "  1) 检查出网：curl -sI https://$(pm_mirror_host) -m 8 ; echo \$?"
    add_hint "  2) 检查 DNS：cat /etc/resolv.conf（可临时换 8.8.8.8 / 223.5.5.5）"
    add_hint "  3) 国内服务器建议把软件源换成国内镜像后重试（node/npm 下载可加 --mirror cn）"
  elif grep -qiE 'unable to locate package|no package .* available|unable to find a match|no match for argument|nothing provides|not found|没有可用的软件包' <<<"$tail_log"; then
    add_hint "【判断】当前软件源里没有这个包（索引未更新 / 缺扩展源）。"
    case "$PM" in
      apt)
        add_hint "  1) 刷新索引：apt-get update"
        add_hint "  2) 查正确包名：apt-cache search ${pkg_list%% *}"
        add_hint "  3) 源太旧就换源：/etc/apt/sources.list（国内可用 mirrors.aliyun.com / mirrors.tencent.com）" ;;
      dnf|yum)
        add_hint "  1) 启用 EPEL：$(epel_rpm_cmd)"
        add_hint "  2) 刷新索引：${PM} makecache"
        add_hint "  3) 查正确包名：${PM} search ${pkg_list%% *}"
        add_hint "  4) nginx 还可走模块：${PM} module list nginx && ${PM} module enable -y nginx:1.24" ;;
      apk)
        add_hint "  1) 刷新索引：apk update（确认 /etc/apk/repositories 已启用社区源）" ;;
      zypper)
        add_hint "  1) 刷新索引：zypper refresh" ;;
    esac
  elif grep -qiE 'could not get lock|lock held|waiting for|another process|is being used by|占用' <<<"$tail_log"; then
    add_hint "【判断】另一个包管理进程正占用锁（常见于系统自动更新）。"
    add_hint "  1) 等它结束，或确认：ps aux | grep -E 'apt|dpkg|dnf|yum|apk'"
    add_hint "  2) 等待后重跑本脚本即可（幂等）"
  elif grep -qiE 'no space left|disk full|空间不足' <<<"$tail_log"; then
    add_hint "【判断】磁盘空间不足：df -h 查看，清理后重试。"
  elif grep -qiE 'permission denied|are you root|not permitted' <<<"$tail_log"; then
    add_hint "【判断】权限不足：请用 root 或加 sudo 重跑本脚本。"
  elif grep -qiE 'gpg|NO_PUBKEY|public key|signature' <<<"$tail_log"; then
    add_hint "【判断】软件源签名/公钥校验失败（源被替换过或密钥过期）。"
    case "$PM" in
      apt) add_hint "  修复：apt-get update --allow-insecure-repositories 或重新导入源的公钥" ;;
      dnf|yum) add_hint "  修复：${PM} clean all && ${PM} makecache（必要时关闭 gpgcheck 仅作临时手段）" ;;
    esac
  else
    add_hint "【判断】未能自动识别原因，请查看日志尾部：tail -n 80 ${LOG_FILE}"
    add_hint "  手动安装命令：$(pm_install_cmd) ${pkg_list}"
  fi

  add_hint ""
  local flag; flag="$(skip_flag_for_pkgs "$pkg_list")"
  add_hint "【或自己装】$(pm_install_cmd) ${pkg_list}"
  if [[ -n "$flag" ]]; then
    add_hint "  装完后让脚本跳过这步重跑："
    add_hint "    $(rerun_cmd "$flag")"
  fi

  if [[ "$optional" == "1" ]]; then
    warn_with_hint "可选依赖安装失败（不影响主流程，功能会降级）" "${HINTS[@]}"
    return 1
  fi
  if confirm_continue; then
    ok "已确认继续（若后续步骤依赖该包，仍可能失败）"
    return 0
  fi
  die_with_hint "软件包安装失败：${pkg_list}" "${HINTS[@]}"
}

pm_mirror_host() {
  case "$PM" in
    apt) printf 'deb.debian.org' ;;
    dnf|yum) printf 'mirrorlist.centos.org' ;;
    apk) printf 'dl-cdn.alpinelinux.org' ;;
    *) printf 'download.opensuse.org' ;;
  esac
}

# 必需依赖：装不上会中止（可交互确认继续）
pkg_install() {
  local pkgs=("$@")
  [[ ${#pkgs[@]} -gt 0 ]] || return 0
  local rc=0
  pkg_run_pm "${pkgs[@]}" || rc=$?
  ((rc == 0)) || on_pkg_failure "${pkgs[*]}" 0
  return 0
}

# 可选依赖：装不上只警告并降级
pkg_install_opt() {
  local pkgs=("$@")
  [[ ${#pkgs[@]} -gt 0 ]] || return 0
  local rc=0
  pkg_run_pm "${pkgs[@]}" || rc=$?
  if ((rc != 0)); then on_pkg_failure "${pkgs[*]}" 1; return 1; fi
  return 0
}

need_pkgs_base() {
  local to_install=()
  have curl || to_install+=(curl)
  have git || to_install+=(git)
  have tar || to_install+=(tar)
  have gzip || to_install+=(gzip)
  have sed || to_install+=(sed)
  have awk || { [[ "$PM" == "apt" ]] && to_install+=(gawk) || to_install+=(gawk); }
  have grep || to_install+=(grep)
  local core_cmd
  for core_cmd in mktemp date head tail cp rm seq wc; do
    if ! have "$core_cmd"; then to_install+=(coreutils); break; fi
  done
  [[ -r /etc/ssl/certs/ca-certificates.crt || -r /etc/pki/tls/certs/ca-bundle.crt ]] || to_install+=(ca-certificates)

  if ((${#to_install[@]})); then
    info "检测到缺少基础工具，将自动安装：${to_install[*]}"
    pkg_install "${to_install[@]}"
  fi

  local cmd
  for cmd in curl git tar gzip sed awk grep mktemp date head tail; do
    have "$cmd" || die_with_hint "基础工具自动安装后仍不可用：${cmd}" \
      "请检查软件源与系统镜像是否完整。" \
      "可手工执行：$(pm_install_cmd) curl git ca-certificates tar gzip sed gawk grep coreutils"
  done
  ok "基础工具已就绪：git / curl / tar / ca-certificates"
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

  # 其余项全部使用安全默认值、已保存状态或命令行参数；初次部署只询问域名。
  info "除域名外均使用自动配置；安装后可执行 kepler 修改端口或重新安装。"

  MODE="${MODE,,}"
  [[ "$MODE" == "systemd" || "$MODE" == "docker" || "$MODE" == "compose" ]] || die "MODE 只支持 systemd 或 docker，当前：$MODE"
  [[ "$MODE" == "compose" ]] && MODE="docker"
  [[ "$INSTALL_DIR" == /* ]] || die "安装目录必须是绝对路径：${INSTALL_DIR}"
  [[ -z "$DATA_DIR" || "$DATA_DIR" == /* ]] || die "数据目录必须是绝对路径：${DATA_DIR}"
  [[ -n "$REPO_URL" ]] || die "源码仓库地址不能为空。"
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

# Node.js 手动安装指引（自动安装失败 / --skip-node 版本不足时给出）
node_manual_hints() {
  local arch="${NODE_ARCH:-x64}"
  HINTS=()
  add_hint "本机需要 Node.js ≥ v18（项目 package.json 的 engines 要求）。任选一种装法："
  add_hint ""
  case "$PM" in
    apt)
      add_hint "  【A】NodeSource（Debian/Ubuntu —— 与本机匹配）"
      add_hint "    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
      add_hint "    apt-get install -y nodejs" ;;
    dnf|yum)
      add_hint "  【A】NodeSource（RHEL/CentOS/Rocky/Alma —— 与本机匹配）"
      add_hint "    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -"
      add_hint "    ${PM} install -y nodejs" ;;
    *)
      add_hint "  【A】发行版源：$(pm_install_cmd) nodejs npm" ;;
  esac
  add_hint "  【B】其它发行版参考"
  add_hint "    Debian/Ubuntu: curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs"
  add_hint "    RHEL/CentOS  : curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - && dnf install -y nodejs"
  add_hint "  【C】官方二进制包（任何发行版通用，装进 /usr/local）"
  add_hint "    curl -fsSL https://nodejs.org/dist/v20.19.0/node-v20.19.0-linux-${arch}.tar.gz \\"
  add_hint "      | tar -xz -C /usr/local --strip-components=1"
  add_hint "  【D】国内服务器可用 npmmirror 镜像（替换【C】的下载地址）"
  add_hint "    https://registry.npmmirror.com/-/binary/node/v20.19.0/node-v20.19.0-linux-${arch}.tar.gz"
  add_hint "  【E】用 nvm 自行管理多版本：https://github.com/nvm-sh/nvm"
  add_hint ""
  add_hint "装完确认：node -v（应显示 v18/v20/v22 等 ≥ v18 的版本）"
  add_hint "然后让脚本跳过安装、只做校验："
  add_hint "    $(rerun_cmd --skip-node)"
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
    if [[ "$SKIP_NODE" == "1" ]]; then
      node_manual_hints
      die_with_hint "已指定 --skip-node，但本机 Node.js 为 v${cur}，低于要求的 v${required}" "${HINTS[@]}"
    fi
    info "已安装 Node.js v${cur}，低于要求 v${required}，将尝试升级。"
  fi

  if [[ "$SKIP_NODE" == "1" ]]; then
    node_manual_hints
    die_with_hint "已指定 --skip-node，但本机未找到 node 命令" "${HINTS[@]}"
  fi

  # 4.1 优先尝试系统包（失败不致命，继续尝试下一级）
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
  warn "系统源里的 Node.js 不满足要求（或源里没有），继续尝试 NodeSource 仓库。"

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
    warn "NodeSource 仓库安装未成功（常见于已 EOL 的发行版或网络受限），继续尝试官方二进制包。"
  fi

  # 4.3 官方二进制包（通用兜底，支持 cn 镜像）
  local ver base url tmp
  ver="$(resolve_node_version)"
  base="$(node_tarball_base)"
  # 用 .tar.gz 而非 .tar.xz：gzip 是标配，部分精简镜像的 tar 不带 xz 支持
  url="${base}/v${ver}/node-v${ver}-linux-${NODE_ARCH}.tar.gz"
  info "下载 Node.js v${ver}（${url}）…"
  tmp="$(mktemp -d)"
  local rc=0
  run curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "${tmp}/node.tar.gz" "$url" || rc=$?
  if ((rc != 0)) && [[ "$MIRROR" != "cn" ]]; then
    warn "官方源下载失败，改用国内镜像重试…"
    url="https://registry.npmmirror.com/-/binary/node/v${ver}/node-v${ver}-linux-${NODE_ARCH}.tar.gz"
    rc=0
    run curl -fsSL --retry 3 --retry-delay 2 --max-time 300 -o "${tmp}/node.tar.gz" "$url" || rc=$?
  fi
  if ((rc != 0)); then
    rm -rf "$tmp"
    node_manual_hints
    HINTS+=("" "下载失败的地址：${url}" "  检查连通性：curl -sI ${url} -m 8 ; echo \$?")
    die_with_hint "Node.js 二进制包下载失败" "${HINTS[@]}"
  fi
  rc=0
  run tar -xzf "${tmp}/node.tar.gz" -C /usr/local --strip-components=1 || rc=$?
  rm -rf "$tmp"
  if ((rc != 0)); then
    HINTS=()
    add_hint "解压失败，可手工解压（以 v${ver} / ${NODE_ARCH} 为例）："
    add_hint "  curl -fsSL -o /tmp/node.tar.gz ${url}"
    add_hint "  tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1"
    add_hint "  常见原因：/usr/local 不可写、tar 不支持 gzip、下载的其实是 HTML 错误页（用 file /tmp/node.tar.gz 看看）"
    die_with_hint "Node.js 解压到 /usr/local 失败" "${HINTS[@]}"
  fi
  if have ldconfig; then run_soft ldconfig; fi
  NODE_BIN="$(command -v node || true)"
  if [[ -z "$NODE_BIN" ]] || ! version_ge "$("$NODE_BIN" -v | sed 's/^v//')" "$required"; then
    node_manual_hints
    die_with_hint "Node.js 自动安装失败（三种方式都没装上 v${required}+）" "${HINTS[@]}"
  fi
  ok "Node.js 安装完成（二进制包）：$("$NODE_BIN" -v) → ${NODE_BIN}"
}

npm_registry_args() {
  if [[ "$MIRROR" == "cn" ]]; then printf '%s' "--registry=https://registry.npmmirror.com"; fi
}

# 网络预检：只探测、只提示，不中断。离线/半离线环境下提前把话说清楚
preflight_network() {
  local -a targets=()
  if [[ "$MIRROR" == "cn" ]]; then
    targets=("https://registry.npmmirror.com/-/binary/node/" "https://registry.npmmirror.com/-/ping")
  else
    targets=("https://nodejs.org/dist/index.json" "https://registry.npmjs.org/-/ping")
  fi
  local t bad=0
  for t in "${targets[@]}"; do
    if ! curl -fsS -m 8 -o /dev/null "$t" >/dev/null 2>&1; then
      warn "网络探测失败：$t"
      bad=1
    fi
  done
  if ((bad == 0)); then
    ok "网络探测正常（Node 源与 npm registry 可达）"
    return 0
  fi
  warn "  · 国内服务器访问境外源慢/不通时，加 --mirror cn 重跑：$(rerun_cmd --mirror cn)"
  warn "  · 完全离线的机器：自行装好 Node 与依赖后，用跳过参数继续：$(rerun_cmd --skip-node --skip-deps)"
  return 0
}

# ------------------------------------------------------------------------------
# 5. 部署源码
# ------------------------------------------------------------------------------
prepare_source() {
  local script_dir; script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ "$REINSTALL" != "1" && -f "${script_dir}/package.json" && -d "${script_dir}/server" ]]; then
    SRC_DIR="$script_dir"
    info "检测到本地源码目录：${SRC_DIR}"
    return 0
  fi
  # 独立运行（如 curl ... | bash）：克隆仓库
  if ! have git; then
    pkg_install_opt git || true
    if ! have git; then
      HINTS=()
      add_hint "本脚本需要 git 才能拉取源码（仓库：${REPO_URL}）。"
      add_hint "  1) 手动安装：$(pm_install_cmd) git"
      add_hint "  2) 或不用 git：把项目打包上传到服务器，解压后在该目录内执行本脚本 ——"
      add_hint "     tar -czf kepler.tgz . && scp kepler.tgz root@<服务器>:/tmp/ "
      add_hint "     （服务器端）mkdir -p /opt/src && tar -xzf /tmp/kepler.tgz -C /opt/src && cd /opt/src && bash deploy.sh --domain <域名>"
      die_with_hint "git 不可用且自动安装失败" "${HINTS[@]}"
    fi
  fi
  local tmp; tmp="$(mktemp -d)"
  info "未发现本地源码，从仓库拉取：${REPO_URL}"
  if ! run git clone --depth 1 "$REPO_URL" "${tmp}/src"; then
    rm -rf "$tmp"
    HINTS=()
    local l
    while IFS= read -r l; do [[ -n "$l" ]] && add_hint "  日志 | ${l}"; done <<<"$(log_key_lines 5)"
    add_hint ""
    add_hint "  1) 换可访问的仓库：--repo <git 地址>"
    add_hint "  2) 或先把项目上传/解压到服务器，再在该目录内执行本脚本（脚本会自动识别同目录源码）"
    add_hint "  3) 检查网络：curl -sI https://github.com -m 8 ; echo \$?"
    die_with_hint "源码拉取失败（${REPO_URL}）" "${HINTS[@]}"
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
  cd "$INSTALL_DIR"
  chmod 0755 "${INSTALL_DIR}/deploy.sh" 2>/dev/null || true
  ok "源码已部署并进入项目目录：${INSTALL_DIR}（版本 ${APP_VERSION}）"
}

npm_install_deps() {
  if [[ "$SKIP_DEPS" == "1" ]]; then
    if [[ -d "${INSTALL_DIR}/node_modules" ]]; then
      info "已按 --skip-deps 跳过依赖安装（保留现有 node_modules）"
    else
      warn "已按 --skip-deps 跳过依赖安装，但 ${INSTALL_DIR}/node_modules 不存在 —— 服务将无法启动。"
      warn "  请自行执行：cd ${INSTALL_DIR} && npm ci --omit=dev"
    fi
    return 0
  fi

  info "安装生产依赖（npm ci --omit=dev）…"
  local rc=0
  mark_log
  run bash -c "cd '$INSTALL_DIR' && npm ci --omit=dev --no-audit --no-fund $(npm_registry_args)" || rc=$?
  if ((rc != 0)); then
    warn "npm ci 失败（可能缺 package-lock.json 或网络受限），改用 npm install 重试…"
    rc=0
    run bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund $(npm_registry_args)" || rc=$?
  fi
  if ((rc != 0)) && [[ "$MIRROR" != "cn" ]]; then
    warn "默认 registry 安装失败，改用国内镜像重试…"
    rc=0
    run bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com" || rc=$?
  fi
  if ((rc != 0)); then
    HINTS=()
    add_hint "安装目录：${INSTALL_DIR}"
    add_hint ""
    local l
    while IFS= read -r l; do [[ -n "$l" ]] && add_hint "  日志 | ${l}"; done <<<"$(log_key_lines 5)"
    add_hint ""
    add_hint "常见原因：registry 不可达 / 代理未配置 / 磁盘空间不足 / 缺编译型依赖的系统库。"
    add_hint "  1) 手动安装：cd ${INSTALL_DIR} && npm ci --omit=dev"
    add_hint "  2) 走国内镜像：cd ${INSTALL_DIR} && npm ci --omit=dev --registry=https://registry.npmmirror.com"
    add_hint "  3) 重跑并指定镜像：$(rerun_cmd --mirror cn)"
    add_hint "  4) 自己装完后跳过这步：$(rerun_cmd --skip-deps)"
    die_with_hint "npm 依赖安装失败（已尝试 npm ci / npm install / 国内镜像）" "${HINTS[@]}"
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
# 找「不是系统包装的 nginx」：宝塔/AMH/编译版/官方二进制常常不在 PATH 里。
# 找到就把所在目录临时加进 PATH，后续 nginx / nginx -t / nginx -s reload 都能用对这一份。
locate_nginx() {
  if have nginx; then NGINX_BIN="$(command -v nginx)"; return 0; fi
  local -a paths=(
    /www/server/nginx/sbin/nginx            # 宝塔面板
    /usr/local/nginx/sbin/nginx             # 编译安装
    /usr/local/openresty/nginx/sbin/nginx   # OpenResty
    /opt/nginx/sbin/nginx
    /usr/sbin/nginx
    /usr/local/sbin/nginx
  )
  local p
  for p in "${paths[@]}"; do
    if [[ -x "$p" ]]; then
      export PATH="$(dirname "$p"):$PATH"
      NGINX_BIN="$p"
      ok "发现非系统包安装的 Nginx：${p}（已临时加入 PATH）"
      return 0
    fi
  done
  return 1
}

install_nginx() {
  if [[ "$SKIP_NGINX" == "1" ]]; then
    warn "已按 --skip-nginx 跳过 Nginx 安装与反代配置。"
    warn "  请自行把 ${APP_PORT} 端口反代出去，并务必转发 X-Forwarded-Proto: https（应用已设 TRUST_PROXY=1）。"
    return 1
  fi
  if ! have nginx; then locate_nginx; fi
  if have nginx; then
    ok "Nginx 已安装：$(nginx -v 2>&1 | sed 's/.*nginx\///')"
  else
    info "安装 Nginx…"
    pkg_install nginx
    if ! have nginx && [[ "$PM" == "dnf" || "$PM" == "yum" ]]; then
      # RHEL 系的 nginx 在 EPEL 源里
      info "未找到 nginx，尝试启用 EPEL 源后重试…"
      run_soft "$PM" install -y epel-release
      if ! have nginx; then pkg_install nginx; fi
    fi
    # 系统包装不上，再找一遍面板/编译版（很多机器其实已经有 nginx，只是没进 PATH）
    if ! have nginx; then locate_nginx; fi
    if ! have nginx; then
      HINTS=()
      add_hint "Nginx 是外网访问的入口（TLS 终结 + 反向代理）。可这样修："
      add_hint ""
      case "$PM" in
        apt)
          add_hint "  apt-get update && apt-get install -y nginx" ;;
        dnf|yum)
          add_hint "  1) 启用 EPEL：$(epel_rpm_cmd)"
          add_hint "  2) 或启用官方模块：${PM} module reset -y nginx && ${PM} module enable -y nginx:1.24 && $(pm_install_cmd) nginx"
          add_hint "  3) 确认源里有包：${PM} search nginx ; ${PM} module list nginx" ;;
        apk)
          add_hint "  apk update && apk add nginx（确认 /etc/apk/repositories 已启用社区源）" ;;
        *)
          add_hint "  zypper refresh && zypper --non-interactive install nginx" ;;
      esac
      if grep -qiE 'exclude filtering|filtered out by exclude' <<<"$(log_since_mark)"; then
        add_hint ""
        add_hint "  【补充判断】包管理器把 nginx 排除掉了（exclude=nginx）—— 面板/自建环境的典型做法，"
        add_hint "  说明这台机器本来就有 Nginx，只是没进 PATH。确认一下："
        add_hint "    grep -rn '^exclude' /etc/yum.conf /etc/dnf/dnf.conf /etc/yum.repos.d/ 2>/dev/null"
        add_hint "    ls -l /www/server/nginx/sbin/nginx /usr/local/nginx/sbin/nginx 2>/dev/null"
        add_hint "  找到后加进 PATH 再重跑（脚本会自动识别）：export PATH=\$PATH:<nginx 所在目录>"
      fi
      add_hint "  4) 查看包管理器报错：tail -n 80 ${LOG_FILE}"
      add_hint ""
      add_hint "装好后重跑：$(rerun_cmd)"
      add_hint "或用现成的 Caddy / 已有 Nginx 自己反代，让脚本不碰这步："
      add_hint "    $(rerun_cmd --skip-nginx)"
      add_hint "    反代要点：proxy_pass http://127.0.0.1:${APP_PORT}; 并带 X-Forwarded-Proto \$scheme"
      die_with_hint "Nginx 安装失败" "${HINTS[@]}"
    fi
    ok "Nginx 安装完成"
  fi
  mkdir -p "$WEBROOT/.well-known/acme-challenge"
  nginx_detect_layout || true
}

# 探测 Nginx 的真实配置体系。
# 很多机器（宝塔/AMH/自建编译/官方镜像）的 nginx 并不用 /etc/nginx/conf.d：
# 直接照抄 Debian/RHEL 惯例写过去，配置根本不会被 include，站点也就不会生效。
# 这里从「nginx -V 的 --conf-path」拿到主配置，再从主配置的 include 规则里挑真实目录。
nginx_detect_layout() {
  NGINX_BIN="$(command -v nginx || true)"
  NGINX_CONF_PATH=""
  NGINX_CONF_DIR=""
  NGINX_LINK=""
  if [[ -z "$NGINX_BIN" ]]; then
    NGINX_CONF="/etc/nginx/conf.d/${SERVICE_NAME}.conf"
    return 1
  fi
  NGINX_CONF_PATH="$("$NGINX_BIN" -V 2>&1 | tr ' ' '\n' | grep -m1 -- '--conf-path=' | cut -d= -f2- || true)"
  [[ -n "$NGINX_CONF_PATH" ]] || NGINX_CONF_PATH="/etc/nginx/nginx.conf"
  local main_dir; main_dir="$(dirname "$NGINX_CONF_PATH")"

  # 候选目录：① 主配置里带通配符的 include 目录（最可信）② 主配置同级 conf.d
  #           ③ 面板常见 vhost 目录 ④ 发行版惯例目录
  local -a cands=()
  if [[ -r "$NGINX_CONF_PATH" ]]; then
    local inc d
    while IFS= read -r inc; do
      [[ "$inc" == *'*'* ]] || continue          # 只认通配 include（排除 mime.types 之类）
      d="${inc%/*}"
      [[ "$d" == "$inc" ]] && continue
      [[ "$d" == /* ]] || d="${main_dir}/${d}"    # 相对路径按主配置目录拼接
      cands+=("$d")
    done < <(grep -oE 'include[[:space:]]+[^;]+;' "$NGINX_CONF_PATH" 2>/dev/null \
             | sed -E 's/include[[:space:]]+//; s/;$//; s/^"//; s/"$//' || true)
  fi
  cands+=("${main_dir}/conf.d" "/www/server/panel/vhost/nginx" "/etc/nginx/conf.d" "/etc/nginx/sites-enabled")

  local c
  for c in "${cands[@]}"; do
    [[ -n "$c" && -d "$c" ]] || continue
    NGINX_CONF_DIR="$c"
    break
  done
  [[ -n "$NGINX_CONF_DIR" ]] || NGINX_CONF_DIR="/etc/nginx/conf.d"

  # Debian 惯例：配置放 sites-available，靠 sites-enabled 软链启用
  if [[ "$NGINX_CONF_DIR" == "/etc/nginx/sites-enabled" ]]; then
    NGINX_CONF="/etc/nginx/sites-available/${SERVICE_NAME}.conf"
    NGINX_LINK="/etc/nginx/sites-enabled/${SERVICE_NAME}.conf"
  else
    NGINX_CONF="${NGINX_CONF_DIR}/${SERVICE_NAME}.conf"
    NGINX_LINK=""
  fi
  ok "Nginx 配置布局：主配置 ${NGINX_CONF_PATH}"
  ok "              站点配置 ${NGINX_CONF}"
  if [[ "$NGINX_CONF_PATH" != /etc/nginx/* && -n "$NGINX_CONF_PATH" ]]; then
    info "注意：这台机器的 Nginx 不是发行版默认布局（可能由面板/编译安装），脚本已按它的实际 include 规则写入配置。"
  fi
  return 0
}

# 写完后确认这份配置真的被主配置加载了（nginx -T 会打印全部生效配置）
verify_conf_loaded() {
  [[ -n "${NGINX_BIN:-}" ]] || return 0
  local dumped
  dumped="$(nginx -T 2>/dev/null || true)"
  [[ -n "$dumped" ]] || return 0     # 老版本不支持 -T 就跳过
  # nginx -T 会以「# configuration file <路径>:」的形式打印每个被加载的文件，匹配文件名即可
  if ! grep -qF "$(basename "${NGINX_CONF}")" <<<"$dumped"; then
    warn "站点配置似乎没有被 Nginx 主配置加载：${NGINX_CONF}"
    warn "  1) 看主配置的 include 规则：grep -n include ${NGINX_CONF_PATH}"
    warn "  2) 在 ${NGINX_CONF_PATH} 的 http{} 内补一行：include ${NGINX_CONF_DIR}/*.conf;"
    warn "  3) 然后 nginx -t && nginx -s reload"
    return 1
  fi
  return 0
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

nginx_is_running() {
  pgrep -x nginx >/dev/null 2>&1 && return 0
  # 有些环境主进程名带路径前缀，退一步看监听端口
  port_in_use "${HTTP_PORT}" && return 0
  return 1
}

# Nginx 启停失败的针对性指引（宝塔/面板/端口占用都能覆盖）
nginx_ctl_failure_hints() {
  HINTS=()
  add_hint "站点配置已写入：${NGINX_CONF}"
  add_hint ""
  add_hint "  1) 看状态：systemctl status nginx --no-pager"
  add_hint "  2) 看 systemd 日志：journalctl -xeu nginx --no-pager"
  add_hint "  3) 看 Nginx 自身错误日志：tail -n 50 $(nginx_err_log)"
  add_hint "  4) 端口被谁占用：ss -ltnp | grep -E ':${HTTP_PORT}|:${HTTPS_PORT}'"
  if [[ -d /www/server/nginx ]]; then
    add_hint ""
    add_hint "  【检测到宝塔/面板环境】面板装的 Nginx 通常是 sysv 服务，systemd 包装经常起不来，改用下面任一方式："
    add_hint "    nginx -t && nginx -s reload"
    add_hint "    /etc/init.d/nginx restart"
    add_hint "    或宝塔面板 → 软件商店 → Nginx → 重启/重载配置"
    add_hint "  若面板已有站点占用 ${HTTP_PORT}/${HTTPS_PORT}：停用冲突站点，或用 --http-port/--https-port 换端口"
  elif [[ -x /etc/init.d/nginx ]]; then
    add_hint ""
    add_hint "  本机有 sysv 启动脚本，可直接：/etc/init.d/nginx restart"
  fi
  add_hint ""
  add_hint "  处理好后重跑：$(rerun_cmd)"
  add_hint "  或让脚本不再管 Nginx：$(rerun_cmd --skip-nginx)"
}

# 猜 Nginx 错误日志路径（用于提示）
nginx_err_log() {
  local p=""
  p="$(nginx -V 2>&1 | tr ' ' '\n' | grep -m1 -- '--error-log-path=' | cut -d= -f2- || true)"
  [[ -n "$p" ]] || p="/var/log/nginx/error.log"
  printf '%s' "$p"
}

# 同名站点冲突：面板里若已给这个域名建过站点，请求可能命中旧的那一个
check_server_name_conflict() {
  [[ -n "${NGINX_BIN:-}" ]] || return 0
  local dumped; dumped="$(nginx -T 2>/dev/null || true)"
  [[ -n "$dumped" ]] || return 0
  # 只统计「不同配置文件」里出现该域名的次数 —— 我们自己的配置里
  # 本来就有 80 跳转 + 443 两个 server 块用同一个域名，不能算冲突。
  # nginx -T 会以 "# configuration file <路径>:" 标出每段归属的文件。
  local files
  files="$(awk -v d="${DOMAIN}" '
      /^# configuration file / { f = $4; sub(/:$/, "", f) }
      index($0, "server_name") && index($0, d) { if (f != "") print f }
    ' <<<"$dumped" | sort -u | wc -l)"
  files="${files//[[:space:]]/}"
  if [[ "${files:-0}" =~ ^[0-9]+$ ]] && ((files > 1)); then
    warn "Nginx 里有 ${files} 个配置文件都用到了域名 ${DOMAIN}（可能在面板里已建过同名站点）"
    warn "  请求可能命中旧站点。请停用/删除旧站点，或在面板里把该域名的反代指向 http://127.0.0.1:${APP_PORT}"
    return 1
  fi
  return 0
}

# 让新配置生效：能 reload 就 reload，没在跑才 start；多种控制方式依次兜底
nginx_ctl() {
  local rc=0
  if nginx_is_running; then
    info "Nginx 已在运行，重载配置…"
    run nginx -s reload || rc=$?
    if ((rc != 0)) && [[ "$INIT_SYSTEM" == "systemd" ]]; then
      rc=0; run systemctl reload nginx || rc=$?
    fi
    if ((rc != 0)) && [[ -x /etc/init.d/nginx ]]; then
      rc=0; run /etc/init.d/nginx reload || rc=$?
    fi
  else
    info "Nginx 未运行，尝试启动…"
    if [[ "$INIT_SYSTEM" == "systemd" ]]; then
      run systemctl start nginx || rc=$?
    else
      rc=1
    fi
    if ((rc != 0)) && [[ -x /etc/init.d/nginx ]]; then
      rc=0; run /etc/init.d/nginx start || rc=$?
    fi
    if ((rc != 0)) && [[ -n "${NGINX_BIN:-}" ]]; then
      # 直接拉起二进制（nginx 默认 daemon 模式，会自行转后台）
      rc=0; run "$NGINX_BIN" || rc=$?
    fi
  fi
  return "$rc"
}

nginx_apply() {
  mark_log
  if ! nginx -t >>"$LOG_FILE" 2>&1; then
    HINTS=()
    add_hint "配置文件：${NGINX_CONF}（主配置 ${NGINX_CONF_PATH:-未知}）"
    add_hint ""
    local l
    while IFS= read -r l; do [[ -n "$l" ]] && add_hint "  日志 | ${l}"; done <<<"$(log_key_lines 6)"
    add_hint ""
    add_hint "  手工校验看完整报错：nginx -t"
    add_hint "  常见原因：${HTTP_PORT}/${HTTPS_PORT} 上已有 default_server 冲突、证书路径不存在、include 目录不对"
    die_with_hint "Nginx 配置校验失败（nginx -t 未通过）" "${HINTS[@]}"
  fi

  # 开机自启：sysv/面板环境下这一步常报「not a native service」，失败无所谓
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    run_soft systemctl enable nginx
  fi

  local rc=0
  nginx_ctl || rc=$?
  if ((rc != 0)); then
    nginx_ctl_failure_hints
    warn_with_hint "Nginx 未能启动/重载（部署继续，但站点需要你手动拉起 Nginx）" "${HINTS[@]}"
    # 只警告不向上抛失败：配置文件已落盘，用户手动 reload 即可生效
    return 0
  fi
  verify_conf_loaded || true
  check_server_name_conflict || true
  ok "Nginx 已应用配置并运行"
  return 0
}

# ------------------------------------------------------------------------------
# 8. HTTPS 证书
# ------------------------------------------------------------------------------
SELF_SIGNED_DIR="/etc/${SERVICE_NAME}/ssl"
CERT_FULLCHAIN="${CERT_FULLCHAIN:-}"
CERT_KEY="${CERT_KEY:-}"

gen_self_signed() {
  mkdir -p "$SELF_SIGNED_DIR"
  local key="${SELF_SIGNED_DIR}/privkey.pem" crt="${SELF_SIGNED_DIR}/fullchain.pem"
  if [[ -s "$key" && -s "$crt" ]]; then
    info "已存在自签名证书，复用：${crt}"
  else
    have openssl || pkg_install openssl
    info "生成自签名证书（有效期 825 天）…"
    local rc=0
    run openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$key" -out "$crt" -subj "/CN=${DOMAIN}" \
      -addext "subjectAltName=DNS:${DOMAIN},DNS:localhost,IP:127.0.0.1" || rc=$?
    if ((rc != 0)); then
      HINTS=()
      add_hint "  手工生成（放到 ${SELF_SIGNED_DIR}）："
      add_hint "    mkdir -p ${SELF_SIGNED_DIR}"
      add_hint "    openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout ${SELF_SIGNED_DIR}/privkey.pem -out ${SELF_SIGNED_DIR}/fullchain.pem -subj \"/CN=${DOMAIN}\""
      add_hint "  或直接改用 Let's Encrypt（需 80 端口可达）：$(rerun_cmd --tls letsencrypt)"
      die_with_hint "自签名证书生成失败（openssl 不可用或参数不被支持）" "${HINTS[@]}"
    fi
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

# Let's Encrypt 签发失败的针对性指引（非致命：脚本会回退自签名）
le_failure_hints() {
  local tail_log; tail_log="$(log_since_mark)"
  HINTS=()
  add_hint "已自动回退到自签名证书（功能不受影响，浏览器会提示不安全）。要换正式证书，请对症处理："
  add_hint ""
  if grep -qiE 'connection refused|timed out|timeout|could not connect|unreachable|fetch' <<<"$tail_log"; then
    add_hint "  【判断】80 端口对外不通（HTTP-01 校验需要外网能访问本机 80 端口）。"
    add_hint "    1) 云厂商安全组放行 80/443；本机防火墙：ufw allow 80,443/tcp 或 firewall-cmd --add-service=http --add-service=https --permanent && firewall-cmd --reload"
    add_hint "    2) 确认 Nginx 在监听：ss -ltnp | grep ':80'"
    add_hint "    3) 确认没有别的程序占用 80：ss -ltnp | grep ':80'"
  elif grep -qiE 'unauthorized|invalid response|403|404' <<<"$tail_log"; then
    add_hint "  【判断】域名解析到的机器不是本机，或请求被 CDN 拦截。"
    add_hint "    1) 核对解析：dig +short ${DOMAIN} 应等于本机公网 IP（curl -s https://api.ipify.org）"
    add_hint "    2) 走 Cloudflare 等 CDN 时先临时关闭代理（灰云），或改用 DNS-01 校验"
  elif grep -qiE 'rate limit|too many|exceeded' <<<"$tail_log"; then
    add_hint "  【判断】触发 Let's Encrypt 频次限制（同一域名每周 5 张）。"
    add_hint "    1) 稍后再试；先用测试环境验证流程：--staging"
    add_hint "    2) 或先 --tls selfsigned 把站点跑起来，过几天再换正式证书"
  elif grep -qiE 'nxdomain|no valid ip|dns problem|dns-01' <<<"$tail_log"; then
    add_hint "  【判断】域名解析异常。先在 DNS 控制台加 A 记录指向本机公网 IP，等生效后重试。"
  else
    add_hint "  【判断】未能自动识别原因，查看日志：tail -n 60 ${LOG_FILE}"
  fi
  add_hint "  日志关键行："
  local l
  while IFS= read -r l; do [[ -n "$l" ]] && add_hint "    | ${l}"; done <<<"$(log_key_lines 4)"
  add_hint ""
  add_hint "处理好后重跑即可自动换成正式证书（不会重复建站，只换证书）："
  add_hint "    $(rerun_cmd --tls letsencrypt)"
  warn_with_hint "Let's Encrypt 证书签发失败" "${HINTS[@]}"
}

issue_letsencrypt() {
  info "准备通过 Let's Encrypt 签发证书…"
  domain_resolves_here || warn "域名解析检测未通过，仍会尝试签发（HTTP-01 需要 80 端口可被外网访问）。"

  if ! ensure_certbot; then
    warn "certbot 不可用（RHEL 系通常在 EPEL 源里：$(epel_rpm_cmd)），改用 acme.sh 申请证书…"
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

  mark_log
  if ! run certbot "${args[@]}"; then
    le_failure_hints
    return 1
  fi
  local live="/etc/letsencrypt/live/${DOMAIN}"
  if [[ ! -s "${live}/fullchain.pem" || ! -s "${live}/privkey.pem" ]]; then
    le_failure_hints
    return 1
  fi
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
# 端口占用探测：返回 0 表示已被占用（ss/netstat/lsof 任一可用即可）
port_in_use() {
  local port="$1"
  if have ss; then ss -ltn 2>/dev/null | grep -qE ":${port}\b" && return 0; fi
  if have netstat; then netstat -ltn 2>/dev/null | grep -qE ":${port}\b" && return 0; fi
  if have lsof; then lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1 && return 0; fi
  return 1
}

# 服务起不来时的排查指引（非致命，交给 wait_for_service 兜底）
service_failure_hints() {
  local kind="$1"
  HINTS=()
  add_hint ""
  if [[ "$kind" == "systemd" ]]; then
    add_hint "  1) 看日志：journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    add_hint "  2) 看状态：systemctl status ${SERVICE_NAME} --no-pager"
    add_hint "  3) 端口被占：ss -ltnp | grep ':${APP_PORT}'（换端口重跑：--port 3001）"
    add_hint "  4) 单实例锁：本应用只能跑一个实例，检查是否已有进程在跑 ——"
    add_hint "     ps aux | grep -E 'server/index.js' | grep -v grep"
    add_hint "  5) 依赖缺失：ls ${INSTALL_DIR}/node_modules | head（为空则没装依赖）"
    add_hint "  6) 手工前台跑一次看报错：cd ${INSTALL_DIR} && env \$(grep -v '^#' .env | xargs) ${NODE_BIN} server/index.js"
    add_hint "  7) 不想让脚本管进程（用 pm2/supervisor 自己起）：$(rerun_cmd --skip-service)"
  else
    add_hint "  1) 看日志：cd ${INSTALL_DIR} && docker compose logs --tail=100"
    add_hint "  2) 看状态：cd ${INSTALL_DIR} && docker compose ps"
    add_hint "  3) 端口被占：ss -ltnp | grep ':${APP_PORT}'"
    add_hint "  4) 重新构建：cd ${INSTALL_DIR} && docker compose up -d --build --force-recreate"
    add_hint "  5) 或改用 systemd 直接跑（更省事）：$(rerun_cmd --mode systemd)"
  fi
}

# 启动前的端口预检：端口被别人占着就先说清楚，避免服务反复重启
check_port_free() {
  if port_in_use "$APP_PORT"; then
    local owner=""
    if have ss; then owner="$(ss -ltnp 2>/dev/null | grep -E ":${APP_PORT}\b" | head -n1)"; fi
    warn "端口 ${APP_PORT} 已被占用：${owner:-（未能识别进程）}"
    warn "  · 若占用者就是本服务的旧实例，脚本会重启它，无需处理；"
    warn "  · 若是其它程序，请用 --port <其它端口> 重跑，例如：$(rerun_cmd --port $((APP_PORT + 1)))"
  fi
}

setup_systemd_service() {
  if [[ "$SKIP_SERVICE" == "1" ]]; then
    warn "已按 --skip-service 跳过服务创建（脚本不会创建/重启 systemd 单元）。"
    plain "  自行启动示例："
    plain "    cd ${INSTALL_DIR} && env \$(grep -v '^#' .env | xargs) ${NODE_BIN} server/index.js"
    plain "    或用 pm2：npm i -g pm2 && cd ${INSTALL_DIR} && pm2 start server/index.js --name ${SERVICE_NAME} --env production && pm2 save && pm2 startup"
    return 1
  fi
  [[ "$INIT_SYSTEM" == "systemd" ]] || die_with_hint "本机不是 systemd 环境，无法创建 systemd 服务" \
    "  · 容器/无 systemd 的环境请改用：$(rerun_cmd --mode docker)" \
    "  · 或自己用 pm2/supervisor 守护，让脚本跳过这步：$(rerun_cmd --skip-service)" \
    "  · 服务启动命令：cd ${INSTALL_DIR} && ${NODE_BIN} server/index.js"
  check_port_free
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
Documentation=https://github.com/xingsenfirst/Kepler
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
  local rc=0
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    run systemctl restart "$SERVICE_NAME" || rc=$?
  else
    run systemctl start "$SERVICE_NAME" || rc=$?
  fi
  if ((rc != 0)) || ! systemctl is-active --quiet "$SERVICE_NAME"; then
    service_failure_hints systemd
    warn_with_hint "systemd 服务未能启动（部署继续，但应用可能没起来）" "${HINTS[@]}"
    return 1
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
  if ! have docker; then
    HINTS=()
    add_hint "本机没有可用 docker。可这样修："
    add_hint "  1) 官方脚本：curl -fsSL https://get.docker.com | sh"
    add_hint "  2) 国内加速：curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun"
    add_hint "  3) 发行版包：apt-get install -y docker.io docker-compose-plugin / $(pm_install_cmd) docker docker-compose-plugin"
    add_hint "  4) 装完启动：systemctl enable --now docker"
    add_hint ""
    add_hint "也可以干脆不用容器（更省事，推荐）："
    add_hint "    $(rerun_cmd --mode systemd)"
    add_hint "    或先只装依赖、服务自己用 pm2/supervisor 管：$(rerun_cmd --mode systemd --skip-service)"
    die_with_hint "Docker 安装失败" "${HINTS[@]}"
  fi
  if ! docker compose version >/dev/null 2>&1; then
    info "安装 docker compose 插件…"
    run_soft "$PM" install -y docker-compose-plugin
    if ! docker compose version >/dev/null 2>&1; then
      local plugin_dir="/usr/local/lib/docker/cli-plugins"
      mkdir -p "$plugin_dir"
      run_soft curl -fsSL --retry 3 --max-time 300 \
        -o "${plugin_dir}/docker-compose" \
        "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH_RAW}"
      chmod +x "${plugin_dir}/docker-compose" 2>/dev/null || true
    fi
  fi
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    run_soft systemctl enable --now docker
  else
    run_soft bash -c 'service docker start || true'
  fi
  if ! docker compose version >/dev/null 2>&1; then
    HINTS=()
    add_hint "docker 已安装但缺少 compose 插件。可这样修："
    add_hint "  1) 发行版包：apt-get install -y docker-compose-plugin / $(pm_install_cmd) docker-compose-plugin"
    add_hint "  2) 手工放插件：mkdir -p /usr/local/lib/docker/cli-plugins && curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${ARCH_RAW} && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose"
    add_hint "  3) 或直接换 systemd 方式：$(rerun_cmd --mode systemd)"
    die_with_hint "docker compose 不可用" "${HINTS[@]}"
  fi
  ok "Docker 环境就绪：$(docker compose version --short 2>/dev/null || echo compose)"
}

write_docker_compose() {
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
}

setup_docker_service() {
  check_port_free
  write_docker_compose

  # 容器内以 uid/gid 1000（node 用户）运行，宿主数据目录需对齐权限，否则无法写入
  mkdir -p "$DATA_DIR"
  run_soft chown -R 1000:1000 "$DATA_DIR"
  chmod 0770 "$DATA_DIR" || true

  if [[ "$SKIP_SERVICE" == "1" ]]; then
    warn "已按 --skip-service 跳过容器创建（docker-compose.yml 与 .env 已生成）。"
    plain "  自行启动：cd ${INSTALL_DIR} && docker compose up -d"
    return 1
  fi
  ensure_docker

  info "构建镜像并启动容器（首次稍慢）…"
  if ! run bash -c "cd '$INSTALL_DIR' && docker compose up -d --build"; then
    service_failure_hints docker
    die_with_hint "容器启动失败" "${HINTS[@]}"
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
# 服务没起来时：自动抓日志 → 按证据给结论，而不是让用户自己瞎猜
diagnose_service() {
  HINTS=()
  local st="" j=""
  if [[ "$MODE" == "docker" ]]; then
    j="$(cd "$INSTALL_DIR" && docker compose logs --tail=60 2>/dev/null || true)"
    local cst; cst="$(cd "$INSTALL_DIR" && docker compose ps --format '{{.State}}' 2>/dev/null | head -n1 || true)"
    add_hint "容器状态：${cst:-未知}"
  elif [[ "$INIT_SYSTEM" == "systemd" ]]; then
    st="$(systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true)"
    add_hint "systemd 状态：${st:-未知}"
    j="$(journalctl -u "${SERVICE_NAME}" -n 60 --no-pager 2>/dev/null || true)"
  fi

  if [[ -n "$j" ]]; then
    add_hint ""
    add_hint "服务日志最后几行："
    local l
    while IFS= read -r l; do [[ -n "$l" ]] && add_hint "    | ${l}"; done \
      <<<"$(printf '%s\n' "$j" | grep -viE '^\s*$' | tail -n 12)"
  else
    add_hint ""
    add_hint "（没读到服务日志，可能服务从未真正启动过）"
  fi
  add_hint ""

  if grep -qiE 'EADDRINUSE|address already in use' <<<"$j"; then
    add_hint "【结论】端口 ${APP_PORT} 已被占用。"
    add_hint "  · ss -ltnp | grep ':${APP_PORT}'      # 看是谁占着"
    add_hint "  · ps aux | grep 'server/index.js' | grep -v grep   # 本应用只允许一个实例"
    add_hint "  · 换端口重跑：$(rerun_cmd --port $((APP_PORT + 1)))"
  elif grep -qiE 'Cannot find module|MODULE_NOT_FOUND' <<<"$j"; then
    add_hint "【结论】依赖缺失：node_modules 不完整。"
    add_hint "  · cd ${INSTALL_DIR} && npm ci --omit=dev"
    add_hint "  · 或重跑让脚本重装：$(rerun_cmd)"
  elif grep -qiE 'EACCES|permission denied|EPERM' <<<"$j"; then
    add_hint "【结论】权限不足：${RUN_USER} 无法读写数据/安装目录。"
    add_hint "  · chown -R ${RUN_USER}:${RUN_USER} ${INSTALL_DIR} ${DATA_DIR} && chmod 0750 ${DATA_DIR}"
    add_hint "  · systemctl restart ${SERVICE_NAME}"
    add_hint "  · RHEL 系还要看 SELinux：getenforce（Enforcing 时打标签或临时 setenforce 0 验证）"
  elif grep -qiE 'instance|lock|already running' <<<"$j"; then
    add_hint "【结论】单实例锁：同一 data 目录只允许一个进程。"
    add_hint "  · ps aux | grep 'server/index.js' | grep -v grep"
    add_hint "  · 确认没有残留进程后：systemctl restart ${SERVICE_NAME}"
    add_hint "  · 仍不行就检查 ${DATA_DIR} 下的锁文件残留"
  elif grep -qiE 'SyntaxError|Unexpected token|not supported|ERR_REQUIRE_ESM' <<<"$j"; then
    add_hint "【结论】Node 版本与代码不兼容（需要 ≥ v18）。"
    add_hint "  · ${NODE_BIN:-node} -v"
    add_hint "  · 升级后用 $(rerun_cmd --skip-node) 重跑"
  elif [[ -n "$st" && "$st" != "active" ]]; then
    add_hint "【结论】服务状态是 ${st}，日志里没有匹配到已知错误模式。"
    add_hint "  · 完整日志：journalctl -u ${SERVICE_NAME} -n 200 --no-pager"
    add_hint "  · 若 systemd 里看不到日志，直接前台跑一次：cd ${INSTALL_DIR} && env \$(grep -v '^#' .env | xargs) ${NODE_BIN:-node} server/index.js"
  else
    add_hint "【结论】未能自动定位，按顺序排查："
    add_hint "  1) journalctl -u ${SERVICE_NAME} -n 100 --no-pager"
    add_hint "  2) ss -ltnp | grep ':${APP_PORT}'"
    add_hint "  3) ls ${INSTALL_DIR}/node_modules | head"
    add_hint "  4) 前台跑一次看真实报错：cd ${INSTALL_DIR} && env \$(grep -v '^#' .env | xargs) ${NODE_BIN:-node} server/index.js"
  fi

  local who=""
  if have ss; then who="$(ss -ltnp 2>/dev/null | grep ":${APP_PORT}\b" | head -n1)"; fi
  [[ -n "$who" ]] && add_hint "  端口现状：${who}"
  if have pgrep; then
    local pids; pids="$(pgrep -f 'server/index.js' 2>/dev/null | tr '\n' ' ' || true)"
    [[ -n "${pids// /}" ]] && add_hint "  已存在进程 PID：${pids}（本应用只允许一个实例）"
  fi
  if have runuser; then
    add_hint ""
    add_hint "  以服务同账号前台跑（最能还原权限问题）："
    add_hint "    cd ${INSTALL_DIR} && runuser -u ${RUN_USER} -- env \$(grep -v '^#' .env | xargs) ${NODE_BIN:-node} server/index.js"
  fi
  warn_with_hint "本地服务未在 ${APP_PORT} 端口就绪" "${HINTS[@]}"
}

wait_for_service() {
  local url="http://127.0.0.1:${APP_PORT}/"
  local i code
  for i in $(seq 1 30); do
    code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$url" 2>/dev/null || true)"
    if [[ "$code" == "200" || "$code" == "302" || "$code" == "301" ]]; then
      ok "应用已就绪（本地 ${url} 返回 ${code}）"
      SERVICE_READY=1
      return 0
    fi
    sleep 1
  done
  SERVICE_READY=0
  diagnose_service
  return 0
}

# 外网探测：按状态码给不同结论（000 与 502 的排查方向完全不同）
external_check() {
  local scheme="https"; [[ "$TLS_MODE" == "none" ]] && scheme="http"
  local port_part=""; [[ ("$scheme" == "https" && "$HTTPS_PORT" != "443") || ("$scheme" == "http" && "$HTTP_PORT" != "80") ]] \
    && port_part=":$( [[ "$scheme" == "https" ]] && echo "$HTTPS_PORT" || echo "$HTTP_PORT" )"
  local url="${scheme}://${DOMAIN}${port_part}${SUB_PATH}"
  local code
  # 注意：curl 失败时 -w 已会输出 000，这里不能再追加一个 000（否则出现 000000）
  code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' -k "$url" 2>/dev/null || true)"
  [[ -n "$code" ]] || code="000"

  if [[ "$code" == "200" || "$code" == "301" || "$code" == "302" ]]; then
    ok "外网访问探测成功：${url}（HTTP ${code}）"
    EXT_OK=1
    return 0
  fi

  EXT_OK=0
  HINTS=()
  case "$code" in
    000)
      add_hint "【结论】从本机访问 ${url} 根本连不上。"
      if [[ "${NGINX_OK:-1}" == "1" ]]; then
        add_hint "  1) Nginx 是否在监听：ss -ltnp | grep -E ':${HTTP_PORT}|:${HTTPS_PORT}'"
        add_hint "  2) 云厂商安全组放行 ${HTTP_PORT}/${HTTPS_PORT}；本机防火墙：firewall-cmd --list-ports 或 ufw status"
        add_hint "  3) 面板环境：站点配置可能没被主配置加载，或没点「重载配置」——"
        add_hint "     nginx -T | grep -n ${SERVICE_NAME}    # 看不到就说明没加载"
      else
        add_hint "  1) 本次未配置 Nginx，外网自然连不上 —— 需把 ${APP_PORT} 反代出去后才有外网入口"
      fi
      add_hint "  4) 本机自检：curl -Ik ${url}" ;;
    502|503|504)
      add_hint "【结论】Nginx 通了，但它反代的上游没响应 —— 应用没起来或端口不对。"
      add_hint "  1) 本地自检：curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:${APP_PORT}/"
      add_hint "  2) 应用日志：journalctl -u ${SERVICE_NAME} -n 100 --no-pager" ;;
    404)
      add_hint "【结论】能连上但 404：请求多半命中了别的站点（面板默认站点 / 同名旧站点）。"
      add_hint "  1) nginx -T | grep -n ${SERVICE_NAME}     # 确认我们的配置被加载"
      add_hint "  2) 面板里停用同名旧站点，或把它的反代指向 http://127.0.0.1:${APP_PORT}" ;;
    301|302)
      add_hint "【结论】返回跳转但探测未就绪，注意别形成重定向循环。"
      add_hint "  1) 确认 .env 里 TRUST_PROXY=1 且 Nginx 转发了 X-Forwarded-Proto \$scheme"
      add_hint "  2) curl -IL ${url}" ;;
    *)
      add_hint "【结论】返回 HTTP ${code}，看 Nginx 错误日志定位：tail -n 50 $(nginx_err_log)" ;;
  esac
  warn_with_hint "外网探测未通过：${url}（HTTP ${code}）" "${HINTS[@]}"
  return 0
}

# 把普通字符串编码成 JSON 字符串字面量（不含外层引号），用于安全地把值传进 node -e
json_quote() {
  local s="${1-}" out=""
  out="${s//\\/\\\\}"
  out="${out//\"/\\\"}"
  out="${out//$'\n'/\\n}"
  out="${out//$'\r'/\\r}"
  out="${out//$'\t'/\\t}"
  printf '%s' "$out"
}

# ------------------------------------------------------------------------------
# 12. 全局管理命令与运行中配置维护
# ------------------------------------------------------------------------------
install_global_command() {
  local target="${INSTALL_DIR}/deploy.sh"
  local content='#!/usr/bin/env bash
set -e
TARGET="__TARGET__"
if [[ "$#" -eq 0 ]]; then set -- --manage; fi
if [[ "$(id -u)" -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$TARGET" "$@"
  fi
  printf "%s\n" "[错误] kepler 管理操作需要 root 权限，请执行：sudo kepler" >&2
  exit 1
fi
exec bash "$TARGET" "$@"'
  content="${content/__TARGET__/$target}"
  write_file "$GLOBAL_COMMAND" "$content" 0755
  ok "已注册全局管理命令：${GLOBAL_COMMAND}（终端输入 kepler 使用）"
}

managed_service_stop() {
  [[ "$SKIP_SERVICE" != "1" ]] || die "当前部署未由脚本管理进程，无法自动停服。"
  if [[ "$MODE" == "docker" ]]; then
    have docker || die "未找到 docker，无法维护容器服务。"
    run bash -c "cd '$INSTALL_DIR' && docker compose down"
  else
    [[ "$INIT_SYSTEM" == "systemd" ]] || die "当前环境不可用 systemd。"
    run systemctl stop "$SERVICE_NAME"
  fi
}

managed_service_start() {
  if [[ "$MODE" == "docker" ]]; then
    run bash -c "cd '$INSTALL_DIR' && docker compose up -d --no-build"
  else
    run systemctl start "$SERVICE_NAME"
  fi
}

update_initial_admin() {
  local field="$1" value="$2" label="密码"
  [[ "$field" == "username" ]] && label="用户名"
  [[ -d "$INSTALL_DIR/server" ]] || die "安装目录不完整：${INSTALL_DIR}"
  [[ -n "$value" ]] || die "新值不能为空。"
  [[ "$field" == "username" || "$field" == "password" ]] || die "不支持的管理员修改字段：${field}"

  local script
  script="$(cat <<'NODE'
const store = require('./server/config-store');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => { main().catch(fail); });

async function main() {
  const field = process.argv[1];
  let value = input.replace(/\r?\n$/, '');
  try {
    const decoded = JSON.parse(input);
    if (typeof decoded === 'string') value = decoded;
  } catch (e) { /* 非 JSON 输入（无换行结尾的管道）时按原文处理 */ }
  const admins = store.listUsers()
    .filter((user) => user.role === 'admin')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  if (!admins.length) throw new Error('尚未创建初始管理员，请先打开网页完成首次初始化');
  const patch = field === 'username' ? { username: value } : { password: value };
  const user = await store.updateUser(admins[0].id, patch);
  await store.flush();
  process.stdout.write(`updated:${user.username}\n`);
}

function fail(error) {
  process.stderr.write(`[管理员配置失败] ${error.message || error}\n`);
  process.exitCode = 1;
}
NODE
)"

  if [[ "$MODE" != "docker" ]]; then
    [[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || NODE_BIN="$(command -v node || true)"
    [[ -n "$NODE_BIN" ]] || die "未找到 Node.js，无法修改管理员配置。"
  fi
  info "将短暂停止服务，以原子方式修改初始管理员${label}（一次性进程更新配置，不打印任何凭据）。"
  managed_service_stop
  local rc=0
  if [[ "$MODE" == "docker" ]]; then
    if (cd "$INSTALL_DIR" && printf '%s' "$(json_quote "$value")" | docker compose run --rm --no-deps -T --entrypoint node "$SERVICE_NAME" -e "$script" "$field") >>"$LOG_FILE" 2>&1; then
      :
    else
      rc=$?
    fi
  else
    if (cd "$INSTALL_DIR" && printf '%s' "$value" | env NODE_ENV=production COS_DATA_DIR="$DATA_DIR" "$NODE_BIN" -e "$script" "$field") >>"$LOG_FILE" 2>&1; then
      :
    else
      rc=$?
    fi
    chown -R "${RUN_USER}:${RUN_USER}" "$DATA_DIR" 2>/dev/null || true
  fi

  if ! managed_service_start; then
    die "管理员配置处理后服务未能重新启动，请查看 ${LOG_FILE}。"
  fi
  if ((rc != 0)); then
    err "管理员配置修改失败，服务已恢复启动。"
    log_key_lines 6 >&2 || true
    return "$rc"
  fi
  ok "初始管理员${label}已修改；旧会话已随服务重启失效。"
}

prompt_admin_username() {
  local value=""
  read -r -p "新的初始管理员用户名（2-32 位，回车取消）: " value || return 0
  [[ -n "$value" ]] || { log "已取消。"; return 0; }
  update_initial_admin username "$value"
}

prompt_admin_password() {
  local first="" second=""
  read -r -s -p "新的初始管理员密码（6-128 位，回车取消）: " first || return 0
  printf '\n'
  [[ -n "$first" ]] || { log "已取消。"; return 0; }
  read -r -s -p "再次输入新密码: " second || return 0
  printf '\n'
  [[ "$first" == "$second" ]] || { warn "两次输入的密码不一致，未做修改。"; return 0; }
  update_initial_admin password "$first"
  first=""; second=""
}

apply_port_change() {
  local new_port="$1"
  [[ "$new_port" =~ ^[0-9]+$ ]] && ((new_port >= 1 && new_port <= 65535)) || die "端口不合法：${new_port}"
  [[ "$new_port" != "$HTTP_PORT" && "$new_port" != "$HTTPS_PORT" ]] || die "应用端口不能与 Nginx 对外端口相同。"
  [[ "$new_port" != "3443" && "$new_port" != "8443" ]] || die "应用端口不能使用 3443 或 8443（应用内置 HTTPS/WebDAV 已占用）。"
  [[ "$new_port" != "$APP_PORT" ]] || { info "端口未变化：${APP_PORT}"; return 0; }
  if port_in_use "$new_port"; then
    warn "端口 ${new_port} 当前已被占用，修改后可能与其他进程冲突。"
  fi

  APP_PORT="$new_port"
  gen_env_file
  if [[ "$MODE" == "docker" ]]; then write_docker_compose; fi
  # 先持久化目标状态：即使后续重启失败，下一次 kepler 维护也会基于同一配置继续修复。
  save_state

  if [[ "$SKIP_SERVICE" != "1" ]]; then
    if [[ "$MODE" == "docker" ]]; then
      run bash -c "cd '$INSTALL_DIR' && docker compose up -d --no-build --force-recreate"
    else
      run systemctl restart "$SERVICE_NAME"
    fi
  fi

  if [[ "$SKIP_NGINX" != "1" ]]; then
    locate_nginx || die "未找到 Nginx，应用端口已更新为 ${APP_PORT}，请修复 Nginx 后再次执行 kepler。"
    nginx_detect_layout || true
    if [[ "$TLS_MODE" == "none" ]]; then
      write_nginx_conf 0 "" ""
      nginx_apply
    elif [[ -s "$CERT_FULLCHAIN" && -s "$CERT_KEY" ]]; then
      write_nginx_conf 1 "$CERT_FULLCHAIN" "$CERT_KEY"
      nginx_apply
    else
      warn "已保存的证书路径不可用，将重新执行 TLS 配置。"
      setup_tls
    fi
  fi
  save_state
  wait_for_service
  [[ "$SKIP_NGINX" == "1" ]] || external_check
  ok "应用端口已修改为 ${APP_PORT}，服务与 Nginx 配置均已同步。"
}

prompt_port_change() {
  local value=""
  read -r -p "新的应用内部端口 [${APP_PORT}]: " value || return 0
  [[ -n "$value" ]] || { log "已取消。"; return 0; }
  apply_port_change "$value"
}

manage_menu() {
  [[ "$STATE_LOADED" == "1" ]] || die "未找到部署状态 ${STATE_FILE}，请先执行一键部署。"
  while true; do
    log ""
    log "${C_BOLD}Kepler 管理菜单${C_RESET}"
    log "  1) 重新安装（保留数据与配置）"
    log "  2) 修改初始管理员用户名"
    log "  3) 修改初始管理员密码"
    log "  4) 修改应用端口"
    log "  5) 卸载（清理服务、应用与数据）"
    log "  0) 退出"
    local choice=""
    read -r -p "请输入编号并回车: " choice || { log "已退出。"; return 0; }
    case "$choice" in
      1)
        info "将按 ${STATE_FILE} 中的配置重新拉取源码并安装（数据目录不会被删除）。"
        rm -f "$LOCK_FILE"
        trap - EXIT
        exec bash "${INSTALL_DIR}/deploy.sh" --reinstall ;;
      2) prompt_admin_username ;;
      3) prompt_admin_password ;;
      4) prompt_port_change ;;
      5) do_uninstall; return 0 ;;
      0) log "已退出。"; return 0 ;;
      *) warn "无效编号：${choice}" ;;
    esac
  done
}

# 命令行直接执行编号：kepler 2（与菜单编号一致）
manage_action() {
  case "$1" in
    1)
      [[ -f "${INSTALL_DIR}/deploy.sh" ]] || die "未找到安装目录脚本：${INSTALL_DIR}/deploy.sh"
      info "将按 ${STATE_FILE} 中的配置重新拉取源码并安装（数据目录不会被删除）。"
      exec bash "${INSTALL_DIR}/deploy.sh" --reinstall ;;
    2) prompt_admin_username ;;
    3) prompt_admin_password ;;
    4) prompt_port_change ;;
    5) do_uninstall ;;
    0) log "已退出。" ;;
    *) die "无效编号：$1（可用：1 重新安装 / 2 改用户名 / 3 改密码 / 4 改端口 / 5 卸载 / 0 退出）" ;;
  esac
}

# ------------------------------------------------------------------------------
# 13. 卸载
# ------------------------------------------------------------------------------
safe_remove_tree() {
  local path="$1" label="$2"
  [[ -n "$path" && "$path" == /* && "$path" != / ]] || [[ "$path" =~ ^[A-Za-z]:[\\/][^\\/] ]] \
    || die "拒绝删除无效${label}路径（必须是非根的绝对路径）：${path}"
  case "$path" in
    /|/bin|/boot|/dev|/etc|/home|/lib|/lib64|/opt|/proc|/root|/run|/sbin|/srv|/sys|/tmp|/usr|/var|/home/*|/root/*|*/Desktop|*/Desktop/*|*/Downloads|*/Downloads/*|*/Documents|*/Documents/*)
      die "安全保护：拒绝递归删除高风险${label}路径 ${path}，请人工核对后处理。" ;;
  esac
  [[ ${#path} -ge 8 ]] || die "安全保护：${label}路径过短，拒绝删除：${path}"
  # 先尝试系统 rm；某些环境（如 Git Bash / MSYS2）会拒绝带盘符前缀的路径，
  # 此时退回到 Node 的递归删除（跨平台语义一致，同样只针对上面校验过的绝对路径）。
  if rm -rf -- "$path" 2>/dev/null; then
    ok "已清理${label}：${path}"
    return 0
  fi
  local node_bin="${NODE_BIN:-}"
  [[ -n "$node_bin" && -x "$node_bin" ]] || node_bin="$(command -v node || true)"
  if [[ -n "$node_bin" ]] && rm_target="$path" "$node_bin" -e 'require("fs").rmSync(process.env.rm_target, { recursive: true, force: true })' >/dev/null 2>&1; then
    ok "已清理${label}：${path}"
    return 0
  fi
  die "清理${label}失败：${path}（可手工执行：rm -rf ${path}）"
}

do_uninstall() {
  local ans=""
  local data="${DATA_DIR:-${INSTALL_DIR}/data}"
  warn "${C_BOLD}⚠️ 此操作非常危险，可能导致不可逆的数据丢失！${C_RESET}"
  warn "将停止 Kepler，并永久清理："
  plain "  服务：${SERVICE_NAME} / ${SERVICE_NAME}-docker"
  plain "  应用：${INSTALL_DIR}"
  plain "  数据：${data}（含主密钥、账户、云存储配置与统计）"
  plain "  命令：${GLOBAL_COMMAND}"
  if [[ "$ASSUME_YES" != "1" && -t 0 ]]; then
    read -r -p "确认永久卸载？请输入 DELETE 继续: " ans || true
    [[ "$ans" == "DELETE" ]] || { log "已取消。"; return 0; }
  fi

  # 必须先优雅停服，让配置存储完成 flush，再删除数据。
  if [[ "$INIT_SYSTEM" == "systemd" ]]; then
    run_soft systemctl stop "${SERVICE_NAME}"
    run_soft systemctl disable "${SERVICE_NAME}"
    run_soft systemctl stop "${SERVICE_NAME}-docker"
    run_soft systemctl disable "${SERVICE_NAME}-docker"
  fi
  if have docker && [[ -f "${INSTALL_DIR}/docker-compose.yml" ]]; then
    run_soft bash -c "cd '${INSTALL_DIR}' && docker compose down --remove-orphans --rmi local"
  fi
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service" "/etc/systemd/system/${SERVICE_NAME}-docker.service"
  [[ "$INIT_SYSTEM" == "systemd" ]] && run_soft systemctl daemon-reload

  local conf
  for conf in "$NGINX_CONF" "$NGINX_LINK" "/etc/nginx/conf.d/${SERVICE_NAME}.conf" "/etc/nginx/sites-enabled/${SERVICE_NAME}.conf" "/etc/nginx/sites-available/${SERVICE_NAME}.conf" "/www/server/panel/vhost/nginx/${SERVICE_NAME}.conf"; do
    [[ -n "$conf" ]] && rm -f -- "$conf"
  done
  if have nginx; then run_soft nginx -t && run_soft nginx -s reload; fi

  if have ufw; then
    run_soft ufw delete allow "${HTTP_PORT}/tcp"
    run_soft ufw delete allow "${HTTPS_PORT}/tcp"
  fi
  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    run_soft firewall-cmd --permanent --remove-port="${HTTP_PORT}/tcp"
    run_soft firewall-cmd --permanent --remove-port="${HTTPS_PORT}/tcp"
    run_soft firewall-cmd --reload
  fi
  rm -f "/etc/cron.d/${SERVICE_NAME}-certbot"
  if have certbot && [[ "$CERT_FULLCHAIN" == "/etc/letsencrypt/live/${DOMAIN}/"* ]]; then
    run_soft certbot delete --non-interactive --cert-name "$DOMAIN"
  fi
  if [[ -x /root/.acme.sh/acme.sh ]]; then run_soft /root/.acme.sh/acme.sh --remove -d "$DOMAIN"; fi

  rm -f -- "$GLOBAL_COMMAND"
  if [[ "$data" == "$INSTALL_DIR" || "$data" == "$INSTALL_DIR"/* ]]; then
    safe_remove_tree "$INSTALL_DIR" "安装目录（含数据）"
  else
    safe_remove_tree "$data" "数据目录"
    safe_remove_tree "$INSTALL_DIR" "安装目录"
  fi
  if id -u "$RUN_USER" >/dev/null 2>&1; then
    if have userdel; then run_soft userdel "$RUN_USER"; elif have deluser; then run_soft deluser "$RUN_USER"; fi
  fi
  rm -rf -- "$STATE_DIR"
  ok "Kepler 已完整卸载：服务、应用、数据、证书配置与全局命令均已清理。"
}

# ------------------------------------------------------------------------------
# 14. 主流程
# ------------------------------------------------------------------------------
TOTAL_STEPS=10

print_summary() {
  local scheme="https"; [[ "$TLS_MODE" == "none" ]] && scheme="http"
  local ext_port="$HTTPS_PORT"; [[ "$scheme" == "http" ]] && ext_port="$HTTP_PORT"
  local port_part=""; [[ ("$scheme" == "https" && "$ext_port" != "443") || ("$scheme" == "http" && "$ext_port" != "80") ]] && port_part=":${ext_port}"
  local url="${scheme}://${DOMAIN}${port_part}${SUB_PATH}"
  # 未配 Nginx 时给出直连地址（仅回环/内网可达）
  if [[ "${NGINX_OK:-1}" != "1" ]]; then
    url="http://${DOMAIN}:${APP_PORT}${SUB_PATH}（未配置反代，直连应用端口）"
  fi

  # 结论：全部就绪才算「部署完成」，否则明说还有几件事没成
  local -a todos=()
  if [[ "${SERVICE_READY:-0}" != "1" ]]; then
    todos+=("本地应用未在 ${APP_PORT} 端口就绪 —— 看上面的自动诊断，或 journalctl -u ${SERVICE_NAME} -n 100 --no-pager")
  fi
  if [[ "${NGINX_OK:-1}" == "1" && "${EXT_OK:-0}" != "1" ]]; then
    todos+=("外网访问未通过 —— 看上面「外网探测未通过」的分步诊断")
  fi
  if [[ "${NGINX_OK:-1}" != "1" ]]; then
    todos+=("Nginx 未由脚本配置 —— 需自建反代把 ${APP_PORT} 暴露出去（或去掉 --skip-nginx 重跑）")
  fi

  log ""
  if ((${#todos[@]} == 0)); then
    log "${C_GREEN}${C_BOLD}================ 部署完成 ================${C_RESET}"
  else
    log "${C_YELLOW}${C_BOLD}============ 部署结束，但有 ${#todos[@]} 项待处理 ============${C_RESET}"
  fi
  log ""
  if [[ "${SERVICE_READY:-0}" == "1" ]]; then
    log "  ${C_BOLD}访问地址${C_RESET}：${C_CYAN}${url}${C_RESET}"
  else
    log "  ${C_BOLD}访问地址${C_RESET}：${C_CYAN}${url}${C_RESET}  ${C_YELLOW}（应用当前未就绪，修好后才能打开）${C_RESET}"
  fi
  log ""
  log "  ${C_BOLD}常用维护命令${C_RESET}"
  if [[ "${SERVICE_OK:-1}" != "1" ]]; then
    log "    ${C_YELLOW}（本次未由脚本拉起服务，请按下面命令自行启动）${C_RESET}"
    if [[ "$MODE" == "systemd" && "$SKIP_SERVICE" != "1" ]]; then
      log "    启动    systemctl start ${SERVICE_NAME}    # 单元已写入，先看 journalctl -u ${SERVICE_NAME} -n 100 排查"
    fi
    log "    手动启动 cd ${INSTALL_DIR} && env \$(grep -v '^#' .env | xargs) ${NODE_BIN:-node} server/index.js"
    if [[ "$MODE" == "docker" ]]; then
      log "    容器启动 cd ${INSTALL_DIR} && docker compose up -d"
    fi
  elif [[ "$MODE" == "systemd" ]]; then
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
  if [[ "${NGINX_OK:-1}" == "1" ]]; then
    log "    Nginx 配置 ${NGINX_CONF}"
    log "    Nginx 校验 nginx -t && nginx -s reload（面板环境也可在面板里点「重载配置」）"
  else
    log "    Nginx 配置 （本次未配置，由你自建反代）"
  fi
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
  log "    6. 终端执行 ${C_BOLD}kepler${C_RESET} 可打开管理菜单：重装、修改初始管理员用户名/密码、修改端口或卸载。"
  log "    7. 重新执行本脚本可升级部署：会重新拉取源码并同步配置，数据目录不会被触碰。"
  if ((${#todos[@]} > 0)); then
    log ""
    log "  ${C_YELLOW}${C_BOLD}待处理（按顺序来）${C_RESET}"
    local i=1 t
    for t in "${todos[@]}"; do
      log "    ${i}) ${t}"
      i=$((i + 1))
    done
    log "    修好后重跑本脚本即可复检（幂等）：$(rerun_cmd)"
  fi
  if [[ "$SKIP_NODE" == "1" || "$SKIP_DEPS" == "1" || "$SKIP_NGINX" == "1" || "$SKIP_SERVICE" == "1" ]]; then
    log ""
    log "  ${C_BOLD}本次跳过的步骤（需你自行负责）${C_RESET}"
    [[ "$SKIP_NODE" == "1" ]]    && log "    · --skip-node    ：Node.js 由你管理，脚本只做版本校验"
    [[ "$SKIP_DEPS" == "1" ]]    && log "    · --skip-deps    ：npm 依赖未安装，需执行 cd ${INSTALL_DIR} && npm ci --omit=dev"
    [[ "$SKIP_NGINX" == "1" ]]   && log "    · --skip-nginx   ：反代与 HTTPS 由你配置，记得转发 X-Forwarded-Proto"
    [[ "$SKIP_SERVICE" == "1" ]] && log "    · --skip-service ：进程守护由你配置（pm2 / supervisor / 容器编排）"
    log "    去掉对应参数重跑即可让脚本接管：$(rerun_cmd)"
  fi
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
  if [[ "$MANAGE" == "1" ]]; then
    detect_env
    if [[ $# -gt 0 ]]; then
      manage_action "$1"
    else
      manage_menu
    fi
    exit 0
  fi

  step "环境检测与基础工具准备"
  detect_env
  need_pkgs_base

  step "部署参数确认"
  collect_config

  step "安装 Node.js 运行时"
  preflight_network
  install_node

  step "拉取源码并安装依赖"
  prepare_source
  install_app
  npm_install_deps

  step "生成环境变量与运行用户"
  create_user
  gen_env_file

  step "配置进程守护（${MODE}）"
  if [[ "$MODE" == "docker" ]]; then
    if setup_docker_service; then SERVICE_OK=1; else SERVICE_OK=0; fi
  else
    if setup_systemd_service; then SERVICE_OK=1; else SERVICE_OK=0; fi
  fi

  step "安装并配置 Nginx 反向代理"
  NGINX_OK=1
  if install_nginx; then setup_firewall; else NGINX_OK=0; fi

  step "申请并配置 HTTPS 证书（${TLS_MODE}）"
  if [[ "$NGINX_OK" == "1" ]]; then
    setup_tls || true
  else
    info "未配置 Nginx，跳过证书步骤（自建反代时请在反代层配置 HTTPS）。"
  fi

  step "健康检查"
  wait_for_service
  if [[ "$NGINX_OK" == "1" ]]; then external_check; fi

  step "保存部署状态并注册 kepler 命令"
  save_state
  install_global_command

  print_summary
}

# 被 source（而非直接执行）时只加载函数，便于静态检查与单元验证。
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
