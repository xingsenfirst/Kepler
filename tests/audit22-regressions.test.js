/**
 * 第二十二轮修复护栏（R22-01 ~ R22-06）
 *
 * 本轮是**对第 21 轮修复的补完**：22 轮复核（`ANALYSIS-ROUND22-VERIFY.md`）确认 6 条全部成立，
 * 其中 3 条是「上一轮只修了一半」，因此这里的用例刻意与 `audit21-regressions.test.js`
 * 的对应项**成对**，把上一轮漏掉的那一半独立钉住。
 *
 * 覆盖：
 *  - R22-01 Windows Hello 登录**第三支**（用户存在 **且** 已启用 Hello）必须与另两支同形
 *          —— R21-05 只收敛了 2/3 支，这一支此前回 `publicReason(r.reason)` + `reason` 字段，
 *          而它的可达前提恰好就是「用户名存在且启用了二次验证」，等于一个更精确的 oracle
 *  - R22-02 `X-Forwarded-For` 的取值必须可信：非法值不得各自成为独立来源（限流 / 锁定键
 *          不得随请求头轮换），且部署脚本生成的反代片段必须**重写**而非追加该头
 *  - R22-03 WebDAV 全部错误出口都不得裸发上游 `message`（R21-14 只接了 2/6 处）
 *  - R22-04 「解密下发」三个出口的加密门禁归属必须在文档里有明确口径，且与代码事实一致
 *  - R22-05 加密令牌的传递通道（请求头 + 分享页 Cookie）必须在文档里各自限定作用域
 *  - R22-06 `httpsRedirectHost()` 的注释顺序必须与实现顺序逐项同序
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R22-*` 条目。
 * ⚠️ 端口一律 `listen(0)`（临时端口），与相邻轮次并发跑文件时不会 EADDRINUSE。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { test } = require('node:test');
const { ROOT, assert, assertEqual, makeTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('cos-audit22-');
process.env.COS_DATA_DIR = tmp.dir;

const express = require(path.join(ROOT, 'node_modules', 'express'));

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 起一个只挂指定路由的本地服务（端口由内核分配） */
async function serve(mount, router) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
}

/**
 * 粗粒度注释剥离（仅为「该文件内不得出现裸 X」这类静态判据服务）。
 * 只按**整行**判定 `//` 与块注释续行，避免被字符串里的 `//`（URL）误伤。
 */
function withoutCommentLines(src) {
  return src.split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
}

/* ==================================================================== */
/* R22-01 · Windows Hello 登录失败的**第三支**必须同形                        */
/* ==================================================================== */

test('R22-01 · 「用户名存在且已启用 Hello」的失败响应必须与前两支逐字相同', async () => {
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));
  const statsStore = require(path.join(ROOT, 'server', 'stats-store.js'));
  statsStore.addLog = () => {};

  // 三个样本 —— 第三支（hello-user）是 R21-05 的护栏**物理上够不到**的那一支：
  // `audit21-regressions.test.js` 把 isWebauthnEnabled 恒打桩为 false，于是第三支不可达。
  configStore.findUserRaw = (u) => (u === 'exists-user' || u === 'hello-user'
    ? { id: 'u-' + u, username: u } : null);
  configStore.isWebauthnEnabled = (raw) => Boolean(raw && raw.username === 'hello-user');
  configStore.getWebauthn = () => ({ credentialId: 'cred-1', publicKey: 'pk', signCount: 0 });

  const authRoutes = require(path.join(ROOT, 'server', 'routes', 'auth.js'));
  const srv = await serve('/api', authRoutes);
  try {
    const a = await request(srv.port, 'POST', '/api/auth/login/webauthn', { body: { username: 'no-such-user' } });
    const b = await request(srv.port, 'POST', '/api/auth/login/webauthn', { body: { username: 'exists-user' } });
    // 第三支：用户存在 + 已启用 Hello，但没带 challenge（b.challenge 为空串）→ 必然走到验签失败分支
    const c = await request(srv.port, 'POST', '/api/auth/login/webauthn', { body: { username: 'hello-user' } });

    assertEqual(c.status, 401,
      `R22-01：第三支（已启用 Hello）验签失败必须回 401，实际 ${c.status}`);
    assertEqual(c.raw, a.raw,
      'R22-01：第三支的响应体必须与「用户不存在」逐字相同 —— 否则匿名可以把它当成'
      + '「用户名存在且已启用二次验证」的 oracle（旧实现回 publicReason(reason) + reason 键）');
    assertEqual(c.raw, b.raw, 'R22-01：三支必须完全同形（状态码 + 文案 + 键集）');
    assert(!/"reason"/.test(c.raw),
      `R22-01：响应里不得再出现 reason 键（它会泄露具体是哪一项校验没过），实际 ${c.raw}`);
    assert(!/challenge|挑战|签名/.test(c.raw),
      `R22-01：不得回「挑战缺失 / 签名错误」这类可区分文案，实际 ${c.raw}`);
  } finally {
    await srv.close();
  }
});

/* ==================================================================== */
/* R22-02 · 转发头取值必须可信（非法值不得成为独立来源；部署侧必须重写）        */
/* ==================================================================== */

test('R22-02 · 非法 XFF 不得各自成为独立来源，也不得重获回环豁免', () => {
  const SEC = path.join(ROOT, 'server', 'security.js');
  const saved = process.env.TRUST_PROXY;
  const fresh = () => {
    delete require.cache[require.resolve(SEC)];
    return require(SEC);
  };
  process.env.TRUST_PROXY = '1';
  try {
    const sec = fresh();
    const mk = (xff) => ({
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      socket: { remoteAddress: '127.0.0.1' }, // 反代部署下 socket 恒为 Nginx 的回环
    });

    /* ---- 正向对照：合法 IP 必须原样透传（护栏不得退化成「一律不信任」） ---- */
    assertEqual(sec.clientIpInfo(mk('203.0.113.9')).ip, '203.0.113.9', 'R22-02：合法 IP 应原样采用');
    assertEqual(sec.clientIpInfo(mk('10.0.0.1')).ip, '10.0.0.1',
      'R22-02：内网地址在局域网部署里是合法客户端 IP，不能按格式拒绝');

    /* ---- 核心：轮换 5 个不同的非法串，取到的「身份」必须收敛为同一个 ---- */
    const ids = ['aaa', 'bbb', 'ccc', 'ddd', 'eee'].map((g) => sec.clientIpInfo(mk(g)).ip);
    const distinct = new Set(ids).size;
    assertEqual(distinct, 1,
      `R22-02：不同的非法 XFF 绝不能产生不同的来源标识（旧实现原样回显，`
      + `限流键 ip 与锁定键 ip|username 随请求头一起轮换 → 限流与账户锁定被整条绕过）；`
      + `实际得到 ${JSON.stringify(ids)}`);

    /* ---- 且不得被当成「本机直连」而白拿回环豁免 ---- */
    const bogus = sec.clientIpInfo(mk('not-an-ip'));
    assertEqual(bogus.fromForwarded, true,
      'R22-02：头在但值不可用，也必须标记为「来自转发头」—— 若落回 socket 分支，'
      + '反代部署下 socket=127.0.0.1 会让它冒充本机、重获回环豁免（R17-01 刚堵掉的洞）');

    /* ---- 正向对照：真正的本机直连（没有转发头）不受影响 ---- */
    const direct = sec.clientIpInfo(mk(undefined));
    assertEqual(direct.fromForwarded, false, 'R22-02：无转发头时必须走 socket 分支');
    assertEqual(direct.ip, '127.0.0.1', 'R22-02：本机直连仍应识别为回环地址');
  } finally {
    if (saved === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = saved;
    delete require.cache[require.resolve(SEC)];
    require(SEC); // 复原：后续用例拿到默认（不信任代理）的实例
  }
});

test('R22-02 · 部署脚本生成的反代片段必须**重写**而非追加 X-Forwarded-For', () => {
  const dep = read('deploy.sh');
  const m = /^\s*proxy_set_header X-Forwarded-For (.+);\s*$/m.exec(dep);
  assert(m, '前置：deploy.sh 必须生成 `proxy_set_header X-Forwarded-For …;` 片段');
  assertEqual(m[1].trim(), '\\$remote_addr',
    'R22-02：必须用 $remote_addr **重写**该头。`$proxy_add_x_forwarded_for` 的语义是'
    + '「客户端原值 + $remote_addr」，首段即请求方送进来的值 —— 任何人都能写一个内网或'
    + '不可解析地址把自己伪装成可信来源（Develop_Document.md 也要求最外层代理重写而非追加）');
  assertEqual(dep.match(/^\s*proxy_set_header X-Forwarded-For /gm).length, 1,
    'R22-02：X-Forwarded-For 只应有一处定义（多处会互相覆盖，且判据不再唯一）');
});

/* ==================================================================== */
/* R22-03 · WebDAV 的**每一个**错误出口都不得裸发上游 message                 */
/* ==================================================================== */

test('R22-03 · webdav-server.js 内不得存在裸 send(e.message)，且六个出口都接了助手', () => {
  const src = read('server/webdav-server.js');
  const code = withoutCommentLines(src);

  /* ---- 扫描范围下界自检：特征扫不到时「命中 0」与「全合规」长得一样 ---- */
  const gate = code.match(/davErrorMessage\(e\)/g) || [];
  assert(gate.length >= 5,
    `扫描范围自检：应至少提取到 5 处 davErrorMessage(e) 调用（当前 ${gate.length}）——`
    + '若为 0，说明本检查已失效，会静默放行');

  const bare = [];
  code.split(/\r?\n/).forEach((l, i) => {
    /**
     * 判据必须覆盖两种同型写法 —— R21-16 复盘时正是被这一条绊住：
     *  - 裸写：`.send(e.message)`
     *  - 特判包一层：`.send(st === 404 ? '404 Not Found' : e.message)`
     *    （DELETE / COPY 两处是这种形态；只匹配裸写会让它们「撤不撤都不变红」）
     */
    if (/\.send\([^)]*\be\.message\b/.test(l)) bare.push(`L${i + 1} ${l.trim()}`);
  });
  assertEqual(bare.length, 0,
    'R22-03：WebDAV 响应里不得再出现裸 e.message（上游 SDK 的 message 可能带请求 ID /'
    + '端点 / AccessKeyId 片段）。R21-14 只收口了 2 处，另外 4 处（PROPFIND / MKCOL /'
    + `DELETE / COPY）撤不撤都不变红 —— 故这里改成**调用点层**的静态不变量：\n  ${bare.join('\n  ')}`);
});

/* ==================================================================== */
/* R22-04 · 「解密下发」三出口的门禁归属必须在文档里有口径，且与代码事实一致      */
/* ==================================================================== */

test('R22-04 · 文档必须写明 WebDAV 出口是否纳入「查看密码」，且与代码事实一致', () => {
  // 代码事实：WebDAV 出口不读取加密令牌 / 查看密码状态（该文件命中数为 0）
  const webdavCode = withoutCommentLines(read('server/webdav-server.js'));
  const hasGate = /passwordSet\(\)|x-enc-token|encStore/.test(webdavCode);
  assertEqual(hasGate, false,
    '前置事实：WebDAV 出口当前不读取加密令牌（若将来接上了门禁，下面那句文档口径必须同步改）');

  const readme = read('README.md');
  const devDoc = read('Develop_Document.md');
  const saysExcluded = (src) => /WebDAV[\s\S]{0,20}不叠加这道门禁/.test(src);
  const excludedInReadme = saysExcluded(readme);
  const excludedInDevDoc = /WebDAV 出口不叠加这道门禁/.test(devDoc);

  assert(excludedInReadme,
    'R22-04：README 必须明确 WebDAV 挂载出口**不叠加**查看密码这道门禁 —— 否则'
    + '「设置后查看 / 下载加密文件前须验证」会被读成覆盖三个出口，而 WebDAV 出口不校验');
  assert(excludedInDevDoc, 'R22-04：Develop_Document.md 也要有同一口径（两份文档不得各说各话）');

  // 双向：文档口径必须与代码事实一致（加了门禁而文档还说「不叠加」→ 立刻变红）
  assertEqual(excludedInReadme, !hasGate,
    'R22-04：文档口径与代码事实必须一致（代码有门禁则文档不得再声明「不叠加」，反之亦然）');
});

/* ==================================================================== */
/* R22-05 · 加密令牌的两条传递通道必须在文档里各自限定作用域                    */
/* ==================================================================== */

test('R22-05 · README 必须区分「管理端请求头」与「分享页 Cookie」两条令牌通道', () => {
  const readme = read('README.md');
  const shareRoutes = read('server/share-routes.js');

  // 代码事实：分享侧确实有 Cookie 通道（否则 README 多写这一句才是错的）
  assert(/ENC_COOKIE\s*=/.test(shareRoutes),
    '前置事实：share-routes.js 必须存在加密令牌的 Cookie 通道，README 才该写到它');
  assert(/x-enc-token/.test(readme), 'R22-05：README 必须仍写明管理端走 x-enc-token 请求头');
  assert(/path=\/s\//.test(readme),
    'R22-05：README 必须写明分享页那枚 Cookie 限定在 /s/ 作用域（否则读者会以为它能进 /api/**）');
  assert(!/令牌\*\*仅通过 ?`x-enc-token` ?请求头\*\*传递/.test(readme),
    'R22-05：不得再声明「仅通过 x-enc-token 请求头传递」—— 分享链路另有 Cookie 通道，'
    + '该句与实现矛盾（旧实现只有请求头，R21-01 加了 Cookie 后此句未同步）');
});

/* ==================================================================== */
/* R22-06 · httpsRedirectHost 的注释顺序必须与实现顺序逐项同序                */
/* ==================================================================== */

test('R22-06 · HTTPS 跳转目标的注释顺序必须与实现顺序一致', () => {
  const SEC = path.join(ROOT, 'server', 'security.js');
  const realLoad = require(path.join(ROOT, 'server', 'config-store.js')).load;
  const savedHost = process.env.HOST;
  const configStore = require(path.join(ROOT, 'server', 'config-store.js'));

  /* ---- 行为侧：钉住实现顺序 = 请求 Host → 本机 HOST（非通配）→ 站点域名 ---- */
  try {
    configStore.load = () => ({ domains: { primary: 'cloud.example.com' } });
    process.env.HOST = 'storage.example.com';
    delete require.cache[require.resolve(SEC)];
    const sec = require(SEC);

    assertEqual(sec.httpsRedirectHost('storage.example.com').host, 'storage.example.com',
      'R22-06：① 被允许的请求 Host 优先');
    assertEqual(sec.httpsRedirectHost('attacker.example').host, 'storage.example.com',
      'R22-06：② 本机 HOST 非通配时**先于**站点域名（旧注释把这步写成了最后一步）');
  } finally {
    configStore.load = realLoad;
    if (savedHost === undefined) delete process.env.HOST; else process.env.HOST = savedHost;
    delete require.cache[require.resolve(SEC)];
    require(SEC);
  }

  /* ---- 文档侧：注释声明的顺序必须与上面钉住的行为同序 ---- */
  const flat = read('server/security.js').replace(/\s+/g, ' ');
  const iHost = flat.indexOf('请求 Host → 本机 HOST');
  const iDom = flat.indexOf('配置的站点主/备域名 → 通配回退');
  assert(iHost >= 0, 'R22-06：注释必须声明第一步是「请求 Host」、第二步是「本机 HOST（非通配时）」');
  assert(iDom > iHost,
    `R22-06：注释里的顺序必须与实现同序（请求 Host → 本机 HOST → 站点域名），`
    + `当前声明的位置为 请求 Host@${iHost} / 站点域名@${iDom}`);
  assert(!/被允许的请求 Host → 配置的站点主\/备域名[\s\S]{0,40}本机 HOST/.test(flat),
    'R22-06：不得再出现被本轮纠正掉的旧顺序（「请求 Host → 站点域名 → 本机 HOST」）');
});

/* ============================ 收尾 ============================ */

test.after(async () => {
  try { await require(path.join(ROOT, 'server', 'secure-store.js')).flush(); } catch (e) { /* ignore */ }
  tmp.cleanup();
});
