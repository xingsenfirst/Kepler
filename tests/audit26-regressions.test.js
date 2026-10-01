/**
 * 第二十六轮护栏（R26-01 ~ R26-08）—— 新增四家 S3 兼容服务商
 *
 * 需求：以 S3 兼容协议接入 **Google Cloud Storage / Cloudflare R2 / MinIO /
 * Backblaze B2**；不同服务商要求的参数不同；商标图形与既有厂商同样内联进
 * `public/js/provider-logos.js`。
 *
 * 本轮的真实风险不是「少注册一家」，而是**每家的差异点被抹平成同一套语义**：
 *  - R2 的端点里带**账户 ID**（`{account}.r2.cloudflarestorage.com`），而
 *    `endpointTemplate` 的常规用法是「地域填进主机名中段」——两者一旦共用同一条
 *    推导路径，R2 就会被拼成 `auto.r2.cloudflarestorage.com`：**语法合法的域名**，
 *    不报错、只让每一次请求都解析失败；
 *  - MinIO 是自建部署，默认的虚拟主机风格会拼出 `bucket.<host>` 而无法解析 ——
 *    「配置看着全对，但每个请求都失败」；
 *  - 这几家都**允许地域留空**，而建桶路由旧代码在推导出厂商**之前**就无条件要求地域；
 *  - 「只改备注」的一次保存不得把密钥的厂商/端点改写掉（否则一条 R2 密钥会被按
 *    腾讯云的规则重算，端点被写坏且不可逆）。
 *
 * 因此这里的每条断言都打在上述**差异点**上，而不是「表里有没有这个 id」。
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R26-*` 条目。
 * ⚠️ 端口一律 `listen(0)`（临时端口），与相邻轮次并发跑文件时不会 EADDRINUSE。
 */
const fsc = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { test } = require('node:test');
const { ROOT, assert, assertEqual, cleanupTempDir } = require('./helpers.js');

const TMP = fsc.mkdtempSync(path.join(os.tmpdir(), 'cos-audit26-'));
process.env.COS_DATA_DIR = TMP;

const providers = require(path.join(ROOT, 'server', 'providers.js'));
const { S3Client } = require(path.join(ROOT, 'server', 's3-client.js'));
const cos = require(path.join(ROOT, 'server', 'cos.js'));

const read = (rel) => fsc.readFileSync(path.join(ROOT, rel), 'utf8');
const NEW_PROVIDERS = ['gcs', 'r2', 'minio', 'b2'];

/** 断言 fn 抛出，并把错误对象交回调用方继续检查 */
function takeThrow(fn, msg) {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('断言失败：期望抛出错误，但正常返回' + (msg ? '（' + msg + '）' : ''));
}

/** 粗粒度注释剥离（仅服务「该文件内不得出现裸 X」这类静态判据） */
function withoutComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

/* ==================================================================== */
/* R26-01 · 注册表：四家厂商都存在，且前后端元数据同源                          */
/* ==================================================================== */

test('R26-01 · 四家 S3 兼容厂商已注册，前端展示顺序与服务端注册表逐项一致', async () => {
  for (const id of NEW_PROVIDERS) {
    const m = providers.get(id);
    assert(m, `R26-01：${id} 未在 providers.js 注册`);
    assertEqual(m.kind, 's3', `R26-01：${id} 必须走 S3 兼容协议`);
    assertEqual(providers.isSupported(id), true, `R26-01：${id} 必须可连接（不得是 planned）`);
    assertEqual(providers.isS3(id), true, `R26-01：${id} 必须判定为 S3 厂商`);
    assert(m.credentialLabel && m.credentialLabel.id && m.credentialLabel.key,
      `R26-01：${id} 必须给出密钥字段标签（否则表单沿用别家的字段名）`);
  }

  /**
   * 前后端各有一份硬编码的**展示顺序**（`server/providers.js` 的数组顺序、
   * `public/js/provider-logos.js` 的 `ORDER`）。两处顺序一旦漂移，界面上的图标
   * 顺序会与文档 / 后端提示不一致，且没有任何一处会报错 —— 用这条把两者绑死。
   */
  const logos = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'provider-logos.js')).href);
  assertEqual(logos.providerList().map((p) => p.id).join(','), providers.list().map((p) => p.id).join(','),
    'R26-01：前端 ORDER 必须与服务端注册表同序（两处硬编码，靠这条绑定）');

  // 名称 / 协议两端必须一致 —— 用户在两处看到的是同一个名字
  for (const id of NEW_PROVIDERS) {
    const web = logos.providerMeta(id);
    const srv = providers.get(id);
    assertEqual(web.name, srv.name, `R26-01：${id} 的显示名前后端不一致`);
    assertEqual(web.id, id, `R26-01：${id} 的前端元数据 id 写错（回退到腾讯云会让图标串台）`);
  }
});

/**
 * 图形必须**确实来自指定的 SVG 源**（`svg.txt`），而不是随便一张同名的图。
 * 判据用「viewBox 尺寸 + 路径条数 + 品牌主色」三者交叉 —— 单看条数或单看颜色
 * 都可能被别的图标蒙对。
 */
test('R26-01b · 四家厂商的内联图形与 svg.txt 规格一致（viewBox / 路径数 / 主色）', async () => {
  const logos = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'provider-logos.js')).href);
  const spec = {
    gcs: { viewBox: '0 0 1024 1024', paths: 4, fills: ['#4587F2', '#FABC07', '#E94436', '#35A853'] },
    r2: { viewBox: '0 0 1280 1024', paths: 2, fills: ['#F78100', '#FBAC42'] },
    minio: { viewBox: '0 0 2048 1024', paths: 1, fills: ['#C72C48'] },
    b2: { viewBox: '0 0 1024 1024', paths: 1, fills: ['#E20626'] },
  };
  for (const id of NEW_PROVIDERS) {
    const svg = logos.providerLogoSvg(id);
    assert(svg, `R26-01b：${id} 没有内联图形（图标会渲染成空白）`);
    const vb = /viewBox="([^"]+)"/.exec(svg);
    assertEqual(vb && vb[1], spec[id].viewBox, `R26-01b：${id} 的 viewBox 与源文件不一致`);
    assertEqual((svg.match(/<path /g) || []).length, spec[id].paths,
      `R26-01b：${id} 的路径条数与源文件不一致（图形被换成了别的版本）`);
    for (const f of spec[id].fills) {
      assert(svg.includes(`fill="${f}"`), `R26-01b：${id} 缺少品牌色 ${f}`);
    }
    // 与既有厂商同一套容器（白底 + 固定尺寸），而不是另起一套
    assert(/^<span class="pv-logo[^"]*"><svg /.test(logos.providerLogo(id)),
      `R26-01b：${id} 必须复用既有的 .pv-logo 容器`);
  }
});

/* ==================================================================== */
/* R26-02 · 端点组装：三种输入形态 + R2 幂等                                  */
/* ==================================================================== */

test('R26-02 · composeEndpoint 的三种形态，且 R2 必须幂等（否则保存一次就多拼一层域名）', () => {
  // ① template（R2）：用户填账户 ID → 拼成完整端点
  assertEqual(providers.composeEndpoint('r2', '1a2b3c4d5e6f'),
    'https://1a2b3c4d5e6f.r2.cloudflarestorage.com',
    'R26-02：R2 的账户 ID 必须被拼成完整端点（否则「测试连接」会把账户 ID 当端点发出去）');

  /**
   * ② **幂等**：表单若要回填库里已组装好的端点、用户不动它直接保存，再拼一次就会得到
   * `https://<id>.r2.cloudflarestorage.com.r2.cloudflarestorage.com` —— 这是一个
   * **语法完全合法**的域名，不报错、只在连接时静默失败，排查成本极高。
   */
  const once = providers.composeEndpoint('r2', '1a2b3c4d5e6f');
  assertEqual(providers.composeEndpoint('r2', once), once,
    'R26-02：R2 端点组装必须幂等（重复保存不得把域名拼成两层）');
  /**
   * 用户从控制台复制「S3 API」端点时常常**不带协议**（`<id>.r2.cloudflarestorage.com`）。
   * 这一形态必须只补协议、不再套模板 —— 否则会拼成
   * `…cloudflarestorage.com.r2.cloudflarestorage.com`（同样语法合法、静默失败）。
   * 它是「已组装完毕」这一判据里**唯一**由域名后缀分支兜住的形态，
   * 与上面带协议的形态各有一个断言落点。
   */
  assertEqual(providers.composeEndpoint('r2', '1a2b3c4d5e6f.r2.cloudflarestorage.com'),
    'https://1a2b3c4d5e6f.r2.cloudflarestorage.com',
    'R26-02：粘贴不带协议的完整端点时必须只补协议，而不是再套一层模板');
  assertEqual(providers.composeEndpoint('r2', 'https://custom.example.com'), 'https://custom.example.com',
    'R26-02：用户显式给了带协议的完整端点时应原样保留（不得再套一层模板）');

  // ③ required（MinIO）：用户填的就是完整端点，原样透传
  assertEqual(providers.composeEndpoint('minio', 'https://minio.example.com:9000'),
    'https://minio.example.com:9000', 'R26-02：MinIO 端点必须原样透传');

  // ④ 其余厂商（含历史厂商）：逐字透传 —— 这条路径必须与历史行为一致，否则存量配置被改写
  assertEqual(providers.composeEndpoint('tencent', 'https://cos.example.com'), 'https://cos.example.com');
  assertEqual(providers.composeEndpoint('aws', '  https://s3.example.com  '), 'https://s3.example.com',
    'R26-02：透传前应去掉首尾空白');

  // 空输入一律回空串（不得凭厂商模板凭空造一个端点）
  for (const id of ['r2', 'minio', 'tencent', 'gcs']) {
    assertEqual(providers.composeEndpoint(id, ''), '', `R26-02：${id} 空输入应回空串`);
    assertEqual(providers.composeEndpoint(id, undefined), '', `R26-02：${id} 未传应回空串`);
  }
});

/* ==================================================================== */
/* R26-03 · 端点推导：模板型厂商不得走「地域填中段」的推导路径                    */
/* ==================================================================== */

test('R26-03 · R2 的端点是账户 ID 前缀，绝不能被地域推导拼成 auto.r2... 这种假域名', () => {
  assertEqual(providers.endpointFor('r2', 'auto'), '',
    'R26-03：R2 不得由地域推导端点 —— 会拼出 `auto.r2.cloudflarestorage.com`：'
    + '语法合法、不报错，但每次请求都解析失败（用户只看到「网络连接异常」）');

  // 反向对照：占位符在主机名**中段**的厂商仍必须能由地域推导（这条路径不能被一起改坏）
  assertEqual(providers.endpointFor('aws', 'us-east-1'), 'https://s3.us-east-1.amazonaws.com',
    'R26-03：AWS 的 {region} 在中段，必须继续按模板推导');
  assertEqual(providers.endpointFor('b2', 'us-west-004'), 'https://s3.us-west-004.backblazeb2.com',
    'R26-03：B2 的 {region} 在中段，必须继续按模板推导');
  assertEqual(providers.endpointFor('gcs', 'auto'), 'https://storage.googleapis.com',
    'R26-03：GCS 无地域模板，应回落到固定端点');

  // 端到端：R2 未填账户 ID 时必须在**建客户端**这一步就给出可行动的报错
  const err = takeThrow(() => cos.createClient({ provider: 'r2', secretId: 'a', secretKey: 'b', region: '' }),
    'R26-03：R2 缺少账户 ID 时必须抛错');
  assertEqual(err.status, 400, 'R26-03：缺少端点属配置问题，应为 400');
  assert(/Cloudflare/.test(err.message) && /账户 ID/.test(err.message),
    `R26-03：文案必须说清缺的是「账户 ID」（实际：${err.message}）`);
});

/* ==================================================================== */
/* R26-04 · 地域解析：允许留空的厂商补默认值；非法字符一律拒绝                    */
/* ==================================================================== */

test('R26-04 · regionFor 补默认地域；地域字符集受限（它会被直接拼进端点主机名）', () => {
  assertEqual(providers.regionFor('gcs', ''), 'auto', 'R26-04：GCS 留空应补 auto');
  assertEqual(providers.regionFor('r2', ''), 'auto', 'R26-04：R2 留空应补 auto');
  assertEqual(providers.regionFor('minio', ''), 'us-east-1', 'R26-04：MinIO 留空应补 us-east-1');
  assertEqual(providers.regionFor('b2', ''), '',
    'R26-04：B2 的地域是必填项，不得凭空补一个（补错会签出错误端点）');
  assertEqual(providers.regionFor('aws', '  us-east-1  '), 'us-east-1', 'R26-04：应去掉首尾空白');

  /**
   * R21-12：地域会被**直接拼进端点模板**（`s3.{region}.amazonaws.com`），
   * 而厂商默认端点这条路**不过** `assertSafeEndpoint`。字符集一旦放开，
   * 一个 `cn-hangzhou/../x` 或 `a?b` 就能改写出站请求的主机 / 路径。
   */
  for (const bad of ['cn-hangzhou/../x', 'a?b', 'us east 1', '#frag', '']) {
    if (!bad) continue;
    const e = takeThrow(() => providers.regionFor('aws', bad), `regionFor 未拦下 ${bad}`);
    assertEqual(e.status, 400, `R26-04：非法地域「${bad}」应为 400`);
  }
  // 端到端：唯一的读取点是 createClient，那里也必须抛
  const e2 = takeThrow(() => cos.createClient({
    provider: 'aws', secretId: 'a', secretKey: 'b', region: 'us-east-1/../../evil',
  }));
  assertEqual(e2.status, 400, 'R26-04：createClient 必须同样拦下（否则绕过界面就能注入）');
});

/* ==================================================================== */
/* R26-05 · MinIO 的路径风格寻址                                              */
/* ==================================================================== */

test('R26-05 · 自建对象存储必须走路径风格，且判据只有一个实现点', () => {
  assertEqual(providers.forcePathStyle('minio'), true,
    'R26-05：MinIO 必须强制路径风格 —— 默认会拼出 `bucket.<host>`，自建部署解析不了');
  assertEqual(providers.forcePathStyle('aws'), false, 'R26-05：公云厂商仍用虚拟主机风格');

  const mk = (extra) => new S3Client(Object.assign({
    accessKeyId: 'k', secretAccessKey: 's',
    endpoint: 'https://minio.internal.example.com:9000', bucket: 'b', region: 'us-east-1',
  }, extra));

  // 行为：预签名直链必须把桶放在**路径**上，而不是主机名前缀
  const pathStyle = mk({ forcePathStyle: true }).getObjectUrl({ Bucket: 'b', Key: 'd/k.txt', Sign: true }).Url;
  assert(/^https:\/\/minio\.internal\.example\.com:9000\/b\/d\/k\.txt\?/.test(pathStyle),
    `R26-05：强制路径风格时直链应为 host/bucket/key（实际 ${pathStyle.split('?')[0]}）`);

  // 反向对照：不强制时仍是虚拟主机风格（证明这个开关真的在起作用）
  const virtual = mk({}).getObjectUrl({ Bucket: 'b', Key: 'd/k.txt', Sign: true }).Url;
  assert(/^https:\/\/b\.minio\.internal\.example\.com:9000\/d\/k\.txt\?/.test(virtual),
    `R26-05：默认应走虚拟主机风格（实际 ${virtual.split('?')[0]}）`);

  /**
   * 端到端：**客户端工厂**也必须把厂商的 `forcePathStyle` 传下去。
   *
   * 这是与「providers 元数据」和「s3-client 判据」并列的第三个可被独立摘掉的地方 ——
   * 只钉住前两处的话，`cos.js` 里少传一个字段照旧是绿的，而线上表现是
   * 「MinIO 完全用不了」。
   */
  const minioClient = cos.createClient({
    provider: 'minio', secretId: 'minioadmin', secretKey: 'sk',
    endpoint: 'https://minio.example.com:9000', region: '', bucket: 'b',
  });
  assertEqual(minioClient._virtualHosted(), false,
    'R26-05：cos.createClient 必须把厂商的 forcePathStyle 传给 S3Client（漏传 = MinIO 全不可用）');
  assertEqual(minioClient.region, 'us-east-1', 'R26-05：工厂同时应补上 MinIO 的默认地域');
  const awsClient = cos.createClient({
    provider: 'aws', secretId: 'AKIAEXAMPLE', secretKey: 'sk',
    endpoint: '', region: 'us-east-1', bucket: 'b',
  });
  assertEqual(awsClient._virtualHosted(), true,
    'R26-05：公云厂商仍应是虚拟主机风格（证明上面不是「一律路径风格」）');

  /**
   * 静态不变量：寻址判据**只允许有一个实现点**。
   *
   * 此前 `this.basePath === ''` 在 4 处各写了一遍 —— 任何一次「只改一处」都会造成
   * 「列举能跑、下载 404」这类只在部分操作上暴露的分叉。收敛到 `_virtualHosted()`
   * 后，这里把「别处不得再出现裸判据」钉死。
   */
  const code = withoutComments(read('server/s3-client.js'));
  const defIdx = code.indexOf('_virtualHosted() {');
  assert(defIdx >= 0, 'R26-05：扫描范围自检 —— 应能定位 _virtualHosted 定义');
  const defEnd = code.indexOf('\n  }', defIdx);
  assert(defEnd > defIdx, 'R26-05：扫描范围自检 —— 应能定位 _virtualHosted 的结束');
  const bare = [];
  for (const m of code.matchAll(/this\.basePath === ''/g)) {
    if (m.index < defIdx || m.index > defEnd) bare.push(m.index);
  }
  assertEqual(bare.length, 0,
    `R26-05：s3-client.js 中出现了 ${bare.length} 处 _virtualHosted 之外的裸寻址判据`
    + '（同一判据多份实现 = 迟早只改一处）');

  // 两个拼 URL 的调用点都必须走该判据
  const reqIdx = code.indexOf('_request(spec) {');
  const urlIdx = code.indexOf('getObjectUrl(params, cb) {');
  assert(reqIdx >= 0 && urlIdx > reqIdx, 'R26-05：扫描范围自检 —— 应能定位 _request / getObjectUrl');
  const reqBody = code.slice(reqIdx, urlIdx);
  const urlBody = code.slice(urlIdx);
  assert((reqBody.match(/_virtualHosted\(\)/g) || []).length >= 2,
    'R26-05：_request 的 hostHeader 与 path 两处都必须走 _virtualHosted()');
  assert(/_virtualHosted\(\)/.test(urlBody),
    'R26-05：getObjectUrl 也必须走同一判据（否则「列举能跑、直链 404」）');
});

/* ==================================================================== */
/* R26-06 · 重新保存不得改写既有记录的厂商 / 端点                              */
/* ==================================================================== */

test('R26-06 · 「只改备注」的一次保存不得把密钥的厂商与端点改写掉', async () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  configStore.save({
    credentials: [{
      id: 'c-r2', provider: 'r2', secretId: 'AKIDr2', secretKey: 'sk',
      endpoint: 'https://1a2b.r2.cloudflarestorage.com',
      enabled: true, visibleToUsers: true, remark: '原备注',
    }],
    buckets: [],
    activeCredentialId: 'c-r2',
  });

  // 旧版 `PUT /config` 的扁平入参：只带 secretId / remark，**不带** provider / endpoint
  configStore.addCredential({ secretId: 'AKIDr2', secretKey: '', remark: '新备注' });
  const c = configStore.load().credentials.find((x) => x.id === 'c-r2');
  assertEqual(c.remark, '新备注', 'R26-06：备注应被更新');
  assertEqual(c.provider, 'r2',
    'R26-06：未显式指定厂商时必须保持原厂商 —— 回落成腾讯云会让这条密钥按别家规则重算');
  assertEqual(c.endpoint, 'https://1a2b.r2.cloudflarestorage.com',
    'R26-06：未显式提交端点时必须保持原端点（旧实现会把它清空 / 重算，且不可逆）');

  // 反向对照：显式提交时必须真的写入（证明上面不是「压根不写」）
  configStore.addCredential({ secretId: 'AKIDr2', secretKey: '', endpoint: '9z8y' });
  assertEqual(configStore.load().credentials.find((x) => x.id === 'c-r2').endpoint,
    'https://9z8y.r2.cloudflarestorage.com', 'R26-06：显式提交端点时应按厂商规则组装并写入');

  /**
   * 要求端点的厂商（R2 / MinIO）缺失端点时必须当场拒绝 ——
   * 否则会落库一条「配置看着齐全、每次操作都失败」的密钥，而失败文案
   * （端点被拼成不存在的域名 → 「网络连接异常」）完全指不到「少填了账户 ID」。
   */
  const e1 = takeThrow(() => configStore.addCredential({
    provider: 'minio', secretId: 'minioadmin', secretKey: 'sk',
  }), 'R26-06：新建 MinIO 密钥但不给端点时必须抛错');
  assertEqual(e1.status, 400, 'R26-06：缺端点属入参问题，应为 400');
  assertEqual(configStore.load().credentials.some((x) => x.secretId === 'minioadmin'), false,
    'R26-06：被拒的密钥不得留下任何记录');

  const e2 = takeThrow(() => configStore.updateCredential('c-r2', { endpoint: '' }),
    'R26-06：把 R2 的端点清空时必须抛错');
  assertEqual(e2.status, 400, 'R26-06：清空必需端点应为 400');
  assertEqual(configStore.load().credentials.find((x) => x.id === 'c-r2').endpoint,
    'https://9z8y.r2.cloudflarestorage.com', 'R26-06：被拒的更新不得改动既有端点');
});

/* ==================================================================== */
/* R26-07 · 建桶路由：地域是否必填取决于厂商                                   */
/* ==================================================================== */

const express = require(path.join(ROOT, 'node_modules', 'express'));

/**
 * 桩必须在**加载路由之前**装好：`routes/buckets.js` 在 require 时就把 `getClient`
 * 与 `p` 解构走了，之后再改 `cos.p` 打不到它（这是「桩打偏 → 护栏假绿」的经典形态）。
 */
cos.getClient = () => ({ __stub: true });
cos.p = async (method) => {
  if (method === 'getBucket') return { Contents: [], IsTruncated: 'false' }; // 存在性探测
  throw new Error('测试桩未预期的 p() 调用：' + method);
};
cos.listAll = async () => [];
cos.listAllExact = async () => [];

const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
const bucketRoutes = require(path.join(ROOT, 'server', 'routes', 'buckets.js'));

function serve(mount, router) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
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

const CRED = (id, provider, sid, endpoint) => ({
  id, provider, secretId: sid, secretKey: 'k-' + sid, endpoint,
  quotaBytes: 0, enabled: true, visibleToUsers: true, remark: id,
});

const seedCreds = (creds, activeId) => configStore.save({
  credentials: creds, buckets: [], activeCredentialId: activeId,
});

test('R26-07 · 地域可留空的厂商在「新建存储桶」时不得被硬性拦下；必填的仍要拦', async () => {
  const srv = await serve('/api', bucketRoutes);
  try {
    /**
     * 旧实现在**推导出厂商之前**就无条件 `if (!region) return 400`，
     * 于是界面明明写着「可留空」，提交却报「请填写存储桶地域」——
     * 用户只能胡乱填一个值，而那个值会真的进入签名串。
     */
    seedCreds([CRED('c-minio', 'minio', 'minioadmin', 'https://minio.example.com:9000')], 'c-minio');
    const ok = await send(srv.port, 'POST', '/api/buckets/local',
      { bucket: 'r26-minio-bkt', region: '', credentialId: 'c-minio' });
    assertEqual(ok.status, 200, `R26-07：MinIO 留空地域必须放行（实际 ${ok.status} / ${ok.raw}）`);
    const saved = (configStore.load().buckets || []).find((b) => b.bucket === 'r26-minio-bkt');
    assert(saved, 'R26-07：放行的请求必须真的落库');
    assertEqual(saved.region, 'us-east-1',
      'R26-07：留空必须补上厂商默认地域 —— 空串进签名串会让客户端与服务端各自兜底成不同值');

    // 反向对照：地域必填的厂商留空仍必须 400（否则这条闸门等于整体失效）
    seedCreds([CRED('c-aws', 'aws', 'AKIAEXAMPLE', '')], 'c-aws');
    const bad = await send(srv.port, 'POST', '/api/buckets/local',
      { bucket: 'r26-aws-bkt', region: '', credentialId: 'c-aws' });
    assertEqual(bad.status, 400, `R26-07：AWS 留空地域必须拒绝（实际 ${bad.status} / ${bad.raw}）`);
    assert(/地域/.test(bad.json && bad.json.error || ''), 'R26-07：拒绝文案应指明是地域问题');
    assertEqual(configStore.load().buckets.some((b) => b.bucket === 'r26-aws-bkt'), false,
      'R26-07：被拒的建桶请求不得留下记录');

    // GCS 同样允许留空（证明不是「只给 MinIO 开了口子」）
    seedCreds([CRED('c-gcs', 'gcs', 'GOOGEXAMPLE', '')], 'c-gcs');
    const gcs = await send(srv.port, 'POST', '/api/buckets/local',
      { bucket: 'r26-gcs-bkt', region: '', credentialId: 'c-gcs' });
    assertEqual(gcs.status, 200, `R26-07：GCS 留空地域必须放行（实际 ${gcs.status} / ${gcs.raw}）`);
    assertEqual(configStore.load().buckets.find((b) => b.bucket === 'r26-gcs-bkt').region, 'auto',
      'R26-07：GCS 留空应补 auto');
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R26-08 · 前端：端点栏由厂商元数据驱动，地域星号同理                          */
/* ==================================================================== */

test('R26-08 · 密钥表单的「服务端点」栏由 endpointMode 驱动，地域星号按厂商隐显', async () => {
  const logos = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'provider-logos.js')).href);
  const html = read('public/index.html');
  const credmgr = read('public/js/credmgr.js');
  const main = read('public/js/main.js');

  /**
   * 元数据必须与服务端逐项一致 —— 前端只负责渲染，组装是服务端的事。
   * 一旦这里写错（例如把 R2 标成 'required'），界面会把账户 ID 当完整地址收，
   * 服务端照样按模板拼，用户以为填错了却看不到任何提示。
   *
   * 这里覆盖**全部厂商**（不只是本轮新增的四家）：`regionRequired` 这类字段是
   * 「界面承诺 vs 服务端闸门」的同一件事，任何一家漂移都是一次口径分叉。
   */
  for (const srv of providers.list()) {
    const web = logos.providerMeta(srv.id);
    assertEqual(web.endpointMode, srv.endpointMode,
      `R26-08：${srv.id} 的 endpointMode 前后端不一致`);
    assertEqual(web.regionRequired, srv.regionRequired,
      `R26-08：${srv.id} 的 regionRequired 前后端不一致（界面承诺与服务端闸门分叉）`);
    assertEqual(web.endpointLabel, srv.endpointLabel,
      `R26-08：${srv.id} 的端点栏标签前后端不一致（用户不知道该填账户 ID 还是地址）`);
    assertEqual(web.kind, srv.kind, `R26-08：${srv.id} 的协议类型前后端不一致`);
  }
  // 反向对照：要求填端点的两家必须带**自己的**标签（不能都退化成兜底文案）
  assertEqual(logos.providerMeta('r2').endpointLabel, '账户 ID（Account ID）',
    'R26-08：R2 的端点栏必须明说是账户 ID —— 用户照「服务端点」去填 URL 会一直失败');
  assertEqual(logos.providerMeta('minio').endpointLabel, '服务端点');

  // 表单里确实有一栏可被显示 / 隐藏的端点输入框（而不是恒不渲染的死代码）
  assert(/id="cred-endpoint-item"/.test(credmgr), 'R26-08：密钥表单应有端点栏容器');
  assert(/id="cred-endpoint"/.test(credmgr), 'R26-08：密钥表单应有端点输入框');
  assert(/meta\.endpointMode/.test(credmgr) && /epItem\.hidden = !mode/.test(credmgr),
    'R26-08：端点栏必须按厂商的 endpointMode 显隐（恒显会让别的厂商看到无意义的输入框）');
  // 提交路径必须把端点带上（否则前端收了值却发不出去 = 静默丢弃）
  assert(/addCredential\([^)]*endpoint/.test(credmgr), 'R26-08：保存密钥时必须提交端点');
  assert(/verifyConfig\([^)]*endpoint/.test(credmgr), 'R26-08：「测试连接」也必须提交端点（否则 R2 必失败）');

  /**
   * 界面上不再出现「服务商」下拉 / 图标选择器之外的硬编码厂商表：
   * index.html 不得自带厂商清单（否则新增一家就漏一处）。
   */
  assert(!/pv-opt/.test(html), 'R26-08：index.html 不应硬编码厂商图标卡片（应完全由 provider-logos 驱动）');

  // 地域星号按厂商隐显：又拍云 / GCS / R2 / MinIO 允许留空
  assert(/id="bk-region-req"/.test(main), 'R26-08：建桶表单的地域星号应有 id 以支持隐显');
  assert(/regionReq\.hidden = prov\.regionRequired === false/.test(main),
    'R26-08：地域星号必须按厂商元数据隐显（否则界面写着必填、服务端却允许留空）');
  assert(/regionRequired !== false/.test(main),
    'R26-08：提交前的地域校验也必须按厂商判定（否则「可留空」的厂商被界面拦下）');
});

/* ============================ 收尾 ============================ */

test.after(async () => {
  await cleanupTempDir(TMP, {
    label: 'audit26-regressions',
    flushers: [
      { name: 'config-store', flush: () => configStore.flush() },
      { name: 'stats-store', flush: () => require(path.join(ROOT, 'server', 'stats-store.js')).flushStatsSync() },
      { name: 'secure-store', flush: () => require(path.join(ROOT, 'server', 'secure-store.js')).flush() },
    ],
  });
});
