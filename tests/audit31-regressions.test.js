/**
 * 第三十一轮护栏（R31-02 / R31-03）—— 用户报障的两件事：
 *
 *  - R31-02「登录验证」卡片：功能本来是**停用**，管理员把站点密钥 / 服务端密钥填好、
 *    点「保存设置」—— 旧行为只是把 `enabled:false` 原样再存一遍，功能依旧停用，
 *    而管理员以为「保存即生效」，登录页其实仍无任何验证。
 *  - R31-03「支付设置」卡片：同理 —— 填完某平台凭证并保存后，支付**总开关**仍是停用，
 *    所有付费链接照旧是免费下载，得再回来手动拨一次开关。
 *
 * 要求（用户明确选定）：保存成功后，若「本次**新填了**信息」且「填写的信息**符合规则**
 * （凭证完整）」且当前功能处于**停用**状态，则自动把状态置为启用。
 * 并明确两条边界：
 *  - 支付卡片只自动开**总开关**，不动渠道开关（那是管理员对该平台的独立选择）；
 *  - 触发器必须绑定「本次新填」—— 否则管理员把开关拨到停用再点保存会被强行打开，
 *    等于**再也停不下来**。
 *
 * 手法（与 audit29-regressions.test.js 同源）：把模块图换成桩，在 Node 里 import
 * **真实的** paysettings.js / syssettings.js，用假 DOM 驱动真实的保存链路，
 * 断言「实际提交给服务端的 payload」—— 而不是断言源码里有没有某个字样。
 * 只有落在真实调用链上，反向变异（摘掉闸门）才可能真的变红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const JS = (...p) => path.join(ROOT, 'public', 'js', ...p);

/* ================================================================== *
 * 假 DOM：按 id 现造元素，并记录 addEventListener / onclick 绑定的处理器
 * ================================================================== */

/**
 * @param {{systemSettingsNull?: boolean}} opts
 *   `systemSettingsNull` 用于 syssettings.js：`refresh()` 的流程是
 *   `wire(); if (!getElementById('systemsettings')) return;` —— 让这个 id 返回 null
 *   就能「只跑事件绑定、不跑后面那一串数据加载」，从而在沙箱里安全地拿到
 *   `btn-captcha-save.onclick`。
 */
function installFakeDom(opts = {}) {
  const els = new Map();
  const makeEl = (id) => {
    const handlers = {};
    const el = {
      id,
      hidden: false,
      innerHTML: '',
      textContent: '',
      value: '',
      checked: false,
      style: {},
      dataset: {},
      className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (t, fn) => { (handlers[t] = handlers[t] || []).push(fn); },
      removeEventListener: () => {},
      appendChild() {},
      remove() {},
      __handlers: handlers,
      /** 触发某个已绑定的监听器（模拟用户点击 / 勾选） */
      __fire(t) {
        const list = handlers[t] || [];
        return Promise.all(list.map((fn) => fn({ target: el, preventDefault() {} })));
      },
    };
    return el;
  };
  const get = (id) => {
    if (opts.systemSettingsNull && id === 'systemsettings') return null;
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  globalThis.window = globalThis;
  globalThis.document = {
    getElementById: get,
    createElement: () => makeEl('created'),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    activeElement: null,
    body: { appendChild() {} },
  };
  return { els, get };
}

/* ================================================================== *
 * 沙箱：桩模块 + 真实模块副本
 * ================================================================== */

/**
 * 桩 `api.js`：把所有方法调用记进 `globalThis.__calls`，具体行为由 `globalThis.__api`
 * 决定（未定义的按 `{}` 解析）。用 Proxy 是为了让「本用例不关心的接口」自动兜底 ——
 * 否则每加一个被 import 的接口就要来改一次测试，迟早有人为了让它通过而写空断言。
 */
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

const UTIL_STUB = `
export const toast = (m) => { (globalThis.__toasts = globalThis.__toasts || []).push(m); };
export const escapeHtml = (s) => String(s == null ? '' : s);
export const confirmDialog = async () => true;
export const openModal = () => {};
export const fmtTime = (s) => String(s || '');
export const fmtSize = (n) => String(n);
// R34：syssettings.js 新增了 updateNotice 具名导入 —— 沙箱里的 util 桩必须一并提供，
// 否则 ESM 在**链接期**就报 does not provide an export named 'updateNotice'，
// 本文件所有 import syssettings.js 的用例会整片变红（红的原因与它们要守的东西无关）。
export const updateNotice = (r) => (r && r.hasUpdate ? '有新版本' : '当前已是最新版本。');
// R35：syssettings.js 又新增了 USER_PREVIEW_LIMIT / filterUsersByName 两个具名导入，同理补上
// （这一条若漏了，audit34-update 的家族护栏会先变红，而不是让本文件整片红得莫名其妙）
export const USER_PREVIEW_LIMIT = 10;
export const filterUsersByName = (list, q) => {
  const all = Array.isArray(list) ? list.slice() : [];
  const s = String(q == null ? '' : q).trim().toLowerCase();
  return s ? all.filter((u) => String((u && u.username) || '').toLowerCase().indexOf(s) !== -1) : all;
};
// R36：syssettings.js 又新增了 previewMoreState 具名导入（「显示全部」判据下沉到 util.js），同理补上
export const previewMoreState = (total, limit, unit) => {
  const over = total > limit;
  return { over, hint: over ? ('卡片仅显示前 ' + limit + ' ' + unit + '，共 ' + total + ' ' + unit) : '' };
};
`;

const MAIN_STUB = `
export const App = {
  state: { user: { role: 'admin', username: 'admin' }, config: {}, prefix: '' },
  onConfigChanged() {}, reloadConfig() {}, refreshStorage() {}, refresh() {},
};
`;

const PAYLOGOS_STUB = `export const paymentLogo = () => '';`;
const WEBAUTHN_STUB = `
export const registerWindowsHello = async () => ({});
export const webauthnReadiness = () => ({ available: false });
`;
const PAYSETTINGS_STUB = `
export const loadPayment = async () => {};
export const resetPaymentView = () => {};
`;

/** 建一个临时模块图目录，返回其路径 */
function makeSandbox({ withSyssettings = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r31-fe-'));
  const w = (n, s) => fs.writeFileSync(path.join(dir, n), s);
  w('api.js', API_STUB);
  w('util.js', UTIL_STUB);
  w('main.js', MAIN_STUB);
  if (withSyssettings) {
    w('payment-logos.js', PAYLOGOS_STUB);
    w('webauthn.js', WEBAUTHN_STUB);
    w('paysettings.js', PAYSETTINGS_STUB);
    fs.copyFileSync(JS('syssettings.js'), path.join(dir, 'syssettings.js'));
    // R36：syssettings.js 现在 import './listdialog.js'（列表对话框骨架）—— 沙箱缺了它
    // 会在 ESM **链接期**直接失败，本文件所有 import syssettings 的用例整片变红。
    fs.copyFileSync(JS('listdialog.js'), path.join(dir, 'listdialog.js'));
    // R37：syssettings.js 又 import 了 './speedlimit.js'（「限速」列 + 限速对话框）——
    // 同一条链接期规则；必须拷**真实**的那一份（它只从 util.js 取三个原语）。
    fs.copyFileSync(JS('speedlimit.js'), path.join(dir, 'speedlimit.js'));
    // R38：syssettings.js 又 import 了 './backupcfg.js'（「备份配置」卡片）—— 同一条链接期
    // 规则。同样必须拷**真实**的那一份（它只从 api.js 取 API、从 util.js 取 toast / openModal）。
    fs.copyFileSync(JS('backupcfg.js'), path.join(dir, 'backupcfg.js'));
  } else {
    w('payment-logos.js', PAYLOGOS_STUB);
    fs.copyFileSync(JS('paysettings.js'), path.join(dir, 'paysettings.js'));
  }
  return dir;
}

const importFresh = (dir, file) => import('file://' + path.join(dir, file).replace(/\\/g, '/')
  + '?v=' + Math.random());

const callsOf = (fn) => (globalThis.__calls || []).filter((c) => c.fn === fn);

/* ================================================================== *
 * R31-02 · 「登录验证」保存成功后自动启用
 * ================================================================== */

/** 平台清单（结构对齐 server/payment-providers.js 下发的可序列化副本） */
const PAY_SCHEMA = [{
  id: 'alipay',
  name: '支付宝',
  doc: 'https://open.alipay.com',
  fields: [
    { key: 'app_id', label: 'App ID', required: true },
    { key: 'private_key', label: '应用私钥', required: true, secret: true },
  ],
}];

/**
 * 驱动一次「支付设置」保存。
 * @param {{beforeEnabled:boolean, beforeComplete:boolean, beforeValues:object,
 *          typeAppId?:string, typeKey?:string, saveEnabled?:boolean,
 *          setEnabledRejects?:string}} p
 */
async function drivePaymentSave(p) {
  const dir = makeSandbox();
  const dom = installFakeDom();
  globalThis.__calls = [];
  globalThis.__toasts = [];
  let channelOn = false;
  globalThis.__api = {
    paymentConfig: async () => ({
      enabled: !!p.beforeEnabled,
      platforms: PAY_SCHEMA,
      settings: {
        alipay: {
          values: p.beforeValues || {},
          configured: { app_id: !!p.beforeComplete, private_key: !!p.beforeComplete },
          complete: !!p.beforeComplete,
          enabled: false,
          available: false,
        },
      },
      availableChannels: [],
      siteUrl: '',
      updatedAt: '',
    }),
    savePayment: async (id, values) => {
      const complete = !!values.app_id && (!!values.private_key || !!p.beforeComplete);
      return {
        ok: true,
        platformId: id,
        values: Object.assign({}, p.beforeValues, values),
        configured: { app_id: !!values.app_id, private_key: complete },
        complete,
        enabled: false,
        available: false,
        updatedAt: '2026-10-03T00:00:00.000Z',
      };
    },
    setPaymentEnabled: async (on) => {
      if (p.setEnabledRejects) throw new Error(p.setEnabledRejects);
      channelOn = !!on;
      return { ok: true, enabled: channelOn, availableChannels: ['alipay'] };
    },
  };

  const mod = await importFresh(dir, 'paysettings.js');
  await mod.loadPayment();
  // 填表（模拟管理员输入）
  if (p.typeAppId !== undefined) dom.get('pay-f-app_id').value = p.typeAppId;
  if (p.typeKey !== undefined) dom.get('pay-f-private_key').value = p.typeKey;
  // 触发真实的「保存设置」点击（wire() 里 addEventListener('click', doSave)）
  await dom.get('btn-payment-save').__fire('click');
  return { dom, dir, saved: callsOf('savePayment'), toggled: callsOf('setPaymentEnabled') };
}

test('R31-03 · 支付：本次新填完凭证且总开关停用时，保存后自动打开总开关', async () => {
  const r = await drivePaymentSave({
    beforeEnabled: false, // 总开关当前停用
    beforeComplete: false, // 之前没配过
    typeAppId: '2021000000000000',
    typeKey: 'MIIEvQIBADANBgkq',
  });
  assertEqual(r.saved.length, 1, '应发出一次保存请求');
  assert(r.saved[0].args[1].app_id === '2021000000000000', '应把用户填写的凭证提交给服务端');
  assertEqual(r.toggled.length, 1,
    'R31-03：本次填入了完整凭证且总开关处于停用 —— 保存成功后必须自动打开总开关；'
    + '否则管理员以为「保存即生效」，而所有付费链接照旧是免费下载');
  assertEqual(r.toggled[0].args[0], true, 'R31-03：自动启用的入参必须是 true');
});

test('R31-03 · 支付：渠道开关不得被「自动启用」顺手改掉（只动总开关）', async () => {
  const r = await drivePaymentSave({
    beforeEnabled: false, beforeComplete: false,
    typeAppId: '2021000000000000', typeKey: 'MIIEvQIBADANBgkq',
  });
  assertEqual(callsOf('setPaymentChannelEnabled').length, 0,
    'R31-03：自动启用只应作用于总开关 —— 渠道开关是管理员对该平台的独立选择，'
    + '被自动改写会让「我只想配好备用、暂不开通这个渠道」变得无法表达');
});

test('R31-03 · 支付：没填新信息时保存不得自动启用（否则手动停用后再也停不下来）', async () => {
  const r = await drivePaymentSave({
    beforeEnabled: false,
    beforeComplete: true,
    beforeValues: { app_id: '2021000000000000' }, // 表单会被预填成同一个值
    typeAppId: '2021000000000000',                 // 用户没改任何东西
  });
  assertEqual(r.saved.length, 1, '应发出一次保存请求');
  assertEqual(r.toggled.length, 0,
    'R31-03：本次没有新填任何信息 ⇒ 不得自动启用。'
    + '管理员把总开关拨到停用、再点一次保存（例如只想改别的字段）时若被强行打开，'
    + '就等于这个开关再也关不掉');
});

test('R31-03 · 支付：凭证仍不完整时保存不得自动启用', async () => {
  const r = await drivePaymentSave({
    beforeEnabled: false, beforeComplete: false,
    typeAppId: '2021000000000000', // 只填了 App ID，私钥留空
  });
  assertEqual(r.toggled.length, 0,
    'R31-03：凭证不完整（填写的信息尚未符合规则）不得自动启用 —— '
    + '否则会得到一个「开了但没人能付」的无效状态');
});

test('R31-03 · 支付：总开关本来就开着时不得重复切换（不产生无谓的「已自动启用」）', async () => {
  const r = await drivePaymentSave({
    beforeEnabled: true, // 总开关已在启用态
    beforeComplete: false,
    typeAppId: '2021000000000000', typeKey: 'MIIEvQIBADANBgkq',
  });
  assertEqual(r.saved.length, 1, '仍应正常保存凭证');
  assertEqual(r.toggled.length, 0,
    'R31-03：总开关已启用时不该再发一次切换请求 —— 那会多做一次无谓的写盘，'
    + '并在界面上谎报「已自动启用」（其实只是原地踏步）');
});

test('R31-03 · 支付：总开关已被服务端规则拒绝时必须如实报错，不得谎报「已启用」', async () => {
  const r = await drivePaymentSave({
    beforeEnabled: false, beforeComplete: false,
    typeAppId: '2021000000000000', typeKey: 'MIIEvQIBADANBgkq',
    // 服务端 paymentRules.checkGlobalToggle：一个渠道都没开时拒绝开总开关
    setEnabledRejects: '请先启用至少一个支付渠道，再开启支付功能',
  });
  assertEqual(r.toggled.length, 1, '应当尝试过一次自动启用');
  const msg = r.dom.get('payment-msg').textContent;
  assert(/凭证已保存|已保存支付宝凭证/.test(msg), `R31-03：保存本身是成功的，提示里必须保留这一事实，实际：${msg}`);
  assert(/请先启用至少一个支付渠道/.test(msg),
    `R31-03：自动启用被拒时必须如实展示服务端原因（不得静默失败、也不得谎称已启用），实际：${msg}`);
  assert(/未成功/.test(msg), 'R31-03：提示必须明确「自动启用未成功」');
  const texts = (globalThis.__toasts || []).join(' | ');
  assert(/未成功/.test(texts), `R31-03：toast 也要把失败讲清楚，实际：${texts}`);
});

/* ================================================================== *
 * R31-02 · 「登录验证」保存成功后自动启用
 * ================================================================== */

/**
 * 驱动一次「保存设置」。可连续多次调用（复用同一沙箱模块实例）——
 * 第 2 次会看到第 1 次保存后写回的 `captchaCfg`，正是「已启用 → 管理员再次改动」的场景。
 *
 * R41 起两种服务商**各自独立**保存：`provider` 决定往哪一组输入框里填（默认 reCAPTCHA），
 * 另一家的输入框恒置空，模拟「另一套还没配 / 本次没动它」。
 * @param {{checked:boolean, provider?:string, siteKey:string, secretKey:string}} p
 */
async function captchaSave(sandbox, dom, p) {
  const provider = p.provider || 'recaptcha';
  const other = provider === 'recaptcha' ? 'turnstile' : 'recaptcha';
  dom.get('captcha-enabled').checked = !!p.checked;
  dom.get('captcha-sitekey-' + provider).value = p.siteKey === undefined ? '' : p.siteKey;
  dom.get('captcha-secretkey-' + provider).value = p.secretKey === undefined ? '' : p.secretKey;
  dom.get('captcha-sitekey-' + other).value = '';
  dom.get('captcha-secretkey-' + other).value = '';
  dom.get('captcha-timeout').value = '5000';
  await dom.get('btn-captcha-save').onclick();
  const c = callsOf('saveCaptchaConfig');
  return c[c.length - 1].args[0];
}

/**
 * 桩 `saveCaptchaConfig`：按 R41 的响应形状回写 —— 两套凭证各自 `{ siteKey, hasSecret }`。
 *
 * 它还**如实模拟服务端那条「空串 = 保持原密钥」的契约**（用闭包状态记住已设过的密钥）：
 * 若桩每次都按 `!!cfg.secretKey` 现算 `hasSecret`，第二次保存（密码框本来就留空）
 * 就会得到 `hasSecret:false`，界面随即把「（已设置）」误显示成「（未设置）」——
 * 那是**桩的错**，不是产品的错，会让护栏指向错误的方向。
 * @param {(provs:object)=>object} [over] 需要额外覆盖时（例如强制某家 `hasSecret` 为真）
 */
function capSaveStub(over) {
  const store = {
    recaptcha: { siteKey: '', secretKey: '' },
    turnstile: { siteKey: '', secretKey: '' },
  };
  return async (cfg) => {
    const provs = {};
    for (const p of ['recaptcha', 'turnstile']) {
      const e = (cfg.providers && cfg.providers[p]) || {};
      if (e.siteKey !== undefined) store[p].siteKey = e.siteKey;
      if (e.secretKey) store[p].secretKey = e.secretKey; // 空串 = 保持原密钥不变
      provs[p] = { siteKey: store[p].siteKey, hasSecret: !!store[p].secretKey };
    }
    return Object.assign({
      enabled: cfg.enabled,
      provider: cfg.provider,
      providers: provs,
      effective: { available: !!cfg.enabled, provider: cfg.provider },
    }, over ? over(provs) : null);
  };
}

test('R31-02 · 登录验证：本次填全凭证且当前停用时，保存后自动启用', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  // 保存前：停用、没有站点密钥、也没有服务端密钥
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh(); // wire() 会绑定 btn-captcha-save.onclick = saveCaptchaSettings

  const sent = await captchaSave(dir && dom, dom, {
    checked: false, // 开关当前是「停用」
    siteKey: '6Lc-site-key-000',
    secretKey: '6Lc-secret-key-111',
  });
  assertEqual(sent.enabled, true,
    'R31-02：本次新填了站点密钥与服务端密钥、且开关处于停用 —— 保存时必须一并以 enabled:true 提交；'
    + '否则管理员以为「保存即生效」，而登录页其实仍无任何验证');
  assertEqual(sent.providers.recaptcha.siteKey, '6Lc-site-key-000', '站点密钥应原样提交到选中服务商那一套');
  assertEqual(sent.providers.recaptcha.secretKey, '6Lc-secret-key-111', '服务端密钥应原样提交到选中服务商那一套');
});

test('R31-02 · 登录验证：已启用时手动取消勾选并保存，必须能真正停用', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  // 第一次：填全并自动启用（模块内 captchaCfg 随之变为 enabled:true）
  await captchaSave(dir, dom, { checked: false, siteKey: 'k-1', secretKey: 's-1' });
  // 第二次：管理员取消勾选、什么都不改，直接保存
  const second = await captchaSave(dir, dom, { checked: false, siteKey: 'k-1', secretKey: '' });
  assertEqual(second.enabled, false,
    'R31-02：功能已处于启用态时，管理员取消勾选并保存必须真的停用 —— '
    + '自动启用只在「保存前是停用」时才触发；否则这个开关将再也关不掉');
});

test('R31-02 · 登录验证：功能已启用时改密钥不得被自动启用逻辑改写勾选状态', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  await captchaSave(dir, dom, { checked: false, siteKey: 'k-1', secretKey: 's-1' });
  // 管理员取消勾选，同时换成一把新的站点密钥
  const second = await captchaSave(dir, dom, { checked: false, siteKey: 'k-2-new', secretKey: '' });
  assertEqual(second.enabled, false,
    'R31-02：保存前已是启用态 ⇒ 一律不自动启用（用户的意图必须优先），'
    + '哪怕这次确实新填了信息');
});

test('R31-02 · 登录验证：只填了站点密钥（凭证不完整）不得自动启用', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  const sent = await captchaSave(dir, dom, { checked: false, siteKey: 'k-only', secretKey: '' });
  assertEqual(sent.enabled, false,
    'R31-02：只有站点密钥、没有服务端密钥 ⇒ 填写的信息尚未符合规则，不得自动启用');
});

test('R31-02 · 登录验证：服务端密钥早已配好、本次没填新信息时，再点保存不得自动启用', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  // 服务端密钥此前已由环境变量 / 历史配置提供（该服务商的 `hasSecret` 恒为真）
  globalThis.__api = {
    saveCaptchaConfig: capSaveStub((provs) => {
      provs.recaptcha.hasSecret = true;
      return { providers: provs };
    }),
  };
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  // 第一次：只填站点密钥（服务端密钥留空表示保持不变）——凭证并不完整，不得自动启用
  const first = await captchaSave(dir, dom, { checked: false, siteKey: 'k-1', secretKey: '' });
  assertEqual(first.enabled, false,
    'R31-02：服务端密钥本身已配好，但开关是关的、且本次只填了站点密钥 ⇒ 不自动启用');

  // 第二次：什么都没改，再点一次保存 —— 不得因为「配置看起来完整」就自动打开
  const second = await captchaSave(dir, dom, { checked: false, siteKey: 'k-1', secretKey: '' });
  assertEqual(second.enabled, false,
    'R31-02：本次没有新填任何信息 ⇒ 不得自动启用。'
    + '否则管理员把开关拨到停用、再点一次保存（例如只想改超时时间）时会被强行打开，'
    + '这个开关就再也关不掉了');
});

/* ================================================================== *
 * R41 · 两种服务商的凭证各自独立（同时保存、任选其一）
 * ================================================================== */

/**
 * 让假 DOM 的 `document.querySelector('#id .chip.active')` 按 id 返回指定 chip 值。
 *
 * `installFakeDom` 默认的 `querySelector` 恒返回 null ⇒ `chipValue()` 恒为 `''`
 * ⇒ provider 永远回落 recaptcha —— 那样「切换到另一家」这类行为根本测不到
 * （测试会以为在测 Turnstile，实际测的还是 reCAPTCHA）。这里只对显式声明的 chip 生效。
 * @param {Record<string,string>} map 形如 `{ 'captcha-provider': 'turnstile' }`
 */
function setChips(map) {
  globalThis.document.querySelector = (sel) => {
    const m = /^#([^\s]+) \.chip\.active$/.exec(String(sel || ''));
    const v = m ? (map || {})[m[1]] : null;
    return v ? { dataset: { v: String(v) } } : null;
  };
}

test('R41 · 登录验证：两套凭证必须同时提交，回填时不得串台', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  setChips({ 'captcha-provider': 'turnstile', 'captcha-onerror': 'block' });
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  // 两套都填上（模拟管理员「两套都配好」），当前选中 Turnstile
  dom.get('captcha-sitekey-recaptcha').value = 'rec-key';
  dom.get('captcha-secretkey-recaptcha').value = 'rec-secret';
  dom.get('captcha-sitekey-turnstile').value = 'ts-key';
  dom.get('captcha-secretkey-turnstile').value = 'ts-secret';
  dom.get('captcha-timeout').value = '5000';
  dom.get('captcha-enabled').checked = true;
  await dom.get('btn-captcha-save').onclick();
  const two = callsOf('saveCaptchaConfig').pop().args[0];

  assertEqual(two.provider, 'turnstile', 'R41：提交的 provider 必须是界面上选中的那一家');
  assertEqual(two.providers.recaptcha.siteKey, 'rec-key',
    'R41：提交里必须**同时**带上另一家的站点密钥 —— 只提交选中那一家，切换服务商就会把另一套悄悄清空');
  assertEqual(two.providers.recaptcha.secretKey, 'rec-secret', 'R41：另一家的服务端密钥也要一并提交');
  assertEqual(two.providers.turnstile.siteKey, 'ts-key', 'R41：选中的那一家的站点密钥要提交');
  assertEqual(two.providers.turnstile.secretKey, 'ts-secret', 'R41：选中的那一家的服务端密钥要提交');

  // 保存后按服务端回帧重新回填：两套各回各的输入框
  assertEqual(dom.get('captcha-sitekey-recaptcha').value, 'rec-key',
    'R41：两套凭证须各回各的输入框；串台会让管理员在 A 家看到 B 家的密钥');
  assertEqual(dom.get('captcha-sitekey-turnstile').value, 'ts-key', 'R41：Turnstile 那套同理');
  assertEqual(dom.get('captcha-secretkey-recaptcha').value, '', 'R41：明文密钥绝不下发，因此输入框必须清空');
  assertEqual(dom.get('captcha-secretkey-turnstile').value, '', 'R41：Turnstile 那套同理');
});

test('R41 · 登录验证：留空表示「保持原密钥」，不得被当成清空', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  setChips({ 'captcha-provider': 'recaptcha', 'captcha-onerror': 'block' });
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  // 第一次：两家的服务端密钥都填上
  dom.get('captcha-sitekey-recaptcha').value = 'rec-key';
  dom.get('captcha-secretkey-recaptcha').value = 'rec-secret';
  dom.get('captcha-sitekey-turnstile').value = 'ts-key';
  dom.get('captcha-secretkey-turnstile').value = 'ts-secret';
  dom.get('captcha-timeout').value = '5000';
  dom.get('captcha-enabled').checked = true;
  await dom.get('btn-captcha-save').onclick();

  // 第二次：两个密码框都留空（界面本来就不会回填明文），只改超时
  dom.get('captcha-timeout').value = '8000';
  await dom.get('btn-captcha-save').onclick();
  const second = callsOf('saveCaptchaConfig').pop().args[0];

  assertEqual(second.providers.recaptcha.secretKey, '',
    'R41：留空必须原样提交空串（服务端据此「保持原密钥」）—— '
    + '若前端自作主张提交别的值，等于每次保存都把密钥换掉');
  assertEqual(second.providers.turnstile.secretKey, '', 'R41：Turnstile 那套同理');
  // 服务端必须如实回「两家都仍有密钥」，否则界面上「（已设置）」会误报成「（未设置）」
  assertEqual(dom.get('captcha-secret-state-recaptcha').textContent.indexOf('已设置') !== -1, true,
    'R41：两家都已配置过密钥 ⇒ 回填后状态应显示「已设置」');
  assertEqual(dom.get('captcha-secret-state-turnstile').textContent.indexOf('已设置') !== -1, true,
    'R41：Turnstile 那套同理');
});

test('R41 · 登录验证：切到「另一家」时，启用校验只看被选中那一家的凭证', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = { saveCaptchaConfig: capSaveStub() };
  setChips({ 'captcha-provider': 'turnstile', 'captcha-onerror': 'block' });
  const mod = await importFresh(dir, 'syssettings.js');
  mod.refresh();

  // 只给 reCAPTCHA 配好两把钥匙；当前选中的 Turnstile 一套是空的
  dom.get('captcha-sitekey-recaptcha').value = 'rec-key';
  dom.get('captcha-secretkey-recaptcha').value = 'rec-secret';
  dom.get('captcha-sitekey-turnstile').value = '';
  dom.get('captcha-secretkey-turnstile').value = '';
  dom.get('captcha-timeout').value = '5000';
  dom.get('captcha-enabled').checked = true; // 想启用
  const before = callsOf('saveCaptchaConfig').length;
  await dom.get('btn-captcha-save').onclick();

  assertEqual(callsOf('saveCaptchaConfig').length, before,
    'R41：选中服务商的凭证不完整时必须**就地拦下**、不发请求 —— '
    + '否则会把「另一家配好了」误判成本次可启用，登录页随即报「未正确配置」而锁死登录');
  const m = dom.get('captcha-msg').textContent;
  assert(/站点密钥/.test(m), `R41：提示必须点名缺的是哪一家的站点密钥，实际：${m}`);
  assert(/Cloudflare Turnstile/.test(m),
    `R41：提示必须点名是哪一家（否则两套并存时管理员无从判断该去补哪一套），实际：${m}`);
});


