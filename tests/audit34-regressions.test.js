/**
 * 第 34 轮行为护栏 —— 「WebDAV 根路径挂载失败」
 *
 * ## 用户报告的现象
 *
 * 「WebDAV 可以正常触发输入用户名和密码，但登录之后提示『输入的文件夹似乎无效，请选择另一个。』」
 *
 * ## 根因（探针实测复现，不是按 RFC 推演）
 *
 * 「路径是否在挂载点内」这一判据**手写在 9 处**，而根路径 `/` 在其中的大部分地方被落在门外。
 * 于是同一路径上两个回答互相矛盾：
 *
 * | 请求 | 修复前 | 修复后 |
 * |------|--------|--------|
 * | `OPTIONS /` | 200 + `DAV: 1`（`app.options` 的路径参数是正则，`/` 命中） | 200 + `DAV: 1` |
 * | `PROPFIND /` | **404 + `text/html`（Express 默认兜底 `Cannot PROPFIND /`）** | **207 + XML** |
 * | `OPTIONS *` | 404，**无 `DAV` 头**（被挂载点边界拦下） | 200 + `DAV: 1` |
 *
 * `OPTIONS /` 的 200 让客户端判定「这里是 WebDAV」并愿意弹凭据框；401 挑战通过后轮到列目录，
 * 却撞上 HTML 404 → 客户端无法确认这是个集合 → 报「文件夹似乎无效」。**密码框先弹、报错在其后**，
 * 与用户描述的顺序完全一致。
 *
 * 根路径那个 301（`app.get('/')`）救不了它：WebDAV 客户端从不用 GET 打开集合，第一步就是 PROPFIND。
 *
 * ## 本文件锁住的性质
 *
 * 1. **同结论**：凡 `OPTIONS` 宣告了 DAV 能力的入口路径，`PROPFIND` 就必须给 207 —— 不允许再出现
 *    「能力声明说支持、数据请求说不存在」这种自相矛盾。
 * 2. **不回落 HTML**：WebDAV 动词在任何路径上都不得返回 `text/html`（那是 Express 默认兜底的指纹，
 *    客户端拿到它无从判断，只会报一句与真实原因无关的话）。
 * 3. **边界不扩大**：只特判**正好等于** `/` 的根路径；`/foo`、`/davx` 仍须 404（FUN-06 的
 *    「挂载点之外不可读、不可写」不能被这次放宽撤销）。
 * 4. **写保护同步**：`/` 被当作挂载点之后，破坏性动词不能跟着被放行（`PUT`/`MKCOL` → 409、
 *    `DELETE` → 403、`LOCK` → 405）。
 * 5. **判据唯一**：源码里不得再出现手写的前缀判据（除 `reqPathToKey` 的「剥离前缀」那处 ——
 *    它回答的是「怎么把挂载前缀去掉」，不是「在不在挂载点内」）。
 *
 * ## 端口区间
 *
 * `node --test` 按 CPU 数并发跑文件，两个文件同时启动 WebDAV 且端口相撞会 EADDRINUSE
 * → `isRunning()` 为 false → 偶发失败。既有区间：audit9 18800-19099、audit10 18900-19199、
 * audit11 19100-19399、audit12 19600-19799、audit13 20400-20599。本文件取 20700-20899。
 *
 * ## GET 不在此文件内测
 *
 * GET 走 `gateway.readObject` → `cos.getObject({ Output })` 的**流式写回**（见 audit13 的桩
 * 里对 `opts.Output` 的处理）。本文件的桩只做对象枚举与存在性判断，不实现流式 Output，
 * 因此不对 GET 的响应体下断言；`GET /` 的 301 属重定向分支，不经网关，可以测。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'audit34-'));
process.env.COS_DATA_DIR = TMP;
process.env.WEBDAV_PORT = String(20700 + (process.pid % 200));

const cos = require(path.join(ROOT, 'server', 'cos.js'));
const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));

const BASE_CFG = {
  secretId: 'stub-id', secretKey: 'stub-key',
  bucket: 'audit34-bucket', region: 'ap-guangzhou', provider: 'tencent',
};

/** 内存云端：readme.txt 在根、docs/a.txt 在子目录 */
const OBJECTS = new Map([
  ['readme.txt', Buffer.from('hi')],
  ['docs/a.txt', Buffer.from('a')],
]);

function handleCloud(method, params) {
  switch (method) {
    case 'headObject':
      return OBJECTS.has(params.Key) ? { headers: { 'content-length': String(OBJECTS.get(params.Key).length) } } : null;
    case 'getBucket': {
      const prefix = params.Prefix || '';
      const contents = [];
      const common = new Set();
      for (const k of OBJECTS.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const i = rest.indexOf('/');
        if (i < 0) {
          if (rest) contents.push({ Key: k, Size: OBJECTS.get(k).length, LastModified: new Date().toISOString() });
        } else common.add(prefix + rest.slice(0, i + 1));
      }
      return {
        Contents: contents,
        CommonPrefixes: [...common].map((x) => ({ Prefix: x })),
        IsTruncated: 'false',
      };
    }
    default:
      return {};
  }
}

const fakeClient = {};
cos.getClient = () => fakeClient;
cos.p = async (client, method, params) => {
  const r = handleCloud(method, params || {});
  if (r === null) throw Object.assign(new Error('Not Found'), { statusCode: 404 });
  return r;
};
// cos.js 内部（listLevel 等）走 cos[method](params, cb) 的回调风格 —— 两条路径都要接
for (const m of ['headObject', 'getBucket', 'getObject', 'putObject', 'deleteObject']) {
  fakeClient[m] = (params, cb) => {
    const r = handleCloud(m, params || {});
    if (r === null) {
      return process.nextTick(() => cb(Object.assign(new Error('Not Found'), { statusCode: 404 })));
    }
    process.nextTick(() => cb(null, r));
  };
}

configStore.get = () => BASE_CFG;
configStore.effectiveForBucket = () => BASE_CFG;
configStore.getWebdav = () => ({ enabled: true, accounts: [{ id: 'a1', username: 'u' }] });
configStore.authenticateWebdav = async (u, p) =>
  (u === 'u' && p === 'p' ? { ok: true, account: { id: 'a1', username: 'u', role: 'admin' } } : { ok: false });
statsStore.addLog = () => {};
statsStore.trackBucket = () => {};

let dav = null;
let davPort = 0;
const AUTH = { Authorization: 'Basic ' + Buffer.from('u:p').toString('base64') };

function request(method, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1', port: davPort, path: urlPath, method,
      rejectUnauthorized: false, headers: Object.assign({}, AUTH, headers),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test.before(async () => {
  dav = require(path.join(ROOT, 'server', 'webdav-server.js'));
  await dav.apply();
  if (!dav.isRunning()) throw new Error('WebDAV 未能启动（端口被占用？）');
  davPort = Number(process.env.WEBDAV_PORT);
});

test.after(async () => {
  try { if (dav) await dav.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/* ================================================================== *
 * 1 · 挂载点判据是唯一实现点
 * ================================================================== */

test('R34 · 判据唯一实现点 `inMount`：`/` 与 `/dav` 同等，`/davx` 不得被误认为挂载点', () => {
  const m = dav.__inMount;
  assert.equal(typeof m, 'function', 'inMount 必须导出供测试直接驱动（与 __reqPathToKey 同例）');
  for (const p of ['/', '/dav', '/dav/', '/dav/a.txt', '/dav/dir/']) {
    assert.equal(m(p), true, `${p} 必须落在外挂载点内`);
  }
  for (const p of ['/foo', '/davx', '/dav-notes', '/other/dav', '']) {
    assert.equal(m(p), false, `${p} 必须**不**在挂载点内`);
  }
  // `/davx` 是刻意的一条：手写 `startsWith('/dav')` 会把它误判为挂载内，
  // 而 `reqPathToKey('/davx')` 剥掉前缀后得到 key `x` —— 一个「界面看不到、WebDAV 却能读」的幽灵命名空间。
  assert.equal(dav.__reqPathToKey('/davx'), 'davx', '前缀剥离只在整段匹配时应发生');
});

test('R34 · 源码内不得再出现手写的前缀判据（9 处分散正是根路径漏判的成因）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'webdav-server.js'), 'utf8');
  // 注释里允许提到历史写法（本文件头就在解释它），因此先剥注释只查代码
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const offenders = code.split('\n')
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter((x) => /startsWith\(\s*MOUNT\s*\)/.test(x.l));
  assert.deepEqual(
    offenders.map((x) => `${x.n}: ${x.l}`), [],
    '「是否在挂载点内」只允许经 inMount() 判断；strip 前缀的那处必须写成 slice/明确的前缀操作',
  );
});

/* ================================================================== *
 * 2 · 能力声明与数据请求必须同结论（本轮的核心性质）
 * ================================================================== */

test('R34 · 凡 OPTIONS 宣告 DAV 的入口，PROPFIND 必须给 207（根路径曾回 404）', async () => {
  for (const p of ['/', '/dav', '/dav/']) {
    const opt = await request('OPTIONS', p);
    assert.equal(opt.status, 200, `OPTIONS ${p} 应回 200`);
    assert.equal(opt.headers.dav, '1', `OPTIONS ${p} 必须宣告 DAV 能力（客户端的凭据框由它触发）`);

    const pf = await request('PROPFIND', p, { Depth: '0' });
    assert.equal(
      pf.status, 207,
      `${p}：OPTIONS 说「这里是 WebDAV」，PROPFIND 就必须给 207 —— 修复前 / 回的是 404 HTML，`
      + '客户端据此报「输入的文件夹似乎无效」',
    );
    assert.match(pf.text, /<D:multistatus/, `${p} 必须回合法 multistatus`);
  }
});

test('R34 · WebDAV 动词在任何路径上都不得回 text/html（Express 默认兜底的指纹）', async () => {
  const paths = ['/', '/dav', '/dav/', '/dav/missing.bin', '/foo', '/davx'];
  const methods = ['PROPFIND', 'OPTIONS'];
  for (const p of paths) {
    for (const method of methods) {
      const r = await request(method, p, { Depth: '0' });
      const ct = String(r.headers['content-type'] || '');
      assert.ok(
        !ct.includes('text/html'),
        `${method} ${p} 回了 text/html（${r.status}）—— 这是 express 默认兜底的指纹，`
        + '说明请求没有被任何 WebDAV 处理器接住',
      );
    }
  }
});

test('R34 · `OPTIONS *` 必须回 200 且带 DAV 头（RFC 4918 §9.1 的服务级能力探测）', async () => {
  const r = await request('OPTIONS', '*');
  assert.equal(r.status, 200, 'OPTIONS * 是服务级探测，不指向资源，不得被挂载点边界答成 404');
  assert.equal(r.headers.dav, '1', 'DAV 头必须出现在对 `*` 的 OPTIONS 响应上');
  assert.ok(String(r.headers.allow || '').includes('PROPFIND'), 'Allow 要与真正实现的动词同源');
});

/* ================================================================== *
 * 3 · 放宽的只有「读取入口」，边界与写保护不得跟着放宽
 * ================================================================== */

test('R34 · FUN-06 边界未被撤销：非挂载路径的每个动词都还是 404（且不是 HTML）', async () => {
  for (const p of ['/foo', '/davx', '/api/fs', '/other/dav']) {
    for (const method of ['GET', 'PUT', 'PROPFIND', 'MKCOL', 'DELETE', 'COPY', 'MOVE', 'LOCK']) {
      const r = await request(method, p);
      assert.equal(r.status, 404, `${method} ${p} 必须 404（挂载点之外不可读、不可写）`);
      assert.ok(
        String(r.headers['content-type'] || '').includes('text/plain'),
        `${method} ${p} 的 404 必须来自挂载点边界（text/plain），不是 Express 兜底`,
      );
    }
  }
});

test('R34 · `/` 被当作挂载点后，破坏性动词仍须被拒（不能只放宽读取）', async () => {
  const put = await request('PUT', '/');
  assert.equal(put.status, 409, 'PUT / 不得创建对象（根路径不是可写的 key）');

  const mkcol = await request('MKCOL', '/');
  assert.equal(mkcol.status, 409, 'MKCOL / 不得成功');

  const del = await request('DELETE', '/');
  assert.equal(del.status, 403, 'DELETE / 不得删除存储桶根');

  const lock = await request('LOCK', '/');
  assert.equal(lock.status, 405, 'LOCK 未实现，必须明确答 405 而不是落到 404');
});

test('R34 · 浏览器入口不受影响：`GET /` 仍是 301 跳转到挂载点', async () => {
  const r = await request('GET', '/');
  assert.equal(r.status, 301, 'get / 的 301 是给浏览器用的便利，不能被本次修复弄丢');
  assert.equal(r.headers.location, '/dav/', '必须跳到挂载点');
});

/* ================================================================== *
 * 4 · 根路径列举出来的子项仍用规范前缀，客户端据此可以继续解析
 * ================================================================== */

test('R34 · `PROPFIND /` Depth:1 的子项 href 仍落在 `/dav/` 命名空间', async () => {
  const r = await request('PROPFIND', '/', { Depth: '1' });
  assert.equal(r.status, 207);
  assert.match(r.text, /<D:href>\/dav\/docs\/<\/D:href>/, '子目录 href 必须是规范前缀（绝对路径，客户端可解析）');
  assert.match(r.text, /<D:href>\/dav\/readme\.txt<\/D:href>/, '子文件 href 同上');
  assert.equal(
    (r.text.match(/<D:response>/g) || []).length, 3,
    '根 + 1 目录 + 1 文件；少一个就说明列举被 / 的特判弄丢了分支',
  );
});
