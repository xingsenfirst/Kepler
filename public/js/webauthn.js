/**
 * Windows Hello（WebAuthn）前端交互
 *
 * 职责：
 *  1. 登录第二步 —— 收到 `webauthnRequired` 后自动唤起 Windows Hello 并回传断言；
 *  2. 凭据注册 —— 用户在"编辑用户"中勾选启用时，完成 `navigator.credentials.create` 并回传；
 *  3. 关闭 —— 通知服务端清除凭据。
 *
 * 设计要点：
 *  - **与 reCAPTCHA / Turnstile 完全解耦**：验证码属登录第一步（密码之前），
 *    本模块只在密码校验通过、服务端要求二次验证时才介入，两条链路串联而非互斥。
 *  - 所有 base64url 编解码都在本模块内完成，服务端只接受 base64url 字符串。
 *  - 环境不支持（非安全上下文 / 非 Windows Hello 平台 / 浏览器无 WebAuthn）时
 *    给出明确文案，绝不静默失败。
 *
 * ⚠️ 血泪教训（2026-09-14）：**"安全上下文校验失败"曾是一个误导性极强的文案**。
 *    旧版把所有 `SecurityError` 一律归因为"没走 HTTPS"，导致用户在本地
 *    HTTP 和 HTTPS 下都看到同一句提示、却怎么换协议都没用。真实原因通常是
 *    **rpId 不合法**——WebAuthn 要求 rpId 是有效域名，而 IP 字面量（127.0.0.1）
 *    严格来说不合法，部分浏览器直接抛 SecurityError。
 *    因此现在统一走 `describeError()` 按实际环境精确区分，并给出可执行动作。
 */

/** 浏览器是否具备 WebAuthn 能力（注意：HTTP 非回环地址下不可用） */
export function webauthnSupported() {
  return typeof window !== 'undefined' &&
    !!(window.PublicKeyCredential && navigator.credentials);
}

/** 当前页面是否为安全上下文（https 或 localhost/127.0.0.1） */
export function isSecureContextOK() {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * 主机名是否为 IP 字面量。
 *
 * ⚠️ 这是 Windows Hello 在本地失败的**头号原因**：
 * WebAuthn 规范要求 `rp.id` 必须是「有效域标识符」（valid domain string），
 * **IP 字面量（含 127.0.0.1 / [::1]）严格来说不合法**。部分浏览器（如某些版本的
 * Edge / Chrome）会对 IP 形式的 rpId 直接抛 `SecurityError`：
 *   "The relying party ID is not a registrable domain suffix of, nor equal to, the current domain."
 * 该错误与"是否 HTTPS"无关 —— 所以用户会看到 HTTP 和 HTTPS **都失败**。
 *
 * 而 `localhost` 是合法域标识符，因此在本地一律推荐用 localhost 访问。
 */
export function isIpLiteralHost(host) {
  const h = String(host === undefined ? (typeof location !== 'undefined' ? location.hostname : '') : host);
  if (!h) return false;
  if (h.startsWith('[') && h.endsWith(']')) return true; // IPv6 字面量 [::1]
  if (h.includes(':')) return true;                      // 未加括号的 IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);              // IPv4 字面量
}

/**
 * 当前环境能否启用 Windows Hello —— 返回结构化结果而非布尔值，
 * 便于把「为什么不行」精确告知用户（旧版只返回布尔值，导致所有失败都归因于"安全上下文"）。
 *
 * @returns {{ok:boolean, reason:string, hint:string}}
 */
export function webauthnReadiness() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { ok: false, reason: 'no_window', hint: '当前不在浏览器环境中。' };
  }
  if (!webauthnSupported()) {
    return {
      ok: false, reason: 'unsupported',
      hint: '当前浏览器不支持 WebAuthn（Windows Hello）。请改用最新版 Edge 或 Chrome。',
    };
  }
  if (!isSecureContextOK()) {
    return {
      ok: false, reason: 'insecure_context',
      hint: `当前地址 ${location.origin} 不是安全上下文。请通过 HTTPS，或使用 127.0.0.1 / localhost 访问。`,
    };
  }
  // 安全上下文成立，但主机名是 IP 字面量 → rpId 非法，浏览器会抛 SecurityError
  if (isIpLiteralHost()) {
    return {
      ok: false, reason: 'ip_literal_rpid',
      hint: `当前通过 IP（${location.hostname}）访问，而 WebAuthn 要求 rpId 是有效域名，`
        + '多数浏览器会拒绝。请改用 http://localhost'
        + (location.port ? ':' + location.port : '') + ' 访问本系统后重试。',
    };
  }
  return { ok: true, reason: 'ok', hint: '' };
}

/* ------------------------------ base64url 工具 ------------------------------ */

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBuf(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** 把 DOMException 翻译为用户可读文案（Windows Hello 的失败原因大多在此） */
export function describeError(e) {
  const name = (e && e.name) || '';
  const msg = (e && e.message) || '';
  if (name === 'NotAllowedError') {
    // 用户取消 / 超时 / 未匹配到可用凭据，浏览器出于隐私不区分，统一提示
    return 'Windows Hello 验证已取消或超时，请重试';
  }
  if (name === 'AbortError') return 'Windows Hello 验证被中止，请重试';
  if (name === 'NotSupportedError') return '当前环境不支持 Windows Hello，请改用最新版 Edge 或 Chrome';
  if (name === 'SecurityError') {
    // ⚠️ SecurityError 有多个来源，绝不能再笼统地归因为"安全上下文"（那是旧版的误导性文案）：
    //   1) rp.id 不是当前 origin 的可注册域（最常见，含 IP 字面量 rpId）
    //   2) 真的处于非安全上下文
    // 这里按实际环境精确区分，直接给出可执行的修复动作。
    if (!isSecureContextOK()) {
      return `安全上下文校验失败：当前地址 ${location.origin} 不受信任，请通过 HTTPS 或 127.0.0.1 / localhost 访问本系统`;
    }
    if (isIpLiteralHost()) {
      return `Windows Hello 不支持以 IP 地址（${location.hostname}）作为访问域名，请改用 http://localhost`
        + (location.port ? ':' + location.port : '') + ' 重新访问后再启用';
    }
    return 'Windows Hello 域名校验失败（rpId 与当前访问地址不一致）：请确认浏览器地址栏的主机名与系统访问地址完全相同，'
      + '不要使用反向代理改写域名，改用 localhost 或 HTTPS 域名访问';
  }
  if (name === 'InvalidStateError') return '该 Windows Hello 凭据已在本机注册过，请先移除后重试';
  if (name === 'ConstraintError') return '本机未找到可用的 Windows Hello 设备（请在系统中先设置 PIN 或指纹）';
  if (/timed out|timeout/i.test(msg)) return 'Windows Hello 验证超时，请重试';
  return msg ? `Windows Hello 验证失败（${name || '未知错误'}）：${msg}` : 'Windows Hello 验证失败';
}

/* ------------------------------ 注册（启用） ------------------------------ */

/**
 * 完成注册流程：取选项 → 唤起 Windows Hello → 回传验签。
 * @param {object} API   api.js 的 API 对象（注入以避免循环依赖）
 * @param {string} password 当前账户密码（服务端用于确认操作者身份）
 * @returns {Promise<{ok:true, user:object}>}
 */
export async function registerWindowsHello(API, password) {
  const ready = webauthnReadiness();
  if (!ready.ok) throw new Error(ready.hint);

  const opt = await API.webauthnRegisterOptions(password);
  if (!opt || !opt.challenge) throw new Error('服务端未返回注册挑战，请重试');

  // 交叉校验：服务端依据 Host 头推导的 rpId 必须与浏览器当前主机名一致，
  // 否则浏览器必然抛 SecurityError。在调用 API 之前就拦下，给出人能看懂的原因。
  const serverRpId = (opt.rp && opt.rp.id) || '';
  if (serverRpId && serverRpId !== location.hostname) {
    throw new Error(
      `访问地址不一致：服务端返回的验证域名是「${serverRpId}」，而当前地址栏是「${location.hostname}」。`
      + '请确认没有经过反向代理改写域名，并用与访问地址完全一致的主机名重新打开本系统。'
    );
  }

  const publicKey = {
    rp: opt.rp,
    user: {
      id: b64urlToBuf(opt.user.id),
      name: opt.user.name,
      displayName: opt.user.displayName || opt.user.name,
    },
    challenge: b64urlToBuf(opt.challenge),
    pubKeyCredParams: (opt.pubKeyCredParams || [{ type: 'public-key', alg: -7 }]).map((p) => ({
      type: p.type, alg: p.alg,
    })),
    timeout: opt.timeout || 60000,
    attestation: opt.attestation || 'none',
    authenticatorSelection: opt.authenticatorSelection || {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'discouraged',
    },
    excludeCredentials: [],
  };

  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey });
  } catch (e) {
    throw new Error(describeError(e));
  }
  if (!cred) throw new Error('Windows Hello 注册未返回凭据');

  const resp = cred.response;
  return API.webauthnRegisterVerify({
    challenge: opt.challenge,
    rawId: bufToB64url(cred.rawId),
    clientDataJSON: bufToB64url(resp.clientDataJSON),
    attestationObject: bufToB64url(resp.attestationObject),
  });
}

/* ------------------------------ 登录断言 ------------------------------ */

/**
 * 完成登录第二步：唤起 Windows Hello 并回传断言。
 *
 * @param {object} API
 * @param {object} req 第一步 /auth/login 的响应（含 challenge / rpId / username / credentialId）
 * @returns {Promise<{ok:true, user:object}>}
 */
export async function verifyWindowsHello(API, req) {
  const ready = webauthnReadiness();
  if (!ready.ok) {
    throw new Error(ready.reason === 'unsupported'
      ? '当前浏览器不支持 Windows Hello，请使用其他浏览器或联系管理员关闭该验证'
      : ready.hint);
  }

  const allow = [];
  if (req.credentialId) {
    allow.push({ type: 'public-key', id: b64urlToBuf(req.credentialId), transports: ['internal'] });
  }

  const publicKey = {
    challenge: b64urlToBuf(req.challenge),
    rpId: req.rpId || location.hostname,
    timeout: req.timeout || 60000,
    userVerification: 'required',
    allowCredentials: allow,
  };

  let assertion;
  try {
    assertion = await navigator.credentials.get({ publicKey });
  } catch (e) {
    throw new Error(describeError(e));
  }
  if (!assertion) throw new Error('Windows Hello 未返回验证结果');

  const resp = assertion.response;
  return API.loginWebauthn({
    username: req.username,
    challenge: req.challenge,
    // 「记住登录状态」由第一步带回，此处原样回传给第二步（服务端据此决定会话有效期）
    remember: !!req.remember,
    rawId: bufToB64url(assertion.rawId),
    clientDataJSON: bufToB64url(resp.clientDataJSON),
    authenticatorData: bufToB64url(resp.authenticatorData),
    signature: bufToB64url(resp.signature),
  });
}
