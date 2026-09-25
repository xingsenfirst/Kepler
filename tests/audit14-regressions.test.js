/**
 * 第十四轮审计回归护栏
 *
 * 本轮 24 条（高 3 / 中 11 / 低 10），这里覆盖已修复项里**可用行为断言表达**的那些：
 *
 *   R14-03 订单裁剪不得丢弃支付窗口内的 pending（钱付了必须拿得到文件）
 *   R14-03b 裁剪动作必须留 warn 日志（此前是完全静默的）
 *   R14-03c 超出窗口的 pending 与 failed 仍可裁（上限机制不得因保护而失效）
 *
 * 其余各条的护栏位置：
 *   R14-01 → tests/s3-client.test.js（Output 传流必须写满并 end）
 *   R14-02 → tests/invariants.test.js（验证码脚本源必须被 CSP 允许）
 *   R14-04 → tests/invariants.test.js（异步写不得持有 await 之前的 store 引用）
 *   R14-05 → tests/invariants.test.js（发起支付必须先查当前支付态）
 *   R14-06 → tests/invariants.test.js（WebDAV 实例必须有安全响应头）
 *   R14-07 → tests/invariants.test.js（WebDAV 认证：口令错误也要走 dummyHash）
 *   R14-13 → tests/invariants.test.js（rename 写入侧必须与 normalizeKey 同源）
 *
 * 为什么 R14-03 单独放这里：它需要**默认的**支付窗口（2 小时），而
 * audit8-regressions.test.js 为了驱动裁剪分支把窗口压到了 1ms —— 两者语义相反，
 * 常量在模块加载时读取，一个进程里只能取一种，故必须分文件（独立进程）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { assert, assertEqual, ROOT, cleanupTempDir } = require('./helpers');

/* ------------------------------------------------------------------ *
 * 0 · 隔离（必须在 require 任何 server 模块之前）
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit14-'));
process.env.COS_DATA_DIR = TMP;
// 小上限驱动跨链接裁剪分支（否则要造两万笔订单才碰得到）
process.env.PAYMENT_MAX_ORDERS_TOTAL = '3';
// **故意不设** PAYMENT_PENDING_KEEP_MS —— 本文件要的就是默认的 2 小时窗口

const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));

/** 收集裁剪日志：`prune` 此前是完全静默的，丢单没人知道 */
const logs = [];
statsStore.addLog = (entry) => { logs.push(entry || {}); };

const paymentOrders = require(path.join(ROOT, 'server', 'payment-orders.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkOrder = (linkId, i) => paymentOrders.create({
  linkId, platform: 'alipay', amountFen: 100, currency: 'CNY', fileName: 'f' + i, fileKey: 'k' + i,
});

/* ------------------------------------------------------------------ *
 * R14-03 · 支付窗口内的 pending 不得被裁
 * ------------------------------------------------------------------ */

/**
 * 因果链：`prune()` / `pruneGlobal()` 把 `pending` 当成可再造的流水裁掉 →
 * 付款者此刻可能正在收银台，异步通知回来时 `resolveNotifiedOrder` 查无此单 →
 * `finalizeOrder` 根本不执行 → **钱已付、文件拿不到**，且没有任何告警。
 *
 * 这是本轮唯一一条会造成实际经济损失的缺陷。
 */
test('R14-03 · 支付窗口内的 pending 订单不得被裁剪（否则钱付了拿不到文件）', async () => {
  const cap = Number(process.env.PAYMENT_MAX_ORDERS_TOTAL);
  const ids = [];
  for (let i = 0; i < 4; i++) { ids.push((await mkOrder('L-WINDOW', i)).id); await sleep(2); }

  assert(paymentOrders.listAll().length > cap,
    `前置：订单数（${paymentOrders.listAll().length}）必须超过上限 ${cap}，否则裁剪分支根本没被驱动`);

  // 4 条全是窗口内的 pending —— 哪怕超限，一条都不许裁
  assertEqual(paymentOrders.listAll().length, 4,
    '窗口内的 pending 一条都不许裁：裁掉任何一条，异步通知都会查无此单 → 已付款的人拿不到文件');
  for (const id of ids) {
    assert(paymentOrders.get(id), `订单 ${id} 必须仍在库中（它还在支付窗口里）`);
  }
});

test('R14-03c · 超出窗口的 failed 仍可被裁（保护不等于让上限机制失效）', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) { ids.push((await mkOrder('L-EXPIRED', i)).id); await sleep(2); }
  // failed 不属于受保护集合（钱没流动过、也无法再推进），可以被裁
  paymentOrders.markFailed(ids[0]);
  paymentOrders.markFailed(ids[1]);
  const before = paymentOrders.listAll().length;

  logs.length = 0;
  await mkOrder('L-EXPIRED', 99); // 触发一次 pruneGlobal

  assertEqual(paymentOrders.get(ids[0]), null, '最旧的 failed 订单应被裁掉');
  assertEqual(paymentOrders.get(ids[1]), null, '第二旧的 failed 订单应被裁掉');
  assert(paymentOrders.get(ids[2]), '仍处于 pending 的订单不得被裁');
  assert(paymentOrders.listAll().length < before + 1,
    `裁剪仍应生效：新增一笔后总数（${paymentOrders.listAll().length}）不得等于 ${before + 1}`);
});

test('R14-03b · 裁剪动作必须留下 warn 日志（此前完全静默）', async () => {
  const before = logs.length;
  const o = await mkOrder('L-LOG', 0);
  paymentOrders.markFailed(o.id);
  await mkOrder('L-LOG', 1); // 触发裁剪

  const prunes = logs.slice(before).filter((e) => e.action === 'payment.prune');
  assert(prunes.length >= 1,
    '裁剪必须写一条 `payment.prune` 日志 —— 订单被丢是会影响对账的事，不能静默发生');
  assertEqual(prunes[prunes.length - 1].level, 'warn',
    '裁剪日志必须是 warn 级：它表示"有东西被丢了"，而不是普通流水');
});

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

test.after(async () => {
  try { await require(path.join(ROOT, 'server', 'secure-store.js')).flush(); } catch (e) { /* ignore */ }
  cleanupTempDir(TMP);
});
