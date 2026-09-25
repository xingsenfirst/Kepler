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
