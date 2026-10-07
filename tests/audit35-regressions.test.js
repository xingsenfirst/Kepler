/**
 * 第三十五轮护栏（R35）—— 「用户管理」卡片：10 条预览 + 「显示全部」对话框
 *
 * 需求（逐条对应到下面的用例）：
 *  1. 卡片列表最多展示 10 个用户                     → `USER_PREVIEW_LIMIT` + 截断行为
 *  2. 用户 ≤10 个：卡片展示全部，并**隐藏**「显示全部」 → 边界用例（正好 10 个 / 9 个）
 *  3. 用户 >10 个：出现「显示全部」，点击打开对话框     → 按钮显隐 + 弹窗结构
 *  4. 对话框要有滚动条、搜索框与合适的尺寸            → 搜索过滤 / 空态 / 滚动容器 / 专属宽度
 *
 * 三层断言的分工（缺任何一层都会留下「假绿」）：
 *  ① **纯函数层**：`util.filterUsersByName` 的匹配规则（大小写、空串、脏数据、不改入参）；
 *  ② **前端层**：真实 `syssettings.js` + 假 DOM。只断言源码字样挡不住「按钮没接线」
 *     「截断写了 slice(0,10) 但按钮判据用 `>=`」「对话框里的行根本没操作按钮」；
 *  ③ **样式层**：静态断言滚动容器 / 吸顶表头 / 专属宽度；尤其是
 *     **`display:flex` 会让 `hidden` 属性彻底失效**（见文件末尾那条用例）——
 *     这类"看着写了 hidden、其实一直露着"的问题静态断言是唯一能拦住它的地方。
 *
 * ⚠️ 沙箱里的 `util.js` 只把**依赖 DOM** 的 `toast / confirmDialog / openModal` 换成桩，
 *    其余（`escapeHtml` / `filterUsersByName` / `USER_PREVIEW_LIMIT` / `fmtTime`）**直接
 *    再导出真实实现** —— 否则「被测的纯函数」与「被测的转义」都成了测试自己写的副本，
 *    只能证明自洽（R30 的假 Azure 就是这么栽的）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { pathToFileURL } = require('url');
const { assert, assertEqual, ROOT } = require('./helpers.js');

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);
const tick = () => new Promise((r) => setTimeout(r, 0));

/* ================================================================== *
 * 假 DOM（与 audit33 同源：多一项 **解析 innerHTML** 的能力）
 *
 * 用户列表的行（含「编辑 / 封禁 / 删除」按钮）是渲染进 `innerHTML` 的，不是写死在
 * index.html 里的。因此必须能从 HTML 片段里把 `id` / `data-act` / `data-id` 抽出来 ——
 * 否则 `querySelectorAll('[data-act]')` 恒为空，「按钮没接线」会被静默放过。
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
    disabled: false, style: {}, dataset: {}, className: '', attrs: {}, _btns: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute(k) { const v = this.attrs[String(k).toLowerCase()]; return v === undefined ? null : v; },
    querySelector(sel) {
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
  return { els: byId, get: (id) => globalThis.document.getElementById(id) };
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

/**
 * `util.js` 桩 —— **只**替换依赖 DOM 的三个函数，其余再导出真实实现。
 *
 * `openModal` 的桩必须与真实实现**同形**：关窗时调用 `onClose`。真实实现里有这一步，
 * 桩若不调用，「关窗后状态没复位 → 再也打不开对话框」这条就永远测不出来。
 */
function utilShim() {
  const real = pathToFileURL(JS('util.js')).href;
  return `
export { escapeHtml, fmtTime, fmtSize, updateNotice, filterUsersByName, USER_PREVIEW_LIMIT, previewMoreState } from '${real}';
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

/** `main.js` 桩：只需 App.state.user（isAdmin / 当前账户的判据），身份由 __me 控制 */
const MAIN_STUB = `
export const App = { state: { get user() { return globalThis.__me || null; } } };
`;

const WEBAUTHN_STUB = `
export const registerWindowsHello = async () => ({});
export const webauthnReadiness = () => ({ ok: true, hint: '' });
`;
const PAYSETTINGS_STUB = `
export const loadPayment = () => {};
export const resetPaymentView = () => {};
`;

/** 在临时模块图里放一份**真实**模块（连带它 import 的同目录依赖的桩） */
function makeFeSandbox(realFiles) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r35-fe-'));
  fs.writeFileSync(path.join(dir, 'api.js'), API_STUB);
  fs.writeFileSync(path.join(dir, 'util.js'), utilShim());
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN_STUB);
  fs.writeFileSync(path.join(dir, 'webauthn.js'), WEBAUTHN_STUB);
  fs.writeFileSync(path.join(dir, 'paysettings.js'), PAYSETTINGS_STUB);
  for (const f of realFiles) fs.copyFileSync(JS(f), path.join(dir, f));
  // R36：syssettings.js 现在 import './listdialog.js'（列表对话框骨架）——
  // 沙箱缺了它会在 ESM 链接期直接失败，所有 import syssettings 的用例整片变红。
  fs.copyFileSync(JS('listdialog.js'), path.join(dir, 'listdialog.js'));
  // R37：syssettings.js 现在 import './speedlimit.js'（「限速」列 + 限速对话框）——
  // 同一条链接期规则，缺文件则本文件所有 import syssettings 的用例一起红。
  fs.copyFileSync(JS('speedlimit.js'), path.join(dir, 'speedlimit.js'));
  // R38：syssettings.js 又 import 了 './backupcfg.js'（「备份配置」卡片）—— 同一条链接期规则。
  fs.copyFileSync(JS('backupcfg.js'), path.join(dir, 'backupcfg.js'));
  return dir;
}

const importFresh = (dir, file) => import('file://' + path.join(dir, file).replace(/\\/g, '/')
  + '?v=' + Math.random());

const callsOf = (fn) => (globalThis.__calls || []).filter((c) => c.fn === fn);
const findBtn = (el, act, dataId) => (el._btns || [])
  .find((b) => b.attrs['data-act'] === act && (dataId === undefined || b.attrs['data-id'] === dataId));

/** 渲染出的用户行数（每行都以 `<td><b>用户名` 开头） */
const countRows = (html) => (String(html).match(/<td><b>/g) || []).length;

const row = (id, username, extra = {}) => Object.assign({
  id,
  username,
  role: 'user',
  permissions: {},
  webauthnEnabled: false,
  ban: { state: 'none', active: false, reason: '', until: '' },
  createdAt: '',
  updatedAt: '',
}, extra);

/** n 位用户：member01 … memberNN（两位数编号，避免 member1 与 member11 的前缀混淆） */
const manyUsers = (n) => Array.from({ length: n }, (_, i) => {
  const k = String(i + 1).padStart(2, '0');
  return row('u' + k, 'member' + k);
});

/** 准备一个 syssettings 沙箱并跑完 refresh（管理员身份） */
async function bootUserCard(users, overrides = {}) {
  const dir = makeFeSandbox(['syssettings.js']);
  const dom = installFakeDom();
  globalThis.__me = { id: 'me', username: 'admin', role: 'admin' };
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__confirms = [];
  globalThis.__modals = [];
  globalThis.__closed = 0;
  globalThis.__deleted = [];
  globalThis.__usersList = users.slice();
  globalThis.__api = Object.assign({
    users: async () => ({ users: globalThis.__usersList }),
    quotaUsage: async () => ({ credentials: [] }),
    // 删除走真实语义：调用后列表里就没有这个人了（下一次 loadUsers 会看到少一位）
    deleteUser: async (id) => {
      globalThis.__deleted.push(id);
      globalThis.__usersList = globalThis.__usersList.filter((u) => u.id !== id);
      return { ok: true };
    },
  }, overrides);
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();
  await tick();
  await tick();
  return { dom, mod };
}

/* ================================================================== *
 * ① 纯函数层 · filterUsersByName / USER_PREVIEW_LIMIT
 * ================================================================== */

test('R35 · 纯函数：搜索按用户名的大小写不敏感子串匹配，空串全量、脏数据不抛错、不改入参', async () => {
  const { filterUsersByName, USER_PREVIEW_LIMIT } = await import(pathToFileURL(JS('util.js')).href);
  const list = [row('1', 'Alice'), row('2', 'bob'), row('3', 'ALICIA'), row('4', '')];

  assertEqual(USER_PREVIEW_LIMIT, 10, '预览上限必须是 10（需求 1 的字面要求）');

  assertEqual(filterUsersByName(list, '').length, 4, '空关键词应返回全部');
  assertEqual(filterUsersByName(list, '   ').length, 4, '只有空白也按空处理（用户误按空格不该把列表清空）');
  assertEqual(filterUsersByName(list, undefined).length, 4, 'undefined 关键词不得抛错');
  assertEqual(filterUsersByName(list, 'ali').map((u) => u.username).join(','), 'Alice,ALICIA',
    '应按子串匹配且大小写不敏感');
  assertEqual(filterUsersByName(list, 'ALI').length, 2, '大写关键词与消息大小写无关');
  assertEqual(filterUsersByName(list, 'zzz').length, 0, '无匹配返回空数组（而不是全体）');

  assertEqual(filterUsersByName(null, 'x').length, 0, '列表为 null 不得抛错');
  assertEqual(filterUsersByName([null, { username: 'ok' }], '').length, 2, '脏条目照样返回');
  assertEqual(filterUsersByName([null], 'o').length, 0, '脏条目在过滤时按空用户名处理，不得抛错');

  const snapshot = list.slice();
  filterUsersByName(list, 'ali');
  assertEqual(list.length, snapshot.length, '过滤不得修改入参（调用方持有的是模块级 usersState）');
  assert(list.every((u, i) => u === snapshot[i]), '入参的元素身份与顺序都不得被改动');
  assert(filterUsersByName(list, '') !== list,
    '空关键词必须返回**副本**：把 usersState 本体交出去后，调用方任何一次 sort/splice 都会就地改掉模块状态，'
    + '而"过滤"这个动作看上去是无害的');
});

/* ================================================================== *
 * ② 前端层 · 卡片列表的截断与「显示全部」按钮
 * ================================================================== */

test('R35 · 前端：10 位（与 9 位）用户时卡片展示全部，且「显示全部」按钮隐藏（需求 2）', async () => {
  const ten = await bootUserCard(manyUsers(10));
  const html10 = ten.dom.get('user-table').innerHTML;
  assert(html10, '前置：卡片应渲染出列表');
  assertEqual(countRows(html10), 10, '恰好 10 位时应全部展示在卡片里');
  assert(/member10/.test(html10), '第 10 位必须在卡片里可见');
  assertEqual(ten.dom.get('user-more').hidden, true,
    '正好 10 位时必须隐藏「显示全部」：此时点开只会看到与卡片一字不差的一份副本');
  assertEqual(ten.dom.get('user-more-hint').textContent, '', '隐藏时不得留下总数提示文案');

  const nine = await bootUserCard(manyUsers(9));
  assertEqual(countRows(nine.dom.get('user-table').innerHTML), 9, '9 位时卡片展示全部 9 位');
  assertEqual(nine.dom.get('user-more').hidden, true, '少于 10 位同样隐藏按钮');
});

test('R35 · 前端：11 位用户时卡片只渲染前 10 位，「显示全部」出现并写明总数（需求 1 / 3）', async () => {
  const { dom } = await bootUserCard(manyUsers(11));
  const html = dom.get('user-table').innerHTML;

  assertEqual(countRows(html), 10, '卡片最多渲染 10 行（需求 1）');
  assert(!/member11/.test(html), '第 11 位不得出现在卡片里 —— 否则「最多 10 个」根本没做到');
  assertEqual(dom.get('user-more').hidden, false, '超过 10 位必须显示「显示全部」按钮');

  const hint = dom.get('user-more-hint').textContent;
  assert(/11/.test(hint), `提示应写明总人数，实际：${hint}`);
  assert(/10/.test(hint), `提示应写明"只显示前 10 位"（数字取自 USER_PREVIEW_LIMIT），实际：${hint}`);
});

test('R35 · 前端：点「显示全部」打开对话框 —— 宽版 + 专属尺寸类 + 搜索框 + 列表容器 + 全部用户（需求 3 / 4）', async () => {
  const { dom } = await bootUserCard(manyUsers(12));
  await dom.get('btn-user-all').onclick();

  const modal = (globalThis.__modals || [])[0];
  assert(modal, '点「显示全部」必须打开弹窗（需求 3 的载体）');
  assertEqual(modal.wide, true, '应使用宽版弹窗');
  assertEqual(modal.cls, 'user-all-dialog', '应带专属尺寸类（7 列表格比通用宽版更宽）');
  assert(/全部用户/.test(String(modal.title)), `标题应表明这是全部用户，实际：${modal.title}`);
  assert(/12/.test(String(modal.title)), '标题应带上总数（用户据此确认没漏人）');
  assert(/关闭/.test(JSON.stringify(modal.foot)), '应有一个「关闭」按钮');

  const bodyHtml = String(modal.body.innerHTML || '');
  assert(/id="user-all-search"/.test(bodyHtml), '对话框里必须有搜索框（需求 4）');
  assert(/type="search"/.test(bodyHtml), '搜索框应为 search 类型（自带清除按钮，语义清晰）');
  assert(/id="user-all-body"/.test(bodyHtml), '对话框里必须有列表容器');
  assert(/class="user-all-body"/.test(bodyHtml),
    '列表容器应带 user-all-body 类 —— 滚动条与吸顶表头都挂在它上面（见样式断言）');

  const listHtml = dom.get('user-all-body').innerHTML;
  assertEqual(countRows(listHtml), 12, '对话框里应是**全部** 12 位用户');
  for (let i = 1; i <= 12; i += 1) {
    assert(new RegExp('member' + String(i).padStart(2, '0')).test(listHtml), `对话框应包含第 ${i} 位用户`);
  }
});

test('R35 · 前端：搜索框过滤（大小写不敏感）、计数同步、无匹配时给出空态且不残留旧行', async () => {
  const { dom } = await bootUserCard(manyUsers(12));
  await dom.get('btn-user-all').onclick();
  assertEqual(dom.get('user-all-count').textContent, '共 12 位用户', '未搜索时应显示总人数');

  const search = dom.get('user-all-search');
  search.value = 'MEMBER1'; // 命中 member10 / 11 / 12
  search.oninput();
  const html = dom.get('user-all-body').innerHTML;
  assertEqual(countRows(html), 3, `大写关键词应命中 3 位，实际 ${countRows(html)}`);
  assert(/member10/.test(html) && /member12/.test(html), '大小写不敏感：大写关键词也要能命中');
  assert(!/member02/.test(html), '不匹配的用户必须从列表里消失');
  assertEqual(dom.get('user-all-count').textContent, '匹配 3 / 共 12 位',
    `计数文案应同步（用户才知道"筛掉了多少"），实际：${dom.get('user-all-count').textContent}`);

  search.value = 'zzz';
  search.oninput();
  const empty = dom.get('user-all-body').innerHTML;
  assert(/没有匹配的用户/.test(empty), '搜索无匹配时应有专门的空态文案');
  assert(!/member/.test(empty),
    '空态下不得残留上一轮的行 —— 残留的行会让用户点到"刚刚搜索过的另一个人"');
  assertEqual(countRows(empty), 0, '空态下不应有任何数据行');

  search.value = '';
  search.oninput();
  assertEqual(countRows(dom.get('user-all-body').innerHTML), 12, '清空关键词应恢复到全部用户');
});

test('R35 · 前端：卡片里看不见的第 11+ 位用户，能在对话框里正常删除（不得出现"管不了的用户"）', async () => {
  const { dom } = await bootUserCard(manyUsers(12));
  assert(findBtn(dom.get('user-table'), 'del', 'u12') === undefined,
    '前置：第 12 位不在卡片里（否则这条用例白测）');

  await dom.get('btn-user-all').onclick();
  globalThis.__confirmResult = true;
  const btn = findBtn(dom.get('user-all-body'), 'del', 'u12');
  assert(btn, '对话框里第 12 位必须有「删除」按钮 —— 「列表里看不见的用户 = 管不了的用户」，'
    + '50 个用户时后 40 个将永远无法编辑/封禁/删除');
  await btn.onclick();

  assertEqual(globalThis.__deleted.join(','), 'u12', '必须真的删掉那一位（按钮接线 + id 传对）');
});

test('R35 · 前端：对话框里的删除会同时刷新卡片与对话框（所有变更共用一个收口点）', async () => {
  const { dom } = await bootUserCard(manyUsers(12));
  await dom.get('btn-user-all').onclick();
  assertEqual(callsOf('users').length, 1, '前置：打开对话框本身不该再拉一次列表（数据已在内存里）');

  await findBtn(dom.get('user-all-body'), 'del', 'u12').onclick();
  await tick();
  await tick();

  assertEqual(callsOf('users').length, 2, '删除后必须重新拉取列表（单一收口点 loadUsers）');
  assert(!/member12/.test(dom.get('user-all-body').innerHTML),
    '被删的用户必须立即从对话框里消失，否则用户以为没删掉、再点一次');
  assertEqual(dom.get('user-all-count').textContent, '共 11 位用户', '计数应同步更新');
  assertEqual(dom.get('user-more').hidden, false, '仍有 11 位 → 「显示全部」保持在位');
  assertEqual(countRows(dom.get('user-table').innerHTML), 10, '卡片仍然只渲染 10 行');
});

test('R35 · 前端：卡片刷新不会清掉对话框里的搜索关键词（状态在模块级，不在闭包里）', async () => {
  const { dom, mod } = await bootUserCard(manyUsers(12));
  await dom.get('btn-user-all').onclick();
  const search = dom.get('user-all-search');
  search.value = 'member03';
  search.oninput();
  assertEqual(countRows(dom.get('user-all-body').innerHTML), 1, '前置：关键词已生效');

  mod.refresh(); // 等价于任意一次后台刷新（loadUsers → renderUsers → repaintAllUsers）
  await tick();
  await tick();

  assertEqual(countRows(dom.get('user-all-body').innerHTML), 1,
    '刷新后仍应按关键词过滤：关键词若被清掉，用户会在毫无操作的情况下看到列表突然变回全部');
  assertEqual(dom.get('user-all-count').textContent, '匹配 1 / 共 12 位', '计数同样保持过滤态');
});

test('R35 · 前端：关闭对话框后可以再次打开（连点不叠层，状态必须复位）', async () => {
  const { dom } = await bootUserCard(manyUsers(12));
  await dom.get('btn-user-all').onclick();
  assertEqual((globalThis.__modals || []).length, 1, '前置：打开了一次');

  await dom.get('btn-user-all').onclick();
  assertEqual((globalThis.__modals || []).length, 1, '连点两次不得叠出第二层遮罩');

  (globalThis.__modals[0].close)();
  await dom.get('btn-user-all').onclick();
  assertEqual((globalThis.__modals || []).length, 2,
    '关闭之后必须能再次打开 —— allUsersOpen 没在 onClose 里复位的话，按钮就永久失效了');
});

test('R35 · 前端：登出 reset() 抹掉卡片、按钮与对话框里的用户数据', async () => {
  const { dom, mod } = await bootUserCard(manyUsers(12));
  await dom.get('btn-user-all').onclick();
  assert(dom.get('user-all-body').innerHTML, '前置：对话框里已有用户数据');

  mod.reset();

  assertEqual(dom.get('user-table').innerHTML, '', '卡片列表必须清空');
  assertEqual(dom.get('user-all-body').innerHTML, '', '对话框里的用户数据同样必须清空（换账号不得残留）');
  assertEqual(dom.get('user-more').hidden, true, '「显示全部」按钮要一并隐藏（列表都没了还留着它很奇怪）');
  assertEqual(dom.get('user-more-hint').textContent, '', '提示文案不得残留');
  assertEqual(dom.get('user-count').textContent, '', '计数同样清掉');
});

test('R35 · 前端：用户名在卡片与对话框里都经过 escapeHtml（新容器最容易漏转义）', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { dom } = await bootUserCard([row('u1', evil)].concat(manyUsers(11)));

  const cardHtml = dom.get('user-table').innerHTML;
  assert(!/<img/.test(cardHtml), '卡片里不得出现未转义的用户名');
  assert(/&lt;img/.test(cardHtml), '卡片里应出现转义后的用户名（说明确实走了 escapeHtml）');

  await dom.get('btn-user-all').onclick();
  const listHtml = dom.get('user-all-body').innerHTML;
  assert(!/<img/.test(listHtml), '对话框里同样不得出现未转义的用户名');
  assert(/&lt;img/.test(listHtml), '对话框里也应出现转义后的用户名');
});

test('R35 · 前端：非管理员点「显示全部」不开弹窗、不发请求（卡片本身已被整卡隐藏）', async () => {
  const { dom } = await bootUserCard(manyUsers(12));
  globalThis.__me = { id: 'me', username: 'bob', role: 'user' }; // 切成普通用户

  await dom.get('btn-user-all').onclick();

  assertEqual((globalThis.__modals || []).length, 0, '普通用户不得打开用户列表对话框');
  assertEqual(callsOf('users').length, 1, '点按钮不该触发任何用户列表请求（只有最初那次 refresh）');
});

/* ================================================================== *
 * ③ 样式 / 静态层
 * ================================================================== */

test('R35 · 单一渲染器：用户表格在 syssettings.js 里只有一份（卡片与对话框共用）', () => {
  const src = fs.readFileSync(JS('syssettings.js'), 'utf8');
  const heads = src.match(/<th>用户名<\/th>/g) || [];
  assertEqual(heads.length, 1,
    '用户表格的表头只允许有一份 —— 卡片与对话框必须共用 userTableHtml()，'
    + '两处各写一份必然逐渐分叉（出现「卡片里能封禁、对话框里却不能」）');
  assert(/function userTableHtml\(/.test(src), '应存在唯一渲染器 userTableHtml');
  assert(/function bindUserRowActions\(/.test(src), '行内按钮的绑定也必须唯一（卡片与对话框共用）');

  assertEqual((src.match(/userTableHtml\(/g) || []).length, 3,
    'userTableHtml 应恰为「1 处定义 + 2 处调用（卡片 / 对话框）」；出现第 4 处就该先确认不是又抄了一份表格');
  assertEqual((src.match(/bindUserRowActions\(/g) || []).length, 3,
    'bindUserRowActions 同样是 1 处定义 + 2 处调用');
  assert(/users\.slice\(0,\s*USER_PREVIEW_LIMIT\)/.test(src),
    '卡片截断必须引用 USER_PREVIEW_LIMIT 常量，而不是就地写死一个 10（写死就会与提示文案里的数字分家）');
});

test('R35 · 样式：滚动容器 / 吸顶表头 / 专属宽度，以及 flex 容器上的 hidden 必须显式声明', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  /** 取某个选择器的规则体（这些选择器在本文件里都唯一） */
  const bodyOf = (sel) => {
    const i = css.indexOf(sel);
    if (i < 0) return '';
    return css.slice(i, css.indexOf('}', i));
  };

  const list = bodyOf('.user-all-body');
  assert(/overflow:\s*auto/.test(list), '对话框列表必须有自己的滚动条（需求 4）');
  assert(/max-height/.test(list), '滚动容器必须有高度上限 —— 没有 max-height 就永远不会有滚动条');
  assert(/position:\s*sticky/.test(bodyOf('.user-all-body .lk-table thead th')),
    '长列表滚动时表头应吸顶，否则滚到中间就不知道每列是什么了');

  assert(/width:\s*min\(/.test(bodyOf('.dialog.user-all-dialog')),
    '「全部用户」对话框应有专属宽度（7 列表格比通用 720px 宽版更宽；用 min() 兼顾窄屏）');
  assert(/overflow:\s*auto/.test(bodyOf('.user-all-bar')) === false,
    '搜索栏本身不该滚动（滚动只发生在下面的列表里，否则筛完还得把列表往上滚回来）');

  // R36：`.user-more` 已泛化为四张卡片共用的 `.list-more`（组件与样式都下沉到
  // `listdialog.js` 的 `openListDialog()` + 通用 CSS 规则），断言随之改名 ——
  // 这条测的行为（flex 容器上的 hidden 必须显式声明）一个字没变。
  assert(/display:\s*none/.test(bodyOf('.list-more[hidden]')),
    '「显示全部」的容器是 display:flex —— 必须显式写 [hidden]{display:none}，'
    + '否则 hidden 属性对 flex 容器**完全无效**，10 位以内也会一直露着这个按钮');

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert(/id="btn-user-all"/.test(html), '「显示全部」按钮应在 index.html 里就位');
  assert(/id="user-more"[^>]*hidden/.test(html), '该按钮所在容器应默认 hidden（渲染出来之前不得闪现）');
});

test('R35 · 工具护栏：反向对照脚本必须拒绝位置参数（否则「只跑一轮」会静默变成「跑全量数小时」）', () => {
  // 本轮的实证教训：`node scripts/reverse-check.js R35-01` 里的位置参数被**静默忽略**，
  // 于是"只跑这一轮"变成跑满全量台账 —— 其中 36 条以 `deploy-script.test.js` 为对象
  // （单跑约 2.5 分钟/条）⇒ 数小时；只能在 10 分钟后强杀，而强杀会留下一个**正处于变异态**
  // 的源文件（这次是 deploy.sh，靠 `*.reversebak` 才看出来）。
  //
  // ⚠️ 断言必须是**行为**而不是源码字样：这条对照的 anchor 字面量就存在被检查的那个
  //    文件里，文本断言会被自己的副本满足 ⇒ 永远为真（实测就是这么拿到一次 fail=0 的假绿）。
  const { parseArgs } = require(path.join(ROOT, 'scripts', 'reverse-check.js'));

  const bad = parseArgs(['R35-01']);
  assert(bad.error, '位置参数必须被拒绝并给出错误，而不是被静默忽略后跑满全量台账');
  assert(/无法识别的参数/.test(bad.error), '应指明是哪个参数没被识别');
  assert(/--only=/.test(bad.error), '错误文案必须给出正确写法（--only=<片段>）');
  assert(parseArgs(['--only=R35-01', 'zzz']).error, '合法参数与位置参数混用同样必须拒绝');

  assertEqual(parseArgs(['--only=R35-01']).only, 'R35-01', '正确写法必须照常工作（别把正常用法一起拦下）');
  assertEqual(parseArgs(['--only=R35-01']).error, undefined, '合法参数不得报错');
  assertEqual(parseArgs([]).only, '', '不带参数 = 跑全量（沿用既有语义）');
  assertEqual(parseArgs([]).error, undefined, '不带参数同样不得报错');
});

/* ================================================================== *
 * R40 · 管理员不能在「用户管理」里编辑自己
 *
 * 需求原文只有一句「隐藏自己那一列的『编辑』按钮」。放在本文件里而不是新建 R40 的
 * 护栏文件，是因为这条需求是**这张卡片**的又一次演进，而驱动它所需的假 DOM +
 * `bootUserCard` 夹具只存在于这里；另起炉灶就意味着把那 150 行假 DOM 再抄一份 ——
 * 那正是本仓库反复记录的「同一份实现两处各写一遍」。
 *
 * 三件事各有用例，缺任何一件都会留下假绿：
 *   ① 自己那一行**没有**编辑按钮（需求本身）；
 *   ② 别人的行**仍然有**（「隐藏自己」与「整列消失」是两种完全不同的写法）；
 *   ③ 对话框里同样没有 —— 卡片与对话框共用 `userTableHtml`，这条同时是
 *      「规则只写在渲染器里、没有第二份副本」的证据。
 * ================================================================== */

/** 当前登录用户是 `__me.id = 'me'`（见 bootUserCard）。把他放进列表 = 自己那一行。 */
const selfPlus = (n) => [row('me', 'admin', { role: 'admin' })].concat(manyUsers(n));

test('R40 · 前端：「用户管理」里不能编辑自己（自己那一行没有「编辑」按钮）', async () => {
  const { dom } = await bootUserCard(selfPlus(11));
  const table = dom.get('user-table');

  assert(findBtn(table, 'edit', 'me') === undefined,
    '自己那一行不得出现「编辑」按钮 —— 需求：管理员不能在「用户管理」中编辑自己');
  assert(findBtn(table, 'edit', 'u01'),
    '别人的行必须照常保留「编辑」按钮：隐藏只针对自己那一行，不能变成整列消失');
  assertEqual(countRows(table.innerHTML), 10,
    '前置：卡片确实只渲染前 10 位（自己 + u01…u09）—— 否则上面两条断言测的可能不是同一批行');

  // 「编辑」是**不渲染**，「删除」是**渲染但禁用** —— 两种语义都要保住，
  // 顺手把自删除的既有约束一起钉住（别在改这条时把那条弄丢了）。
  const del = findBtn(table, 'del', 'me');
  assert(del, '自己那一行的「删除」仍应渲染出来');
  assert(del.attrs.disabled === '', '「删除」必须是「存在但禁用」（不能删掉当前登录账户），而不是直接消失');
  assert(/当前账户/.test(table.innerHTML), '自己那一行仍要显示「当前账户」标记 —— 否则用户看不出为什么这行少了按钮');
});

test('R40 · 前端：「显示全部」对话框里同样不能编辑自己', async () => {
  const { dom } = await bootUserCard(selfPlus(11));
  await dom.get('btn-user-all').onclick();
  const dialog = dom.get('user-all-body');

  assert(findBtn(dialog, 'edit', 'me') === undefined,
    '对话框里的自己那一行同样不得有「编辑」按钮 —— 卡片与对话框共用 userTableHtml，'
    + '两处行为不一致就说明有人另抄了一份渲染器');
  assert(findBtn(dialog, 'edit', 'u11'),
    '对话框里**别人**的行必须照常可编辑（「列表里看不见的用户 = 管不了的用户」这条不能被本轮改坏）');
});

test('R40 · 静态：编辑按钮只在一个地方渲染，且以 isSelf 作条件', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'syssettings.js'), 'utf8');

  // 取 userTableHtml 的函数体（配对花括号）。**必须把范围收进这个函数**：
  // 本文件里另有一处 `data-act="edit"`（WebDAV 账户列表第 392 行，与用户无关），
  // 全文件计数会把它一起数进来 —— 判据就没落在「用户表渲染器」上了。
  const start = src.indexOf('function userTableHtml(');
  assert(start !== -1, '前置：userTableHtml 必须存在（取不到 = 本条检查已失效）');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert(end > start, '前置：userTableHtml 的函数体应能配对到闭合花括号');
  const body = src.slice(start, end);

  // 计数断言，不是「存在」断言：`.test()` 在两处同串时会永远为真（R36 的 fail=0 教训）。
  assertEqual((body.match(/data-act="edit"/g) || []).length, 1,
    '用户表格里「编辑」按钮只允许渲染一次');
  assert(/const editBtn = isSelf \? ''/.test(body),
    '该按钮必须以 isSelf 为条件渲染：isSelf 为真时返回空串（**不渲染**），而不是 disabled');
  assert(/\$\{editBtn\}/.test(body),
    '条件渲染出来的 editBtn 必须真的插进行模板里 —— 定义了却不使用等于没改');
});

