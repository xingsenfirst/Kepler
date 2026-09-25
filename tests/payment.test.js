/**
 * 支付平台凭证配置 —— 行为契约测试
 *
 * 本文件只覆盖「凭证字段定义与合法性校验」这一层（server/payment-providers.js 与
 * server/routes/payment.js），不涉及任何支付业务。
 *
 * 断言原则（沿用本项目的测试铁律）：
 *  - 一律写**行为断言**（喂输入、看输出），不做源码 grep —— 否则会退化成
 *    "注释里恰好有同名词就全绿"的假护栏。
 *  - 每条校验规则都配一组「合法样例 / 非法样例」，确保规则真的在生效而非摆设。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const test = require('node:test');
const { after } = require('node:test');
const { assert, assertEqual, ROOT } = require('./helpers');

const pp = require(path.join(ROOT, 'server', 'payment-providers.js'));
const pp2 = require(path.join(ROOT, 'server', 'payment-rules.js'));

/* ------------------------------------------------------------------ *
 * 合法样例：三家平台各一份"照官方文档填对"的凭证
 * ------------------------------------------------------------------ */
const PEM_PRIVATE = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDk3VvP3nQ7mXq',
  '-----END PRIVATE KEY-----',
].join('\n');
const PEM_PUBLIC = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4t1b0oZ0nQ7mXqAAAAA',
  '-----END PUBLIC KEY-----',
].join('\n');

const VALID = {
  alipay: {
    appId: '2021004100000000',
    privateKey: PEM_PRIVATE,
    alipayPublicKey: PEM_PUBLIC,
    signType: 'RSA2',
  },
  wechat: {
    mchId: '1900000109',
    appId: 'wx1234567890abcdef',
    apiV3Key: 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6',
    certSerialNo: '1A2B3C4D5E6F7A8B9C0D1E2F3A4B5C6D7E8F9A0B',
    privateKey: PEM_PRIVATE,
  },
  paypal: {
    clientId: 'AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789',
    clientSecret: 'EeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz0123456789012345',
    mode: 'sandbox',
  },
};

/* ================================================================== *
 * 1 · 注册表基本契约
 * ================================================================== */

test('注册表覆盖支付宝 / 微信支付 / PayPal 三家，且顺序稳定', () => {
  assertEqual(pp.list().length, 3, '应有三个支付平台');
  assertEqual(pp.ORDER.join(','), 'alipay,wechat,paypal', '展示顺序应稳定');
  for (const id of pp.ORDER) {
    assert(pp.isKnown(id), `${id} 应被识别`);
    assert(pp.platform(id).fields.length > 0, `${id} 应有字段定义`);
  }
  assert(!pp.isKnown('stripe'), '未接入的平台不应被识别');
  assert(pp.platform('stripe') === null, '未知平台返回 null');
});

test('字段按各平台官方命名，未被强行统一成同一个键名', () => {
  // 三家平台的必填字段集合必须互不相同 —— 若被强行统一，这里就会撞车
  const keysets = {};
  for (const id of pp.ORDER) {
    keysets[id] = pp.platform(id).fields.filter((f) => f.required).map((f) => f.key).sort().join(',');
  }
  assertEqual(new Set(Object.values(keysets)).size, 3, `三家必填字段集合不应相同：${JSON.stringify(keysets)}`);

  // 各自官方字段名确实来自官方文档
  assertEqual(pp.field('alipay', 'appId').official, 'app_id', '支付宝应用 ID 官方字段名');
  assertEqual(pp.field('wechat', 'mchId').official, 'mchid', '微信支付商户号官方字段名');
  assertEqual(pp.field('wechat', 'apiV3Key').official, 'api_v3_key', '微信支付 APIv3 密钥官方字段名');
  assertEqual(pp.field('wechat', 'certSerialNo').official, 'serial_no', '微信支付证书序列号官方字段名');
  assertEqual(pp.field('paypal', 'clientId').official, 'client_id', 'PayPal Client ID 官方字段名');
  assertEqual(pp.field('paypal', 'clientSecret').official, 'client_secret', 'PayPal Secret 官方字段名');

  // 每个字段都必须带官方字段名（否则界面无从对照控制台）
  for (const id of pp.ORDER) {
    for (const f of pp.platform(id).fields) {
      assert(f.official, `${id}.${f.key} 缺少官方字段名`);
      assert(f.label, `${id}.${f.key} 缺少中文标签`);
    }
  }
});

test('敏感字段已标 secret（密钥 / 证书 / Secret），非敏感字段未标记', () => {
  const secret = (id, key) => !!pp.field(id, key).secret;
  assert(secret('alipay', 'privateKey'), '支付宝应用私钥属敏感');
  assert(secret('alipay', 'alipayPublicKey'), '支付宝公钥属敏感');
  assert(secret('wechat', 'apiV3Key'), 'APIv3 密钥属敏感');
  assert(secret('wechat', 'privateKey'), '商户 API 私钥属敏感');
  assert(secret('paypal', 'clientSecret'), 'Client Secret 属敏感');
  // 这些是标识类字段，界面需要回显，不应被当作密钥
  assert(!secret('alipay', 'appId'), '应用 ID 非敏感（需回显）');
  assert(!secret('wechat', 'mchId'), '商户号非敏感（需回显）');
  assert(!secret('wechat', 'appId'), '应用 ID 非敏感（需回显）');
  assert(!secret('paypal', 'clientId'), 'Client ID 非敏感（需回显）');
});

/* ================================================================== *
 * 2 · 校验引擎
 * ================================================================== */

test('合法样例全部通过校验', () => {
  for (const id of pp.ORDER) {
    const r = pp.validate(id, VALID[id]);
    assert(r.ok, `${id} 合法样例应通过，实际错误：${JSON.stringify(r.errors)}`);
    assertEqual(r.errors.length, 0, `${id} 不应有错误`);
  }
});

test('必填项缺失时逐项报错，且错误定位到具体字段', () => {
  for (const id of pp.ORDER) {
    const r = pp.validate(id, {});
    assert(!r.ok, `${id} 空提交应失败`);
    const required = pp.platform(id).fields.filter((f) => f.required).map((f) => f.key);
    const reported = r.errors.map((e) => e.field);
    for (const key of required) {
      assert(reported.includes(key), `${id} 缺少必填项 ${key} 应被报出，实际报了 ${JSON.stringify(reported)}`);
    }
    // 报错信息要能直接看懂，而不是"参数错误"
    for (const e of r.errors) assert(/必填/.test(e.message), `必填报错文案应含"必填"：${e.message}`);
  }
});

test('格式非法的输入被拒，且提示符合官方规则描述', () => {
  const cases = [
    // 支付宝
    ['alipay', { appId: '2021abc' }, 'appId', /16 ~ 32 位纯数字/],
    ['alipay', { appId: '2021004100000000x' }, 'appId', /16 ~ 32 位纯数字/],
    ['alipay', { appCertSn: 'ZZZZ' }, 'appCertSn', /十六进制/],
    // 微信支付
    ['wechat', { mchId: '12345' }, 'mchId', /10 位纯数字/],
    ['wechat', { appId: 'wxabc' }, 'appId', /wx 前缀/],
    ['wechat', { apiV3Key: 'short' }, 'apiV3Key', /32 位字母数字/],
    ['wechat', { certSerialNo: 'ABCDEFGH' }, 'certSerialNo', /40 位十六进制/],
    ['wechat', { subMchId: '190000010' }, 'subMchId', /10 位纯数字/],
    // PayPal
    ['paypal', { clientId: 'ab' }, 'clientId', /20 ~ 128 位/],
    ['paypal', { merchantId: 'ABCDEFGHIJK-' }, 'merchantId', /13 位/],
    ['paypal', { webhookId: '!!' }, 'webhookId', /6 ~ 64 位/],
  ];
  for (const [id, patch, fieldKey, re] of cases) {
    const r = pp.validate(id, Object.assign({}, VALID[id], patch));
    assert(!r.ok, `${id}.${fieldKey} = ${JSON.stringify(patch[fieldKey])} 应被拒绝`);
    const hit = r.errors.find((e) => e.field === fieldKey);
    assert(hit, `${id}.${fieldKey} 的错误应定位到该字段，实际：${JSON.stringify(r.errors)}`);
    assert(re.test(hit.message), `${id}.${fieldKey} 提示应说明官方规则（期望匹配 ${re}），实际："${hit.message}"`);
  }
});

test('枚举字段只接受注册表内列出的值', () => {
  const r1 = pp.validate('alipay', Object.assign({}, VALID.alipay, { signType: 'MD5' }));
  assert(!r1.ok, 'signType 不接受 MD5');
  assert(/RSA2 \/ RSA \/ SM2/.test(r1.errors.find((e) => e.field === 'signType').message), '提示应列出可选值');

  const r2 = pp.validate('paypal', Object.assign({}, VALID.paypal, { mode: 'production' }));
  assert(!r2.ok, 'mode 不接受 production');

  // 合法枚举值应通过
  assert(pp.validate('paypal', Object.assign({}, VALID.paypal, { mode: 'live' })).ok, 'mode=live 应通过');
  assert(pp.validate('alipay', Object.assign({}, VALID.alipay, { signType: 'SM2' })).ok, 'signType=SM2 应通过');
});

test('选填字段留空不影响通过，填写了就要合规', () => {
  assert(pp.validate('alipay', VALID.alipay).ok, '留空选填应通过');
  assert(pp.validate('wechat', VALID.wechat).ok, '留空选填应通过');

  // 服务商模式填了子商户号就要是 10 位
  assert(pp.validate('wechat', Object.assign({}, VALID.wechat, { subMchId: '1900000109' })).ok, '合法子商户号应通过');
  assert(!pp.validate('wechat', Object.assign({}, VALID.wechat, { subMchId: 'abc' })).ok, '非法子商户号应被拒');
});

test('未知平台与空输入不会误判为通过', () => {
  assert(!pp.validate('stripe', {}).ok, '未知平台应失败');
  assert(!pp.validate('alipay', null).ok, 'null 输入应失败');
  assert(!pp.validate('alipay', 'not-an-object').ok, '非对象输入应失败');
});

/* ================================================================== *
 * 3 · 密钥 / URL 专用校验器
 * ================================================================== */

test('私钥校验器：接受 PEM 与长 Base64，拒绝垃圾内容', () => {
  const probe = (v) => pp.VALIDATORS.privateKey(v);
  assert(probe(PEM_PRIVATE) === true, 'PEM 私钥应通过');
  assert(probe('-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----') === true, 'PKCS#1 私钥应通过');
  assert(probe('A'.repeat(240)) === true, '长 Base64 密钥体应通过');
  assert(typeof probe('garbage') === 'string', '垃圾内容应被拒且给出原因');
  assert(typeof probe('A'.repeat(50)) === 'string', '过短的 Base64 应被拒');
  // 头尾必须成对，只有开头没有结尾不算 PEM
  assert(typeof probe('-----BEGIN PRIVATE KEY-----\nMIIE\n') === 'string', '缺少结尾标记的 PEM 应被拒');
});

test('公钥校验器：接受 PEM 与长 Base64，拒绝垃圾内容', () => {
  const probe = (v) => pp.VALIDATORS.publicKey(v);
  assert(probe(PEM_PUBLIC) === true, 'PEM 公钥应通过');
  assert(probe('MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A'.repeat(6)) === true, '长 Base64 公钥应通过');
  assert(typeof probe('not a key') === 'string', '垃圾内容应被拒');
});

test('网关 URL 校验器：强制 https，拒绝 http 与非法地址', () => {
  const probe = (v) => pp.VALIDATORS.httpsUrl(v);
  assert(probe('https://openapi.alipay.com/gateway.do') === true, 'https 网关应通过');
  assert(probe('https://openapi-sandbox.dl.alipaydev.com/gateway.do') === true, '沙箱网关应通过');
  assert(typeof probe('http://openapi.alipay.com/gateway.do') === 'string', '明文 http 应被拒');
  assert(typeof probe('openapi.alipay.com') === 'string', '缺少协议的主机应被拒');
  // 通过字段走一遍，确认真的接在注册表上
  const r = pp.validate('alipay', Object.assign({}, VALID.alipay, { gateway: 'http://a.com' }));
  assert(!r.ok && r.errors.some((e) => e.field === 'gateway'), '网关字段应真的启用该校验器');
});

/* ================================================================== *
 * 4 · 敏感字段不外泄
 * ================================================================== */

test('publicView 不回传任何敏感字段的值，只给「是否已配置」', () => {
  const stored = Object.assign({}, VALID.alipay);
  const view = pp.publicView('alipay', stored);
  for (const f of pp.platform('alipay').fields) {
    if (!f.secret) continue;
    assertEqual(view.values[f.key], '', `敏感字段 ${f.key} 不应回传值`);
    assertEqual(view.configured[f.key], true, `敏感字段 ${f.key} 应标记为已配置`);
  }
  // 已保存的公钥明文绝不能出现在返回结构里
  assert(!JSON.stringify(view).includes('MIIBIjANBgkq'), '返回内容不得包含密钥明文片段');
  // 非敏感字段照常回显
  assertEqual(view.values.appId, '2021004100000000', '非敏感字段应回显');
});

test('未配置时 publicView 的 configured 全为 false', () => {
  const view = pp.publicView('wechat', {});
  for (const f of pp.platform('wechat').fields) {
    assertEqual(view.configured[f.key], false, `${f.key} 未配置时应为 false`);
  }
});

test('maskSecret 不泄露完整明文', () => {
  const m = pp.maskSecret('EeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTt');
  assert(!m.includes('IiJjKkLlMmNn'), '掩码不得保留中段明文');
  assert(m.startsWith('EeFf') && m.endsWith('SsTt'), '掩码保留首尾各 4 位便于核对');
  const pem = pp.maskSecret(PEM_PRIVATE);
  assert(!pem.includes('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDk3VvP3nQ7mXq'), 'PEM 掩码不得含密钥体');
  assertEqual(pp.maskSecret(''), '', '空值掩码为空');
});

/* ================================================================== *
 * 5 · 保存合并语义（"留空保持不变"）
 * ================================================================== */

test('applySave：敏感字段留空保持原值，非敏感字段留空则清空', () => {
  const prev = Object.assign({}, VALID.wechat);
  // 只提交商户号，私钥留空
  const merged = pp.applySave('wechat', prev, { mchId: '1900009191', apiV3Key: '', privateKey: '' });
  assertEqual(merged.mchId, '1900009191', '提交的新值应生效');
  assertEqual(merged.privateKey, PEM_PRIVATE, '敏感字段留空应保持原值');
  assertEqual(merged.apiV3Key, VALID.wechat.apiV3Key, '敏感字段留空应保持原值');

  // 非敏感字段清空
  const merged2 = pp.applySave('wechat', prev, { mchId: '' });
  assert(!merged2.mchId, '非敏感字段留空应被清空');
});

test('applySave：未提交的字段沿用原值，未知字段一律丢弃', () => {
  const prev = Object.assign({}, VALID.paypal);
  const merged = pp.applySave('paypal', prev, { mode: 'live', evilKey: '<script>', __proto__: 'x' });
  assertEqual(merged.mode, 'live', '提交的字段应生效');
  assertEqual(merged.clientId, prev.clientId, '未提交字段应沿用原值');
  assert(!('evilKey' in merged), '注册表之外的键必须丢弃');
  assert(!Object.prototype.hasOwnProperty.call(merged, 'evilKey'), '未知键不得写入');
});

test('applySave：未知平台返回空对象，不产生脏数据', () => {
  assertEqual(Object.keys(pp.applySave('stripe', {}, { a: 1 })).length, 0, '未知平台应返回空对象');
});

test('isConfigured 以必填项为准，选填项不影响判定', () => {
  assert(pp.isConfigured('alipay', VALID.alipay), '必填齐全应判定已配置');
  assert(pp.isConfigured('wechat', VALID.wechat), '必填齐全应判定已配置');
  assert(pp.isConfigured('paypal', VALID.paypal), '必填齐全应判定已配置');
  const partial = Object.assign({}, VALID.alipay);
  delete partial.privateKey;
  assert(!pp.isConfigured('alipay', partial), '缺一个必填项即未配置完成');
  assert(!pp.isConfigured('alipay', {}), '空配置未配置完成');
});

/* ================================================================== *
 * 6 · 扩展点：可替换为真实校验
 * ================================================================== */

test('registerValidator 扩展点生效，且可撤销', () => {
  // 模拟"后续接入 SDK 后的联机校验"：私钥与商户号不匹配
  pp.registerValidator('wechat', (values) => (
    values.mchId === '1900000109' ? [{ field: 'privateKey', message: '私钥与该商户号不匹配' }] : []
  ));
  try {
    const r = pp.validate('wechat', VALID.wechat);
    assert(!r.ok, '自定义校验器应能拦截');
    assert(r.errors.some((e) => e.field === 'privateKey' && /不匹配/.test(e.message)), '自定义错误应被合并进结果');

    // 换一个商户号则不触发
    const ok = pp.validate('wechat', Object.assign({}, VALID.wechat, { mchId: '1900009191' }));
    assert(ok.ok, `不触发条件时应通过，实际：${JSON.stringify(ok.errors)}`);
  } finally {
    // 必须撤销，否则会污染后续用例
    pp.registerValidator('wechat', () => []);
  }
  assert(pp.validate('wechat', VALID.wechat).ok, '撤销后恢复纯本地格式校验');
});

test('registerValidator 拒绝非函数，避免留下坏扩展点', () => {
  let threw = false;
  try {
    pp.registerValidator('alipay', 'not a function');
  } catch (e) {
    threw = /必须是函数/.test(e.message);
  }
  assert(threw, '登记非函数应抛出且提示"必须是函数"');
});

test('超长输入先被长度上限拦截，不会进入正则分支', () => {
  const r = pp.validate('alipay', Object.assign({}, VALID.alipay, { appId: '1'.repeat(48) }));
  assert(!r.ok, '超长应用 ID 应被拒绝');
  const hit = r.errors.find((e) => e.field === 'appId');
  assert(hit, '应定位到 appId');
  assert(/不能超过 32/.test(hit.message), `超长应报长度错误，实际："${hit.message}"`);
});

/* ================================================================== *
 * 7 · 下发前端的表单定义
 * ================================================================== */

test('clientSchema 与服务端同源且可直接序列化', () => {
  const schema = pp.clientSchema();
  assertEqual(schema.length, 3, '应有三份平台定义');
  const json = JSON.stringify(schema); // 不应抛错（含循环引用 / 函数会失败）
  assert(json.length > 0, 'schema 应可序列化');
  for (const p of schema) {
    for (const f of p.fields) {
      assert(typeof f.key === 'string' && f.key, '字段键应为非空字符串');
      assert(['text', 'secret', 'textarea', 'select'].includes(f.input), `${f.key} 的 input 类型应受支持`);
      assert(!('validator' in f) || typeof f.validator !== 'function', '不应把函数体下发前端');
      // pattern 若存在必须是可编译的正则
      if (f.pattern) new RegExp(f.pattern);
      if (f.input === 'select') assert(Array.isArray(f.options) && f.options.length, `${f.key} 缺少下拉选项`);
    }
  }
});

/* ================================================================== *
 * 8 · 路由：全部挂载管理员校验
 * ================================================================== */

test('支付路由全部挂载 requireAdmin（接口层强制校验，不依赖前端隐藏）', () => {
  const router = require(path.join(ROOT, 'server', 'routes', 'payment.js'));
  const routes = router.stack.filter((l) => l.route).map((l) => l.route);
  assertEqual(routes.length, 9, '应有 9 条支付路由');

  const seen = [];
  for (const r of routes) {
    const method = Object.keys(r.methods)[0].toUpperCase();
    seen.push(`${method} ${r.path}`);
    const guarded = r.stack.some((layer) => layer.handle && layer.handle.name === 'requireAdmin');
    assert(guarded, `${method} ${r.path} 必须挂载 requireAdmin，否则普通用户可直接读写支付凭证`);
  }
  const expected = [
    'GET /payment/config',
    'PUT /payment/enabled',
    'PUT /payment/site-url',
    'PUT /payment/config/:platform/enabled',
    'POST /payment/config/:platform/validate',
    'PUT /payment/config/:platform',
    'DELETE /payment/config/:platform',
    'GET /payment/orders',
    'POST /payment/orders/:id/refund',
  ];
  for (const e of expected) assert(seen.includes(e), `缺少路由 ${e}，实际：${seen.join(' | ')}`);
});

/* ================================================================== *
 * 9 · 开关约束（需求一 / 二）
 * ================================================================== */

test('总开关：停用永远允许；启用时若无任何渠道开启则被拒', () => {
  const none = { alipay: false, wechat: false, paypal: false };
  assert(pp2.checkGlobalToggle(false, none).ok, '停用支付功能应始终允许');
  const on = pp2.checkGlobalToggle(true, none);
  assert(!on.ok, '没有任何渠道开启时不允许启用支付功能');
  assert(/至少一个支付渠道/.test(on.message), `提示应引导先启用渠道，实际："${on.message}"`);

  assert(pp2.checkGlobalToggle(true, { alipay: true, wechat: false, paypal: false }).ok, '有一个渠道开启即可启用');
});

test('渠道开关：可任意组合，但总开关启用时不允许关闭最后一个', () => {
  const two = { alipay: true, wechat: true, paypal: false };
  // 两个开着 → 关掉其中一个没问题
  assert(pp2.checkChannelToggle(two, 'wechat', false, true).ok, '还剩一个渠道时允许关闭');
  assert(!pp2.checkChannelToggle(two, 'wechat', false, false).ok === false, '总开关停用时关闭渠道也应允许');

  const one = { alipay: true, wechat: false, paypal: false };
  const bad = pp2.checkChannelToggle(one, 'alipay', false, true);
  assert(!bad.ok, '总开关启用时不允许关闭最后一个渠道');
  assert(/至少需要保留一个支付渠道/.test(bad.message), `提示应说明如何继续，实际："${bad.message}"`);

  // 同一个动作，在总开关停用时是允许的 —— 这条区分很关键，
  // 否则会出现"停用支付后反而无法调整渠道"的死角
  const off = pp2.checkChannelToggle(one, 'alipay', false, false);
  assert(off.ok, '总开关停用时允许关闭全部渠道');

  assert(pp2.checkChannelToggle(one, 'alipay', true, true).ok, '开启渠道永远允许');
});

test('渠道三态：enabled / configured / available 三者必须区分开', () => {
  const cfg = {
    alipay: { enabled: true },   // 开关开，但凭证没填完
    wechat: { enabled: false },  // 开关关
    paypal: { enabled: true },
  };
  const states = pp2.channelStates(cfg, ['alipay', 'wechat', 'paypal']);
  assertEqual(states.alipay, true, 'alipay 开关为开');
  assertEqual(states.wechat, false, 'wechat 开关为关');
  // 没有 enabled 字段的历史数据按关闭处理
  assertEqual(pp2.channelStates({ alipay: {} }, ['alipay']).alipay, false, '缺 enabled 字段视为关闭');
  assertEqual(pp2.channelStates({}, ['alipay']).alipay, false, '无记录视为关闭');

  const ready = { alipay: false, wechat: true, paypal: true };
  const avail = pp2.availableChannels(states, ready);
  assert(!avail.includes('alipay'), '开关开但凭证不完整 → 不可用');
  assert(!avail.includes('wechat'), '开关关 → 不可用');
  assert(avail.includes('paypal'), '开关开且凭证完整 → 可用');
});

/* ================================================================== *
 * 10 · 金额规则（需求三）
 * ================================================================== */

test('金额：最低 0.01 元，以「分」为整数存储，杜绝浮点误差', () => {
  const a = pp2.normalizeAmount(0.01);
  assert(a.ok && a.fen === 1, `0.01 元应为 1 分，实际 ${JSON.stringify(a)}`);
  assert(!pp2.normalizeAmount(0).ok, '0 元不允许');
  assert(!pp2.normalizeAmount(0.001).ok, '低于 0.01 元不允许');
  assert(!pp2.normalizeAmount(-1).ok, '负数不允许');
  assert(!pp2.normalizeAmount('abc').ok, '非数字不允许');
  assert(!pp2.normalizeAmount('').ok, '空值不允许');
  assert(!pp2.normalizeAmount(200000).ok, '超过上限不允许');

  // 0.1 + 0.2 的经典陷阱：必须落到 30 分而不是 30.000000000000004
  const b = pp2.normalizeAmount(0.1 + 0.2);
  assert(b.ok && b.fen === 30, `0.1+0.2 应为 30 分，实际 ${JSON.stringify(b)}`);
  assertEqual(pp2.formatAmount(1), '0.01', '格式化应固定两位小数');
  assertEqual(pp2.formatAmount(12345), '123.45', '格式化应固定两位小数');
});

/* ================================================================== *
 * 11 · 付费生效判定（需求四：全局开关与链接配置的联动）
 * ================================================================== */

/** 构造一次判定所需的上下文 */
function ctxFor({ enabled, states, configured, paid }) {
  return {
    globalEnabled: !!enabled,
    channelStates: states || { alipay: true, wechat: false, paypal: false },
    configuredMap: configured || { alipay: true, wechat: false, paypal: false },
    linkPaid: paid,
  };
}

test('未配置付费 → 永远不收费', () => {
  const r = pp2.resolvePaidState(ctxFor({ enabled: true, paid: { required: false, amountFen: 0 } }));
  assertEqual(r.effective, false, '未开启付费不应收费');
  assertEqual(r.reason, 'not-required', '原因应为未开启');
});

test('全局停用 → 链接自动转免费，但配置原样保留（可恢复）', () => {
  const paid = { required: true, amountFen: 500 };
  const off = pp2.resolvePaidState(ctxFor({ enabled: false, paid }));
  assertEqual(off.effective, false, '停用后不应收费');
  assertEqual(off.required, true, '链接上的付费配置必须原样保留（这是可恢复的前提）');
  assertEqual(off.amountFen, 500, '金额必须原样保留');
  assertEqual(off.reason, 'payment-disabled', '原因应为支付已停用');

  // 重新启用 → 按原配置恢复，不需要任何数据写入
  const on = pp2.resolvePaidState(ctxFor({ enabled: true, paid }));
  assertEqual(on.effective, true, '重新启用后应恢复收费');
  assertEqual(on.amountFen, 500, '恢复的金额应与停用前一致');
});

test('总开关开着但没有可用渠道 → 不收费，且原因与"已停用"区分开', () => {
  const r = pp2.resolvePaidState(ctxFor({
    enabled: true,
    states: { alipay: true },
    configured: { alipay: false }, // 开关开了但凭证没填完
    paid: { required: true, amountFen: 100 },
  }));
  assertEqual(r.effective, false, '没有可用渠道时不应收费');
  assertEqual(r.reason, 'no-channel', '原因应为无可用渠道');
  assert(pp2.REASON_TEXT['no-channel'], '无可用渠道应有面向下载者的说明文案');
});

test('三种不生效原因都配有面向下载者的说明文案', () => {
  for (const k of ['payment-disabled', 'no-channel']) {
    assert(pp2.REASON_TEXT[k] && pp2.REASON_TEXT[k].length > 0, `${k} 缺少说明文案`);
  }
});

/* ================================================================== *
 * 12 · 订单状态机（需求三）
 * ================================================================== */

/**
 * 订单会真实落盘，必须隔离到临时目录 —— 否则跑一次测试就在 data/ 里留一堆垃圾订单。
 * 注意：要在 require 之前设置，因为数据目录是模块加载时定死的。
 */
const ordersDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pay-orders-'));
process.env.COS_DATA_DIR = ordersDir;
const orders = require(path.join(ROOT, 'server', 'payment-orders.js'));
after(() => {
  try { fs.rmSync(ordersDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

test('订单状态流转：pending → paid 放行，pending → failed 拦截', () => {
  const o = orders.create({ linkId: 'L1', platform: 'alipay', amountFen: 500, payerIp: '1.2.3.4' });
  assertEqual(o.status, 'pending', '新订单应为支付中');
  assertEqual(o.amountFen, 500, '金额应快照进订单');

  // 支付中：不得放行
  const pending = orders.payerState('L1', orders.orderToken(o));
  assertEqual(pending.state, 'pending', '票据应能解析出支付中状态');

  const paid = orders.markPaid(o.id);
  assertEqual(paid.status, 'paid', '确认成功应置为已支付');
  assert(Boolean(paid.paidAt), '应记录支付时间');
  assertEqual(orders.payerState('L1', orders.orderToken(o)).state, 'paid', '已支付应放行');

  // 已支付订单不允许被改判失败（防止重复回调把成功订单打回）
  const stillPaid = orders.markFailed(o.id, '回调说失败');
  assertEqual(stillPaid.status, 'paid', '已支付订单不应被改判为失败');
});

test('支付失败：可重新发起新订单，旧失败订单不再作为凭证', () => {
  const o1 = orders.create({ linkId: 'L2', platform: 'wechat', amountFen: 100 });
  const failed = orders.markFailed(o1.id, '支付未完成或已被取消');
  assertEqual(failed.status, 'failed', '确认失败应置为失败');
  assert(/取消/.test(failed.failReason), '应记录失败原因供界面展示');
  assertEqual(orders.payerState('L2', orders.orderToken(o1)).state, 'failed', '失败状态应被识别');

  // 重新发起
  const o2 = orders.create({ linkId: 'L2', platform: 'alipay', amountFen: 100 });
  assert(o2.id !== o1.id, '重新发起应生成新订单');
  assertEqual(orders.payerState('L2', orders.orderToken(o2)).state, 'pending', '新订单回到支付中');
});

test('退款：已支付才可标记，标记后支付凭证失效且不再计入已收', () => {
  const o = orders.create({ linkId: 'L4', platform: 'alipay', amountFen: 800 });
  orders.markPaid(o.id);

  // ① 支付中的订单退无可退（钱还没进账）
  const pendingOrder = orders.create({ linkId: 'L4', platform: 'wechat', amountFen: 300 });
  const notYet = orders.markRefunded(pendingOrder.id);
  assertEqual(notYet.status, 'pending', '未支付的订单不得被标记为已退款');

  // ② 已支付 → 已退款
  const r = orders.markRefunded(o.id);
  assertEqual(r.status, 'refunded', '已支付订单应能标记为已退款');
  assert(Boolean(r.refundedAt), '应记录退款时间');

  // ③ 凭证失效：这是退款的全部意义 —— 否则退了钱还能凭旧票据下载
  assertEqual(orders.payerState('L4', orders.orderToken(o)).state, 'refunded',
    '退款后票据仍要能认出这个人，但状态必须是 refunded 而非 paid');
  assert(orders.payerState('L4', orders.orderToken(o)).state !== 'paid',
    '已退款订单绝不能再放行下载');

  // ④ 幂等：重复标记不应改变状态，也不应重复记账
  const again = orders.markRefunded(o.id);
  assertEqual(again.status, 'refunded', '重复退款应保持幂等');

  // ⑤ 失败订单无需退款
  const bad = orders.create({ linkId: 'L4', platform: 'alipay', amountFen: 100 });
  orders.markFailed(bad.id, '支付未完成');
  assertEqual(orders.markRefunded(bad.id).status, 'failed', '失败的订单不得标记为已退款');
});

test('退款是不可逆终态：网关查单仍说已支付时也不得复活', () => {
  const o = orders.create({ linkId: 'L5', platform: 'alipay', amountFen: 1200 });
  orders.markPaid(o.id);
  orders.markRefunded(o.id);

  // 该订单确实付过钱 —— 异步通知 / 轮询会再去查单，查回来必然是「已支付」。
  // 若这里放行，管理员刚退的一笔会被网关的回答改回 paid，下载者得以继续下载。
  const revived = orders.markPaid(o.id);
  assertEqual(revived.status, 'refunded', '已退款订单不得被网关的「已支付」结果复活');
  assertEqual(orders.payerState('L5', orders.orderToken(o)).state, 'refunded',
    '复活一旦发生，支付凭证就会重新生效');

  // 同样不能被改判失败（否则 failReason 会盖掉退款事实）
  const failed = orders.markFailed(o.id, '回调说失败');
  assertEqual(failed.status, 'refunded', '已退款订单不得被改判为支付失败');

  // 退款订单必须参与「永不裁剪」集合，否则日后无法证明这笔钱退过
  assert(orders.MAX_ORDERS_PER_LINK > 0, '裁剪上限应存在');
  const two = orders.create({ linkId: 'L5', platform: 'alipay', amountFen: 100 });
  orders.markPaid(two.id);
  orders.markRefunded(two.id);
  assertEqual(orders.get(two.id).status, 'refunded', '第二笔退款应成功');
});

test('订单视图暴露退款时间，且不含密钥类字段', () => {
  const o = orders.create({ linkId: 'L6', platform: 'alipay', amountFen: 100, payerIp: '9.9.9.9' });
  orders.markPaid(o.id);
  assertEqual(orders.view(o).refundedAt, null, '未退款时退款时间应为 null');
  orders.markRefunded(o.id);
  const v = orders.view(orders.get(o.id));
  assert(Boolean(v.refundedAt), '已退款订单的视图应带退款时间');
  assertEqual(v.payerIp, undefined, '视图不得向前端泄露付款者 IP');
  assertEqual(v.status, 'refunded', '视图状态应与内部一致');
});

test('退款订单永不参与裁剪（否则历史退款记录会被自动清掉，无从对账）', () => {
  const link = 'LK-PRUNE';
  const kept = orders.create({ linkId: link, platform: 'alipay', amountFen: 700 });
  orders.markPaid(kept.id);
  orders.markRefunded(kept.id);

  // 灌满裁剪上限（MAX_ORDERS_PER_LINK=50），触发 create 内部的 prune(linkId)
  for (let i = 0; i < orders.MAX_ORDERS_PER_LINK + 12; i++) {
    const o = orders.create({ linkId: link, platform: 'alipay', amountFen: 100 });
    orders.markFailed(o.id, '支付未完成');
  }
  const still = orders.get(kept.id);
  assert(still, '退款订单必须仍在 —— 一旦被裁剪，就再也无法证明这笔钱退过');
  assertEqual(still.status, 'refunded', '退款状态不得因裁剪而改变');
  assert(orders.listForLink(link).length <= orders.MAX_ORDERS_PER_LINK,
    '裁剪仍应生效：总数不得超过上限');
});

test('退款接口：仅管理员可用，且只能作用于已支付订单（真实 HTTP）', async () => {
  const express = require(path.join(ROOT, 'node_modules', 'express'));
  const { statsStore } = require(path.join(ROOT, 'server', 'routes', '_context.js'));
  const origLog = statsStore.addLog;
  statsStore.addLog = () => {}; // 只在 ui JSON 临时目录里工作，这里彻底免写
  let server = null;
  try {
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use((req, _res, next) => {
      req.authUser = { username: 'tester', role: req.headers['x-test-role'] === 'admin' ? 'admin' : 'user' };
      next();
    });
    app.use('/api', require(path.join(ROOT, 'server', 'routes', 'payment.js')));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const call = (method, url, role) => new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port, method, path: url,
        headers: Object.assign({ 'X-Requested-With': 'XMLHttpRequest' }, role ? { 'x-test-role': role } : null),
      }, (res) => {
        let text = '';
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', () => resolve({ status: 0, json: null }));
      req.end();
    });

    const o = orders.create({ linkId: 'L7', platform: 'alipay', amountFen: 600 });

    // ① 普通用户：一律 403（接口层把关，不靠前端隐藏）
    const denied = await call('POST', `/api/payment/orders/${o.id}/refund`, 'user');
    assertEqual(denied.status, 403, '退款必须仅限管理员');
    assertEqual(orders.get(o.id).status, 'pending', '被拒后订单状态不得变化');

    // ② 订单存在但尚未支付 → 400 且给出可读原因
    const tooEarly = await call('POST', `/api/payment/orders/${o.id}/refund`, 'admin');
    assertEqual(tooEarly.status, 400, '未支付的订单不得退款');
    assert(/无法退款/.test((tooEarly.json && tooEarly.json.error) || ''),
      `应说明为何不能退（实际："${tooEarly.json && tooEarly.json.error}"）`);

    // ③ 已支付 → 成功，且返回的正是已退款状态
    orders.markPaid(o.id);
    const ok = await call('POST', `/api/payment/orders/${o.id}/refund`, 'admin');
    assertEqual(ok.status, 200, '已支付订单应能退款');
    assertEqual(ok.json && ok.json.order && ok.json.order.status, 'refunded', '响应应回传已退款状态');
    assert(ok.json && ok.json.order && ok.json.order.refundedAt, '响应应带退款时间');

    // ④ 重复退款 → 400（幂故排除向量：同样的请求不能改两次账）
    const again = await call('POST', `/api/payment/orders/${o.id}/refund`, 'admin');
    assertEqual(again.status, 400, '已退款的订单不得重复退款');

    // ⑤ 不存在的订单 → 404
    const missing = await call('POST', '/api/payment/orders/does-not-exist/refund', 'admin');
    assertEqual(missing.status, 404, '不存在的订单应返回 404');
  } finally {
    statsStore.addLog = origLog;
    if (server) await new Promise((r) => server.close(r));
  }
});

test('分享下载的放行必须是「严格等于 paid」的白名单', () => {
  // 这是退款能真正生效的最后一道闸：一旦有人把 `payer.state !== 'paid'`
  // 改写成逐个枚举的「黑名单」，新出现的 refunded 状态就会被默认放行 ——
  // 退款后的订单仍能下载，等于白嫖。（payerState 已是全部判据的唯一来源。）
  const src = require('fs').readFileSync(path.join(ROOT, 'server', 'share-routes.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\w])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
  assert(/payer\.state !== 'paid'/.test(code),
    '分享下载必须以「不是 paid 就拦截」的白名单形式判定，逐个状态枚举的黑名单写法会漏放未来新增的状态');
  assert(!/payer\.state !== 'none'/.test(code), '不得以「不是 none 就放行」的形式写判定');
});

test('订单票据：无法跨链接复用，也无法伪造', () => {
  const o = orders.create({ linkId: 'LA', platform: 'alipay', amountFen: 100 });
  orders.markPaid(o.id);
  const token = orders.orderToken(o);

  // 同一票据拿到别的链接上必须失效
  assertEqual(orders.payerState('LB', token).state, 'none', '票据不得跨链接复用');
  assert(orders.verifyToken('LB', token) === null, '跨链接校验应返回 null');

  // 伪造 / 空值 / 乱码一律无效
  assertEqual(orders.payerState('LA', '').state, 'none', '空票据视为未支付');
  assertEqual(orders.payerState('LA', 'garbage').state, 'none', '乱码票据视为未支付');
  assertEqual(orders.payerState('LA', o.id + '.' + 'f'.repeat(64)).state, 'none', '伪造签名应被拒');
});

test('改价不影响已支付订单，新订单按新金额', () => {
  const old1 = orders.create({ linkId: 'L3', platform: 'alipay', amountFen: 100 });
  orders.markPaid(old1.id);
  // 分享者把价格改成 9.99 元
  const after = orders.create({ linkId: 'L3', platform: 'alipay', amountFen: 999 });
  assertEqual(orders.get(old1.id).amountFen, 100, '已支付订单的金额快照不应被改动');
  assertEqual(after.amountFen, 999, '新订单应采用新金额');
  assertEqual(orders.payerState('L3', orders.orderToken(old1)).state, 'paid', '已支付订单在新价格下依然有效');
});
