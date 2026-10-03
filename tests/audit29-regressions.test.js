/**
 * 第二十九轮护栏（R29-01 / R29-02）—— 两个**用户报告**的运行期问题：
 *
 *  - R29-01「上传小文件进度条假死 / 大文件卡住」：请求体一发完进度条就是 100%，
 *    而服务端还要加密上云；且上传没有任何停滞保护 —— 服务端不回应就永远停在「上传中」。
 *  - R29-02「设置改完要按 F5」：设置类写操作只刷新自己那张卡片，而侧边栏 / 状态栏 /
 *    其它卡片读的是 `App.state.config` 快照。
 *
 * 本文件用「模块图替换」把 upload.js 的依赖换成桩，在 Node 里驱动**真实的** uploadMgr；
 * 另用一个假 `XMLHttpRequest` 直接驱动 `api.js` 的 `xhrPut`，验证停滞看门狗。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const readSrc = (...p) => fs.readFileSync(JS(...p), 'utf8');

/**
 * 留下**代码行**（丢掉 `//`、`/*`、`*` 起头的注释行）。
 *
 * 为什么 R29-02 的窗口断言必须过这一道：最初直接
 * `src.slice(idx, idx + 900).includes('App.onConfigChanged(')`，**而 bucketmgr.js 里那段
 * 说明注释恰好也含同样字样**（「改为走 `App.onConfigChanged()`（内部：…）」）。于是反向变异把
 * 真代码行摘掉之后，注释照旧满足 `includes` —— 实测 R29-02b **`fail=0`**：变异明明生效了，
 * 台账却判「护栏没抓到」。这正是本项目反复踩过的「判据落在注释上 = 假绿」，与
 * `invariants.test.js` 用 `stripComments()` 抹白注释是同一条纪律。
 *
 * 这里只做**行级**过滤而不复用 `stripComments()`：本文件要判的是「这一行是不是一句调用」，
 * 行级足够且不依赖另一个测试文件的内部函数（它未导出）；真正的抹白式剥离仍以
 * `invariants.test.js` 为唯一实现点，扫源码全量的判据一律走它。
 */
function codeLines(src) {
  return src.split('\n').filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l)).join('\n');
}

/* ================================================================== *
 * R29-01 · 停滞看门狗（直接驱动 api.js 的 xhrPut + 假 XHR）
 * ================================================================== */

/** 最小假 XMLHttpRequest：把 handlers 记下来，由测试手动触发。 */
function installFakeXhr() {
  const log = { aborted: 0, sent: null, handlers: {}, uploadHandlers: {} };
  class FakeXHR {
    constructor() {
      this.upload = {};
      // `upload` 是实例属性（不是原型上的），事件必须定义在实例上
      for (const name of ['onprogress', 'onload']) {
        Object.defineProperty(this.upload, name, {
          set: (fn) => { log.uploadHandlers[name] = fn; },
          get: () => log.uploadHandlers[name],
        });
      }
      this.status = 0;
      this.response = null;
    }
    open() {}
    setRequestHeader() {}
    send(blob) { log.sent = blob; }
    abort() { log.aborted += 1; if (this.onabort) this.onabort(); }
  }
  for (const name of ['onload', 'onerror', 'onabort']) {
    Object.defineProperty(FakeXHR.prototype, name, {
      set(fn) { log.handlers[name] = fn; },
      get() { return log.handlers[name]; },
    });
  }
  const prev = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = FakeXHR;
  return { log, restore: () => { globalThis.XMLHttpRequest = prev; } };
}

/** 让看门狗立即触发：把 setTimeout 换成「同步收集、手动触发」 */
function installManualTimers() {
  const timers = [];
  const prev = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  return {
    timers,
    restore: () => { globalThis.setTimeout = prev; },
    fireLast: () => { const t = timers.pop(); if (t) t.fn(); return t; },
  };
}

/** 用假 XHR + 手动定时器驱动一次 xhrPut，返回 { promise, xhrLog, timers } */
async function driveXhrPut(setup) {
  const fake = installFakeXhr();
  const timers = installManualTimers();
  let rejected = null;
  let resolved = null;
  let p = null;
  try {
    const api = require(JS('api.js'));
    p = api.xhrPut('/api/fs/upload/simple?path=a.txt', { size: 100 }, () => {});
    p.catch((e) => { rejected = e; });
    p.then((d) => { resolved = d; });
    if (setup) setup({ fake: fake.log, timers });
  } finally {
    fake.restore();
    timers.restore();
  }
  // 让 promise 的 catch 落地
  await new Promise((r) => setImmediate(r));
  return { promise: p, rejected, resolved, xhrLog: fake.log, timers };
}

test('R29-01 · 上传无进展必须被看门狗中断（且错误可重试：不带 aborted）', async () => {
  const fake = installFakeXhr();
  const timers = installManualTimers();
  let rejected = null;
  try {
    delete require.cache[require.resolve(JS('api.js'))];
    const api = require(JS('api.js'));
    const p = api.xhrPut('/api/fs/upload/simple?path=a.txt', { size: 100 }, () => {});
    p.catch((e) => { rejected = e; });
    // 没有任何 upload.onprogress：最后一个定时器就是"发送阶段"的看门狗
    const t = timers.timers[timers.timers.length - 1];
    assert(t, 'R29-01：xhr.send 之后必须挂上一个停滞看门狗（否则服务端不回应就永远停在「上传中」）');
    assertEqual(t.ms, 60 * 1000, 'R29-01：发送阶段的静默容忍应为 60 秒');
    t.fn();
    await new Promise((r) => setImmediate(r));
    assertEqual(fake.log.aborted, 1, 'R29-01：看门狗到点必须 abort 该请求');
    assert(rejected, 'R29-01：abort 之后必须 reject（不能让上传任务无限期挂着）');
    assert(/停滞/.test(rejected.message), `R29-01：错误文案必须说明是「停滞」，实际：${rejected.message}`);
    assertEqual(rejected.stalled, true, 'R29-01：必须带 stalled 标记（便于上层区分）');
    assertEqual(rejected.aborted === true, false,
      'R29-01：停滞**不得**标成 aborted —— uploadWithRetry 对 aborted 是"直接放弃"，'
      + '标错会让本该重试的停滞变成一次性的失败');
  } finally {
    fake.restore();
    timers.restore();
  }
});

test('R29-01 · 请求体发完后看门狗切到"等服务端"长档（不误杀慢链路 / 慢加密）', async () => {
  const fake = installFakeXhr();
  const timers = installManualTimers();
  try {
    delete require.cache[require.resolve(JS('api.js'))];
    const api = require(JS('api.js'));
    let progressed = 0;
    const p = api.xhrPut('/api/fs/upload/simple?path=a.txt', { size: 100 }, () => { progressed += 1; });
    p.catch(() => {});
    // 触发 upload.onload（浏览器在"请求体已全部交给网络栈"时必发）
    const onUploadLoad = fake.log.uploadHandlers.onload;
    assert(onUploadLoad, 'R29-01：必须监听 upload.onload（小文件的 onprogress 可能一次都不触发）');
    onUploadLoad();
    assert(progressed > 0, 'R29-01：upload.onload 必须把「已发完」这一事实回调给调用方（界面据此切到"服务器处理中"）');
    const t = timers.timers[timers.timers.length - 1];
    assertEqual(t.ms, 10 * 60 * 1000,
      'R29-01：请求体发完后的等待档必须放宽到 10 分钟 —— 服务端还要加密 / 上云，大文件可能几分钟');
  } finally {
    fake.restore();
    timers.restore();
  }
});

/* ================================================================== *
 * R29-01 · 进度条相位（用真实 uploadMgr + 桩模块图）
 * ================================================================== */

/** 搭一套「upload.js + 桩依赖」的临时模块图，返回 { dir } */
function makeUploadSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r29-upload-'));
  const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  w('util.js', `
export const QUOTA_EXCEEDED_CODE = 'CREDENTIAL_QUOTA_EXCEEDED';
export const BUCKET_QUOTA_EXCEEDED_CODE = 'BUCKET_QUOTA_EXCEEDED';
export const fmtSize = (n) => String(n);
export const toast = (...a) => { (globalThis.__toasts = globalThis.__toasts || []).push(a[0]); };
export const escapeHtml = (s) => String(s);
export const showQuotaDialog = () => true;
`);
  w('gitignore.js', `export const createMatcher = () => ({ isIgnored: () => false });`);
  w('main.js', `
export const App = {
  state: { prefix: '', uploadExcludes: {}, config: {} },
  refreshStorage: () => { globalThis.__refreshStorage = (globalThis.__refreshStorage || 0) + 1; },
};
`);
  w('explorer.js', `export const explorer = { refresh: () => { globalThis.__explorerRefresh = (globalThis.__explorerRefresh || 0) + 1; } };`);
  fs.copyFileSync(JS('upload.js'), path.join(dir, 'upload.js'));
  return dir;
}

/**
 * 假 DOM：只实现 upload.js 用到的那几个入口。
 * **整个文件共用一份、不还原** —— 上传任务可能在用例返回后仍有在途回调（例如
 * 「服务端不响应」那一条），还原 DOM 会让它在事后抛异常并被 test runner 记为
 * "asynchronous activity after the test ended"。每个用例都 import 一份**新的**
 * upload.js 实例（带 query 破缓存），因此共享 DOM 不会互相串味。
 */
const FAKE_DOM = new Map();
function fakeEl(id) {
  if (!FAKE_DOM.has(id)) {
    FAKE_DOM.set(id, {
      id, hidden: false, innerHTML: '', textContent: '', style: {},
      querySelectorAll: () => [], querySelector: () => null,
      classList: { add() {}, remove() {}, toggle() {} },
    });
  }
  return FAKE_DOM.get(id);
}
globalThis.window = globalThis;
globalThis.window.__SVG = { pause: 'p', play: 'r', cancel: 'c' };
globalThis.document = {
  getElementById: fakeEl, createElement: () => fakeEl('tmp'),
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  body: { appendChild() {} },
};

/** 在沙箱里跑一个上传任务；plan 控制桩 api.js 的行为 */
async function runUploadScenario({ dir, plan, size, refreshStorageThrows }) {
  fs.writeFileSync(path.join(dir, 'api.js'), `
export function xhrPut(url, blob, onProgress) {
  const plan = globalThis.__plan;
  const p = new Promise((resolve, reject) => {
    setTimeout(() => {
      if (onProgress) onProgress(plan.respondAt, blob.size); // 先报"已发完"
      if (plan.holdResponse) return;                          // 模拟服务端迟迟不响应
      resolve({ ok: true });
    }, 1);
  });
  p.xhr = { abort() {} };
  return p;
}
export const API = {
  uploadInit: async () => globalThis.__plan.init,
  uploadComplete: async () => (globalThis.__plan.completed.push(1), { ok: true }),
  uploadAbort: async () => ({}),
};
`);
  globalThis.__toasts = [];
  globalThis.__explorerRefresh = 0;
  globalThis.__refreshStorage = 0;
  globalThis.__plan = Object.assign({ completed: [], respondAt: size, holdResponse: false, init: { mode: 'simple', key: 'a.bin' } }, plan);
  FAKE_DOM.get('upload-list') && (FAKE_DOM.get('upload-list').innerHTML = '');
  if (refreshStorageThrows) {
    /**
     * 让 `App.refreshStorage` 抛错：验证「上传成功后界面刷新失败不得改判为失败」。
     *
     * ⚠️ 导入 main.js **绝不能带 `?v=`**：`upload.js` 内部的 `import … from './main.js'`
     * 解析到的是**无查询串**那个模块记录，带上 `?v=<随机>` 会拿到**另一个实例** ——
     * 改它的 `App` 对 `upload.js` 毫无影响，于是本用例**无论实现怎么写都会绿**。
     * 反向变异实测就是如此：`R29-01e` 首跑 `fail=0`（把 `try/catch` 摘掉后照样全绿），
     * 而三个沙箱用例里只有这一条依赖 `App` 的**对象同一性**，所以只有它空转。
     *
     * 覆盖动作放在 `import upload.js` **之前**：先拿到 upload.js 将要使用的那一份 App，
     * 再替换 `refreshStorage`。各用例的沙箱目录由 `mkdtemp` 保证互不相同，
     * 因此这份覆盖不会串到别的用例。
     */
    const mainMod = await import('file://' + path.join(dir, 'main.js').replace(/\\/g, '/'));
    mainMod.App.refreshStorage = () => { throw new Error('模拟界面刷新异常'); };
  }
  const mod = await import('file://' + path.join(dir, 'upload.js').replace(/\\/g, '/') + '?v=' + Math.random());
  const { uploadMgr } = mod;
  uploadMgr.init();
  await uploadMgr.enqueue([{ name: 'a.bin', size, lastModified: Date.now(), slice: (s, e) => ({ size: Math.max(0, e - s) }) }], '', false);
  const t0 = Date.now();
  while (uploadMgr.hasActive() && Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 5));
  const html = fakeEl('upload-list').innerHTML;
  const active = uploadMgr.hasActive();
  try { uploadMgr.reset(); } catch (e) { /* 收尾：中止在途任务，避免事后回调干扰 */ }
  return { html, active };
}

test('R29-01 · 字节发完但服务端未响应时：状态显示「服务器处理中」且进度条不到 100%', async () => {
  const dir = makeUploadSandbox();
  const r = await runUploadScenario({ dir, size: 1000, plan: { holdResponse: true, respondAt: 1000 } });
  assert(/服务器处理中/.test(r.html),
    'R29-01：请求体已发完、等服务端确认时必须显示「服务器处理中…」—— '
    + '旧实现里进度条此刻已是 100%、状态仍写「上传中」，看起来就是"假死"');
  assert(!/width:100\.0%/.test(r.html),
    `R29-01：发送阶段进度条不得显示 100%（应封顶 99%），实际渲染：${(r.html.match(/width:[\d.]+%/) || [])[0]}`);
});

test('R29-01 · 上传成功后界面刷新抛错，不得把任务改判成「失败」', async () => {
  const dir = makeUploadSandbox();
  const r = await runUploadScenario({ dir, size: 1000, plan: { respondAt: 1000 }, refreshStorageThrows: true });
  assert(/已完成/.test(r.html),
    'R29-01：文件已落云（HTTP 200）却被标成「失败」是典型的"业务成功、界面谎报失败"—— '
    + `界面刷新异常必须被吞掉。实际渲染：${r.html.slice(0, 160)}`);
  assertEqual(r.active, false, 'R29-01：任务必须收尾（不能停在 uploading）');
});

/* ================================================================== *
 * R29-02 · 设置写操作后的全局刷新
 * ================================================================== */

test('R29-02 · main.js 必须提供两个刷新入口（配置级 / 全局级）', () => {
  const src = readSrc('main.js');
  assert(/reloadConfig\s*\(\)\s*\{/.test(src), 'main.js 应提供 reloadConfig()（只刷新配置快照）');
  assert(/onConfigChanged\s*\(\)\s*\{/.test(src), 'main.js 应保留 onConfigChanged()（配置 + 目录树 + 文件列表）');
});

test('R29-02 · 密钥设置的写操作必须刷新全局配置（侧边栏 / 状态栏 / 桶弹窗的密钥下拉都读它）', () => {
  const src = readSrc('credmgr.js');
  const mustRefresh = [
    ['await API.addCredential({', 'onConfigChanged'],
    ['await API.updateCredential(cred.id, { enabled: want })', 'onConfigChanged'],
    ['await API.deleteCredential(cred.id)', 'onConfigChanged'],
    ['await API.updateCredential(cred.id, { remark })', 'reloadConfig'],
    ['await API.updateCredential(cred.id, { visibleToUsers: want })', 'reloadConfig'],
    ['await API.saveConfig({', 'reloadConfig'],
  ];
  for (const [call, fn] of mustRefresh) {
    const i = src.indexOf(call);
    assert(i >= 0, `credmgr.js 中应存在 ${call}`);
    const after = codeLines(src.slice(i, i + 900));
    assert(after.includes(`App.${fn}(`),
      `R29-02：${call} 之后必须调用 App.${fn}() —— 否则改完设置要按 F5，侧边栏/状态栏/`
      + '存储桶弹窗仍读旧快照（判据只看代码行：注释里写「本该调它」不算数）');
  }
});

test('R29-02 · 启停存储桶与清空桶后必须走全局刷新（`buckets-changed` 不会刷新侧边栏）', () => {
  const src = codeLines(readSrc('bucketmgr.js'));
  const toggleIdx = src.indexOf('await API.toggleBucketEnabled(row.id, want);');
  assert(toggleIdx >= 0, 'bucketmgr.js 中应存在 toggleBucketEnabled 调用');
  assert(src.slice(toggleIdx, toggleIdx + 900).includes('App.onConfigChanged('),
    'R29-02：启停存储桶后必须走 App.onConfigChanged() —— 侧边栏读的是 App.state.config 快照，'
    + '而 `buckets-changed` 的监听者只有各卡片自己（事件注释所称"同步侧边栏"并不成立）。'
    + '⚠️ 本判据只认代码行：该函数上方那段说明注释里也有同样的字样，'
    + '按原文 `includes` 会被注释满足 ⇒ 反向变异摘掉真调用仍全绿（实测 R29-02b fail=0）');
  assert(/function afterBucketMutated\(row\)\s*\{[\s\S]{0,400}App\.onConfigChanged\(/.test(src),
    'R29-02：清空桶 / 桶内容变动后的收尾必须刷新全局（否则被删掉的文件仍留在文件列表里）');
});
