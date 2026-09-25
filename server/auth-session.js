/**
 * 会话管理 —— 本地 WebUI 登录会话（内存存储）
 *
 *  - 登录成功后生成随机 token，通过 Cookie 下发
 *  - 会话保存在内存 Map 中，默认 24 小时有效；服务重启后会话失效（可接受）
 *  - token 不落盘，降低泄露风险
 */
const crypto = require('crypto');

const COOKIE_NAME = 'cosmgr_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时（不勾选「记住登录状态」）
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天（勾选「记住登录状态」）
const MAX_SESSIONS_PER_USER = 10; // 每用户最多并发会话数，超出时淘汰最早的（S11）

const sessions = new Map(); // token -> { user, expiresAt, createdAt, remember }

/**
 * 创建会话，返回 token；超出每用户上限时淘汰最早会话，避免无限堆积
 * @param {object} user
 * @param {{remember?: boolean}} [opts] remember=true 时用 30 天有效期
 */
function createSession(user, opts) {
  const remember = Boolean(opts && opts.remember);
  const uid = user && user.id;
  if (uid !== undefined && uid !== null) {
    const mine = [];
    for (const [t, s] of sessions) if (s.user && String(s.user.id) === String(uid)) mine.push([t, s]);
    if (mine.length >= MAX_SESSIONS_PER_USER) {
      mine.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
      const drop = mine.length - MAX_SESSIONS_PER_USER + 1;
      for (let i = 0; i < drop; i++) sessions.delete(mine[i][0]);
    }
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    user: Object.assign({}, user),
    expiresAt: Date.now() + (remember ? REMEMBER_TTL_MS : SESSION_TTL_MS),
    createdAt: Date.now(),
    remember,
    // FUN-15：当前桶是**会话级**状态，不能再写进全局配置
    // （否则普通用户切桶会改变管理员与 WebDAV 的目标桶）。
    // 空串表示"跟随系统默认桶"。
    activeBucketId: '',
  });
  prune();
  return token;
}

/**
 * 设置会话的当前桶（FUN-15）
 * @returns {boolean} token 有效则 true
 */
function setSessionBucket(token, bucketId) {
  const s = getSession(token); // 顺带清理过期会话
  if (!s) return false;
  s.activeBucketId = bucketId || '';
  return true;
}

/** 读取会话的当前桶；未设置或会话失效返回空串 */
function getSessionBucket(token) {
  const s = getSession(token);
  return (s && s.activeBucketId) || '';
}

/** 强制登出某用户的全部会话（S11「强制登出所有设备」），返回销毁数量 */
function destroyUserSessions(userId) {
  let n = 0;
  for (const [t, s] of sessions) {
    if (s.user && String(s.user.id) === String(userId)) { sessions.delete(t); n += 1; }
  }
  return n;
}

/**
 * 强制登出某用户的**其它**会话，保留 `keepToken` 对应的那一个。
 *
 * 用途：用户自行修改密码时，应让其它设备（可能已被窃取的会话）立即失效，
 * 但不能把当前操作中的这台设备也踢掉 —— 否则用户改完密码立刻掉线，体验突兀。
 */
function destroyUserSessionsExcept(userId, keepToken) {
  let n = 0;
  for (const [t, s] of sessions) {
    if (t === keepToken) continue;
    if (s.user && String(s.user.id) === String(userId)) { sessions.delete(t); n += 1; }
  }
  return n;
}

/** 会话概况（管理/运维用）：总数与按用户分布 */
function stats() {
  prune();
  const byUser = {};
  for (const s of sessions.values()) {
    const k = (s.user && s.user.username) || '(未知)';
    byUser[k] = (byUser[k] || 0) + 1;
  }
  return { total: sessions.size, byUser };
}

/** 校验 token 并返回会话（含 user），无效或过期返回 null */
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

/**
 * 取会话的剩余有效期（毫秒）；无效返回 0。
 *
 * Cookie 的 Max-Age 必须由**会话自身的过期时间**推导，不能写死常量 ——
 * 否则「记住登录状态」勾选后下发的仍是 24 小时 Cookie，
 * 浏览器会先于服务端把会话丢掉，勾选形同虚设。
 */
function sessionTtl(token) {
  const s = getSession(token);
  if (!s) return 0;
  return Math.max(0, s.expiresAt - Date.now());
}

/** 销毁会话（登出） */
function destroySession(token) {
  if (token) sessions.delete(token);
}

/** 从请求 Cookie 中解析会话 token */
function parseToken(req) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE_NAME) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        return part.slice(i + 1).trim();
      }
    }
  }
  return '';
}

/** 清理过期会话 */
function prune() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (v.expiresAt < now) sessions.delete(k);
  }
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_MS,
  REMEMBER_TTL_MS,
  MAX_SESSIONS_PER_USER,
  createSession,
  getSession,
  sessionTtl,
  destroySession,
  destroyUserSessions,
  destroyUserSessionsExcept,
  setSessionBucket,
  getSessionBucket,
  stats,
  parseToken,
};
