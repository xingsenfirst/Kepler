# Kepler 项目长期记忆

## 验证约定（重要）

- **每条新护栏都要登记到 `scripts/reverse-check.js` 的 `CASES`**（项目自带反向变异台账，已有 100+ 条）。
  `tests/invariants.test.js` 会硬断言：① 每条 anchor 在各自 file 内命中（比对前会剥注释，所以 anchor 必须是代码）；
  ② 条目数 ≥ 50；③ 退役项必须写 ≥20 字原因且总数 ≤ 5。跑单条：`node scripts/reverse-check.js --only=<name 片段>`。
- **全量测试有跨文件干扰**：部分 `audit*-regressions.test.js` 会临时改写工作区文件来做变异验证。
  与它同时跑的其它测试会读到"变异态"文件而假红。实测证据：干净 HEAD 副本上，
  `deploy.sh：任何函数都不得以「短路条件」结尾` 等 3 条护栏与 `反向变异 anchor 必须在各自的 file 内命中` 会失败，
  而单跑 `tests/deploy-script.test.js` 是 10/10 绿。**判断"是不是我改坏了"要看失败名集合的差集**，
  并用干净副本（`git worktree add --detach <dir> HEAD`）取基线。
- 本机 `node_modules` 缺失 → 全量套件有 ~26 条 `Cannot find module 'express' / 'cos-nodejs-sdk-v5'` 环境性失败，忽略。

## deploy.sh（一键部署脚本）

- 入口/约定：`set -Eeuo pipefail`；被 source 时只加载函数（`[[ "${BASH_SOURCE[0]}" == "$0" ]]` 才跑 main）；
  状态文件 `/etc/kepler/deploy.conf`；单实例锁 `/var/lock/kepler-deploy.lock`（`exec` 重装用 `KEPLER_LOCK_HELD` 交接）。
- **改管理员凭据（kepler 2/3）的值必须原样经 stdin 传给 node**：两条分支（docker / systemd）都用
  `printf '%s' "$value" | ... node -e "$script" <field>`。曾有 `json_quote()` 多包一层转义 +
  内联脚本 `JSON.parse` 解码 → docker 方式下把 `\`、`"`、制表符写进真实密码（提示成功却登不上）。
- **Nginx 站点目录探测必须认 include 的语法上下文**：Debian/Ubuntu 的 `/etc/nginx/nginx.conf` 顶层就有
  `include /etc/nginx/modules-enabled/*.conf;`，且该目录在装了 nginx 的机器上必然存在 →
  只挑"第一个存在的通配 include 目录"会把站点配置写进 modules-enabled（main 上下文），
  `nginx -t` 报 `"server" directive is not allowed here`，部署在 nginx 那步断掉。
  现由 `nginx_http_include_dirs()` 只取 `http{}` 直接内部的 include（awk 数括号深度，排除 `server{}` 内嵌套）。
- **`pkg_install` 失败即 `die`**：它后面跟的兜底逻辑（如 RHEL 系 nginx 的 EPEL 重试）会成死代码。
  需要"失败还能接着兜底"时改用不中断的 `pkg_run_pm`，把诊断交给后面的提示层。
- `--domain` 不接受 `域名:端口`（`is_ip_addr` 见到冒号就判成 IP → 静默自签名 + `server_name` 带端口打挂 nginx -t）。

## 实测过的 shell 语义（省得下次重跑探针）

- bash 5.3：**SIGINT / SIGTERM 会触发 EXIT trap**（锁文件会被清理）——"Ctrl+C 后锁残留"不是缺陷；
  真正不触发 EXIT trap 的只有 `exec`。
- `local x="$(false)"` 存活；`local x; x="$(false)"` 被 `set -e` 杀掉。
- `if true; then false; fi` 作为函数体被 `set -e` 杀掉；`false && true` 作为独立语句不会（`&&` 左值豁免）。
