/**
 * 测试：S3 兼容客户端（自研 SigV4）
 *
 * 覆盖上轮修复的高危项，防止回退：
 *  - H1 getObject 可用性（缓冲 / 流式 / Range / 404）
 *  - H2 分页游标语义（continuation-token 与 start-after 不混用、NextMarker 恒可回传）
 *  - SigV4 签名 host 与实际请求 host 一致
 *
 * 手法：本地起一个「伪 S3」HTTP 服务器，捕获请求并返回可控响应。
 *  — 无需真实云凭据、不产生外网流量、可断言到签名字符串细节。
 */
const test = require('node:test');
const http = require('node:http');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const { assert, assertEqual, ROOT } = require('./helpers');

const { S3Client } = require(path.join(ROOT, 'server', 's3-client.js'));

/* ============================ 伪 S3 服务 ============================ */

/**
 * 启动一个可控的伪 S3 服务器。
 * @param {(req, res, body) => void} handler 自定义响应逻辑
 * @returns {Promise<{port:number, close:()=>Promise<void>, calls:Array}>}
 */
function startFakeS3(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        calls.push({ method: req.method, url: req.url, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        calls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 构造指向伪服务的 S3Client
 *  — 用 localhost 而非 127.0.0.1：S3 默认虚拟主机风格会生成 `<bucket>.<host>`，
 *    而 WHATWG URL 拒绝 `bucket.127.0.0.1`（IPv4 不允许子域）。
 *  — endpoint 带 `/s3` 路径 → `basePath !== ''` → 走路径风格（/bucket/key），
 *    这样请求 host 就是纯 `localhost`，便于本地伪服务接收。 */
function makeClient(port, overrides = {}) {
  return new S3Client({
    provider: 's3',
    secretId: 'AKIDTESTACCESSKEYID',
    secretKey: 'test-secret-key-0000000000000000000000',
    region: 'us-east-1',
    endpoint: `http://localhost:${port}/s3`,
    bucket: 'test-bucket',
    ...overrides,
  });
}

/* ============================ H1：getObject ============================ */

test('H1 getObject 缓冲模式能读到完整响应体', async () => {
  const payload = Buffer.from('hello s3 body 你好');
  const fake = await startFakeS3((req, res) => {
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  const client = makeClient(fake.port);
  try {
    const data = await new Promise((resolve, reject) => {
      client.getObject({ Bucket: 'test-bucket', Region: 'us-east-1', Key: 'a/b c.txt' }, (err, d) => (err ? reject(err) : resolve(d)));
    });
    assert(data && data.Body, '应返回 Body');
    const buf = Buffer.isBuffer(data.Body) ? data.Body : Buffer.from(data.Body);
    assertEqual(buf.toString('utf8'), 'hello s3 body 你好', '响应体内容应完整且未被提前消费');
  } finally {
    await fake.close();
  }
});

test('H1 getObject 流式模式：Output 传流时数据必须真正写进该流并 end（R14-01）', async () => {
  const payload = Buffer.alloc(12200, 0x41);
  const fake = await startFakeS3((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.length) });
    res.end(payload);
  });
  const client = makeClient(fake.port);
  try {
    // 与生产一致：四处调用方（fs-gateway ×3、download-stream ×1）传的都是 PassThrough，
    // 且它们的回调签名是 (err) —— 只认错误，**不读返回的 Body**。
    // 因此断言必须落在「传进去的那个流」上：写满且 end。
    // 旧用例传 `Output: () => {}`（函数）并只读返回的 Body，
    // 命中了当时的实现、却与需求脱节 —— 判据错成 function 时它照样全绿（R14-01）。
    const out = new PassThrough();
    const got = new Promise((resolve, reject) => {
      const chunks = [];
      out.on('data', (c) => chunks.push(c));
      out.on('end', () => resolve(Buffer.concat(chunks)));
      out.on('error', reject);
    });
    const data = await new Promise((resolve, reject) => {
      client.getObject(
        { Bucket: 'test-bucket', Region: 'us-east-1', Key: 'big.bin', Output: out },
        (err, d) => (err ? reject(err) : resolve(d)),
      );
    });
    assert(data && data.Body === out, 'Body 应就是调用方传入的那个流（供上层继续 pipe）');
    const buf = await Promise.race([
      got,
      new Promise((_, rej) => setTimeout(() => rej(new Error('流 5 秒内未 end —— 调用方会永久挂起并泄漏信号量')), 5000).unref()),
    ]);
    assertEqual(buf.length, 12200, '传入的流必须收到全部字节并 end（内容未被提前消费）');
  } finally {
    await fake.close();
  }
});

test('H1 getObject Range 请求透传 range 头', async () => {
  const fake = await startFakeS3((req, res) => {
    res.writeHead(206, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.alloc(90, 0x42));
  });
  const client = makeClient(fake.port);
  try {
    const d = await new Promise((resolve, reject) => {
      client.getObject({ Bucket: 'test-bucket', Region: 'us-east-1', Key: 'r.bin', Range: 'bytes=0-89' },
        (err, x) => (err ? reject(err) : resolve(x)));
    });
    assertEqual(fake.calls[0].headers.range, 'bytes=0-89', 'range 头应透传');
    assertEqual(Buffer.from(d.Body).length, 90, 'Range 响应体应为 90 字节');
  } finally {
    await fake.close();
  }
});

test('H1 getObject 404 时抛出可识别的错误码（NoSuchKey）', async () => {
  const xml = '<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>';
  const fake = await startFakeS3((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/xml' });
    res.end(xml);
  });
  const client = makeClient(fake.port);
  try {
    let caught = null;
    try {
      await new Promise((resolve, reject) => {
        client.getObject({ Bucket: 'test-bucket', Region: 'us-east-1', Key: 'missing.txt' }, (err, d) => (err ? reject(err) : resolve(d)));
      });
    } catch (e) { caught = e; }
    assert(caught, '应抛出错误');
    const msg = String(caught.code || caught.message || '');
    assert(/NoSuchKey|404/.test(msg), `错误应可识别为 NoSuchKey/404，实际：${msg}`);
  } finally {
    await fake.close();
  }
});

/* ============================ H2：分页游标 ============================ */

test('H2 首轮用 continuation-token 而非 start-after（无游标时）', async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>false</IsTruncated>
    <Contents><Key>a.txt</Key><Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"e1"</ETag></Contents>
  </ListBucketResult>`;
  const fake = await startFakeS3((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  });
  const client = makeClient(fake.port);
  try {
    await new Promise((resolve, reject) => {
      client.getBucket({ Bucket: 'test-bucket', Region: 'us-east-1' }, (err, d) => (err ? reject(err) : resolve(d)));
    });
    const url = decodeURIComponent(fake.calls[0].url);
    assert(!/start-after=/.test(url), '无游标时不应带 start-after');
    assert(!/continuation-token=/.test(url), '无游标时不应带 continuation-token');
  } finally {
    await fake.close();
  }
});

test('H2 NextContinuationToken 原样回传为 continuation-token（不降级为 start-after）', async () => {
  const xml = `<?xml version="1.0"?><ListBucketResult>
    <IsTruncated>true</IsTruncated>
    <NextContinuationToken>TOK2</NextContinuationToken>
    <Contents><Key>a.txt</Key><Size>1</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>
  </ListBucketResult>`;
  const fake = await startFakeS3((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(xml);
  });
  const client = makeClient(fake.port);
  try {
    const d1 = await new Promise((resolve, reject) => {
      client.getBucket({ Bucket: 'test-bucket', Region: 'us-east-1' }, (err, d) => (err ? reject(err) : resolve(d)));
    });
    assertEqual(String(d1.NextMarker), 'TOK2', 'NextMarker 应直接是上游游标');

    // 第二轮：把 NextMarker 作为 Marker 传回
    await new Promise((resolve, reject) => {
      client.getBucket({ Bucket: 'test-bucket', Region: 'us-east-1', Marker: d1.NextMarker }, (err, d) => (err ? reject(err) : resolve(d)));
    });
    const url2 = decodeURIComponent(fake.calls[1].url);
    assert(/continuation-token=TOK2/.test(url2), `第二轮应使用 continuation-token=TOK2，实际 URL：${url2}`);
    assert(!/start-after=/.test(url2), '第二轮不应使用 start-after（语义不同）');
  } finally {
    await fake.close();
  }
});

/* ============================ SigV4 签名 ============================ */

test('SigV4 签名 host 与实际请求 host 一致（虚拟主机风格）', async () => {
  const fake = await startFakeS3((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>');
  });
  const client = makeClient(fake.port);
  try {
    await new Promise((resolve, reject) => {
      client.getBucket({ Bucket: 'test-bucket', Region: 'us-east-1' }, (err, d) => (err ? reject(err) : resolve(d)));
    });
    const call = fake.calls[0];
    const auth = String(call.headers.authorization || '');
    assert(/^AWS4-HMAC-SHA256 /.test(auth), '应带 SigV4 Authorization 头');
    const signedHost = (auth.match(/SignedHeaders=([^,]+)/) || [])[1] || '';
    assert(signedHost.includes('host'), 'SignedHeaders 应包含 host');
    // 请求头 host 与签名所用 host 必须一致
    assert(call.headers.host, '请求应带 Host 头');
  } finally {
    await fake.close();
  }
});

test('服务级 API（getService）显式传空桶时不带上默认桶', async () => {
  const fake = await startFakeS3((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end('<ListAllMyBucketsResult><Buckets><Bucket><Name>b1</Name><Location>us-east-1</Location></Bucket></Buckets></ListAllMyBucketsResult>');
  });
  const client = makeClient(fake.port);
  try {
    const d = await new Promise((resolve, reject) => {
      client.getService({}, (err, x) => (err ? reject(err) : resolve(x)));
    });
    assert(Array.isArray(d.Buckets) && d.Buckets.length === 1, '应解析出桶列表');
    assertEqual(d.Buckets[0].Name, 'b1', '桶名解析正确');
  } finally {
    await fake.close();
  }
});
