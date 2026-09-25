/**
 * 真实支付网关适配器（server/payment-gateway.js）—— 行为断言
 *
 * 网关联调无法在单测里做（要真凭证 + 公网回调），所以这里覆盖的是
 * **能在本地确定性验证**的两类东西：
 *   1. 签名串 / 请求头的**构造规则**（错一格就永远签不过，是最容易写错的部分）
 *   2. 失败路径必须 fail-closed（查单失败绝不能判成"已支付"）
 */
const crypto = require('crypto');
const path = require('path');
const test = require('node:test');
const { assert, assertEqual, assertMatch, ROOT } = require('./helpers');

const gw = require(path.join(ROOT, 'server', 'payment-gateway.js'));

/** 生成一对临时 RSA 密钥（仅用于验证签名流程走得通） */
const { privateKey: RSA_PRIV, publicKey: RSA_PUB } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/* ================================================================== *
 * 1 · 支付宝签名
 * ================================================================== */

test('alipaySignPayload：按 key 升序拼接，剔除 sign 与空值', () => {
  const s = gw.alipaySignPayload({
    method: 'alipay.trade.page.pay',
    app_id: '2021001',
    sign: 'xxx',          // 必须剔除
    charset: 'utf-8',
    empty: '',            // 必须剔除
    nul: null,            // 必须剔除
    biz_content: '{"a":1}',
  });
  assertEqual(s, 'app_id=2021001&biz_content={"a":1}&charset=utf-8&method=alipay.trade.page.pay',
    '待签名串应为升序拼接且不含 sign / 空值');
});

test('alipaySignPayload：空对象得到空串（不会抛出）', () => {
  assertEqual(gw.alipaySignPayload({}), '');
  assertEqual(gw.alipaySignPayload({ sign: 'x', a: '' }), '');
});

test('alipayBuildUrl：带签名参数、值做 URL 编码，且可用公钥验签', () => {
  const params = {
    app_id: '2021004100000000',
    method: 'alipay.trade.page.pay',
    biz_content: JSON.stringify({ out_trade_no: 'abc', subject: '中文 主题 & more' }),
  };
  const url = gw.alipayBuildUrl('https://openapi.alipay.com/gateway.do', params, RSA_PRIV, 'RSA2');
  const u = new URL(url);
  assertEqual(u.origin + u.pathname, 'https://openapi.alipay.com/gateway.do', '应指向配置中的网关');
  assert(u.searchParams.get('sign'), '应带 sign 参数');
  assertEqual(u.searchParams.get('app_id'), '2021004100000000', '业务参数应完整');
  assertEqual(u.searchParams.get('biz_content'), params.biz_content, 'biz_content 应能原样取回（已正确编码）');

  // 用公钥验签：证明签的确实是「按规则拼出的那个串」
  const sign = Buffer.from(u.searchParams.get('sign'), 'base64');
  const payload = gw.alipaySignPayload(params);
  const ok = crypto.createVerify('RSA-SHA256').update(payload, 'utf8').verify(RSA_PUB, sign);
  assert(ok, '签名应能用对应公钥验证通过（否则网关侧必然报签名错误）');
});

test('alipayTimestamp：格式 yyyy-MM-dd HH:mm:ss', () => {
  assertMatch(gw.alipayTimestamp(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, '时间戳格式');
});

/* ================================================================== *
 * 2 · 微信支付 APIv3
 * ================================================================== */

test('wechatSignPayload：五段换行，GET 请求也保留末尾换行', () => {
  const s = gw.wechatSignPayload('GET', '/v3/pay/transactions/id?mchid=1', '1700000000', 'nonce123', '');
  assertEqual(s, 'GET\n/v3/pay/transactions/id?mchid=1\n1700000000\nnonce123\n\n',
    'GET 的报文主体为空串，但末尾换行不能少（少了会恒定 401）');
  const p = gw.wechatSignPayload('POST', '/v3/pay/transactions/native', '1', 'n', '{"a":1}');
  assertEqual(p, 'POST\n/v3/pay/transactions/native\n1\nn\n{"a":1}\n', 'POST 应把报文主体放在倒数第二行');
});

test('wechatAuthorization：头格式与字段齐全，签名可验', () => {
  const cfg = { mchId: '1900000109', certSerialNo: 'ABCD1234', privateKey: RSA_PRIV };
  const ts = '1700000000';
  const nonce = 'abcdef1234567890';
  const body = '{"amount":{"total":1}}';
  const auth = gw.wechatAuthorization('POST', '/v3/pay/transactions/native', body, cfg, { timestamp: ts, nonce });

  assertMatch(auth, /^WECHATPAY2-SHA256-RSA2048 /, '应以 WECHATPAY2-SHA256-RSA2048 开头');
  assertMatch(auth, /mchid="1900000109"/, '应带 mchid');
  assertMatch(auth, /serial_no="ABCD1234"/, '应带商户证书序列号');
  assertMatch(auth, /nonce_str="abcdef1234567890"/, '应带 nonce_str');
  assertMatch(auth, /timestamp="1700000000"/, '应带 timestamp');

  const sig = /signature="([^"]+)"/.exec(auth)[1];
  const payload = gw.wechatSignPayload('POST', '/v3/pay/transactions/native', ts, nonce, body);
  const ok = crypto.createVerify('RSA-SHA256').update(payload, 'utf8').verify(RSA_PUB, Buffer.from(sig, 'base64'));
  assert(ok, 'Authorization 中的签名应能用商户公钥验证通过');
});

/**
 * R8-01：**签名调用必须把报文主体传进去**。
 *
 * `wechatAuthorization(method, url, body, cfg, {timestamp, nonce})` 是五参数。
 * 旧实现写成 `wechatAuthorization(method, path, cfg, {timestamp, nonce})` —— 实参整体
 * 左移一位：`cfg` 收到的是请求体、第五参解构 `undefined` → **每次调用必抛 TypeError**。
 * 微信渠道的下单与查单都经过这里，因此该渠道此前 100% 不可用，而单测只覆盖了
 * 构造规则（`wechatAuthorization` 本身没问题），没覆盖"调用点传对了参数"。
 *
 * 这条护栏因此必须**端到端**：驱动真实的下单 / 查单流程、拦下外发请求，
 * 再用公钥验证签名的确是「方法\n路径\n时间戳\n随机串\n报文主体\n」这一串 ——
 * 只要主体没参与签名，验签必然失败。
 */
test('R8-01 · 微信下单 / 查单：签名必须覆盖报文主体（漏传 body 会让该渠道必然抛错）', async () => {
  const cfg = { appId: 'wx-app', mchId: 'mch-1', certSerialNo: 'SERIAL-1', privateKey: RSA_PRIV };
  const captured = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    captured.push({ url, init });
    // 按请求方法给不同响应，避免依赖调用次序（下单 POST / 查单 GET）
    const isQuery = String((init && init.method) || '').toUpperCase() === 'GET';
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify(
        isQuery
          ? { trade_state: 'SUCCESS', transaction_id: 'wx-tx-1' }
          : { code_url: 'weixin://wxpay/bizpayurl?pr=abc' },
      ),
    };
  };

  /** 从 Authorization 头里取签名，按「微信规定的待签名串」用公钥验签 */
  const verifyAuth = (init, method, path, body) => {
    const auth = (init.headers && init.headers.Authorization) || '';
    assert(/^WECHATPAY2-SHA256-RSA2048 /.test(auth), 'Authorization 必须是 WECHATPAY2-SHA256-RSA2048 方案');
    const ts = /timestamp="(\d+)"/.exec(auth)[1];
    const nonce = /nonce_str="([^"]+)"/.exec(auth)[1];
    const sig = /signature="([^"]+)"/.exec(auth)[1];
    const payload = gw.wechatSignPayload(method, path, ts, nonce, body);
    return crypto.createVerify('RSA-SHA256').update(payload, 'utf8')
      .verify(RSA_PUB, Buffer.from(sig, 'base64'));
  };

  try {
    /* ---- ① 下单（POST，有报文主体） ---- */
    const r = await gw.createCharge('wechat', cfg, {
      order: { id: 'ORD-1', amountFen: 100 }, subject: '测试商品', notifyUrl: 'https://example.test/notify',
    });
    assertEqual(r.ok, true,
      `微信下单必须可用（实际失败：${r.error || ''}）—— 签名调用漏传 body 会让它必然抛 TypeError`);
    assertEqual(captured.length, 1, '下单应恰好发出一次外发请求');

    const postInit = captured[0].init;
    assert(postInit.body, '下单请求必须带报文主体');
    assert(verifyAuth(postInit, 'POST', '/v3/pay/transactions/native', postInit.body),
      '微信侧的待签名串是「方法\\n路径\\n时间戳\\n随机串\\n报文主体\\n」——'
      + '报文主体必须逐字参与签名，否则网关恒定报签名错误');

    /* ---- ② 查单（GET，主体为空串但末尾换行不能少） ---- */
    captured.length = 0;
    const q = await gw.queryCharge('wechat', cfg, { id: 'ORD-1' });
    assertEqual(q.paid, true, `查单应识别为已支付（实际 state=${q.state} ${q.failReason || ''}）`);
    assertEqual(captured.length, 1, '查单应恰好发出一次外发请求');

    const u = new URL(captured[0].url);
    const getInit = captured[0].init;
    assertEqual(getInit.body, undefined, 'GET 查单不得带请求体（带 body 会被网关直接拒绝）');
    assert(verifyAuth(getInit, 'GET', u.pathname + u.search, ''),
      '查单的签名必须基于「方法\\n路径（含 query）\\n时间戳\\n随机串\\n\\n」——'
      + '结尾那个空行漏掉会恒定 401');
  } finally {
    global.fetch = realFetch;
  }
});

test('wechatDecryptResource：AES-256-GCM 加解密往返一致', () => {  const apiV3Key = '0123456789abcdef0123456789abcdef'; // 32 字节
  const nonce = 'abc123456789';
  const aad = 'transaction';
  const plain = JSON.stringify({ out_trade_no: 'ORDER-1', trade_state: 'SUCCESS' });

  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(aad));
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const resource = {
    ciphertext: Buffer.concat([enc, cipher.getAuthTag()]).toString('base64'),
    nonce,
    associated_data: aad,
  };
  assertEqual(gw.wechatDecryptResource(apiV3Key, resource), plain, '应能还原出原始报文（用于从通知里取订单号）');
});

test('wechatDecryptResource：密钥不合法或密文过短时抛错（不静默返回空）', () => {
  let threw = false;
  try { gw.wechatDecryptResource('short', { ciphertext: 'AAAA', nonce: 'x', associated_data: '' }); } catch (e) { threw = true; }
  assert(threw, 'APIv3 密钥长度不对时必须抛错');

  threw = false;
  try { gw.wechatDecryptResource('0123456789abcdef0123456789abcdef', { ciphertext: '', nonce: '', associated_data: '' }); } catch (e) { threw = true; }
  assert(threw, '密文为空时必须抛错');
});

/* ================================================================== *
 * 3 · PayPal
 * ================================================================== */

test('paypalHost：live 走生产域名，其余一律沙箱（避免误用生产凭证）', () => {
  assertEqual(gw.paypalHost('live'), 'https://api-m.paypal.com');
  assertEqual(gw.paypalHost('LIVE'), 'https://api-m.paypal.com');
  assertEqual(gw.paypalHost('sandbox'), 'https://api-m.sandbox.paypal.com');
  assertEqual(gw.paypalHost(''), 'https://api-m.sandbox.paypal.com', '缺省应落到沙箱（更安全的一侧）');
  assertEqual(gw.paypalHost(undefined), 'https://api-m.sandbox.paypal.com');
});

/* ================================================================== *
 * 4 · 私钥归一化
 * ================================================================== */

test('normalizePrivateKey：PEM 原样返回，裸 Base64 按 PKCS#8 包裹', () => {
  // 输出统一 trim（密钥前后的空行无意义，且各家控制台复制出来常带换行）
  assertEqual(gw.normalizePrivateKey(RSA_PRIV), RSA_PRIV.trim(), '已是 PEM 时除首尾空白外不改动');
  const body = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=';
  const out = gw.normalizePrivateKey(body);
  assert(out.startsWith('-----BEGIN PRIVATE KEY-----'), '应补上 PEM 头');
  assert(out.endsWith('-----END PRIVATE KEY-----'), '应补上 PEM 尾');
  assertEqual(out.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), body, '密钥体本身应原样保留');
  assertEqual(gw.normalizePrivateKey(''), '', '空输入返回空');
});

/* ================================================================== *
 * 5 · 失败路径必须 fail-closed
 * ================================================================== */

test('createCharge：未知平台直接失败，不发起任何网络请求', async () => {
  const r = await gw.createCharge('unknown-pay', {}, { order: { id: 'x' } });
  assertEqual(r.ok, false, '未知平台应失败');
  assert(r.error, '应给出错误信息');
});

test('queryCharge：未知平台判为未支付（不置为已支付）', async () => {
  const r = await gw.queryCharge('unknown-pay', {}, { id: 'x' });
  assertEqual(r.paid, false, '未知平台绝不能判为已支付');
  assertEqual(r.state, 'error', '状态应为 error 以便上层重试或提示');
});

test('queryCharge：网关不可达 / 凭证错误时判为未支付（fail-closed）', async () => {
  // 指向一个必然不可达的地址，走真实的网络失败路径
  const r = await gw.queryCharge('alipay', {
    appId: '2021004100000000', privateKey: RSA_PRIV, signType: 'RSA2',
    gateway: 'https://127.0.0.1:1/gateway.do',
  }, { id: 'order-1' });
  assertEqual(r.paid, false, '查单失败时绝不能判为已支付——宁可慢一点确认，也不能误放行');
  assert(r.failReason, '应给出失败原因（便于排障与展示）');
});
