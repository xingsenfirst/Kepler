/**
 * R30 护栏：Microsoft Azure Blob Storage 客户端（`server/azure-client.js`）
 *
 * 为什么用「**自己验签的假 Azure 服务**」而不是打桩：
 * Azure 的 Shared Key 签名是一串**字段顺序固定、少一段就 403** 的规范串，
 * 光看代码几乎不可能确认自己拼对了。这里起一个最小 Blob 服务，它按规范
 * **独立重算**每个请求的签名并与 `Authorization` 头逐字比对 —— 只要客户端在
 * 头部排序、空 `Content-Length`、查询参数解码、规范化资源（账户名取凭据而非主机名）
 * 任一处拼错，签名立刻对不上，测试当场变红。
 *
 * 覆盖：签名 / 列举 / 单传 / 分片（Block Blob，含断点续传）/ 复制（含异步轮询）/
 * 删除（幂等语义与白名单）/ ACL 映射 / Range / 流式 Output / SAS 预签名 /
 * 错误形状（statusCode + code）/ `request` 的 NotImplemented。
 *
 * ⚠️ **假服务的期望值必须来自规范，不能来自被测实现。** 第一版在 SAS 一处栽了：
 * 假服务把客户端的规范资源形态（缺 `/blob` 服务名）照抄了一份，于是「客户端签什么、
 * 服务端就认什么」—— 用例全绿而真实 Azure 必回 403。凡协议细节（规范串、URL 形态、
 * 主机名）都要按官方文档**写死**在测试里，并让假服务真的校验它。
 * 第 30 轮的缺陷检测（`AZ-01`~`AZ-05`）就是靠这条原则找出来的，见文件末尾的 6 组用例。
 */
const test = require('node:test');
const http = require('http');
const crypto = require('crypto');
const path = require('node:path');
const { PassThrough } = require('stream');
const { assert, assertEqual, ROOT } = require('./helpers');

const { AzureBlobClient } = require(path.join(ROOT, 'server', 'azure-client.js'));
const providers = require(path.join(ROOT, 'server', 'providers.js'));
const cos = require(path.join(ROOT, 'server', 'cos.js'));

const ACCOUNT = 'testaccount';
const KEY_BYTES = Buffer.from('kepler-azure-test-key-32-bytes!!', 'utf8');
const KEY_B64 = KEY_BYTES.toString('base64');
const API_VERSION = '2020-12-06';

/* ================================================================== *
 * 假 Azure Blob 服务：独立实现签名校验（不引用被测代码的任何拼接函数）
 * ================================================================== */

const WEAK = {};

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 规范串 → 签名（与 azure-client 的拼装逻辑**独立**，用于交叉验证） */
function signSharedKey(method, path, query, headers) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[String(k).toLowerCase()] = String(v == null ? '' : v).trim();
  const msHeaders = Object.keys(lower).filter((k) => k.startsWith('x-ms-')).sort()
    .map((k) => `${k}:${lower[k]}\n`).join('');
  /**
   * ⚠️ 查询值**不再解码**：`query` 来自 `URLSearchParams`（它已经把请求行解码过一次），
   * 而规范要的就是「解码后」的那个值。再解一次会让含字面 `%XX` 的值对不上
   * （见 AZ-04：客户端一度也犯同样的错，两侧同源 ⇒ 用例照绿）。
   */
  const q = Object.keys(query).sort()
    .map((k) => '\n' + k.toLowerCase() + ':' + String(query[k]))
    .join('');
  const canonicalizedResource = `/${ACCOUNT}${path}${q}`;
  const len = lower['content-length'];
  const stringToSign = [
    method.toUpperCase(),
    lower['content-encoding'] || '',
    lower['content-language'] || '',
    len && Number(len) > 0 ? String(len) : '',
    lower['content-md5'] || '',
    lower['content-type'] || '',
    lower['date'] || '',
    lower['if-modified-since'] || '',
    lower['if-match'] || '',
    lower['if-none-match'] || '',
    lower['if-unmodified-since'] || '',
    lower['range'] || '',
  ].join('\n') + '\n' + msHeaders + canonicalizedResource;
  return crypto.createHmac('sha256', KEY_BYTES).update(stringToSign, 'utf8').digest('base64');
}

/**
 * 服务 SAS 的规范串 —— **按官方规范写死**（`learn.microsoft.com` 《构造服务 SAS》）。
 *
 * ⚠️ 这里**绝不能**引用被测实现的任何片段或假设。第一版护栏就栽在这里：它照抄了客户端
 * 的规范资源（`/<账户><路径>`，缺 `/blob` 服务名、也没解码），于是「客户端签什么、
 * 服务端就认什么」，用例全绿而真实 Azure 必回 403。规范硬编码 + 下方 `specSasResource()`
 * 的形态断言，才让这条护栏真的能区分对错。
 */
function signServiceSas({ st, se, path }) {
  const stringToSign = ['r', st, se, specSasResource(path), '', '', '', API_VERSION, 'b', '', '', '', '', '', '', ''].join('\n');
  return crypto.createHmac('sha256', KEY_BYTES).update(stringToSign, 'utf8').digest('base64');
}

/** 官方口径的规范资源：`/blob/<账户>/<容器>[/<Blob>]`，且**必须 URL 解码** */
function specSasResource(encodedPath) {
  return `/blob/${ACCOUNT}${decodeURIComponent(encodedPath)}`;
}

/**
 * 启动假 Azure 服务。返回 `{ port, close, state, log, onRequest }`。
 * 端点用回环地址（真实 Azure 用 `https://<账户>.blob.core.windows.net`）——
 * 规范化资源仍取凭据里的账户名，这正是自定义域名场景的形态。
 *
 * @param {object} [opts]
 *  - `blockListCursor: true` 时让 `Get Block List` 的响应**多带一个 `NextMarker`**。
 *    真实 Azure 的该接口既没有翻页参数、响应里也没有该字段，这里是为了复现
 *    「服务端给了游标」这一形态（旧实现在此形态下会重复累加同一批分片）。
 */
function startFakeAzure(opts) {
  const o = opts || {};
  const blockListCursor = o.blockListCursor === true;
  const state = {
    containers: new Map(), // name -> { blobs: Map<key, {body, type, meta}>, blocks: Map<key, Map<blockId, Buffer>>, publicAccess: '' }
  };
  // 预置测试用容器：Azure 的容器在控制台创建，本客户端只负责对象级操作
  state.containers.set('c1', { blobs: new Map(), blocks: new Map(), publicAccess: '' });
  const log = [];
  let copyAsyncMs = 0; // >0 时复制先返回 pending（用于验证轮询）
  const assertContainer = (name) => {
    if (!state.containers.has(name)) state.containers.set(name, { blobs: new Map(), blocks: new Map(), publicAccess: '' });
    return state.containers.get(name);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const [rawPath, rawQs] = req.url.split('?');
      /**
       * ⚠️ 签名用的是**编码后**的路径（Azure 的 CanonicalizedResource 取请求行里的资源路径），
       * 因此这里必须保留原始（已编码）路径用于验签，另取一份解码版仅用于路由分发 ——
       * 曾经把解码后的路径拿去验签，于是任何含空格 / 中文的键都必然「签名不匹配」。
       */
      const signedPath = rawPath;
      const pathname = decodeURIComponent(rawPath);
      // 与 azure-client 的 URL 形态一致：/<容器>[/<键>]
      const segs = pathname.replace(/^\//, '').split('/');
      const container = segs.shift() || '';
      const key = segs.join('/');
      const query = {};
      for (const [k, v] of new URLSearchParams(rawQs || '')) query[k] = v;
      const headers = req.headers;
      log.push({ method: req.method, path: pathname, signedPath, query, headers, body: body.length });

      const send = (code, hdrs, payload) => {
        res.writeHead(code, Object.assign({ 'x-ms-request-id': 'fake' }, hdrs || {}));
        res.end(payload === undefined ? '' : payload);
      };
      // 真实 Azure 在错误响应里恒带 x-ms-error-code 头（HEAD 请求无响应体，只能靠它）
      const xmlError = (code, status, message) => send(status, {
        'Content-Type': 'application/xml', 'x-ms-error-code': code,
      }, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${xmlEsc(message || code)}</Message></Error>`);

      /* ---------- ① 预签名（SAS）请求：用查询里的 sig 校验，不查 Authorization ---------- */
      if (query.sig) {
        const st = query.st || '';
        const se = query.se || '';
        if (query.sv !== API_VERSION || query.sr !== 'b' || query.sp !== 'r') return xmlError('AuthenticationFailed', 403, 'SAS 参数不符');
        const want = signServiceSas({ st, se, path: signedPath });
        if (want !== query.sig) return xmlError('AuthenticationFailed', 403, 'SAS 签名不匹配');
        const c = state.containers.get(container);
        const b = c && c.blobs.get(key);
        if (!b) return xmlError('BlobNotFound', 404, 'SAS 指向的对象不存在');
        return send(200, { 'Content-Type': b.type || 'application/octet-stream', 'Content-Length': String(b.body.length) }, b.body);
      }

      /* ---------- ② 其余请求：Shared Key 验签 ---------- */
      const auth = String(headers.authorization || '');
      if (!auth.startsWith(`SharedKey ${ACCOUNT}:`)) return xmlError('AuthenticationFailed', 403, '缺少 Shared Key 授权头');
      if (headers['x-ms-version'] !== API_VERSION) return xmlError('InvalidHeaderValue', 400, 'x-ms-version 不符');
      const got = auth.slice(`SharedKey ${ACCOUNT}:`.length);
      const want = signSharedKey(req.method, signedPath, query, headers);
      if (got !== want) {
        WEAK.lastMismatch = { pathname, signedPath, query, got, want };
        return xmlError('AuthenticationFailed', 403, '签名不匹配');
      }
      // 验签通过即清除上一轮的记录 —— 否则一条历史的失败会污染后续用例的 `!WEAK.lastMismatch` 断言
      WEAK.lastMismatch = null;

      /* ---------- ③ 容器级 ---------- */
      if (query.comp === 'list' && !container) {
        const items = [...state.containers.keys()].map((n) =>
          `<Container><Name>${xmlEsc(n)}</Name><Properties><Last-Modified>2026-01-01T00:00:00.000Z</Last-Modified></Properties></Container>`).join('');
        return send(200, { 'Content-Type': 'application/xml' },
          `<?xml version="1.0"?><EnumerationResults ServiceEndpoint="https://${ACCOUNT}.blob.core.windows.net/"><Containers>${items}</Containers><NextMarker /></EnumerationResults>`);
      }
      if (query.restype === 'container' && query.comp === 'acl' && req.method === 'GET') {
        const c = state.containers.get(container);
        if (!c) return xmlError('ContainerNotFound', 404, '容器不存在');
        const h = { 'Content-Type': 'application/xml' };
        if (c.publicAccess) h['x-ms-blob-public-access'] = c.publicAccess;
        return send(200, h, '<?xml version="1.0"?><SignedIdentifiers />');
      }
      if (query.restype === 'container' && !query.comp && req.method === 'HEAD') {
        return state.containers.has(container) ? send(200, {}) : xmlError('ContainerNotFound', 404, '容器不存在');
      }
      if (query.restype === 'container' && !query.comp && req.method === 'DELETE') {
        if (!state.containers.has(container)) return xmlError('ContainerNotFound', 404, '容器不存在');
        state.containers.delete(container);
        return send(202, {});
      }
      if (query.restype === 'container' && query.comp === 'list') {
        const c = state.containers.get(container);
        if (!c) return xmlError('ContainerNotFound', 404, '容器不存在');
        const prefix = query.prefix || '';
        const max = Number(query.maxresults) || 5000;
        const all = [...c.blobs.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = query.marker ? all.indexOf(query.marker) + 1 : 0;
        const page = all.slice(start, start + max);
        const more = start + max < all.length;
        const blobs = page.map((k) => {
          const b = c.blobs.get(k);
          return `<Blob><Name>${xmlEsc(k)}</Name><Properties><Last-Modified>2026-01-01T00:00:00.000Z</Last-Modified>`
            + `<Etag>"etag-${xmlEsc(k)}"</Etag><Content-Length>${b.body.length}</Content-Length>`
            + `<Content-Type>${xmlEsc(b.type || 'application/octet-stream')}</Content-Type></Properties></Blob>`;
        }).join('');
        return send(200, { 'Content-Type': 'application/xml' },
          `<?xml version="1.0"?><EnumerationResults><Blobs>${blobs}</Blobs>`
          + `<NextMarker>${more ? xmlEsc(page[page.length - 1]) : ''}</NextMarker></EnumerationResults>`);
      }

      /* ---------- ④ 对象级 ---------- */
      const c = state.containers.get(container);
      if (!c) return xmlError('ContainerNotFound', 404, '容器不存在');

      // 块：上传 / 列表 / 提交
      if (query.comp === 'block' && req.method === 'PUT') {
        if (!c.blocks.has(key)) c.blocks.set(key, new Map());
        c.blocks.get(key).set(query.blockid, body);
        return send(201, {});
      }
      if (query.comp === 'blocklist' && req.method === 'GET') {
        const blocks = c.blocks.get(key) || new Map();
        const items = [...blocks.entries()].map(([id, buf]) => `<Block><Name>${id}</Name><Size>${buf.length}</Size></Block>`).join('');
        // 见 startFakeAzure 的 opts 说明：只在需要复现「响应带游标」时才加这一行
        const cursor = blockListCursor ? '<NextMarker>opaque-cursor-1</NextMarker>' : '';
        return send(200, { 'Content-Type': 'application/xml' },
          `<?xml version="1.0"?><BlockList><CommittedBlocks />${query.blocklisttype === 'uncommitted' ? `<UncommittedBlocks>${items}</UncommittedBlocks>` : ''}${cursor}</BlockList>`);
      }
      if (query.comp === 'blocklist' && req.method === 'PUT') {
        const text = body.toString('utf8');
        const ids = [...text.matchAll(/<(Latest|Uncommitted)>([^<]+)<\/\1>/g)].map((m) => m[2]);
        const blocks = c.blocks.get(key) || new Map();
        const parts = [];
        for (const id of ids) {
          if (!blocks.has(id)) return xmlError('InvalidBlockList', 400, `未知块 ${id}`);
          parts.push(blocks.get(id));
        }
        c.blobs.set(key, { body: Buffer.concat(parts), type: 'application/octet-stream', meta: {} });
        c.blocks.delete(key);
        return send(201, { ETag: '"committed"' });
      }

      // 复制
      if (req.method === 'PUT' && headers['x-ms-copy-source']) {
        const src = String(headers['x-ms-copy-source']);
        const srcUrl = new URL(src);
        /**
         * AZ-02：复制源**必须指向本服务自己**。
         *
         * 真实 Azure 只接受指向该账户端点的源 URL。本项目允许用户覆盖端点（主权云 / Azurite），
         * 客户端若把源 URL 硬拼成公有云域名（`<账户>.blob.core.windows.net`），请求就会打到
         * 一台**不属于该账户**的主机 —— 而「端点被覆盖时复制仍然正确」这件事，只有在假服务
         * 校验主机名时才测得到：旧护栏只取 `pathname`，换任何主机都照样返回成功（假绿）。
         */
        if (srcUrl.host !== `127.0.0.1:${server.address().port}`) {
          return xmlError('CannotVerifyCopySource', 404, `复制源主机不是本服务：${srcUrl.host}`);
        }
        const srcSegs = decodeURIComponent(srcUrl.pathname).replace(/^\//, '').split('/');
        const srcContainer = srcSegs.shift();
        const srcKey = srcSegs.map(decodeURIComponent).join('/');
        const sc = state.containers.get(srcContainer);
        const sb = sc && sc.blobs.get(srcKey);
        if (!sb) return xmlError('CannotVerifyCopySource', 404, '复制源不存在');
        if (copyAsyncMs > 0 && !headers['x-ms-requires-sync']) {
          c.blobs.set(key, { body: Buffer.alloc(0), type: sb.type, meta: {}, copyPending: Date.now() + copyAsyncMs, copyBody: sb.body });
          return send(202, { 'x-ms-copy-status': 'pending' });
        }
        c.blobs.set(key, { body: sb.body, type: sb.type, meta: Object.assign({}, sb.meta) });
        return send(202, { 'x-ms-copy-status': 'success' });
      }

      // 普通对象
      if (req.method === 'PUT') {
        const meta = {};
        for (const [k, v] of Object.entries(headers)) if (k.startsWith('x-ms-meta-')) meta[k.slice('x-ms-meta-'.length)] = String(v);
        c.blobs.set(key, { body, type: String(headers['content-type'] || 'application/octet-stream'), meta });
        return send(201, { ETag: '"put"' });
      }
      if (req.method === 'HEAD') {
        const b = c.blobs.get(key);
        if (!b) return xmlError('BlobNotFound', 404, '对象不存在');
        if (b.copyPending) {
          if (Date.now() >= b.copyPending) {
            c.blobs.set(key, { body: b.copyBody, type: b.type, meta: b.meta });
            return send(200, { 'Content-Length': String(b.copyBody.length), 'x-ms-copy-status': 'success' });
          }
          return send(200, { 'x-ms-copy-status': 'pending' });
        }
        const h = {
          'Content-Length': String(b.body.length),
          'Content-Type': b.type,
          ETag: '"head"',
          'Last-Modified': 'Wed, 01 Jan 2026 00:00:00 GMT',
        };
        for (const [k, v] of Object.entries(b.meta || {})) h['x-ms-meta-' + k] = String(v);
        return send(200, h);
      }
      if (req.method === 'GET') {
        const b = c.blobs.get(key);
        if (!b) return xmlError('BlobNotFound', 404, '对象不存在');
        if (headers.range) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(String(headers.range));
          if (m) {
            const s = Number(m[1]); const e = Math.min(Number(m[2]), b.body.length - 1);
            if (s >= b.body.length) return xmlError('InvalidRange', 416, '范围不合法');
            const slice = b.body.subarray(s, e + 1);
            return send(206, {
              'Content-Type': b.type,
              'Content-Length': String(slice.length),
              'Content-Range': `bytes ${s}-${e}/${b.body.length}`,
            }, slice);
          }
        }
        return send(200, { 'Content-Type': b.type, 'Content-Length': String(b.body.length) }, b.body);
      }
      if (req.method === 'DELETE') {
        // 用一个固定名字模拟「云端拒绝删除」（对象锁 / 保留策略），用于验证白名单纪律
        if (key === 'forbidden.txt') return xmlError('AuthorizationPermissionMismatch', 403, '云端拒绝删除该对象');
        if (!c.blobs.has(key)) return xmlError('BlobNotFound', 404, '对象不存在');
        c.blobs.delete(key);
        return send(202, {});
      }
      return xmlError('UnsupportedOperation', 400, '未实现的假接口');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        state, log,
        /** 预置一个容器（Azure 的容器由控制台或 Create Container 创建，本客户端不负责建容器） */
        createContainer: (name, publicAccess) => {
          state.containers.set(name, {
            blobs: new Map(), blocks: new Map(), publicAccess: publicAccess || '',
          });
        },
        setCopyAsync: (ms) => { copyAsyncMs = ms; },
        /**
         * AZ-05：预置一个「**别的会话**留下的块」（块名里的令牌与本会话不同）。
         * 真实 Azure 的未提交块挂在目标对象上、取消掉的上传其块最长留存 7 天，
         * 且没有按会话区分的枚举接口 —— 这就是「跨会话混入」在云端的样子。
         */
        seedBlock: (container, key, blockName, buf) => {
          const c = assertContainer(container);
          if (!c.blocks.has(key)) c.blocks.set(key, new Map());
          c.blocks.get(key).set(Buffer.from(blockName, 'utf8').toString('base64'), buf || Buffer.alloc(4));
        },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 起一个连到假服务的客户端 */
function clientFor(port, extra) {
  return new AzureBlobClient(Object.assign({
    accountName: ACCOUNT, accountKey: KEY_B64, bucket: 'c1', endpoint: `http://127.0.0.1:${port}`,
  }, extra || {}));
}

/** 把回调风格包成 Promise，便于断言 */
function call(obj, method, params) {
  return new Promise((resolve, reject) => obj[method](params, (e, d) => (e ? reject(e) : resolve(d))));
}

/* ================================================================== *
 * 1 · 签名与端点
 * ================================================================== */

test('R30 · 端点由存储账户名推导，且账户名字符集受严格约束', () => {
  assertEqual(providers.get('azure').kind, 'azure', 'azure 必须登记为独立协议类型（不能是 planned / s3）');
  assertEqual(providers.isSupported('azure'), true, 'azure 必须被判定为已支持');
  assertEqual(providers.endpointRequired('azure'), false, 'azure 的端点栏是可选覆盖口，不得判为必填');
  assertEqual(providers.endpointForAccount('azure', 'myaccount'), 'https://myaccount.blob.core.windows.net',
    '端点必须由账户名拼成（唯一实现点）');
  for (const bad of ['evil.com/x', 'ab', 'A'.repeat(25), 'my account', 'my_account', 'a/b']) {
    let threw = false;
    try { providers.endpointForAccount('azure', bad); } catch (e) { threw = true; }
    assert(threw, `R30：账户名「${bad}」必须被拒绝 —— 它会被直接拼进主机名，放行即等于盲 SSRF`);
  }
  assertEqual(providers.endpointForAccount('tencent', 'AKIDx'), '',
    'R30：未登记账户名模板的厂商不得因此报错（返回空串）');
});

test('R30 · 每个请求的 Shared Key 签名必须被服务端（独立实现）验签通过', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    // 覆盖：无体 GET、带体 PUT、带查询参数、带 Range、带自定义头
    await call(c, 'getService', {});
    await call(c, 'putObject', { Bucket: 'c1', Key: 'a.txt', Body: Buffer.from('hello'), ContentLength: 5 });
    await call(c, 'getObject', { Bucket: 'c1', Key: 'a.txt', Output: new PassThrough() });
    await call(c, 'headObject', { Bucket: 'c1', Key: 'a.txt' });
    await call(c, 'getBucket', { Bucket: 'c1', Prefix: '', Delimiter: '', Marker: '', MaxKeys: 100 });
    const bad = WEAK.lastMismatch;
    assert(!bad, `R30：所有请求都必须通过验签；最近一次不匹配：${JSON.stringify(bad)}`);
  } finally {
    await fake.close();
  }
});

test('R30 · 规范化资源取「凭据里的账户名」而不是主机名（自定义域名 / 回环端点下同样成立）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port); // 端点是 127.0.0.1，主机名里没有账户名
  try {
    await call(c, 'headBucket', { Bucket: 'c1' }).catch(() => {});
    const auth = String(fake.log[fake.log.length - 1].headers.authorization || '');
    assert(auth.startsWith(`SharedKey ${ACCOUNT}:`), 'Authorization 必须用凭据里的账户名');
    // 服务端用同一份规则验签（见 signSharedKey 里的 `/account + path`）——已通过则说明一致
    assert(!WEAK.lastMismatch, 'R30：自定义域名端点下签名仍必须匹配（账户名不来自主机名）');
  } finally {
    await fake.close();
  }
});

/* ================================================================== *
 * 2 · 列举 / 单传 / 下载 / 删除
 * ================================================================== */

test('R30 · 列举容器与对象：返回 COS/S3 同名同义的形状，翻页游标可直接回传', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    await call(c, 'putObject', { Bucket: 'c1', Key: 'a/1.txt', Body: Buffer.from('x') });
    await call(c, 'putObject', { Bucket: 'c1', Key: 'a/2.txt', Body: Buffer.from('yy') });
    await call(c, 'putObject', { Bucket: 'c1', Key: 'b.txt', Body: Buffer.from('zzz') });

    const svc = await call(c, 'getService', {});
    assertEqual(svc.Buckets.map((x) => x.Name).join(','), 'c1', 'getService 必须列出容器');
    assert(svc.Buckets[0].Region, 'R30：容器必须带非空 Region —— 否则 /config/verify 会报「未找到存储桶」');

    const page1 = await call(c, 'getBucket', { Bucket: 'c1', Prefix: '', Delimiter: '', Marker: '', MaxKeys: 2 });
    assertEqual(page1.Contents.length, 2, '单页条数受 MaxKeys 约束');
    assertEqual(page1.IsTruncated, 'true', '还有下一页时 IsTruncated 必须是字符串 true');
    assert(page1.NextMarker, 'R30：被截断时必须给出可回传的游标（Azure 的 marker 是不透明值，不能靠末键回退）');
    const page2 = await call(c, 'getBucket', { Bucket: 'c1', Prefix: '', Delimiter: '', Marker: page1.NextMarker, MaxKeys: 2 });
    assertEqual(page2.IsTruncated, 'false', '翻到末页后必须结束');
    const all = [...page1.Contents, ...page2.Contents].map((x) => x.Key);
    assertEqual(all.length, 3, '两页合计应取到全部 3 个对象');
    assert(page1.Contents[0].Size > 0 && page1.Contents[0].LastModified && page1.Contents[0].ETag,
      '每条必须带 Size / LastModified / ETag（上层列表与搜索都读它们）');
  } finally {
    await fake.close();
  }
});

test('R30 · 单传 / HEAD（小写 headers + x-ms-meta 映射）/ Range / 流式 Output', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    const body = Buffer.from('0123456789');
    await call(c, 'putObject', {
      Bucket: 'c1', Key: 'k.txt', Body: body,
      Headers: { 'x-cos-meta-file-mtime': '1700000000' },
    });
    const head = await call(c, 'headObject', { Bucket: 'c1', Key: 'k.txt' });
    assertEqual(head.headers['content-length'], '10', 'headObject 必须给小写 headers（上层只认这个形状）');
    assert(head.headers.etag, 'etag 必须存在（WebDAV / 下载判据都读它）');
    assertEqual(head.headers['x-cos-meta-file-mtime'], '1700000000',
      'R30：Azure 的 x-ms-meta-* 必须映射回 x-cos-meta-*，上层才能无差别读取');

    // 流式：Output 必须被写入并 end
    // ⚠️ 回调在**响应头到达时**就返回（与 s3-client 同语义：调用方自己消费流），
    //    因此这里必须等 `end` 而不是等回调，否则断言会跑在数据到达之前。
    const pass = new PassThrough();
    const got = [];
    pass.on('data', (d) => got.push(d));
    await new Promise((resolve, reject) => {
      pass.on('end', resolve);
      pass.on('error', reject);
      c.getObject({ Bucket: 'c1', Key: 'k.txt', Output: pass }, (e) => { if (e) reject(e); });
    });
    assertEqual(Buffer.concat(got).toString(), '0123456789', '流式下载必须完整送达并 end');

    // Range：Azure 必须真的按区间返回（上层据此合成 206 与 Content-Length）
    const ranged = await call(c, 'getObject', { Bucket: 'c1', Key: 'k.txt', Range: 'bytes=2-5' });
    assertEqual(ranged.statusCode, 206, 'Range 请求应得到 206');
    assertEqual(ranged.Body.toString(), '2345', 'Range 正文必须是所请求的区间');
  } finally {
    await fake.close();
  }
});

test('R30 · 删除：批量删除合成白名单 Deleted / Error（不存在的对象按幂等算已删）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    await call(c, 'putObject', { Bucket: 'c1', Key: 'gone.txt', Body: Buffer.from('x') });
    await call(c, 'putObject', { Bucket: 'c1', Key: 'forbidden.txt', Body: Buffer.from('y') });
    const r = await call(c, 'deleteMultipleObject', {
      Bucket: 'c1', Objects: [{ Key: 'gone.txt' }, { Key: 'never-existed.txt' }, { Key: 'forbidden.txt' }],
    });
    const deleted = r.Deleted.map((x) => x.Key).sort();
    assertEqual(deleted.join(','), 'gone.txt,never-existed.txt',
      'R30：确认删除的与「本来就不存在」的都必须进 Deleted（与 S3 DeleteObjects 的幂等语义一致）；'
      + '上层用这份白名单决定能否清加密元数据 / 标记分享链接失效');
    assertEqual(r.Error.map((x) => x.Key).join(','), 'forbidden.txt',
      'R30：云端拒绝删除的**绝不能**出现在 Deleted 里（那会清掉仍在的密文的解密凭据，不可逆）');
    assert(r.Error[0].Code, 'R30：错误项必须带 Code，便于上层日志定位');
  } finally {
    await fake.close();
  }
});

/* ================================================================== *
 * 3 · 分片（Block Blob）
 * ================================================================== */

test('R30 · 分片上传：块名定宽、提交按序、断点续传可由块列表恢复', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    const init = await call(c, 'multipartInit', { Bucket: 'c1', Key: 'big.bin' });
    assert(init.UploadId, 'R30：Azure 没有 UploadId 握手，但上层要存一个会话令牌，必须给出非空值');

    const parts = [Buffer.from('AAA'), Buffer.from('BBB'), Buffer.from('CC')];
    const etags = [];
    for (let i = 0; i < parts.length; i++) {
      const r = await call(c, 'multipartUpload', {
        Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId, PartNumber: i + 1,
        Body: parts[i], ContentLength: parts[i].length,
      });
      assert(r.ETag, `R30：第 ${i + 1} 片必须回非空 ETag（上层会把它记进上传会话）`);
      etags.push(r.ETag);
    }

    // 断点续传：由块列表恢复出分片号与尺寸
    const lp = await call(c, 'multipartListPart', { Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId });
    const restored = lp.ListPartsResult.Part;
    assertEqual(restored.map((x) => x.PartNumber).join(','), '1,2,3', '块列表必须能还原分片号（提交顺序依赖它）');
    assertEqual(restored.map((x) => x.Size).join(','), '3,3,2', '块尺寸必须如实回报（断点续传的进度依赖它）');

    await call(c, 'multipartComplete', {
      Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId,
      Parts: restored.map((x) => ({ PartNumber: x.PartNumber, ETag: x.ETag })).reverse(), // 故意乱序
    });
    const out = await call(c, 'getObject', { Bucket: 'c1', Key: 'big.bin' });
    assertEqual(out.Body.toString(), 'AAABBBCC', '提交必须按 PartNumber 排序，而不是按入参顺序');

    // 中止：不得抛错（上层是 fire-and-forget 调用）
    await call(c, 'multipartAbort', { Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId });
  } finally {
    await fake.close();
  }
});

/**
 * R30 收尾复核抓出的真实缺陷（旧实现会重复累加同一批分片）。
 *
 * `Get Block List` 请求参数只有 `comp` / `blocklisttype` / `timeout` / `snapshot` /
 * `versionid`，**没有翻页参数**，响应里也没有 `NextMarker`。旧实现却写了一个 `marker`
 * 循环，而 `marker` **从未进入请求**（`if (marker) query['blocklisttype'] = 'uncommitted'`
 * 是个空操作，该值本来就是它）——于是只要服务端回了游标，第二圈就会原样重取第一页、
 * 把同一批分片再记一次（实测 `[1,2,1,2]`）。
 *
 * 为什么必须钉住：`routes/fs.js` 的续传闸门用 `Σ size` 当「已落云、不必再计入配额」的
 * 字节数，重复项会把它翻倍，`netAdd = size - already` 被低估（可低到 0）⇒ **放松配额
 * 判定**。方向是 fail-open，所以不能只靠「真实 Azure 不会回游标」来兜。
 *
 * 两条对照都断言：① 正常响应（无游标）必须还原出分片号；② 带游标的响应既不得重复
 * 累加，也不得**多打一次请求**（多打的那次只会拿到同一页）。
 */
test('R30 · 断点续传：块列表响应带游标时不得重复累加分片（Get Block List 无翻页参数）', async () => {
  const run = async (blockListCursor) => {
    const fake = await startFakeAzure({ blockListCursor });
    const c = clientFor(fake.port);
    const countBlockList = () => fake.log.filter((r) => r.query.comp === 'blocklist').length;
    try {
      const init = await call(c, 'multipartInit', { Bucket: 'c1', Key: 'big.bin' });
      for (const n of [1, 2]) {
        await call(c, 'multipartUpload', {
          Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId, PartNumber: n, Body: Buffer.alloc(16),
        });
      }
      const before = countBlockList();
      const lp = await call(c, 'multipartListPart', { Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId });
      return {
        nums: lp.ListPartsResult.Part.map((x) => x.PartNumber).join(','),
        requests: countBlockList() - before,
      };
    } finally {
      await fake.close();
    }
  };

  const normal = await run(false); // 正向对照：服务端按真实契约作答
  assertEqual(normal.nums, '1,2', 'R30：正常块列表必须还原出分片号（提交顺序依赖它）');
  assertEqual(normal.requests, 1, 'R30：无游标时只应发一次请求');

  const withCursor = await run(true); // 反例：服务端多给了一个游标
  assertEqual(withCursor.nums, '1,2',
    'R30：带游标的响应不得让同一批分片被累加两次（旧实现返回 1,2,1,2 —— 重复项会让'
    + 'routes/fs.js 的「已落云字节」翻倍，从而放松配额判定）');
  assertEqual(withCursor.requests, 1,
    'R30：Get Block List 没有翻页参数，只允许发一次请求（再发一次只会拿到同一页）');
});

/* ================================================================== *
 * 4 · 复制（Azure 是异步的）
 * ================================================================== */

test('R30 · 复制：同步返回成功即可；异步（pending）时必须轮询到终态才 resolve', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    await call(c, 'putObject', { Bucket: 'c1', Key: 'src.txt', Body: Buffer.from('payload') });
    // 同步复制
    await call(c, 'putObjectCopy', { Bucket: 'c1', Key: 'dst-sync.txt', CopySource: '/c1/src.txt' });
    const a = await call(c, 'getObject', { Bucket: 'c1', Key: 'dst-sync.txt' });
    assertEqual(a.Body.toString(), 'payload', '同步复制必须立刻可见');

    // AZ-02：复制源必须是**本客户端自己的端点**（假服务会拒绝指向别的主机的源 URL）
    const copyReq = fake.log.find((r) => r.headers['x-ms-copy-source']);
    assert(copyReq, '必须发出过 Put Copy');
    assertEqual(new URL(String(copyReq.headers['x-ms-copy-source'])).host, `127.0.0.1:${fake.port}`,
      'AZ-02：x-ms-copy-source 必须与自身端点同源 —— 硬拼公有云域名在主权云 / Azurite 上必然失败');

    // 异步复制：服务端先回 pending，客户端必须轮询到 success 才返回
    fake.setCopyAsync(300);
    const t0 = Date.now();
    // 这里显式传绝对 URL（本服务自己的地址）：一是覆盖「已是 URL 则原样透传」，
    // 二是覆盖 `RequiresSync: false` 这条分支。注意**不能**写别的主机 ——
    // 假服务按 AZ-02 会校验复制源必须指向本服务（真实 Azure 同样只接受本账户端点）。
    await call(c, 'putObjectCopy', {
      Bucket: 'c1', Key: 'dst-async.txt',
      CopySource: `http://127.0.0.1:${fake.port}/c1/src.txt`, RequiresSync: false,
    });
    const waited = Date.now() - t0;
    assert(waited >= 250, `R30：pending 时必须轮询到终态再返回（否则上层会立刻删源，数据丢失）；实际等待 ${waited}ms`);
    const b = await call(c, 'getObject', { Bucket: 'c1', Key: 'dst-async.txt' });
    assertEqual(b.Body.toString(), 'payload', '轮询结束后目标必须已就绪');
  } finally {
    await fake.close();
  }
});

test('R30 · copySource() 必须给 Azure 用 S3 那套 /容器/键 形式（绝不能落进 COS 外链分支）', () => {
  const src = cos.copySource('azure', 'mycontainer', 'auto', 'dir/a b.txt');
  assertEqual(src, '/mycontainer/dir/a%20b.txt',
    'R30：Azure 的 CopySource 由客户端拼成绝对 URL，copySource() 只提供路径形式；'
    + '落进 `<桶>.cos.<地域>.myqcloud.com/…` 分支会让复制必然失败');
  assert(!src.includes('myqcloud'), 'R30：Azure 不得走 COS 外链域名分支');
});

/* ================================================================== *
 * 5 · ACL / 预签名 / request
 * ================================================================== */

test('R30 · ACL：blob / container 公开级别映射为 public-read，缺失即 private（Azure 无匿名写）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  const evalBucketAcl = (aclData) => {
    const grants = (aclData && aclData.Grants) || [];
    let allRead = false, allWrite = false;
    for (const g of grants) {
      const uri = (g && g.Grantee && g.Grantee.URI) || '';
      if (!uri.includes('global/AllUsers')) continue;
      const perm = String(g.Permission || '').toUpperCase();
      if (perm === 'FULL_CONTROL' || perm === 'WRITE') { allWrite = true; allRead = true; }
      else if (perm === 'READ') allRead = true;
    }
    if (allWrite) return 'public-read-write';
    if (allRead) return 'public-read';
    return 'private';
  };
  try {
    await call(c, 'headBucket', { Bucket: 'c1' }).catch(() => {});
    fake.state.containers.get('c1').publicAccess = '';
    assertEqual(evalBucketAcl(await call(c, 'getBucketAcl', { Bucket: 'c1' })), 'private', '无公开级别即私有');
    fake.state.containers.get('c1').publicAccess = 'blob';
    assertEqual(evalBucketAcl(await call(c, 'getBucketAcl', { Bucket: 'c1' })), 'public-read', 'blob 级别 = 匿名可读');
    fake.state.containers.get('c1').publicAccess = 'container';
    const acl = await call(c, 'getBucketAcl', { Bucket: 'c1' });
    assertEqual(evalBucketAcl(acl), 'public-read', 'container 级别 = 匿名可读 + 可列目录');
    assertEqual(acl.Grants.some((g) => String(g.Permission).toUpperCase() === 'WRITE'), false,
      'R30：Azure 不存在匿名写，绝不能映射出 public-read-write（否则会把私有桶误报成高危）');
  } finally {
    await fake.close();
  }
});

test('R30 · 预签名：SAS 直链必须能被服务端验签，且指向正确的容器与键', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    await call(c, 'putObject', { Bucket: 'c1', Key: 'dir/a b.txt', Body: Buffer.from('sas-payload') });
    const { Url } = c.getObjectUrl({ Bucket: 'c1', Key: 'dir/a b.txt', Sign: true, Expires: 600 });
    assert(/[?&]sv=/.test(Url) && /[?&]sig=/.test(Url), 'R30：必须带 sv 与 sig');
    assert(Url.includes('/c1/dir/a%20b.txt?'), `R30：路径必须逐段编码且不含主机名外的账户段，实际 ${Url}`);
    // 关键一步：拿这个 URL 去请求假服务，由服务端**重算 SAS 签名**校验
    const res = await fetch(Url);
    assertEqual(res.status, 200, `R30：SAS 直链必须被服务端接受（签名不符即 403），实际 ${res.status}`);
    assertEqual(await res.text(), 'sas-payload', 'SAS 直链必须取到对象内容');
  } finally {
    await fake.close();
  }
});

test('R30 · request（容量统计接口）必须显式报 NotImplemented，让上层回退到列举统计', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    let err = null;
    await call(c, 'request', { Method: 'GET', Bucket: 'c1', action: 'stats' }).catch((e) => { err = e; });
    assert(err, 'R30：request 不存在会让 cos[\'request\'] 变成 TypeError，必须显式实现并抛 NotImplemented');
    assertEqual(err.code, 'NotImplemented', 'code 必须是 NotImplemented');
    assertEqual(err.statusCode, 501, 'statusCode 必须是 501，translateError 才能给出「当前服务商不支持该操作」');
    const t = cos.translateError(err);
    assertEqual(t.message, '当前服务商不支持该操作', '错误必须被翻译成用户可读文案');
  } finally {
    await fake.close();
  }
});

test('R30 · 错误必须带 statusCode + code（六个调用点据此分类，包括「资源不存在」与 WebDAV 回显）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    let err = null;
    await call(c, 'headObject', { Bucket: 'c1', Key: 'missing' }).catch((e) => { err = e; });
    assertEqual(err.statusCode, 404, 'R30：404 必须原样透出（share-routes 的 isNotFound 只看 statusCode===404 与少数 code）');
    assertEqual(err.code, 'BlobNotFound', 'code 应保留 Azure 侧的错误码');
    const t = cos.translateError(err);
    assertEqual(t.message, '资源不存在：对象或存储桶不存在', '404 必须被翻译成「资源不存在」');
    assertEqual(t.status, 404, '上游 404 透传为 404');
  } finally {
    await fake.close();
  }
});

/* ================================================================== *
 * 6 · 第 30 轮缺陷检测（AZ-01 ~ AZ-05）
 *
 * 这一组用例的**期望值全部按官方规范写死**（不引用被测实现的任何片段）。原因见文件头：
 * 上一版的假服务在 SAS 一处照抄了客户端的错误假设，于是协议拼错而用例全绿。
 * ================================================================== */

/**
 * AZ-01 · 服务 SAS 的规范资源形态 —— 先自检**测试自己的期望值**。
 *
 * 这条不碰客户端：它把「规范要求什么」钉在护栏里。若有人为了让用例通过而把假服务改回
 * 客户端的旧形态（缺 `/blob`），这条会先红 —— 假服务与规范之间的绑定不再靠注释。
 */
test('AZ-01 · SAS 规范资源必须是官方形态 /blob/<账户>/<容器>[/<Blob>]，且须 URL 解码', () => {
  assertEqual(specSasResource('/c1/plain.txt'), '/blob/testaccount/c1/plain.txt',
    'AZ-01：2015-02-21 起规范资源必须带服务名 /blob（缺了就必然 403 AuthenticationFailed）');
  assertEqual(specSasResource('/c1/dir/a%20b.txt'), '/blob/testaccount/c1/dir/a b.txt',
    'AZ-01：规范要求字段必须 URL 解码 —— 签的必须是解码后的路径');
  assert(specSasResource('/c1/plain.txt') !== '/testaccount/c1/plain.txt',
    'AZ-01：不得退化成「不带服务名」的独占授权形态（两者不是同一套规则）');
});

/**
 * AZ-01 · 端到端：键里同时含**需要编码的字符**与**字面 `%20`** 时，预签名直链仍须通过验签。
 *
 * 这一条同时覆盖 AZ-01 的两处错误：① 规范资源缺 `/blob`；② 用编码后的路径去签（未解码）。
 * 键 `dir/a%20b c.txt` 的编码形态是 `a%2520b%20c`，正是能区分「签解码值」与「签编码值」的样本。
 */
test('AZ-01 · 预签名直链：含字面 %XX 与空格的键也必须被服务端（按规范）验签通过', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    const key = 'dir/a%20b c.txt';
    await call(c, 'putObject', { Bucket: 'c1', Key: key, Body: Buffer.from('sas-needle') });
    const { Url } = c.getObjectUrl({ Bucket: 'c1', Key: key, Sign: true, Expires: 600 });
    assert(Url.includes('/c1/dir/a%2520b%20c.txt?'),
      `AZ-01：URL 里的路径必须是逐段编码后的形态，实际 ${Url}`);
    const res = await fetch(Url);
    assertEqual(res.status, 200,
      `AZ-01：直链必须被服务端接受（403 即签名与规范不符 —— 缺 /blob 或未解码）`);
    assertEqual(await res.text(), 'sas-needle', 'AZ-01：直链必须取到对象内容');
  } finally {
    await fake.close();
  }
});

test('AZ-02 · 复制源 URL 必须跟随客户端自己的端点（协议 + 主机 + 路径前缀），而不是硬拼公有云域名', () => {
  const mk = (endpoint) => new AzureBlobClient({
    accountName: 'myaccount', accountKey: KEY_B64, bucket: 'c1', endpoint,
  });
  const cases = [
    ['https://myaccount.blob.core.windows.net', 'https://myaccount.blob.core.windows.net/c1/big.bin', '公有云'],
    ['https://myaccount.blob.core.chinacloudapi.cn', 'https://myaccount.blob.core.chinacloudapi.cn/c1/big.bin', 'Azure 中国（主权云）'],
    ['http://127.0.0.1:10000/devstoreaccount1', 'http://127.0.0.1:10000/devstoreaccount1/c1/big.bin', 'Azurite（带路径前缀）'],
  ];
  for (const [endpoint, want, label] of cases) {
    assertEqual(mk(endpoint)._copySourceUrl('/c1/big.bin'), want,
      `AZ-02：${label} 下复制源必须与自身端点同源 —— 硬拼公有云域名会让复制 / 移动 / 重命名与`
      + 'WebDAV COPY·MOVE 打到不属于该账户的主机上（表现为 CannotVerifyCopySource）');
  }
  assertEqual(mk(cases[0][0])._copySourceUrl('https://x.example/a/b'), 'https://x.example/a/b',
    'AZ-02：已经是绝对 URL 的原样透传（上层可能直接给 URL）');
});

test('AZ-03 · 删除不存在的对象必须成功（与 S3/COS 的幂等语义、以及本文件批删口径一致）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    // 正向对照：对象存在时必须真的被删掉（否则守卫会退化成"什么都不做"）
    await call(c, 'putObject', { Bucket: 'c1', Key: 'here.txt', Body: Buffer.from('x') });
    await call(c, 'deleteObject', { Bucket: 'c1', Key: 'here.txt' });
    assertEqual(fake.state.containers.get('c1').blobs.has('here.txt'), false, 'AZ-03：存在时必须真的删掉');

    let gone = null;
    await call(c, 'deleteObject', { Bucket: 'c1', Key: 'never-existed.txt' }).catch((e) => { gone = e; });
    assertEqual(gone, null,
      'AZ-03：对象本就不存在 = 已达成删除，不得抛错 —— 否则 WebDAV DELETE 重试会由成功变报错，'
      + '而 S3 / COS 两家都是成功（同一份客户端里单删与批删也必须同口径）');

    let noContainer = null;
    await call(c, 'deleteObject', { Bucket: 'no-such-container', Key: 'x.txt' }).catch((e) => { noContainer = e; });
    assertEqual(noContainer, null, 'AZ-03：容器不存在同理（ContainerNotFound 也按已达成删除处理）');

    // 反例：云端明确拒绝（403）仍必须抛出 —— 幂等只对"不存在"成立，不能把"不确定"当"已删除"
    let hard = null;
    await call(c, 'deleteObject', { Bucket: 'c1', Key: 'forbidden.txt' }).catch((e) => { hard = e; });
    assert(hard, 'AZ-03：云端拒绝删除时仍必须抛出（否则上层会去清仍在的密文的解密凭据，不可逆）');
    assertEqual(hard.statusCode, 403, 'AZ-03：403 必须原样透出');
  } finally {
    await fake.close();
  }
});

test('AZ-04 · 列举的签名不得对查询值重复解码（前缀含字面 %XX 时也必须通过验签）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    await call(c, 'putObject', { Bucket: 'c1', Key: 'a%20b/x.txt', Body: Buffer.from('x') });
    const page = await call(c, 'getBucket', {
      Bucket: 'c1', Prefix: 'a%20b/', Delimiter: '', Marker: '', MaxKeys: 100,
    });
    assert(!WEAK.lastMismatch,
      `AZ-04：查询值在签名里必须原样使用（服务端解出的就是它）；再解一次会把 a%20b 变成 a b ⇒ 403。`
      + `最近一次不匹配：${JSON.stringify(WEAK.lastMismatch)}`);
    assertEqual(page.Contents.map((x) => x.Key).join(','), 'a%20b/x.txt',
      'AZ-04：前缀必须原样送达（被解成 "a b/" 就取不到任何对象）');
  } finally {
    await fake.close();
  }
});

/**
 * AZ-05 · 块列表只认**本会话**的块。
 *
 * Azure 的未提交块挂在目标对象上、取消掉的上传其块最长留存 7 天、也没有按会话区分的枚举
 * —— 所以「上一次会话遗留的块」与本次的块在云端不可区分。若块名只由分片号决定，
 * 「取消后重新上传同一路径」的续传判定就会采信旧块：跳过本应重传的分片，
 * 提交出一份**新旧拼接、且不报任何错**的文件。
 *
 * 判据取可观测后果：把上游给的块列表**原样**当成本次进度（这正是 `routes/fs.js` 的续传闸门
 * 与提交的做法），提交出来的内容必须只有本会话的分片。外来的那个块特意选了**本会话没有的
 * 分片号 9** —— 若按分片号去重会把它悄悄吞掉（判据就退化成"恒绿"），必须让它可观测。
 */
test('AZ-05 · 断点续传：不得采信「上一次会话」遗留的块（块名必须按会话令牌隔离）', async () => {
  const fake = await startFakeAzure();
  const c = clientFor(fake.port);
  try {
    // 别的会话留下的块：合法块名形态、但令牌不同，且分片号取本会话不会用到的 9
    fake.seedBlock('c1', 'big.bin', 'block-aaaaaaaaaaaa-00009', Buffer.from('FOREIGN'));

    const init = await call(c, 'multipartInit', { Bucket: 'c1', Key: 'big.bin' });
    for (const [n, body] of [[1, 'AAA'], [2, 'BBB']]) {
      await call(c, 'multipartUpload', {
        Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId, PartNumber: n, Body: Buffer.from(body),
      });
    }
    const lp = await call(c, 'multipartListPart', {
      Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId,
    });
    const parts = lp.ListPartsResult.Part;
    assertEqual(parts.map((x) => x.PartNumber).join(','), '1,2',
      'AZ-05：块列表必须只含本会话的块 —— 混入旧会话的块会让上游跳过本应重传的分片');

    // 上游就是这么用的：拿块列表当 Parts 去提交
    await call(c, 'multipartComplete', {
      Bucket: 'c1', Key: 'big.bin', UploadId: init.UploadId,
      Parts: parts.map((x) => ({ PartNumber: x.PartNumber, ETag: x.ETag })),
    });
    const out = await call(c, 'getObject', { Bucket: 'c1', Key: 'big.bin' });
    assertEqual(out.Body.toString(), 'AAABBB',
      'AZ-05：提交结果必须只由本会话的分片拼成（出现 FOREIGN 即意味着旧会话的块漏了进来）');
  } finally {
    await fake.close();
  }
});
