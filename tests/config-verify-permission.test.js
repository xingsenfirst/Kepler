/**
 * 测试：连接验证接口（POST /api/config/verify）的权限边界
 *
 * 背景：本接口会调云端 `getService`，回传该密钥可见的**全部桶名**，同时允许请求方
 * 携带 endpoint / 凭据 —— 因此同时踩在两条红线上：
 *
 *   - **SEC-03 盲 SSRF**：请求方可控的 endpoint / 凭据可被用来探测内网与云实例元数据；
 *   - **SEC-11 云端桶名属于账号资产**：任何登录用户都能枚举即为信息泄露
 *     （`GET /buckets` 长期挂 requireAdmin，理由就是这一条）。
 *
 * 曾经为了「普通用户也能用可见密钥拉取桶列表」，把 requireAdmin 摘掉、改成在请求体内
 * 判定（只允许带 credentialId、且密钥启用 + 对普通用户可见）。那道窄缝把 SSRF 面收窄了，
 * **却没有改变「普通用户能枚举账号资产」这一事实** —— 与 `GET /buckets` 的口径直接冲突。
 *
 * 同一件事只允许有一条口径，因此收回为 `requireAdmin`：非管理员一律 403，
 * 前端对普通用户也不再提供「从云端获取桶列表」入口（仍可手填桶名 + 地域添加，
 * 服务端会做存在性探测）。
 *
 * 这里起真实的 express 应用打请求验证（不触碰真实 data/，只读不写）。
 */
const http = require('http');
const path = require('path');
const fsc = require('fs');
const os = require('os');
const test = require('node:test');
const { assert, assertEqual, ROOT, cleanupTempDir } = require('./helpers');

/**
 * R12-01：本文件此前既不设 `COS_DATA_DIR`，又依赖「生产配置里必须有一条已启用且对
 * 普通用户可见的密钥」才能构造那条最关键的用例。这是把**资产本身**当成测试夹具 ——
 * 换个干净环境（或用户清了配置）用例就直接红。这里改为隔离 + 自己播种。
 */
const TMP = fsc.mkdtempSync(path.join(os.tmpdir(), 'cos-cfgverify-'));
process.env.COS_DATA_DIR = TMP;

test.after(async () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  await cleanupTempDir(TMP, {
    label: 'config-verify-permission',
    flushers: [{ name: 'config-store', flush: () => configStore.flush() }],
  });
});

/* 先接管云端客户端，**再**加载路由：config.js 在 require 时就解构了 createClient / p，
   必须在此之前替换 —— 否则替换不生效，测试会打真实网络（既慢又依赖真密钥是否有效）。 */
const cos = require(path.join(ROOT, 'server', 'cos.js'));
const STUB_BUCKETS = [{ Name: 'demo-bucket', Region: 'ap-guangzhou' }];
cos.createClient = () => ({ __stub: true });
cos.p = async () => ({ Buckets: STUB_BUCKETS });
const configRoutes = require(path.join(ROOT, 'server', 'routes', 'config.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

/* R12-01 · 播种一条「已启用且对普通用户可见」的密钥（隔离目录，不碰生产） */
configStore.save({
  credentials: [{
    id: 'cred-cfgverify', provider: 'tencent',
    secretId: 'stub-id', secretKey: 'stub-key',
    enabled: true, visibleToUsers: true, remark: 'config-verify-permission 播种数据（隔离目录）',
  }],
  activeCredentialId: 'cred-cfgverify',
});

/** 起一个只挂 config 路由、并强制指定角色的临时服务 */
function startServer(role) {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, _res, next) => { req.authUser = { id: 'u', username: 'u', role }; next(); });
  app.use('/api', configRoutes);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

async function postJson(port, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'X-Requested-With': 'XMLHttpRequest' },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch (e) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('连接验证接口挂载 requireAdmin（与 GET /buckets 同一口径）', () => {
  const routes = require(path.join(ROOT, 'server', 'routes.js'));
  let guarded = null;
  const walk = (stack) => {
    for (const layer of stack || []) {
      if (layer.route && layer.route.path === '/config/verify') {
        const names = (layer.route.stack || []).map((x) => x && x.name);
        guarded = names.includes('requireAdmin');
      } else if (layer.handle && layer.handle.stack) walk(layer.handle.stack);
    }
  };
  walk(routes.stack);
  assertEqual(guarded, true,
    'POST /config/verify 必须挂 requireAdmin —— 它会回传该密钥可见的全部云端桶名（SEC-11 账号资产），' +
    '与 GET /buckets 必须保持同一口径，不能只对其中一个放行');
});

test('非管理员一律 403（不泄露密钥是否存在）', async () => {
  const srv = await startServer('user');
  try {
    const r = await postJson(srv.port, '/api/config/verify', { credentialId: '__not_exist__' });
    assertEqual(r.status, 403, '非管理员一律 403，且不区分具体原因');
  } finally {
    await srv.close();
  }
});

test('普通用户不得携带凭据 / 端点字段（否则等于开放盲 SSRF）', async () => {
  const srv = await startServer('user');
  try {
    const cases = [
      { body: { secretId: 'AKIDxxx', secretKey: 'xxx' }, name: '自带 secretId/secretKey' },
      { body: { endpoint: 'http://169.254.169.254/latest/meta-data/' }, name: '自带 endpoint' },
      { body: { region: 'ap-guangzhou' }, name: '自带 region' },
      { body: { provider: 'tencent' }, name: '自带 provider' },
      { body: {}, name: '不带 credentialId' },
    ];
    for (const c of cases) {
      const r = await postJson(srv.port, '/api/config/verify', c.body);
      assertEqual(r.status, 403, `非管理员 + ${c.name}：必须 403`);
    }
  } finally {
    await srv.close();
  }
});

/**
 * 这是口径收紧后**最关键**的一条：即便密钥「已启用且对普通用户可见」，
 * 普通用户也不得借此枚举云端桶名 —— 可见性标记控制的是「能否用这条密钥访问桶」，
 * 不等于「可以把账号下有哪些桶列出来」。
 */
test('普通用户即便持「可见密钥」也不得拿到云端桶列表', async () => {
  const srv = await startServer('user');
  try {
    const cred = (configStore.load().credentials || [])
      .find((c) => c.enabled !== false && c.visibleToUsers !== false);
    assert(cred, '测试环境应至少有一条「已启用且对普通用户可见」的密钥');
    const r = await postJson(srv.port, '/api/config/verify', { credentialId: cred.id });
    assertEqual(r.status, 403, `非管理员不得枚举云端桶列表（实际 ${r.status}）`);
    const leaked = r.json && Array.isArray(r.json.buckets) && r.json.buckets.length > 0;
    assert(!leaked, '响应中不得包含 buckets（云端桶名属账号资产）');
  } finally {
    await srv.close();
  }
});

test('管理员不受上述限制（行为不变）', async () => {
  const srv = await startServer('admin');
  try {
    const r = await postJson(srv.port, '/api/config/verify', { secretId: 'AKIDxxx', secretKey: 'xxx' });
    assert(r.status !== 403, `管理员携带凭据不应被 403（实际 ${r.status}）`);
  } finally {
    await srv.close();
  }
});
