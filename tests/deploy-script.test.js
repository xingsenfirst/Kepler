/**
 * 部署脚本（deploy.sh）护栏
 *
 * 一键部署脚本跑在**root 权限的新机器上**，CI 里既没有 systemd 也没有 Nginx，
 * 无法真正执行一遍；但脚本错了会让用户在一台干净服务器上卡住 —— 代价很高。
 * 因此这里钉住两类最容易「改坏却没人发现」的契约：
 *
 *  1. **持久化与管理入口**：部署状态必须落盘（重跑/改端口依赖它）、必须注册
 *     全局 kepler 命令、菜单编号必须与 dispatch 分支一一对应（少一个分支就是
 *     选了没反应，多一个分支就是永远点不到）。
 *  2. **管理员凭据修改的内联脚本**：kepler 菜单改初始管理员用户名/密码靠一段
 *     `node -e` 内联脚本完成。它只做「取第一个管理员 → 改字段 → 落盘」，
 *     一旦 require 路径、字段映射或 flush 被改坏，表现是「提示成功但没生效」，
 *     属于最难自查的故障。这里用真实 config-store + 临时数据目录在 vm 里跑一遍。
 *
 * 隔离：config-store 是**模块级单例**（进程内缓存配置），因此每个测试都新建
 * Module 实例 + 设置 COS_DATA_DIR 到自己的临时目录，避免用例之间互相串数据。
 *
 * 注意：本文件只读解析脚本，且所有写入都发生在临时目录内，绝不触碰真实部署路径。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const assert = require('node:assert');
const test = require('node:test');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DEPLOY = path.join(ROOT, 'deploy.sh');
const CONFIG_STORE = path.join(ROOT, 'server', 'config-store.js').replace(/\\/g, '/');

function readDeploy() {
  return fs.readFileSync(DEPLOY, 'utf8');
}

/** deploy.sh 里函数的两种写法（function f() / f()）都要认 */
function hasFn(src, name) {
  return new RegExp(`^[ \\t]*(function[ \\t]+)?${name}[ \\t]*\\([ \\t]*\\)`, 'm').test(src);
}

/** 从 deploy.sh 里抽出 update_initial_admin() 使用的内联 node 脚本 */
function extractInlineScript() {
  const src = readDeploy();
  const start = src.indexOf("  script=\"$(cat <<'NODE'");
  assert.notEqual(start, -1, 'update_initial_admin() 必须内联一段 node 脚本（用于改初始管理员凭据）');
  const head = src.indexOf('\n', start) + 1;
  const tail = src.indexOf('\nNODE\n', head);
  assert.notEqual(tail, -1, '内联 node 脚本必须以 NODE 结束（heredoc 未闭合会让整个脚本失效）');
  return src.slice(head, tail).split('\n').map((line) => line.replace(/^  /, '')).join('\n');
}

/**
 * 新建一份独立模块注册表。
 *
 * config-store 在**模块加载时就读** `COS_DATA_DIR` 固化数据目录，
 * 且被 Node 的 `Module._cache` 缓存；若不清缓存，后一个用例会拿到前一个用例
 * 实例（指向上一个临时目录）—— 那正是「改了没生效」类故障最难发现的原因。
 */
function freshRequireStore(dataDir) {
  process.env.COS_DATA_DIR = dataDir;
  Object.keys(require.cache).forEach((key) => { delete require.cache[key]; });
  if (Module._pathCache) Module._pathCache = Object.create(null);
  const filename = require.resolve(CONFIG_STORE);
  const m = new Module(filename, null);
  m.filename = filename;
  m.path = path.dirname(filename);
  m.require = (id) => Module._load(id, m, false);
  m.exports = {};
  return m;
}

/** 模拟 deploy.sh 里的 `env COS_DATA_DIR=... node -e <script> <field>` */
async function runInlineScript(script, field, value, dataDir) {
  const mod = freshRequireStore(dataDir);
  const listeners = {};
  const sandbox = {
    module: mod,
    exports: mod.exports,
    // vm 里没有 require：注入一个按模块所在目录解析的 require
    require: mod.require,
    __dirname: path.dirname(mod.filename),
    __filename: mod.filename,
    console,
    process: {
      argv: ['node', field],
      exitCode: 0,
      stdout: { write: (c) => { sandbox.__out += String(c); return true; } },
      stderr: { write: (c) => { sandbox.__err += String(c); return true; } },
      stdin: { setEncoding: () => {}, on: (e, cb) => { listeners[e] = cb; } },
    },
    __out: '',
    __err: '',
  };
  vm.createContext(sandbox);
  const patched = script.replace(
    "require('./server/config-store')",
    `require(${JSON.stringify(CONFIG_STORE)})`,
  );
  // 先注册监听，再像管道一样投递数据与结束事件
  vm.runInContext(patched, sandbox, { filename: 'kepler-admin-inline.js' });
  listeners.data(value);
  listeners.end();
  // 等异步 handler 收尾（成功写 stdout，失败写 stderr 并置 exitCode）
  for (let i = 0; i < 200; i += 1) {
    if (sandbox.process.exitCode || sandbox.__out || sandbox.__err) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return { out: sandbox.__out, err: sandbox.__err, code: sandbox.process.exitCode };
}

/** 直接以「同一份数据目录」读取落盘后的管理员状态 */
async function readAdminState(dataDir) {
  const mod = freshRequireStore(dataDir);
  const store = mod.require(CONFIG_STORE);
  const admin = store.listUsers().find((u) => u.role === 'admin');
  if (!admin) return { name: null, okOldPass: null, okNewPass: null };
  const [oldPass, newPass] = await Promise.all([
    store.authenticateUser(admin.username, 'Old' + 'Pass123'),
    store.authenticateUser(admin.username, 'New' + 'Pass456'),
  ]);
  return {
    name: admin.username,
    okOldPass: oldPass ? oldPass.username : null,
    okNewPass: newPass ? newPass.username : null,
  };
}

async function seedAdmin(dataDir) {
  const mod = freshRequireStore(dataDir);
  const store = mod.require(CONFIG_STORE);
  await store.addUser({ username: 'admin', password: 'Old' + 'Pass123', role: 'admin' });
  await store.flush();
}

function tempDataDir(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data').replace(/\\/g, '/');
  fs.mkdirSync(dataDir, { recursive: true });
  return { tmp, dataDir };
}

/**
 * 起一个真实 bash 跑 deploy.sh，拿到 stdout/stderr/退出码。
 *
 * 为什么值得起子进程：`set -Eeuo pipefail` 下有一类坑**静态扫描看不出来** ——
 * `shift 2` 越界、`exec` 跳过 EXIT trap、裸调用返回 1 的函数被 ERR trap 当成失败。
 * 这里只喂**参数错误**和**管理编号**：这两类都在 detect_env 之前就结束，
 * 不需要 root、不写任何系统路径，所以在开发机（Windows + Git Bash）上也能安全跑。
 *
 * 用**异步 spawn**：本机 spawnSync 恒 EBUSY（与 audit13 同一处环境问题），
 * 拿不到输出就会把「没跑起来」误判成「输出为空」→ 假绿。
 * bash 不存在时返回 { unavailable }，调用方跳过运行期断言（静态断言仍然生效）。
 */
function spawnBash(args) {
  return new Promise((resolve) => {
    const child = spawn('bash', [DEPLOY, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ unavailable: e.code || String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** 取某个 shell 函数的函数体（函数体以行首 `}` 结束） */
function fnBody(src, name) {
  const start = src.indexOf(`\n${name}() {`);
  assert.notEqual(start, -1, `deploy.sh 里应存在函数 ${name}`);
  const end = src.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name}() 应有正常的函数体结束`);
  return src.slice(start, end);
}

/**
 * 去掉整行注释再断言。
 * 脚本里的注释经常**举反例**（比如「这里刻意不用 /home/* 这类通配」），
 * 不剥注释就会把"注释里提到的坏写法"当成真的坏写法，护栏自己把自己搞红。
 */
function codeOnly(body) {
  return body.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
}

/**
 * 列出每个函数的「最后一条有效语句」。
 *
 * 用于抓一类极隐蔽的 shell 陷阱：`set -Eeuo pipefail` 下，函数**最后一条语句**
 * 若为 `[[ ... ]] && VAR=...` 这类短路写法，条件为假时函数返回 1 —— 调用点
 * 便会被 ERR trap 当成「脚本意外失败」直接退出。
 * 实测：`apply_env_overrides()` 在**未设置任何环境变量**时就是这个情况，
 * 表现为全新服务器上一执行就报「脚本在第 N 行意外失败（退出码 1）」。
 */
function lastStatements(src) {
  const lines = src.split('\n');
  const out = [];
  let name = null;
  let last = '';
  for (const line of lines) {
    if (/^(function )?[A-Za-z_][A-Za-z0-9_]*\(\) \{/.test(line)) {
      name = line.replace(/ \{$/, '');
      last = '';
      continue;
    }
    if (line === '}' && name) {
      out.push({ fn: name, last });
      name = null;
      continue;
    }
    if (name && line.trim() && !/^\s*#/.test(line)) last = line.trim();
  }
  return out;
}

test('deploy.sh：任何函数都不得以「短路条件」结尾（set -e 误杀护栏）', () => {
  // 只判「裸条件语句」：if/while 包裹的返回 0，带 `|| true` / `|| return 0` / `|| die` 的已显式兜底
  const SAFE_SUFFIX = /(\|\| true|\|\| return 0|\|\| exit|\|\| die )$/;
  const risky = lastStatements(readDeploy()).filter(({ last }) => (
    !/^(if|while|until|for|case) /.test(last)
    && /^(\[\[|\[ |test |! )/.test(last)
    && !SAFE_SUFFIX.test(last)
  ));
  assert.deepStrictEqual(risky.map((r) => `${r.fn} → ${r.last}`), [],
    '函数最后一条语句不得是 `[[ ... ]] && ...` 这类短路写法：条件为假时返回 1，会被 ERR trap 当成脚本失败');
  assert(/function apply_env_overrides\(\)[\s\S]*?\n  return 0\n\}/.test(readDeploy()),
    'apply_env_overrides() 必须以 return 0 结束（默认值来自内置常量时所有条件都为假）');
});

/**
 * 命令替换里的管道必须有 `|| true` 兜底。
 *
 * 开了 `pipefail` 后，`VAR="$(cmd | grep ... )"` 在 grep **没匹配到**时整条赋值
 * 返回 1，同样会被 ERR trap 当成脚本失败。实测 `diagnose_service()` 里那句
 * `who="$(ss -ltnp | grep ":PORT" | head -n1)"` 正是如此：服务没起来（最需要
 * 诊断输出的时候）端口上必然没有监听，脚本反而自杀在健康检查那一步。
 * 只扫描**同一行内**的替换，跨行的多行替换天然带 `|| true`（已逐条确认）。
 */
test('deploy.sh：命令替换里的管道必须有 || true 兜底（pipefail 误杀护栏）', () => {
  const risky = [];
  readDeploy().split('\n').forEach((line, i) => {
    const re = /\$\(/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (m.index > 0 && line[m.index - 1] === '\\') continue; // 提示语里被转义的 $(...) 是字面文本
      const inner = line.slice(m.index, line.indexOf(')', m.index) + 1);
      // `||` 是布尔或，不是管道：先剔除再判断是否真的有管道
      if (!inner.replace(/\|\|/g, '').includes('|')) continue;
      if (/\|\|\s*(true|echo|:)/.test(inner)) continue;
      risky.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepStrictEqual(risky, [],
    '命令替换里出现管道时必须加 `|| true`（或其他 || 兜底）：pipefail 下 grep 无匹配会返回 1，被 ERR trap 当成脚本失败');
});

test('deploy.sh：持久化状态、全局命令与菜单入口齐备', () => {
  const src = readDeploy();

  assert(/readonly STATE_FILE=/.test(src), '必须有只读的部署状态文件路径常量（重跑与 kepler 维护都依赖它）');
  assert(hasFn(src, 'load_state') && hasFn(src, 'save_state'),
    '必须实现状态加载与保存（否则改端口/重装会退化成「必须手传全部参数」）');
  assert(/readonly GLOBAL_COMMAND=/.test(src) && hasFn(src, 'install_global_command'),
    '必须注册全局 kepler 命令');
  assert(hasFn(src, 'manage_menu'), '必须提供编号菜单');
  assert(hasFn(src, 'manage_action'), '必须支持 kepler <编号> 直接执行');
  assert(hasFn(src, 'do_uninstall') && hasFn(src, 'safe_remove_tree'),
    '卸载必须走受保护的删除函数，不能直接 rm -rf');

  // 菜单编号与 dispatch 分支必须一一对应：少分支=点了没反应，多分支=永远点不到
  const menu = src.slice(src.indexOf('\nmanage_menu() {'), src.indexOf('// 命令行直接执行编号'));
  const numbers = [...menu.matchAll(/^\s*log "  (\d)\) /gm)].map((m) => m[1]);
  assert(numbers.length >= 5, '菜单至少要有 5 个编号项（含退出项）');
  assert(numbers.includes('0'), '菜单必须包含 0（退出项）');
  assert(numbers.includes('5'), '菜单必须包含 5（卸载项）');

  const dispatch = src.slice(src.indexOf('\nmanage_action() {'));
  for (const n of numbers) {
    assert(new RegExp(`^\\s*${n}\\)\\s+\\S`, 'm').test(dispatch),
      `菜单编号 ${n} 必须在 manage_action() 里有对应的执行分支`);
  }
});

test('deploy.sh：改初始管理员的用户名与密码真实生效（临时数据目录）', async () => {
  const script = extractInlineScript();
  const { tmp, dataDir } = tempDataDir('kepler-deploy-admin-');
  try {
    await seedAdmin(dataDir);

    const r1 = await runInlineScript(script, 'username', 'root-admin', dataDir);
    assert.strictEqual(r1.code, 0, `改用户名不应失败：${r1.err}`);
    assert(/updated:root-admin/.test(r1.out), `改用户名应回显新用户名，实际：${r1.out}`);

    const r2 = await runInlineScript(script, 'password', 'New' + 'Pass456', dataDir);
    assert.strictEqual(r2.code, 0, `改密码不应失败：${r2.err}`);
    assert(/updated:root-admin/.test(r2.out), `改密码应回显当前用户名，实际：${r2.out}`);

    const state = await readAdminState(dataDir);
    assert.strictEqual(state.name, 'root-admin', '用户名修改必须真实落盘（否则表现为「提示成功但没生效」）');
    assert.strictEqual(state.okOldPass, null, '旧密码必须立即失效');
    assert.strictEqual(state.okNewPass, 'root-admin', '新密码必须可用于登录');
  } finally {
    delete process.env.COS_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deploy.sh：未初始化时改管理员应报错而不是新建一个账户', async () => {
  const script = extractInlineScript();
  const { tmp, dataDir } = tempDataDir('kepler-deploy-empty-');
  try {
    const r = await runInlineScript(script, 'username', 'root-admin', dataDir);
    assert.strictEqual(r.code, 1, `系统尚未初始化时必须以非零码退出，实际输出：${r.out}`);
    assert(/尚未创建初始管理员/.test(r.err),
      '系统尚未初始化时必须明确报错（静默建号会绕过 /api/auth/init 的限流与互斥）');
    assert.strictEqual(r.out, '', '失败时不应输出「修改成功」');
  } finally {
    delete process.env.COS_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deploy.sh：取值型参数缺值必须给人话错误（不得退化成「意外失败」）', async () => {
  const src = readDeploy();

  // 静态：禁止 `--x) VAR="${2:-}"; shift 2` —— 只给选项不给值时 shift 越界返回 1，
  // 会被 ERR trap 报成「脚本在第 N 行意外失败」，而不是「你少给了一个值」。
  assert.strictEqual(
    src.match(/^\s*--\S+\)\s*\w+="\$\{2:-\}";\s*shift 2\s*;;/m),
    null,
    '取值型参数不得用 `VAR="${2:-}"; shift 2`：shift 越界会触发 ERR trap，报错信息完全看不懂',
  );
  assert(/\[\[ \$# -lt 2 \|\| -z "\$\{2-\}" \]\]/.test(src),
    '取值型参数必须校验「确实给了取值」（`$#` 够且非空）');
  assert(/--domain\|--port\|[^\n]*--mirror\)/.test(src),
    '所有取值型选项应走同一个校验分支，避免漏掉某一个');

  const r = await spawnBash(['--domain']);
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert.strictEqual(r.code, 1, '参数缺值应以 1 退出');
  assert(/缺少取值/.test(all), `应明确指出是哪个参数缺值，实际输出：${all.slice(0, 200)}`);
  assert(!/意外失败/.test(all), '参数写错属于用户输入问题，不该报成「脚本意外失败」（那会让人以为脚本坏了）');
});

test('deploy.sh：kepler <编号> 必须解析成管理动作（否则 README 里的用法不可用）', async () => {
  const src = readDeploy();
  assert(/MANAGE_ACTION=""/.test(src), '必须初始化 MANAGE_ACTION（set -u 下未定义会直接报 unbound variable）');
  assert(/^\s*\[0-9\]\)\s+MANAGE=1;\s*MANAGE_ACTION="\$1";\s*shift/m.test(src),
    'parse_args 必须把裸数字识别为「执行该编号的管理动作」');
  assert(/"\$MANAGE_ACTION"/.test(src) || /\$\{MANAGE_ACTION\}/.test(src),
    'main 必须按 MANAGE_ACTION 分发，不能靠位置参数个数猜（--manage 2 时位置参数是 --manage）');

  const r = await spawnBash(['2']);
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert(!/未知参数/.test(all),
    `kepler 2 应进入管理流程而不是被当成未知参数（被当成未知参数就意味着全局命令「kepler <编号>」完全不可用）：${all.slice(0, 200)}`);
});

test('deploy.sh：重装必须把单实例锁交接给新进程（exec 不触发 EXIT trap）', () => {
  const src = readDeploy();

  assert(/"\$\{KEPLER_LOCK_HELD:-\}" == "\$LOCK_FILE"/.test(fnBody(src, 'detect_env')),
    'detect_env 必须识别父进程交接过来的锁，否则重装一启动就误判「另一个部署进程正在运行」');
  assert(/exec env KEPLER_LOCK_HELD="\$LOCK_FILE" bash "\$target" --reinstall/.test(fnBody(src, 'reinstall_now')),
    '重装必须用 KEPLER_LOCK_HELD 交接锁，并清掉自己的 EXIT trap');
  assert(!/exec bash "\$\{INSTALL_DIR\}\/deploy\.sh"/.test(src),
    '不得再有「裸 exec 安装目录脚本」的重装写法：exec 会跳过 EXIT trap，锁文件留在磁盘上，重装必然自锁失败');

  // 菜单与命令行两条路径必须走同一个 helper（历史上只有菜单那条做了清理）
  const menu = src.slice(src.indexOf('\nmanage_menu() {'), src.indexOf('# 命令行直接执行编号'));
  const dispatch = src.slice(src.indexOf('\nmanage_action() {'));
  assert(/^ *1\) reinstall_now/m.test(menu), '菜单的重装项必须走 reinstall_now()');
  assert(/^ *1\) reinstall_now/m.test(dispatch), '命令行的重装项必须走 reinstall_now()');
});

test('deploy.sh：可选依赖安装失败只能降级，不得中断部署', () => {
  const body = codeOnly(fnBody(readDeploy(), 'pkg_install_opt'));
  assert(/on_pkg_failure[^\n]*\|\| true/.test(body),
    'on_pkg_failure 在「可选」分支返回 1，裸调用会被 ERR trap 判成脚本失败 —— 明明设计成降级，实际却中断');
  assert(/return 0/.test(body), '成功路径必须显式 return 0');
});

test('deploy.sh：卸载白名单不得误伤正常安装目录', () => {
  const body = codeOnly(fnBody(readDeploy(), 'safe_remove_tree'));
  assert(!/\/home\/\*|\/root\/\*/.test(body),
    '不得使用 /home/* 这类通配：case 的 * 会跨 "/" 匹配，把 /home/<用户>/kepler 正常安装目录一起拦掉，卸载永远失败');
  assert(/\(Desktop\|Downloads\|Documents\)/.test(body),
    '个人目录要按路径组件精确匹配（Desktop/Downloads/Documents）');
  assert(/拒绝递归删除系统目录|\/usr\/local/.test(body), '系统目录白名单必须显式列出并拒绝');
});

/**
 * 跑一段 bash 片段（cwd 在仓库根，里面可以 `source ./deploy.sh`）。
 * 与 spawnBash 同理用**异步 spawn**，且必须容忍片段以非 0 退出（被测代码会 die）。
 */
function spawnBashSnippet(script, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', script], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(extraEnv || {}) },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ unavailable: e.code || String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('deploy.sh：站点配置必须落在主配置 http{} 里 include 的目录（Debian 的 modules-enabled 陷阱）', async () => {
  const src = readDeploy();
  assert(hasFn(src, 'nginx_http_include_dirs'),
    '必须按「include 是否位于 http{} 内」筛候选目录：只挑「主配置里任意一个通配 include 目录」会在 Debian/Ubuntu 上选中 modules-enabled');

  // 真实形态：Debian/Ubuntu 的 nginx.conf 顶层就有 include .../modules-enabled/*.conf;
  // （动态模块目录，在 http{} 之外），而该目录在装了 nginx 的机器上必然存在。
  // 站点配置写进去 → server{} 落在 main 上下文 → nginx -t 报
  // 「"server" directive is not allowed here」，部署就在这里断掉。
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/etc/nginx/modules-enabled" "$T/etc/nginx/conf.d"
cat > "$T/etc/nginx/nginx.conf" <<EOF
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include $T/etc/nginx/modules-enabled/*.conf;

events {
	worker_connections 768;
}

http {
	include $T/etc/nginx/mime.types;
	include $T/etc/nginx/conf.d/*.conf;
	include $T/etc/nginx/sites-enabled/*;
}
EOF
cat > "$T/bin/nginx" <<EOF
#!/bin/sh
if [ "\\$1" = "-V" ]; then
  printf 'nginx version: nginx/1.24.0\\n'
  printf 'configure arguments: --conf-path=$T/etc/nginx/nginx.conf\\n'
fi
EOF
chmod +x "$T/bin/nginx"
PATH="$T/bin:$PATH" nginx_detect_layout >/dev/null 2>&1 || true
printf 'CONF=%s\\n' "$NGINX_CONF"
`);
  if (r.unavailable) return;
  const all = r.out + r.err;
  const conf = (all.match(/CONF=(.+)/) || [])[1] || '';
  assert(!conf.includes('modules-enabled'),
    `站点配置不得写进 modules-enabled（那是 http{} 之外的主上下文，server{} 会直接报错）：${conf}`);
  assert(/\/etc\/nginx\/conf\.d\/kepler\.conf$/.test(conf),
    `http{} 内 include 的 conf.d 才是站点配置该落的地方，实际选中：${conf}`);
});

test('deploy.sh：改管理员凭据必须原样传值（转义会写进真实密码）', () => {
  const src = readDeploy();
  // 注意：不能用 fnBody() —— 它会停在 heredoc 里第一个行首 `}`，
  // 而两条取值分支恰好写在 heredoc 之后。
  const start = src.indexOf('\nupdate_initial_admin() {');
  const end = src.indexOf('\nprompt_admin_username() {', start);
  assert(start !== -1 && end > start, 'update_initial_admin() 的结构变了，护栏需要同步');
  const body = codeOnly(src.slice(start, end));

  assert(!/json_quote/.test(src),
    '值经 stdin 传递，不需要转义函数：多包一层转义会把反斜杠/引号/制表符变成字面字符写进真实密码（提示成功却登不上）');
  assert(/printf '%s' "\$value" \| docker compose run/.test(body),
    'docker 分支必须把原值直接交给 stdin，不得再套一层编码');
  assert(/printf '%s' "\$value" \| env NODE_ENV=production/.test(body),
    'systemd 分支同样必须原样传值（两条分支必须一致，否则「同样的密码换个部署方式就登不上」）');

  const inline = extractInlineScript();
  assert(!/JSON\.parse\(/.test(inline),
    '内联脚本不得解析 JSON：值若恰好长得像 JSON 字符串字面量（密码就是 "abc123" 带引号），会被解码成 abc123');
  assert(/const value = input\.replace/.test(inline), '必须按 stdin 原文取值');
});

test('deploy.sh：改管理员密码在特殊字符下真实生效（真实 node 管道）', async () => {
  // 覆盖历史上会被静默改写的取值：引号、反斜杠、制表符，以及「长得像 JSON 字符串」的密码。
  // 脚本/密码/数据目录一律经**环境变量**递进去：拼进双引号命令串会被 bash 展开
  // `${...}` 与反引号，等于测了个假样本。
  const script = extractInlineScript();
  const tricky = ['a"bcd123', 'back\\slash123', 'tab\tinside', '"abc123"'];
  for (const pass of tricky) {
    const { tmp, dataDir } = tempDataDir('kepler-deploy-exact-');
    try {
      await seedAdmin(dataDir);
      const r = await spawnBashSnippet(
        'printf \'%s\' "$KEPLER_PASS" | env NODE_ENV=production COS_DATA_DIR="$KEPLER_DATA" '
        + 'node -e "$KEPLER_INLINE" password',
        { KEPLER_INLINE: script, KEPLER_PASS: pass, KEPLER_DATA: dataDir },
      );
      if (r.unavailable) return;
      assert.strictEqual(r.code, 0, `改密码不应失败（${pass}）：${r.err}`);
      const mod = freshRequireStore(dataDir);
      const store = mod.require(CONFIG_STORE);
      const admin = store.listUsers().find((u) => u.role === 'admin');
      const loggedIn = await store.authenticateUser(admin.username, pass);
      assert.strictEqual(loggedIn ? loggedIn.username : null, 'admin',
        `密码必须原样落盘，才能用「用户输入的原文」登录：${JSON.stringify(pass)}`);
      const stale = await store.authenticateUser(admin.username, 'Old' + 'Pass123');
      assert.strictEqual(stale, null, '旧密码必须立即失效');
    } finally {
      delete process.env.COS_DATA_DIR;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test('deploy.sh：nginx 装不上时必须走到对症提示（不得被通用失败出口截胡）', async () => {
  const body = codeOnly(fnBody(readDeploy(), 'install_nginx'));
  assert(/pkg_run_pm nginx/.test(body),
    'nginx 安装要先用「不中断」的调用：RHEL 系第一枪常常打不中（包在 EPEL 里），走 pkg_install 会直接 die');
  assert(!/pkg_install nginx/.test(body),
    '不得用会 die 的 pkg_install 装 nginx：它一失败就中断，下面的 EPEL 兜底与对症提示全成死代码');
  assert(body.indexOf('epel-release') < body.indexOf('die_with_hint "Nginx 安装失败"'),
    'EPEL 兜底必须夹在「尝试安装」与「判失败」之间');

  // 行为验证：系统装包一律失败 + RHEL 系 + 日志显示「nginx 被 exclude 过滤」+ 非交互执行
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
PM=dnf
ASSUME_YES=0
pkg_run_pm() { return 1; }
run_soft() { return 0; }
locate_nginx() { return 1; }
have() { case "$1" in nginx) return 1 ;; *) command -v "$1" >/dev/null 2>&1 ;; esac; }
# 用户真实日志（CentOS 8）：包管理器把 nginx 排除掉了
log_since_mark() { printf '%s\\n' 'All matches were filtered out by exclude filtering for argument: nginx' 'Error: Unable to find a match: nginx'; }
out="$( install_nginx 2>&1 </dev/null )"
rc=$?
printf '%s\\n' "$out"
printf 'RC=%s\\n' "$rc"
`);
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert(/RC=1/.test(all), `装不上 nginx 应以非 0 退出：${all.slice(0, 300)}`);
  assert(/epel-release/.test(all),
    `RHEL 系失败后必须真的去启用 EPEL 重试（这行兜底以前永远执行不到）：${all.slice(0, 400)}`);
  assert(/--skip-nginx/.test(all),
    `必须给出对症提示与 --skip-nginx 逃生口（以前只会看到「软件包安装失败：nginx」）：${all.slice(0, 400)}`);
  assert(!/软件包安装失败：nginx/.test(all),
    '不得掉进通用失败出口：那意味着 nginx 专属诊断全部不可达');
  assert(/--disableexcludes=all/.test(all),
    `必须给出「临时无视 exclude」的可敲命令：只让人去 grep exclude= 配置而不给命令，用户还是装不上：${all.slice(0, 600)}`);
  assert(/\/www\/server\/nginx\/sbin\/nginx/.test(all),
    `被 exclude 过滤时要让人去确认「这台机器本来就有 Nginx，只是没进 PATH」（面板路径）：${all.slice(0, 600)}`);
});

test('deploy.sh：域名带端口必须当场拒绝（否则静默降级 + nginx -t 失败）', async () => {
  const src = readDeploy();
  assert(/域名里不要带端口/.test(src), '必须在 collect_config 里显式拒绝「域名:端口」');

  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
MODE=systemd; INSTALL_DIR=/opt/kepler; DATA_DIR=""; TLS_MODE=auto
SUB_PATH=/; EMAIL=""; REPO_URL="https://example.com/x.git"
APP_PORT=3000; HTTP_PORT=80; HTTPS_PORT=443
for d in "example.com:8080" "https://cos.example.com:8443/" "1.2.3.4:80" "cos.example.com" "2001:db8::1"; do
  DOMAIN="$d"
  out="$( collect_config 2>&1 )"
  rc=$?
  if grep -q '不要带端口' <<<"$out"; then verdict=拒绝; else verdict=放行; fi
  printf 'CASE %-32s rc=%s %s\\n' "$d" "$rc" "$verdict"
done
`);
  if (r.unavailable) return;
  const all = r.out + r.err;
  const line = (d) => (all.split('\n').find((l) => l.includes(`CASE ${d}`)) || '').trim();
  assert(/rc=1 拒绝/.test(line('example.com:8080')),
    `带端口的域名必须当场拒绝（放行会导致：静默改自签名证书 + server_name 带端口让 nginx -t 失败）：${all.slice(0, 300)}`);
  assert(/rc=1 拒绝/.test(line('https://cos.example.com:8443/')),
    '整段 URL 粘进来也要拒绝，并提示端口该用哪个参数传');
  // 正反两面都要测：只测「该拒绝的都拒绝了」，坏实现（一律拒绝）会全绿
  assert(/rc=0 放行/.test(line('cos.example.com')), '正常域名必须放行');
  assert(/rc=0 放行/.test(line('2001:db8::1')), 'IPv6 字面量必须放行（不能把冒号一律当成端口）');
});

test('deploy.sh：重装前必须识破「安装目录里的脚本已损坏」（不得把它当脚本执行）', async () => {
  const body = codeOnly(fnBody(readDeploy(), 'reinstall_now'));
  assert(/head -n1 "\$target" \| grep -qE/.test(body),
    'reinstall_now 必须检查首行 shebang：「404: Not Found」在 bash 眼里是一条**语法合法**的命令（bash -n 会放行），只有 shebang 检查能识破它');
  assert(/bash -n "\$target"/.test(body),
    'reinstall_now 还必须用 bash -n 兜住另一种坏法：shebang 还在、内容被截断或改坏');
  assert(/die /.test(body), '预检不通过必须给人话错误，而不是继续 exec 一个坏文件');

  const { tmp } = tempDataDir('kepler-deploy-reinstall-');
  try {
    const installDir = path.join(tmp, 'install').replace(/\\/g, '/');
    fs.mkdirSync(installDir, { recursive: true });
    const target = path.join(installDir, 'deploy.sh');
    const snippet = `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
INSTALL_DIR=${JSON.stringify(installDir)}
reinstall_now
`;

    // 反面：内容是「下载到的 404 响应体」—— 这正是 curl 不带 -f 的后果。
    // 不预检就 exec，用户看到的只有 `deploy.sh: line 1: 404:: command not found`。
    fs.writeFileSync(target, '404: Not Found');
    const bad = await spawnBashSnippet(snippet);
    if (bad.unavailable) return;
    const badAll = bad.out + bad.err;
    assert(!/404:: command not found/.test(badAll),
      `不得把损坏的脚本当成脚本来执行（这句报错用户完全无从下手）：${badAll.slice(0, 300)}`);
    assert(/不完整或已损坏/.test(badAll),
      `必须给出人话错误并指明路径：${badAll.slice(0, 300)}`);

    // 正面：正常的脚本必须照常放行并交接执行（否则预检就成了「永远拒绝」）
    fs.writeFileSync(target, "#!/usr/bin/env bash\nprintf 'STUB_REINSTALL %s\\n' \"$*\"\n");
    const good = await spawnBashSnippet(snippet);
    if (good.unavailable) return;
    assert(/STUB_REINSTALL --reinstall/.test(good.out),
      `正常脚本必须被放行（预检不得误伤）：${(good.out + good.err).slice(0, 300)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deploy.sh：git 装不上不得中断部署（CentOS 8 上它恰恰最容易装不上）', async () => {
  const body = codeOnly(fnBody(readDeploy(), 'need_pkgs_base'));
  assert(!/for cmd in [^;]*\bgit\b/.test(body),
    '必需工具清单里不得含 git：它只是「把源码弄到服务器」的一种手段，当成硬依赖会让部署死在第一步');
  assert(/pkg_install_opt git/.test(body),
    'git 必须走「可选」通道（pkg_install_opt）：失败只降级，prepare_source 里有完整的无 git 替代方案');

  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
have() { if [[ "$1" == git ]]; then return 1; fi; command -v "$1" >/dev/null 2>&1; }
pkg_install()     { printf 'REQ %s\\n' "$*"; return 0; }
pkg_install_opt() { printf 'OPT-FAIL %s\\n' "$*"; return 1; }
out="$( need_pkgs_base 2>&1 )"
rc=$?
printf '%s\\n' "$out"
printf 'RC=%s\\n' "$rc"
`);
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert(/RC=0/.test(all),
    `git 装不上时基础工具这步必须正常返回 —— 否则用户直接被卡死在第一步：${all.slice(0, 300)}`);
  assert(/OPT-FAIL git/.test(all), 'git 必须真的走可选通道去尝试安装（而不是悄悄跳过）');
  assert(/未安装 git/.test(all),
    `必须明确告知「缺 git 只影响拉源码这一步」：${all.slice(0, 300)}`);
});

test('deploy.sh：RHEL 系装包失败必须识别「模块流被过滤」并给出 module 修复命令', async () => {
  // 剥注释再判：本文件多处注释**特意**提到 mirrorlist.centos.org 说明它为何不能用，
  // 不剥注释会把这些讲解当成"仍在用它"。
  const src = codeOnly(readDeploy());
  assert(/filtered out by modular filtering/.test(src),
    '诊断链必须识别 modular filtering：RHEL/CentOS 8 的 git 装不上十有八九是它，掉进通用兜底则用户得不到任何有用信息');
  assert(!/mirrorlist\.centos\.org/.test(src),
    '不得再拿 mirrorlist.centos.org 当探针：该域名已随 CentOS 7 EOL（2024-06-30）正式下线，探针恒失败会把「源不可达」误报成「网络不通」');

  const snippetFor = (fakeLog) => `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
PM=dnf; VERSION_ID=8
FAKE_LOG='${fakeLog}'
log_since_mark() { printf '%s' "$FAKE_LOG"; }
log_key_lines()  { sed -n '1,5p' <<<"$FAKE_LOG"; }
out="$( on_pkg_failure git 1 2>&1 )"
printf '%s\\n' "$out"
`;

  // 用户真实日志（CentOS Linux 8 / dnf）
  const modular = await spawnBashSnippet(snippetFor(`Error:
Problem: package git-2.27.0-1.el8.x86_64 requires perl(Git), but none of the providers can be installed
- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering
(try to add '--skip-broken' to skip uninstallable packages)`));
  if (modular.unavailable) return;
  const all = modular.out + modular.err;
  assert(/module reset perl/.test(all),
    `必须给出「复位 perl 模块流」的命令：${all.slice(0, 500)}`);
  assert(/module enable -y perl:5\.26/.test(all),
    `必须按报错里期望的流版本重新启用（perl-libs 5.26）：${all.slice(0, 500)}`);
  assert(/不需要 git/.test(all),
    `必须同时给出「不用 git 也能部署」的逃生口，否则用户以为部署做不下去了：${all.slice(0, 500)}`);

  // 对照：网络类日志仍要走网络分支（别把诊断写成一刀切）
  const net = await spawnBashSnippet(snippetFor('Could not resolve host: mirrors.example.com; Name or service not known'));
  if (net.unavailable) return;
  assert(/网络 \/ DNS 不可达/.test(net.out + net.err),
    '普通网络类失败仍要落到网络分支，不能被新分支截胡');
});

test('deploy.sh：Node 装不上必须先点出「机器上已有 nodejs 与新版互斥」这个真原因', async () => {
  const src = readDeploy();
  const body = codeOnly(fnBody(src, 'install_node'));
  assert(/mark_log/.test(body),
    'install_node 必须在「尝试装包」前记日志位点：否则事后分不清冲突是这次发生的还是历史遗留');
  assert(/node_conflict_detected/.test(body) && /node_conflict_hints/.test(body),
    'install_node 必须识别并给出「已有 nodejs 包互斥」的指引，否则用户拿到的只是无关的通用提示');
  assert(/if \(\(node_conflict\)\); then node_conflict_hints; fi/.test(body),
    '冲突指引必须挂在**失败出口**上（node_manual_hints 会先 HINTS=() 清空，提前 add 会被冲掉）');

  // 判据本身：`is already installed` 是 dnf **装成功后**也会打印的一句
  // （"Package nodejs-1:16.13.1… is already installed."），单独拿它当判据会误报
  assert(!/already installed/.test(codeOnly(fnBody(src, 'node_conflict_detected'))),
    '不得用「already installed」单独当冲突判据：装成功时 dnf 也这么打印，会把正常情况误报成冲突');

  const snippet = (fakeLog) => `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
PM=dnf
FAKE_LOG='${fakeLog}'
log_since_mark() { printf '%s' "$FAKE_LOG"; }
HINTS=()
if node_conflict_detected; then node_conflict_hints; fi
printf '%s\\n' "\${HINTS[@]}"
`;

  // 用户真实日志（CentOS Linux 8：NodeSource 20 撞上 AppStream 的 nodejs:16 模块包）
  const conflict = await spawnBashSnippet(snippet(
    ' - cannot install both nodejs-2:20.20.2-1nodesource.x86_64 and nodejs-1:16.13.1-3.module_el8.5.0+1059+1852da12.x86_64',
  ));
  if (conflict.unavailable) return;
  const all = conflict.out + conflict.err;
  assert(/cannot install both/.test(all),
    `指引里应复述日志里的冲突措辞，让人一眼对上自己看到的那行：${all.slice(0, 400)}`);
  assert(/module reset nodejs/.test(all),
    `必须给出「复位 nodejs 模块流」的命令：${all.slice(0, 600)}`);
  assert(/remove -y nodejs npm/.test(all),
    `必须给出「卸掉系统那份 nodejs」的命令 —— 不卸它，NodeSource 永远装不上：${all.slice(0, 600)}`);
  assert(/\/usr\/local/.test(all),
    `必须同时给出「用官方二进制包绕开包管理器」这条最省事的路：${all.slice(0, 600)}`);

  // 对照：装成功时 dnf 打的那句「is already installed」不得被当成冲突
  const okLog = await spawnBashSnippet(snippet(
    'Package nodejs-1:16.13.1-3.module_el8.5.0+1059+1852da12.x86_64 is already installed.',
  ));
  if (okLog.unavailable) return;
  assert(!/cannot install both/.test(okLog.out + okLog.err),
    '「is already installed」是安装成功的正常输出，不得据此误报冲突（会把人引去卸掉刚装好的包）');
});
