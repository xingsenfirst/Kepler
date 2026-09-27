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

/** 取某个 shell 函数的函数体（函数体以行首 `}` 结束）。两种写法（f() / function f()）都要认。 */
function fnBody(src, name) {
  const m = new RegExp(`\\n(?:function[ \\t]+)?${name}\\(\\) \\{`).exec(src);
  assert(m, `deploy.sh 里应存在函数 ${name}`);
  const start = m.index;
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
  /**
   * 判据从「正则凑巧匹配到 --mirror」升级为「该分支的选项清单必须逐个覆盖下面这份名单」。
   * 旧写法把 `--mirror` 锚在末尾，一旦在它后面追加选项（本次加了 --ca/--eab-kid/--eab-hmac-key），
   * 断言会失败在"格式变了"上而不是"真的漏了校验"上 —— 这种假红会诱使人去改断言而不是看代码。
   * 新写法只关心集合是否被覆盖：新增取值型选项却没并进这个分支，立刻变红。
   */
  const VALUE_OPTS = ['--domain', '--port', '--https-port', '--http-port', '--dir', '--data-dir',
    '--mode', '--tls', '--email', '--path', '--repo', '--node-version', '--mirror',
    '--ca', '--eab-kid', '--eab-hmac-key'];
  const branch = /^\s*(--[a-z0-9-]+(?:\|--[a-z0-9-]+)+)\)\s*$/m.exec(codeOnly(src));
  assert(branch, 'parse_args 里应有一个「多个取值型选项合并」的 case 分支（形如 `--a|--b) ）');
  const covered = new Set(branch[1].split('|'));
  const notCovered = VALUE_OPTS.filter((o) => !covered.has(o));
  assert.strictEqual(notCovered.length, 0,
    `这些取值型选项没有并进统一校验分支：${notCovered.join(', ')}\n`
    + '  它们只给选项不给值时不会命中「缺少取值」校验，而是 shift 越界 → 「脚本在第 N 行意外失败」');

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
  assert(/module reset -y perl/.test(all),
    `必须给出「复位 perl 模块流」的完整可敲命令（含 -y，且模块名由解析结果生成）：${all.slice(0, 500)}`);
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

/**
 * ---- ACME 多 CA（Let's Encrypt / ZeroSSL / LiteSSL）----
 *
 * 背景：用户实测在**国内服务器**上 certbot 签 Let's Encrypt 报错，宝塔面板签 LE 也失败，
 * 但宝塔签 LiteSSL（亚数 TrustAsia）成功 —— 根因是 LE 的 API 在境外，服务器连不上。
 * 于是脚本支持多 CA。三条最容易「改坏却没人发现」的契约：
 *
 *  1. **换 CA 不等于换 --server**：实测 LiteSSL 与 ZeroSSL 的 directory 元数据里都是
 *     `externalAccountRequired: true`，必须带 EAB（KID + HMAC KEY）。少了这个判断，
 *     用户会看到「注册失败」，然后去怀疑网络、DNS、80 端口 —— 全错。
 *  2. **EAB 是密钥**：不得回显到提示里、不得写进部署状态文件。
 *  3. **账户目录推导**：acme.sh 的账户目录是 ca/&lt;host&gt;/&lt;path&gt;/，账户密钥在**最里层**。
 *     只用通配符匹配 ca/ 下面一层目录，只会命中外层父目录，永远判成「没注册过」，
 *     于是每次重跑都强索 EAB —— 而 acme.sh 早把 EAB 存在 ca.conf 里了。
 * ------------------------------------------------------------------ */

test('deploy.sh：CA 注册表、EAB 必要性与 acme.sh 账户目录推导（真实 source 跑一遍）', async () => {
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
ACME_HOME="$T"
printf 'ROOT=%s\\n' "$T"
printf 'SRV_LE=%s\\n' "$(ca_server letsencrypt)"
printf 'SRV_ZS=%s\\n' "$(ca_server zerossl)"
printf 'SRV_LS=%s\\n' "$(ca_server litessl)"
printf 'SRV_BAD=[%s]\\n' "$(ca_server netease)"
ca_needs_eab litessl && printf 'NEED_LS=1\\n' || printf 'NEED_LS=0\\n'
ca_needs_eab zerossl && printf 'NEED_ZS=1\\n' || printf 'NEED_ZS=0\\n'
ca_needs_eab letsencrypt && printf 'NEED_LE=1\\n' || printf 'NEED_LE=0\\n'
printf 'DIR_LE=%s\\n' "$(acme_ca_dir letsencrypt)"
printf 'DIR_ZS=%s\\n' "$(acme_ca_dir zerossl)"
printf 'DIR_LS=%s\\n' "$(acme_ca_dir litessl)"
printf 'BIN=%s\\n' "$(acme_bin)"
acme_account_exists litessl && printf 'ACC_EMPTY=1\\n' || printf 'ACC_EMPTY=0\\n'
mkdir -p "$T/ca/acme.litessl.com/acme/v2/directory"
printf 'dummy-account-key' > "$T/ca/acme.litessl.com/acme/v2/directory/account.key"
acme_account_exists litessl && printf 'ACC_LS=1\\n' || printf 'ACC_LS=0\\n'
acme_account_exists zerossl && printf 'ACC_ZS=1\\n' || printf 'ACC_ZS=0\\n'
`);
  if (r.unavailable) return;
  const all = r.out + r.err;
  const val = (k) => (new RegExp('^' + k + '=(.*)$', 'm').exec(all) || [])[1];

  assert.strictEqual(val('SRV_LE'), 'https://acme-v02.api.letsencrypt.org/directory');
  assert.strictEqual(val('SRV_ZS'), 'https://acme.zerossl.com/v2/DV90');
  assert.strictEqual(val('SRV_LS'), 'https://acme.litessl.com/acme/v2/directory',
    'LiteSSL 的 ACME 接口是 acme.litessl.com/acme/v2/directory（不是 /v2/DV90 那种路径）');
  assert.strictEqual(val('SRV_BAD'), '[]',
    '未知 CA 必须返回空串（调用方据此报错），不得静默回落成某个默认 CA');

  assert.strictEqual(val('NEED_LS'), '1',
    'LiteSSL 必须提供 EAB：它的 directory 元数据里 externalAccountRequired=true');
  assert.strictEqual(val('NEED_ZS'), '0', 'ZeroSSL 不该强制要 EAB：acme.sh 能用注册邮箱自动换取');
  assert.strictEqual(val('NEED_LE'), '0', "Let's Encrypt 免 EAB，不该被卡住");

  const root = val('ROOT');
  assert.strictEqual(val('DIR_LE'), `${root}/ca/acme-v02.api.letsencrypt.org/directory`,
    '账户目录必须与 acme.sh 的 CA_DIR（ca/<host>/<path>）逐段一致，否则判不出「已注册」');
  assert.strictEqual(val('DIR_ZS'), `${root}/ca/acme.zerossl.com/v2/DV90`,
    'ZeroSSL 的两个路径段（v2、DV90）都要保留，少一段就落到别的目录去');
  assert.strictEqual(val('DIR_LS'), `${root}/ca/acme.litessl.com/acme/v2/directory`,
    'LiteSSL 的三个路径段（acme、v2、directory）都要保留');

  assert.strictEqual(val('BIN'), `${root}/acme.sh`,
    'acme.sh 可执行文件路径必须跟着 ACME_HOME 现算：加载期缓存成常量会读到覆盖前的旧值');
  assert.strictEqual(val('ACC_EMPTY'), '0', '没建过账户时必须如实报「没有」');
  assert.strictEqual(val('ACC_LS'), '1',
    '账户密钥在 ca/<host>/<path>/ 最里层；glob 到外层目录会永远判成「没注册过」，导致重跑反复索要 EAB');
  assert.strictEqual(val('ACC_ZS'), '0',
    '不能把别的 CA 的账户算到这家头上（否则会跳过注册、到签发时才发现没有 EAB）');
});

test('deploy.sh：EAB HMAC 密钥不得回显、不得落盘（它相当于签发密码）', async () => {
  const src = readDeploy();

  // 1) 落盘闸门：状态文件里只能有 CA 与 EAB KID；HMAC 由 acme.sh 自己存进 ca.conf
  assert(!/EAB_HMAC_KEY/.test(codeOnly(fnBody(src, 'save_state'))),
    'save_state 不得把 EAB_HMAC_KEY 写进部署状态文件（明文密钥落盘，而且没必要）');
  assert(!/EAB_HMAC_KEY/.test(codeOnly(fnBody(src, 'load_state'))),
    'load_state 也不得回读 HMAC 密钥，否则等于给它开了条落盘通道');
  assert(/EAB_KID/.test(codeOnly(fnBody(src, 'save_state')))
    && /EAB_KID/.test(codeOnly(fnBody(src, 'load_state'))),
    'EAB KID 是公开标识，应当持久化（重跑时少敲一个参数）');

  // 2) 回显闸门：run 打印失败命令、rerun_cmd 打印「原样重跑」都可能带上 HMAC
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
ORIG_ARGS='--domain a.example.com --ca litessl --eab-kid KID1 --eab-hmac-key SUPER-SECRET-HMAC'
printf 'RERUN=%s\\n' "$(rerun_cmd)"
printf 'RED1=[%s]\\n' "$(redact_args '--eab-kid K --eab-hmac-key SEC --domain a')"
printf 'RED2=[%s]\\n' "$(redact_args '--eab-hmac-key=SEC2 --domain b')"
printf 'RED3=[%s]\\n' "$(redact_args '--eab-hmac-key')"
printf 'RED4=[%s]\\n' "$(redact_args '')"
`);
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert(!all.includes('SUPER-SECRET-HMAC'),
    'rerun_cmd 会把原始命令行原样回显，必须先把 --eab-hmac-key 的值抹掉（HMAC 相当于签发密码）');
  assert(/KID1/.test(all), 'KID 是公开标识，回显时保留反而有用（能确认脚本确实收到了）');
  assert(/RED1=\[--eab-kid K --eab-hmac-key \*\*\* --domain a\]/.test(all),
    `--eab-hmac-key 的值应被替换成 ***（空格分隔写法）：${all.slice(0, 300)}`);
  assert(/RED2=\[--eab-hmac-key=\*\*\* --domain b\]/.test(all),
    `--eab-hmac-key=VALUE 这种等号写法也要抹掉，否则漏一条通道：${all.slice(0, 300)}`);
  assert(/RED3=\[--eab-hmac-key\]/.test(all), '只给参数名（无值）不得崩，也不该凭空补 ***');
  assert(/RED4=\[\]/.test(all), '空命令行不得崩（未带参数重跑就是这条路径）');
});

test('deploy.sh：非 LE 的 CA 必须走 acme.sh，且真的带上 --server / EAB / --install-cert', () => {
  const src = readDeploy();
  const issue = codeOnly(fnBody(src, 'issue_cert'));
  assert(/CA_PROVIDER"?\s*!=\s*"?letsencrypt/.test(issue),
    '非 LE 必须与 LE 分支区分开：CentOS 8 的 certbot 是 1.22（Python 3.6），不支持 --eab-kid/--eab-hmac-key，用 certbot 接 EAB 类 CA 必然失败');
  assert(/issue_acme_sh/.test(issue), '必须真有一条 acme.sh 通道');
  assert(/issue_via_certbot/.test(issue), "LE 侧应优先用 certbot（续期交给包自带的 timer/cron）");

  const acme = codeOnly(fnBody(src, 'issue_acme_sh'));
  const flat = acme.replace(/\n/g, ' ');
  assert(/--register-account[^\n]*--server/.test(acme.replace(/\n/g, ' ')),
    '注册账户时必须显式 --server：acme.sh v3 的默认 CA 是 ZeroSSL，不指定就把用户送错 CA');
  assert(/--home "\$ACME_HOME"/.test(acme),
    'acme.sh 调用必须显式 --home（默认是当前用户 ~/.acme.sh；ACME_HOME 可被环境变量覆盖，不显式传会不一致）');
  assert(/--eab-kid/.test(acme) && /--eab-hmac-key/.test(acme),
    'EAB 只能由命令行传给 acme.sh（它没有对应的环境变量），少了这两个参数 LiteSSL 必然注册失败');
  assert(/--eab-hmac-key "\$EAB_HMAC_KEY"/.test(acme),
    'EAB 的值要以变量形式原样传，不得内联/转义（转义过的密钥会被 acme.sh 当成错误凭据）');
  assert(/acme_account_exists/.test(acme),
    '已注册过的账户应跳过注册：acme.sh 会把 EAB 存进 ca.conf，重跑不该再索要 EAB');
  assert(/--issue[^\n]*--server "\$server"/.test(flat),
    '签发时同样必须 --server：否则 acme.sh 会回到默认 CA（ZeroSSL）');
  assert(/acme_install_cert/.test(acme),
    '必须 --install-cert 把证书落到固定路径：否则续期只更新 acme.sh 私有目录，Nginx 一直用旧证书');

  const inst = codeOnly(fnBody(src, 'acme_install_cert'));
  assert(/--install-cert/.test(inst) && /--key-file/.test(inst)
    && /--fullchain-file/.test(inst) && /--reloadcmd/.test(inst),
    '--install-cert 要指定 key-file / fullchain-file / reloadcmd（续期后自动生效）');
  assert(/chmod 0600/.test(inst), '私钥落盘后必须收紧到 0600');

  // 反面：certbot 通道不得承载非 LE 的 CA
  const cb = codeOnly(fnBody(src, 'issue_via_certbot'));
  assert(!/--eab-kid|--eab-hmac-key|--server/.test(cb),
    'certbot 通道不得出现 EAB / --server：那正是 1.22 不支持的用法，写在这里等于给了个跑不通的假通道');
});

test('deploy.sh：LiteSSL 缺 EAB 必须当场失败并给出人话+可敲命令（不得拖到签发才失败）', async () => {
  const snippet = (ca, kid, hmac) => `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
DOMAIN="cos.example.com"
ACME_HOME="$(mktemp -d)"
TLS_MODE="auto"
CA_PROVIDER="${ca}"
EAB_KID="${kid}"
EAB_HMAC_KEY="${hmac}"
collect_config
printf 'REACHED_END\\n'
`;

  // ① litessl 不给 EAB：必须当场死，且死得有用
  const bad = await spawnBashSnippet(snippet('litessl', '', ''));
  if (bad.unavailable) return;
  const badAll = bad.out + bad.err;
  assert.strictEqual(bad.code, 1,
    '证书这一步失败是「回退自签名、不中断」的，用户很容易把它当成网络抖动；缺 EAB 是参数错，必须当场退出');
  assert(/EAB/.test(badAll), `必须点出 EAB 这个词，否则用户搜不到方向：${badAll.slice(0, 400)}`);
  assert(/litessl\.com/i.test(badAll), `必须给出取 EAB 的地址：${badAll.slice(0, 600)}`);
  assert(/--eab-kid/.test(badAll) && /--eab-hmac-key/.test(badAll),
    `必须给出可直接复制重跑的命令（凭据只能由用户去 CA 控制台取，脚本变不出来）：${badAll.slice(0, 800)}`);
  assert(!/REACHED_END/.test(badAll), '必须在「部署参数确认」阶段就退出，不能继续往下装东西');

  // ② 对照：给了 EAB 就必须放行（否则等于把所有 LiteSSL 用户挡在门外）
  const withEab = await spawnBashSnippet(snippet('litessl', 'kid-123', 'hmac-abc'));
  if (withEab.unavailable) return;
  assert(/REACHED_END/.test(withEab.out),
    `带上 --eab-kid/--eab-hmac-key 后必须通过参数校验：${(withEab.out + withEab.err).slice(0, 400)}`);

  // ③ 对照：LE / ZeroSSL 本来就免 EAB，一个都不能被卡住
  for (const ca of ['letsencrypt', 'zerossl']) {
    const ok = await spawnBashSnippet(snippet(ca, '', ''));
    if (ok.unavailable) return;
    assert(/REACHED_END/.test(ok.out),
      `${ca} 免 EAB/可自动换取 EAB，不该被 EAB 门禁拦下：${(ok.out + ok.err).slice(0, 400)}`);
  }

  // ④ 未知 CA 名必须报错，不得当成「不认识就按默认来」
  const bogus = await spawnBashSnippet(snippet('netease', '', ''));
  if (bogus.unavailable) return;
  assert.strictEqual(bogus.code, 1, '未知 CA 必须报错退出');
  assert(/证书颁发机构不合法/.test(bogus.out + bogus.err),
    `未知 CA 的错误要说人话并列出可选值：${(bogus.out + bogus.err).slice(0, 300)}`);
});

test('deploy.sh：HSTS 必须按证书来源区分（自签名发 max-age=0，正式证书才发长期 HSTS）', async () => {
  // 背景：正式证书签发失败回退自签名时，TLS 配置仍声明 max-age=31536000 的 HSTS。
  // 浏览器一旦记录该域名的 HSTS，再遇到自签名证书的错误就**没有「继续访问」入口**
  // （Chrome：「您目前无法访问 … 因为此网站使用了 HSTS」）—— 回退方案变成了整站不可达，
  // 比不回退还糟。正确行为：自签名下发 max-age=0（主动清除旧记录），正式证书才发长期 HSTS。
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
T="$(mktemp -d)"
DOMAIN=cos.example.com
APP_PORT=3000
SUB_PATH=/
NGINX_LINK=""
SELF_SIGNED_DIR="$T/ssl"
ACME_CERT_DIR="$T/ssl/acme"
mkdir -p "$T/ssl" "$T/ssl/acme"
: > "$T/ssl/privkey.pem"; : > "$T/ssl/fullchain.pem"
: > "$T/ssl/acme/privkey.pem"; : > "$T/ssl/acme/fullchain.pem"
NGINX_CONF="$T/self.conf"
write_nginx_conf 1 "$T/ssl/fullchain.pem" "$T/ssl/privkey.pem"
NGINX_CONF="$T/acme.conf"
write_nginx_conf 1 "$T/ssl/acme/fullchain.pem" "$T/ssl/acme/privkey.pem"
printf 'SELF_LONG=%s\\n' "$(grep -c 'max-age=31536000' "$T/self.conf" || true)"
printf 'SELF_ZERO=%s\\n' "$(grep -c 'max-age=0' "$T/self.conf" || true)"
printf 'ACME_LONG=%s\\n' "$(grep -c 'max-age=31536000' "$T/acme.conf" || true)"
printf 'ACME_ZERO=%s\\n' "$(grep -c 'max-age=0' "$T/acme.conf" || true)"
`);
  if (r.unavailable) return;
  const val = (k) => (new RegExp('^' + k + '=(\\d+)$', 'm').exec(r.out) || [])[1];
  assert.strictEqual(val('SELF_LONG'), '0',
    '自签名证书绝不能声明长期 HSTS：浏览器记录后，自签名的证书错误没有「继续访问」入口，整站无法访问');
  assert.notStrictEqual(val('SELF_ZERO'), '0',
    '自签名要主动下发 max-age=0，清除浏览器里可能已记录的旧 HSTS（否则老访客仍被锁死）');
  assert.notStrictEqual(val('ACME_LONG'), '0', '正式证书要保留长期 HSTS（防协议降级的本来目的）');
  assert.strictEqual(val('ACME_ZERO'), '0', '正式证书不得下发 max-age=0（会把有效防护清掉）');
});

test('deploy.sh：CA 速率限制（rateLimited/429）必须命中专属分支，且排在「连不上」之前', async () => {
  // 背景：用户实测 LE 返回 rateLimited，日志是：
  //   Error creating new order. Le_OrderFinalize not found.
  //   "type": "urn:ietf:params:acme:error:rateLimited", "status": 429
  //   detail: "too many certificates (50) already issued for \"l.cd\" ..."
  // 同时脚本打出「已存在 LE 的 ACME 账户，跳过注册」——用户误以为「账户坏了」，其实账户有效，
  // 是 CA 按「注册域名」限流。两个必须钉住的契约：
  //   1. rateLimited（驼峰、无空格）与 429/Le_OrderFinalize/too many 必须命中限流分支，不能漏判；
  //   2. 限流分支必须排在「连接失败」分支之前 —— 429 是 CA 明确返回的 HTTP 状态，说明网络是通的。
  const src = codeOnly(readDeploy());

  // 静态：判据（grep -qiE 那行）要覆盖 acme.sh 实际的报错措辞（驼峰 rateLimited → ratelimited、
  // Le_OrderFinalize、429）。必须锚定**判据行本身**（而非整个函数体）：提示文案里也会写
  // 「rateLimited / 429」这几个字，锚定函数体会让退回旧判据的变异仍被文案「救命」→ 抓不住。
  const hintsBody = codeOnly(fnBody(src, 'acme_failure_hints'));
  const rateGrepLine = hintsBody.split('\n').find((l) => /grep -qiE/.test(l) && /ratelimited|429/i.test(l));
  assert(rateGrepLine, '限流判据（grep 那行）必须含 ratelimited / Le_OrderFinalize / 429 —— acme.sh 被限流时输出的是这些驼峰词，旧判据「rate limit|too many」抓不到');
  assert(/ratelimited|Le_OrderFinalize|429/i.test(rateGrepLine),
    '判据行必须覆盖 429 与 ratelimited：429 恰恰证明网络可达，漏掉会误报成「连不上」');
  assert(/retry after|retry-after/i.test(hintsBody),
    '提示里要出现 retry-after，让人知道参数与等待时间在哪看');

  // 静态：限流分支必须排在「连接失败」分支之前（429 是明确响应，网络是通的）
  const rateIdx = hintsBody.indexOf(rateGrepLine);
  const connIdx = hintsBody.search(/cannot connect|failed to connect|timed out/i);
  assert(rateIdx >= 0 && connIdx >= 0 && rateIdx < connIdx,
    '限流分支必须排在「连接失败」之前：否则 429 的日志会被更宽泛的连接判据先吞掉，报成「连不上 CA」误导用户');

  // 行为验证：真实 source，用 stub 的日志喂给 acme_failure_hints
  const snippet = (fakeLog) => `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
CA_PROVIDER=letsencrypt
DOMAIN=bucketmg.l.cd
FAKE_LOG='${fakeLog}'
log_since_mark() { printf '%s' "$FAKE_LOG"; }
log_key_lines()  { sed -n '1,4p' <<<"$FAKE_LOG"; }
acme_failure_hints
printf '--HINTS--\\n'
printf '%s\\n' "\${HINTS[@]}"
`;
  const rateLog = `Using CA: https://acme-v02.api.letsencrypt.org/directory
Error creating new order. Le_OrderFinalize not found.
"type": "urn:ietf:params:acme:error:rateLimited",
"status": 429`;
  const r = await spawnBashSnippet(snippet(rateLog));
  if (r.unavailable) return;
  const all = r.out + r.err;
  assert(/速率限制|rateLimited|429/.test(all),
    `限流日志必须命中限流分支并点出「速率限制」，而不是笼统回退：${all.slice(0, 500)}`);
  assert(!/连不上 ACME/.test(all),
    `429 是 CA 明确返回的响应，绝不能报成「连不上 ACME 服务器」：${all.slice(0, 500)}`);
  assert(/l\.cd|注册域名|公共后缀/.test(all),
    `要说明限流按「注册域名/公共后缀」计，避免用户误以为「已存在的账户坏了」：${all.slice(0, 700)}`);
});

test('deploy.sh：acme.sh 的安装必须「先落盘校验再安装」，且带国内镜像兜底', () => {
  // 背景：官方安装器（get.acme.sh）实际从 raw.githubusercontent.com 取文件（读其源码确认），
  // 国内服务器连不上 GitHub → acme.sh 装不上 → 所有需要 EAB 的 CA 全军覆没
  // （certbot 又不支持 EAB 参数）→ 必然回退自签名。另外原来的 `curl … | sh`
  // 违反 D1-06 钉下的纪律（管道吞掉下载失败，$? 取右侧 sh 的 0）。
  const body = codeOnly(fnBody(readDeploy(), 'install_acme_sh'));
  assert(!/\|\s*(ba)?sh\b/.test(body),
    '不得用 curl … | sh 安装：管道会把左侧下载失败吞掉（$? 取的是右侧 sh 的 0），404/错误页也可能被当成脚本执行（D1-06 同型）');
  assert(/gitee\.com\/neilpang\/acme\.sh\/raw\/master\/acme\.sh/.test(body),
    '官方源（raw.githubusercontent.com）失败时必须兜底 gitee 镜像（acme.sh 官方 wiki《Install in China》给的地址）—— 否则国内服务器永远装不上 acme.sh');
  assert(/head -c 2/.test(body),
    '落盘后必须查首行 shebang（拦「镜像返回了错误页」）：curl -f 拦不住所有非脚本内容');
  assert(/bash -n/.test(body), '必须 bash -n 拦「是脚本但被截断」—— 与 reinstall_now 的双检同一条纪律');
  assert(/--cron --home/.test(body),
    '不跑官方 --install（它会写 root 的 crontab），续期任务自己落 /etc/cron.d，必须带 --cron --home');
});

test('deploy.sh：默认 CA 必须是 zerossl，且旧状态残留 letsencrypt 时要主动提醒换 CA', async () => {
  // 背景：用户在公共后缀域名（*.l.cd）上反复用 LE 被 rateLimited 拒签，明确要求「不要再使用 LE」。
  // 但之前跑 LE 时状态文件已持久化 CA_PROVIDER=letsencrypt，即使把默认值改成 zerossl，
  // 重跑仍会因 load_state 回读而继续走 LE。所以既要改默认值，也要在「没显式选 CA 却仍用 LE」时提醒。
  const src = readDeploy();

  // 静态：默认值必须是 zerossl（不再是 letsencrypt）
  assert(/CA_PROVIDER="zerossl"/.test(src),
    '默认 CA 必须是 zerossl：LE 按公共后缀共享 7 天配额、极易 rateLimited，不适合当默认');

  // 静态：要有「显式指定」标记，用于区分「用户就要 LE」与「状态残留 LE」
  const parseBody = codeOnly(fnBody(src, 'parse_args'));
  assert(/CA_EXPLICIT=1/.test(parseBody),
    '--ca / --tls 显式指定 CA 时必须置 CA_EXPLICIT=1，否则无法区分「用户就要 LE」与「状态文件残留 LE」');

  // 行为验证：真实 source，模拟「没显式传 --ca + 状态残留 letsencrypt」→ 必须打印换 CA 提醒
  const snippet = (caProvider, caExplicit) => `
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
DOMAIN=bucketmg.l.cd
TLS_MODE=auto
CA_PROVIDER=${caProvider}
CA_EXPLICIT=${caExplicit}
out="$(collect_config 2>&1)"
printf '%s\\n' "$out"
`;
  // ① 残留 LE + 未显式指定 → 必须提醒换 CA
  const r1 = await spawnBashSnippet(snippet('letsencrypt', 0));
  if (r1.unavailable) return;
  const a1 = r1.out + r1.err;
  assert(/rateLimited|速率限制|配额|限流/.test(a1),
    `旧状态残留 LE 且未显式指定时，必须提醒 LE 容易 rateLimited：${a1.slice(0, 500)}`);
  assert(/--ca zerossl/.test(a1),
    `提醒里必须给出可直接换 CA 的命令（--ca zerossl 零手工）：${a1.slice(0, 600)}`);
  assert(/--ca letsencrypt/.test(a1),
    `必须给出「确要 LE 就显式 --ca letsencrypt」的出口，避免用户以为只能用 LE：${a1.slice(0, 600)}`);

  // ② 显式指定 LE（CA_EXPLICIT=1）→ 不打扰
  const r2 = await spawnBashSnippet(snippet('letsencrypt', 1));
  if (r2.unavailable) return;
  assert(!/rateLimited|建议改用/.test(r2.out + r2.err),
    '用户显式拍板 --ca letsencrypt 时不得再打印换 CA 提醒（那是他自己的选择）');

  // ③ zerossl（新默认）→ 不提醒
  const r3 = await spawnBashSnippet(snippet('zerossl', 0));
  if (r3.unavailable) return;
  assert(!/rateLimited|建议改用/.test(r3.out + r3.err),
    'zerossl 本身就是默认推荐，不该触发换 CA 提醒');
});

test('deploy.sh：acme 证书落盘后不得因 reload 失败而误判「安装失败」回退自签名', async () => {
  // 背景：宝塔/自编译的 nginx 不是 systemd native service，`systemctl reload nginx` 报
  // "is not active, cannot reload"。acme.sh 的 --install-cert 会先把 key/fullchain 写进指定
  // 路径、之后才跑 --reloadcmd；reload 失败时 acme.sh 返回非零并打 "Reload error"，但证书
  // 其实已经装好了。之前 acme_install_cert 拿 run 的返回码直接判「安装失败」→ 回退自签名。
  const src = readDeploy();

  // 1) nginx_reload_cmd 必须优先 `nginx -s reload` 并依次兜底，不能按 INIT_SYSTEM 二分走 systemctl
  const rcBody = codeOnly(fnBody(src, 'nginx_reload_cmd'));
  assert(/nginx -s reload/.test(rcBody),
    'reload 命令必须优先 nginx -s reload：脚本已把宝塔/自编译的 nginx 二进制加进 PATH，systemctl reload 对非 native service 会报 is not active');
  assert(/systemctl reload nginx/.test(rcBody),
    '要保留 systemctl reload nginx 作为兜底（systemd native 场景）');

  // 2) acme_install_cert 成功判据是「证书是否落盘」，而非 run 的返回码
  const inst = codeOnly(fnBody(src, 'acme_install_cert'));
  assert(!/if ! run .*; then return 1; fi\s*\n\s*chmod/.test(inst) &&
         !/if ! run "\$\(acme_bin\)" "\$\{args\[@\]\}" <\/dev\/null; then return 1; fi/.test(inst),
    '不得再把 --install-cert 的 run 返回码直接当「安装失败」：reload 失败时 acme.sh 返回非零，但证书已落盘，会误回退自签名');
  assert(/! -s "\$\{dir\}\/privkey\.pem"/.test(inst) || /! -s "\$\{dir\}\/fullchain\.pem"/.test(inst),
    '成功判据必须是「privkey.pem / fullchain.pem 是否非空落盘」');

  // 3) 行为验证：模拟 acme.sh --install-cert 返回非零但证书已写盘 → 必须判成功
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
ACME_HOME="$(mktemp -d)"
DOMAIN=cos.example.com
dir="$(mktemp -d)"
printf 'KEY' > "$dir/privkey.pem"; printf 'CHAIN' > "$dir/fullchain.pem"
# 让 acme.sh 那步「失败」（返回非零），但证书文件已存在且非空
acme_bin() { printf 'false'; }
acme_install_cert "$dir"
printf 'RC=%s\\n' "$?"
`);
  if (r.unavailable) return;
  assert(/RC=0/.test(r.out),
    `证书已落盘时，即使 acme.sh 的 --install-cert（reloadcmd）失败也不该判「安装失败」：${(r.out + r.err).slice(0, 400)}`);
});

/**
 * ------------------------------------------------------------------
 * 重装不得把正式证书降级成服务器自签名（2026-09 现场故障）
 *
 * 现场原始日志：
 *   [信息] 已存在 ZeroSSL 的 ACME 账户，跳过注册（无需再次提供 EAB）。
 *   [错误] 命令执行失败（退出码 2）
 *   → SSL 证书退回服务器自签名。
 *
 * 两处根因，各钉一组：
 *   ① acme.sh 的退出码 2 是 `RENEW_SKIP`（源码第 93 行 `RENEW_SKIP=2`；`issue()` 在证书
 *      未到续期时间时打印 "Domains not changed. / Skipping. Next renewal time is: … /
 *      Add '--force' to force renewal." 之后 `return $RENEW_SKIP`）——**正常跳过，不是失败**。
 *      旧 `issue_acme_sh` 用裸 `run` 判「非零即失败」→ 回退自签名。
 *   ② 证书已装好且仍在有效期内时，重装压根不该再跑一遍申请：它可能失败（降级），
 *      也会白占 CA 的速率配额。`setup_tls` 必须**先判可复用、再决定是否申请**。
 *
 * 修完必须能回答的一句话：*「重装时，已经做完且没坏的事不再重做。」*
 * ------------------------------------------------------------------
 */
test('deploy.sh：acme.sh 退出码 2（RENEW_SKIP）不得被当成签发失败', async () => {
  const src = readDeploy();

  assert(hasFn(src, 'run_allow_rc'),
    '必须提供「可容忍指定退出码的 run」：否则无法既让调用方声明 2 属正常、又不掩盖真失败');
  assert(hasFn(src, 'acme_issue_skipped'),
    '「acme.sh 是否只是跳过续期」必须抽成独立判据函数（退出码 + 措辞双证据）');
  assert(/\nrun\(\) \{ _run_impl "" "\$@"; \}/.test(src),
    'run 必须等价于「不容忍任何退出码」，否则其他调用点的失败会被静默吞掉');

  const issue = codeOnly(fnBody(src, 'issue_acme_sh'));
  assert(/run_allow_rc 2 /.test(issue),
    '`acme.sh --issue` 必须以 run_allow_rc 2 调用 —— RENEW_SKIP 的退出码就是 2');
  assert(/acme_issue_skipped "\$rc"/.test(issue),
    '非零退出码必须先交给 acme_issue_skipped 判定，而不是直接当失败');
  assert(!/if ! run .*acme_bin.*\$\{args\[@\]\}/.test(issue),
    '不得再对 --issue 用裸 run 判失败：那正是把退出码 2 误判成「签发失败 → 回退自签名」的写法');
  assert(/RENEW_SKIP/.test(fnBody(src, 'issue_acme_sh')),
    '注释里要写明退出码 2 的语义（RENEW_SKIP），否则下一个人会把「容忍 2」那行当冗余删掉');

  const skipFn = codeOnly(fnBody(src, 'acme_issue_skipped'));
  assert(/rc == 2/.test(skipFn), 'acme_issue_skipped 必须把退出码 2 直接判为「跳过续期」');
  assert(/next renewal time is/i.test(skipFn) && /domains not changed/i.test(skipFn),
    '除退出码外还要认 acme.sh 的措辞：退出码可能被包装层改写，措辞才是它的直接证据');

  // 行为验证：三种输入 → 三种结论。措辞一路靠 log_since_mark 这个「日志来源」接缝注入，
  // 判据本体（哪些措辞、退出码怎么处理）仍跑真实代码。
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
if acme_issue_skipped 2; then printf 'RC2=skip\\n'; else printf 'RC2=fail\\n'; fi
FAKE_LOG=''
log_since_mark() { printf '%s\\n' "$FAKE_LOG"; }
FAKE_LOG='Domains not changed.
Skipping. Next renewal time is: Sun Oct 25 00:00:00 UTC 2026
Add --force to force renewal.'
if acme_issue_skipped 1; then printf 'TEXT=skip\\n'; else printf 'TEXT=fail\\n'; fi
FAKE_LOG='Error, can not get domain token.'
if acme_issue_skipped 1; then printf 'REAL=skip\\n'; else printf 'REAL=fail\\n'; fi
`);
  if (r.unavailable) return;
  const seen = `${r.out}${r.err}`;
  assert(/RC2=skip/.test(r.out),
    `退出码 2 必须判为「跳过续期」而不是失败：${seen.slice(0, 300)}`);
  assert(/TEXT=skip/.test(r.out),
    `退出码被改写、但日志里是 acme.sh 的跳过措辞时，也必须判为跳过：${seen.slice(0, 300)}`);
  assert(/REAL=fail/.test(r.out),
    `真正的失败（如拿不到域名校验 token）不得被判成「跳过续期」——那会让重装悄悄复用一张不存在的证书：${seen.slice(0, 300)}`);
});

test('deploy.sh：被允许的退出码不得打成 [错误]（误导用户的直接来源）', async () => {
  const src = readDeploy();
  const impl = codeOnly(fnBody(src, '_run_impl'));
  assert(/for code in \$allow/.test(impl),
    '「容忍哪些退出码」必须逐个比对（allow 是退出码列表），而不是只判非零');
  assert(/tolerated/.test(impl), '必须真的按 tolerated 分支决定打不打错误块');
  assert(/\nrun_allow_rc\(\) \{ .*_run_impl "\$allow" "\$@"; \}/.test(src),
    'run_allow_rc 必须把允许列表原样交给 _run_impl，不能自己吞掉返回码');
  const occurrences = (codeOnly(src).match(/命令执行失败/g) || []).length;
  assert(occurrences === 1,
    `「命令执行失败」只应出现在 _run_impl 里（实测 ${occurrences} 处）：多一处就意味着有别的路径绕过 allow 列表自己判失败`);

  // 行为验证：LOG_FILE 是 readonly 常量，测试改不了它 —— 不可写就跳过运行期断言
  // （脚本本体会 mkdir -p 它的目录，root 下必然可写；只影响开发机/CI）。
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
if ! : >>"$LOG_FILE" 2>/dev/null; then printf 'LOG_UNAVAILABLE\\n'; exit 0; fi
run_allow_rc 2 bash -c 'exit 2'   2>&1 | grep -c '命令执行失败' | sed 's/^/TOLERATED=/'
run bash -c 'exit 3'              2>&1 | grep -c '命令执行失败' | sed 's/^/STRICT=/'
run_allow_rc 2 bash -c 'exit 3'   2>&1 | grep -c '命令执行失败' | sed 's/^/OTHER=/'
`);
  if (r.unavailable || /LOG_UNAVAILABLE/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/TOLERATED=0/.test(r.out),
    `被允许的退出码（2）不该打印任何「命令执行失败」块 —— 这正是用户看到的「信息：跳过注册 / 错误：退出码 2」：${seen.slice(0, 300)}`);
  assert(/STRICT=1/.test(r.out),
    `未被允许的退出码仍必须打印错误块：容忍机制不能把真失败一起吞掉：${seen.slice(0, 300)}`);
  assert(/OTHER=1/.test(r.out),
    `只允许 2 时，退出码 3 仍要报错（不能退化成「只要声明了 allow 就全都放过」）：${seen.slice(0, 300)}`);
});

test('deploy.sh：tls_cert_reusable 的判据与阈值（「跳过申请」的前提）', async () => {
  const src = readDeploy();
  const m = /^CERT_REUSE_MIN_DAYS=(\d+)/m.exec(src);
  assert(m, '必须有 CERT_REUSE_MIN_DAYS 常量，作为「证书还够新、不必再申请」的天数阈值');
  const days = Number(m[1]);
  assert(days >= 1 && days <= 60,
    `阈值应落在 1..60 天：acme.sh 自己的每日任务在到期前 60 天续期，脚本不该越过它（当前 ${days}）`);

  const body = codeOnly(fnBody(src, 'tls_cert_reusable'));
  assert(/-checkend/.test(body),
    '必须用 openssl x509 -checkend 判「未来 N 天内会不会过期」：解析 notAfter 文本会撞上 BSD/GNU 的 date 语法差异');
  assert(/-s "\$\{dir\}\/fullchain\.pem"/.test(body) && /-s "\$\{dir\}\/privkey\.pem"/.test(body),
    'fullchain 与 privkey 两个文件都必须「存在且非空」才算可复用（缺一个就起不了 TLS）');

  // 行为验证：阈值两侧各留余量（90 天 ≫ 30、10 天 ≪ 30），外加三类「看似有文件其实不可用」
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
if ! command -v openssl >/dev/null 2>&1; then printf 'NO_OPENSSL\\n'; exit 0; fi
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
D="$T/acme"; mkdir -p "$D"
mkcert() {
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days "$1" \\
    -keyout "$D/privkey.pem" -out "$D/fullchain.pem" -subj '/CN=cos.example.com' >/dev/null 2>&1
}
rep() { if tls_cert_reusable "$D"; then printf '%s=reusable\\n' "$1"; else printf '%s=notreusable\\n' "$1"; fi; }
mkcert 90
rep FRESH_90D
mkcert 10
rep SOON_10D
rm -f "$D/privkey.pem"
rep NO_KEY
: > "$D/fullchain.pem"; printf 'k' > "$D/privkey.pem"
rep EMPTY_CHAIN
printf 'not a certificate' > "$D/fullchain.pem"
rep BAD_CERT
`);
  if (r.unavailable || /NO_OPENSSL/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/FRESH_90D=reusable/.test(r.out),
    `90 天有效期的证书必须判为可复用（阈值 ${days} 天）：${seen.slice(0, 300)}`);
  assert(/SOON_10D=notreusable/.test(r.out),
    `只剩 10 天的证书必须判为不可复用，不能因为「文件在」就跳过申请：${seen.slice(0, 300)}`);
  assert(/NO_KEY=notreusable/.test(r.out),
    `缺 privkey.pem 必须判为不可复用（只查 fullchain 会让 Nginx 起不来）：${seen.slice(0, 300)}`);
  assert(/EMPTY_CHAIN=notreusable/.test(r.out),
    `空的 fullchain.pem 必须判为不可复用（判据是「非空」-s，不是「存在」-e）：${seen.slice(0, 300)}`);
  assert(/BAD_CERT=notreusable/.test(r.out),
    `不是证书的文件必须判为不可复用：判据不能只看文件大小，得真让 openssl 读一遍：${seen.slice(0, 300)}`);
});

test('deploy.sh：证书已装好且仍在有效期内 → 重装跳过申请（不重跑已完成步骤）', async () => {
  const src = readDeploy();
  const tls = codeOnly(fnBody(src, 'setup_tls'));
  const iReuse = tls.indexOf('tls_cert_reusable "$ACME_CERT_DIR"');
  const iIssue = tls.indexOf('issue_cert');
  assert(iReuse !== -1,
    'setup_tls 的 auto|acme 分支必须先用 tls_cert_reusable 判「证书是否可复用」');
  assert(iIssue !== -1 && iReuse < iIssue,
    '「可复用就跳过」的判定必须排在 issue_cert 之前：排在后面等于照样跑一遍申请（照样可能降级）');
  assert(/FORCE_CERT/.test(tls),
    '必须有逃生门 FORCE_CERT：用户想强制重签时不能被「跳过」挡住');
  assert(!/SELF_SIGNED_DIR/.test(tls),
    '可复用判据只能认 ACME_CERT_DIR（正式证书）这一个来源：把自签名目录也算进去，「正式证书掉了」就永远修不回来');

  // 行为验证：四个场景 —— 够新则跳过、临近到期则申请、没有则申请、--force-cert 则强制申请
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
if ! command -v openssl >/dev/null 2>&1; then printf 'NO_OPENSSL\\n'; exit 0; fi
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
OUTF="$T/setup-tls.out"
ACME_CERT_DIR="$T/acme"
SELF_SIGNED_DIR="$T/self"
TLS_MODE=auto

ISSUE_CALLS=0
issue_cert() { ISSUE_CALLS=$((ISSUE_CALLS + 1)); CERT_FULLCHAIN="$ACME_CERT_DIR/fullchain.pem"; CERT_KEY="$ACME_CERT_DIR/privkey.pem"; return 0; }
gen_self_signed() { printf 'SELFSIGNED\\n'; }
write_nginx_conf() { :; }
nginx_apply() { :; }

mkcert() {
  mkdir -p "$ACME_CERT_DIR"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days "$1" \\
    -keyout "$ACME_CERT_DIR/privkey.pem" -out "$ACME_CERT_DIR/fullchain.pem" \\
    -subj '/CN=cos.example.com' >/dev/null 2>&1
}

# 注意：setup_tls 的输出**不能**用 out="$(setup_tls ...)" 接 —— 命令替换是子 shell，
# issue_cert 里的 ISSUE_CALLS 计数与 CERT_FULLCHAIN 赋值都传不回来，四个场景会
# 一律显示 ISSUE=0、把「该申请时没申请」变成假绿。改为重定向到文件再读。
case_run() {
  local label="$1" force="$2" src=OTHER skip=0 back=0
  ISSUE_CALLS=0
  CERT_FULLCHAIN=""
  FORCE_CERT="$force"
  setup_tls >"$OUTF" 2>&1
  if [[ "$CERT_FULLCHAIN" == "$ACME_CERT_DIR/fullchain.pem" ]]; then src=ACMECERT; fi
  if grep -q '跳过证书申请' "$OUTF"; then skip=1; fi
  if grep -q '改用自签名' "$OUTF"; then back=1; fi
  printf '%s|ISSUE=%s|CERT=%s|SKIPMSG=%s|FALLBACK=%s\\n' "$label" "$ISSUE_CALLS" "$src" "$skip" "$back"
}

mkcert 90
case_run FRESH_90D 0
mkcert 10
case_run SOON_10D 0
rm -rf "$ACME_CERT_DIR"
case_run NO_CERT 0
mkcert 90
case_run FORCE_CERT 1
`);
  if (r.unavailable || /NO_OPENSSL/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/FRESH_90D\|ISSUE=0\|CERT=ACMECERT\|SKIPMSG=1\|FALLBACK=0/.test(r.out),
    `证书还在有效期内时，重装必须一条申请命令都不发（ISSUE=0）、打出跳过提示、且绝不回退自签名：${seen.slice(0, 400)}`);
  assert(/SOON_10D\|ISSUE=1\|/.test(r.out),
    `证书临近到期时必须照旧去申请（ISSUE=1），「跳过」不能变成永久不续期：${seen.slice(0, 400)}`);
  assert(/NO_CERT\|ISSUE=1\|/.test(r.out),
    `没有证书时必须去申请（ISSUE=1）：跳过分支不能把「首次部署」也一起跳过：${seen.slice(0, 400)}`);
  assert(/FORCE_CERT\|ISSUE=1\|/.test(r.out),
    `--force-cert 必须能压过「可复用就跳过」（ISSUE=1），否则用户没有任何手段重签：${seen.slice(0, 400)}`);
});

/**
 * 用户现场那条日志的**端到端**复现：
 *   [信息] 已存在 ZeroSSL 的 ACME 账户，跳过注册（无需再次提供 EAB）。
 *   [错误] 命令执行失败（退出码 2）
 * 上面的第 29 条只单独验了 `acme_issue_skipped` 的判据；这一条把 `issue_acme_sh` 整条路径
 * 跑一遍（账户已存在 → --issue → --install-cert），确认它最终返回 0、不打错误块、
 * 并把 CERT_FULLCHAIN 指到 `ACME_CERT_DIR` —— 也就是「重装不再降级为自签名」。
 *
 * 三个输入各钉一件事：
 *   · RENEWAL_2（回放 acme.sh 的真实措辞 + 退出码 2）→ 措辞与退出码任一成立即判跳过；
 *   · SILENT_2（什么都不打印，只退出 2）→ **只有退出码这一条证据**，
 *     这正是「判据必须认退出码 2」的最小反例（撤掉它这条必红）；
 *   · ERROR_1（真失败）→ 仍要判失败并打「签发失败」，容忍机制不能把真失败一起吞掉。
 */
test('deploy.sh：账户已存在 + --issue 退出码 2 → 重装判成功并复用证书（现场日志端到端）', async () => {
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
if ! : >>"$LOG_FILE" 2>/dev/null; then printf 'LOG_UNAVAILABLE\\n'; exit 0; fi
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
ACME_CERT_DIR="$T/acme"; mkdir -p "$ACME_CERT_DIR"
DOMAIN=cos.example.com
EMAIL=you@example.com
CA_PROVIDER=zerossl

# 把 acme.sh 换成一个假体：措辞照抄 acme.sh issue() 的真实输出，退出码由环境变量给。
# 用带引号的 heredoc（'FAKE'）—— 里面必须保持字面，不能被展开。
fake_acme() {
  cat > "$T/acme.sh" <<'FAKE'
#!/usr/bin/env bash
if [[ "$FAKE_MODE" == "renewal" ]]; then
  echo "Domains not changed."
  echo "Skipping. Next renewal time is: Sun Oct 25 00:00:00 UTC 2026"
  echo "Add '--force' to force renewal."
elif [[ "$FAKE_MODE" == "error" ]]; then
  echo "Error, can not get domain token."
fi
exit "$FAKE_RC"
FAKE
  chmod +x "$T/acme.sh"
  acme_bin() { printf '%s' "$T/acme.sh"; }
}

install_acme_sh() { return 0; }
ca_server() { printf 'https://acme.zerossl.com/v2/DV90'; }
ca_label() { printf 'ZeroSSL'; }
acme_account_exists() { return 0; }
acme_install_cert() { return 0; }

probe() {
  local label="$1" mode="$2" frc="$3" out="$T/out.txt" rc=0
  fake_acme
  FAKE_MODE="$mode"; export FAKE_MODE
  FAKE_RC="$frc"; export FAKE_RC
  CERT_FULLCHAIN=""
  issue_acme_sh >"$out" 2>&1
  rc=$?
  printf '%s|RC=%s|ERRBLOCK=%s|SKIPMSG=%s|FAILMSG=%s|SIGNED=%s\\n' "$label" "$rc" \\
    "$(grep -c '命令执行失败' "$out")" \\
    "$(grep -c '跳过续期' "$out")" \\
    "$(grep -c '签发失败' "$out")" \\
    "$(if [[ "$CERT_FULLCHAIN" == "$ACME_CERT_DIR/fullchain.pem" ]]; then printf ok; else printf bad; fi)"
}

probe RENEWAL_2 renewal 2
probe SILENT_2  silent  2
probe ERROR_1   error   1
`);
  if (r.unavailable || /LOG_UNAVAILABLE/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/RENEWAL_2\|RC=0\|ERRBLOCK=0\|SKIPMSG=1\|FAILMSG=0\|SIGNED=ok/.test(r.out),
    `现场那条「跳过注册 + 退出码 2」必须判成功：不打错误块、打印「跳过续期」、并把证书指向 ACME_CERT_DIR：${seen.slice(0, 500)}`);
  assert(/SILENT_2\|RC=0\|ERRBLOCK=0\|SKIPMSG=1\|/.test(r.out),
    `acme.sh 什么也不打印、只以退出码 2 收场时，也必须判「跳过续期」——退出码是这条判据的主证据，不能只靠日志措辞：${seen.slice(0, 500)}`);
  assert(/ERROR_1\|RC=1\|ERRBLOCK=1\|SKIPMSG=0\|FAILMSG=1\|SIGNED=bad/.test(r.out),
    `真失败（拿不到域名校验 token）仍须判失败并打「签发失败」：容忍退出码 2 不能把真失败一起吞掉：${seen.slice(0, 500)}`);
});

/**
 * ------------------------------------------------------------------
 * 「脚本自动安装 git 失败。这种最基础的操作不应该出问题。」
 *
 * 现场（CentOS 8）：`dnf install -y git` 失败，日志里
 *   Invalid configuration value: failovermethod=priority …   ← 无害警告，刷了 5 行
 *   Problem: package git-2.27.0-1.el8.x86_64 requires perl(Git) …
 *   - package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering
 *
 * 旧实现**已经能识别**这是模块流问题，但只把 `dnf module reset perl` 打印给用户，
 * 让用户自己去敲。而 git 走的是**可选**通道，装不上只降级不中断 —— 于是
 * 重装时 `prepare_source` 才发现没有 git，整个部署卡在拉源码那一步。
 *
 * 修法：**能自己修的绝不推回给人。** 识别到模块流不一致就自己
 * reset → 按报错里期望的流 enable → 重试；两个安装通道都要接上。
 * 边界：只对**能确定原因**的失败动手，拿不准就不碰系统。
 * ------------------------------------------------------------------
 */
test('deploy.sh：git 装不上时必须先自动修好模块流，而不是只打印提示', async () => {
  const src = readDeploy();

  // 1) 判据只能有一份：诊断与自动修复各判一次，迟早出现「诊断说 A、修复去修 B」
  assert(hasFn(src, 'pkg_failure_kind'),
    '失败原因分类必须抽成 pkg_failure_kind（唯一实现点），否则诊断与自动修复的两套判据会漂移');
  assert(hasFn(src, 'pkg_auto_repair') && hasFn(src, 'pkg_repair_modular_streams'),
    '必须有「自动修复 + 重试」这条路径：识别出原因却只打印命令，等于把最基础的一步推回给用户');
  const diag = codeOnly(fnBody(src, 'on_pkg_failure'));
  assert(/pkg_failure_kind/.test(diag),
    'on_pkg_failure 必须直接用 pkg_failure_kind 的结论分支');
  assert(!/elif grep -q/.test(diag),
    'on_pkg_failure 里不得再留一份自己的 grep 判据 —— 两份判据必然漂移（这正是本仓反复中招的形态）');

  // 2) 两个通道都要接上自动修复。**git 走的是 pkg_install_opt**，
  //    只在 pkg_install 里修等于没修（用户看到的正是这条通道）。
  for (const fn of ['pkg_install', 'pkg_install_opt']) {
    const body = codeOnly(fnBody(src, fn));
    assert(/pkg_auto_repair/.test(body),
      `${fn} 必须先尝试自动修复：git 走的是可选通道，只在必需通道里修等于没修`);
    assert(/PKG_AUTO_REPAIR_TRIED=0/.test(body),
      `${fn} 每次调用前要重置「已尝试自动修复」标记，否则下一次失败会误报「脚本已自动尝试过」`);
  }

  // 3) 行为：git 装上（修复后成功）→ 返回 0、且**不输出任何失败诊断**
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
if ! : >>"$LOG_FILE" 2>/dev/null; then printf 'LOG_UNAVAILABLE\\n'; exit 0; fi
# 清空日志：log_since_mark 是「失败日志」的唯一来源，残留内容会让 pkg_failure_kind
# 读到上一次运行的东西（假绿假红都可能）。这是部署脚本自己的日志文件。
: > "$LOG_FILE"
T="$(mktemp -d)"; trap 'rm -rf "$T" 2>/dev/null || true' EXIT
CALLS="$T/calls.txt"

PM=dnf
FIXED=0
# 假 dnf：install 先失败（照抄现场那两行），module enable 之后再装就成功。
# 这样「自动修复到底有没有让它装上」是可观测的，而不是只看有没有打印提示。
dnf() {
  printf '%s\\n' "$*" >>"$CALLS"
  case "$1" in
    module) case "$2" in
        list)   printf 'Name Stream Profiles Summary\\nperl 5.26 common Practical Extraction\\n'; return 0 ;;
        reset)  return 0 ;;
        enable) FIXED=1; return 0 ;;
      esac ;;
    clean|makecache) return 0 ;;
    install)
      if ((FIXED)); then printf 'Complete!\\n'; return 0; fi
      printf 'Problem: package git-2.27.0-1.el8.x86_64 requires perl-Git\\n' >&2
      printf -- '- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering\\n' >&2
      return 1 ;;
  esac
  return 1
}

( pkg_install_opt git ) >"$T/opt" 2>&1 </dev/null
printf 'OPT_RC=%s\\n' "$?"
printf 'OPT_CALLS=%s\\n' "$(tr '\\n' '|' < "$CALLS")"
printf 'OPT_DIAG=%s\\n' "$(grep -c '模块流（module stream）' "$T/opt")"
printf 'OPT_WARN=%s\\n' "$(grep -c '可选依赖安装失败' "$T/opt")"

: > "$CALLS"; FIXED=0
( pkg_install perl-pack ) >"$T/hard" 2>&1 </dev/null
printf 'HARD_RC=%s\\n' "$?"
printf 'HARD_DIAG=%s\\n' "$(grep -c '模块流（module stream）' "$T/hard")"
`);
  if (r.unavailable || /LOG_UNAVAILABLE/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/OPT_RC=0/.test(r.out),
    `git 必须在自动修复后真的装上（返回 0）：${seen.slice(0, 600)}`);
  assert(/module reset -y perl/.test(r.out) && /module enable -y perl:5\.26/.test(r.out),
    `自动修复必须复位模块流并按报错里期望的流重新启用（perl:5.26）：${seen.slice(0, 600)}`);
  // 用「|module reset -y perl|」把边界一起钉住：否则 `..._reset -y perl-libs|`
  // 会因为前缀相同而假绿 —— 而 perl-libs 根本不是模块名，reset 它只会多刷一行错。
  assert(/OPT_CALLS=[^\n]*\|module reset -y perl\|[^\n]*\|makecache\|[^\n]*install -y git\|/.test(r.out),
    `修复之后必须**重试安装**（否则 reset/enable 白做，git 还是没装上）：${seen.slice(0, 600)}`);
  // 顺序断言：`printf '%s' "$*"` 打印的是**展开后**的参数，引号是 shell 语法、不在参数里，
  // 所以这里不能带引号（引号属于源码层面的事，由「纯净系统」那条用例的静态部分钉住）。
  const calls = (/OPT_CALLS=([^\n]*)/.exec(r.out) || [])[1] || '';
  const iHot = calls.indexOf('--setopt=*.module_hotfixes=true');
  const iReset = calls.indexOf('|module reset -y perl|');
  assert(iHot >= 0 && iReset >= 0 && iHot < iReset,
    `绕过模块过滤必须排在复位模块流**之前**（零副作用的一档在前）—— 实际调用序：${calls}`);
  assert(/OPT_DIAG=0/.test(r.out) && /OPT_WARN=0/.test(r.out),
    `自动修好之后不得再打失败诊断/降级警告：用户不该看到一个已经被自己解决的错误：${seen.slice(0, 600)}`);
  assert(/HARD_RC=0/.test(r.out) && /HARD_DIAG=0/.test(r.out),
    `必需通道同样要能自动修好（否则 nginx/nodejs 这类包一失败就走到 die）：${seen.slice(0, 600)}`);
});

test('deploy.sh：自动修复的边界 —— 只修能确定原因的，且不用 --skip-broken', async () => {
  const src = readDeploy();

  // --skip-broken 会「跳过装不上的包」却仍返回 0：pkg_install 于是以为装好了，
  // 而 `have git` 依旧是假。错误被吞进返回码里 —— 本仓最忌讳的一种假成功。
  assert(!/--skip-broken/.test(codeOnly(src)),
    '不得使用 --skip-broken：它让「装不上」返回 0，pkg_install 会误判为成功，而 have git 仍为假');
  assert(/--nobest/.test(codeOnly(src)),
    '放宽候选版本要用 --nobest：它允许选非最佳版本，装不上仍会如实返回非零');

  // --nobest 只能出现在「确认修过模块流之后」：没搞清原因就放宽版本，
  // 等于换一个版本装上、把问题推给下一个环节。
  const repair = codeOnly(fnBody(src, 'pkg_repair_modular_streams'));
  const auto = codeOnly(fnBody(src, 'pkg_auto_repair'));
  assert(/pkg_run_pm_nobest/.test(repair),
    '--nobest 的降级重试要挂在「模块流修好但仍装不上」之后');
  assert(!/pkg_run_pm_nobest/.test(auto),
    '不得在 pkg_auto_repair 里无条件试 --nobest：那会在没识别出原因时也放宽版本选择');
  assert(!/network|missing|lock|space|perm|gpg/.test(auto),
    '自动修复只对「能确定原因且自己能解决」的失败动手（目前只有 modular）；把别的类别拉进来等于瞎改系统');

  // 行为：「解析不到被过滤的包」时**一个 module 操作都不做**（退化成原有流程，不冒险）
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
if ! : >>"$LOG_FILE" 2>/dev/null; then printf 'LOG_UNAVAILABLE\\n'; exit 0; fi
T="$(mktemp -d)"; trap 'rm -rf "$T" 2>/dev/null || true' EXIT
CALLS="$T/calls.txt"
PM=dnf
: > "$LOG_FILE"

case_run() {
  local label="$1" mode="$2"
  : > "$CALLS"; : > "$LOG_FILE"
  if [[ "$mode" == "network" ]]; then
    dnf() { printf '%s\\n' "$*" >>"$CALLS"; printf 'Could not resolve host: mirrors.example.com\\n' >&2; return 1; }
  elif [[ "$mode" == "moduleonly" ]]; then
    dnf() { printf '%s\\n' "$*" >>"$CALLS"; case "$1" in install) printf 'Error: Problem: requires module(perl:5.26)\\n' >&2 ;; esac; return 1; }
  else
    dnf() {
      printf '%s\\n' "$*" >>"$CALLS"
      case "$1" in
        module) case "$2" in list) printf 'Name Stream Profiles Summary\\nperl 5.26 common x\\n'; return 0 ;; reset|enable) return 0 ;; esac ;;
        clean|makecache) return 0 ;;
        install) printf -- '- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering\\n' >&2; return 1 ;;
      esac
      return 1
    }
  fi
  ( pkg_install_opt git ) >"$T/$label.out" 2>&1 </dev/null
  printf '%s_FIX_ACTS=%s\\n' "$label" "$(grep -c -E 'module (reset|enable)|nobest|setopt' "$CALLS")"
  printf '%s_MODULE_ACTS=%s\\n' "$label" "$(grep -c -E 'module (reset|enable)' "$CALLS")"
}

case_run NETWORK network
case_run MODULEONLY moduleonly
case_run REPAIRFAIL repairfail
`);
  if (r.unavailable || /LOG_UNAVAILABLE/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/NETWORK_FIX_ACTS=0/.test(r.out),
    `网络类失败时**一个修复动作都不该做** —— 绕过过滤/复位模块流/nobest 与原因毫无关系，只会白改一通系统：${seen.slice(0, 600)}`);
  assert(/MODULEONLY_MODULE_ACTS=0/.test(r.out),
    `日志里解析不出「哪个包被过滤」时，绝不去 reset/enable 模块流（那是全局状态变更，改错方向比不改更糟）：${seen.slice(0, 600)}`);
  assert(/MODULEONLY_FIX_ACTS=1/.test(r.out),
    `但零副作用的「绕过模块过滤」可以且只应该试一次（它不改机器状态，试它不冒险）：${seen.slice(0, 600)}`);
  assert(/REPAIRFAIL_MODULE_ACTS=[1-9]/.test(r.out),
    `反之，识别到被过滤的包就必须真的动手（否则这条护栏自己没打在修复路径上）：${seen.slice(0, 600)}`);
  assert(/REPAIRFAIL_FIX_ACTS=[2-9]/.test(r.out),
    `修不好时要走完「绕过过滤 → 复位模块流 → 放宽候选」这一串，而不是只试一档就放弃：${seen.slice(0, 600)}`);
});

test('deploy.sh：模块流判据与解析（纯函数）+ failovermethod 是无害警告', async () => {
  const src = readDeploy();

  // 「无人知晓的无害警告」比错误本身更耗时：它刷 5 行、最显眼，却不是失败原因。
  // 真实故障现场里用户正是被它带偏的，所以脚本必须主动说清。
  assert(/Invalid configuration value.*failovermethod/.test(src),
    '必须识别并说明 CentOS 8 的 failovermethod 警告：它是旧版 yum 的选项，dnf 不支持，与安装失败无关');
  const kindFn = codeOnly(fnBody(src, 'pkg_failure_kind'));
  assert(!/failovermethod/.test(kindFn),
    'failovermethod 不得参与失败原因分类 —— 它只是一行警告，进了判据会让分类整体走偏');

  // 解析必须**动态**来做，不能硬编码 perl/5.26：换成别的被过滤包（nodejs 等）时，
  // 写死的提示会直接把人带偏。
  const modularBranch = codeOnly(fnBody(src, 'on_pkg_failure'));
  assert(!/module reset -y perl/.test(modularBranch),
    '诊断里的手工命令必须按解析结果生成，不得硬编码 perl —— 换个被过滤的包（如 nodejs）提示就全错了');
  assert(/modular_suspects/.test(modularBranch),
    '诊断分支必须复用 modular_suspects 的解析结果');

  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
printf 'SV3=%s\\n' "$(stream_from_version 5.26.3)"
printf 'SV2=%s\\n' "$(stream_from_version 5.26)"
printf 'SV1=%s\\n' "$(stream_from_version 7)"
printf 'SV0=[%s]\\n' "$(stream_from_version '')"

printf 'CAND=%s\\n' "$(module_name_candidates perl-libs | tr '\\n' ',')"
printf 'CAND2=%s\\n' "$(module_name_candidates perl | tr '\\n' ',')"

LOG='- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering
- package perl-libs-4:5.26.3-420.el8.i686 is filtered out by modular filtering
- package nodejs-npm-1:10.21.0-3.module_el8.x86_64 is filtered out by modular filtering
Error: something else entirely'
printf 'SUSPECTS=%s\\n' "$(modular_suspects "$LOG" | tr '\\n' ',')"

# 现场那条完整日志（原样抄，含最容易把人带偏的 failovermethod 那几行）
TMPLOG="$(mktemp)"; trap 'rm -f "$TMPLOG" 2>/dev/null || true' EXIT
cat >"$TMPLOG" <<'USERLOG'
Invalid configuration value: failovermethod=priority in /etc/yum.repos.d/CentOS-Base.repo; Configuration: OptionBinding with id "failovermethod" does not exist
Last metadata expiration check: 1:23:03 ago on Sun 27 Sep 2026 01:34:05 PM CST.
Error:
 Problem: package git-2.27.0-1.el8.x86_64 requires perl(Git), but none of the providers can be installed
 - package git-2.27.0-1.el8.x86_64 requires perl(Git::I18N), but none of the providers can be installed
 - package perl-Git-2.27.0-1.el8.noarch requires perl(:MODULE_COMPAT_5.26.3), but none of the providers can be installed
 - conflicting requests
 - package perl-libs-4:5.26.3-420.el8.i686 is filtered out by modular filtering
 - package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering
USERLOG
printf 'KIND_USER=%s\\n' "$(pkg_failure_kind "$(cat "$TMPLOG")")"

FAKE_LOG='Invalid configuration value: failovermethod=priority in /etc/yum.repos.d/CentOS-Base.repo; Configuration: OptionBinding with id "failovermethod" does not exist
- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering'
log_since_mark() { printf '%s' "$FAKE_LOG"; }
log_key_lines()  { sed -n '1,5p' <<<"$FAKE_LOG"; }
PM=dnf; VERSION_ID=8
on_pkg_failure git 1 2>&1 | grep -c -E 'failovermethod.*无害|无害警告' | sed 's/^/FOOTNOTE=/'
`);
  if (r.unavailable) return;
  const seen = `${r.out}${r.err}`;
  assert(/SV3=5\.26/.test(r.out) && /SV2=5\.26/.test(r.out) && /SV1=7/.test(r.out),
    `包版本必须收敛成模块流号（5.26.3 → 5.26）：${seen.slice(0, 400)}`);
  assert(/CAND=perl-libs,perl,/.test(r.out),
    `包名要能推出候选模块名（perl-libs → perl-libs/perl），存在与否交给 module list 验证、不靠猜：${seen.slice(0, 400)}`);
  assert(/SUSPECTS=perl-libs 5\.26,perl-libs 5\.26,nodejs-npm 10\.21,/.test(r.out),
    `必须从报错里解出「被过滤的包 + 期望流版本」（i686/x86_64 两条都命中、别的行不能混进来）：${seen.slice(0, 400)}`);
  assert(/KIND_USER=modular/.test(r.out),
    `现场那条日志必须被归类为 modular：${seen.slice(0, 400)}`);
  assert(/FOOTNOTE=[1-9]/.test(r.out),
    `failovermethod 出现时必须主动说明它是无害警告，否则用户会顺着它查错方向：${seen.slice(0, 400)}`);
});

/*
 * ------------------------------------------------------------------
 * 「即使是全新安装的纯净系统也出现这种情况」
 *
 * 这一句把上一版的修复方向整个推翻：先前认定 `perl-libs` 被过滤是「模块流状态与仓库
 * 期望不一致」，于是自动修复只做 `module reset perl && module enable perl:5.26`。
 * 但在**纯净系统**上模块流本来就是一致的 —— reset + enable 全是空转，
 * 那台机器上永远不会成功。真正的机制是 RHEL 8 的 module failsafe：它按模块的
 * 包级过滤清单屏蔽掉 `perl-libs`，与机器上的模块流状态无关。
 *
 * 对策是 dnf 官方的 `module_hotfixes`：让仓库按**包级**视图参与求解、不套模块过滤。
 * 它只影响**本次事务**，不写任何持久状态 —— 因此比 reset/enable（**全局**改机器
 * 模块流状态）安全得多，必须排在前面。
 *
 * ⚠️ 那个 `*` 的引号是必须的：不引会被 shell 当通配符在当前目录做 glob 展开，
 * dnf 收到的是被换成文件名的垃圾参数，而失败信息完全看不出是这个原因。
 * ------------------------------------------------------------------
 */
test('deploy.sh：纯净系统上的 module failsafe 必须靠 --setopt 绕过模块过滤直接装上（不动系统模块流）', async () => {
  const src = readDeploy();
  const code = codeOnly(src);

  assert(hasFn(src, 'pkg_run_pm_hotfixes'),
    '必须有「绕过模块过滤」这一档：纯净系统上模块流状态本来就是对的，reset/enable 修不动它');

  // 引号：唯一能防住 shell glob 的东西。
  // 判据必须是「**每一处** --setopt= 后面都紧跟引号」—— 用负向前瞻而不是枚举非法字符：
  // `--setopt=[^*'"\s]` 那种写法在引号被去掉后紧跟的正是 `*`，会**恰好漏判**（本轮实测）。
  const unquoted = code.match(/--setopt=(?!')/g) || [];
  assert.deepStrictEqual(unquoted, [],
    "`--setopt=` 后面必须紧跟引号（判据要覆盖**每一处**出现，不只实现处）：不引起来的话那个 * "
    + '会被 shell 当通配符在当前目录做 glob 展开成文件名，dnf 收到垃圾参数且失败信息完全看不出原因');
  assert((code.match(/--setopt='/g) || []).length >= 2,
    '实现处与诊断提示处都要给出带引号的命令（用户会原样复制提示里的那条）');

  // 首选：必须排在 reset/enable 之前（后者是全局状态变更，副作用大且对纯净系统无效）
  const auto = codeOnly(fnBody(src, 'pkg_auto_repair'));
  const iHot = auto.indexOf('pkg_run_pm_hotfixes');
  const iReset = auto.indexOf('pkg_repair_modular_streams');
  assert(iHot >= 0 && iReset >= 0 && iHot < iReset,
    '自动修复必须先试「绕过模块过滤」，再试「复位模块流」——顺序反了的话纯净系统会先去空转一遍');

  // 判据要认这个机制名（日志里可能出现 modulefailsafe / module_hotfixes 的措辞）
  const kindFn = codeOnly(fnBody(src, 'pkg_failure_kind'));
  assert(/modulefailsafe/.test(kindFn),
    '失败判据必须认得 modulefailsafe：它才是纯净系统上 perl-libs 被屏蔽的机制名');

  // 行为：纯净系统（模块流状态正常）—— 只有带 --setopt 的那次能装上，且**不许碰模块流**
  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
if ! : >>"$LOG_FILE" 2>/dev/null; then printf 'LOG_UNAVAILABLE\\n'; exit 0; fi
: > "$LOG_FILE"
T="$(mktemp -d)"; trap 'rm -rf "$T" 2>/dev/null || true' EXIT
CALLS="$T/calls.txt"
PM=dnf
# 纯净 RHEL 8：模块流状态是好的（module list 也正常），但 failsafe 照样屏蔽 perl-libs。
# 只有「绕过过滤」那一次能成功 —— 这正是用户现场。
dnf() {
  printf '%s\\n' "$*" >>"$CALLS"
  case "$*" in *module_hotfixes*) printf 'Complete!\\n'; return 0 ;; esac
  case "$1" in
    module) printf 'Name Stream Profiles Summary\\nperl 5.26 common Practical Extraction\\n'; return 0 ;;
    install)
      printf 'Problem: package git-2.27.0-1.el8.x86_64 requires perl-Git\\n' >&2
      printf -- '- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering\\n' >&2
      return 1 ;;
  esac
  return 1
}

( pkg_install_opt git ) >"$T/opt" 2>&1 </dev/null
printf 'PURE_RC=%s\\n' "$?"
printf 'PURE_CALLS=%s\\n' "$(tr '\\n' '|' < "$CALLS")"
printf 'PURE_MODULE_OPS=%s\\n' "$(grep -c -E 'module (reset|enable|list)|nobest' "$CALLS")"
printf 'PURE_DIAG=%s\\n' "$(grep -c '【判断】' "$T/opt")"
printf 'PURE_WARN=%s\\n' "$(grep -c '可选依赖安装失败' "$T/opt")"

: > "$CALLS"
( pkg_install git ) >"$T/hard" 2>&1 </dev/null
printf 'HARD_RC=%s\\n' "$?"
`);
  if (r.unavailable || /LOG_UNAVAILABLE/.test(r.out)) return;
  const seen = `${r.out}${r.err}`;
  assert(/PURE_RC=0/.test(r.out),
    `纯净系统上必须靠绕过过滤直接装上（返回 0）：${seen.slice(0, 600)}`);
  // 桩里 `printf '%s' "$*"` 打印的是**展开后**的参数，引号不在其中（引号是 shell 语法）
  // —— 引号那一层由本用例上半段的静态断言负责，这里只钉「确实发出了这条命令」。
  assert(/PURE_CALLS=[^\n]*install -y --setopt=\*\.module_hotfixes=true git\|/.test(r.out),
    `必须真的发出带 --setopt 的安装命令（而不是只打提示）：${seen.slice(0, 600)}`);
  assert(/PURE_MODULE_OPS=0/.test(r.out),
    `绕过过滤就够了的话，绝不该再去 reset/enable/list 模块流 —— 那是对**机器全局状态**的无谓改动：${seen.slice(0, 600)}`);
  assert(/PURE_DIAG=0/.test(r.out) && /PURE_WARN=0/.test(r.out),
    `修好之后不得再打失败诊断/降级警告：用户不该看到一个已经被自己解决的错误：${seen.slice(0, 600)}`);
  assert(/HARD_RC=0/.test(r.out),
    `必需通道同样要能靠绕过过滤装好（否则 nginx/nodejs 这类包一失败就走到 die）：${seen.slice(0, 600)}`);
});

test('deploy.sh：诊断给出的手工命令必须以 --setopt 绕过过滤为首选，且带引号、排在 reset 之前', async () => {
  const src = readDeploy();
  const diag = codeOnly(fnBody(src, 'on_pkg_failure'));
  const iHot = diag.indexOf('module_hotfixes');
  const iReset = diag.indexOf('module reset');
  assert(iHot >= 0 && iReset >= 0 && iHot < iReset,
    '诊断里的第 1 条手工命令必须是「绕过模块过滤」——用户要照着敲的是它，把 reset 放第一条等于又把人带回空转那条路');

  const r = await spawnBashSnippet(`
set -Eeuo pipefail
source ./deploy.sh
trap - ERR
set +e
T="$(mktemp -d)"; trap 'rm -rf "$T" 2>/dev/null || true' EXIT
PM=dnf; VERSION_ID=8
FAKE_LOG='Error:
Problem: package git-2.27.0-1.el8.x86_64 requires perl(Git), but none of the providers can be installed
- package perl-libs-4:5.26.3-420.el8.x86_64 is filtered out by modular filtering'
log_since_mark() { printf '%s' "$FAKE_LOG"; }
log_key_lines()  { sed -n '1,5p' <<<"$FAKE_LOG"; }
on_pkg_failure git 1 >"$T/diag" 2>&1 || true
printf 'HF_LINE=%s\\n' "$(grep -n -m1 'module_hotfixes' "$T/diag" | cut -d: -f1)"
printf 'RESET_LINE=%s\\n' "$(grep -n -m1 'module reset' "$T/diag" | cut -d: -f1)"
printf 'QUOTED=%s\\n' "$(grep -c -F -- "--setopt='*.module_hotfixes=true'" "$T/diag")"
printf 'FULLCMD=%s\\n' "$(grep -c -E 'dnf install -y --setopt=.*module_hotfixes=true.*git' "$T/diag")"
`);
  if (r.unavailable) return;
  const seen = `${r.out}${r.err}`;
  const mH = /HF_LINE=(\d+)/.exec(r.out);
  const mR = /RESET_LINE=(\d+)/.exec(r.out);
  assert(mH && mR && Number(mH[1]) > 0 && Number(mR[1]) > 0,
    `诊断里两条命令都要出现（顺序断言不能靠"其中一条压根没有"来通过）：${seen.slice(0, 600)}`);
  assert(Number(mH[1]) < Number(mR[1]),
    `手工命令里「绕过过滤」必须排在「复位模块流」之前（第 ${mH && mH[1]} 行 vs 第 ${mR && mR[1]} 行）：${seen.slice(0, 600)}`);
  assert(/QUOTED=[1-9]/.test(r.out),
    `给出的命令必须带引号，否则用户原样复制执行时那个 * 会被自己的 shell 展开：${seen.slice(0, 600)}`);
  assert(/FULLCMD=[1-9]/.test(r.out),
    `必须是一条可以直接复制执行的完整命令（含包名）：${seen.slice(0, 600)}`);
});
