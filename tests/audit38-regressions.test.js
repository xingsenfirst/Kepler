/**
 * 第三十八轮 · Windows Hello 域名校验修复 + 配置备份
 * （R38-01 / R38-02）
 *
 * ## R38-01 的现场
 * 部署实例上用真实域名访问，启用 Windows Hello 却被回一句
 * 「当前访问地址不是本站域名…」—— 而它**就是**本站。根因不在那条判据本身
 * （它是 R24-02 的防钓鱼落点，必须 fail-closed），而在它的**允许集是空的**：
 * `deploy.sh` 生成的运行环境写的是 `HOST=0.0.0.0`（通配绑定地址，永远不可能出现在
 * 请求的 Host 头里），真实域名只进了 nginx 的 `server_name`，应用无从得知自己叫什么；
 * 唯一能填「域名」的界面入口是密钥管理页的「自定义请求域名（可选）」，而它按设计是
 * **分享链接用的 CDN 域名**，可选，与 WebAuthn 毫无关系。
 *
 * 因此本轮的修法是**补上权威来源**（`SITE_DOMAIN`，由部署脚本写入），
 * 而**不是**放宽判据 —— 判据一旦放宽成「任取请求 Host」，R24-02 就整条失效。
 *
 * ## R38-02 的两个「唯一实现点」
 *  - `server/backup.js`：备份范围、实时码、导出码加解密、导入落盘
 *  - `ip-guard.replaceAllRules()`：IP 规则的整批替换（保留 id / enabled）
 *
 * ## 隔离
 * `HOST` / `SITE_DOMAIN` / `TRUST_PROXY` 都是 `security.js` 的**模块级常量**，
 * 必须在 require 之前写进 env，故用 `withEnv()` 连缓存一起清。数据目录由
 * `helpers.js` 兜底到临时目录，绝不触碰生产 `data/`。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');
const test = require('node:test');

require('./helpers'); // 兜底 COS_DATA_DIR 到临时目录

const { assertEqual, assertMatch, request } = require('./helpers');
const { express } = require('../server/routes/_context');

const ROOT = path.join(__dirname, '..');
const SEC = path.join(ROOT, 'server', 'security.js');
const CONTEXT = path.join(ROOT, 'server', 'routes', '_context.js');
const ROUTES_SHARED = path.join(ROOT, 'server', 'routes', '_shared.js');
const ROUTES_BACKUP = path.join(ROOT, 'server', 'routes', 'backup.js');
const DEPLOY = path.join(ROOT, 'deploy.sh');

const backup = require('../server/backup.js');
const configStore = require('../server/config-store.js');
const ipGuard = require('../server/ip-guard.js');

const read = (p) => fs.readFileSync(p, 'utf8');

/* ============================ 通用工具 ============================ */

/**
 * 在指定 env 下**重新加载** security.js / _context.js / routes/_shared.js。
 *
 * 三个都要清，少一个就是**假绿**：`security` 的 `HOST` / `SITE_DOMAIN` 是模块级常量；
 * 而 `routes/_shared.js` 的 `security` 并不是自己 `require('../security')` 得来的 ——
 * 它从 `./_context` 解构（`_context` 才是汇聚点），所以只清 `_shared` 拿到的仍是旧模块。
 * 实测教训：只清两个时，「外站 Host 必须被拒」会因为读的是上一份 env 而**静默通过**。
 */
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const files = [SEC, CONTEXT, ROUTES_SHARED];
  for (const f of files) delete require.cache[require.resolve(f)];
  const sec = require(SEC);
  require(CONTEXT);
  const shared = require(ROUTES_SHARED);
  try {
    return fn(sec, shared);
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    for (const f of files) delete require.cache[require.resolve(f)];
  }
}

/** 部署形态（与 deploy.sh 生成的运行环境一致：通配 HOST + 反代 + 站点域名） */
const DEPLOY_ENV = { HOST: '0.0.0.0', TRUST_PROXY: '1', SITE_DOMAIN: 'cos.example.com' };

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个只有 backup 路由的 app，并注入指定角色的 req.authUser */
async function serveBackup(role) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    req.authUser = role || null;
    next();
  });
  delete require.cache[require.resolve(ROUTES_BACKUP)];
  app.use(require(ROUTES_BACKUP));
  // 统一错误落地点（与 index.js 同形：结构化 status 一律透传）
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

/* 演示用占位值（刻意不像任何真实密钥） */
const DEMO = {
  sid: 'demo-access-id-0001',
  skey: 'demo-access-key-0001',
  capSite: 'demo-site-key',
  capSecret: 'demo-captcha-key',
  wdPass: 'demo-webdav-pass',
};

/** 往当前实例里放一份「已配置」的数据（每一项都可独立开启，供逐项护栏复用） */
function seedOne(section) {
  switch (section) {
    case 'credentials': configStore.addCredential({ provider: 'tencent', secretId: DEMO.sid, secretKey: DEMO.skey }); break;
    case 'uploadExcludes': configStore.save({ uploadExcludes: { dsStore: true, thumbsDb: false, gitignore: false } }); break;
    case 'captcha': configStore.save({ captcha: { enabled: false, provider: 'recaptcha', siteKey: DEMO.capSite, secretKey: '', timeoutMs: 5000, onError: 'block' } }); break;
    case 'webdav': configStore.setWebdavEnabled(true); break;
    case 'payment': configStore.save({ payment: { enabled: false, platforms: { alipay: { appId: 'demo' } }, siteUrl: '' } }); break;
    case 'buckets': configStore.addBucket({ provider: 'tencent', bucket: 'demo-bucket-0001', region: 'ap-guangzhou' }); break;
    case 'ipguard': ipGuard.addRule({ target: '203.0.113.0/24', remark: 'demo' }); break;
    default: throw new Error('未知分区：' + section);
  }
}

/* ==================================================================== */
/* R38-01 · Windows Hello 的「本站域名」判定                              */
/* ==================================================================== */

test('R38-01a · 部署模式下站点域名必须被认作本站（用户报的那句 403 不再出现）', () => {
  // 反例先行：这正是用户看到的现场 —— HOST=0.0.0.0 且没有任何域名来源时，
  // 用**真实域名**访问本站会被判成「不是本站域名」。
  const before = withEnv({ HOST: '0.0.0.0', TRUST_PROXY: '1', SITE_DOMAIN: '' }, (sec, shared) => {
    let err = null;
    try { shared.webauthnContext({ secure: true, headers: { host: 'cos.example.com' } }); } catch (e) { err = e; }
    return err;
  });
  assert(before && before.status === 403 && before.webauthnUntrusted === true,
    'R38-01：先复现现场 —— 没有域名来源时，真实域名访问会被 fail-closed 拒掉（这说明判据在跑，而不是没生效）');

  // 修复后：部署脚本写入的 SITE_DOMAIN 就是本站域名
  withEnv(DEPLOY_ENV, (sec, shared) => {
    assertEqual(sec.SITE_DOMAIN, 'cos.example.com', 'security 必须导出并归一本站域名');
    assertEqual(sec.isOwnSiteHost('cos.example.com', []), true,
      'R38-01：部署脚本写入的站点域名必须属于「本站」—— 否则用真实域名访问本站时，'
      + 'Windows Hello 会被判成「访问了外站」，用户看到的就是那句 403');
    const ctx = shared.webauthnContext({ secure: true, headers: { host: 'cos.example.com' } });
    assertEqual(ctx.rpId, 'cos.example.com', 'rpId 必须是裸主机名（不能带端口/协议）');
    assertEqual(ctx.origin, 'https://cos.example.com', 'origin 必须与浏览器地址栏一致');
  });
});

test('R38-01b · 外站 Host 仍须被拒（本轮不得把 R24-02 的防钓鱼放宽）', () => {
  withEnv(DEPLOY_ENV, (sec, shared) => {
    for (const evil of ['evil.example', 'cos.example.com.evil.example', 'cos-example.com', 'other.example']) {
      assertEqual(sec.isOwnSiteHost(evil, []), false, `「${evil}」不属于本站`);
      assert.throws(() => shared.webauthnContext({ secure: true, headers: { host: evil } }),
        (e) => e && e.status === 403 && e.webauthnUntrusted === true,
        `R38-01：外站 Host「${evil}」仍必须被拒 —— 把域名解析到同一 IP 的钓鱼站若能用它当 rpId，`
        + '就能完整代理「注册 + 登录」两步，WebAuthn「凭据绑定固定 RP」的防钓鱼属性被抵消');
    }
  });
});

test('R38-01c · 通配绑定地址不是「本站域名」（HOST=0.0.0.0 不得进允许集）', () => {
  withEnv(DEPLOY_ENV, (sec) => {
    for (const wild of ['0.0.0.0', '::', '[::]', '*']) {
      assertEqual(sec.isOwnSiteHost(wild, []), false,
        `R38-01：通配绑定地址「${wild}」不是任何请求能带上的 Host，留在允许集里只是`
        + '「看着有一条、其实永远不命中」的假象');
    }
    // 反向对照：它在**没有**域名来源时确实曾被当成唯一来源（这正是缺陷的形态）
    withEnv({ HOST: '0.0.0.0', TRUST_PROXY: '1', SITE_DOMAIN: '' }, (sec2) => {
      assertEqual(sec2.isOwnSiteHost('cos.example.com', []), false,
        'R38-01：没有域名来源时，真实域名确实匹配不上 —— 这就是用户报的那句 403 的来源');
    });
  });
});

test('R38-01d · HTTPS 跳转目标必须落到真实域名，而不是 0.0.0.0', () => {
  withEnv(DEPLOY_ENV, (sec) => {
    const pick = sec.httpsRedirectHost('attacker.example');
    assertEqual(pick.host, 'cos.example.com',
      'R38-01：配置了站点域名后，跳转目标必须是真实域名（否则 301 到 https://0.0.0.0:3443 无法解析）');
    assertEqual(pick.fallbackToBindAll, false, 'R38-01：取到域名时不应触发「通配回退」告警分支');
  });
});

test('R38-01e · 回环访问仍放行（本机自测不受影响）', () => {
  withEnv(DEPLOY_ENV, (sec, shared) => {
    const ctx = shared.webauthnContext({ secure: true, headers: { host: '127.0.0.1:3000' } });
    assertEqual(ctx.rpId, '127.0.0.1', '回环 rpId 必须照旧可用');
    assertEqual(ctx.origin, 'https://127.0.0.1:3000', '回环 origin 必须保留端口');
  });
});

test('R38-01f · 部署脚本必须把真实域名写进运行环境（SITE_DOMAIN）', () => {
  const sh = read(DEPLOY);
  assertMatch(sh, /^SITE_DOMAIN=\$\{DOMAIN\}$/m,
    'R38-01：deploy.sh 必须把 `--domain` 得到的域名写成 SITE_DOMAIN —— '
    + '这是应用**唯一**能知道「自己叫什么」的权威来源（HOST 只能是通配监听地址）');
  // 反面：HOST 必须仍是通配绑定地址（改成域名会让容器/多网卡部署起不来）
  assertMatch(sh, /^HOST=0\.0\.0\.0$/m,
    'R38-01：HOST 必须保持 0.0.0.0（监听地址），「本站域名」与「监听地址」是两件事，不得合并');
});

test('R38-01g · 新环境变量必须登记进文档（docs-sync 的口径）', () => {
  const doc = read(path.join(ROOT, 'Develop_Document.md'));
  assertMatch(doc, /SITE_DOMAIN/,
    'R38-01：新增的 SITE_DOMAIN 必须写进开发文档的环境变量表，否则下一个人不知道它存在');
  const readme = read(path.join(ROOT, 'README.md'));
  assertMatch(readme, /SITE_DOMAIN/,
    'R38-01：README 的部署说明里也要给出来 —— 自建反代（不走 deploy.sh）的用户只能靠它');
});

/* ==================================================================== */
/* R38-02 · 备份范围                                                      */
/* ==================================================================== */

test('R38-02a · 备份范围必须是需求列出的 8 项，且顺序一致', () => {
  assertEqual(backup.SCOPES.length, 8, 'R38-02：用户可见的备份项恰好 8 项');
  assertEqual(backup.SCOPES.map((s) => s.label).join('|'),
    ['API Key 管理', '负载均衡', '上传排除', '登陆验证', 'WebDAV 服务', '支付设置', '存储桶管理', 'IP 地址管理'].join('|'),
    'R38-02：8 项的措辞与顺序必须与需求逐字一致（顺序即界面上的清单顺序）');
});

test('R38-02b · 「负载均衡」与「API Key 管理」必须是同一份数据，不是两份', () => {
  const cred = backup.SCOPES.filter((s) => s.section === 'credentials').map((s) => s.label);
  assertEqual(cred.join('+'), 'API Key 管理+负载均衡',
    'R38-02：负载均衡展示/编辑的就是各密钥的 quotaBytes，与 API Key 是 config.enc 里的**同一条记录**；'
    + '另存一份会让「同一个字段两个来源」，导入时谁覆盖谁全凭顺序');
  assertEqual(backup.SECTIONS.length, 7,
    'R38-02：8 个用户可见项落到 7 个实际分区（去重后）');
});

test('R38-02c · 用户列表不得进入备份（含管理员）', () => {
  const keys = Object.keys(backup.collect());
  assertEqual(keys.indexOf('users'), -1, 'R38-02：用户列表不在备份范围内');
  const code = backup.buildCode();
  const plain = Buffer.from(code.slice(backup.CODE_HEAD.length + 1), 'base64url').toString('utf8');
  assertEqual(/passwordHash|passwordSalt|"users"/.test(plain), false,
    'R38-02：实时码里绝不能出现用户表或口令哈希（跨实例搬运等于把「谁能登录」一起搬走）');
});

test('R38-02d · 分享链接 / 订单 / 加密密钥文件不得进入备份', () => {
  const keys = Object.keys(backup.collect()).join(',');
  for (const banned of ['links', 'shareLinks', 'payments', 'orders', 'enc', 'encSettings', 'encMeta', 'secretKeyFile']) {
    assertEqual(keys.includes(banned), false, `R38-02：分区里不得出现「${banned}」`);
  }
  // 「文件加密选项」也不含在内（需求点 2）
  assertEqual(keys.includes('encSettings'), false,
    'R38-02：备份里没有「文件加密选项」——还原了开关却没有 enc.key，只会让系统以为'
    + '文件是加密的、实际一份也解不开');
});

test('R38-02e · 备份载荷的分区集合必须与 SECTIONS 完全一致（不多不少）', () => {
  const keys = Object.keys(backup.collect()).sort();
  assertEqual(keys.join(','), backup.SECTIONS.slice().sort().join(','),
    'R38-02：collect() 产出的键集合必须**恰好**等于 SECTIONS —— 多一个就是偷偷备份了范围外的东西，'
    + '少一个就是备份不完整（两者都不会有任何运行期症状）');
});

/* ==================================================================== */
/* R38-02 · 实时码                                                        */
/* ==================================================================== */

test('R38-02f · 实时码是当前配置的纯函数：改了设置就变，没改就不变', () => {
  const before = backup.buildCode();
  assertEqual(backup.buildCode(), before,
    'R38-02：同一份配置必须得到同一串码 —— 否则页面每刷新一次码就变，'
    + '用户根本分不清「我改了设置」与「它自己又变了」');
  configStore.save({ uploadExcludes: { dsStore: true, thumbsDb: false, gitignore: false } });
  const after = backup.buildCode();
  assert(before !== after, 'R38-02：修改设置后实时码必须立即变化');
  assertEqual(backup.fingerprint(after).length, 12, 'R38-02：指纹是固定 12 位短串（界面展示用）');
  assert(after.length > 60, 'R38-02：实时码应当是「一串长代码」（需求原话）');
});

test('R38-02g · 实时码可自洽解码，且声明的分区与实际内容一致', () => {
  configStore.addCredential({ provider: 'tencent', secretId: DEMO.sid, secretKey: DEMO.skey, quotaBytes: 5368709120 });
  const data = backup.decodeCode(backup.buildCode());
  assertEqual(Object.keys(data).sort().join(','), backup.SECTIONS.slice().sort().join(','),
    'R38-02：码里声明的分区必须与实际内容一致');
  assertEqual(data.credentials.credentials[0].quotaBytes, 5368709120,
    'R38-02：quotaBytes（负载均衡的实体）必须随 API Key 一起被带上');
  assertEqual(data.credentials.credentials[0].speedLimit, 0,
    'R38-02：R37 引入的 speedLimit 也要随记录一起走（否则导入后限速整批丢失）');
});

/* ==================================================================== */
/* R38-02 · 导出码（账户口令 + 独立备份密码）                              */
/* ==================================================================== */

test('R38-02h · 导出码往返一致，且必须用备份密码才能打开', () => {
  const code = backup.buildCode();
  const sealed = backup.seal(code, 'backup-pass-123');
  assertEqual(sealed.startsWith(backup.SEAL_HEAD + '.'), true, 'R38-02：导出码有独立的抬头，便于人眼区分');
  assert(sealed !== code, 'R38-02：导出码必须与实时码不同（前者是密文）');
  const out = backup.open(sealed, 'backup-pass-123');
  assertEqual(JSON.stringify(out), JSON.stringify(backup.decodeCode(code)),
    'R38-02：导出码解出来的内容必须与实时码完全一致');
});

test('R38-02i · 备份密码错误 / 导出码被篡改都必须报错，绝不返回半截配置', () => {
  const sealed = backup.seal(backup.buildCode(), 'backup-pass-123');
  assert.throws(() => backup.open(sealed, 'backup-pass-124'), /密码错误|篡改/,
    'R38-02：密码错必须报错（GCM 认证失败），绝不能解出半截配置 —— 半截配置的导入是破坏性的');

  // 篡改密文段中间一个字符
  const parts = sealed.split('.');
  const head = parts[4].slice(0, 5);
  const tail = parts[4].slice(6);
  const flip = parts[4][5] === 'A' ? 'B' : 'A';
  const tampered = [parts[0], parts[1], parts[2], parts[3], head + flip + tail].join('.');
  assert.throws(() => backup.open(tampered, 'backup-pass-123'), /密码错误|篡改/,
    'R38-02：被改过一个字符的导出码必须认证失败（这就是选 AES-GCM 而不是 CBC 的原因）');

  // 抬头不对：实时码不能被当成导出码导入
  assert.throws(() => backup.open(backup.buildCode(), 'backup-pass-123'), /抬头/,
    'R38-02：把实时码当导出码导入必须被拒 —— 实时码没有完整性保护，谁都能改一个字节再让服务端吃进去');
});

test('R38-02j · 备份密码有长度约束（太短直接拒，不静默接受）', () => {
  assert.throws(() => backup.seal(backup.buildCode(), '1234567'), new RegExp(String(backup.PASSWORD_MIN)),
    'R38-02：备份密码短于下限必须报错，绝不静默接受一个弱口令来保护全部密钥');
  assert.throws(() => backup.seal(backup.buildCode(), 'x'.repeat(backup.PASSWORD_MAX + 1)), /最长/,
    'R38-02：超长也必须拒绝（与 WebDAV 账户口令同一上限，避免同一套界面两种口径）');
});

test('R38-02k · WebDAV 账户口令必须「导出取明文、导入重新封」，不得原样搬密文', () => {
  configStore.addWebdavAccount({ appName: 'app1', username: 'u1', password: DEMO.wdPass });
  configStore.setWebdavEnabled(true);
  const data = backup.decodeCode(backup.buildCode());
  assertEqual(data.webdav.accounts[0].password, DEMO.wdPass,
    'R38-02：备份里的 WebDAV 口令必须是**明文** —— 落盘的 passwordSealed 用本实例主密钥封装，'
    + '原样搬到别的实例只是一段永远解不开的密文（表现为「导入成功、WebDAV 却登录不上」）');
  assertEqual(/passwordSealed/.test(JSON.stringify(data)), false,
    'R38-02：备份里不得出现 passwordSealed');
});

/* ==================================================================== */
/* R38-02 · 导入准入判据                                                  */
/* ==================================================================== */

test('R38-02l · 准入判据「每一项都算数」：只配了任意一项，导入就必须关闭', () => {
  // 判据本身是纯函数（`isEmptyData`），故可以直接构造「全新实例」的载荷来验 ——
  // 而**不是**依赖「本文件前面几条用例碰巧把它配满了」（那种护栏换个执行顺序就假绿）。
  const empty = () => ({
    credentials: { credentials: [], activeCredentialId: '' },
    uploadExcludes: { dsStore: false, thumbsDb: false, gitignore: false },
    captcha: { enabled: false, provider: 'recaptcha', siteKey: '', secretKey: '', timeoutMs: 5000, onError: 'block' },
    webdav: { enabled: false, accounts: [] },
    payment: { enabled: false, platforms: {}, siteUrl: '' },
    buckets: { buckets: [], activeBucketId: '' },
    ipguard: { rules: [] },
  });
  assertEqual(backup.isEmptyData(empty()), true,
    'R38-02：全新实例（备份范围内一项没配）必须**允许**导入 —— 这正是「首次启动并创建用户后」那个窗口');

  // 逐项打开：任何一项都不许被漏掉（漏掉的那一项在导入时会「覆盖了但没提醒」，反过来也会
  // 「明明配过了却仍然允许导入」）
  const cases = [
    ['API Key 管理', (d) => { d.credentials.credentials.push({ id: 'c1', quotaBytes: 0, speedLimit: 0 }); }],
    ['生效密钥 id', (d) => { d.credentials.activeCredentialId = 'c1'; }],
    ['上传排除', (d) => { d.uploadExcludes.dsStore = true; }],
    ['登陆验证', (d) => { d.captcha.siteKey = 'k'; }],
    ['登陆验证（仅启用）', (d) => { d.captcha.enabled = true; }],
    ['WebDAV 开关', (d) => { d.webdav.enabled = true; }],
    ['WebDAV 账户', (d) => { d.webdav.accounts.push({ appName: 'a', username: 'u', password: 'p' }); }],
    ['支付设置', (d) => { d.payment.platforms = { alipay: { appId: 'x' } }; }],
    ['支付站点地址', (d) => { d.payment.siteUrl = 'https://pay.example.com'; }],
    ['存储桶管理', (d) => { d.buckets.buckets.push({ id: 'b1', quotaBytes: 0, speedLimit: 0 }); }],
    ['IP 地址管理', (d) => { d.ipguard.rules.push({ id: 'r1', target: '203.0.113.0/24' }); }],
  ];
  for (const [label, mutate] of cases) {
    const d = empty();
    mutate(d);
    assertEqual(backup.isEmptyData(d), false,
      `R38-02：只要「${label}」已经配过，导入就必须关闭 —— 此时导入会把线上配置整批覆盖掉`);
  }

  // 用户列表**不**影响判据：需求要的正是「创建用户之后」这个时刻
  const withUser = empty();
  withUser.users = [{ username: 'admin1', passwordHash: 'x', passwordSalt: 'y', role: 'admin' }];
  assertEqual(backup.isEmptyData(withUser), true,
    'R38-02：用户不在备份范围内，故「有没有用户」不能影响准入判据');

  // 真实实例此刻已被本文件前面几条用例配过 → 必须已关闭
  assertEqual(backup.canImport(), false, 'R38-02：本实例已配置，canImport 必须为 false');
});

/* ==================================================================== */
/* R38-02 · 导入是覆盖语义                                                */
/* ==================================================================== */

test('R38-02m · 导入必须直接覆盖原有设置项（原有内容全部丢失）', () => {
  // 造一份「备份」，再在实例上覆盖成别的内容，然后导入还原
  configStore.save({ uploadExcludes: { dsStore: true, thumbsDb: true, gitignore: true } });
  const snapshot = backup.decodeCode(backup.buildCode());

  configStore.save({ uploadExcludes: { dsStore: false, thumbsDb: false, gitignore: false } });
  assertEqual(backup.collect().uploadExcludes.dsStore, false, '前置：先把它改掉');

  backup.apply(snapshot);
  const after = backup.collect().uploadExcludes;
  assertEqual(after.dsStore && after.thumbsDb && after.gitignore, true,
    'R38-02：导入必须**覆盖**而不是合并 —— 需求原话「导入配置后，原有设置项将被直接覆盖、全部丢失」');
});

test('R38-02n · 导入后 WebDAV 口令必须能在本实例通过认证（证明重新封过）', async () => {
  const snapshot = backup.decodeCode(backup.buildCode());
  backup.apply(snapshot);
  const r = await configStore.authenticateWebdav('u1', DEMO.wdPass);
  assertEqual(r.ok, true,
    'R38-02：导入后 WebDAV Basic 认证必须通过 —— 这证明导入走的是 addWebdavAccount（用**本实例**主密钥重新封），'
    + '而不是把备份里的密文原样塞回去');
});

test('R38-02o · 导入后 IP 规则必须真实生效，且保留原 id 与启用状态', () => {
  const blk = ipGuard.addRule({ target: '203.0.113.0/24', remark: '导入用屏蔽规则' });
  const off = ipGuard.addRule({ target: '198.51.100.7', kind: 'speed', speedLimit: 1048576 });
  ipGuard.setRuleEnabled(off.id, false);
  const snapshot = backup.decodeCode(backup.buildCode());
  ipGuard.replaceAllRules([]); // 先清空，证明是导入把它带回来的
  assertEqual(ipGuard.evaluate('203.0.113.9', 'GET').ok, true, '前置：清空后该 IP 已放行');

  backup.apply(snapshot);
  const rules = ipGuard.listRules();
  const speed = rules.find((r) => r.target === '198.51.100.7');
  const block = rules.find((r) => r.target === '203.0.113.0/24');
  assert(speed && block, 'R38-02：导入必须带回屏蔽 / 限速规则');
  assertEqual(block.id, blk.id, 'R38-02：规则 id 必须保留（否则引用它的地方会悬空）');
  assertEqual(speed.id, off.id, 'R38-02：同上');
  assertEqual(speed.enabled, false,
    'R38-02：**停用状态必须保留** —— 一条被刻意停用的屏蔽规则在导入后悄悄生效，'
    + '用户只会觉得「导入把配置弄坏了」');
  assertEqual(ipGuard.evaluate('203.0.113.9', 'GET').ok, false,
    'R38-02：导入进来的屏蔽规则必须**真的拦得住**（不是只在列表里显示一条）');
});

test('R38-02p · 导入后 activeCredentialId / activeBucketId 不得悬空', () => {
  const c = configStore.addCredential({ provider: 'tencent', secretId: 'demo-access-id-0002', secretKey: 'demo-access-key-0002' });
  configStore.addBucket({ provider: 'tencent', bucket: 'demo-bucket-0002', region: 'ap-guangzhou' });
  const snapshot = backup.decodeCode(backup.buildCode());
  // 把「生效 id」故意改成不存在的值，导入后必须被纠正回来
  snapshot.credentials.activeCredentialId = 'not-exist';
  snapshot.buckets.activeBucketId = 'not-exist';
  backup.apply(snapshot);
  const cfg = configStore.load();
  const credOk = cfg.credentials.some((x) => x.id === cfg.activeCredentialId);
  const bkOk = cfg.buckets.some((x) => x.id === cfg.activeBucketId);
  assertEqual(credOk, true, 'R38-02：生效密钥 id 必须指向一条真实记录（悬空 id 会让「当前密钥」变成空）');
  assertEqual(bkOk, true, 'R38-02：生效桶 id 同上');
  assert(c, '前置：密钥已建立');
});

/* ==================================================================== */
/* R38-02 · 路由层                                                        */
/* ==================================================================== */

test('R38-02q · 备份相关接口一律 requireAdmin（普通用户 403）', async () => {
  const s = await serveBackup({ id: 'u-demo', username: 'user1', role: 'user' });
  try {
    for (const [m, p] of [['GET', '/backup/status'], ['GET', '/backup/code'], ['POST', '/backup/export'], ['POST', '/backup/import']]) {
      const r = await request(s.port, m, p, { body: m === 'POST' ? {} : null });
      assertEqual(r.status, 403,
        `R38-02：${m} ${p} 必须拒绝普通用户 —— 实时码里含 API Key / 支付凭证 / WebDAV 口令的明文`);
      assertEqual(r.json.error, '仅管理员可执行该操作', 'R38-02：拒绝文案与其它管理接口同形');
    }
  } finally { await s.close(); }
});

test('R38-02r · 导出必须校验账户口令：口令错 → 403 且不产生任何导出码', async () => {
  await configStore.addUser({ username: 'admin1', password: 'Admin-Pass-12345', role: 'admin' });
  const me = configStore.load().users.find((u) => u.username === 'admin1');
  const s = await serveBackup({ id: me.id, username: 'admin1', role: 'admin' });
  try {
    const bad = await request(s.port, 'POST', '/backup/export', {
      body: { password: 'wrong-account-pass', backupPassword: 'backup-pass-123' },
    });
    assertEqual(bad.status, 403, 'R38-02：账户口令错误必须 403');
    assertEqual(bad.json.code, undefined, 'R38-02：口令错时绝不能把导出码回给客户端');

    const good = await request(s.port, 'POST', '/backup/export', {
      body: { password: 'Admin-Pass-12345', backupPassword: 'backup-pass-123' },
    });
    assertEqual(good.status, 200, 'R38-02：账户口令正确时应返回导出码');
    assertEqual(String(good.json.code).startsWith(backup.SEAL_HEAD + '.'), true, 'R38-02：返回的是加密导出码');
    const opened = backup.open(good.json.code, 'backup-pass-123');
    assert(Object.keys(opened).length > 0, 'R38-02：导出码必须能用备份密码解开（闭环验证）');
  } finally { await s.close(); }
});

test('R38-02s · 导入在「已有配置」的实例上必须 409，且不能落盘任何东西', async () => {
  const me = configStore.load().users.find((u) => u.username === 'admin1');
  const s = await serveBackup({ id: me.id, username: 'admin1', role: 'admin' });
  try {
    const snapshot = backup.buildCode();
    const sealed = backup.seal(snapshot, 'backup-pass-123');
    const before = backup.buildCode();
    const r = await request(s.port, 'POST', '/backup/import', { body: { code: sealed, backupPassword: 'backup-pass-123' } });
    assertEqual(r.status, 409, 'R38-02：已配置实例必须拒绝导入（覆盖不可撤销）');
    assertMatch(r.json.error, /覆盖|全新/,
      'R38-02：拒绝文案必须说明「为什么不行 + 该怎么办」。'
      + '⚠️ 判据只能是状态码 409 —— `apiHandler` 只下发 `{ error }`，'
      + '挂在错误对象上的结构化标志到不了客户端（本项目已吃过一次亏）');
    assertEqual(backup.buildCode(), before, 'R38-02：被拒的导入绝不能改动任何配置');
  } finally { await s.close(); }
});

test('R38-02t · status 接口现算准入判据（不缓存）', async () => {
  const me = configStore.load().users.find((u) => u.username === 'admin1');
  const s = await serveBackup({ id: me.id, username: 'admin1', role: 'admin' });
  try {
    const r = await request(s.port, 'GET', '/backup/status');
    assertEqual(r.status, 200, 'R38-02：status 应可读');
    assertEqual(r.json.canImport, false, 'R38-02：本实例已配置，状态必须是「不可导入」');
    assertEqual(r.json.scopes.join('|'), backup.SCOPES.map((x) => x.label).join('|'),
      'R38-02：界面清单直接取服务端定义（单一实现点），不在前端再抄一份');
    await wait(1);
  } finally { await s.close(); }
});

/* ==================================================================== */
/* R38-02 · 界面与文案                                                    */
/* ==================================================================== */

test('R38-02u · 「备份配置」卡片必须位于「关于」卡片**上方**', () => {
  const html = read(path.join(ROOT, 'public', 'index.html'));
  const backupPos = html.indexOf('id="sysset-backup-card"');
  const aboutPos = html.indexOf('class="sysset-tag about"');
  assert(backupPos > 0, 'R38-02：设置页必须有 id="sysset-backup-card" 的卡片');
  assert(aboutPos > 0, 'R38-02：应能定位到「关于」卡片');
  assert(backupPos < aboutPos,
    'R38-02：需求要求备份卡片在「关于」上方，而「关于」还必须留在设置页最末（R34 的既有约束）');
});

test('R38-02v · 三点提示必须逐条出现在界面上', () => {
  const html = read(path.join(ROOT, 'public', 'index.html'));
  // ① 分享链接与订单属运行时数据；2MB 请求体上限
  assert(html.includes('2MB') && html.includes('分享链接') && html.includes('订单'),
    'R38-02：必须写明「分享链接和订单属运行时数据，全量备份将触及 2MB 请求体上限，故不在备份范围内」');
  // ② 密钥文件无法也绝不能备份；备份文件加密选项与用户列表没有意义
  assert(html.includes('密钥文件') && html.includes('绝不能备份') && html.includes('用户列表'),
    'R38-02：必须写明「文件和用户相关的密钥文件无法备份也绝不能备份，故备份文件加密选项和用户列表没有意义」');
  // ③ 导入直接覆盖、全部丢失
  assert(html.includes('覆盖') && html.includes('全部丢失'),
    'R38-02：必须写明「导入配置后，原有设置项将被直接覆盖、全部丢失」');
});

test('R38-02w · 备份卡片必须是仅管理员可见（纳入 ADMIN_ONLY_CARDS）', () => {
  const js = read(path.join(ROOT, 'public', 'js', 'syssettings.js'));
  assertMatch(js, /ADMIN_ONLY_CARDS\s*=\s*\[[^\]]*'sysset-backup-card'/,
    'R38-02：实时码含密钥明文，卡片必须随角色整卡显隐（普通用户看不到入口与内容）');
  const front = read(path.join(ROOT, 'public', 'js', 'backupcfg.js'));
  assertMatch(front, /export function refresh/,
    'R38-02：前端模块必须导出 refresh（供 switchMainView / refresh 调用）');
  assertMatch(front, /export function reset/,
    'R38-02：前端模块必须导出 reset（换账号时清掉上一份实时码，与其它模块同一约定）');
});

test('R38-02x · 导入不得动用户表（万一被清空 = 零管理员 → 永久锁死）', () => {
  // 需求把「所有用户」排除在备份之外 —— 于是 `apply()` **只覆盖备份范围里的顶层键**。
  // 这条性质一旦破掉，后果不是「某个设置没还原」，而是把系统导成**零管理员**：
  // 管理页面打不开、也没有任何自助恢复通道，只能去手工改 data/ 下的密文。
  const ids = (cfg) => (cfg.users || []).map((u) => u.id).sort().join(',');
  const before = ids(configStore.load());
  assert(before.length > 0, '前置：本实例上应当已有用户（否则这条断言是空的）');

  const snapshot = backup.decodeCode(backup.buildCode());
  // 即便载荷里被人塞了一张用户表，导入也不得据此顶替或清空本机的用户
  snapshot.users = [{ id: 'injected-by-backup', username: 'injected', role: 'admin' }];
  backup.apply(snapshot);

  assertEqual(ids(configStore.load()), before,
    'R38-02：导入必须只覆盖备份范围内的顶层键 —— 用户表既不能被清空，也不能被载荷里的内容顶替');
});
