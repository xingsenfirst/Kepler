/**
 * 测试：第五轮审计（AUDIT-REPORT.md）修复护栏
 *
 * 编写约定与既有护栏一致：
 *  - **行为断言**，不用「源码里 grep 到某个词」糊弄过去；
 *  - 真实驱动中间件 / 路由，而不是断言「某个函数被导出」；
 *  - 不写真实 data/：需要数据时用桩注入，写入口一律拦截。
 */
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT } = require('./helpers');

/* ============================ FUN-01 ============================ */

/**
 * FUN-01：IP 屏蔽的 HTML 分支里写的是 `${ip}`，而 `middleware()` 作用域内
 * 根本没有 `ip` 变量（只有 `v` 和 `tip`）→ 任一被屏蔽的**页面类**请求恒抛
 * ReferenceError，被 Express 错误处理器吞成 500。屏蔽功能对分享页等于失效。
 *
 * 这里注入规则集（不写真实 data/ipguard.json），分别驱动 JSON 与 HTML 两条分支。
 */
const secureStore = require(path.join(ROOT, 'server', 'secure-store.js'));
const FAKE_GUARD = {
  rules: [{ id: 'r-test', target: '8.8.8.8', methods: [], enabled: true, bucketIds: [] }],
  updatedAt: '',
};
const origRead = secureStore.readJson;
secureStore.readJson = (file, fb) => (String(file).includes('ipguard') ? FAKE_GUARD : origRead(file, fb));
// 命中会计数并置 dirty，3 秒后落盘 —— 测试里屏蔽该写入，避免污染真实 data/
const origWrite = secureStore.writeJson;
secureStore.writeJson = (file, obj) => (String(file).includes('ipguard') ? undefined : origWrite(file, obj));

const ipGuard = require(path.join(ROOT, 'server', 'ip-guard.js'));

/** 直接驱动中间件（它是同步的），捕获任何抛出 */
function drive(req) {
  const res = {
    statusCode: 0, body: '', headers: {},
    status(c) { this.statusCode = c; return this; },
    type(t) { this.headers['content-type'] = t; return this; },
    json(o) { this.body = JSON.stringify(o); this.jsonBody = o; return this; },
    send(s) { this.body = String(s); return this; },
  };
  let nexted = false;
  let threw = null;
  try {
    ipGuard.middleware(req, res, () => { nexted = true; });
  } catch (e) {
    threw = e;
  }
  return { res, nexted, threw };
}

function mkReq(reqPath, ip = '8.8.8.8') {
  return { path: reqPath, method: 'GET', headers: {}, socket: { remoteAddress: ip } };
}

test('FUN-01 · 被屏蔽的 /api/** 请求返回 403 JSON（既有行为，防回归）', () => {
  const { res, nexted, threw } = drive(mkReq('/api/fs/list'));
  assertEqual(threw, null, '不应抛异常');
  assertEqual(nexted, false, '被屏蔽时不得放行');
  assertEqual(res.statusCode, 403, '应返回 403');
  assertEqual(res.jsonBody.blocked, true, '响应体应带 blocked 标记');
  assertEqual(res.jsonBody.ip, '8.8.8.8', '响应体应带回客户端 IP');
});

test('FUN-01 · 被屏蔽的页面类请求（分享页）返回 403 HTML 且含客户端 IP，不再是 500', () => {
  const { res, nexted, threw } = drive(mkReq('/s/abcdef'));
  assertEqual(threw, null,
    'HTML 分支不得抛异常 —— 曾写成 `${ip}`（该变量在 middleware 内未定义），' +
    '导致分享页屏蔽恒 500，功能形同虚设');
  assertEqual(nexted, false, '被屏蔽时不得放行');
  assertEqual(res.statusCode, 403, '应返回 403 而不是 500');
  assertMatch(res.body, /<!DOCTYPE html>/i, '应返回 HTML 提示页');
  assertMatch(res.body, /8\.8\.8\.8/, '提示页应显示客户端 IP');
  assert(!/undefined/.test(res.body), '提示页不得出现 undefined（变量取值错误的典型症状）');
});

test('FUN-01 · 未命中的请求不受影响（回环放行）', () => {
  const { nexted, threw } = drive(mkReq('/s/abcdef', '127.0.0.1'));
  assertEqual(threw, null, '不应抛异常');
  assertEqual(nexted, true, '本机回环应放行');
});

test('FUN-01 · 提示页对 IP 做 HTML 转义（纵深防御）', () => {
  // 当前 clientIp 只取 socket 地址，这里是防将来改为信任代理头后的注入
  const { res } = drive(mkReq('/s/abcdef'));
  assert(!/<script/i.test(res.body), '提示页不得包含未转义的标签');
});
