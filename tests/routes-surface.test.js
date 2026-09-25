/**
 * 测试：路由表面积与权限守卫的静态一致性
 *
 * 目的：拆分 routes.js（2200 行）为 server/routes/ 子模块后，确保
 *  1. 路由总量与关键路径未丢失、未重复；
 *  2. 敏感接口仍挂载 requireAdmin；
 *  3. 挂载顺序未破坏（/credentials/visibility 先于 /credentials/:id）。
 * 这类断言不需要启动服务、不触碰 data/，是重构后最有价值的「防回退」网。
 */
const test = require('node:test');
const path = require('node:path');

const { assert, assertEqual, ROOT } = require('./helpers');

const routes = require(path.join(ROOT, 'server', 'routes.js'));

/** 展开 express 路由栈为 ['GET /a/b', ...] */
function listRoutes(router) {
  const out = [];
  const walk = (stack) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
        for (const m of methods) out.push(`${m} ${layer.route.path}`);
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(router.stack);
  return out;
}

const ROUTES = listRoutes(routes);

/** 完整路由清单（重构基线 + WebAuthn 增量，用于回归比对） */
const EXPECTED = [
  'POST /auth/login', 'POST /auth/login/webauthn',
  'POST /auth/logout', 'POST /auth/logout-all', 'GET /auth/me', 'POST /auth/init',
  'GET /users/me', 'PUT /users/me',
  'GET /users', 'POST /users', 'PUT /users/:id', 'DELETE /users/:id', 'POST /users/:id/logout',
  'GET /captcha/public', 'GET /captcha/config', 'PUT /captcha/config',
  'GET /payment/config', 'PUT /payment/config/:platform',
  'POST /payment/config/:platform/validate', 'DELETE /payment/config/:platform',
  'PUT /payment/enabled', 'PUT /payment/config/:platform/enabled',
  'PUT /payment/site-url', 'GET /payment/orders', 'POST /payment/orders/:id/refund',
  'POST /webauthn/register/options', 'POST /webauthn/register/verify',
  'POST /webauthn/disable', 'POST /users/:id/webauthn/disable',
  'GET /config', 'PUT /config',
  'GET /credentials', 'POST /credentials', 'PUT /credentials/:id/active', 'PUT /credentials/visibility',
  'PUT /credentials/:id', 'DELETE /credentials/:id',
  'POST /config/verify',
  // 注意：云端桶列表的 `GET /buckets` 已删除（死代码），唯一入口是 POST /config/verify
  'GET /buckets/local', 'POST /buckets/local', 'PUT /buckets/local/:id',
  'PUT /buckets/local/:id/enabled', 'PUT /buckets/local/:id/active', 'PUT /buckets/visibility',
  'DELETE /buckets/local/:id', 'GET /buckets/stats',
  'POST /buckets/local/:id/clear', 'GET /buckets/local/:id/fragments',
  'POST /buckets/local/:id/fragments/clear', 'GET /buckets/local/:id/destroy-check',
  'POST /buckets/local/:id/destroy', 'PUT /buckets/local/:id/block-overseas',
  'GET /acl-check', 'PUT /acl-check/disabled',
  'GET /ipguard', 'POST /ipguard/rules', 'PUT /ipguard/rules/:id',
  'PUT /ipguard/rules/:id/enabled', 'DELETE /ipguard/rules/:id', 'GET /ipguard/test',
  'GET /enc/settings', 'PUT /enc/settings', 'POST /enc/unlock',
  // R8-14：只回 `{ passwordSet }`（不含 mode / 魔数）的只读端点，普通用户也可访问
  // —— 前端 `ensureUnlocked()` 靠它判断「要不要弹查看密码框」。见下方 selfServe。
  'GET /enc/status',
  'GET /upload-excludes', 'PUT /upload-excludes',
  'GET /webdav', 'PUT /webdav/enabled', 'POST /webdav/accounts',
  'PUT /webdav/accounts/:id', 'DELETE /webdav/accounts/:id', 'GET /webdav/accounts/:id/password',
  'GET /links', 'POST /links', 'PUT /links/:id', 'DELETE /links/:id',
  'GET /fs/list', 'GET /fs/stat', 'GET /fs/search', 'POST /fs/mkdir',
  'PUT /fs/upload/simple', 'POST /fs/upload/init', 'PUT /fs/upload/chunk',
  'POST /fs/upload/complete', 'POST /fs/upload/abort', 'GET /fs/sessions',
  // R11-05：`/fs/download` 的 HEAD 必须显式注册（express 对 HEAD 有「退化成 get」的
  // 回退，不注册就会走 streamDownload 全路径 —— 整份下载 + 污染流量统计）
  'HEAD /fs/download',
  'GET /fs/download', 'GET /fs/thumb', 'GET /fs/presign',
  'POST /fs/rename', 'POST /fs/move', 'POST /fs/delete', 'GET /fs/tree',
  'GET /stats/speed', 'GET /stats/storage', 'GET /stats/summary', 'GET /stats/logs',
  'GET /health',
];

test('路由总数与重构前一致', () => {
  assertEqual(ROUTES.length, EXPECTED.length, '路由数量应保持不变');
});

test('无路由丢失', () => {
  const missing = EXPECTED.filter((r) => !ROUTES.includes(r));
  assertEqual(missing.length, 0, '以下路由在拆分后丢失：' + missing.join(', '));
});

test('无路由重复注册', () => {
  const seen = new Set();
  const dup = [];
  for (const r of ROUTES) {
    if (seen.has(r)) dup.push(r);
    seen.add(r);
  }
  assertEqual(dup.length, 0, '以下路由被重复注册：' + dup.join(', '));
});

test('敏感接口均挂载 requireAdmin', () => {
  // 这些路由的 handler 链中必须存在 requireAdmin（否则普通用户可越权）
  // 通过 express 路由层的 handle 列表逐一核查
  const adminGuarded = [];
  const walk = (stack, prefix) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const h = layer.route.stack || layer.route.handlers || [];
        const names = h.map((x) => (x && x.name) || '');
        if (names.includes('requireAdmin')) {
          const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
          for (const m of methods) adminGuarded.push(`${m} ${layer.route.path}`);
        }
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack, prefix);
      }
    }
  };
  walk(routes.stack, '');

  const mustBeAdmin = [
    // 注意：GET /users 不在此列 —— 普通用户也需要它来读自己的资料，
    // 服务端按 role 过滤返回内容（scope: 'all' | 'self'），而非拒绝访问。
    'POST /users', 'PUT /users/:id', 'DELETE /users/:id', 'POST /users/:id/logout',
    'POST /users/:id/webauthn/disable',
    'PUT /config',
    // 连接验证会回传云端全部桶名（SEC-11 账号资产）且请求方可带 endpoint（SEC-03 SSRF）
    'POST /config/verify',
    'POST /credentials', 'PUT /credentials/:id/active', 'PUT /credentials/visibility',
    'PUT /credentials/:id', 'DELETE /credentials/:id',
    // 桶集合由管理员统一维护（普通用户不再自行添加：不知道桶名/地域，也无枚举权限）
    'POST /buckets/local',
    'PUT /buckets/local/:id/enabled', 'PUT /buckets/visibility', 'DELETE /buckets/local/:id',
    'POST /buckets/local/:id/clear', 'POST /buckets/local/:id/fragments/clear',
    'POST /buckets/local/:id/destroy', 'PUT /buckets/local/:id/block-overseas',
    // R8-08：彻底删除前的三项前置读/写（fragments、fragments/clear、destroy）原先只有
    // destroy-check 漏挂 —— 它会暴露**不可见桶**的对象数/碎片数/可删性，并真实发起
    // getBucket + 分片全量列举。登记在此，避免下次重构再漏。
    'GET /buckets/local/:id/destroy-check', 'GET /buckets/local/:id/fragments',
    'PUT /acl-check/disabled',
    'GET /ipguard', 'POST /ipguard/rules', 'PUT /ipguard/rules/:id',
    'PUT /ipguard/rules/:id/enabled', 'DELETE /ipguard/rules/:id', 'GET /ipguard/test',
    // 退款会把订单置为不可逆终态并让支付凭证失效，必须与其它写操作同级保护
    'POST /payment/orders/:id/refund',
    'GET /enc/settings', 'PUT /enc/settings',
    'GET /upload-excludes', 'PUT /upload-excludes',
    'GET /webdav', 'PUT /webdav/enabled', 'POST /webdav/accounts',
    'PUT /webdav/accounts/:id', 'DELETE /webdav/accounts/:id', 'GET /webdav/accounts/:id/password',
  ];
  const unprotected = mustBeAdmin.filter((r) => !adminGuarded.includes(r));
  assertEqual(unprotected.length, 0,
    '以下敏感路由缺少 requireAdmin 保护：\n  ' + unprotected.join('\n  '));
});

test('明文密码接口受管理员保护（WebDAV）', () => {
  const s = require('node:fs').readFileSync(
    path.join(ROOT, 'server', 'routes', 'webdav.js'), 'utf8');
  assert(/requireAdmin/.test(s), 'webdav.js 必须引用 requireAdmin');
  assert(/accounts\/:id\/password',\s*requireAdmin/.test(s),
    '/webdav/accounts/:id/password 必须显式挂载 requireAdmin');
});

test('/credentials/visibility 先于 /credentials/:id 注册', () => {
  const iv = ROUTES.indexOf('PUT /credentials/visibility');
  const id = ROUTES.indexOf('PUT /credentials/:id');
  assert(iv >= 0 && id >= 0, '两个路由都应存在');
  assert(iv < id, '/credentials/visibility 必须在 /credentials/:id 之前，否则会被参数捕获');
});

test('/users/me 先于 /users/:id 注册（否则自助接口被参数路由吞掉）', () => {
  const getMe = ROUTES.indexOf('GET /users/me');
  const putMe = ROUTES.indexOf('PUT /users/me');
  const putId = ROUTES.indexOf('PUT /users/:id');
  assertEqual(getMe, 6, 'GET /users/me 应为第 7 条路由');
  assertEqual(putMe, 7, 'PUT /users/me 应为第 8 条路由');
  assert(putId > putMe, 'PUT /users/me 必须在 PUT /users/:id 之前');
});

test('自助接口不挂 requireAdmin（普通用户必须可用）', () => {
  // GET/PUT /users/me、/webauthn/register|disable 属"人人可用"，误挂管理员守卫会导致
  // 普通用户无法修改自己的资料 / 启用 Windows Hello。
  const selfServe = [
    'GET /users/me', 'PUT /users/me',
    'POST /webauthn/register/options', 'POST /webauthn/register/verify',
    'POST /webauthn/disable',
    'POST /auth/login/webauthn',
    // R8-14：只回 `{ passwordSet }`（不含 mode / 魔数）。普通用户必须能读到它，
    // 否则前端 `ensureUnlocked()` 恒真、加密文件的密码验证框永不出现。
    'GET /enc/status',
  ];
  const guardMap = new Map();
  const walk = (stack) => {
    for (const layer of stack || []) {
      if (layer.route) {
        const h = layer.route.stack || layer.route.handlers || [];
        const names = h.map((x) => (x && x.name) || '');
        const methods = Object.keys(layer.route.methods).map((m) => m.toUpperCase());
        for (const m of methods) guardMap.set(`${m} ${layer.route.path}`, names.includes('requireAdmin'));
      } else if (layer.handle && layer.handle.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk(routes.stack);
  const wrong = selfServe.filter((r) => guardMap.get(r) === true);
  assertEqual(wrong.length, 0, '以下自助路由不应挂 requireAdmin：\n  ' + wrong.join('\n  '));
  // 反向确认这些路由确实存在于守卫表中（避免拼写错误导致断言空过）
  const absent = selfServe.filter((r) => !guardMap.has(r));
  assertEqual(absent.length, 0, '自助路由清单存在拼写错误：\n  ' + absent.join('\n  '));
});

test('两步登录的第二步在匿名白名单中（index.js PUBLIC_API）', () => {
  // /auth/login/webauthn 在"密码已校验但尚未签发会话"的中间态被调用，
  // 因此必须可匿名到达，否则第二步一定 401。
  const idx = require('node:fs').readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  assert(/\/auth\/login\/webauthn/.test(idx), "index.js 的 PUBLIC_API 应包含 '/auth/login/webauthn'");
});

test('/auth/me 与 /auth/login 位于匿名白名单所需位置（auth 模块优先挂载）', () => {
  // index.js 的 PUBLIC_API 依赖 /auth/login、/auth/me、/auth/init 可匿名到达；
  // 拆分后 auth 模块必须第一个挂载（无前置鉴权中间件阻断）
  const idx = require('node:fs').readFileSync(path.join(ROOT, 'server', 'routes.js'), 'utf8');
  const authPos = idx.indexOf("require('./routes/auth')");
  const others = ["require('./routes/users')", "require('./routes/fs')", "require('./routes/buckets')"]
    .map((s) => idx.indexOf(s)).filter((x) => x >= 0);
  assert(authPos >= 0, 'routes.js 应挂载 auth 模块');
  assert(others.every((x) => x > authPos), 'auth 模块应最先挂载');
});

/**
 * 文档侧的反向护栏：真实路由必须在 `Develop_Document.md` 里**逐条**出现。
 *
 * 起因：第 7 章的 API 表习惯用「家族记法」压缩同类路由（如
 * `PUT /buckets/local/:id/active` · `/enabled` · `/buckets/visibility`），
 * 被压缩掉的那几条在全文里根本搜不到完整路径 —— 二开的人只能去翻源码。
 * 曾经漏掉的就是 `PUT /buckets/local/:id/enabled`、`PUT /ipguard/rules/:id/enabled`、
 * `GET /webdav/accounts/:id/password`、`POST /fs/upload/abort` 这四条。
 *
 * 判据只看「路径是否出现」，不要求与方法同框：8.3 的支付接口表、模块说明里的
 * 单行提及都算数。这样既拦得住整条漏列，又不会因为表格排版调整而误报。
 */
test('全部路由都能在开发文档中搜到完整路径（防「家族记法」漏列）', () => {
  const doc = require('node:fs').readFileSync(path.join(ROOT, 'Develop_Document.md'), 'utf8');
  const missing = EXPECTED.filter((r) => {
    const routePath = r.slice(r.indexOf(' ') + 1);
    return doc.indexOf(routePath) < 0;
  });
  assertEqual(missing.length, 0,
    '以下路由在开发文档里搜不到完整路径（多半是被「家族记法」压掉了）：' + missing.join('、'));
});
