/**
 * 第四十一轮 · 用户报障的两件事（R41-01 / R41-02）
 *
 * ## R41-01 · Google reCAPTCHA 卡在「正在加载人机验证组件…」
 *
 * 现场（无头 Chrome + DevTools 协议实测，两轮 A/B）：
 * ```
 * ########## 当前线上那份 CSP ##########
 * SCRIPT_LOAD
 * VIOLATION script-src-elem :: https://www.gstatic.cn/recaptcha/releases/<ver>/recaptcha__zh_cn.js
 * RESULT_POLL_EXHAUSTED          elapsed=20280ms     ← 用户看到的就是这个
 * ########## script-src 补上 www.gstatic.cn ##########
 * SCRIPT_LOAD  ONLOAD_CALLBACK  READY after 676ms   RESULT_READY
 * ```
 * 机制：`https://www.recaptcha.net/recaptcha/api.js` 只是**引导脚本**（1040 字节），
 * 它自己再去注入真正的实现 `recaptcha/releases/<版本>/recaptcha__*.js`；
 * 该实现在中国大陆被解析到 **`www.gstatic.cn`**（境外 `www.gstatic.com`；同一份内容、
 * 两边都是 HTTP 200 / 858138 字节）。而 CSP 的 host-source 是**精确匹配**，
 * 站点里只列了 `www.gstatic.com` ⇒ 实现脚本被拦 ⇒ `grecaptcha` 永不 ready。
 *
 * ⚠️ 这条正是 R14-02 的**盲区**：R14-02 只比对了 `main.js` 里那几个**引导脚本**的
 * 来源，而实现脚本的域名是 Google 的加载器**运行期**决定的，源码里根本搜不到 ——
 * 「判据落在源码这一层、而故障发生在运行期」= 典型的判据没落在被执行的那一层。
 * 因此这里改成：**先按 CSP 语义把 host-source 拆成集合**，再要求集合里
 * 同时含有实现脚本的两个可能来源，并附「取法自证」防止提取失效后假绿。
 *
 * ## R41-02 · 两种服务的配置必须各自独立保存
 *
 * 需求原文：「Google reCAPTCHA 和 Cloudflare Turnstile 应该是两个独立的配置项：
 * 应该让用户可以同时保存两种验证码配置，然后选择使用其中一项。」
 * 旧结构是**扁平**的 `{ provider, siteKey, secretKey }` —— 换服务商就等于重填密钥。
 * 新结构 `providers[provider] = { siteKey, secretKey }`，`provider` 只决定登录页用哪一套。
 * ------------------------------------------------------------------ */
const fs = require('fs');
const path = require('path');
const test = require('node:test');

require('./helpers'); // 兜底 COS_DATA_DIR 到临时目录

const { assert, assertEqual, request } = require('./helpers');
const { express } = require('../server/routes/_context');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const captcha = require('../server/captcha.js');
const configStore = require('../server/config-store.js');
const backup = require('../server/backup.js');

/** 清掉验证码相关的环境变量，保证用例之间不串味 */
function clearEnv() {
  for (const k of ['CAPTCHA_PROVIDER', 'CAPTCHA_SITE_KEY', 'CAPTCHA_SECRET_KEY', 'CAPTCHA_ENABLED']) {
    delete process.env[k];
  }
}

/** 在指定环境变量下执行（结束即还原），用于验证「环境变量优先级」相关行为 */
function withCapEnv(env, fn) {
  clearEnv();
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  try {
    return fn();
  } finally {
    clearEnv();
    for (const k of Object.keys(saved)) if (saved[k] !== undefined) process.env[k] = saved[k];
  }
}

/* ==================================================================== */
/* R41-01 · CSP 必须放行 reCAPTCHA 的**实现脚本**                        */
/* ==================================================================== */

/** reCAPTCHA 实现脚本的两个来源：境外 gstatic.com、中国大陆 gstatic.cn */
const RECAPTCHA_IMPL_ORIGINS = ['https://www.gstatic.com', 'https://www.gstatic.cn'];

/**
 * 剥掉块注释与行注释。
 *
 * ⚠️ 必须剥：`server/index.js` 的 CSP 那段注释里本身就写着 `script-src` 与
 * `unsafe-inline`，不剥就会被注释抢先命中，判据落到注释上 = 假绿（R40 踩过）。
 */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * 按 **CSP 语义**取出 `script-src` 的 host-source 集合（不是「源码里有没有这段字样」）。
 * @returns {{set: Set<string>, raw: string}}
 */
function scriptSrcOrigins(idxSrc) {
  const t = stripComments(idxSrc);
  const m = /script-src([^;\n]*)/.exec(t);
  assert(m, 'server/index.js 里应存在 CSP 的 script-src 段（提取不到 = 本条检查已失效）');
  const raw = m[1];
  const set = new Set(raw.split(/\s+/).filter((s) => /^https?:\/\//.test(s)));
  return { set, raw };
}

test('R41-01 · CSP script-src 必须同时放行 reCAPTCHA 实现脚本的境内/境外来源', () => {
  const { set, raw } = scriptSrcOrigins(read('server/index.js'));

  // 取法自证：确认这段确实是 script-src 的**值**而不是别的指令 / 注释残渣
  assert(set.has('https://www.recaptcha.net') && set.has('https://challenges.cloudflare.com'),
    `取法自证：script-src 段应含两个引导脚本来源（recaptcha.net / challenges.cloudflare.com），`
    + `实际取到：${raw.trim()} —— 取不到说明本检查的提取已失效，不得当作通过`);

  for (const origin of RECAPTCHA_IMPL_ORIGINS) {
    assert(set.has(origin),
      `R41-01：CSP 的 script-src 必须包含 ${origin} —— reCAPTCHA 的加载器会根据所在地`
      + `注入 gstatic.com（境外）或 gstatic.cn（中国大陆）上的实现脚本，少一个都会让`
      + `该地区的用户卡在「正在加载人机验证组件…」；host-source 是精确匹配，`
      + `写法必须与这里逐字一致（含 www）。实际 script-src：${raw.trim()}`);
  }
});

test('R41-01 · 实现脚本域名必须确实被拦过：负向对照（撤掉 gstatic.cn 即失守）', () => {
  // 负向对照：把 www.gstatic.cn 从 script-src 里删掉，本条判据必须变红 ——
  // 否则这条护栏只是「碰巧为真」，改坏了也发现不了。
  const src = read('server/index.js');
  const broken = src.replace(' https://www.gstatic.cn', '');
  assertEqual(broken === src, false,
    'R41-01：负向对照的前提是把 gstatic.cn 从 CSP 里删得掉 —— 删不掉说明构建方式已变，需同步修本条');
  const { set } = scriptSrcOrigins(broken);
  assertEqual(set.has('https://www.gstatic.cn'), false, 'R41-01：撤掉后集合里就不该再有它');
});

/* ==================================================================== */
/* R41-02 · 两套凭证各自独立保存 / 任选其一                              */
/* ==================================================================== */

test('R41-02a · saveCaptcha：写一家不得动另一家；切换 provider 只换生效的那一套', () => {
  clearEnv();
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: { recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret' } },
  });
  // 再配 Turnstile：reCAPTCHA 那一套必须原样保留
  const afterTs = configStore.saveCaptcha({
    providers: { turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret' } },
  });
  assertEqual(afterTs.providers.recaptcha.siteKey, 'rec-key',
    'R41-02：保存 Turnstile 时不得清空 reCAPTCHA 的站点密钥 —— 那正是「两套同时保存」的前提');
  assertEqual(afterTs.providers.recaptcha.secretKey, 'rec-secret', 'R41-02：reCAPTCHA 的服务端密钥同理');
  assertEqual(afterTs.providers.turnstile.siteKey, 'ts-key', 'R41-02：Turnstile 的站点密钥应已保存');

  // 切换生效方：只应改 provider，两套凭证都不许动
  const switched = configStore.saveCaptcha({ provider: 'turnstile' });
  assertEqual(switched.provider, 'turnstile', 'R41-02：provider 应切换到 turnstile');
  assertEqual(switched.siteKey, 'ts-key', 'R41-02：切换后「生效的那一套」应变成 Turnstile 的站点密钥');
  assertEqual(switched.secretKey, 'ts-secret', 'R41-02：服务端密钥同理');
  assertEqual(switched.providers.recaptcha.siteKey, 'rec-key', 'R41-02：切换生效方不得动另一套的站点密钥');
  assertEqual(switched.providers.recaptcha.secretKey, 'rec-secret', 'R41-02：另一套的服务端密钥同理');

  // 切回来必须还是原来那一套（否则「切换」等于「重填」）
  const back = configStore.saveCaptcha({ provider: 'recaptcha' });
  assertEqual(back.siteKey, 'rec-key', 'R41-02：切回 reCAPTCHA 必须复原它自己的站点密钥');
  assertEqual(back.secretKey, 'rec-secret', 'R41-02：切回 reCAPTCHA 必须复原它自己的服务端密钥');
});

test('R41-02b · saveCaptcha：留空 = 保持原密钥（绝不能变成清空），null 才是清除', () => {
  clearEnv();
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret' },
    },
  });
  // 界面每次保存都会带上两家的 siteKey、而密码框恒为空串
  const kept = configStore.saveCaptcha({
    providers: { recaptcha: { siteKey: 'rec-key', secretKey: '' }, turnstile: { siteKey: 'ts-key', secretKey: '' } },
  });
  assertEqual(kept.providers.recaptcha.secretKey, 'rec-secret',
    'R41-02：空串必须表示「保持原密钥」—— 否则管理员只改一下超时时间就会把密钥清空，登录立即锁死');
  assertEqual(kept.providers.turnstile.secretKey, 'ts-secret', 'R41-02：Turnstile 那套同理');

  const cleared = configStore.saveCaptcha({ providers: { recaptcha: { secretKey: null } } });
  assertEqual(cleared.providers.recaptcha.secretKey, '', 'R41-02：null 才是显式清除');
  assertEqual(cleared.providers.turnstile.secretKey, 'ts-secret', 'R41-02：清除一家不得连带清掉另一家');
});

test('R41-02c · 向后兼容：旧的扁平配置**从磁盘读回**后被迁进 providers[provider]', () => {
  clearEnv();

  // 真实地造一份 1.6.3 形态的 config.enc（顶层扁平 siteKey/secretKey），
  // 走加密原语直接落盘 —— 而不是 `save()`，因为 `save()` 自己就会归一，
  // 那样测的只是「save 的归一」而**测不到读盘迁移**（升级用户的真实路径）。
  const storePath = require.resolve('../server/config-store.js');
  const legacy = Object.assign({}, configStore.load(), {
    captcha: { enabled: true, provider: 'turnstile', siteKey: 'legacy-key', secretKey: 'legacy-secret', timeoutMs: 5000, onError: 'block' },
  });
  configStore.flush();
  fs.writeFileSync(path.join(process.env.COS_DATA_DIR, 'config.enc'), configStore.encrypt(legacy));

  // 丢掉模块缓存 ⇒ 新实例首次 `load()` 必须真的从磁盘解密 + normalize
  const original = require.cache[storePath];
  delete require.cache[storePath];
  const fresh = require(storePath);
  require.cache[storePath] = original; // 还原，免得后续 require 拿到这份临时实例

  const c = fresh.getCaptcha();
  assertEqual(c.providers.turnstile.siteKey, 'legacy-key',
    'R41-02：历史扁平配置必须被迁进**它当时选中的那一套**（turnstile），否则升级后密钥凭空消失');
  assertEqual(c.providers.turnstile.secretKey, 'legacy-secret', 'R41-02：服务端密钥同理');
  assertEqual(c.providers.recaptcha.siteKey, '', 'R41-02：另一家不该被凭空填入');
  assertEqual(c.siteKey, 'legacy-key', 'R41-02：派生视图仍应给出「生效那一套」的值（旧调用方兼容）');

  // 落盘归一后不得再留着扁平键：否则「扁平键 + providers」两个真相迟早会打架
  const raw = fresh.load();
  assertEqual(raw.captcha.siteKey, undefined, 'R41-02：归一化后不应再保留顶层扁平 siteKey');
  assertEqual(raw.captcha.secretKey, undefined, 'R41-02：归一化后不应再保留顶层扁平 secretKey');
});

test('R41-02c2 · save() 的部分写入也必须归一：不得留下「扁平键 + providers」两个真相', () => {
  clearEnv();
  // 先配好 Turnstile（providers 里有记录）
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: { turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret' } },
  });
  // 再走通用 `save({ captcha: {…扁平键…} })` —— 归一后必须读得到这次写入的值
  configStore.save({ captcha: { enabled: false, provider: 'recaptcha', siteKey: 'flat-key', secretKey: 'flat-secret' } });
  const c = configStore.getCaptcha();
  assertEqual(c.providers.recaptcha.siteKey, 'flat-key',
    'R41-02：走 save() 的扁平键写入必须**真的生效** —— 否则「存了但没生效」，界面显示已保存、登录页却拿不到 siteKey');
  assertEqual(c.providers.recaptcha.secretKey, 'flat-secret', 'R41-02：服务端密钥同理');
  assertEqual(configStore.load().captcha.siteKey, undefined,
    'R41-02：写完之后不得还留着扁平键（读取侧只认 providers，留着它就是第二个真相）');
});

test('R41-02d · resolveConfig：CAPTCHA_PROVIDER 切到另一家时，取的是**那一家**的密钥', () => {
  clearEnv();
  // 存储里选的是 reCAPTCHA，但环境变量把它切到 Turnstile
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret' },
    },
  });

  withCapEnv({ CAPTCHA_PROVIDER: 'turnstile' }, () => {
    const c = captcha.resolveConfig(configStore);
    assertEqual(c.provider, 'turnstile', 'R41-02：环境变量应把生效服务商切到 turnstile');
    assertEqual(c.siteKey, 'ts-key',
      'R41-02：必须取**切换后**那一家的站点密钥 —— 先取密钥再定 provider 会取成 reCAPTCHA 那套，'
      + '而前端会拿着 reCAPTCHA 的 siteKey 去渲染 Turnstile 组件（直接渲染失败）');
    assertEqual(c.secretKey, 'ts-secret', 'R41-02：服务端密钥同理');
    assertEqual(captcha.publicConfig(configStore).siteKey, 'ts-key', 'R41-02：下发给登录页的也必须是这一套');
  });

  // 无环境变量时按存储值走
  const c = captcha.resolveConfig(configStore);
  assertEqual(c.provider, 'recaptcha', 'R41-02：没有环境变量时按存储的 provider 走');
  assertEqual(c.siteKey, 'rec-key', 'R41-02：取 reCAPTCHA 自己那一套');
  assertEqual(c.secretKey, 'rec-secret', 'R41-02：服务端密钥同理');
});

test('R41-02e · resolveConfig：环境变量里的密钥覆盖**选中那一套**（作用域不得张冠李戴）', () => {
  clearEnv();
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret' },
    },
  });

  withCapEnv({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: 'env-key', CAPTCHA_SECRET_KEY: 'env-secret' }, () => {
    const c = captcha.resolveConfig(configStore);
    assertEqual(c.provider, 'turnstile', 'R41-02：生效服务商应为 turnstile');
    assertEqual(c.siteKey, 'env-key', 'R41-02：环境变量必须覆盖选中的这一套');
    assertEqual(c.secretKey, 'env-secret', 'R41-02：服务端密钥同理');
  });

  // 只覆盖 siteKey 时，secretKey 仍应来自存储里**选中那一套**
  withCapEnv({ CAPTCHA_PROVIDER: 'turnstile', CAPTCHA_SITE_KEY: 'env-key' }, () => {
    const c = captcha.resolveConfig(configStore);
    assertEqual(c.siteKey, 'env-key', 'R41-02：只覆盖了 siteKey');
    assertEqual(c.secretKey, 'ts-secret', 'R41-02：未覆盖的字段应落到 Turnstile 自己那一套，而不是 reCAPTCHA 的');
  });
});

/* ==================================================================== */
/* R41-02f · 路由：两套凭证的视图 + 明文密钥永不出服务端                 */
/* ==================================================================== */

/** 起一个只有 captcha 路由的 app，并注入指定角色的 req.authUser */
async function serveCaptcha(role) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => { req.authUser = role || null; next(); });
  delete require.cache[require.resolve('../server/routes/captcha.js')];
  app.use(require('../server/routes/captcha.js'));
  app.use((err, req, res, next) => {
    res.status((err && err.status) || 500).json({ error: (err && err.message) || 'ERR' });
  });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  return { port: srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}

const ADMIN = { username: 'admin1', role: 'admin' };

test('R41-02f · GET /captcha/config 下发两套视图，且任何情况下不含明文密钥', async () => {
  clearEnv();
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret-plain' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret-plain' },
    },
  });

  const s = await serveCaptcha(ADMIN);
  try {
    const r = await request(s.port, 'GET', '/captcha/config');
    assertEqual(r.status, 200, 'R41-02：管理员应能读取验证码配置');
    assertEqual(r.json.providers.recaptcha.siteKey, 'rec-key', 'R41-02：reCAPTCHA 的 siteKey 应下发');
    assertEqual(r.json.providers.turnstile.siteKey, 'ts-key', 'R41-02：Turnstile 的 siteKey 也应下发');
    assertEqual(r.json.providers.recaptcha.hasSecret, true, 'R41-02：只回「有没有」，不回明文');
    assertEqual(r.json.providers.turnstile.hasSecret, true, 'R41-02：Turnstile 同理');
    // 顶部派生值 = 选中那一套（兼容旧前端）
    assertEqual(r.json.siteKey, 'rec-key', 'R41-02：顶层 siteKey 应为选中那一套的派生值');
    assertEqual(r.json.hasSecret, true, 'R41-02：顶层 hasSecret 同上');
    // 明文密钥绝不出服务端
    assertEqual(/rec-secret-plain|ts-secret-plain/.test(r.raw), false,
      'R41-02：响应里绝不允许出现明文 secretKey —— 它只用于服务端回源校验');
  } finally { await s.close(); }
});

test('R41-02g · PUT /captcha/config：两套一并保存；未知服务商与越界超时必须被拒', async () => {
  clearEnv();
  const s = await serveCaptcha(ADMIN);
  try {
    const ok = await request(s.port, 'PUT', '/captcha/config', {
      body: {
        enabled: true, provider: 'turnstile', timeoutMs: 6000, onError: 'block',
        providers: {
          recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret-plain' },
          turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret-plain' },
        },
      },
    });
    assertEqual(ok.status, 200, 'R41-02：正常保存应 200');
    assertEqual(ok.json.providers.recaptcha.siteKey, 'rec-key', 'R41-02：两套都应落盘并回帧');
    assertEqual(ok.json.providers.turnstile.siteKey, 'ts-key', 'R41-02：两套都应落盘并回帧');
    assertEqual(ok.json.provider, 'turnstile', 'R41-02：生效方应为 turnstile');
    assertEqual(ok.json.effective.provider, 'turnstile', 'R41-02：登录页生效视图应同步');
    assertEqual(/rec-secret-plain|ts-secret-plain/.test(ok.raw), false, 'R41-02：回帧同样不得含明文密钥');

    // 只改一家时，另一家必须原样保留
    const only = await request(s.port, 'PUT', '/captcha/config', {
      body: { providers: { recaptcha: { siteKey: 'rec-key-2' } } },
    });
    assertEqual(only.status, 200, 'R41-02：只提交一家也应成功');
    assertEqual(only.json.providers.recaptcha.siteKey, 'rec-key-2', 'R41-02：应更新这一家');
    assertEqual(only.json.providers.recaptcha.hasSecret, true, 'R41-02：未提交的 secretKey 应保持');
    assertEqual(only.json.providers.turnstile.siteKey, 'ts-key', 'R41-02：未提交的那一家必须原样保留');

    // 密码框留空 = 保持（界面上这两个框本来就永远不回填明文，每次保存都提交空串）
    const cached = await request(s.port, 'PUT', '/captcha/config', {
      body: { providers: { recaptcha: { siteKey: 'rec-key-2', secretKey: '' }, turnstile: { siteKey: 'ts-key', secretKey: '' } } },
    });
    assertEqual(cached.status, 200, 'R41-02：带空 secretKey 的保存应成功');
    assertEqual(cached.json.providers.recaptcha.hasSecret, true,
      'R41-02：空串 = 保持原密钥 —— 若被当成清除，管理员每改一次超时时间就把密钥清空，登录直接锁死');
    assertEqual(cached.json.providers.turnstile.hasSecret, true, 'R41-02：Turnstile 那套同理');

    const bad = await request(s.port, 'PUT', '/captcha/config', {
      body: { providers: { nosuch: { siteKey: 'x' } } },
    });
    assertEqual(bad.status, 400, 'R41-02：未知服务商必须 400，不得静默忽略（否则界面以为存上了）');

    const badTimeout = await request(s.port, 'PUT', '/captcha/config', { body: { timeoutMs: 99999 } });
    assertEqual(badTimeout.status, 400, 'R41-02：越界超时必须 400');
  } finally { await s.close(); }
});

test('R41-02h · GET /captcha/public 只下发选中那一套（登录页拿不到另一家的密钥）', async () => {
  clearEnv();
  configStore.saveCaptcha({
    enabled: true, provider: 'turnstile',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret-plain' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret-plain' },
    },
  });
  const s = await serveCaptcha(null); // 匿名
  try {
    const r = await request(s.port, 'GET', '/captcha/public');
    assertEqual(r.status, 200, 'R41-02：公开视图应匿名可取');
    assertEqual(r.json.provider, 'turnstile', 'R41-02：登录页应按选中那一套渲染');
    assertEqual(r.json.siteKey, 'ts-key', 'R41-02：只下发选中的那一家');
    assertEqual(r.json.available, true, 'R41-02：已启用且有 siteKey ⇒ available');
    assertEqual(/rec-secret-plain|ts-secret-plain|rec-key/.test(r.raw), false,
      'R41-02：公开视图里不得出现任何服务端密钥，也不该泄漏另一家的 siteKey');
  } finally { await s.close(); }
});

/* ==================================================================== */
/* R41-02i · 备份：两套凭证一起走、一起回                                */
/* ==================================================================== */

test('R41-02i · 备份导出/导入：两套凭证必须完整往返（且为空判据覆盖两套）', () => {
  clearEnv();
  configStore.saveCaptcha({
    enabled: true, provider: 'recaptcha',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret-plain' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret-plain' },
    },
  });

  const data = backup.decodeCode(backup.buildCode());
  assertEqual(data.captcha.providers.recaptcha.siteKey, 'rec-key', 'R41-02：备份应导出 reCAPTCHA 那一套');
  assertEqual(data.captcha.providers.turnstile.siteKey, 'ts-key',
    'R41-02：备份必须带上另一家 —— 否则恢复后管理员得把第二套密钥重新申请一遍');
  assertEqual(data.captcha.providers.turnstile.secretKey, 'ts-secret-plain', 'R41-02：服务端密钥随备份走');

  // 先换一套完全不同的配置，再导入，验证「导入后两套都回来了」
  configStore.saveCaptcha({
    providers: {
      recaptcha: { siteKey: 'X', secretKey: null },
      turnstile: { siteKey: 'Y', secretKey: null },
    },
  });
  const before = configStore.getCaptcha();
  assertEqual(before.providers.recaptcha.secretKey, '', 'R41-02：前置条件 —— 两家的密钥都已清掉');

  backup.apply(data);
  const after = configStore.getCaptcha();
  assertEqual(after.providers.recaptcha.secretKey, 'rec-secret-plain', 'R41-02：导入后 reCAPTCHA 那一套应复原');
  assertEqual(after.providers.turnstile.siteKey, 'ts-key', 'R41-02：导入后 Turnstile 那一套也应复原');
  assertEqual(after.providers.turnstile.secretKey, 'ts-secret-plain', 'R41-02：服务端密钥同理');

  // 空判据必须覆盖两套：只配了 Turnstile 也必须算「已配置」（否则导入会静默覆盖掉它）
  const blank = () => ({
    credentials: { credentials: [], activeCredentialId: '' },
    uploadExcludes: { dsStore: false, thumbsDb: false, gitignore: false },
    captcha: { enabled: false, provider: 'recaptcha', providers: { recaptcha: { siteKey: '', secretKey: '' }, turnstile: { siteKey: '', secretKey: '' } }, timeoutMs: 5000, onError: 'block' },
    webdav: { enabled: false, accounts: [] },
    payment: { enabled: false, platforms: {}, siteUrl: '' },
    buckets: { buckets: [], activeBucketId: '' },
    ipguard: { rules: [] },
  });
  assertEqual(backup.isEmptyData(blank()), true, 'R41-02：全新载荷应判为空');
  const onlyTs = blank();
  onlyTs.captcha.providers.turnstile.siteKey = 'k';
  assertEqual(backup.isEmptyData(onlyTs), false,
    'R41-02：只配了 Turnstile 也算「已配置」—— 漏判会让导入静默覆盖掉这一套');
  const legacy = blank();
  legacy.captcha.siteKey = 'k'; // 旧载荷的扁平键
  assertEqual(backup.isEmptyData(legacy), false, 'R41-02：旧载荷的扁平键同样必须算数（向后兼容）');
});

/* ==================================================================== */
/* R41-02j · 前端：静态契约                                             */
/* ==================================================================== */

test('R41-02j · 前端卡片必须同时存在两套输入框，且 id 由同一份服务商清单拼出', () => {
  const html = read('public/index.html');
  for (const p of ['recaptcha', 'turnstile']) {
    for (const kind of ['sitekey', 'secretkey', 'secret-state']) {
      const id = `captcha-${kind}-${p}`;
      assertEqual(html.indexOf('id="' + id + '"') !== -1, true,
        `R41-02：卡片里必须存在 #${id} —— 两套独立配置在界面上就是两组各不相同的输入框`);
    }
  }
  assertEqual(html.indexOf('id="captcha-sitekey"') === -1, true,
    'R41-02：旧的单套输入框 #captcha-sitekey 必须消失，否则会出现「两套 + 一套」的第三种真相');

  const js = read('public/js/syssettings.js');
  assert(/const CAPTCHA_PROVIDERS = \['recaptcha', 'turnstile'\]/.test(js),
    'R41-02：前端应有唯一一份服务商清单（元素 id 由它拼出，增删服务商只改一处）');
  assert(/captcha-sitekey-' \+ p/.test(js) && /captcha-secretkey-' \+ p/.test(js),
    'R41-02：回填与读取都必须按服务商拼 id，不得写死某一家');
});

/* ==================================================================== */
/* 收尾：模块自证                                                        */
/* ==================================================================== */

test('R41 · 模块自证：captcha.resolveConfig 取到的两套密钥来源正确', () => {
  clearEnv();
  configStore.saveCaptcha({
    provider: 'recaptcha',
    providers: {
      recaptcha: { siteKey: 'rec-key', secretKey: 'rec-secret' },
      turnstile: { siteKey: 'ts-key', secretKey: 'ts-secret' },
    },
  });
  const c = captcha.resolveConfig(configStore);
  assertEqual(c.siteKey, 'rec-key', 'R41：默认选中的是 reCAPTCHA 那一套');
  assertEqual(c.secretKey, 'rec-secret', 'R41：服务端校验用的也是那一套的密钥');
  assertEqual(captcha.VERIFY_ENDPOINTS.recaptcha.indexOf('recaptcha.net') !== -1, true,
    'R41：reCAPTCHA 的回源校验端点固定走 recaptcha.net（规避 google.com 不可达）');
  // 取法自证：两套都在配置里，若 resolveConfig 取错了套别，上面两条必然有一条失败。
  assertEqual(Object.keys(configStore.getCaptcha().providers).sort().join(','), 'recaptcha,turnstile',
    'R41：两套凭证都必须真实存在于配置里（否则上面的相等断言可能因「两边都空」而假绿）');
});
