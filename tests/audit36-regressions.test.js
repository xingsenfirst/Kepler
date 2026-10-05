/**
 * 第三十六轮护栏（R36）—— 四张列表卡片的「预览 + 显示全部」与属性面板的「创建者 / 上传者」
 *
 * 需求（逐条对应到下面的用例）：
 *  0. 「全部用户」对话框新增角色下拉筛选；
 *  1. 属性面板：文件夹显示「创建者」、文件显示「上传者」；
 *  2. 「访问密钥管理」「存储桶管理」与用户管理一致：① 列表只显示 10 个、>10 点「显示全部」；
 *     ② 服务商下拉筛选 + 搜索备注；③ 存储桶还能搜桶名；④ 存储桶**只有一个搜索框**同时搜两者；
 *  3. 「分享链接管理」：最多 100 条、>100 点「显示全部」，可按存储桶筛选、搜文件名与分享者。
 *
 * 这一轮与前几轮最大的不同：**四张卡片做的是同一件事**。因此大部分风险不在「某张卡片写错了」，
 * 而在「四份实现悄悄分叉」—— 卡片里能删、对话框里却不能；用户卡片搜得到大写、桶卡片搜不到；
 * 打开对话框时的数据是快照、删掉一条后对话框还留着它。护栏据此分四层：
 *  ① **纯函数层**：`matchesQuery` / `previewMoreState` / `ownerText` / `propertyBodyHtml`
 *     （真实 `util.js`）—— 四张卡片共用的判据与文案在这里被钉死；
 *  ② **组件层**：真实 `listdialog.js` + 桩化的 `openModal`/`escapeHtml`。**这是本轮唯一
 *     必须新增前端模块的原因**：把对话框写进 `util.js` 的话，沙箱只能连它一起换成桩，
 *     测到的就是「测试自己写的一份副本」，只能证明自洽（第 30 轮假 Azure 的 SAS 就是这么栽的）；
 *  ③ **卡片层**：沙箱里 import 真实的 `credmgr.js` / `bucketmgr.js` / `linkmgr.js`
 *     + 假 DOM，真点按钮、真断言渲染结果与请求；
 *  ④ **服务端层**：上传者写入对象元数据的唯一实现点（`cos.uploaderMeta` / `readUploader`）、
 *     两个适配器的 `x-cos-meta-*` → `x-amz-meta-*` / `x-ms-meta-*` 映射，
 *     以及**真实 `fs-gateway.writeObject` 的透传**（第 7 个参数必须真的上到云端请求里）。
 *
 * ⚠️ 假 DOM 的 `getElementById` 对任何 id 都会**凭空造一个**元素出来，因此
 *    `assert(dom.get('x'))` 恒为真 —— 对话框内部控件（搜索框 / 下拉 / 列表容器）的存在性
 *    必须断言在 `modal.body.innerHTML` 上（第 35 轮已踩过）。
 *
 * 反向对照登记在 `scripts/reverse-check.js` 的 `R36-*` 条目；过滤只认 `--only=<片段>`。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT } = require('./helpers.js');

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const SERVER = (...p) => path.join(ROOT, 'server', ...p);
const readSrc = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ *
 * 隔离（必须在 require 任何 server 模块之前）
 *
 * 本文件后半部分要驱动**真实的** `fs-gateway.writeObject`，而它在加载时就解构了
 * `cos.getClient` / `cos.p` —— 必须先把这两个句柄换掉，否则会真的去连腾讯云。
 * 单独成文件（`node --test` 每个测试文件一个子进程）也保证了不会污染别的轮次。
 * ------------------------------------------------------------------ */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-audit36-'));
process.env.COS_DATA_DIR = TMP;

const cos = require(SERVER('cos.js'));

/** 打到 `p()` 咽喉点的调用记录（`cos.p` 正是 fs-gateway 加载时解构的那一个） */
const PVCALLS = [];
cos.getClient = () => ({ __stub: true });
cos.p = async (client, method, params) => {
  PVCALLS.push({ method, params });
  if (method === 'putObject') return {};
  if (method === 'headObject') {
    const e = new Error('对象不存在');
    e.statusCode = 404;
    e.code = 'NoSuchKey';
    throw e;
  }
  if (method === 'getBucket') return { Contents: [], IsTruncated: 'false' };
  return [];
};

const configStore = require(SERVER('config-store.js'));
configStore.save({
  provider: 'tencent',
  secretId: 'AKIDx', secretKey: 'skx', bucket: 'r36-bucket', region: 'ap-guangzhou',
  credentials: [{
    id: 'c1', provider: 'tencent', secretId: 'AKIDx', secretKey: 'skx',
    enabled: true, visibleToUsers: true, remark: 'c1',
  }],
  buckets: [{
    id: 'b1', provider: 'tencent', bucket: 'r36-bucket', region: 'ap-guangzhou',
    credentialId: 'c1', enabled: true,
  }],
  activeCredentialId: 'c1',
});

const gateway = require(SERVER('fs-gateway.js'));

/* ================================================================== *
 * ① 纯函数层（真实 util.js）
 * ================================================================== */

const utilUrl = pathToFileURL(JS('util.js')).href;

test('R36 · util.matchesQuery：多字段任一命中 / 大小写不敏感 / 空串恒真 / 脏数据不抛错', async () => {
  const u = await import(utilUrl);

  assertEqual(u.matchesQuery('', ['a']), true, '空关键词必须恒为真（等于「不过滤」）');
  assertEqual(u.matchesQuery('   ', ['a']), true, '只有空白也按空处理（用户误按空格不该把列表清空）');
  assertEqual(u.matchesQuery(null, ['a']), true, 'null 关键词不得抛错');
  assertEqual(u.matchesQuery('ali', ['Alice']), true, '应大小写不敏感');
  assertEqual(u.matchesQuery('ALI', ['alice']), true, '大写关键词同样要能命中');
  assertEqual(u.matchesQuery('zzz', ['Alice']), false, '无匹配返回 false（而不是"放行"）');

  assertEqual(u.matchesQuery('报表', ['备份', '月报-报表.xlsx']), true,
    '多字段时任一命中即算命中 —— 存储桶卡片要「一个搜索框同时搜桶名与备注」全靠它');
  assertEqual(u.matchesQuery('备份', ['备份', '月报.xlsx']), true, '命中第一个字段');
  assertEqual(u.matchesQuery('x', ['备份', '']), false, '字段为空串时按空比较，不得抛错');

  assertEqual(u.matchesQuery('a', null), false, 'texts 为 null 不得抛错');
  assertEqual(u.matchesQuery('a', [null, undefined]), false, '脏字段按空串处理');
  assertEqual(u.matchesQuery('a', 'abc'), true, '单个字符串（非数组）也要支持');
  assert(u.matchesQuery('ab', ['xxabxx']), true, '是**子串**匹配而不是前缀匹配');
});

test('R36 · util.previewMoreState：判据是严格大于，等于上限时必须隐藏「显示全部」', async () => {
  const u = await import(utilUrl);

  const at = u.previewMoreState(10, 10, '位用户');
  assertEqual(at.over, false,
    '正好 10 个时必须隐藏按钮 —— 此时卡片已完整展示，点开只能看到与卡片一字不差的一份副本');
  assertEqual(at.hint, '', '隐藏时不得留下提示文案');

  assertEqual(u.previewMoreState(9, 10, '位用户').over, false, '少于上限同样隐藏');
  assertEqual(u.previewMoreState(0, 10, '位用户').over, false, '空列表不得显示按钮');

  const over = u.previewMoreState(11, 10, '位用户');
  assertEqual(over.over, true, '超过上限必须显示按钮');
  assert(/11/.test(over.hint), `提示应写明总数，实际：${over.hint}`);
  assert(/10/.test(over.hint), `提示应写明"只显示前 10"，实际：${over.hint}`);

  // 分享链接卡片用的是 100，同一判据必须同样成立
  assertEqual(u.previewMoreState(100, 100, '条链接').over, false, '正好 100 条同样隐藏');
  assertEqual(u.previewMoreState(101, 100, '条链接').over, true, '101 条才显示');
});

test('R36 · util.ownerText：有值则转义展示，无值显示「—」而不是顶替一个「合理」的名字', async () => {
  const u = await import(utilUrl);

  assertEqual(u.ownerText('alice'), 'alice', '有上传者就原样（转义后）展示');
  assertEqual(u.ownerText('  alice  '), 'alice', '两侧空白应去掉');

  for (const empty of ['', '   ', null, undefined]) {
    const html = u.ownerText(empty);
    assert(/—/.test(html), `空值（${JSON.stringify(empty)}）应显示占位「—」，实际：${html}`);
    assert(/title=/.test(html),
      '占位符必须带 title 解释原因 —— 否则用户会以为「这个文件没有上传者」或「系统坏了」');
  }

  const html = u.ownerText('<img src=x onerror=alert(1)>');
  assert(!/<img/.test(html), '上传者名不得未转义地进入属性面板（元数据同样可能被伪造）');
  assert(/&lt;img/.test(html), '应出现转义后的形态（说明确实走了 escapeHtml）');
});

test('R36 · util.propertyBodyHtml：文件夹「创建者」/ 文件「上传者」，标签规则只此一处', async () => {
  const u = await import(utilUrl);

  const folder = u.propertyBodyHtml({
    key: 'docs/', name: 'docs', isFolder: true, uploader: 'alice',
    lastModified: '2026-10-01T00:00:00.000Z', objectCount: 3, reachedCap: false,
  }, '文件夹');
  assert(/创建者/.test(folder), '文件夹属性必须显示「创建者：」（需求 1）');
  assert(!/上传者/.test(folder), '文件夹属性里不得出现「上传者」—— 两个标签同现说明判据写成了"都显示"');
  assert(/alice/.test(folder), '应展示创建者名');
  assert(/对象总数/.test(folder), '文件夹该有的行不得因为这次拆分而丢掉');

  const file = u.propertyBodyHtml({
    key: 'a.png', name: 'a.png', isFolder: false, uploader: 'bob',
    lastModified: '2026-10-01T00:00:00.000Z', size: 2048, encrypted: false,
  }, '图片');
  assert(/上传者/.test(file), '文件属性必须显示「上传者：」（需求 1）');
  assert(!/创建者/.test(file), '文件属性里不得出现「创建者」');
  assert(/bob/.test(file), '应展示上传者名');
  assert(/图片/.test(file), '文件类型文案应由调用方传入的类型给出');

  // 历史对象：没有元数据 → 如实显示「—」，不得拿"最后操作者"之类顶替
  const legacy = u.propertyBodyHtml({
    key: 'old.bin', name: 'old.bin', isFolder: false, uploader: '',
    lastModified: '2020-01-01T00:00:00.000Z', size: 1, encrypted: false,
  }, '文件');
  assert(/—/.test(legacy), '本版之前创建的对象没有元数据，必须显示「—」');
  assert(/上传者/.test(legacy), '占位不影响标签本身');

  // 加密标记只在密文时出现（拆分时最容易顺手漏掉的条件行）
  const encOpts = { key: 'x.bin', name: 'x.bin', isFolder: false, uploader: 'bob', lastModified: '', size: 1 };
  assert(/加密/.test(u.propertyBodyHtml(Object.assign({ encrypted: true }, encOpts), '文件')),
    '加密对象应多一行「加密」说明');
  assert(!/加密/.test(u.propertyBodyHtml(Object.assign({ encrypted: false }, encOpts), '文件')),
    '未加密对象不得出现「加密」行');
});

test('R36 · explorer.js 的属性面板只有一个渲染器（标签规则不得在别处再写一份）', () => {
  const src = readSrc('public', 'js', 'explorer.js');
  assert(/propertyBodyHtml\(/.test(src), 'explorer.js 应调用 util.propertyBodyHtml 渲染属性面板');
  assert(!/'创建者'/.test(src), 'explorer.js 里不得再出现「创建者」字面量 —— 标签规则只允许在 util.js 定义一次');
  assert(!/'上传者'/.test(src), 'explorer.js 里不得再出现「上传者」字面量');

  const util = readSrc('public', 'js', 'util.js');
  assertEqual((util.match(/'创建者'/g) || []).length, 1, 'util.js 中「创建者」应恰为 1 处');
  assertEqual((util.match(/'上传者'/g) || []).length, 1, 'util.js 中「上传者」应恰为 1 处');
  assert(/st\.isFolder \? '创建者' : '上传者'/.test(util),
    '两个标签必须在**同一个三元表达式**里 —— 拆成两个 if 分支各写一行，将来加一行就只会改到一处');
});

/* ================================================================== *
 * 假 DOM（与 audit33 / audit35 同源：**解析 innerHTML**）
 *
 * 行与按钮是渲染进 `innerHTML` 的，不是写死在 index.html 里的。因此必须能从片段里
 * 把 `id` / `data-act` / `data-id` 抽出来 —— 否则「按钮没接线」会被静默放过。
 * ================================================================== */

function installFakeDom() {
  const byId = new Map();
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
  const parseAttrs = (s) => {
    const out = {};
    attrRe.lastIndex = 0;
    let m;
    while ((m = attrRe.exec(s))) out[m[1].toLowerCase()] = m[2] === undefined ? '' : m[2];
    return out;
  };

  const mk = (id) => ({
    id, hidden: false, _html: '', textContent: '', value: '', checked: false,
    disabled: false, style: {}, dataset: {}, className: '', attrs: {}, _btns: [], options: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute(k) { const v = this.attrs[String(k).toLowerCase()]; return v === undefined ? null : v; },
    querySelector(sel) {
      // 与 audit35 同口径：只支持 `#id`（由 innerHTML 解析时全局登记），这也是
      // `syncProviderLabels()` 这类「先 innerHTML 再回查自己刚渲染的控件」的写法需要的
      if (sel && sel[0] === '#') return byId.get(sel.slice(1)) || null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-act]') return this._btns.slice();
      return [];
    },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {}, focus() {},
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      this._btns = [];
      const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
      let m;
      while ((m = tagRe.exec(this._html))) {
        const tag = m[1].toLowerCase();
        const attrs = parseAttrs(m[2]);
        if (tag === 'button') {
          const b = mk('btn');
          b.attrs = attrs;
          this._btns.push(b);
        }
        if (attrs.id) {
          const el = byId.get(attrs.id) || mk(attrs.id);
          el.attrs = attrs;
          if (attrs.value !== undefined) el.value = attrs.value;
          byId.set(attrs.id, el);
        }
      }
    },
  });

  globalThis.window = globalThis;
  // 四张卡片都会 `window.addEventListener('buckets-changed', …)`（Node 里 window === globalThis）
  globalThis.addEventListener = () => {};
  globalThis.removeEventListener = () => {};
  globalThis.document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, mk(id));
      return byId.get(id);
    },
    createElement: () => mk('created'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
    body: { appendChild() {} },
  };
  // bucketmgr.js 在**模块加载期**就会读 localStorage（loadInterval）—— 必须先就位
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {} };
  return { els: byId, get: (id) => globalThis.document.getElementById(id) };
}

const resetGlobals = (extra) => {
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__confirms = [];
  globalThis.__modals = [];
  globalThis.__closed = 0;
  globalThis.__me = { id: 'me', username: 'admin', role: 'admin' };
  globalThis.__api = Object.assign({}, extra);
};

/**
 * `util.js` 桩 —— **只**替换依赖 DOM 的 `toast / confirmDialog / openModal`，
 * 其余（含本轮新增的 `matchesQuery` / `previewMoreState` / `ownerText` / `propertyBodyHtml`）
 * 一律**再导出真实实现**：否则「被测的纯函数」与「被测的转义」都成了测试自己写的副本。
 *
 * `openModal` 的桩必须与真实实现**同形**（关窗时调用 `onClose`）—— 真实实现里有这一步，
 * 桩若不调用，「关窗后状态没复位 → 再也打不开对话框」这条就永远测不出来。
 */
function utilStub() {
  const real = pathToFileURL(JS('util.js')).href;
  return `
export { escapeHtml, fmtTime, fmtSize, matchesQuery, previewMoreState, ownerText, propertyBodyHtml, filterUsersByName, USER_PREVIEW_LIMIT, updateNotice, banNotice } from '${real}';
export const toast = (m, o) => { (globalThis.__toasts = globalThis.__toasts || []).push({ m, o }); };
export const confirmDialog = async (opts) => {
  (globalThis.__confirms = globalThis.__confirms || []).push(opts);
  return globalThis.__confirmResult === undefined ? true : globalThis.__confirmResult;
};
export const openModal = (opts) => {
  const rec = {
    title: opts.title, body: opts.body, foot: opts.foot || [],
    wide: !!opts.wide, cls: opts.cls || '', onClose: opts.onClose,
  };
  (globalThis.__modals = globalThis.__modals || []).push(rec);
  const close = () => {
    globalThis.__closed = (globalThis.__closed || 0) + 1;
    if (rec.onClose) rec.onClose(null);
  };
  rec.close = close;
  return { overlay: opts.body, close, bodyEl: opts.body, footEl: opts.body };
};
`;
}

/** `api.js` 桩：调用记进 __calls，返回值由 __api 决定（Proxy 让无关接口自动兜底） */
const API_STUB = `
export const API = new Proxy({}, {
  get(t, k) {
    if (typeof k !== 'string') return undefined;
    return (...a) => {
      (globalThis.__calls = globalThis.__calls || []).push({ fn: k, args: a });
      const impl = globalThis.__api && globalThis.__api[k];
      return Promise.resolve(impl ? impl(...a) : {});
    };
  },
});
`;

const MAIN_STUB = `
export const App = {
  state: {
    get user() { return globalThis.__me || null; },
    get config() { return globalThis.__cfg || null; },
  },
  onConfigChanged() {}, reloadConfig() {}, refreshStorage() {}, openBucketDialog() {},
};
`;

const WEBAUTHN_STUB = `
export const registerWindowsHello = async () => ({});
export const webauthnReadiness = () => ({ ok: true, hint: '' });
`;
const PAYSETTINGS_STUB = `
export const loadPayment = () => {};
export const resetPaymentView = () => {};
`;

/** 在临时模块图里放若干**真实**模块 + 它们的桩 */
function makeFeSandbox(realFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r36-fe-'));
  fs.writeFileSync(path.join(dir, 'api.js'), API_STUB);
  fs.writeFileSync(path.join(dir, 'util.js'), utilStub());
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN_STUB);
  fs.writeFileSync(path.join(dir, 'webauthn.js'), WEBAUTHN_STUB);
  fs.writeFileSync(path.join(dir, 'paysettings.js'), PAYSETTINGS_STUB);
  for (const f of realFiles) fs.copyFileSync(JS(f), path.join(dir, f));
  // 四张卡片都 import './listdialog.js'；组件本身也必须拷**真实**的那一份
  // （见文件头：写进 util.js 就会被桩掉，只能证明自洽）
  if (!realFiles.includes('listdialog.js')) fs.copyFileSync(JS('listdialog.js'), path.join(dir, 'listdialog.js'));
  // R37：四张卡片还都 import './speedlimit.js'（「限速」列 + 限速对话框）。
  // ESM 的**具名导入在链接期校验**：沙箱里少这个文件，四张卡片的**所有**用例会一起
  // 报 ERR_MODULE_NOT_FOUND —— 红的原因与它们各自要守的东西毫无关系。
  // 同样必须是**真实**的那一份（它只从 util.js 取 openModal / escapeHtml / toast 三个原语，
  // 于是真实的对话框逻辑能跑在桩化的弹窗原语上）。
  if (!realFiles.includes('speedlimit.js')) fs.copyFileSync(JS('speedlimit.js'), path.join(dir, 'speedlimit.js'));
  return dir;
}

const importFresh = (dir, file) => import('file://' + path.join(dir, file).replace(/\\/g, '/')
  + '?v=' + Math.random());

const callsOf = (fn) => (globalThis.__calls || []).filter((c) => c.fn === fn);
const findBtn = (el, act, dataId) => (el._btns || [])
  .find((b) => b.attrs['data-act'] === act && (dataId === undefined || b.attrs['data-id'] === dataId));
const modal = (i) => (globalThis.__modals || [])[i || 0] || {};
const modalBody = (i) => String(modal(i).body ? modal(i).body.innerHTML : '');
/** 渲染出的行数：四张卡片的数据行都以 `<tr data-id="…"` 开头 */
const countRows = (html) => (String(html).match(/<tr data-id="/g) || []).length;
/** 对话框里 `type="search"` 的输入框个数（需求 2④ 要的"只有一个搜索框"） */
const countSearchBoxes = (html) => (String(html).match(/type="search"/g) || []).length;

/* ================================================================== *
 * ② 组件层：真实 listdialog.js + 桩化的 openModal
 * ================================================================== */

async function bootLibrary() {
  const dir = makeFeSandbox(['listdialog.js']);
  const dom = installFakeDom();
  resetGlobals({});
  const mod = await importFresh(dir, 'listdialog.js');
  return { dom, mod, dir };
}

const plainRows = (n) => Array.from({ length: n }, (_, i) => ({
  id: 'r' + String(i + 1).padStart(2, '0'),
  bucket: 'b' + String(i + 1).padStart(2, '0'),
  remark: '备注' + String(i + 1).padStart(2, '0'),
  provider: i % 2 ? 'tencent' : 's3',
}));
const rowsHtml = (rows) => `<table><tbody>${rows
  .map((r) => `<tr data-id="${r.id}"><td>${r.id}</td></tr>`).join('')}</tbody></table>`;

test('R36 · openListDialog：工具条 + 搜索框 + 计数 + 列表容器，且列表在工具条之后', async () => {
  const { dom, mod } = await bootLibrary();
  const api = mod.openListDialog({
    idPrefix: 'x-all',
    title: '全部（共 12 项）',
    placeholder: '搜索…',
    cls: 'x-all-dialog',
    unit: '项',
    emptyAll: '暂无数据',
    emptyMatch: '没有匹配的项',
    items: () => plainRows(12),
    rowHtml: rowsHtml,
  });
  assertEqual(api.open, true, '打开后句柄应为 open');

  const rec = modal();
  assert(rec.body, '应调用 openModal');
  assertEqual(rec.wide, true, '默认使用宽版弹窗（10 列表格需要更宽）');
  assertEqual(rec.cls, 'x-all-dialog', 'cls 必须经 openModal 参数传递，而不是事后 classList.add');
  assert(/关闭/.test(JSON.stringify(rec.foot)), '应有一个「关闭」按钮');
  assert(/12/.test(String(rec.title)), '标题应由调用方带上总数');

  const body = modalBody();
  for (const frag of ['id="x-all-search"', 'id="x-all-body"', 'id="x-all-count"', 'class="x-all-bar"']) {
    assert(body.includes(frag), `对话框正文里应有 ${frag}`);
  }
  assert(body.indexOf('x-all-body') > body.indexOf('x-all-bar'),
    '列表容器必须排在工具条**之后** —— 顺序反了会把搜索框一起滚走');
  assertEqual(countRows(dom.get('x-all-body').innerHTML), 12, '列表容器里应渲染全部 12 行');
  assertEqual(dom.get('x-all-count').textContent, '共 12 项', '未筛选时显示总数');
});

test('R36 · openListDialog：搜索与下拉筛选、计数文案、两种空态互不混淆', async () => {
  const { dom, mod } = await bootLibrary();
  let data = plainRows(5);
  mod.openListDialog({
    idPrefix: 'y-all',
    title: '全部（共 5 项）',
    placeholder: '搜索…',
    unit: '个存储桶',
    unitShort: '个',
    emptyAll: '还没有绑定存储桶',
    emptyMatch: '没有匹配的存储桶',
    selects: [{
      id: 'provider',
      title: '按服务商筛选',
      value: '',
      options: [
        { value: '', text: '全部服务商' },
        { value: 'tencent', text: '腾讯云' },
        { value: 's3', text: 'S3 兼容' },
      ],
    }],
    items: () => data,
    filter: (list, st) => list.filter((r) => (!st.filters.provider || r.provider === st.filters.provider)
      && (!String(st.query).trim() || r.bucket.indexOf(st.query) !== -1)),
    rowHtml: rowsHtml,
  });

  const search = dom.get('y-all-search');
  const sel = dom.get('y-all-provider');
  assert(sel, '下拉筛选应渲染出来（idPrefix + 选项 id）');
  assertEqual((modalBody().match(/<select/g) || []).length, 1, '本用例只配一个下拉，正文里就应只有一个');

  search.value = 'b02';
  search.oninput();
  assertEqual(countRows(dom.get('y-all-body').innerHTML), 1, '搜索应即时生效');
  assertEqual(dom.get('y-all-count').textContent, '匹配 1 / 共 5 个',
    `筛选生效时计数必须同时给出"匹配 x"与"共 N"（unitShort 生效），实际：${dom.get('y-all-count').textContent}`);

  search.value = 'zzz';
  search.oninput();
  const emptyMatch = dom.get('y-all-body').innerHTML;
  assert(/没有匹配的存储桶/.test(emptyMatch), '筛不到时应给「无匹配」空态');
  assert(!/还没有绑定存储桶/.test(emptyMatch), '「筛不到」与「一条都没有」必须用不同文案，否则用户以为数据丢了');
  assertEqual(countRows(emptyMatch), 0, '空态下不得残留上一轮的行');

  search.value = '';
  search.oninput();
  assertEqual(countRows(dom.get('y-all-body').innerHTML), 5, '清空关键词应恢复全部');

  sel.value = 'tencent';
  sel.onchange();
  assertEqual(countRows(dom.get('y-all-body').innerHTML), 2, '按服务商筛选应生效（5 行里 2 个 tencent）');
  assertEqual(dom.get('y-all-count').textContent, '匹配 2 / 共 5 个', '下拉筛选同样要触发计数更新');

  data = [];
  sel.value = '';
  sel.onchange();
  assert(/还没有绑定存储桶/.test(dom.get('y-all-body').innerHTML), '列表整体为空时应给「暂无数据」空态');
  assertEqual(dom.get('y-all-count').textContent, '共 0 个存储桶', '空列表同样要给出计数口径');
});

test('R36 · openListDialog：items() 每次重绘现取，而不是打开时快照；close() 必须真的关窗', async () => {
  const { dom, mod } = await bootLibrary();
  let data = plainRows(3);
  const api = mod.openListDialog({
    idPrefix: 'z-all',
    title: '全部（共 3 项）',
    placeholder: '搜索…',
    unit: '项',
    items: () => data,
    rowHtml: rowsHtml,
  });
  assertEqual(countRows(dom.get('z-all-body').innerHTML), 3, '前置：先渲染 3 行');

  data = plainRows(3).concat([{ id: 'r04' }]);
  api.repaint();
  assertEqual(countRows(dom.get('z-all-body').innerHTML), 4,
    'items() 必须**现取**：若在打开时快照一份，删掉一条后对话框里却还留着它、新增的也不出现');

  api.close();
  assertEqual(api.open, false, '关闭后句柄应复位（卡片据此清掉自己的引用）');
  assertEqual(globalThis.__closed, 1, '关闭必须真的调用弹窗的 close()');
});

test('R36 · 下拉选项只列数据集里真实出现过的厂商 / 存储桶（不给"选了必然为空"的选项）', async () => {
  const { mod } = await bootLibrary();
  const meta = (id) => ({ tencent: { name: '腾讯云' }, s3: { name: 'S3 兼容' } }[id] || { name: id });

  const prov = mod.providerSelectOptions(
    [{ provider: 's3' }, { provider: 'tencent' }, { provider: 's3' }, {}],
    meta, '全部服务商',
  );
  assertEqual(prov[0].value, '', "首项必须是「全部」（约定 value === '' 表示不筛选）");
  assertEqual(prov.map((o) => o.value).join(','), ',s3,tencent',
    '只列真实出现过的厂商且去重；缺 provider 的行按默认厂商 tencent 计入（不会多出一个空选项）');
  assertEqual(prov.map((o) => o.text)[1], 'S3 兼容',
    '选项文案必须来自 providerMeta（与服务端注册表同源），不能另起一套叫法');

  const bucket = mod.bucketSelectOptions(
    [{ bucket: 'aa' }, { bucket: '' }, { bucket: 'bb' }, { bucket: 'aa' }],
    '全部存储桶',
  );
  assertEqual(bucket.map((o) => o.value).join(','), ',aa,bb',
    '只列真实出现过的桶且去重；bucket 为空的旧数据不占一个选项（它在「全部」下仍可见）');
  assertEqual(bucket[1].text, 'aa', '桶选项文案就是桶名本身');
});

/* ================================================================== *
 * ③ 卡片层：三张列表卡片
 * ================================================================== */

const credRow = (i, extra = {}) => Object.assign({
  id: 'c' + String(i).padStart(2, '0'),
  provider: i % 2 ? 's3' : 'tencent',
  secretIdMasked: 'AKID****' + String(i).padStart(2, '0'),
  remark: '密钥' + String(i).padStart(2, '0'),
  enabled: true,
  visibleToUsers: true,
}, extra);

const bucketRow = (i, extra = {}) => Object.assign({
  id: 'k' + String(i).padStart(2, '0'),
  provider: i % 2 ? 's3' : 'tencent',
  bucket: 'bkt-' + String(i).padStart(2, '0'),
  remark: '桶备注' + String(i).padStart(2, '0'),
  region: 'ap-guangzhou',
  enabled: true,
  stats: {},
}, extra);

const linkRow = (i, extra = {}) => Object.assign({
  id: 'l' + String(i).padStart(3, '0'),
  bucket: 'bkt-' + String(i % 3).padStart(2, '0'),
  key: 'dir/file' + String(i).padStart(3, '0') + '.bin',
  fileName: 'file' + String(i).padStart(3, '0') + '.bin',
  createdBy: i % 2 ? 'bob' : 'alice',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: null,
  maxDownloads: 0,
  downloads: 0,
  hasPassword: false,
  paid: { required: false },
}, extra);

/* ---- 访问密钥卡片 ---- */

async function bootCredCard(creds) {
  const dir = makeFeSandbox(['credmgr.js', 'provider-logos.js']);
  const dom = installFakeDom();
  resetGlobals({
    listCredentials: async () => ({ credentials: globalThis.__creds, activeCredentialId: 'c01' }),
    getConfig: async () => ({ domains: { primary: '', backup: '' } }),
  });
  globalThis.__creds = creds.slice();
  const mod = await importFresh(dir, 'credmgr.js');
  mod.refresh();
  await tick();
  await tick();
  return { dom, mod };
}

test('R36 · 密钥卡片：10 个以内全部展示并隐藏「显示全部」；11 个只渲染前 10 个', async () => {
  const ten = await bootCredCard(Array.from({ length: 10 }, (_, i) => credRow(i + 1)));
  assertEqual(countRows(ten.dom.get('credmgr-table').innerHTML), 10, '正好 10 个应全部展示在卡片里');
  assertEqual(ten.dom.get('cred-more').hidden, true,
    '正好 10 个时必须隐藏按钮：点开只能看到与卡片一字不差的一份副本');
  assertEqual(ten.dom.get('cred-more-hint').textContent, '', '隐藏时不得留下提示文案');

  const eleven = await bootCredCard(Array.from({ length: 11 }, (_, i) => credRow(i + 1)));
  const html = eleven.dom.get('credmgr-table').innerHTML;
  assertEqual(countRows(html), 10, '卡片最多渲染 10 行（需求 2①）');
  assert(!/密钥11/.test(html), '第 11 把密钥不得出现在卡片里');
  assertEqual(eleven.dom.get('cred-more').hidden, false, '超过 10 个必须显示「显示全部」');
  assert(/11/.test(eleven.dom.get('cred-more-hint').textContent), '提示应写明总数');
  assert(/10/.test(eleven.dom.get('cred-more-hint').textContent), '提示应写明"只显示前 10 个"');
});

test('R36 · 密钥卡片：「显示全部」对话框含服务商下拉与搜索框，且第 11 把能删掉', async () => {
  const { dom } = await bootCredCard(Array.from({ length: 11 }, (_, i) => credRow(i + 1)));
  assert(findBtn(dom.get('credmgr-table'), 'del', 'c11') === undefined,
    '前置：第 11 把不在卡片里（否则这条用例白测）');

  await dom.get('btn-cred-all').onclick();
  const rec = modal();
  assert(rec.body, '点「显示全部」必须打开弹窗');
  assertEqual(rec.cls, 'cred-all-dialog', '应带专属尺寸类');
  assert(/全部密钥/.test(String(rec.title)) && /11/.test(String(rec.title)), '标题应含「全部密钥」与总数');
  assert(/id="cred-all-search"/.test(modalBody()), '对话框里必须有搜索框（需求 2②）');
  assert(/id="cred-all-provider"/.test(modalBody()), '对话框里必须有服务商下拉（需求 2②）');
  assert(/全部服务商/.test(modalBody()), '下拉首项应为「全部服务商」');

  assertEqual(countRows(dom.get('cred-all-body').innerHTML), 11, '对话框里应是**全部** 11 把密钥');

  globalThis.__api.deleteCredential = async () => ({ ok: true });
  const btn = findBtn(dom.get('cred-all-body'), 'del', 'c11');
  assert(btn, '对话框里第 11 把必须有「删除」按钮 —— 「列表里看不见的密钥 = 管不了的密钥」');
  await btn.onclick();
  assertEqual(callsOf('deleteCredential').length, 1, '必须真的发出删除请求（按钮接线 + id 传对）');
});

test('R36 · 密钥卡片：对话框按服务商筛选、按备注 / 访问密钥 ID 搜索（同一判据）', async () => {
  const { dom } = await bootCredCard(Array.from({ length: 11 }, (_, i) => credRow(i + 1)));
  await dom.get('btn-cred-all').onclick();

  const sel = dom.get('cred-all-provider');
  sel.value = 's3';
  sel.onchange();
  assertEqual(countRows(dom.get('cred-all-body').innerHTML), 6, '奇数序号（1/3/5/7/9/11）共 6 把是 s3');
  assertEqual(dom.get('cred-all-count').textContent, '匹配 6 / 共 11 个', '计数文案应同步');

  sel.value = '';
  sel.onchange();
  const search = dom.get('cred-all-search');
  search.value = '密钥1';
  search.oninput();
  assertEqual(countRows(dom.get('cred-all-body').innerHTML), 2, '「密钥1」是子串，命中「密钥10」「密钥11」');

  // 需求 2② 文字上只写「搜索备注」，但密钥卡片的搜索框占位符写着
  // 「搜索备注 / 访问密钥 ID」—— 这里把后半句也钉住：只搜备注时这条会失败。
  search.value = 'AKID****07';
  search.oninput();
  assertEqual(countRows(dom.get('cred-all-body').innerHTML), 1,
    '按「访问密钥 ID（掩码）」也要能搜到 —— 否则占位符承诺的一半功能是假的');
});

test('R36 · 密钥卡片：行按钮绑定与用户卡片同型，且表格渲染器唯一', () => {
  const src = readSrc('public', 'js', 'credmgr.js');
  assert(/function credTableHtml\(/.test(src), '应存在唯一渲染器 credTableHtml');
  assert(/function bindCredRowActions\(/.test(src), '行内按钮绑定也必须唯一');
  assertEqual((src.match(/credTableHtml\(/g) || []).length, 3, 'credTableHtml 应为「1 处定义 + 2 处调用」');
  assertEqual((src.match(/bindCredRowActions\(/g) || []).length, 3, 'bindCredRowActions 同样 1 定义 + 2 调用');
  assertEqual((src.match(/<th>服务商<\/th>/g) || []).length, 1, '表头只允许有一份');
  assert(/querySelectorAll\('\[data-act\]'\)/.test(src),
    '行按钮绑定必须与用户卡片同型（扁平 [data-act] + 按钮自带 data-id），四张卡片一种写法');

  for (const f of ['credmgr.js', 'bucketmgr.js', 'linkmgr.js']) {
    const s = readSrc('public', 'js', f);
    assert(/function \w+TableHtml\(/.test(s), `${f} 应有唯一的表格渲染器`);
    // 只检查绑定函数**自身**：同一个文件里别的表（如 bucketmgr 的 IP 规则表）用嵌套查询是它们的事
    const bindFn = /function bind\w+RowActions\(root[\s\S]*?\n\}/.exec(s);
    assert(bindFn, `${f} 应有唯一的 bindXxxRowActions`);
    assert(/querySelectorAll\('\[data-act\]'\)/.test(bindFn[0]),
      `${f} 的绑定函数必须与用户卡片同型（扁平 [data-act]）`);
    assert(!/tr\[data-id\]/.test(bindFn[0]),
      `${f} 不得改用嵌套行查询 —— 四张卡片的绑定写法分叉，测试里的假 DOM 也只得各写一套`);
    assert(!/allUsersQuery|allUsersOpen/.test(s), `${f} 不得残留 R35 的旧状态变量名`);
  }
});

/* ---- 存储桶卡片 ---- */

async function bootBucketCard(rows) {
  const dir = makeFeSandbox(['bucketmgr.js', 'provider-logos.js']);
  const dom = installFakeDom();
  resetGlobals({
    bucketStats: async () => ({ buckets: globalThis.__buckets }),
    ipGuard: async () => ({ rules: [], chinaRangeCount: 0, methods: [] }),
  });
  globalThis.__buckets = rows.slice();
  const mod = await importFresh(dir, 'bucketmgr.js');
  mod.refresh();
  await tick();
  await tick();
  return { dom, mod };
}

test('R36 · 存储桶卡片：10 个以内隐藏「显示全部」；11 个只渲染前 10 个', async () => {
  const ten = await bootBucketCard(Array.from({ length: 10 }, (_, i) => bucketRow(i + 1)));
  try {
    assertEqual(countRows(ten.dom.get('bucketmgr-table').innerHTML), 10, '正好 10 个应全部展示');
    assertEqual(ten.dom.get('bucket-more').hidden, true, '正好 10 个必须隐藏按钮');
  } finally { ten.mod.stop(); }

  const eleven = await bootBucketCard(Array.from({ length: 11 }, (_, i) => bucketRow(i + 1)));
  try {
    const html = eleven.dom.get('bucketmgr-table').innerHTML;
    assertEqual(countRows(html), 10, '卡片最多渲染 10 行（需求 2①）');
    assert(!/bkt-11/.test(html), '第 11 个桶不得出现在卡片里');
    assertEqual(eleven.dom.get('bucket-more').hidden, false, '超过 10 个必须显示「显示全部」');
  } finally { eleven.mod.stop(); }
});

test('R36 · 存储桶卡片：对话框里**只有一个搜索框**，且它能同时搜桶名与备注（需求 2④）', async () => {
  const rows = [
    bucketRow(1, { bucket: 'alpha-logs', remark: '日志归档' }),
    bucketRow(2, { bucket: 'beta-data', remark: '月报' }),
  ].concat(Array.from({ length: 9 }, (_, i) => bucketRow(i + 3)));
  const { dom, mod } = await bootBucketCard(rows);
  try {
    await dom.get('btn-bucket-all').onclick();
    const body = modalBody();
    assertEqual(countSearchBoxes(body), 1,
      '存储桶对话框里必须**只有一个**搜索框（需求 2④）—— 两个输入框会逼用户先判断"我要找的字在哪一栏"');
    assert(/id="bucket-all-provider"/.test(body), '还应有服务商下拉（需求 2②）');

    const search = dom.get('bucket-all-search');
    search.value = 'alpha-logs';
    search.oninput();
    assertEqual(countRows(dom.get('bucket-all-body').innerHTML), 1, '搜索框必须能搜**桶名**（需求 2③）');

    search.value = '日志归档';
    search.oninput();
    assertEqual(countRows(dom.get('bucket-all-body').innerHTML), 1, '同一个搜索框也必须能搜**备注**（需求 2②④）');

    search.value = 'bkt-';
    search.oninput();
    assertEqual(countRows(dom.get('bucket-all-body').innerHTML), 9, '其余 9 个桶名均形如 bkt-NN');
  } finally { mod.stop(); }
});

test('R36 · 存储桶卡片：「只剩一个启用桶不得停用」必须按**全量**判定，筛过的子集不得被当成全域', async () => {
  // 全量：2 个启用（k01 腾讯云 / k03 S3）+ 10 个停用
  const rows = [
    bucketRow(1, { provider: 'tencent' }),
    bucketRow(2, { provider: 'tencent', enabled: false }),
    bucketRow(3, { provider: 's3' }),
  ].concat(Array.from({ length: 10 }, (_, i) => bucketRow(i + 4, { provider: 's3', enabled: false })));
  const { dom, mod } = await bootBucketCard(rows);
  try {
    await dom.get('btn-bucket-all').onclick();
    const sel = dom.get('bucket-all-provider');
    sel.value = 'tencent'; // 子集 = k01（启用）+ k02（停用）→ 子集内"启用数"= 1
    sel.onchange();
    assertEqual(countRows(dom.get('bucket-all-body').innerHTML), 2, '前置：子集应为 2 个桶');

    const btn = findBtn(dom.get('bucket-all-body'), 'dis', 'k01');
    assert(btn, '前置：k01 应有一个「停用」按钮');
    assertEqual(btn.attrs.disabled, undefined,
      'k01 必须**仍可停用**（全局还有 2 个启用桶）。若判据用了过滤后的子集，这里会算出'
      + '"只剩一个启用桶"而把按钮锁死 —— 卡片上明明能停用、对话框里却不能，是最容易漏的一类不一致');
  } finally { mod.stop(); }
});

test('R36 · 存储桶卡片：非管理员点「显示全部」不开弹窗', async () => {
  const { dom, mod } = await bootBucketCard(Array.from({ length: 11 }, (_, i) => bucketRow(i + 1)));
  try {
    globalThis.__me = { id: 'me', username: 'bob', role: 'user' };
    await dom.get('btn-bucket-all').onclick();
    assertEqual((globalThis.__modals || []).length, 0, '普通用户不得打开存储桶对话框');
  } finally { mod.stop(); }
});

/* ---- 分享链接卡片 ---- */

async function bootLinkCard(links) {
  const dir = makeFeSandbox(['linkmgr.js', 'share-status.js']);
  const dom = installFakeDom();
  resetGlobals({ links: async () => ({ links: globalThis.__links }) });
  globalThis.__links = links.slice();
  const mod = await importFresh(dir, 'linkmgr.js');
  mod.refresh();
  await tick();
  await tick();
  return { dom, mod };
}

test('R36 · 分享链接卡片：100 条以内隐藏「显示全部」；101 条只渲染前 100 条（需求 3）', async () => {
  const hundred = await bootLinkCard(Array.from({ length: 100 }, (_, i) => linkRow(i)));
  assertEqual(countRows(hundred.dom.get('linkmgr-table').innerHTML), 100, '正好 100 条应全部展示');
  assertEqual(hundred.dom.get('link-more').hidden, true, '正好 100 条必须隐藏按钮');

  const over = await bootLinkCard(Array.from({ length: 101 }, (_, i) => linkRow(i)));
  const html = over.dom.get('linkmgr-table').innerHTML;
  assertEqual(countRows(html), 100, '卡片最多渲染 100 行（需求 3）');
  assert(!/file100/.test(html), '第 101 条不得出现在卡片里');
  assertEqual(over.dom.get('link-more').hidden, false, '101 条必须显示「显示全部」');
  assert(/101/.test(over.dom.get('link-more-hint').textContent), '提示应写明总数');
  assert(/100/.test(over.dom.get('link-more-hint').textContent), '提示应写明"只显示前 100 条"');
});

test('R36 · 分享链接卡片：对话框可按存储桶筛选，并搜文件名与分享者（需求 3）', async () => {
  const links = [
    linkRow(0, { bucket: 'bkt-00', fileName: '季度报表.xlsx', createdBy: 'alice' }),
    linkRow(1, { bucket: 'bkt-01', fileName: 'photo.jpg', createdBy: 'bob' }),
  ].concat(Array.from({ length: 99 }, (_, i) => linkRow(i + 2)));
  const { dom } = await bootLinkCard(links);
  await dom.get('btn-link-all').onclick();

  const rec = modal();
  assertEqual(rec.cls, 'link-all-dialog', '应带专属尺寸类（10 列表格）');
  assert(/id="link-all-bucket"/.test(modalBody()), '应有存储桶下拉（需求 3）');
  assert(/全部存储桶/.test(modalBody()), '下拉首项应为「全部存储桶」');
  assertEqual(countRows(dom.get('link-all-body').innerHTML), 101, '对话框里应是全部 101 条');

  const search = dom.get('link-all-search');
  search.value = '季度';
  search.oninput();
  assertEqual(countRows(dom.get('link-all-body').innerHTML), 1, '必须能搜**文件名**（需求 3）');

  search.value = 'bob';
  search.oninput();
  assertEqual(countRows(dom.get('link-all-body').innerHTML), 50,
    `必须能搜**分享者**（奇数序号共 50 条），实际 ${countRows(dom.get('link-all-body').innerHTML)}`);

  search.value = '';
  search.oninput();
  const sel = dom.get('link-all-bucket');
  sel.value = 'bkt-00';
  sel.onchange();
  assertEqual(countRows(dom.get('link-all-body').innerHTML), 34,
    `必须能按存储桶筛选（序号被 3 整除的共 34 条），实际 ${countRows(dom.get('link-all-body').innerHTML)}`);
});

test('R36 · 分享链接卡片：历史链接（bucket 为空）在「全部存储桶」下仍可见，不被筛选悄悄藏起来', async () => {
  const { dom } = await bootLinkCard([linkRow(0, { bucket: '' }), linkRow(1, { bucket: 'bkt-01' })]);
  await dom.get('btn-link-all').onclick();
  const sel = dom.get('link-all-bucket');
  sel.value = '';
  sel.onchange();
  assertEqual(countRows(dom.get('link-all-body').innerHTML), 2,
    'bucket 为空的旧数据必须仍然可见（下拉只列真实出现过的桶，但「全部」下不排除任何一条）');
});

/* ================================================================== *
 * ④ 「全部用户」对话框的角色筛选（需求 0）
 * ================================================================== */

const userRow = (id, username, extra = {}) => Object.assign({
  id,
  username,
  role: 'user',
  permissions: {},
  webauthnEnabled: false,
  ban: { state: 'none', active: false, reason: '', until: '' },
  createdAt: '',
  updatedAt: '',
}, extra);

/** 渲染出的用户行数（每行都以 `<td><b>用户名` 开头） */
const countUserRows = (html) => (String(html).match(/<td><b>/g) || []).length;

async function bootUserCard(users) {
  const dir = makeFeSandbox(['syssettings.js']);
  const dom = installFakeDom();
  resetGlobals({
    users: async () => ({ users: globalThis.__users }),
    quotaUsage: async () => ({ credentials: [] }),
  });
  globalThis.__users = users.slice();
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();
  await tick();
  await tick();
  return { dom, mod };
}

test('R36 · 全部用户对话框：新增角色下拉，选中后按角色筛选（需求 0）', async () => {
  const users = [
    userRow('a1', 'admin01', { role: 'admin' }),
    userRow('a2', 'admin02', { role: 'admin' }),
  ].concat(Array.from({ length: 10 }, (_, i) => userRow('u' + i, 'member' + i)));
  const { dom } = await bootUserCard(users);

  await dom.get('btn-user-all').onclick();
  const body = modalBody();
  assert(/id="user-all-role"/.test(body), '「全部用户」对话框里必须有角色下拉（需求 0）');
  assert(/全部角色/.test(body), '下拉首项应为「全部角色」');
  assert(/管理员/.test(body) && /普通用户/.test(body), '两个角色都要在下拉里可选');
  assertEqual(countUserRows(dom.get('user-all-body').innerHTML), 12, '前置：默认展示全部 12 位');

  const sel = dom.get('user-all-role');
  sel.value = 'admin';
  sel.onchange();
  assertEqual(countUserRows(dom.get('user-all-body').innerHTML), 2, '选「管理员」应只剩 2 位');
  assert(/admin01/.test(dom.get('user-all-body').innerHTML), '管理员必须在结果里');
  assert(!/member1/.test(dom.get('user-all-body').innerHTML), '普通用户必须被筛掉');
  assertEqual(dom.get('user-all-count').textContent, '匹配 2 / 共 12 位', '计数文案应同步');

  sel.value = 'user';
  sel.onchange();
  assertEqual(countUserRows(dom.get('user-all-body').innerHTML), 10, '选「普通用户」应剩 10 位');

  // 关键词与下拉必须是**与**关系（两个条件同时生效），而不是后者覆盖前者
  const search = dom.get('user-all-search');
  search.value = 'member1';
  search.oninput();
  assertEqual(countUserRows(dom.get('user-all-body').innerHTML), 1,
    '前置：普通用户里只有 member1 命中关键词');

  sel.value = 'admin';
  sel.onchange();
  assertEqual(countUserRows(dom.get('user-all-body').innerHTML), 0,
    '管理员 ∩ 关键词 member1 = 空 —— 若下拉覆盖了关键词，这里会错误地剩下 2 位管理员');
  assert(/没有匹配的用户/.test(dom.get('user-all-body').innerHTML), '空结果应给「无匹配」空态');

  sel.value = '';
  sel.onchange();
  assertEqual(countUserRows(dom.get('user-all-body').innerHTML), 1, '清空角色筛选应恢复关键词过滤的结果');
});

test('R36 · 全部用户对话框：角色下拉参与"是否在筛选"的判定（复位后计数文案要收回去）', async () => {
  const users = Array.from({ length: 11 }, (_, i) => userRow('u' + i, 'member' + i, { role: i ? 'user' : 'admin' }));
  const { dom } = await bootUserCard(users);
  await dom.get('btn-user-all').onclick();
  assertEqual(dom.get('user-all-count').textContent, '共 11 位用户', '未筛选时是「共 N」而不是「匹配 x / 共 N」');

  const sel = dom.get('user-all-role');
  sel.value = 'user';
  sel.onchange();
  assertEqual(dom.get('user-all-count').textContent, '匹配 10 / 共 11 位',
    '只动下拉、没动搜索框，计数也必须切成"匹配"口径 —— 否则用户看不出列表已经被筛过');

  sel.value = '';
  sel.onchange();
  assertEqual(dom.get('user-all-count').textContent, '共 11 位用户',
    '下拉复位到「全部角色」后必须收回"匹配"口径（filtering() 要把下拉一起算进去）');
});

test('R36 · 四张卡片共用同一套预览判据与同一套对话框骨架（不得各写一份）', () => {
  const util = readSrc('public', 'js', 'util.js');
  assertEqual((util.match(/function previewMoreState\(/g) || []).length, 1,
    '「显示全部」的判据只允许有一处实现（util.previewMoreState）');
  assertEqual((util.match(/function matchesQuery\(/g) || []).length, 1,
    '关键词匹配只允许有一处实现（util.matchesQuery）');

  for (const f of ['syssettings.js', 'credmgr.js', 'bucketmgr.js', 'linkmgr.js']) {
    const s = readSrc('public', 'js', f);
    assert(/previewMoreState\(/.test(s), `${f} 应使用共享的 previewMoreState`);
    assert(/openListDialog\(/.test(s), `${f} 应使用共享的 openListDialog`);
    assert(!/total\s*>\s*\w*PREVIEW_LIMIT/.test(s),
      `${f} 不得就地重写"严格大于"判据（写两份必然有一天一边被改成 >=）`);
    assert(/slice\(0,\s*[A-Z_]+PREVIEW_LIMIT\)/.test(s),
      `${f} 的卡片截断必须引用常量（就地写死数字会与提示文案分家）`);
  }
  assertEqual((readSrc('public', 'js', 'listdialog.js').match(/export function openListDialog\(/g) || []).length, 1,
    '对话框骨架只允许有一份实现');
});

test('R36 · 样式：四张卡片的对话框与「显示全部」共用同一组规则，且 flex 容器上的 hidden 必须显式声明', () => {
  const css = readSrc('public', 'css', 'style.css');
  const bodyOf = (sel) => {
    const i = css.indexOf(sel);
    return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
  };

  for (const p of ['user-all', 'cred-all', 'bucket-all', 'link-all']) {
    assert(new RegExp(`\\.${p}-body`).test(css), `缺少 ${p}-body 的样式规则`);
    assert(new RegExp(`\\.${p}-search`).test(css), `缺少 ${p}-search 的样式规则`);
    assert(new RegExp(`\\.${p}-count`).test(css), `缺少 ${p}-count 的样式规则`);
  }
  assert(/overflow:\s*auto/.test(bodyOf('.cred-all-body')), '对话框列表必须有自己的滚动条');
  assert(/max-height/.test(bodyOf('.cred-all-body')), '没有 max-height 就永远不会有滚动条');
  assert(/position:\s*sticky/.test(bodyOf('.bucket-all-body .lk-table thead th')), '长列表滚动时表头应吸顶');
  assert(/display:\s*none/.test(bodyOf('.list-more[hidden]')),
    '「显示全部」的容器是 display:flex —— 必须显式写 [hidden]{display:none}，'
    + '否则 hidden 属性对 flex 容器完全无效，10 条以内也会一直露着按钮');

  const html = readSrc('public', 'index.html');
  for (const [btn, wrap] of [
    ['btn-cred-all', 'cred-more'], ['btn-bucket-all', 'bucket-more'],
    ['btn-link-all', 'link-more'], ['btn-user-all', 'user-more'],
  ]) {
    assert(new RegExp(`id="${btn}"`).test(html), `index.html 里应有 ${btn}`);
    assert(new RegExp(`id="${wrap}"[^>]*hidden`).test(html), `${wrap} 应默认 hidden（渲染之前不得闪现）`);
  }
});

/* ================================================================== *
 * ⑤ 服务端层：对象元数据里的「上传者」
 * ================================================================== */

test('R36 · cos.uploaderMeta / readUploader：唯一实现点，空用户名不写空值元数据', () => {
  assertEqual(cos.UPLOADER_META, 'x-cos-meta-uploader', '元数据键名应集中定义在一个常量上');

  assertEqual(JSON.stringify(cos.uploaderMeta('alice')), JSON.stringify({ 'x-cos-meta-uploader': 'alice' }));
  assertEqual(JSON.stringify(cos.uploaderMeta('  bob  ')), JSON.stringify({ 'x-cos-meta-uploader': 'bob' }),
    '两侧空白应去掉（用户名字段可能带空白，写进元数据后前端会原样显示）');
  for (const empty of ['', '   ', null, undefined]) {
    assertEqual(JSON.stringify(cos.uploaderMeta(empty)), '{}',
      `空用户名（${JSON.stringify(empty)}）必须返回**空对象**而不是空值元数据：`
      + '写入 `x-cos-meta-uploader: ""` 会让云端多一个永远为空的字段，'
      + '而前端「没有这项元数据」与「元数据是空串」是两条不同的显示路径');
  }

  assertEqual(cos.readUploader({ 'x-cos-meta-uploader': 'alice' }), 'alice', '应能读回写入的值');
  assertEqual(cos.readUploader({ 'x-cos-meta-uploader': '  alice  ' }), 'alice', '读取端同样去空白');
  assertEqual(cos.readUploader({}), '', '没有该字段时返回空串（前端据此显示「—」）');
  assertEqual(cos.readUploader(null), '', 'headers 为 null 不得抛错');
});

test('R36 · 元数据键名只在 cos.js 出现（新增出口不得自己拼字面量）', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'server'));
  const offenders = files
    .filter((p) => path.basename(p) !== 'cos.js')
    .filter((p) => /x-cos-meta-uploader/.test(fs.readFileSync(p, 'utf8')))
    .map((p) => path.relative(ROOT, p));
  assertEqual(offenders.join(','), '',
    '元数据键名只允许在 cos.js 出现（uploaderMeta / readUploader 是唯一实现点）—— '
    + '别的模块自己拼字面量，改名时必然漏一处，表现为「网页上传的能看到上传者、WebDAV 的看不到」');
});

test('R36 · 真实 fs-gateway.writeObject：上传者必须真的进到云端请求头里（第 7 个参数不得半路丢掉）', async () => {
  PVCALLS.length = 0;
  await gateway.writeObject('r36-bucket', 'up/a.txt', Buffer.from('hello'), 'text/plain', null, null, 'alice');
  const put = PVCALLS.filter((c) => c.method === 'putObject').pop();
  assert(put, '前置：应发生一次 putObject');
  assertEqual(put.params.Headers['x-cos-meta-uploader'], 'alice',
    'writeObject 的第 7 个参数（uploader）必须落到请求头 —— 半路丢掉的话，'
    + 'WebDAV 与分享页写入的对象在属性面板里永远显示「—」，而网页上传的却有值');
  assertEqual(put.params.Headers['Content-Type'], 'text/plain', '原有的 Content-Type 不得被挤掉');

  PVCALLS.length = 0;
  await gateway.writeObject('r36-bucket', 'up/b.txt', Buffer.from('hi'), 'text/plain', null, null, '');
  const put2 = PVCALLS.filter((c) => c.method === 'putObject').pop();
  assert(put2, '前置：应发生第二次 putObject');
  assertEqual(put2.params.Headers['x-cos-meta-uploader'], undefined, '上传者为空时不得写入空值元数据');
});

test('R36 · 两个适配器把 x-cos-meta-* 翻译成各自的厂商头（单传与分片两条路径共用同一映射）', () => {
  const { S3Client } = require(SERVER('s3-client.js'));
  const { AzureBlobClient } = require(SERVER('azure-client.js'));
  const cosMeta = { 'x-cos-meta-uploader': 'alice' };

  const s3 = new S3Client({ accessKeyId: 'a', secretAccessKey: 'b', endpoint: 'https://s3.example.com' });
  const s3out = s3._metaHeaders(Object.assign({ 'Content-Type': 'text/plain' }, cosMeta));
  assertEqual(s3out['x-amz-meta-uploader'], 'alice', 'S3 / COS 侧应翻译为 x-amz-meta-*');
  assertEqual(s3out['x-cos-meta-uploader'], undefined, '翻译后不得留下 x-cos-meta-* 原键');
  assertEqual(s3out['Content-Type'], 'text/plain', '非元数据头必须原样保留');

  const az = new AzureBlobClient({ accountName: 'acct01', accountKey: Buffer.alloc(32, 1).toString('base64') });
  const azOut = az._metaHeaders(cosMeta);
  assertEqual(azOut['x-ms-meta-uploader'], 'alice', 'Azure 侧应翻译为 x-ms-meta-*');
  assertEqual(azOut['x-cos-meta-uploader'], undefined, '翻译后不得留下 x-cos-meta-* 原键');

  const s3src = readSrc('server', 's3-client.js');
  const azSrc = readSrc('server', 'azure-client.js');
  assert(/multipartInit\(params[^)]*\)[\s\S]{0,400}this\._metaHeaders\(params\.Headers\)/.test(s3src),
    'S3/COS 的对象元数据**只能**在创建时（multipartInit）写入，故这里必须走同一映射');
  assert(/putObject\(params[^)]*\)[\s\S]{0,400}this\._metaHeaders\(params\.Headers\)/.test(s3src),
    'putObject 必须与 multipartInit 共用 _metaHeaders，两处各写一份必然分叉');
  assertEqual((s3src.match(/_metaHeaders\(/g) || []).length, 3,
    's3-client 中 _metaHeaders 应恰为「1 处定义 + 2 处调用」');
  assertEqual((azSrc.match(/_metaHeaders\(/g) || []).length, 3,
    'azure-client 中 _metaHeaders 应恰为「1 处定义 + 2 处调用」（putObject + multipartComplete）');
});

test('R36 · 写入点必须都带上上传者：mkdir / 直传 / 分片 init+complete / WebDAV PUT+MKCOL', () => {
  const fsRoute = readSrc('server', 'routes', 'fs.js');
  assert(/uploaderMeta, readUploader,/.test(fsRoute), 'fs.js 应同时导入写入端与读取端');

  // 分片上传：对象元数据只能在 init 时写入（S3/COS 语义），故 init 必须带
  assert(/multipartInit',\s*\{[\s\S]{0,300}?Headers:\s*uploaderMeta\(/.test(fsRoute),
    '分片上传必须在 multipartInit 带上传者 —— S3/COS 的对象元数据只在创建时生效');
  // 而 Azure 的 Put Block List 接受元数据，故 complete 也要带上（会话创建者，不是当前请求者）
  assert(/multipartComplete'[\s\S]{0,1200}?Headers:\s*uploaderMeta\(sess\.createdBy\)/.test(fsRoute),
    '分片 complete 必须带**会话创建者**（不是当前请求者）：Azure 的 Put Block List 接受元数据，'
    + '而分片可能由不同会话续传，取当前请求者会把别人的名字写上去');
  // ⚠️ 必须是**计数**断言，而不是「文件里存在这个模式串」：mkdir 与直传用的是**同一个**
  // 模式串，只判 `.test()` 时删掉其中一个、另一个仍在，护栏照样全绿 ——
  // 本轮 R36-08d 实测就是 fail=0 的假绿（名字写着「mkdir / 直传」却只兜住了「至少一处」）。
  assertEqual((fsRoute.match(/uploaderMeta\(req\.authUser && req\.authUser\.username\)/g) || []).length, 2,
    'mkdir 与直传**各自**都要以当前登录用户作为上传者');

  // 读取端：两个分支都要给出 uploader
  const statIdx = fsRoute.indexOf("router.get('/fs/stat'");
  assert(statIdx >= 0, '前置：fs.js 应有 /fs/stat 路由');
  const nextRoute = fsRoute.indexOf('router.', statIdx + 10);
  const handler = fsRoute.slice(statIdx, nextRoute > 0 ? nextRoute : statIdx + 3000);
  assertEqual((handler.match(/readUploader\(/g) || []).length, 2,
    '文件夹分支与文件分支**各自**都要读一次上传者 —— 只改一支的表现是'
    + '「文件夹属性有创建者、文件属性永远显示 —」');

  const dav = readSrc('server', 'webdav-server.js');
  assertEqual((dav.match(/uploaderMeta\(req\.webdavUser && req\.webdavUser\.username\)/g) || []).length, 2,
    'WebDAV 的 PUT（写入目录标记）与 MKCOL 都要带上传者，否则 WebDAV 建的一切在属性面板里都是「—」');
  assert(/writeObject\([\s\S]{0,240}?req\.webdavUser && req\.webdavUser\.username/.test(dav),
    'WebDAV 的 writeObject 调用必须把用户名作为第 7 个参数传下去');
});

test('R36 · movePrefix 重建空目录标记时必须**沿用**原标记的上传者（不得变成"无主"）', () => {
  const src = readSrc('server', 'fs-gateway.js');
  const i = src.indexOf('async function movePrefix');
  assert(i >= 0, '前置：fs-gateway 应有 movePrefix');
  const body = src.slice(i, i + 12000);
  assert(/headObject[\s\S]{0,300}?srcP \+ '\/'/.test(body),
    '重建目录标记前应先读原标记对象的元数据');
  assert(/markerMeta = uploaderMeta\(readUploader\(h\.headers\)\)/.test(body),
    '重建的标记必须沿用原上传者：移动一个别人建的文件夹不该把它变成"无主"，'
    + '而这里不是服务端复制、是 new 一个对象 —— 不显式搬运就会丢掉');
});
