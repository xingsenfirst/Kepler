/**
 * 第四十二轮护栏（R42-01 ~ R42-03）—— 多厂商密钥「无法绑定」与厂商差异收敛
 *
 * 用户报告：**华为云 / 七牛云 / 又拍云 / Backblaze 不可用 —— 即使是正确的 key 也无法
 * 正常绑定密钥**；AWS S3 / Microsoft Azure / Google Cloud / MinIO 未经测试。
 *
 * 根因不是任何一家的协议写错了（SigV4 是自洽的、端点也与官方文档一致），而是
 * `/api/config/verify` 里的一段**跨厂商继承**：
 *
 *   const region = (b.region && …) || stored.region;     // stored = configStore.get()
 *   const bucket = (b.bucket && …) || stored.bucket;
 *   const endpoint = composeEndpoint(provider, (b.endpoint && …) || stored.endpoint);
 *
 * `configStore.get()` 返回的是**当前生效配置**的扁平形态（`effective()`），其中的
 * `region` / `bucket` / `endpoint` 属于**当前激活的那个桶**。密钥表单里根本没有地域栏
 * （地域记在桶上），所以「测试连接」只会提交 provider/secretId/secretKey —— 于是这些
 * 值被原样拿去验证**另一家**的密钥：
 *   · `region` 推导端点 ⇒ 「用华为云密钥」实际打向 `obs.ap-guangzhou.myhuaweicloud.com`
 *     （华为云没有该地域）⇒ DNS 失败，界面只说「网络连接异常」；
 *   · 又拍云更隐蔽：端点是固定且正确的 `s3.api.upyun.com`，错的是**签名地域**
 *     （应为 us-east-1，被写成别家的 ap-southeast-2）⇒ 403 SignatureDoesNotMatch；
 *   · 阿里云等的 `stored.endpoint` **恒非空** ⇒ 请求被发到别家域名。
 * 表现即「谁先配好谁正常，之后换哪家都不行」，与用户报告完全吻合。
 *
 * 另一半是**厂商差异**：华为云 OBS 的 V4 只接受 `UNSIGNED-PAYLOAD`，发真实载荷哈希
 * 必得 403 且报文不带线索 —— 这条同样由注册表下发（`providers.unsignedPayload`）。
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R42-*` 条目。
 * ⚠️ 端口一律 `listen(0)`；所有出站请求走 fetch 拦截，绝不真连云端。
 */
const fsc = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { test } = require('node:test');
const { ROOT, assert, assertEqual } = require('./helpers.js');

const TMP = fsc.mkdtempSync(path.join(os.tmpdir(), 'cos-audit42-'));
process.env.COS_DATA_DIR = TMP;

const express = require(path.join(ROOT, 'node_modules', 'express'));
const providers = require(path.join(ROOT, 'server', 'providers.js'));
const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const configRoutes = require(path.join(ROOT, 'server', 'routes', 'config.js'));

/* ==================================================================== */
/* 出站拦截：把所有 fetch 记下来，并合成一个成功的响应                        */
/* ==================================================================== */

const captured = [];
const realFetch = global.fetch;

function installFetch(xml) {
  captured.length = 0;
  global.fetch = (url, init) => {
    const h = {};
    const hd = (init && init.headers) || {};
    if (typeof hd.forEach === 'function') hd.forEach((v, k) => { h[k] = v; });
    else for (const [k, v] of Object.entries(hd)) h[k] = v;
    captured.push({ url: String(url), method: String((init && init.method) || 'GET').toUpperCase(), headers: h });
    const body = xml === null ? '' : (xml || '<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
    return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } }));
  };
}
process.on('exit', () => { global.fetch = realFetch; });

const hosts = () => captured.map((c) => new URL(c.url).host);

/* ==================================================================== */
/* 最小 HTTP 挂载（与 audit26 同款）                                        */
/* ==================================================================== */

function serve(mount, router) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  // 路由内用 requireAdmin：直接注入管理员身份，把被测面收窄到「取值」这一个点
  app.use((req, _res, next) => { req.authUser = { id: 'u1', username: 'u1', role: 'admin' }; next(); });
  app.use(mount, router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function send(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : null),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, raw, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 种一份「当前生效配置」：某个厂商的密钥 + 一个启用中的桶（带地域）。
 * 这正是 `configStore.get()` 会读到的东西，也是旧实现拿去污染别家验证的来源。
 */
function seedActive(provider, region, bucketName) {
  configStore.save({
    credentials: [{
      id: 'c-active', provider, secretId: 'SID-' + provider, secretKey: 'k-' + provider,
      endpoint: '', quotaBytes: 0, enabled: true, visibleToUsers: true, remark: '',
    }],
    buckets: [{
      id: 'b-active', provider, bucket: bucketName, region, remark: '',
      quotaBytes: 0, credentialId: 'c-active', visibleToUsers: true, enabled: true,
    }],
    activeCredentialId: 'c-active',
    activeBucketId: 'b-active',
  });
}

/* ==================================================================== */
/* R42-01 · 跨厂商「测试连接」不得继承当前生效配置的 region / bucket / endpoint */
/* ==================================================================== */

test('R42-01a · 别的厂商的密钥，验证时必须落回该厂商自己的默认端点（不得被激活桶的地域带偏）', async () => {
  // 激活配置：AWS + 悉尼的桶。旧实现会把 ap-southeast-2 塞进华为云的端点模板
  seedActive('aws', 'ap-southeast-2', 'demo-aws-bucket');
  installFetch();
  const srv = await serve('/api', configRoutes);
  try {
    const r = await send(srv.port, 'POST', '/api/config/verify', {
      provider: 'huawei', secretId: 'HWAKxxxxxxxxxxxxxxxx', secretKey: 'h'.repeat(32),
    });
    assertEqual(r.status, 200, 'R42-01a：验证接口本身应正常应答（实际 ' + r.raw + '）');
    assert(r.json && r.json.ok === true,
      'R42-01a：华为云密钥必须验证通过，实际返回 ' + JSON.stringify(r.json));
    const h = hosts();
    assertEqual(h[0], 'obs.cn-north-4.myhuaweicloud.com',
      'R42-01a：必须用华为云的默认端点，实际打了 ' + h.join(', '));
    assert(!h.some((x) => /ap-southeast-2/.test(x)),
      'R42-01a：不得把激活桶（AWS 悉尼）的地域带进华为云的端点，实际 ' + h.join(', '));
  } finally {
    await srv.close();
  }
});

test('R42-01b · 同厂商仍然继承激活桶的地域（防「矫枉过正」把正常场景也切断）', async () => {
  seedActive('aws', 'ap-southeast-2', 'demo-aws-bucket');
  installFetch();
  const srv = await serve('/api', configRoutes);
  try {
    const r = await send(srv.port, 'POST', '/api/config/verify', {
      provider: 'aws', secretId: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
    assert(r.json && r.json.ok === true, 'R42-01b：同厂商验证应通过，实际 ' + JSON.stringify(r.json));
    const h = hosts();
    assert(h.includes('s3.ap-southeast-2.amazonaws.com'),
      'R42-01b：同厂商必须继承激活桶的地域，实际 ' + h.join(', '));
  } finally {
    await srv.close();
  }
});

test('R42-01c · 端点固定、地域靠签名的那家（又拍云）：跨厂商时签名地域必须是它自己的', async () => {
  seedActive('aws', 'ap-southeast-2', 'demo-aws-bucket');
  installFetch();
  const srv = await serve('/api', configRoutes);
  try {
    const r = await send(srv.port, 'POST', '/api/config/verify', {
      provider: 'upyun', secretId: 'operator', secretKey: 'p'.repeat(32),
    });
    assert(r.json && r.json.ok === true, 'R42-01c：又拍云密钥应验证通过，实际 ' + JSON.stringify(r.json));
    const h = hosts();
    // 又拍云端点恒定 —— 光看 URL 看不出问题，真正的判据在 Authorization 的 scope 里
    assertEqual(h[0], 's3.api.upyun.com', 'R42-01c：又拍云端点固定为 s3.api.upyun.com，实际 ' + h.join(', '));
    const auth = captured[0].headers.authorization || captured[0].headers.Authorization || '';
    assert(/\/us-east-1\/s3\/aws4_request/.test(auth),
      'R42-01c：签名地域必须是又拍云的 us-east-1，实际 Authorization = ' + auth);
    assert(!/ap-southeast-2/.test(auth),
      'R42-01c：不得把激活桶的地域写进签名串，实际 Authorization = ' + auth);
  } finally {
    await srv.close();
  }
});

test('R42-01d · 激活配置的「固定端点」（阿里云恒非空）不得被当成别家的端点', async () => {
  seedActive('aliyun', 'cn-hangzhou', 'demo-oss-bucket');
  // 先确认前提：effective() 给出的 endpoint 确实非空（这正是旧实现的污染源）
  const stored = configStore.get();
  assert(stored.endpoint && /aliyuncs\.com/.test(stored.endpoint),
    'R42-01d：前提不成立 —— 激活配置应带一个非空端点，实际 ' + JSON.stringify(stored.endpoint));

  installFetch();
  const srv = await serve('/api', configRoutes);
  try {
    const r = await send(srv.port, 'POST', '/api/config/verify', {
      provider: 'huawei', secretId: 'HWAKxxxxxxxxxxxxxxxx', secretKey: 'h'.repeat(32),
    });
    assert(r.json && r.json.ok === true, 'R42-01d：华为云密钥应验证通过，实际 ' + JSON.stringify(r.json));
    const h = hosts();
    assertEqual(h[0], 'obs.cn-north-4.myhuaweicloud.com', 'R42-01d：实际打了 ' + h.join(', '));
    assert(!h.some((x) => /aliyuncs\.com/.test(x)),
      'R42-01d：请求不得发往激活配置所属厂商的域名，实际 ' + h.join(', '));
  } finally {
    await srv.close();
  }
});

test('R42-01e · 跨厂商时也不得拿激活桶的名字去 headBucket', async () => {
  seedActive('aws', 'ap-southeast-2', 'demo-aws-bucket');
  installFetch();
  const srv = await serve('/api', configRoutes);
  try {
    await send(srv.port, 'POST', '/api/config/verify', {
      provider: 'b2', secretId: 'keyid-0001', secretKey: 'a'.repeat(32),
    });
    assert(!captured.some((c) => c.method === 'HEAD'),
      'R42-01e：别的厂商的桶名不得被拿来在本厂商上做存在性探测，实际请求 ' + JSON.stringify(hosts()));
    assert(!captured.some((c) => c.url.includes('demo-aws-bucket')),
      'R42-01e：激活桶名不得出现在跨厂商验证的请求里，实际 ' + JSON.stringify(captured.map((c) => c.url)));
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R42-02 · 华为云只收 UNSIGNED-PAYLOAD（厂商差异由注册表下发）                */
/* ==================================================================== */

test('R42-02a · 华为云所有请求都发 UNSIGNED-PAYLOAD（含空体 GET），别家维持真实哈希', async () => {
  const UNSIGNED = 'UNSIGNED-PAYLOAD';
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  async function observe(provider, region) {
    installFetch();
    const client = cos.createClient({
      provider, secretId: 'AK', secretKey: 's'.repeat(32), region, bucket: 'b',
      endpoint: provider === 'minio' ? 'https://minio.example.com:9000' : undefined,
    });
    await client.getService({});
    const get = captured[captured.length - 1].headers['x-amz-content-sha256'];
    await client.putObject({ Bucket: 'b', Key: 'k.txt', Body: Buffer.from('hello') });
    const put = captured[captured.length - 1].headers['x-amz-content-sha256'];
    return { get, put };
  }

  const hw = await observe('huawei', 'cn-north-4');
  assertEqual(hw.get, UNSIGNED, 'R42-02a：华为云空体请求也必须发 UNSIGNED-PAYLOAD');
  assertEqual(hw.put, UNSIGNED, 'R42-02a：华为云带体请求必须发 UNSIGNED-PAYLOAD（发真实哈希必 403）');

  // 负向对照：别家必须维持原状 —— 七牛的 S3 文档明确要求「每个请求必带 payload 的 sha256」
  const qn = await observe('qiniu', 'cn-east-1');
  assertEqual(qn.get, EMPTY, 'R42-02a：七牛的空体请求仍必须是空串哈希');
  assertEqual(qn.put, crypto.createHash('sha256').update('hello').digest('hex'),
    'R42-02a：七牛的带体请求仍必须是真实载荷哈希');

  const aws = await observe('aws', 'us-east-1');
  assertEqual(aws.put, crypto.createHash('sha256').update('hello').digest('hex'),
    'R42-02a：AWS 维持真实载荷哈希');
});

test('R42-02b · 注册表里只有华为云声明 unsignedPayload（顺手给别家开会被对方拒绝）', async () => {
  assertEqual(providers.unsignedPayload('huawei'), true, 'R42-02b：华为云必须声明 unsignedPayload');
  for (const id of ['tencent', 'aliyun', 'qiniu', 'upyun', 'azure', 'aws', 'gcs', 'r2', 'minio', 'b2']) {
    assertEqual(providers.unsignedPayload(id), false,
      `R42-02b：${id} 不得声明 unsignedPayload（七牛等明确要求真实载荷哈希）`);
  }
  assertEqual(providers.unsignedPayload('不存在的厂商'), false, 'R42-02b：未知厂商回退后也不得为 true');
  assertEqual(providers.PROVIDERS.filter((p) => p.unsignedPayload).length, 1,
    'R42-02b：全表只允许有一家声明 unsignedPayload');
});

/* ==================================================================== */
/* R42-03 · 八家厂商的连接参数一致性（把「未经测试」的那四家纳入覆盖）          */
/* ==================================================================== */

/** 按 AWS SigV4 规范**独立**重算签名 —— 不抄 s3-client 的任何一行 */
function verifySigV4(req, secret) {
  const auth = req.headers.authorization || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return { ok: false, why: 'Authorization 格式不符：' + auth.slice(0, 90) };
  const [, , dateStamp, region, service, signedStr, sig] = m;
  const names = signedStr.split(';');
  const u = new URL(req.url);
  const enc = (v, keepSlash) => String(v).split('').map((ch) => {
    if (/[A-Za-z0-9\-._~]/.test(ch)) return ch;
    if (ch === '/' && keepSlash) return ch;
    return Buffer.from(ch, 'utf8').toString('hex').replace(/../g, (h) => '%' + h.toUpperCase());
  }).join('');
  const pairs = [];
  u.searchParams.forEach((v, k) => pairs.push([enc(k, false), enc(v, false)]));
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const lowered = {};
  for (const [k, v] of Object.entries(req.headers)) lowered[k.toLowerCase()] = String(v).trim();
  const missing = names.filter((n) => lowered[n] === undefined);
  if (missing.length) return { ok: false, why: '签了但请求里没有的头：' + missing.join(',') };
  const canonical = [
    req.method, u.pathname || '/', pairs.map(([k, v]) => `${k}=${v}`).join('&'),
    names.map((n) => `${n}:${lowered[n]}\n`).join(''), signedStr,
    lowered['x-amz-content-sha256'] || '',
  ].join('\n');
  const sts = ['AWS4-HMAC-SHA256', lowered['x-amz-date'] || '',
    `${dateStamp}/${region}/${service}/aws4_request`,
    crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const h = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
  const key = h(h(h(h('AWS4' + secret, dateStamp), region), service), 'aws4_request');
  const expect = crypto.createHmac('sha256', key).update(sts, 'utf8').digest('hex');
  return { ok: expect === sig, why: expect === sig ? '' : `签名不符（region=${region}）` };
}

const CONFORMANCE = [
  { id: 'aliyun', region: 'cn-hangzhou', host: 'oss-cn-hangzhou.aliyuncs.com' },
  { id: 'huawei', region: 'cn-north-4', host: 'obs.cn-north-4.myhuaweicloud.com' },
  { id: 'qiniu', region: 'cn-east-1', host: 's3.cn-east-1.qiniucs.com' },
  { id: 'upyun', region: '', host: 's3.api.upyun.com' },
  { id: 'aws', region: 'us-east-1', host: 's3.us-east-1.amazonaws.com' },
  { id: 'gcs', region: '', host: 'storage.googleapis.com' },
  { id: 'minio', region: '', host: 'minio.example.com:9000', endpoint: 'https://minio.example.com:9000' },
  { id: 'b2', region: 'us-west-004', host: 's3.us-west-004.backblazeb2.com' },
];

test('R42-03a · 八家 S3 厂商：端点/地域/桶名寻址正确，且 SigV4 与 AWS 规范逐字自洽', async () => {
  const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  for (const c of CONFORMANCE) {
    installFetch();
    const client = cos.createClient({
      provider: c.id, secretId: 'AKIAIOSFODNN7EXAMPLE', secretKey: SECRET,
      region: c.region, bucket: 'demo-bucket', endpoint: c.endpoint,
    });
    await client.getService({});
    await client.putObject({ Bucket: 'demo-bucket', Key: 'dir/a b.txt', Body: Buffer.from('hello') });
    await client.getBucket({ Bucket: 'demo-bucket' });
    await client.headBucket({ Bucket: 'demo-bucket' });

    assertEqual(captured.length, 4, `R42-03a：${c.id} 应发出 4 个请求，实际 ${captured.length}`);
    assertEqual(new URL(captured[0].url).host, c.host, `R42-03a：${c.id} 服务级端点应为 ${c.host}`);
    // 桶级请求：虚拟主机风格（MinIO 走路径风格，桶名落在路径上）
    const item = new URL(captured[1].url);
    const where = c.id === 'minio' ? item.pathname : item.host;
    assert(where.includes('demo-bucket'), `R42-03a：${c.id} 桶名寻址错误，实际 ${item.host}${item.pathname}`);
    for (const req of captured) {
      const v = verifySigV4(req, SECRET);
      assert(v.ok, `R42-03a：${c.id} ${req.method} ${req.url} —— ${v.why}`);
    }
  }
});

test('R42-03b · Azure 走独立鉴权协议（Shared Key），不得混入 SigV4 头', async () => {
  installFetch();
  const client = cos.createClient({
    provider: 'azure', secretId: 'myaccount', secretKey: 'a'.repeat(44) + '==',
    region: '', bucket: 'demo-container',
  });
  await client.getService({});
  assertEqual(new URL(captured[0].url).host, 'myaccount.blob.core.windows.net',
    'R42-03b：Azure 端点由存储账户名推导');
  const auth = captured[0].headers.authorization || '';
  assert(/^SharedKey myaccount:/.test(auth), 'R42-03b：Azure 必须用 SharedKey 鉴权，实际 ' + auth.slice(0, 60));
  assert(!/AWS4-HMAC-SHA256/.test(auth), 'R42-03b：Azure 不得使用 SigV4');
  assert(captured[0].headers['x-ms-date'] || captured[0].headers['x-ms-version'],
    'R42-03b：Azure 必须带 x-ms-* 头');
});
