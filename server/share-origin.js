/**
 * 分享下载「请求来源」判定（SEC-08 的纯函数实现，便于行为测试）
 *
 * 背景：`GET /s/:id/dl` 是**有副作用的 GET** —— 命中即扣减下载次数。
 * 若不作来源校验，第三方页面只要写一行 `<img src="https://host/s/xxx/dl">`，
 * 任何打开该页面的人都会默默帮它刷掉一次额度。
 *
 * 难点：`Sec-Fetch-Site` 只有现代浏览器发送，curl / wget / 旧浏览器不发，
 * 所以「缺失该头」不能直接放行（旧实现就是这样，等于第二层防护不存在），
 * 也不能直接拒绝（会误伤合法的脚本直连下载）。
 *
 * 分层策略（优先级从高到低）：
 *   ① 有有效票据（解锁 Cookie）→ 放行。正常流程一定是"先看分享页再点下载"，
 *      而票据 Cookie 是 SameSite=Lax，跨站子资源请求不会携带 —— 天然阻断 `<img>` 预取。
 *   ② 浏览器显式声明 cross-site → 拒绝。
 *   ③ 无票据且缺失该头 → 回退校验 Referer：有 Referer 但不同源即拒绝；
 *      无 Referer 判定为直连客户端（curl/wget），放行但要求调用方记审计日志。
 *   ④ 浏览器声明 same-site / same-origin / none（用户主动发起）→ 放行。
 *
 * 该函数**不产生副作用**（不发日志、不改状态），判定结果由调用方执行，
 * 这样它才能被单元测试直接驱动。
 */

const CROSS_SITE = 'cross-site';

/**
 * @param {object} ctx
 * @param {string} [ctx.secFetchSite]  Sec-Fetch-Site 请求头（已小写化）
 * @param {string} [ctx.referer]       Referer / Referrer 请求头
 * @param {string} [ctx.host]          当前请求的 Host 头（含端口）
 * @param {boolean} [ctx.secure]       是否 HTTPS（req.secure）
 * @param {boolean} [ctx.hasTicket]    是否已通过密码解锁（持有有效票据 Cookie）
 * @returns {{ allow: boolean, reason: string }}
 */
function classifyDownloadSource(ctx) {
  const c = ctx || {};
  const site = String(c.secFetchSite || '').trim().toLowerCase();
  const hasTicket = c.hasTicket === true;

  // ① 票据优先：持票说明用户确实访问过分享页并解锁过
  if (hasTicket) return { allow: true, reason: 'ticket' };

  // ② 浏览器显式声明跨站
  if (site === CROSS_SITE) return { allow: false, reason: 'cross-site' };

  // ③ 缺失 Sec-Fetch-Site：非浏览器客户端，或不支持该头的旧浏览器
  if (site === '') {
    const ref = String(c.referer || '').trim();
    if (!ref) {
      // 直连客户端（curl / wget）：保留可用性，但标记为无来源，由调用方记审计
      return { allow: true, reason: 'no-source-hint' };
    }
    let sameOrigin = false;
    try {
      const u = new URL(ref);
      const proto = c.secure ? 'https:' : 'http:';
      sameOrigin = u.protocol === proto && u.host === String(c.host || '');
    } catch (e) {
      sameOrigin = false;
    }
    return sameOrigin ? { allow: true, reason: 'referer-same-origin' } : { allow: false, reason: 'referer-cross-origin' };
  }

  // ④ 浏览器声明同源 / 用户直接发起
  return { allow: true, reason: site === 'none' ? 'user-initiated' : `site-${site}` };
}

module.exports = { classifyDownloadSource, CROSS_SITE };
