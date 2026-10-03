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
 * @param {{checked:boolean, siteKey:string, secretKey:string}} p
 */
async function captchaSave(sandbox, dom, p) {
  dom.get('captcha-enabled').checked = !!p.checked;
  dom.get('captcha-sitekey').value = p.siteKey === undefined ? '' : p.siteKey;
  dom.get('captcha-secretkey').value = p.secretKey === undefined ? '' : p.secretKey;
  dom.get('captcha-timeout').value = '5000';
  await dom.get('btn-captcha-save').onclick();
  const c = callsOf('saveCaptchaConfig');
  return c[c.length - 1].args[0];
}

test('R31-02 · 登录验证：本次填全凭证且当前停用时，保存后自动启用', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = {
    // 保存前：停用、没有站点密钥、也没有服务端密钥
    saveCaptchaConfig: async (cfg) => Object.assign({}, cfg, {
      siteKey: cfg.siteKey,
      hasSecret: !!cfg.secretKey,
      effective: { available: !!cfg.enabled, provider: cfg.provider },
    }),
  };
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
  assertEqual(sent.siteKey, '6Lc-site-key-000', '站点密钥应原样提交');
  assertEqual(sent.secretKey, '6Lc-secret-key-111', '服务端密钥应原样提交');
});

test('R31-02 · 登录验证：已启用时手动取消勾选并保存，必须能真正停用', async () => {
  const dir = makeSandbox({ withSyssettings: true });
  const dom = installFakeDom({ systemSettingsNull: true });
  globalThis.__calls = [];
  globalThis.__toasts = [];
  globalThis.__api = {
    saveCaptchaConfig: async (cfg) => Object.assign({}, cfg, {
      siteKey: cfg.siteKey,
      hasSecret: !!cfg.secretKey,
      effective: { available: !!cfg.enabled, provider: cfg.provider },
    }),
  };
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
  globalThis.__api = {
    saveCaptchaConfig: async (cfg) => Object.assign({}, cfg, {
      siteKey: cfg.siteKey,
      hasSecret: !!cfg.secretKey,
      effective: { available: !!cfg.enabled, provider: cfg.provider },
    }),
  };
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
  globalThis.__api = {
    saveCaptchaConfig: async (cfg) => Object.assign({}, cfg, {
      siteKey: cfg.siteKey, hasSecret: !!cfg.secretKey, effective: { available: false },
    }),
  };
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
  // 服务端密钥此前已由环境变量 / 历史配置提供（`hasSecret` 恒为真）
  globalThis.__api = {
    saveCaptchaConfig: async (cfg) => Object.assign({}, cfg, {
      siteKey: cfg.siteKey, hasSecret: true, effective: { available: !!cfg.enabled },
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
