/**
 * 请求上下文 —— 基于 AsyncLocalStorage 的按请求/按会话状态
 *
 * ## 为什么需要它（FUN-15）
 *
 * 「当前激活桶」原先只是配置里的一个全局字段 `cfg.activeBucketId`。任何登录用户
 * 调用 `PUT /buckets/local/:id/active` 都会改写它 —— 于是普通用户切桶会连带改变：
 *   - 管理员界面看到的当前桶；
 *   - `/api/fs/*`、`/api/stats/*` 解析出的目标桶；
 *   - WebDAV 服务与分享链接使用的桶（二者没有会话）。
 * 这是典型的「多人共享单值全局状态」，在多人同时使用时表现为"我的桶自己变了"。
 *
 * 修复思路是让「当前桶」成为**会话级**状态。但直接给所有 `requireConfig()` 调用点
 * 加参数会牵动几十处路由，且极易漏改。这里改用 AsyncLocalStorage：在鉴权中间件里
 * 建立一次上下文，后续任何深度的异步调用都能取到，**路由层零改动**即完成按会话隔离。
 *
 * 全局 `cfg.activeBucketId` 保留，语义降级为**系统默认桶**，仅在无会话场景
 * （WebDAV、分享链接、启动自检）与首次登录时作为回退。
 */
const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * 在上下文中执行 `fn`（Express 中间件里传入 `next` 即可覆盖后续全部处理）。
 * @param {{token?:string, userId?:string, role?:string, activeBucketId?:string}} store
 * @param {Function} fn
 */
function runWith(store, fn) {
  return storage.run(store || {}, fn);
}

/** 当前上下文；不在请求中时返回 null */
function current() {
  return storage.getStore() || null;
}

/** 当前请求的会话 token（无则空串） */
function token() {
  const s = current();
  return s && s.token ? s.token : '';
}

/** 当前请求所属用户的角色（无上下文时返回空串，调用方按最宽松处理） */
function role() {
  const s = current();
  return s && s.role ? s.role : '';
}

/** 当前上下文记录的激活桶 id（未设置返回空串） */
function activeBucketId() {
  const s = current();
  return s && s.activeBucketId ? s.activeBucketId : '';
}

/** 更新当前上下文的激活桶 id（供切桶接口立即生效，无需重新登录） */
function setActiveBucketId(id) {
  const s = current();
  if (s) s.activeBucketId = id || '';
}

module.exports = { runWith, current, token, role, activeBucketId, setActiveBucketId };
