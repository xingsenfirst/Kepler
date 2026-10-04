/**
 * 分享链接状态的**前端**判定 —— 必须与服务端 `server/share-store.js` 的 status() 同序。
 *
 * 单独成文件的原因：管理页既要用它渲染状态徽章，又要据此把整行灰化划线，
 * 编辑弹窗里也要提示；这段判定一旦与服务端不同步，就会出现「管理页显示有效、
 * 访客打开却提示文件已删除」。独立且不含任何 DOM 依赖，测试才能直接加载它。
 *
 * ⚠️ 改这里的判定顺序时，同步改 server/share-store.js 的 status()。
 */

export const STATUS_META = {
  active: { label: '有效', cls: 'ok' },
  expired: { label: '已过期', cls: 'bad' },
  exhausted: { label: '已关闭', cls: 'warn' },
  deleted: { label: '文件已删除', cls: 'gone' },
};

/**
 * @param {object} l /api/links 返回的链接视图（服务端 view() 已带上 missing 字段）
 * @returns {'deleted'|'expired'|'exhausted'|'active'}
 */
export function statusOf(l) {
  if (!l) return 'active';
  // 「文件已删除」优先于过期 / 次数用尽：对象没了是最根本的事实，
  // 否则管理员会去改有效期，改完照样下不了。
  if (l.missing) return 'deleted';
  if (l.expiresAt && new Date(l.expiresAt).getTime() <= Date.now()) return 'expired';
  if (l.maxDownloads > 0 && l.downloads >= l.maxDownloads) return 'exhausted';
  return 'active';
}

/**
 * 「失效」链接的状态集合 —— 「删除失效链接」按钮的**前端唯一判据**。
 *
 * ⚠️ **刻意不含 `exhausted`（已关闭）**：那是一个**可逆**状态，管理员把
 * 「可下载次数」调大即可让链接复活；把它当失效删掉，会让「先收紧配额、之后再放开」
 * 变成不可逆操作。`deleted`（对象真没了）与 `expired`（时间已过）才无法靠改配置恢复。
 *
 * 与服务端 `server/share-store.js` 的 `removeDead()` 必须保持一致：
 * 两边各写一份就会出现「界面说 3 条失效、点下去只删掉 1 条」。
 */
export const DEAD_STATUS = new Set(['deleted', 'expired']);

/** 该链接是否属于「失效」（可被「删除失效链接」清掉） */
export function isDead(l) {
  return DEAD_STATUS.has(statusOf(l));
}
