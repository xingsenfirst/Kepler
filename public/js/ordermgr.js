/** 订单管理页 —— 付费下载订单的流水与对账（视觉风格与「链接管理」保持一致） */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, fmtTime } from './util.js';

let ordersCache = [];
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  const btn = document.getElementById('btn-orders-refresh');
  if (btn) btn.onclick = () => refresh();
}

const STATUS_META = {
  pending: { label: '支付中', cls: 'warn' },
  paid: { label: '已支付', cls: 'ok' },
  failed: { label: '支付失败', cls: 'bad' },
  refunded: { label: '已退款', cls: 'refund' },
};

/** 退款的二次确认文案：本系统不代持资金，这一步只是记账 */
const REFUND_NOTICE = '由于本系统不代持资金，将此订单设置为已退款则代表已在其它渠道退还钱款给下载者，本系统仅作记账和标记。';

function fmtAmount(o) {
  return `¥${(Number(o.amountFen || 0) / 100).toFixed(2)}`;
}

/** 时间列：没有值时显示占位符，避免整列参差 */
function fmtTimeOrDash(v) {
  return v ? escapeHtml(fmtTime(v)) : '<span class="ord-dash">—</span>';
}

function fmtLink(o) {
  if (!o.linkExists) return '<span class="ord-dash" title="分享链接已被删除">已删除</span>';
  return `<button class="mini-btn" data-act="copy" title="${escapeHtml(o.linkUrl)}">复制链接</button>`;
}

function fmtDownloaded(o) {
  if (o.downloadedAt) {
    return `<span class="ord-yes" title="${escapeHtml(fmtTime(o.downloadedAt))}">已下载</span>`;
  }
  if (o.status === 'paid') return '<span class="ord-no">未下载</span>';
  return '<span class="ord-dash">—</span>';
}

/**
 * 汇总统计（抽成纯函数以便直接驱动测试）。
 *
 * **「已收」只统计「已支付」** —— 退款过的钱已经退回去了，账面上不能再算作收入，
 * 这是退款动作两个可见后果之一（另一个是支付凭证失效）。退款金额单独列出，
 * 否则管理员只会看到总额变少，却看不出是被自己退掉的那一笔。
 *
 * @param {Array<{status:string, amountFen:number}>} orders
 * @returns {{count:number, receivedFen:number, refundedFen:number}}
 */
export function computeTotals(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const sum = (st) => list
    .filter((o) => o.status === st)
    .reduce((s, o) => s + (Number(o.amountFen) || 0), 0);
  return { count: list.length, receivedFen: sum('paid'), refundedFen: sum('refunded') };
}

/** 已退款的行整行置灰 + 数据列划线（.row-refunded 与「文件已删除」的 .row-gone 同机制） */
export function rowClassOf(o) {
  return o && o.status === 'refunded' ? 'row-refunded' : '';
}

/**
 * 操作列：只有「已支付」的订单能退款。
 *
 * 其余状态给占位符而不是禁用按钮 —— 禁用按钮虽然列宽一致，但会让用户以为
 * 「再点几下就能解锁」；占位符明确传达"这一行没有可执行的操作"。
 */
export function fmtActions(o) {
  if (!o || o.status !== 'paid') return '<span class="lk-dash">—</span>';
  return '<button class="mini-btn danger" data-act="refund" title="标记为已退款（本系统不代持资金，仅作记账）">退款</button>';
}

export function refresh() {
  wire();
  const box = document.getElementById('ordermgr-table');
  if (!box) return;
  API.paymentOrders().then((r) => {
    ordersCache = r.orders || [];
    render();
  }).catch((e) => {
    box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
  });
}

function render() {
  const box = document.getElementById('ordermgr-table');
  const head = document.getElementById('ordermgr-count');
  if (!box) return;

  const { count, receivedFen, refundedFen } = computeTotals(ordersCache);
  if (head) {
    head.textContent = count
      ? `（共 ${count} 笔 · 已收 ¥${(receivedFen / 100).toFixed(2)}`
        + (refundedFen ? ` · 已退款 ¥${(refundedFen / 100).toFixed(2)}` : '') + '）'
      : '';
  }

  if (!ordersCache.length) {
    box.innerHTML = `<div class="lk-empty">还没有付费订单。为分享链接开启「需付费下载」后，下载者支付成功即会在此留下一笔记录。</div>`;
    return;
  }

  box.innerHTML = `<table class="lk-table">
    <thead><tr>
      <th>文件</th><th>文件链接</th><th>订单号</th><th>金额</th><th>支付方式</th>
      <th>创建时间</th><th>付款时间</th><th>支付状态</th><th>是否已下载</th><th style="width:90px">操作</th>
    </tr></thead>
    <tbody>
      ${ordersCache.map((o) => {
        const sm = STATUS_META[o.status] || { label: o.status || '未知', cls: '' };
        // 已退款：整行灰化 + 数据列划线，明确「这笔钱不算数了」；
        // 但状态列（徽章）与操作列保持可读 —— 与「文件已删除的分享链接」同一视觉语言。
        const dim = o.status === 'refunded' ? ' class="lk-dim"' : '';
        // 已带 class 的列只能追加类名（重复 class 属性会被 HTML 解析器丢弃）
        const dimExtra = o.status === 'refunded' ? ' lk-dim' : '';
        const refundTitle = o.refundedAt ? `退款时间：${escapeHtml(fmtTime(o.refundedAt))}` : '';
        return `<tr data-id="${escapeHtml(o.id)}"${rowClassOf(o) ? ` class="${rowClassOf(o)}"` : ''}>
          <td class="lk-file${dimExtra}" title="${escapeHtml(o.fileKey || o.fileName)}">${escapeHtml(o.fileName || '(未记录文件名)')}</td>
          <td>${fmtLink(o)}</td>
          <td class="ord-no-wrap${dimExtra}" title="${escapeHtml(o.tradeNo || '')}">${escapeHtml(o.id)}</td>
          <td${dim}><b style="color:#b45309">${escapeHtml(fmtAmount(o))}</b></td>
          <td${dim}>${escapeHtml(o.platformName || o.platform || '—')}</td>
          <td${dim}>${escapeHtml(fmtTime(o.createdAt))}</td>
          <td${dim}>${fmtTimeOrDash(o.paidAt)}</td>
          <td><span class="lk-badge ${sm.cls}"${refundTitle ? ` title="${refundTitle}"` : ''}>${sm.label}</span></td>
          <td${dim}>${fmtDownloaded(o)}</td>
          <td class="lk-acts">${fmtActions(o)}</td>
        </tr>`;
      }).join('')}
    </tbody></table>`;

  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const o = ordersCache.find((x) => x.id === tr.dataset.id);
    if (!o) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        if (btn.dataset.act === 'copy') copyUrl(o);
        else if (btn.dataset.act === 'refund') refund(o);
      };
    });
  });
}

async function copyUrl(o) {
  const url = location.origin + o.linkUrl;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制到剪贴板', { type: 'success' });
  } catch (e) {
    openModal({
      title: '分享链接', body: `<textarea readonly style="width:100%;height:72px;border:1px solid var(--border-strong);border-radius:6px;padding:8px;font-size:12px;resize:none">${escapeHtml(url)}</textarea>`,
      foot: [{ text: '关闭' }],
    });
  }
}

/**
 * 标记订单为已退款。
 *
 * 这一步**不调用任何支付网关** —— 钱从未经过本系统服务器，退款是在渠道后台
 * 手动完成的。所以文案必须先说清楚这一点，避免管理员误以为点了就退钱到账。
 */
async function refund(o) {
  const ok = await confirmDialog({ allowHtml: true,
    title: '标记为已退款',
    message: `确定将 <b>${escapeHtml(o.fileName || '(未记录文件名)')}</b> 的这笔 `
      + `<b style="color:#b45309">${escapeHtml(fmtAmount(o))}</b> 订单标记为已退款吗？<br><br>`
      + `<span style="color:var(--danger)">${escapeHtml(REFUND_NOTICE)}</span><br><br>`
      + '<span style="color:var(--text-2)">标记后该订单的支付凭证立即失效（下载者需重新支付），'
      + '且这笔金额不再计入「已收」。</span>',
    okText: '标记为已退款', danger: true,
  });
  if (!ok) return;
  try {
    await API.refundOrder(o.id);
    toast('已标记为退款：支付凭证已失效，该笔金额不再计入已收', { type: 'success', duration: 5000 });
    refresh();
  } catch (e) {
    toast('操作失败：' + e.message, { type: 'error' });
  }
}

/** 供 main.js 在登出 / 换账号时清空残留 */
export function reset() {
  ordersCache = [];
  const box = document.getElementById('ordermgr-table');
  if (box) box.innerHTML = '';
  const head = document.getElementById('ordermgr-count');
  if (head) head.textContent = '';
}
