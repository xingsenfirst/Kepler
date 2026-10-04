/**
 * 第三十二轮护栏（R32-01 / R32-02）—— 两个新增的批量清理按钮
 *
 * 需求：
 *  - R32-01「订单管理 · 付费订单」卡片：新增「删除失效订单」，删掉全部**支付失败**的订单；
 *  - R32-02「链接管理 · 分享链接管理」卡片：新增「删除失效链接」，删掉全部
 *    **文件已删除**与**已过期**的链接（**不含**「已关闭」—— 那是「调大下载次数即可复活」
 *    的可逆状态，删掉就不可逆了）。
 *
 * 本文件按三层断言，任何一层缺失都会留下「假绿」：
 *  ① **存储层**（真实模块 `payment-orders.removeFailed()` / `share-store.removeDead()`）：
 *     判据到底是什么 —— 只删该删的，绝不误删对账凭据与在途订单；
 *  ② **路由层**（真实 express 路由 + 真发 HTTP）：方法 / 路径 / 鉴权 / 作用域是否真接上了。
 *     只驱动纯函数挡不住「守卫漏挂」「路径被参数路由吞掉」「作用域串了」；
 *  ③ **前端层**（沙箱里 import 真实的 ordermgr.js / linkmgr.js + 假 DOM）：
 *     点按钮是否真的发出了对应请求。只断言源码字样挡不住「事件根本没绑上」。
 *
 * ⚠️ 订单会真实落盘，必须先把 COS_DATA_DIR 指到临时目录**再** require store，
 *    否则跑一次测试就在项目真实 data/ 里留下一堆垃圾订单。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('cos-r32-');
process.env.COS_DATA_DIR = tmp.dir;

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const SERVER = (...p) => path.join(ROOT, 'server', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));
const secureStore = require(SERVER('secure-store.js'));
const statsStore = require(SERVER('stats-store.js'));
const paymentOrders = require(SERVER('payment-orders.js'));
const shareStore = require(SERVER('share-store.js'));

/** 审计日志：本文件只把内容收进数组以备断言，不落盘 */
const logs = [];
statsStore.addLog = (entry) => { logs.push(entry); };

const paymentRoutes = require(SERVER('routes', 'payment.js'));
const linkRoutes = require(SERVER('routes', 'links.js'));

/* ================================================================== *
 * 公共工具
 * ================================================================== */

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 建一笔订单并推进到目标状态（create 返回的就是内部对象，状态是就地改的） */
function mkOrder(linkId, status) {
  const o = paymentOrders.create({
    linkId, platform: 'alipay', amountFen: 100, payerIp: '127.0.0.1',
  });
  if (status === 'paid') paymentOrders.markPaid(o.id);
  else if (status === 'failed') paymentOrders.markFailed(o.id, '测试：支付未完成');
  else if (status === 'refunded') { paymentOrders.markPaid(o.id); paymentOrders.markRefunded(o.id); }
  return o;
}

const idsOf = (list) => list.map((o) => o.id);

/** 磁盘上的订单（真实落盘结果，用于证明 removeFailed 不只是改内存） */
function ordersOnDisk() {
  const raw = secureStore.readJson(path.join(tmp.dir, 'payments.json'), null);
  return raw && Array.isArray(raw.orders) ? raw.orders : [];
}

/**
 * 轮询等落盘结果满足条件。
 *
 * `flush()` 只负责**派发**一次异步写（`coalesce` → `secureStore.writeJsonAsync`），
 * 返回时文件往往还没落地；再加去抖窗口，固定 sleep 只能靠猜。这里直接等「磁盘状态
 * 变成期望的样子」，既有确定性，又不会把「写了没有」这件事混进等待时间。
 */
async function waitForDisk(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** 起一个只挂这两条路由的本地服务；角色由请求头 `x-test-as` 决定 */
let server = null;
let port = 0;
async function api(method, urlPath, { as = 'admin' } = {}) {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const as2 = String(req.headers['x-test-as'] || 'admin');
      req.authUser = as2 === 'admin'
        ? { username: 'admin', role: 'admin' }
        : { username: as2.replace(/^user:/, ''), role: 'user' };
      next();
    });
    app.use('/api', paymentRoutes);
    app.use('/api', linkRoutes);
    server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  }
  return request(port, method, urlPath, { headers: { 'x-test-as': as } });
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanupTempDir(tmp.dir, {
    label: 'cos-r32-',
    flushers: [
      { name: 'payment-orders', flush: () => paymentOrders.flush() },
      // share-store 的 links.json 也走去抖写；不刷干就在目录删掉之后落地，只留下 ENOENT 噪声
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});

/* ================================================================== *
 * ① 存储层 · payment-orders.removeFailed()
 * ================================================================== */

test('R32-01 · 只删「支付失败」：已支付 / 已退款 / 支付中一个都不能少', async () => {
  paymentOrders.removeFailed(); // 清场：本用例只关心自己造的这一批
  const L = 'R32-A1';
  const f1 = mkOrder(L, 'failed');
  const f2 = mkOrder(L, 'failed');
  const pending = mkOrder(L, 'pending');
  const paid = mkOrder(L, 'paid');
  const refunded = mkOrder(L, 'refunded');

  const removed = paymentOrders.removeFailed();
  const left = idsOf(paymentOrders.listForLink(L));

  assertEqual(removed, 2, '应删掉两笔「支付失败」订单');
  assert(!left.includes(f1.id) && !left.includes(f2.id), '「支付失败」订单必须被删除');
  assert(left.includes(pending.id),
    '「支付中」不得被删除 —— 付款者此刻可能正在收银台上（R14-03），'
    + '删掉就是「钱付了、订单查无此单、文件永远拿不到」');
  assert(left.includes(paid.id),
    '「已支付」是钱真正流动过的对账凭据，任何情况下都不能删 —— 删了就再也证明不了收过这笔钱');
  assert(left.includes(refunded.id),
    '「已退款」同理：删掉退款记录后，账面上只剩「收了一笔、文件还被免费下载」');
});

test('R32-01 · 超出支付窗口的「支付中」也不删（按钮名是「支付失败」，不是「清理可裁流水」）', async () => {
  paymentOrders.removeFailed();
  const L = 'R32-A2';
  const pending = mkOrder(L, 'pending');

  /**
   * 把判定时刻拨到 3 小时后（> PENDING_KEEP_MS = 2h）：这条 pending 已**不在**不可裁窗口内，
   * 自动裁剪（pruneGlobal）此时确实可以裁掉它。但本按钮按**状态**过滤（只删 failed），
   * 因此仍必须原样保留 —— 这正是「可裁」与「本按钮该删」的分界。
   */
  const removed = paymentOrders.removeFailed(Date.now() + 3 * 60 * 60 * 1000);
  assertEqual(removed, 0, '没有「支付失败」订单时应返回 0');
  assert(idsOf(paymentOrders.listForLink(L)).includes(pending.id),
    '超出支付窗口的 pending 仍不得被本按钮删除：它只是「允许被自动裁剪」，'
    + '而本按钮的语义是清掉明确的失败流水 —— 两者混同会让一次点击静默清掉一批可能还在途的付款');
});

test('R32-01 · 删除必须落盘（只改内存的话重启后失效订单会全部复活）', async () => {
  paymentOrders.removeFailed();
  const L = 'R32-A3';
  mkOrder(L, 'failed');
  paymentOrders.flush();
  assert(await waitForDisk(() => ordersOnDisk().some((o) => o.linkId === L)),
    '前置条件：该订单应先出现在磁盘上');

  paymentOrders.removeFailed();
  paymentOrders.flush();

  assert(await waitForDisk(() => !ordersOnDisk().some((o) => o.linkId === L)),
    'removeFailed 必须真正落盘：只从内存数组里摘掉的话，进程重启后'
    + '磁盘上那份会把「支付失败」订单整批带回来，管理员的清理动作等于没做');
});

test('R32-01 · 无失效订单时返回 0（幂等，不报错）', async () => {
  paymentOrders.removeFailed();
  assertEqual(paymentOrders.removeFailed(), 0, '没有失效订单时应返回 0');
  assertEqual(paymentOrders.removeFailed(), 0, '重复调用仍应返回 0（幂等）');
});

/* ================================================================== *
 * ② 路由层 · DELETE /payment/orders/failed
 * ================================================================== */

test('R32-01 · 路由：管理员可经 HTTP 批量删除失效订单，响应带上实际条数', async () => {
  paymentOrders.removeFailed();
  const L = 'R32-B1';
  const failed = mkOrder(L, 'failed');
  const paid = mkOrder(L, 'paid');
  logs.length = 0;

  const r = await api('DELETE', '/api/payment/orders/failed');
  assertEqual(r.status, 200, `应为 200，实际 ${r.status}（${r.raw}）`);
  assertEqual(r.json && r.json.ok, true, '应回 ok:true');
  assertEqual(r.json && r.json.removed, 1, '响应里的 removed 应是实际删除条数（前端据此提示）');
  assert(!paymentOrders.get(failed.id), '失效订单应经该接口被删除');
  assert(paymentOrders.get(paid.id), '已支付订单不得被该接口波及');

  const hit = logs.filter((e) => e.action === 'payment.delete-failed');
  assertEqual(hit.length, 1, '批量删除必须留审计日志（谁在什么时候删掉了多少条流水）');
  assert(/admin/.test(hit[0].detail) && /1 条/.test(hit[0].detail),
    `日志应写明操作者与条数，实际：${hit[0].detail}`);
});

test('R32-01 · 路由：普通用户不得调用（批量不可逆写操作，与退款同级保护）', async () => {
  paymentOrders.removeFailed();
  const L = 'R32-B2';
  const failed = mkOrder(L, 'failed');

  const r = await api('DELETE', '/api/payment/orders/failed', { as: 'user:alice' });
  assertEqual(r.status, 403, `普通用户应被 403 拦下，实际 ${r.status}（${r.raw}）`);
  assert(paymentOrders.get(failed.id),
    '403 之后订单必须原样还在 —— 若已被删掉，说明守卫只是事后判了一下，破坏已经发生');
});

/* ================================================================== *
 * ② 路由层 · DELETE /links/dead
 * ================================================================== */

/** 造一条链接；`status` 决定它落在哪个状态桶里 */
async function mkLink(username, status) {
  const base = { key: `k-${Math.random().toString(36).slice(2)}`, bucket: 'tb', region: 'r', createdBy: username };
  if (status === 'expired') return shareStore.create(Object.assign({}, base, { expiresHours: -1 }));
  if (status === 'exhausted') {
    const l = await shareStore.create(Object.assign({}, base, { expiresHours: 24, maxDownloads: 1 }));
    shareStore.tryAcquire(l.id); // 用掉唯一一次下载 → 状态转「已关闭」
    return l;
  }
  const l = await shareStore.create(Object.assign({}, base, { expiresHours: 24 }));
  if (status === 'deleted') shareStore.markMissing(l.id);
  return l;
}

test('R32-02 · 路由：一次删掉「文件已删除」与「已过期」，保留「有效」与「已关闭」', async () => {
  const who = 'r32-c1';
  const active = await mkLink(who, 'active');
  const expired = await mkLink(who, 'expired');
  const exhausted = await mkLink(who, 'exhausted');
  const deleted = await mkLink(who, 'deleted');
  assertEqual(shareStore.status(shareStore.get(exhausted.id)), 'exhausted', '前置：该链接应处于「已关闭」');

  const r = await api('DELETE', '/api/links/dead', { as: `user:${who}` });
  assertEqual(r.status, 200, `应为 200，实际 ${r.status}（${r.raw}）`);
  assertEqual(r.json && r.json.removed, 2, '恰好两条（文件已删除 + 已过期）应被删除');

  assert(!shareStore.get(expired.id), '「已过期」链接应被删除');
  assert(!shareStore.get(deleted.id), '「文件已删除」链接应被删除');
  assert(shareStore.get(active.id), '「有效」链接不得被删除');
  assert(shareStore.get(exhausted.id),
    '「已关闭」（下载次数用尽）不得被删除 —— 它在「编辑」里调大下载次数即可复活，'
    + '属于可改回来的状态；一并删掉会让「先收紧配额、之后再放开」变成不可逆操作');
});

test('R32-02 · 路由：普通用户只能清自己创建的失效链接（链接管理页对普通用户开放）', async () => {
  const carol = 'r32-c2-carol';
  const bob = 'r32-c2-bob';
  const carolDead = await mkLink(carol, 'expired');
  await mkLink(bob, 'active'); // bob 自己有一条「有效」链接

  const r = await api('DELETE', '/api/links/dead', { as: `user:${bob}` });
  assertEqual(r.status, 200, `应为 200，实际 ${r.status}（${r.raw}）`);
  assertEqual(r.json && r.json.removed, 0,
    'bob 自己没有失效链接 ⇒ 应删 0 条。若这里删掉了别人的，就是越权');
  assert(shareStore.get(carolDead.id), 'carol 的失效链接不得被 bob 删掉');
});

test('R32-02 · 路由：管理员可清理全部人的失效链接', async () => {
  const dave = 'r32-c3-dave';
  const daveDead = await mkLink(dave, 'deleted');
  const daveActive = await mkLink(dave, 'active');

  const r = await api('DELETE', '/api/links/dead', { as: 'admin' });
  assertEqual(r.status, 200, `应为 200，实际 ${r.status}（${r.raw}）`);
  assert(!shareStore.get(daveDead.id), '管理员的批量清理应覆盖所有创建者的失效链接');
  assert(shareStore.get(daveActive.id), '「有效」链接仍不得被波及');
});

test('R32-02 · 路由：不得挂 requireAdmin（普通用户点了不能是 403）', async () => {
  const who = 'r32-c4';
  await mkLink(who, 'active');
  const r = await api('DELETE', '/api/links/dead', { as: `user:${who}` });
  assert(r.status !== 403,
    'DELETE /links/dead 挂上 requireAdmin 会让普通用户的按钮一点就 403 —— '
    + '越权应由 shareStore.removeDead() 的 canManage 隔离，而不是靠角色门禁一刀切');
});

/* ================================================================== *
 * ③ 前端层 · 真实模块 + 假 DOM
 * ================================================================== */

function installFakeDom() {
  const els = new Map();
  const makeEl = (id) => {
    const el = {
      id, hidden: false, innerHTML: '', textContent: '', value: '', checked: false,
      style: {}, dataset: {}, className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {}, removeEventListener() {},
      appendChild() {}, remove() {},
    };
    return el;
  };
  globalThis.window = globalThis;
  globalThis.document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement: () => makeEl('created'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
    body: { appendChild() {} },
  };
  return { els, get: (id) => globalThis.document.getElementById(id) };
}

/** `api.js` 桩：调用记进 __calls，返回值由 __api 决定（Proxy 让无关接口自动兜底） */
const API_STUB = `
export const API = new Proxy({}, {
  get(t, k) {
    if (typeof k !== 'string') return undefined;
    return (...a) => {
      (globalThis.__calls = globalThis.__calls || []).push({ fn: k, args: a });
      const impl = globalThis.__api && globalThis.__api[k];
      return Promise.resolve(impl ? impl(...a) : {});
    };
  },
});
`;

/** `util.js` 桩：toast / confirmDialog 都记录下来，便于断言「提示了什么」 */
const UTIL_STUB = `
export const toast = (m, o) => { (globalThis.__toasts = globalThis.__toasts || []).push({ m, o }); };
export const escapeHtml = (s) => String(s == null ? '' : s);
export const confirmDialog = async (opts) => {
  (globalThis.__confirms = globalThis.__confirms || []).push(opts);
  return globalThis.__confirmResult === undefined ? true : globalThis.__confirmResult;
};
export const openModal = () => {};
export const fmtTime = (s) => String(s || '');
export const fmtSize = (n) => String(n);
// R34：syssettings.js 新增了 updateNotice 具名导入 —— 桩必须同步（否则 ESM 链接期直接报错）
export const updateNotice = (r) => (r && r.hasUpdate ? '有新版本' : '当前已是最新版本。');
`;

/** 在临时模块图里放一份**真实**模块（连带它 import 的同目录依赖） */
function makeFeSandbox(realFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r32-fe-'));
  fs.writeFileSync(path.join(dir, 'api.js'), API_STUB);
  fs.writeFileSync(path.join(dir, 'util.js'), UTIL_STUB);
  for (const f of realFiles) fs.copyFileSync(JS(f), path.join(dir, f));
  return dir;
}

const importFresh = (dir, file) => import('file://' + path.join(dir, file).replace(/\\/g, '/')
  + '?v=' + Math.random());
const callsOf = (fn) => (globalThis.__calls || []).filter((c) => c.fn === fn);
const confirmsText = () => (globalThis.__confirms || []).map((c) => String((c && c.message) || '')).join('\n');

test('R32-01 · 前端：点「删除失效订单」发出删除请求，确认框写明待删条数', async () => {
  const dir = makeFeSandbox(['ordermgr.js']);
  const dom = installFakeDom();
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__confirms = [];
  globalThis.__confirmResult = true;
  globalThis.__api = {
    paymentOrders: async () => ({
      orders: [
        { id: 'o1', status: 'failed' }, { id: 'o2', status: 'failed' },
        { id: 'o3', status: 'paid' }, { id: 'o4', status: 'pending' },
      ],
    }),
    deleteFailedOrders: async () => ({ ok: true, removed: 2 }),
  };

  const mod = await importFresh(dir, 'ordermgr.js');
  mod.refresh();
  await tick();

  await dom.get('btn-orders-clean').onclick();
  assertEqual(callsOf('deleteFailedOrders').length, 1,
    '点「删除失效订单」必须真的发出删除请求 —— 只画了个按钮、事件没绑上是最常见的半成品');
  assert(/共 <b>2<\/b> 笔/.test(confirmsText()),
    `确认框应写明待删条数（只数「支付失败」，实际文案：${confirmsText()}）`);
  const said = (globalThis.__toasts || []).map((t) => t.m).join(' | ');
  assert(/2 笔/.test(said), `结果提示应带上实际删除条数，实际：${said}`);
});

test('R32-01 · 前端：确认框里点「取消」不得发出任何删除请求', async () => {
  const dir = makeFeSandbox(['ordermgr.js']);
  const dom = installFakeDom();
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__confirms = [];
  globalThis.__confirmResult = false; // 用户点了取消
  globalThis.__api = {
    paymentOrders: async () => ({ orders: [{ id: 'o1', status: 'failed' }] }),
    deleteFailedOrders: async () => ({ ok: true, removed: 1 }),
  };

  const mod = await importFresh(dir, 'ordermgr.js');
  mod.refresh();
  await tick();
  await dom.get('btn-orders-clean').onclick();

  assertEqual(callsOf('deleteFailedOrders').length, 0,
    '取消后不得发请求：这是个不可逆的批量删除，二次确认必须是真闸门而不是装饰');
});

test('R32-02 · 前端：点「删除失效链接」发出删除请求，待删条数不含「已关闭」', async () => {
  const dir = makeFeSandbox(['linkmgr.js', 'share-status.js']);
  const dom = installFakeDom();
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__confirms = [];
  globalThis.__confirmResult = true;
  globalThis.__api = {
    links: async () => ({
      links: [
        { id: 'a', missing: true },                                        // 文件已删除
        { id: 'b', expiresAt: new Date(Date.now() - 60000).toISOString() }, // 已过期
        { id: 'c', missing: false, expiresAt: null, maxDownloads: 0, downloads: 0 }, // 有效
        { id: 'd', missing: false, expiresAt: null, maxDownloads: 1, downloads: 1 }, // 已关闭
      ],
    }),
    deleteDeadLinks: async () => ({ ok: true, removed: 2 }),
  };

  const mod = await importFresh(dir, 'linkmgr.js');
  mod.refresh();
  await tick();

  await dom.get('btn-links-clean').onclick();
  assertEqual(callsOf('deleteDeadLinks').length, 1,
    '点「删除失效链接」必须真的发出删除请求');
  assert(/共 <b>2<\/b> 条/.test(confirmsText()),
    '待删条数只能是「文件已删除」+「已过期」两条；把「已关闭」也算进来，'
    + `界面就会承诺删 3 条而服务端只删 2 条。实际文案：${confirmsText()}`);
});

test('R32-02 · share-status：「失效」集合含「文件已删除」「已过期」，不含「已关闭」', async () => {
  const m = await import(pathToFileURL(JS('share-status.js')).href);

  assertEqual(m.DEAD_STATUS.has('deleted'), true, '「文件已删除」属于失效');
  assertEqual(m.DEAD_STATUS.has('expired'), true, '「已过期」属于失效');
  assertEqual(m.DEAD_STATUS.has('exhausted'), false,
    '「已关闭」不属于失效：它是可逆状态（调大下载次数即恢复），'
    + '与服务端 share-store.removeDead() 的口径必须一致');
  assertEqual(m.DEAD_STATUS.has('active'), false, '「有效」显然不属于失效');

  assertEqual(m.isDead({ missing: true }), true, 'missing 的链接应被判为失效');
  assertEqual(m.isDead({ maxDownloads: 1, downloads: 1 }), false, '已关闭的链接不得被判为失效');
  assertEqual(m.isDead({ expiresAt: null, missing: false }), false, '永久有效的链接不得被判为失效');
  assertEqual(m.isDead(null), false, '空值不得被判为失效（刷新时可能拿到脏数据）');
});
