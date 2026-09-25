/**
 * 登录会话 —— 行为断言
 *
 * 背景：曾经有个"一刷新浏览器就掉线"的问题，根因在 `/auth/me` 读了一个
 * 会话对象上根本不存在的字段（`session.userId`），取到 undefined 后判定用户
 * 已被删除，于是**每次探测登录态都主动销毁会话**。登录当时不掉线，是因为
 * 登录后前端直接用返回值渲染，直到刷新才会重新走 /auth/me。
 *
 * 这类 bug 单看代码很难发现（字段名"看起来"完全合理），所以这里**起真实的
 * express 应用打请求**来验证，而不是 grep 源码。
 */
const http = require('http');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const authSession = require(path.join(ROOT, 'server', 'auth-session.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
const authRoutes = require(path.join(ROOT, 'server', 'routes', 'auth.js'));
const { sessionCookie } = require(path.join(ROOT, 'server', 'routes', '_shared.js'));

/* ------------------------------------------------------------------ *
 * 测试替身
 *
 * routes/auth.js 通过 `configStore.xxx` / `statsStore.xxx` 访问模块导出，
 * 因此可以直接替换属性：既不用真实 data/ 目录，也不会把审计日志写进磁盘。
 * ------------------------------------------------------------------ */

const origFind = configStore.findUserRawById;
const origLog = statsStore.addLog;
const origList = configStore.listUsers;

let store = new Map(); // id -> 用户原始记录

function fakeUser(id, username, role) {
  return { id, username, role: role || 'user', permissions: {}, webauthn: { enabled: false }, createdAt: '', updatedAt: '' };
}

function installStubs() {
  configStore.findUserRawById = (id) => store.get(String(id)) || null;
  configStore.listUsers = () => [...store.values()].map(configStore.userView);
  statsStore.addLog = () => {};
}

function restoreStubs() {
  configStore.findUserRawById = origFind;
  configStore.listUsers = origList;
  statsStore.addLog = origLog;
}

/** 起一个只挂 auth 路由的临时服务，返回 { port, close } */
function startServer() {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/', authRoutes);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function getJson(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); } catch (e) { resolve({ status: res.statusCode, json: null, text: body }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* ================================================================== *
 * 1 · 刷新不掉线（核心回归）
 * ================================================================== */

test('刷新不掉线：/auth/me 连续调用不得销毁会话', async () => {
  installStubs();
  const srv = await startServer();
  try {
    const u = fakeUser('u1', 'alice', 'admin');
    store.set('u1', u);
    const token = authSession.createSession(configStore.userView(u));
    const cookie = 'cosmgr_session=' + token;

    const first = await getJson(srv.port, '/auth/me', cookie);
    assertEqual(first.json && first.json.ok, true, '首次探测应成功');
    assertEqual(first.json.user && first.json.user.username, 'alice', '应返回当前用户');

    // 连续探测 5 次 —— 旧实现在**第一次**就会把会话销毁掉
    for (let i = 0; i < 5; i++) {
      const r = await getJson(srv.port, '/auth/me', cookie);
      assertEqual(r.json && r.json.ok, true, `第 ${i + 2} 次探测仍应为已登录`);
      assert(r.json.user, `第 ${i + 2} 次探测应返回用户（会话未被销毁）`);
    }
    authSession.destroySession(token);
  } finally {
    await srv.close();
    restoreStubs();
  }
});

test('用户被删除后 /auth/me 立即失效并销毁会话', async () => {
  installStubs();
  const srv = await startServer();
  try {
    const u = fakeUser('u2', 'bob');
    store.set('u2', u);
    const token = authSession.createSession(configStore.userView(u));
    const cookie = 'cosmgr_session=' + token;

    const before = await getJson(srv.port, '/auth/me', cookie);
    assertEqual(before.json.user && before.json.user.username, 'bob', '删除前应已登录');

    store.delete('u2'); // 管理员删除该用户
    const after = await getJson(srv.port, '/auth/me', cookie);
    assertEqual(after.json.user, null, '用户已删除时应视为未登录');
    assertEqual(authSession.getSession(token), null, '会话必须已被销毁');
  } finally {
    await srv.close();
    restoreStubs();
  }
});

test('/auth/me 返回的是实时记录（降权后立刻反映），而非登录快照', async () => {
  installStubs();
  const srv = await startServer();
  try {
    const u = fakeUser('u3', 'carol', 'admin');
    store.set('u3', u);
    const token = authSession.createSession(configStore.userView(u)); // 登录快照是 admin
    const cookie = 'cosmgr_session=' + token;

    store.set('u3', fakeUser('u3', 'carol', 'user')); // 管理员将其降权
    const r = await getJson(srv.port, '/auth/me', cookie);
    assertEqual(r.json.user.role, 'user', '降权后应立即读到新角色（不能沿用快照）');
    authSession.destroySession(token);
  } finally {
    await srv.close();
    restoreStubs();
  }
});

/* ================================================================== *
 * 2 · 记住登录状态
 * ================================================================== */

test('记住登录状态：会话有效期显著延长', () => {
  const u = configStore.userView(fakeUser('u4', 'dave'));
  const normal = authSession.createSession(u);
  const remembered = authSession.createSession(u, { remember: true });
  assert(authSession.sessionTtl(remembered) > authSession.sessionTtl(normal) * 10,
    '勾选后有效期应显著长于普通会话');
  assertNear(authSession.sessionTtl(remembered), authSession.REMEMBER_TTL_MS, '应为 30 天');
  assertNear(authSession.sessionTtl(normal), authSession.SESSION_TTL_MS, '未勾选应为 24 小时');
  authSession.destroySession(normal);
  authSession.destroySession(remembered);
});

test('Cookie 的 Max-Age 与会话实际有效期一致（否则浏览器会先于服务端丢弃）', () => {
  const u = configStore.userView(fakeUser('u5', 'erin'));
  const normal = authSession.createSession(u);
  const remembered = authSession.createSession(u, { remember: true });

  const cNormal = sessionCookie(normal);
  const cRemember = sessionCookie(remembered);
  assertMatchMaxAge(cNormal, Math.floor(authSession.SESSION_TTL_MS / 1000), '普通登录的 Max-Age');
  assertMatchMaxAge(cRemember, Math.floor(authSession.REMEMBER_TTL_MS / 1000), '记住登录的 Max-Age');

  assert(/HttpOnly/.test(cRemember), '应带 HttpOnly');
  assert(/SameSite=Lax/.test(cRemember), '应带 SameSite=Lax');

  authSession.destroySession(normal);
  authSession.destroySession(remembered);
});

/**
 * 会话 TTL 允许几秒误差：`sessionTtl` 是 `expiresAt - Date.now()`，
 * 创建会话到断言之间必然流逝若干毫秒，绝不能写死相等断言。
 */
function assertNear(actual, expected, msg) {
  assert(Math.abs(actual - expected) <= 3000, `${msg}：期望约 ${expected}ms，实际 ${actual}ms`);
}

/** Max-Age 允许有 1~2 秒误差（会话创建到取 TTL 之间会流逝一点时间） */
function assertMatchMaxAge(cookie, expectedSec, msg) {
  const m = /Max-Age=(\d+)/.exec(cookie);
  assert(m, `${msg}：Cookie 中应有 Max-Age`);
  const v = Number(m[1]);
  assert(Math.abs(v - expectedSec) <= 2, `${msg}：期望 ${expectedSec} 秒，实际 ${v} 秒`);
}

test('会话销毁后 sessionTtl 归零，Cookie 退回默认 TTL', () => {
  const u = configStore.userView(fakeUser('u6', 'frank'));
  const token = authSession.createSession(u, { remember: true });
  authSession.destroySession(token);
  assertEqual(authSession.sessionTtl(token), 0, '会话不存在时应返回 0');
  assertMatchMaxAge(sessionCookie(token), Math.floor(authSession.SESSION_TTL_MS / 1000), '无效会话的 Cookie');
});
