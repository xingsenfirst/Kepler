/**
 * 测试：gzip 响应压缩
 *  — 判定逻辑单测（不启服务）：API / 静态资源压缩，二进制与下载流跳过
 *  — 端到端：用独立端口启一个最小 express，实测 Content-Encoding 与体积收益
 */
const test = require('node:test');
const http = require('node:http');
const zlib = require('node:zlib');
const path = require('node:path');

const { assert, assertEqual, ROOT } = require('./helpers');
const { gzipMiddleware, shouldCompress, STATIC_EXT } = require(path.join(ROOT, 'server', 'gzip.js'));

test('压缩判定：API JSON 与静态文本资源命中', () => {
  const hit = [
    ['/api/config', 'gzip'],
    ['/api/fs/list?prefix=', 'gzip, deflate, br'],
    ['/js/main.js', 'gzip'],
    ['/css/style.css', 'gzip'],
    ['/index.html', 'gzip'],
    ['/assets/logo.svg', 'gzip'],
    ['/manifest.webmanifest', 'gzip'],
  ];
  for (const [p, ae] of hit) {
    assertEqual(shouldCompress({ path: p, headers: { 'accept-encoding': ae } }), true, `${p} 应压缩`);
  }
});

test('压缩判定：流式下载与二进制资源跳过（避免大文件进内存）', () => {
  const skip = [
    ['/api/fs/download', 'gzip'],
    ['/api/fs/thumb', 'gzip'],
    ['/s/abc123/dl', 'gzip'],
    ['/api/stats/speed', 'gzip'],
    ['/img/photo.png', 'gzip'],
    ['/font/a.woff2', 'gzip'],
    ['/media/v.mp4', 'gzip'],
    ['/js/main.js', ''],            // 客户端不接受 gzip
  ];
  for (const [p, ae] of skip) {
    assertEqual(shouldCompress({ path: p, headers: { 'accept-encoding': ae } }), false, `${p} 应跳过`);
  }
});

test('静态扩展名白名单不含已压缩二进制格式', () => {
  for (const bad of ['.png', '.jpg', '.gif', '.webp', '.woff', '.woff2', '.zip', '.gz', '.mp4', '.pdf']) {
    assert(!STATIC_EXT.has(bad), `${bad} 不应在可压缩白名单中`);
  }
  for (const good of ['.html', '.js', '.css', '.json', '.svg']) {
    assert(STATIC_EXT.has(good), `${good} 应可压缩`);
  }
});

test('端到端：静态 JS 与 API JSON 实际被 gzip 压缩', async () => {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const app = express();
  app.use(gzipMiddleware);
  // 大于 1KB 的文本响应
  const big = 'x'.repeat(20000);
  app.get('/api/big', (req, res) => res.json({ data: big }));
  app.get('/js/big.js', (req, res) => res.type('application/javascript').send(`/* ${big} */`));
  app.get('/img/big.png', (req, res) => {
    res.type('image/png');
    res.send(Buffer.alloc(20000, 7));
  });

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const get = (p, ae) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers: ae ? { 'accept-encoding': ae } : {} },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(c) }));
      });
    req.on('error', reject);
    req.end();
  });

  try {
    const api = await get('/api/big', 'gzip');
    assertEqual(api.headers['content-encoding'], 'gzip', 'API JSON 应被 gzip');
    assertEqual(api.headers.vary, 'Accept-Encoding', '应设置 Vary 头供缓存区分');
    const apiPlain = await get('/api/big', '');
    assert(api.body.length < apiPlain.body.length, '压缩后体积应更小');
    // 解压应还原
    assertEqual(zlib.gunzipSync(api.body).length, apiPlain.body.length, 'gunzip 应还原原始长度');

    const js = await get('/js/big.js', 'gzip');
    assertEqual(js.headers['content-encoding'], 'gzip', '静态 JS 应被 gzip');

    const png = await get('/img/big.png', 'gzip');
    assertEqual(png.headers['content-encoding'], undefined, 'PNG 不应被压缩');
    assertEqual(png.body.length, 20000, 'PNG 应原样返回');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
