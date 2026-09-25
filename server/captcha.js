/**
 * 验证码服务模块 —— 服务端校验网关（零硬依赖版本）
 *
 * 设计要点：
 *  - 同时支持 Google reCAPTCHA 与 Cloudflare Turnstile，通过配置项二选一。
 *  - 敏感信息（secretKey / siteKey）仅来自配置（data/config.enc）或环境变量，绝不硬编码。
 *  - 校验只在服务端完成：前端提交的 token 不可信，必须回源服务商验证。
 *  - 全程超时受控（AbortController），绝不会让 /auth/login 无响应。
 *  - 当验证码服务不可用 / 超时 / 校验失败时，按策略返回"失败"（拦截），
 *    若显式降级（degrade=true，即配置异常/密钥缺失）则放过登录，绝不挂死接口。
 *  - 关闭（enabled=false）时本模块零行为：verify() 直接放行，无任何网络依赖。
 *
 * 环境变量覆盖（优先级高于 config.enc 中的同名字段）：
 *  - CAPTCHA_PROVIDER        'recaptcha' | 'turnstile'
 *  - CAPTCHA_SITE_KEY        前端渲染用站点公钥
 *  - CAPTCHA_SECRET_KEY      服务端校验用密钥（绝不下发前端）
 *  - CAPTCHA_ENABLED         'true' | 'false'
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// 服务商校验端点
const VERIFY_ENDPOINTS = {
  recaptcha: 'https://www.recaptcha.net/recaptcha/api/siteverify', // 走 recaptcha.net，规避 google.com 不可达
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
};

/** 默认配置（关闭状态；不依赖任何外部服务） */
const DEFAULTS = {
  enabled: false,        // 全局开关（默认关闭，登录保持原有逻辑）
  provider: 'recaptcha', // 'recaptcha' | 'turnstile'
  siteKey: '',           // 站点公钥（前端渲染用，可下发）
  secretKey: '',         // 服务端密钥（绝不回传前端）
  timeoutMs: 5000,       // 单次校验超时（毫秒）
  verifyPath: '',        // reCAPTCHA v2 可选：action 名或前端传回的额外字段归属（保留扩展位）
  // 失败策略：'block'（默认，校验失败/不可用拦截登录）或 'degrade'（异常时放行）
  // 注意：安全默认是 block；只有在配置明显缺失/不可用时才会自动降级，避免"开了等于没开"。
  onError: 'block',
};

/**
 * 读取当前生效的验证码配置。
 * 优先级：环境变量 > configStore.captcha > DEFAULTS。
 * 任何字段缺失时回落到 DEFAULTS，确保返回结构完整、绝不抛错。
 * @param {object} configStore 配置存储模块（注入，避免直接 require 造成循环依赖）
 */
function resolveConfig(configStore) {
  let stored = {};
  try {
    const cfg = configStore.load();
    if (cfg && cfg.captcha && typeof cfg.captcha === 'object') stored = cfg.captcha;
  } catch (e) { /* 配置不可用时回落默认 */ }

  const env = {};
  // 仅在环境变量真实存在时写入，避免 Object.assign 用 undefined 覆盖已存储的配置
  if (process.env.CAPTCHA_PROVIDER) env.provider = process.env.CAPTCHA_PROVIDER;
  if (process.env.CAPTCHA_SITE_KEY) env.siteKey = process.env.CAPTCHA_SITE_KEY;
  if (process.env.CAPTCHA_SECRET_KEY) env.secretKey = process.env.CAPTCHA_SECRET_KEY;
  if (process.env.CAPTCHA_ENABLED === 'true') env.enabled = true;
  else if (process.env.CAPTCHA_ENABLED === 'false') env.enabled = false;

  const merged = Object.assign({}, DEFAULTS, stored, env);
  // 规范化枚举，避免脏配置导致后续分支异常
  if (merged.provider !== 'turnstile' && merged.provider !== 'recaptcha') merged.provider = 'recaptcha';
  if (merged.onError !== 'degrade') merged.onError = 'block';
  if (!Number.isFinite(merged.timeoutMs) || merged.timeoutMs <= 0 || merged.timeoutMs > 15000) {
    merged.timeoutMs = DEFAULTS.timeoutMs;
  }
  return merged;
}

/** 前端可见配置（绝不暴露 secretKey） */
function publicConfig(configStore) {
  const c = resolveConfig(configStore);
  return {
    enabled: !!c.enabled,
    provider: c.provider,
    siteKey: c.siteKey || '',
    // 仅当真正可用（已开启且具备 siteKey）时前端才渲染验证码组件
    available: !!(c.enabled && c.siteKey),
  };
}

/**
 * 执行一次服务商校验请求（带超时）。
 * @returns {Promise<{success:boolean, raw?:object, error?:string}>}
 */
function postVerify(endpoint, params, timeoutMs) {
  return new Promise((resolve) => {
    let body;
    try {
      body = new URLSearchParams(params).toString();
    } catch (e) {
      return resolve({ success: false, error: 'invalid_params' });
    }
    let u;
    try { u = new URL(endpoint); } catch (e) { return resolve({ success: false, error: 'bad_endpoint' }); }

    const lib = u.protocol === 'http:' ? http : https;
    const reqOpt = {
      method: 'POST',
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'cosmgr-captcha/1.0',
      },
    };

    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    let req;
    try {
      req = lib.request(reqOpt, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (settled) return;
          try {
            const json = JSON.parse(raw);
            finish({ success: json && json.success === true, raw: json });
          } catch (e) {
            finish({ success: false, error: 'bad_response', raw: raw.slice(0, 200) });
          }
        });
      });
    } catch (e) {
      return finish({ success: false, error: 'request_failed' });
    }

    req.on('error', (err) => finish({ success: false, error: 'network:' + (err && err.code ? err.code : 'error') }));
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish({ success: false, error: 'timeout' }); });
    try {
      req.setTimeout(timeoutMs);
      req.write(body);
      req.end();
    } catch (e) {
      finish({ success: false, error: 'write_failed' });
    }
  });
}

/**
 * 服务端校验入口（供 /auth/login 调用）。
 *
 * @param {object} args
 * @param {string} args.token          前端提交的验证码 token（reCAPTCHA: g-recaptcha-response；Turnstile: cf-turnstile-response）
 * @param {string} [args.remoteip]     可选客户端 IP（服务商支持时一并提交）
 * @param {object} configStore         配置存储模块
 * @returns {Promise<{passed:boolean, reason?:string, degraded?:boolean}>}
 *   - passed=true   允许登录流程继续
 *   - passed=false  拦截（reason 给出可读原因，前端直接呈现）
 *   - degraded=true 表示本次因服务不可用而放行（仅 onError='degrade' 或配置缺失时）
 *
 * 设计保证：
 *  - enabled=false 时直接 passed=true（零网络依赖、零副作用）。
 *  - 任何异常/超时都不会抛错，而是转为 passed=false 或 degraded，绝不挂死登录接口。
 */
async function verify({ token, remoteip }, configStore) {
  let c;
  try { c = resolveConfig(configStore); } catch (e) { c = Object.assign({}, DEFAULTS); }

  // 1) 关闭状态：完全放行，保持原有登录逻辑
  if (!c.enabled) return { passed: true, reason: 'disabled' };

  // 2) 缺少必要配置（provider/secretKey/siteKey）：视为"配置不可用"
  //    此时若策略为 degrade 则放行，否则一律拦截（避免"开了却等于没开"）。
  const endpoint = VERIFY_ENDPOINTS[c.provider];
  const missing = !endpoint || !c.secretKey || !c.siteKey;
  if (missing) {
    if (c.onError === 'degrade') return { passed: true, reason: 'config_missing_degraded', degraded: true };
    return { passed: false, reason: 'captcha_not_configured' };
  }

  // 3) 前端未提交 token：直接拦截（防止跳过校验）
  if (!token || !String(token).trim()) {
    return { passed: false, reason: 'captcha_token_missing' };
  }

  // 4) 回源校验（受控超时）
  const params = { secret: c.secretKey, response: String(token).trim() };
  if (remoteip) params.remoteip = String(remoteip);

  let result;
  try {
    result = await postVerify(endpoint, params, c.timeoutMs);
  } catch (e) {
    result = { success: false, error: 'unexpected' };
  }

  if (result.success) return { passed: true, reason: 'ok' };

  // 5) 校验失败 / 超时 / 网络异常
  if (c.onError === 'degrade') {
    // 仅在"服务不可达/超时/纯网络错误"时降级放行；明确业务失败（success=false 且非网络问题）仍拦截
    const netErr = ['timeout', 'network', 'request_failed', 'bad_endpoint', 'bad_response', 'write_failed', 'unexpected'].some((k) => String(result.error || '').includes(k));
    if (netErr) return { passed: true, reason: 'verify_error_degraded', degraded: true };
  }
  return { passed: false, reason: result.error || 'captcha_failed' };
}

/**
 * 校验结果原因码 → 面向用户的可读文案（拦截场景）。
 * 仅用于登录接口的错误响应；放行场景不需要文案。
 */
function publicReason(reason) {
  const r = String(reason || '');
  if (r === 'captcha_not_configured') return '人机验证服务未正确配置，登录已被拦截，请联系管理员检查验证码设置';
  if (r === 'captcha_token_missing') return '请先完成人机验证';
  if (r === 'timeout') return '人机验证超时，请重新验证后重试';
  if (r.indexOf('network') === 0 || r === 'request_failed' || r === 'write_failed' || r === 'bad_endpoint') return '人机验证服务暂不可用，请稍后重试';
  if (r === 'bad_response' || r === 'unexpected') return '人机验证服务响应异常，请重试';
  return '人机验证未通过，请重新验证';
}

module.exports = { resolveConfig, publicConfig, verify, publicReason, DEFAULTS, VERIFY_ENDPOINTS };
