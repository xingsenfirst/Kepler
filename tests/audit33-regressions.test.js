/**
 * 第三十三轮护栏（R33）—— 用户管理「封禁」功能
 *
 * 需求（逐条对应到下面的用例）：
 *  1. 仅限管理员可执行封禁          → 路由 403 / `EXPECTED` + `mustBeAdmin` 台账
 *  2. 时间选择器选择封禁到期时间    → 到期判定 + 「到期自动解除」+ datetime-local → epoch 毫秒
 *  3. 「解封」按钮可立即解除封禁    → POST /users/:id/unban + 前端按钮
 *  4. 「封禁原因」编辑框            → 原因必填 / 超长拒绝 / 原样送到被封用户
 *  5. 被封禁用户登录时能看到原因与解封时间 → 登录 403 + `banned`/`reason`/`until` + 文案
 *  6. 版本推进 1.3.0                → 见 docs-sync / CHANGELOG（本文件不重复断言版本号）
 *
 * 本文件同样按三层断言 —— 任何一层缺失都会留下「假绿」：
 *  ① **存储层**（真实 `config-store`）：封禁判据到底是什么。只测路由的话，
 *     「到期没到期」「脏数据怎么算」这些真正决定放不放行的问题全都不在射程内；
 *  ② **路由层**（真实 express 路由 + 真发 HTTP）：鉴权、自封禁、会话吊销、
 *     以及**登录接口的响应顺序**（密码错了不得泄露"这个号被封了"）；
 *  ③ **前端层**（沙箱里 import 真实的 syssettings.js / util.js / api.js + 假 DOM）：
 *     按钮是否真接上、datetime-local 是否真换算成绝对时刻、错误字段是否真传到调用方。
 *     只断言源码字样挡不住「事件根本没绑上」「忘了换算时区」。
 *
 * ⚠️ 配置会真实落盘（`config.enc`），必须先把 COS_DATA_DIR 指到临时目录**再** require store，
 *    否则跑一次测试就在项目真实 data/ 里留下一堆测试用户。
 *
 * ⚠️ 登录路径有按 IP 的限流（10 次/分钟，`security.loginLimiter`），
 *    本文件对 `/auth/login*` 的请求总数刻意压在 8 次以内 —— 新增用例时务必接着数。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT, makeTempDir, request, cleanupTempDir } = require('./helpers.js');

const tmp = makeTempDir('cos-r33-');
process.env.COS_DATA_DIR = tmp.dir;

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const SERVER = (...p) => path.join(ROOT, 'server', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));
const secureStore = require(SERVER('secure-store.js'));
const statsStore = require(SERVER('stats-store.js'));
const configStore = require(SERVER('config-store.js'));
const authSession = require(SERVER('auth-session.js'));

/** 审计日志：只收进数组以备断言，不落盘 */
const logs = [];
statsStore.addLog = (entry) => { logs.push(entry); };

const userRoutes = require(SERVER('routes', 'users.js'));
const authRoutes = require(SERVER('routes', 'auth.js'));

/* ================================================================== *
 * 公共工具
 * ================================================================== */

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 建一个用户，返回 id */
async function mkUser(name, role = 'user') {
  const u = await configStore.addUser({ username: name, password: 'Unit!2026abc', role });
  return u.id;
}

/** 磁盘上的配置（真落盘结果；用来证明 setUserBan 不只是改了内存副本） */
function configOnDisk() {
  const file = path.join(tmp.dir, 'config.enc');
  if (!fs.existsSync(file)) return null;
  try { return configStore.decrypt(fs.readFileSync(file, 'utf8').trim()); } catch (e) { return null; }
}

const banOnDisk = (id) => {
  const cfg = configOnDisk();
  const u = cfg && Array.isArray(cfg.users) ? cfg.users.find((x) => x.id === id) : null;
  return u ? u.ban : null;
};

/** 轮询等落盘结果满足条件（`flush()` 只派发异步写，返回时多半还没落地） */
async function waitForDisk(predicate, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return predicate();
    await sleep(25);
  }
}

/** 起一个本地服务：users 路由的角色由请求头 `x-test-as` 决定；auth 路由匿名可达 */
let server = null;
let port = 0;
async function api(method, urlPath, { as = 'admin', body } = {}) {
  if (!server) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const who = String(req.headers['x-test-as'] || 'admin');
      req.authUser = who === 'admin'
        ? { id: 'admin-self', username: 'admin', role: 'admin' }
        : { id: 'other', username: who.replace(/^user:/, ''), role: 'user' };
      next();
    });
    app.use('/api', userRoutes);
    app.use('/api', authRoutes);
    server = await new Promise((resolve) => {
      const s = http.createServer(app);
      s.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = server.address().port;
  }
  return request(port, method, urlPath, { headers: { 'x-test-as': as }, body });
}

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await cleanupTempDir(tmp.dir, {
    label: 'cos-r33-',
    flushers: [
      { name: 'config-store', flush: () => configStore.flush() },
      // secret.key / 别名的去抖写同理：不刷干就在目录删掉之后落地，只留下 ENOENT 噪声
      { name: 'secure-store', flush: () => secureStore.flush() },
    ],
  });
});

/* ================================================================== *
 * ① 存储层 · banInfo / setUserBan / clearUserBan
 * ================================================================== */

test('R33 · 封禁判据：未设 / 未来 / 已过期 / 永久 四态各自正确', () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  assertEqual(configStore.banInfo({}).state, 'none', '无 ban 字段 = 从未封禁');
  assertEqual(configStore.banInfo({}).active, false, '从未封禁不得判定为生效中');

  assertEqual(configStore.banInfo({ ban: { active: false, reason: 'x', until: iso(now + 1000) } }).active, false,
    'active=false 时即便 until 在未来也不算封禁（解封后的残留标记必须无效）');

  const future = configStore.banInfo({ ban: { active: true, reason: '违规', until: iso(now + 3600000) } });
  assertEqual(future.state, 'active', '到期时间在未来 → 封禁生效中');
  assertEqual(future.reason, '违规', '生效中必须带上原因（要展示给被封用户）');
  assertEqual(future.until, iso(now + 3600000), '生效中必须带上解封时间');

  const past = configStore.banInfo({ ban: { active: true, reason: '违规', until: iso(now - 1000) } });
  assertEqual(past.state, 'expired', '到期时间已过 → 封禁自然失效');
  assertEqual(past.active, false,
    '已到期的封禁**不得**再拦登录 —— 否则「选择到期时间」这个功能等于不存在；'
    + '状态另用 expired 表示，供界面区分「从未封禁」与「封过又到期」');

  const forever = configStore.banInfo({ ban: { active: true, reason: '永久', until: '' } });
  assertEqual(forever.state, 'active', '到期时间为空 = 永久封禁');
  assertEqual(forever.until, '', '永久封禁的解封时间为空串（前端据此显示"永久"）');
});

test('R33 · 封禁判据：脏数据与非法时间一律 fail-closed（宁可按封禁处理）', () => {
  assertEqual(configStore.banInfo({ ban: '垃圾字符串' }).state, 'none', 'ban 不是对象 → 回落未封禁');
  assertEqual(configStore.banInfo({ ban: ['a'] }).state, 'none', 'ban 是数组 → 回落未封禁');
  assertEqual(configStore.banInfo(null).state, 'none', '用户记录为 null 不得抛错');

  const bad = configStore.banInfo({ ban: { active: true, reason: 'r', until: 'not-a-date' } });
  assertEqual(bad.active, true,
    '时间戳解析不出来时按**永久封禁**处理：封禁标记被数据瑕疵静默忽略是安全缺陷，'
    + '而误判为封禁可由管理员一键解封，代价不对称（与 WebAuthn「缺凭据即未启用」方向相反）');
});

test('R33 · setUserBan：原因必填、限长，到期时间必须是**未来**的有效时刻', async () => {
  const id = await mkUser('r33-a1');

  const bad = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  const e1 = bad(() => configStore.setUserBan(id, { reason: '   ', until: Date.now() + 60000 }));
  assertEqual(e1 && e1.status, 400, '空原因必须 400');
  assert(/封禁原因/.test(e1 ? e1.message : ''), '错误文案应指向"原因"，否则用户不知道该改哪一项');

  const e2 = bad(() => configStore.setUserBan(id, { reason: 'x'.repeat(201), until: Date.now() + 60000 }));
  assertEqual(e2 && e2.status, 400, `超过 ${configStore.BAN_REASON_MAX} 字必须 400`);

  const e3 = bad(() => configStore.setUserBan(id, { reason: 'r', until: '2026-13-45' }));
  assertEqual(e3 && e3.status, 400, '非法日期串必须 400');

  const e4 = bad(() => configStore.setUserBan(id, { reason: 'r', until: Date.now() - 1000 }));
  assertEqual(e4 && e4.status, 400,
    '到期时间已过必须**拒绝写入**：那样写下去这条封禁一落库就已失效，接口却回 ok:true、'
    + '界面还弹「已封禁」—— 典型的假成功');

  assertEqual(configStore.banInfo(configStore.findUserRawById(id)).state, 'none',
    '上面四次被拒之后，该用户必须仍然未被封禁（不能"拒了但已经改了一半"）');
});

test('R33 · setUserBan：三种时间入参都归一化成 ISO 存储（前端传 epoch 毫秒，服务端存绝对时刻）', async () => {
  const id = await mkUser('r33-a2');
  const target = Date.now() + 3600000;

  const byNumber = configStore.setUserBan(id, { reason: '数字', until: target });
  assertEqual(byNumber.ban.until, new Date(target).toISOString(), '数值入参应存成 ISO');

  const byNumericString = configStore.setUserBan(id, { reason: '数字串', until: String(target) });
  assertEqual(byNumericString.ban.until, new Date(target).toISOString(), '纯数字串按 epoch 毫秒解释');

  const byIso = configStore.setUserBan(id, { reason: 'ISO 串', until: new Date(target).toISOString() });
  assertEqual(byIso.ban.until, new Date(target).toISOString(), 'ISO 串应原样归一化');

  assertEqual(configStore.banInfo(configStore.findUserRawById(id)).until, new Date(target).toISOString(),
    '落库后读回来的仍是同一个绝对时刻');

  const cleared = configStore.clearUserBan(id);
  assertEqual(cleared.ban.state, 'none', '解封后状态应为 none');
  assertEqual(cleared.ban.reason, '', '解封必须把原因一并清空（否则下次封禁会显示上一条原因）');
  assertEqual(cleared.ban.until, '', '解封必须把到期时间一并清空');
});

test('R33 · 封禁必须落盘（只改内存副本的话重启后封禁整体消失）', async () => {
  const id = await mkUser('r33-a3');
  await waitForDisk(() => Boolean(banOnDisk(id)), 3000);
  const before = banOnDisk(id);
  assert(!(before && before.active), '前置：磁盘上该用户尚未被封禁');

  configStore.setUserBan(id, { reason: '落盘验证', until: Date.now() + 3600000 });
  configStore.flush();

  assert(await waitForDisk(() => {
    const b = banOnDisk(id);
    return Boolean(b && b.active === true && b.reason === '落盘验证');
  }), 'setUserBan 必须真正写进 config.enc —— 只改 cached 的话重启即失效，封禁形同虚设');

  configStore.clearUserBan(id);
  configStore.flush();
  assert(await waitForDisk(() => {
    const b = banOnDisk(id);
    return Boolean(b && b.active === false);
  }), '解封同样必须落盘：否则重启后封禁会"复活"，而管理员明明已经解封过');
});

test('R33 · userView 暴露 ban 判定结果，但不得外泄内部结构', async () => {
  const id = await mkUser('r33-a4');
  configStore.setUserBan(id, { reason: '视图验证', until: Date.now() + 3600000 });

  const view = configStore.userView(configStore.findUserRawById(id));
  assert(view.ban, 'userView 必须带 ban 字段（GET /users 与 /auth/me 都靠它）');
  assertEqual(view.ban.state, 'active', '视图里的 state 应为 active');
  assertEqual(view.ban.active, true, '视图里的 active 应为 true');
  assertEqual(view.ban.reason, '视图验证', '视图应带上原因');
  assertEqual(Object.keys(view.ban).sort().join(','), 'active,reason,state,until',
    'ban 视图只应有 state/active/reason/until 四个键，不得把 normalizeBan 的内部结构整体透出');
  configStore.clearUserBan(id);
});

/* ================================================================== *
 * ② 路由层 · /users/:id/ban 与 /users/:id/unban
 * ================================================================== */

test('R33 · 路由：管理员封禁成功，响应含会话吊销数，并留下写明原因与解封时间的审计日志', async () => {
  const id = await mkUser('r33-b1');
  logs.length = 0;

  const r = await api('POST', `/api/users/${id}/ban`, {
    body: { reason: '多次上传违规内容', until: Date.now() + 3600000 },
  });
  assertEqual(r.status, 200, `应为 200，实际 ${r.status}（${r.raw}）`);
  assertEqual(r.json && r.json.ok, true, '应回 ok:true');
  assertEqual(r.json.user.ban.state, 'active', '响应里的用户应处于封禁态（前端据此刷新列表）');
  assertEqual(typeof r.json.sessionsRevoked, 'number', '响应应带上被吊销的会话数');

  const hit = logs.filter((e) => e.action === 'users.ban');
  assertEqual(hit.length, 1, '封禁必须留一条审计日志（谁在什么时候封了谁、为什么）');
  assertEqual(hit[0].level, 'warn', '封禁属危险操作，日志级别应为 warn');
  assert(/多次上传违规内容/.test(hit[0].detail), `日志应写明封禁原因，实际：${hit[0].detail}`);
  assert(/r33-b1/.test(hit[0].detail) && /admin/.test(hit[0].detail), `日志应写明双方身份，实际：${hit[0].detail}`);
});

test('R33 · 路由：封禁立即吊销该用户的全部会话（只写标记不清会话等于没封）', async () => {
  const id = await mkUser('r33-b2');
  const raw = configStore.findUserRawById(id);
  const token = authSession.createSession(configStore.userView(raw), {});
  assert(authSession.getSession(token), '前置：该用户的会话应已建立');

  const r = await api('POST', `/api/users/${id}/ban`, {
    body: { reason: '会话吊销验证', until: Date.now() + 3600000 },
  });
  assertEqual(r.status, 200, `应为 200，实际 ${r.status}`);
  assertEqual(r.json.sessionsRevoked, 1, '响应应报告 1 个被吊销的会话');
  assertEqual(authSession.getSession(token), null,
    '被封禁者的既有会话必须**立即**失效：否则他能拿着旧会话继续读写对象存储，'
    + '最长 30 天（勾选过"记住登录状态"）—— 封禁等于一张空头支票');
});

test('R33 · 路由：普通用户不得封禁 / 解封（403，且破坏不得发生）', async () => {
  const id = await mkUser('r33-b3');

  const r1 = await api('POST', `/api/users/${id}/ban`, {
    as: 'user:mallory', body: { reason: '越权尝试', until: Date.now() + 3600000 },
  });
  assertEqual(r1.status, 403, `普通用户封禁应 403，实际 ${r1.status}（${r1.raw}）`);
  assertEqual(configStore.banInfo(configStore.findUserRawById(id)).state, 'none',
    '403 之后该用户必须仍然未被封禁 —— 若已被封，说明守卫只是事后判了一下，破坏已经发生');

  configStore.setUserBan(id, { reason: '前置封禁', until: Date.now() + 3600000 });
  const r2 = await api('POST', `/api/users/${id}/unban`, { as: 'user:mallory' });
  assertEqual(r2.status, 403, `普通用户解封应 403，实际 ${r2.status}（${r2.raw}）`);
  assertEqual(configStore.banInfo(configStore.findUserRawById(id)).state, 'active',
    '403 之后封禁必须原样保留');
  configStore.clearUserBan(id);
});

test('R33 · 路由：可以封禁"另一个管理员"（封禁不设"至少保留一个管理员"限制的理由）', async () => {
  // 请求头里的身份恒为管理员（见 api() 的中间件），且它**不能封自己**（下一用例验证）。
  // 因此无论封谁，发起者本人始终是未被封禁的管理员 ⇒ 系统永远还剩至少一个可用管理员，
  // 不需要像删除 / 降级那样加 adminCount 保护（那两者确实可能把系统锁死）。
  const otherAdmin = await mkUser('r33-b4', 'admin');
  const r = await api('POST', `/api/users/${otherAdmin}/ban`, {
    body: { reason: '封禁另一个管理员', until: Date.now() + 3600000 },
  });
  assertEqual(r.status, 200, `封禁其他管理员应成功，实际 ${r.status}（${r.raw}）`);
  assertEqual(configStore.banInfo(configStore.findUserRawById(otherAdmin)).state, 'active', '目标应被封禁');
  configStore.clearUserBan(otherAdmin);
});

test('R33 · 路由：自封禁被 400 拦下（真实构造"目标即自己"）', async () => {
  // 让请求头身份指向一个真实存在的用户，制造"管理员封自己"的场景
  const me = await configStore.addUser({ username: 'r33-self', password: 'Unit!2026abc', role: 'admin' });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = { id: me.id, username: 'r33-self', role: 'admin' };
    next();
  });
  app.use('/api', userRoutes);
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const r = await request(srv.address().port, 'POST', `/api/users/${me.id}/ban`, {
      body: { reason: '自封禁', until: Date.now() + 3600000 },
    });
    assertEqual(r.status, 400, `自封禁应 400，实际 ${r.status}（${r.raw}）`);
    assert(/不能封禁当前登录/.test(String(r.json && r.json.error)), `错误文案应说明原因，实际：${r.raw}`);
    assertEqual(configStore.banInfo(configStore.findUserRawById(me.id)).state, 'none',
      '被拒之后自己必须仍未被封禁');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('R33 · 路由：解封后立即恢复，重复解封返回 400（不制造"成功"的错觉）', async () => {
  const id = await mkUser('r33-b5');
  configStore.setUserBan(id, { reason: '待解封', until: Date.now() + 3600000 });
  logs.length = 0;

  const r1 = await api('POST', `/api/users/${id}/unban`);
  assertEqual(r1.status, 200, `解封应为 200，实际 ${r1.status}（${r1.raw}）`);
  assertEqual(r1.json.user.ban.state, 'none', '解封后状态应为 none');
  const hit = logs.filter((e) => e.action === 'users.unban');
  assertEqual(hit.length, 1, '解封必须留审计日志');

  const r2 = await api('POST', `/api/users/${id}/unban`);
  assertEqual(r2.status, 400,
    '从未封禁 / 已解封后再点「解封」必须 400：永远成功的解封按钮会让人以为刚才那一下真解开了什么');
});

test('R33 · 路由：参数校验原样透传存储层的拒绝理由（400 而非 500）', async () => {
  const id = await mkUser('r33-b6');

  const noReason = await api('POST', `/api/users/${id}/ban`, {
    body: { until: Date.now() + 3600000 },
  });
  assertEqual(noReason.status, 400, `缺原因应 400，实际 ${noReason.status}`);
  assert(/封禁原因/.test(String(noReason.json && noReason.json.error)), `错误文案应指向原因，实际：${noReason.raw}`);

  const pastTime = await api('POST', `/api/users/${id}/ban`, {
    body: { reason: 'r', until: Date.now() - 60000 },
  });
  assertEqual(pastTime.status, 400, `到期时间已过应 400，实际 ${pastTime.status}`);

  assertEqual(configStore.banInfo(configStore.findUserRawById(id)).state, 'none', '两次被拒后仍未被封禁');
});

/* ================================================================== *
 * ② 路由层 · 登录
 * ================================================================== */

test('R33 · 登录：被封禁者拿到 403 + 原因 + 解封时间，且不签发会话', async () => {
  const id = await mkUser('r33-c1');
  const until = Date.now() + 3600000;
  const iso = new Date(until).toISOString();
  configStore.setUserBan(id, { reason: '多次上传违规内容', until });
  logs.length = 0;

  const r = await api('POST', '/api/auth/login', {
    body: { username: 'r33-c1', password: 'Unit!2026abc' },
  });

  assertEqual(r.status, 403, `被封禁者应 403，实际 ${r.status}（${r.raw}）`);
  assertEqual(r.json && r.json.banned, true, '响应必须带机器可读的 banned 标记（前端据此走封禁提示）');
  assertEqual(r.json.reason, '多次上传违规内容', '需求 5：被封用户必须能看到**封禁原因**');
  assertEqual(r.json.until, iso, '需求 5：被封用户必须能看到**解封时间**');
  assert(!r.headers['set-cookie'], '被封禁者不得拿到任何会话 Cookie');

  const hit = logs.filter((e) => e.action === 'auth.fail');
  assertEqual(hit.length, 1, '被封禁者的登录尝试必须留日志');
  assert(/封禁/.test(hit[0].detail), `日志应写明是封禁拦截，实际：${hit[0].detail}`);
});

test('R33 · 登录：**密码错误在前**，不得泄露"这个号被封了"（顺序证据）', async () => {
  const id = await mkUser('r33-c2');
  configStore.setUserBan(id, { reason: '顺序验证', until: Date.now() + 3600000 });

  const r = await api('POST', '/api/auth/login', {
    body: { username: 'r33-c2', password: 'Wrong!Password9' },
  });

  assertEqual(r.status, 401, `密码错误应 401，实际 ${r.status}（${r.raw}）`);
  assert(!(r.json && r.json.banned), '密码错误时**不得**带 banned 字段');
  assertEqual(r.json.reason, undefined,
    '密码错误与"不存在该用户"必须完全同形：若这里就吐封禁原因，'
    + '登录接口等于免费提供"该用户名存在且已被封禁"的枚举 oracle');
  configStore.clearUserBan(id);
});

test('R33 · 登录：解封后立刻可登录；封禁到期后自动放行（到期时间真的在生效）', async () => {
  // ⚠️ 登录路径有 10 次/分钟的 IP 限流，本文件刻意不在前置条件上浪费请求：
  //    「当前确实被封着」用存储层判据来断言，登录接口只用来验证**放行/拦截的结果**。
  const idA = await mkUser('r33-c3a');
  configStore.setUserBan(idA, { reason: '将被解封', until: Date.now() + 3600000 });
  assertEqual(configStore.banInfo(configStore.findUserRawById(idA)).active, true, '前置：封禁应生效中');

  await api('POST', `/api/users/${idA}/unban`);
  const afterUnban = await api('POST', '/api/auth/login', { body: { username: 'r33-c3a', password: 'Unit!2026abc' } });
  assertEqual(afterUnban.status, 200, `解封后应可登录，实际 ${afterUnban.status}（${afterUnban.raw}）`);
  assert(afterUnban.headers['set-cookie'], '解封后登录必须正常签发会话 Cookie');

  // 到期自动解除：用一段真实的短到期时间，等它过去（需求 2 的核心语义）
  const idB = await mkUser('r33-c3b');
  configStore.setUserBan(idB, { reason: '短暂封禁', until: Date.now() + 1200 });
  assertEqual(configStore.banInfo(configStore.findUserRawById(idB)).active, true, '前置：未到期时应生效');
  await sleep(1400);
  assertEqual(configStore.banInfo(configStore.findUserRawById(idB)).state, 'expired', '到期后判据应转为 expired');

  const afterExpiry = await api('POST', '/api/auth/login', { body: { username: 'r33-c3b', password: 'Unit!2026abc' } });
  assertEqual(afterExpiry.status, 200,
    `到期后应自动放行（无需管理员操作），实际 ${afterExpiry.status}（${afterExpiry.raw}）`);
  configStore.clearUserBan(idB);
});

test('R33 · 登录：永久封禁时 until 为空串，前端据此显示"永久"', async () => {
  const id = await mkUser('r33-c4');
  configStore.setUserBan(id, { reason: '永久封禁验证', until: '' });

  const r = await api('POST', '/api/auth/login', { body: { username: 'r33-c4', password: 'Unit!2026abc' } });
  assertEqual(r.status, 403, `永久封禁同样应 403，实际 ${r.status}（${r.raw}）`);
  assertEqual(r.json && r.json.banned, true, '应带 banned 标记');
  assertEqual(r.json.until, '', '永久封禁的 until 应为空串（前端据此显示"永久封禁，需管理员手动解除"）');
  assertEqual(r.json.reason, '永久封禁验证', '永久封禁同样要给出原因');
  configStore.clearUserBan(id);
});

test('R33 · 登录第二步（Windows Hello）：被封禁的响应必须与其它失败分支**完全同形**', async () => {
  const bannedId = await mkUser('r33-c5-banned');
  const helloId = await mkUser('r33-c5-hello');
  for (const id of [bannedId, helloId]) {
    configStore.setUserWebauthn(id, {
      credentialId: 'unit-' + id,
      publicKey: Buffer.alloc(91, 7).toString('base64'),
      signCount: 0, aaguid: '00'.repeat(16), fmt: 'none',
    });
  }
  configStore.setUserBan(bannedId, { reason: '第二步同形验证', until: Date.now() + 3600000 });

  /** 只提交用户名（challenge 缺失）→ 走到"进不去"的分支 */
  const probe = (username) => api('POST', '/api/auth/login/webauthn', { body: { username } });
  const banned = await probe('r33-c5-banned');
  const normal = await probe('r33-c5-hello');

  assertEqual(banned.status, normal.status,
    '被封禁与其它失败分支的状态码必须一致，否则本端点（匿名可达）又成了一个用户名 oracle');
  assertEqual(banned.raw, normal.raw,
    '响应体必须逐字相同：带封禁原因的 403 会把 R21-05 / R22-01 刚收敛掉的三支同形重新漏开一条');
  assert(!(banned.json && banned.json.banned),
    '第二步不得下发 banned —— 被封者回第一步就能看到原因，这里只负责不让他进');

  configStore.clearUserBan(bannedId);
});

/* ================================================================== *
 * ③ 前端层 · 真实模块 + 假 DOM
 * ================================================================== */

/**
 * 极简假 DOM。
 *
 * 除了 `getElementById` 之外，这里多了一项 audit32 没有的能力：**解析 innerHTML**。
 * 原因：用户列表的「封禁 / 解封」按钮是**渲染进 `table.innerHTML`** 的（不像
 * `btn-orders-clean` 那样写死在 index.html 里），因此必须能从 HTML 片段里把
 * `data-act` / `data-id` / `id` 抽出来，否则 `querySelectorAll('[data-act]')`
 * 恒为空 → 「按钮没接线」这类缺陷会被静默放过。
 */
function installFakeDom() {
  const byId = new Map();
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  const parseAttrs = (s) => {
    const out = {};
    attrRe.lastIndex = 0;
    let m;
    while ((m = attrRe.exec(s))) out[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2];
    return out;
  };

  const mk = (id) => ({
    id, hidden: false, _html: '', textContent: '', value: '', checked: false,
    disabled: false, style: {}, dataset: {}, className: '', attrs: {}, _btns: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute(k) { const v = this.attrs[String(k).toLowerCase()]; return v === undefined ? null : v; },
    querySelector(sel) {
      if (sel && sel[0] === '#') return byId.get(sel.slice(1)) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-act]') return this._btns.slice();
      return [];
    },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {},
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this._btns = [];
      const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(this._html))) {
        const tag = m[1].toLowerCase();
        const attrs = parseAttrs(m[2]);
        if (tag === 'button') {
          const b = mk('btn');
          b.attrs = attrs;
          this._btns.push(b);
        }
        // 带 id 的控件登记到全局表，并把它写在 HTML 里的 value 一并读出来 ——
        // 否则 `showBanForm` 里 `value="<默认到期时间>"` 这段就永远看不见，
        // 「弹窗带了默认到期时间」这件事会在测试里变成一片空白（假绿）。
        if (attrs.id) {
          const el = byId.get(attrs.id) || mk(attrs.id);
          el.attrs = attrs;
          if (attrs.value !== undefined) el.value = attrs.value;
          byId.set(attrs.id, el);
        }
      }
    },
  });

  globalThis.window = globalThis;
  globalThis.document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, mk(id));
      return byId.get(id);
    },
    createElement: () => mk('created'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
    body: { appendChild() {} },
  };
  return { els: byId, get: (id) => globalThis.document.getElementById(id) };
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

/** `util.js` 桩：toast / confirmDialog / openModal 都记录下来，便于断言"提示了什么""弹了什么" */
const UTIL_STUB = `
export const toast = (m, o) => { (globalThis.__toasts = globalThis.__toasts || []).push({ m, o }); };
export const escapeHtml = (s) => String(s == null ? '' : s);
export const confirmDialog = async (opts) => {
  (globalThis.__confirms = globalThis.__confirms || []).push(opts);
  return globalThis.__confirmResult === undefined ? true : globalThis.__confirmResult;
};
export const openModal = (opts) => {
  const rec = { title: opts.title, body: opts.body, foot: opts.foot || [], close: null };
  (globalThis.__modals = globalThis.__modals || []).push(rec);
  const close = () => { globalThis.__closed = (globalThis.__closed || 0) + 1; };
  rec.close = close;
  return { overlay: opts.body, close, bodyEl: opts.body, footEl: opts.body };
};
export const fmtTime = (s) => String(s || '');
export const fmtSize = (n) => String(n);
// R34：syssettings.js 新增了 updateNotice 具名导入 —— 桩必须同步（否则 ESM 链接期直接报错）
export const updateNotice = (r) => (r && r.hasUpdate ? '有新版本' : '当前已是最新版本。');
// R35：syssettings.js 新增 USER_PREVIEW_LIMIT / filterUsersByName 具名导入 —— 桩必须同步
// （否则 ESM 链接期直接报错，本文件所有 import syssettings.js 的用例整片变红）
export const USER_PREVIEW_LIMIT = 10;
export const filterUsersByName = (list, q) => {
  const all = Array.isArray(list) ? list.slice() : [];
  const s = String(q == null ? '' : q).trim().toLowerCase();
  return s ? all.filter((u) => String((u && u.username) || '').toLowerCase().indexOf(s) !== -1) : all;
};
// R36：previewMoreState 同理（「显示全部」判据下沉到 util.js）
export const previewMoreState = (total, limit, unit) => {
  const over = total > limit;
  return { over, hint: over ? ('卡片仅显示前 ' + limit + ' ' + unit + '，共 ' + total + ' ' + unit) : '' };
};
`;

/** `main.js` 桩：只需 App.state.user（isAdmin / currentId 的判据），身份由 __me 控制 */
const MAIN_STUB = `
export const App = { state: { get user() { return globalThis.__me || null; } } };
`;

/** `webauthn.js` / `paysettings.js` 桩：与用户管理无关的邻居依赖 */
const WEBAUTHN_STUB = `
export const registerWindowsHello = async () => ({});
export const webauthnReadiness = () => ({ ok: true, hint: '' });
`;
const PAYSETTINGS_STUB = `
export const loadPayment = () => {};
export const resetPaymentView = () => {};
`;

/** 在临时模块图里放一份**真实**模块（连带它 import 的同目录依赖的桩） */
function makeFeSandbox(realFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r33-fe-'));
  fs.writeFileSync(path.join(dir, 'api.js'), API_STUB);
  fs.writeFileSync(path.join(dir, 'util.js'), UTIL_STUB);
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN_STUB);
  fs.writeFileSync(path.join(dir, 'webauthn.js'), WEBAUTHN_STUB);
  fs.writeFileSync(path.join(dir, 'paysettings.js'), PAYSETTINGS_STUB);
  for (const f of realFiles) fs.copyFileSync(JS(f), path.join(dir, f));
  // R36：syssettings.js 现在 import './listdialog.js'（列表对话框骨架）——
  // 沙箱缺了它会在 ESM 链接期直接失败，所有 import syssettings 的用例整片变红。
  fs.copyFileSync(JS('listdialog.js'), path.join(dir, 'listdialog.js'));
  // R37：syssettings.js 现在 import './speedlimit.js'（「限速」列 + 限速对话框）——
  // 同一条链接期规则，缺文件则本文件所有 import syssettings 的用例一起红。
  fs.copyFileSync(JS('speedlimit.js'), path.join(dir, 'speedlimit.js'));
  return dir;
}

const importFresh = (dir, file) => import('file://' + path.join(dir, file).replace(/\\/g, '/')
  + '?v=' + Math.random());
const callsOf = (fn) => (globalThis.__calls || []).filter((c) => c.fn === fn);
const toastsText = () => (globalThis.__toasts || []).map((t) => t.m).join(' | ');
const buttonsOf = (el) => el._btns;
const findBtn = (el, act, dataId) => buttonsOf(el)
  .find((b) => b.attrs['data-act'] === act && (dataId === undefined || b.attrs['data-id'] === dataId));

/** 准备一个 syssettings 沙箱并跑完 refresh（管理员身份） */
async function bootUserCard(users, overrides = {}) {
  const dir = makeFeSandbox(['syssettings.js']);
  const dom = installFakeDom();
  globalThis.__me = { id: 'me', username: 'admin', role: 'admin' };
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__confirms = [];
  globalThis.__modals = [];
  globalThis.__closed = 0;
  globalThis.__api = Object.assign({
    users: async () => ({ users }),
    quotaUsage: async () => ({ credentials: [] }),
  }, overrides);
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();
  await tick();
  await tick();
  return { dom, mod };
}

const normalRow = (id, name) => ({
  id, username: name || id, role: 'user', permissions: {}, webauthnEnabled: false,
  ban: { state: 'none', active: false, reason: '', until: '' },
  createdAt: '', updatedAt: '',
});

test('R33 · 前端：用户列表渲染出封禁状态与「封禁 / 解封」按钮，且自己没有封禁按钮', async () => {
  const active = Object.assign(normalRow('u-ban', 'bob'), {
    ban: { state: 'active', active: true, reason: '多次上传违规内容', until: new Date(Date.now() + 3600000).toISOString() },
  });
  const expired = Object.assign(normalRow('u-exp', 'carol'), {
    ban: { state: 'expired', active: false, reason: '早先封过', until: new Date(Date.now() - 1000).toISOString() },
  });
  const self = Object.assign(normalRow('me', 'admin'), { role: 'admin' });
  const { dom } = await bootUserCard([active, expired, self]);

  const html = dom.get('user-table').innerHTML;
  assert(html, '用户列表必须被渲染（前置：否则下面的断言全部空过）');
  assert(findBtn(dom.get('user-table'), 'ban', 'u-ban') === undefined,
    '封禁生效中的用户不应再出现「封禁」按钮（应改为「解封」）');
  assert(findBtn(dom.get('user-table'), 'unban', 'u-ban'),
    '封禁生效中的用户必须有「解封」按钮（需求 3）');
  assert(findBtn(dom.get('user-table'), 'ban', 'u-exp'),
    '封禁已到期的用户应可再次封禁');
  assert(/已封禁/.test(html), '生效中的封禁必须有可见的状态标记（需求 5 的管理侧可见性）');
  assert(/封禁已到期/.test(html), '已到期的封禁应与「从未封禁」区分展示');
  assert(findBtn(dom.get('user-table'), 'ban', 'me') === undefined
    && findBtn(dom.get('user-table'), 'unban', 'me') === undefined,
    '当前登录账户不得有封禁/解封按钮 —— 否则管理员一点就把自己锁在系统外，且没人能解开');
});

test('R33 · 前端：点「解封」发出解封请求；确认框里点取消则一个请求都不发', async () => {
  const active = Object.assign(normalRow('u-x', 'bob'), {
    ban: { state: 'active', active: true, reason: '待解封', until: new Date(Date.now() + 3600000).toISOString() },
  });
  const { dom } = await bootUserCard([active]);

  globalThis.__confirmResult = false; // 先点取消
  await findBtn(dom.get('user-table'), 'unban', 'u-x').onclick();
  assertEqual(callsOf('unbanUser').length, 0, '取消之后不得发出任何请求');

  globalThis.__confirmResult = true;
  await findBtn(dom.get('user-table'), 'unban', 'u-x').onclick();
  assertEqual(callsOf('unbanUser').length, 1,
    '点「解封」必须真的发出解封请求（只画了个按钮、事件没绑上是最常见的半成品）');
  assertEqual(callsOf('unbanUser')[0].args[0], 'u-x', '必须带上目标用户 id');
  assert(/解除封禁/.test(JSON.stringify(globalThis.__confirms[1] || {})), '解封应有二次确认');
});

test('R33 · 前端：封禁弹窗把 datetime-local 换算成 epoch 毫秒提交，清空则提交永久', async () => {
  const { dom } = await bootUserCard([normalRow('u-f', 'bob')]);
  dom.get('user-table');

  const banBtn = findBtn(dom.get('user-table'), 'ban', 'u-f');
  assert(banBtn, '前置：应有「封禁」按钮');
  await banBtn.onclick();

  const modal = (globalThis.__modals || [])[0];
  assert(modal, '点「封禁」必须打开封禁弹窗（需求 2 / 4 的载体）');
  assert(dom.get('ban-reason'), '弹窗里必须有一个封禁原因编辑框（需求 4）');
  assert(dom.get('ban-until'), '弹窗里必须有一个到期时间选择器（需求 2）');

  // ① 填了时间：必须换算成**绝对时刻**（epoch 毫秒）再提交
  dom.get('ban-reason').value = '  多次上传违规内容  ';
  const local = dom.get('ban-until').value; // 默认值 = 7 天后（本地时间串）
  assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local), `默认到期时间应是本地时间串，实际 ${local}`);
  await modal.foot[1].onClick(modal.body, modal.close);

  const sent = callsOf('banUser');
  assertEqual(sent.length, 1, '点「确认封禁」必须发出封禁请求');
  assertEqual(sent[0].args[0], 'u-f', '必须带上目标用户 id');
  assertEqual(sent[0].args[1].reason, '多次上传违规内容', '原因应去掉首尾空白后提交');
  assertEqual(typeof sent[0].args[1].until, 'number',
    'datetime-local 的值不带时区，必须换算成 epoch 毫秒再传；'
    + '直接把字符串发给服务端会在"浏览器时区 ≠ 服务器时区"时错位若干小时');
  assertEqual(sent[0].args[1].until, new Date(local).getTime(),
    '换算结果必须等于"按浏览器本地时区解释该时间串"得到的绝对时刻');
  assertEqual(globalThis.__closed > 0, true, '提交成功后应关闭弹窗');
  assert(/已封禁/.test(toastsText()), `应提示已封禁，实际：${toastsText()}`);
});

test('R33 · 前端：封禁弹窗清空到期时间 = 永久封禁；原因为空则本地拦下', async () => {
  const { dom } = await bootUserCard([normalRow('u-g', 'bob')]);
  await findBtn(dom.get('user-table'), 'ban', 'u-g').onclick();
  const modal = (globalThis.__modals || [])[0];

  // ① 空原因：本地拦下，不发请求
  dom.get('ban-reason').value = '   ';
  await modal.foot[1].onClick(modal.body, modal.close);
  assertEqual(callsOf('banUser').length, 0, '原因必填：为空时不得发请求（服务端也会 400，这里提前拦一次）');
  assert(/原因/.test(String((dom.get('ban-msg') || {}).textContent || '')), '应在弹窗内提示需要填写原因');

  // ② 填原因 + 清空时间 → 永久封禁
  dom.get('ban-reason').value = '永久封禁';
  dom.get('ban-until').value = '';
  await modal.foot[1].onClick(modal.body, modal.close);
  const sent = callsOf('banUser');
  assertEqual(sent.length, 1, '填了原因、清空了时间应当可以提交');
  assertEqual(sent[0].args[1].until, '', '清空到期时间应提交空串 = 永久封禁（服务端据此不设 until）');
});

test('R33 · api.js：403 的 banned/reason/until 必须挂回错误对象（否则登录页拿不到原因）', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opt) => {
    seen.push({ url, opt });
    const status = globalThis.__fetchStatus;
    return { ok: status >= 200 && status < 300, status, json: async () => globalThis.__fetchBody };
  };
  try {
    const { API } = await import(pathToFileURL(JS('api.js')).href);

    globalThis.__fetchStatus = 403;
    globalThis.__fetchBody = {
      error: '该账户已被封禁', banned: true, reason: '多次上传违规内容', until: '2026-10-11T04:00:00.000Z',
    };
    let err = null;
    try { await API.login('bob', 'pw', '', false); } catch (e) { err = e; }
    assert(err, '被封禁的登录必须抛出错误');
    assertEqual(err.status, 403, '错误对象应保留状态码');
    assertEqual(err.banned, true, 'banned 字段必须挂回错误对象（登录页据此走封禁提示分支）');
    assertEqual(err.reason, '多次上传违规内容', 'reason 必须挂回错误对象（需求 5 的原因来源）');
    assertEqual(err.until, '2026-10-11T04:00:00.000Z', 'until 必须挂回错误对象（需求 5 的解封时间来源）');

    // 对照：普通 401 不得被误判成封禁
    globalThis.__fetchStatus = 401;
    globalThis.__fetchBody = { error: '用户名或密码错误' };
    let err2 = null;
    try { await API.login('bob', 'bad', '', false); } catch (e) { err2 = e; }
    assert(err2 && !err2.banned, '普通凭据错误不得被识别为封禁');

    // 封禁 / 解封两个客户端方法的路径必须与路由一致
    globalThis.__fetchStatus = 200;
    globalThis.__fetchBody = { ok: true };
    seen.length = 0;
    await API.banUser('u1', { reason: 'r', until: 123 });
    await API.unbanUser('u1');
    assertEqual(seen[0].url, '/api/users/u1/ban', '封禁应打到 /api/users/:id/ban');
    assertEqual(seen[0].opt.method, 'POST', '封禁应为 POST');
    assertEqual(JSON.parse(seen[0].opt.body).until, 123, '封禁请求体应原样带上 until');
    assertEqual(seen[1].url, '/api/users/u1/unban', '解封应打到 /api/users/:id/unban');
    assertEqual(seen[1].opt.method, 'POST', '解封应为 POST');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('R33 · util.banNotice：登录页文案同时给出原因与解封时间，永久封禁单独措辞', async () => {
  const { banNotice } = await import(pathToFileURL(JS('util.js')).href);

  const withTime = banNotice({ reason: '多次上传违规内容', until: '2026-10-11T04:00:00.000Z' });
  assert(/封禁原因：多次上传违规内容/.test(withTime), `文案应包含封禁原因，实际：${withTime}`);
  assert(/解封时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(withTime), `文案应包含解封时间，实际：${withTime}`);

  const forever = banNotice({ reason: '', until: '' });
  assert(/永久/.test(forever), `永久封禁应明确写"永久"，实际：${forever}`);
  assert(!/原因：/.test(forever), '没有原因时不应输出一个空的原因字段');

  const err = new Error('该账户已被封禁');
  assert(/已被封禁/.test(banNotice(err)), '只有 error 文案时也应给出一句完整提示（不得输出 undefined）');
  assert(!/undefined/.test(banNotice(err)), '不得把 undefined 拼进给用户看的文案');
});

test('R33 · 接线：登录失败分支消费 e.banned（静态钉子，行为由上面两条用例覆盖）', () => {
  // `main.js` 是带副作用的入口模块（import 即引导整个应用），测试里无法单独载入，
  // 因此这里只钉住"最后一公里"的接线：登录 catch 必须**分岔**，且文案取自 util.banNotice。
  //
  // ⚠️ 定位方式：以「resetAuthCaptcha(); // token 一次性使用」这句**唯一**的收尾注释为锚，
  //    只看它前面 300 字符。不能用「showAuthError(...); 紧跟 resetAuthCaptcha」这种写法 ——
  //    Windows Hello 分支里也有一处同样形状的相邻两行，会先匹配上而让断言打偏。
  const src = fs.readFileSync(JS('main.js'), 'utf8');
  const marker = 'resetAuthCaptcha(); // token 一次性使用';
  const at = src.indexOf(marker);
  assert(at > 0, '应能在 main.js 中定位到登录失败的收尾分支（锚点注释被改动请同步本用例）');
  const branch = src.slice(Math.max(0, at - 300), at);

  assert(/e\.banned/.test(branch),
    'catch 必须按 e.banned 分岔：否则被封用户只会看到一句让人反复重试密码的「用户名或密码错误」');
  assert(/banNotice\(/.test(branch), '封禁分支的文案必须取自 util.banNotice（唯一实现点）');
  assert(/import\s*\{[^}]*\bbanNotice\b[^}]*\}\s*from\s*'\.\/util\.js'/.test(src),
    'main.js 应从 util.js 引入 banNotice（而不是自己再写一份文案）');
});
