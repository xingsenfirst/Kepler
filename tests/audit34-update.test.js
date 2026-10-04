/**
 * 第 34 轮护栏（其二）—— 「关于」卡片「检查更新」
 *
 * 需求原文：
 *  - 在「关于」卡片新增一个「检查更新」按钮，通过 GitHub 发布页检测当前版本是否为最新版；
 *  - 已是最新 → 「当前已是最新版本。」
 *  - 不是最新 → 「当前版本：xxx，最新版：xxx。若要更新，请前往服务器终端执行重新安装的命令。」
 *
 * ## 断言分三层（任何一层缺失都会留下「假绿」）
 *
 *  ① **纯函数层**（真实 `server/update-check.js`）：版本比较的语义 ——
 *     按数值而非字符串比较、预发布小于正式版、**无法解析返回 `null` 而不是 0**。
 *     最后一条最要紧：`null` 被误当成 `0`（相等），用户就永远收不到升级提示。
 *  ② **路由层**（真实 express 路由 + 真发 HTTP + 假上游）：三级来源回退、
 *     全部失败要 502 且逐级说明原因、缓存真的省下了上游调用、**普通用户也能调用**。
 *  ③ **前端层**（沙箱里 import 真实的 `util.js`）：两句文案与需求**逐字**一致。
 *
 * ⚠️ 「关于」卡片是设置页里**唯一保留给普通用户**的卡片（见 `syssettings.js` 的
 *    `ADMIN_ONLY_CARDS`），因此 `/update/check` **不得**挂 `requireAdmin` ——
 *    用例 2 刻意以 `role: 'user'` 发请求，把这条约束钉在**行为**上，
 *    而不是只写一句注释。
 *
 * ⚠️ 上游取数走 `updateCheck.__setFetcher()` 注入的假实现，**不发真实网络请求** ——
 *    否则 CI 断网就会让本文件整片变红，而红的原因与代码对错无关。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT, makeTempDir, cleanupTempDir, request } = require('./helpers.js');

const tmp = makeTempDir('cos-r34u-');
process.env.COS_DATA_DIR = tmp.dir;

const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);

const express = require(path.join(ROOT, 'node_modules', 'express'));
const updateCheck = require(SERVER('update-check.js'));
const statsRoutes = require(SERVER('routes', 'stats.js'));

test.after(async () => {
  updateCheck.__setFetcher(null);
  if (server) await new Promise((r) => server.close(r));
  await cleanupTempDir(tmp.dir);
});

/* ================================================================== *
 * 路由层公共设施
 * ================================================================== */

let server = null;
let port = 0;

/** 与 index.js 同形的最小应用：角色由请求头决定；错误处理器尊重 `err.status` */
function startServer() {
  if (server) return Promise.resolve();
  const app = express();
  app.use((req, _res, next) => {
    const who = String(req.headers['x-test-as'] || 'user');
    req.authUser = who === 'admin'
      ? { id: 'admin-1', username: 'admin', role: 'admin' }
      : { id: 'user-1', username: 'user', role: 'user' };
    next();
  });
  app.use('/api', statsRoutes);
  // ⚠️ 必须与 index.js 同形：不读 `err.status` 的话，本模块抛的 502 会被吞成 500，
  // 用例就只能去断言一个错误的状态码。
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => { server = s; port = s.address().port; resolve(); });
  });
}

/**
 * 假上游。按 URL 形状分派到 `release` / `tag` / `package` 三档；
 * 未给出的一档按 GitHub 的 404 抛错（模拟「这条路径没有东西」）。
 * 同时记录被调用过的 URL —— 缓存用例靠它证明「上游只被打了一次」。
 */
function stubUpstream(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const key = url.indexOf('/releases/latest') >= 0 ? 'release'
      : url.indexOf('/tags') >= 0 ? 'tag' : 'package';
    if (map[key] === undefined) throw Object.assign(new Error('HTTP 404'), { statusCode: 404 });
    if (map[key] instanceof Error) throw map[key];
    return map[key];
  };
  return { fn, calls };
}

const get = (headers) => request(port, 'GET', '/api/update/check', { headers });

/* ================================================================== *
 * ① 纯函数层：版本比较的语义
 * ================================================================== */

test('R34 · 版本比较语义（唯一实现点 `compareVersion`）：按数值比较、预发布更小、无法解析返回 null', () => {
  const c = updateCheck.compareVersion;
  assertEqual(c('1.4.0', '1.3.9'), 1, '1.4.0 应大于 1.3.9');
  assertEqual(c('1.3.0', '1.4.0'), -1, '1.3.0 应小于 1.4.0');
  assertEqual(c('v1.3.0', '1.3.0'), 0, '前缀 v 不参与比较');
  // 字符串比较会把 "1.10.0" 判成小于 "1.9.9" → 一条永远发不出的升级提示
  assertEqual(c('1.10.0', '1.9.9'), 1, '必须按数值比较，不能按字符串');
  assertEqual(c('1.4.0-rc.1', '1.4.0'), -1, '预发布版本小于同名正式版');
  // null 与 0 必须严格区分：null = 「这次比较不成立」，调用方要换下一个来源
  assertEqual(c('nightly', '1.3.0'), null, '无法解析必须返回 null，不得返回 0（会被当成"已是最新"）');
  assertEqual(c('1.3.0', ''), null, '当前版本为空同样不可比较');
  assertEqual(c('1.2.3', '1.2.3.4'), null, '只认三段式，四段不是本项目的版本号形态');
});

/* ================================================================== *
 * ② 路由层：回退 / 缓存 / 权限 / 失败可诊断
 * ================================================================== */

test('R34 · 有新版本：hasUpdate=true，且**普通用户**（非管理员）也能调用', async () => {
  await startServer();
  updateCheck.__clearCache();
  // ⚠️ 不能把「更新版本」写死成一个具体号（写成 1.4.0 之后，本轮把版本推到 1.4.0 就当场假红）。
  // 由当前版本**推导**一个严格更大的号，这样每次推进版本号都不会让本条失效。
  const cur = updateCheck.currentVersion();
  const newer = 'v' + (Number(cur.split('.')[0]) + 1) + '.0.0';
  const { fn } = stubUpstream({ release: { tag_name: newer } });
  updateCheck.__setFetcher(fn);

  const r = await get({ 'x-test-as': 'user' });
  assertEqual(r.status, 200, '「关于」卡片对普通用户可见，普通用户点按钮不得 403');
  assertEqual(r.json.current, cur, '当前版本必须取自 package.json');
  assertEqual(r.json.latest, newer);
  assertEqual(r.json.hasUpdate, true);
  assertEqual(r.json.source, 'release', '有 Release 时应优先采用它');
});

test('R34 · 已是最新：hasUpdate=false（同一个号既不能报"有新版本"，也不能报错）', async () => {
  await startServer();
  updateCheck.__clearCache();
  const { fn } = stubUpstream({ release: { tag_name: 'v' + updateCheck.currentVersion() } });
  updateCheck.__setFetcher(fn);

  const r = await get();
  assertEqual(r.status, 200);
  assertEqual(r.json.hasUpdate, false);
  assertEqual(r.json.latest, 'v' + updateCheck.currentVersion());
});

test('R34 · 三级来源回退：Release → tag → 默认分支 package.json', async () => {
  await startServer();
  // 同前：由当前版本推导，避免把具体号写死后每次推进版本都假红
  const major = Number(updateCheck.currentVersion().split('.')[0]) + 1;
  const tagVer = `v${major}.0.0`;
  const pkgVer = `${major}.1.0`;
  const tagVer2 = `v${major}.2.0`;

  // ① Release 不存在（404）→ 用 tag
  updateCheck.__clearCache();
  let s = stubUpstream({ tag: [{ name: tagVer }] });
  updateCheck.__setFetcher(s.fn);
  let r = await get();
  assertEqual(r.json.source, 'tag', 'Release 取不到时应退到 tag');
  assertEqual(r.json.latest, tagVer);
  assertEqual(r.json.hasUpdate, true);

  // ② Release 与 tag 都没有 → 用默认分支的 package.json（本仓库当前正是这种情形）
  updateCheck.__clearCache();
  s = stubUpstream({ package: { version: pkgVer } });
  updateCheck.__setFetcher(s.fn);
  r = await get();
  assertEqual(r.json.source, 'package', '两者都没有时应退到默认分支的 package.json');
  assertEqual(r.json.latest, pkgVer);

  // ③ Release 存在但版本号不合规 → 换下一级，绝不能当成"已是最新"而静默收场
  updateCheck.__clearCache();
  s = stubUpstream({ release: { tag_name: 'nightly' }, tag: [{ name: tagVer2 }] });
  updateCheck.__setFetcher(s.fn);
  r = await get();
  assertEqual(r.json.source, 'tag', '号不可解析时应换下一个来源');
  assertEqual(r.json.latest, tagVer2);
});

test('R34 · 三级全部失败：502，且错误文案逐级说明原因（用户才分得清断网 / 被墙 / 改名）', async () => {
  await startServer();
  updateCheck.__clearCache();
  updateCheck.__setFetcher(async () => { throw new Error('connect ETIMEDOUT'); });

  const r = await get();
  assertEqual(r.status, 502, '取不到最新版本时必须是错误，绝不能假装"已是最新"');
  const msg = String(r.json && r.json.error || '');
  for (const k of ['release', 'tag', 'package']) {
    assert(msg.indexOf(k) >= 0, `错误文案里应含「${k}」这一级的失败原因，实际：${msg}`);
  }
  assert(msg.indexOf('ETIMEDOUT') >= 0, '应把上游的真实失败原因带出来');
});

test('R34 · 结果缓存：连点按钮不会反复打上游（GitHub 未认证 API 仅 60 次/小时/IP）', async () => {
  await startServer();
  updateCheck.__clearCache();
  const s = stubUpstream({ release: { tag_name: 'v1.4.0' } });
  updateCheck.__setFetcher(s.fn);

  await get();
  await get();
  await get();
  assertEqual(s.calls.length, 1, '三次请求只应打一次上游（10 分钟内命中缓存）');
});

/* ================================================================== *
 * ③ 前端层：文案逐字一致 + 按钮真的接上线
 * ================================================================== */

test('R34 · util.updateNotice：两句文案与需求逐字一致', async () => {
  const { updateNotice } = await import(pathToFileURL(JS('util.js')).href);

  assertEqual(updateNotice({ current: '1.3.0', latest: '1.3.0', hasUpdate: false }),
    '当前已是最新版本。');

  const up = updateNotice({ current: '1.3.0', latest: '1.4.0', hasUpdate: true });
  assertEqual(up,
    '当前版本：1.3.0，最新版：1.4.0。若要更新，请前往服务器终端执行重新安装的命令。');
  // 两个号若写反位，用户会照着装错版本 —— 单独钉一次顺序
  assert(up.indexOf('当前版本：1.3.0，最新版：1.4.0') === 0, '当前版本在前、最新版在后');
  assert(!/undefined|NaN/.test(up), '不得把 undefined / NaN 拼进给用户看的文案');
});

test('R34 · 「关于」卡片确实有按钮，且 syssettings 把它接到了 API 上', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert(/id="btn-check-update"/.test(html), '「关于」卡片必须有「检查更新」按钮');
  assert(/id="update-result"/.test(html), '必须有展示结果的容器，否则用户点了看不到任何反馈');

  const src = fs.readFileSync(JS('syssettings.js'), 'utf8');
  assert(/getElementById\('btn-check-update'\)/.test(src), '必须取到按钮');
  assert(/btnUpdate\.onclick\s*=\s*checkUpdate/.test(src), '按钮必须接线到 checkUpdate');
  assert(/API\.checkUpdate\(\)/.test(src), 'checkUpdate 必须真的发请求');
  assert(/updateNotice\(/.test(src), '文案必须取自 util.updateNotice（唯一实现点），不得就地再写一份');
  assert(/finally\s*\{[\s\S]{0,120}btn\.disabled\s*=\s*false/.test(src),
    '按钮必须在 finally 里恢复可用 —— 否则一次失败就永久禁用');
});

/**
 * 沙箱桩与真实模块 import 图的同步护栏。
 *
 * `syssettings.js` 现在用具名导入取 `updateNotice`，而 audit31 / 32 / 33 三个前端沙箱
 * 各自在临时目录里放了一份**自己的 `util.js` 桩**。ESM 的具名导入是在**链接期**校验的：
 * 桩里少一个名字，`import syssettings.js` 直接抛
 * `does not provide an export named '…'`，于是那三个文件里**所有**用例整片变红 ——
 * 而红的原因与它们各自要守的东西毫无关系（本轮实测：一次改动引发 9 条无关用例失败）。
 *
 * 这条护栏把「桩的导出集 ⊇ syssettings.js 的导入集」变成断言，让下一次新增导入时
 * 在第一处就报错，而不是让 9 条无关用例替它背锅。
 */
test('R34 · 前端沙箱的 util 桩必须覆盖 syssettings.js 从 util.js 具名导入的全部符号', () => {
  const src = fs.readFileSync(JS('syssettings.js'), 'utf8');
  const m = /import\s*\{([^}]+)\}\s*from\s*'\.\/util\.js'/.exec(src);
  assert(m, 'syssettings.js 应从 ./util.js 具名导入');
  const need = m[1].split(',').map((s) => s.trim()).filter(Boolean);
  assert(need.length > 0, '解析到的导入集不得为空（否则本条形同虚设）');

  for (const f of ['audit31-regressions.test.js', 'audit32-regressions.test.js', 'audit33-regressions.test.js']) {
    const t = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8');
    const miss = need.filter((n) => !new RegExp(`export\\s+(?:const|function|async\\s+function)\\s+${n}\\b`).test(t));
    assertEqual(miss.join(','), '',
      `${f} 的 util 桩缺少：${miss.join('、')} —— ESM 在链接期就会报错，该文件所有 import syssettings.js 的用例会整片变红`);
  }
});
