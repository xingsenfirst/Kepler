/** 链接管理页 —— 查看全部分享链接，编辑 / 删除 / 复制 */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, fmtSize, fmtTime } from './util.js';
import { STATUS_META, statusOf } from './share-status.js';

let linksCache = [];
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  const btn = document.getElementById('btn-links-refresh');
  if (btn) btn.onclick = () => refresh();
}

function fmtExpiry(l) {
  if (!l.expiresAt) return '永久';
  return fmtTime(l.expiresAt);
}

function fmtCount(l) {
  return l.maxDownloads > 0 ? `${l.downloads} / ${l.maxDownloads}` : `${l.downloads} / ∞`;
}

/**
 * 付费列：链接上的 `required` 只是**分享者的意图**，是否真的收费取决于
 * 支付功能总开关与可用渠道，因此这里只展示配置本身，不臆断当前是否收费。
 */
function fmtPaid(l) {
  const p = l.paid || {};
  if (!p.required) return '—';
  return `<b style="color:#b45309">¥${(Number(p.amountFen || 0) / 100).toFixed(2)}</b>`;
}

/** 创建者：历史链接没有该字段（早于「按创建者隔离」时创建），显示占位符而非 undefined */
function fmtOwner(l) {
  return l.createdBy ? escapeHtml(l.createdBy) : '<span class="lk-dash" title="创建于按创建者隔离之前的旧链接">—</span>';
}

/** 存储桶：同样是创建时快照的；历史数据可能为空 */
function fmtBucket(l) {
  return l.bucket
    ? `<span class="lk-bucket" title="${escapeHtml(l.bucket)}">${escapeHtml(l.bucket)}</span>`
    : '<span class="lk-dash">—</span>';
}

export function refresh() {
  wire();
  const box = document.getElementById('linkmgr-table');
  if (!box) return;
  API.links().then((r) => {
    linksCache = r.links || [];
    render();
  }).catch((e) => {
    box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
  });
}

function render() {
  const box = document.getElementById('linkmgr-table');
  const head = document.getElementById('linkmgr-count');
  if (!box) return;
  if (head) head.textContent = linksCache.length ? `（共 ${linksCache.length} 条）` : '';
  if (!linksCache.length) {
    box.innerHTML = `<div class="lk-empty">还没有分享链接。在文件列表中选中文件 → 点击“复制链接”即可创建。</div>`;
    return;
  }
  box.innerHTML = `<table class="lk-table">
    <thead><tr>
      <th>文件</th><th>分享者</th><th>存储桶</th><th>状态</th><th>有效期至</th><th>下载次数</th><th>密码</th><th>付费</th><th>创建时间</th><th style="width:150px">操作</th>
    </tr></thead>
    <tbody>
      ${linksCache.map((l) => {
        const st = statusOf(l);
        const sm = STATUS_META[st];
        // 文件已被删除：整行灰化 + 划线（.lk-dim 只标数据列，状态列与操作列保持可读）
        const gone = st === 'deleted';
        const dim = gone ? ' class="lk-dim"' : '';
        return `<tr data-id="${escapeHtml(l.id)}"${gone ? ' class="row-gone"' : ''}>
          <td class="lk-file${gone ? ' lk-dim' : ''}" title="${escapeHtml(l.bucket)}/${escapeHtml(l.key)}（${fmtSize(l.size)}）">${escapeHtml(l.fileName || l.key)}</td>
          <td${dim}>${fmtOwner(l)}</td>
          <td${dim}>${fmtBucket(l)}</td>
          <td><span class="lk-badge ${sm.cls}">${sm.label}</span></td>
          <td${dim}>${escapeHtml(fmtExpiry(l))}</td>
          <td${dim}>${escapeHtml(fmtCount(l))}</td>
          <td${dim}>${l.hasPassword ? '🔒 已启用' : '—'}</td>
          <td${dim}>${fmtPaid(l)}</td>
          <td${dim}>${escapeHtml(fmtTime(l.createdAt))}</td>
          <td class="lk-acts">
            <button class="mini-btn" data-act="copy">复制</button>
            <button class="mini-btn" data-act="edit">编辑</button>
            <button class="mini-btn danger" data-act="del">删除</button>
          </td>
        </tr>`;
      }).join('')}
    </tbody></table>`;

  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const l = linksCache.find((x) => x.id === tr.dataset.id);
    if (!l) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'copy') copyUrl(l);
        else if (act === 'edit') openEditDialog(l);
        else if (act === 'del') removeLink(l);
      };
    });
  });
}

async function copyUrl(l) {
  const url = location.origin + '/s/' + l.id;
  try {
    await navigator.clipboard.writeText(url);
    toast('链接已复制到剪贴板', { type: 'success' });
  } catch (e) {
    openModal({
      title: '分享链接', body: `<textarea readonly style="width:100%;height:84px;border:1px solid var(--border-strong);border-radius:6px;padding:8px;font-size:12px;resize:none">${escapeHtml(url)}</textarea>`,
      foot: [{ text: '关闭' }],
    });
  }
}

async function removeLink(l) {
  const ok = await confirmDialog({ allowHtml: true,
    title: '删除分享链接',
    message: `确定删除 <b>${escapeHtml(l.fileName || l.key)}</b> 的分享链接吗？<br><span style="color:var(--text-2)">仅删除本地分享记录，<b>不会删除云端文件</b>；已送达访问者的链接将立即失效。</span>`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteLink(l.id);
    toast('链接已删除', { type: 'success' });
    refresh();
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error' });
  }
}

/** 编辑链接：有效期 / 次数 / 密码 / 重置计数 */
function openEditDialog(l) {
  const remainH = l.expiresAt ? Math.max(0, (new Date(l.expiresAt).getTime() - Date.now()) / 3600000) : null;
  const keepLabel = remainH === null ? '保持当前（永久有效）' : `保持当前（剩余 ${remainH >= 48 ? (remainH / 24).toFixed(1) + ' 天' : remainH.toFixed(1) + ' 小时'}）`;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item"><label>文件</label>
      <div class="hint" style="word-break:break-all">${escapeHtml(l.bucket)}/${escapeHtml(l.key)}</div>
      ${l.missing ? '<div class="hint" style="color:var(--danger)">该文件已被删除，此链接当前无法下载。若把同名文件重新上传到同一位置，链接会自动恢复。</div>' : ''}
      <div class="hint">已下载 ${l.downloads} 次${l.lastDownloadAt ? '，最近 ' + escapeHtml(fmtTime(l.lastDownloadAt)) : ''}</div></div>
    <div class="form-item"><label>链接有效时间</label>
      <select id="le-expires" class="full">
        <option value="keep" selected>${escapeHtml(keepLabel)}</option>
        <option value="1">重新计为 1 小时</option>
        <option value="24">重新计为 1 天</option>
        <option value="168">重新计为 7 天</option>
        <option value="720">重新计为 30 天</option>
        <option value="0">改为永久有效</option>
      </select></div>
    <div class="form-item"><label>可下载次数</label>
      <input id="le-count" type="number" min="0" step="1" value="${l.maxDownloads}" placeholder="0">
      <div class="hint">0 表示不限制；修改为小于已下载次数将立即关闭链接。</div></div>
    <div class="form-item"><label>访问密码</label>
      <label class="check-line"><input id="le-pw-on" type="checkbox" ${l.hasPassword ? 'checked' : ''}>${l.hasPassword ? '保持密码保护' : '启用密码保护'}</label>
      <input id="le-pw" type="text" maxlength="64" placeholder="${l.hasPassword ? '留空保持原密码不变' : '请输入访问密码'}" ${l.hasPassword ? '' : 'disabled'} autocomplete="off">
      <div class="hint">${l.hasPassword ? '取消勾选将清除密码保护；输入新密码将替换原密码。' : '启用后，访问者需输入正确密码方可下载。'}</div></div>
    <div class="form-item"><label>付费下载</label>
      <label class="check-line"><input id="le-paid-on" type="checkbox" ${l.paid && l.paid.required ? 'checked' : ''}>  需要付费后才能下载</label>
      <div id="le-paid-row" style="display:${l.paid && l.paid.required ? '' : 'none'};margin-top:8px">
        <input id="le-paid-amount" type="number" min="0.01" step="0.01" value="${l.paid && l.paid.amountFen ? (l.paid.amountFen / 100).toFixed(2) : '1.00'}" placeholder="1.00">
        <div class="hint">当前仅支持人民币（CNY），最低 <b>0.01</b> 元。取消勾选不会清空金额，重新勾选时保留。</div>
      </div></div>
    <div class="form-item"><label>下载计数</label>
      <label class="check-line"><input id="le-reset" type="checkbox">重置已下载次数为 0</label></div>`;

  const pwOn = wrap.querySelector('#le-pw-on');
  const pwInput = wrap.querySelector('#le-pw');
  pwOn.addEventListener('change', () => { pwInput.disabled = !pwOn.checked; if (pwOn.checked) pwInput.focus(); });
  const paidOn = wrap.querySelector('#le-paid-on');
  const paidRow = wrap.querySelector('#le-paid-row');
  const paidAmount = wrap.querySelector('#le-paid-amount');
  paidOn.addEventListener('change', () => {
    paidRow.style.display = paidOn.checked ? '' : 'none';
    if (paidOn.checked) paidAmount.focus();
  });

  openModal({
    title: '编辑分享链接', body: wrap,
    foot: [
      { text: '取消' },
      { text: '保存', cls: 'primary', onClick: async (o, close) => {
        const body = {};
        const ev = wrap.querySelector('#le-expires').value;
        if (ev !== 'keep') body.expiresHours = Number(ev) || null;
        const cnt = wrap.querySelector('#le-count').value.trim();
        if (cnt !== '') {
          const n = Number(cnt);
          if (!Number.isInteger(n) || n < 0) return toast('可下载次数必须是不小于 0 的整数（0 表示不限制）', { type: 'error' });
          body.maxDownloads = n;
        }
        if (!pwOn.checked) {
          body.password = null; // 清除密码
        } else if (pwInput.value) {
          if (pwInput.value.length > 64) return toast('密码长度不能超过 64 个字符', { type: 'error' });
          body.password = pwInput.value; // 替换密码
        } // 勾选且留空：保持原密码，不传字段
        if (wrap.querySelector('#le-reset').checked) body.resetCount = true;
        // 付费配置：勾选时金额最低 0.01 元；未勾选时金额一并提交以便保留
        if (paidOn.checked) {
          const amount = Number(paidAmount.value);
          if (!Number.isFinite(amount) || amount < 0.01) return toast('付费金额最低 0.01 元', { type: 'error' });
          body.paid = { required: true, amount };
        } else if (l.paid && l.paid.amountFen) {
          body.paid = { required: false, amount: l.paid.amountFen / 100 };
        }
        try {
          const r = await API.updateLink(l.id, body);
          toast('链接已更新', { type: 'success' });
          close();
          refresh();
          if (r && r.warn) toast(r.warn, { type: 'warn', duration: 6000 });
        } catch (e) {
          toast('保存失败：' + e.message, { type: 'error' });
        }
      } },
    ],
  });
}
