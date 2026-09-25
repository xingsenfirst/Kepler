/** 存储桶管理页 —— 添加 / 清空文件 / 碎片清理 / 彻底删除 / 存储统计 / IP 访问屏蔽 */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, fmtSize, fmtTime } from './util.js';
import { App } from './main.js';
import { providerMeta } from './provider-logos.js';

let wired = false;
let timer = null;
let cache = []; // [{ id, bucket, region, remark, quotaBytes, active, stats, error }]
let ipCache = null; // { rules, chinaRangeCount, methods }

/* ------------------------- 自动刷新时间（自定义） ------------------------- */

// 可选项：5 秒 / 30 秒 / 1 分钟 / 5 分钟 / 从不（0）
const INTERVAL_KEY = 'bucketmgr.autoRefreshMs';
const DEFAULT_INTERVAL_MS = 60000; // 默认 1 分钟
const INTERVAL_OPTIONS = {
  5000: '5 秒',
  30000: '30 秒',
  60000: '1 分钟',
  300000: '5 分钟',
  0: '从不',
};

/** 读取持久化的刷新间隔（非法值回退默认） */
function loadInterval() {
  const v = Number(localStorage.getItem(INTERVAL_KEY));
  return Object.prototype.hasOwnProperty.call(INTERVAL_OPTIONS, v) ? v : DEFAULT_INTERVAL_MS;
}

let refreshMs = loadInterval();

/** 应用新的自动刷新间隔：重置定时器并持久化 */
function applyInterval(ms) {
  refreshMs = ms;
  try { localStorage.setItem(INTERVAL_KEY, String(ms)); } catch (e) { /* ignore */ }
  if (timer) { clearInterval(timer); timer = null; }
  if (ms > 0) {
    timer = setInterval(() => {
      const sec = document.getElementById('bucketmgr');
      if (sec && !sec.hidden) refresh();
    }, ms);
  }
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 请求序号 —— PERF-04：桶统计较慢，自动刷新定时器与手动刷新/操作后刷新会并发，
 * 慢的旧响应后到会把新结果覆盖掉。自增序号后只认「最后一次发起」的响应。
 */
let statsSeq = 0;

export function refresh() {
  wire();
  const box = document.getElementById('bucketmgr-table');
  if (!box) return;
  if (!timer && refreshMs > 0) {
    timer = setInterval(() => {
      const sec = document.getElementById('bucketmgr');
      if (sec && !sec.hidden) refresh();
    }, refreshMs);
  }
  const seq = ++statsSeq;
  box.innerHTML = '<div class="lk-empty">正在加载存储桶统计数据…</div>';
  API.bucketStats().then((r) => {
    if (seq !== statsSeq) return; // 已有更新的刷新：丢弃本次响应
    cache = r.buckets || [];
    render();
  }).catch((e) => {
    if (seq !== statsSeq) return;
    box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
  });
  refreshIpGuard();
}

function wire() {
  if (wired) return;
  wired = true;
  const rf = document.getElementById('btn-buckets-refresh');
  if (rf) rf.onclick = () => refresh();
  // 自动刷新时间下拉框
  const itv = document.getElementById('bucketmgr-interval');
  if (itv) {
    itv.value = String(refreshMs);
    itv.onchange = () => {
      const ms = Number(itv.value);
      applyInterval(ms);
      toast(ms > 0 ? `自动刷新时间已设为每 ${INTERVAL_OPTIONS[ms]}` : '已关闭自动刷新（可随时点击「刷新」手动更新）', { type: 'success' });
    };
  }
  const add = document.getElementById('btn-buckets-add');
  if (add) {
    add.onclick = () => {
      if (!App.state.config || !App.state.config.configured) {
        toast('请先在“系统设置”中配置访问密钥', { type: 'warn' });
        return;
      }
      App.openBucketDialog(null);
    };
  }
  // 添加/编辑/删除桶后（含设置页、侧栏）同步刷新本页
  window.addEventListener('buckets-changed', () => {
    const sec = document.getElementById('bucketmgr');
    if (sec && !sec.hidden) refresh();
  });
  // IP 屏蔽
  const rfIp = document.getElementById('btn-ipguard-refresh');
  if (rfIp) rfIp.onclick = () => refreshIpGuard();
  const addIp = document.getElementById('btn-ipguard-add');
  if (addIp) addIp.onclick = () => openIpRuleDialog(null);
  const testBtn = document.getElementById('btn-ipguard-test');
  if (testBtn) testBtn.onclick = testIpBlocked;
}

/* ------------------------------ 渲染 ------------------------------ */

function statText(v) { return (v === null || v === undefined) ? '—' : fmtSize(v); }

function render() {
  const box = document.getElementById('bucketmgr-table');
  const head = document.getElementById('bucketmgr-count');
  if (!box) return;
  if (head) head.textContent = cache.length ? `（共 ${cache.length} 个）` : '';
  if (!cache.length) {
    // 普通用户不自行添加桶：可见桶由管理员开放，一个都没有时只能联系管理员
    box.innerHTML = `<div class="lk-empty">${isAdmin()
      ? '还没有绑定存储桶。点击右上角“添加存储桶”，或从云端获取桶列表后选择添加。'
      : '管理员尚未为你开放任何存储桶，请联系管理员在「存储桶可见性权限」中开放。'}</div>`;
    return;
  }
  box.innerHTML = `<table class="lk-table bm-table">
    <thead><tr>
      <th>服务商</th><th>存储桶</th><th>地域</th><th>已用容量</th><th>累计上传</th><th>累计下载</th><th>请求数</th><th>碎片</th>
      ${isAdmin() ? '<th style="width:90px">屏蔽海外 IP</th>' : ''}
      ${isAdmin() ? '<th style="width:320px">操作</th>' : ''}
    </tr></thead>
    <tbody>
      ${cache.map((row) => {
        const st = row.stats || {};
        const frag = st.fragmentCount;
        const fragCell = frag === null || frag === undefined ? '—'
          : frag < 0 ? '<span class="bm-sub-bad">查询失败</span>'
          : frag === 0 ? '0'
          : `<span class="lk-badge warn">${frag} 个</span>`;
        // 停用保护：仅剩最后一个启用桶时禁止停用（服务端同样强制校验）
        const disabled = row.enabled === false;
        const enabledCount = cache.filter((x) => x.enabled !== false).length;
        const disBlocked = !disabled && enabledCount <= 1;
        const toggleBtn = isAdmin() ? `<button class="mini-btn" data-act="${disabled ? 'en' : 'dis'}"
          ${disBlocked ? 'disabled title="仅剩一个存储桶时不能停用，请直接解绑。"' : ''}>${disabled ? '启用' : '停用'}</button>` : '';
        const overseaChecked = row.blockOverseasIP === true;
        const overseaCell = isAdmin()
          ? `<label class="check-line" title="开启后，访问该桶时仅中国大陆 / 内网 IP 可放行"><input type="checkbox" data-act="block-overseas"${overseaChecked ? ' checked' : ''} ${disabled ? 'disabled' : ''}></label>`
          : `<span class="lk-badge ${overseaChecked ? 'warn' : ''}">${overseaChecked ? '已开启' : '—'}</span>`;
        const provId = row.provider || 'tencent';
        const prov = providerMeta(provId);
        return `<tr data-id="${escapeHtml(row.id)}"${disabled ? ' class="row-disabled"' : ''}>
          <td class="lk-provider" title="${escapeHtml(prov.name)}">${escapeHtml(prov.name)}<i class="bk-sub">${escapeHtml(prov.shortName)}</i></td>
          <td class="lk-file" title="${escapeHtml(row.bucket)}">
            ${escapeHtml(row.remark || row.bucket)}${row.remark ? `<i class="bk-sub">（${escapeHtml(row.bucket)}）</i>` : ''}
            ${row.active ? '<span class="lk-badge ok">当前</span>' : ''}
            ${disabled ? '<span class="lk-badge warn">已停用</span>' : ''}
            ${row.error ? `<div class="bm-sub-bad" title="${escapeHtml(row.error)}">统计不可用：${escapeHtml(row.error)}</div>` : ''}
          </td>
          <td>${escapeHtml(row.region)}</td>
          <td title="${st.objectCount != null ? st.objectCount + ' 个对象' : ''}">${statText(st.sizeBytes)}${st.estimated ? '<i class="bk-sub">（估算，超5000对象）</i>' : ''}${row.statError ? '<i class="bk-sub">（容量查询失败）</i>' : ''}</td>
          <td>↑ ${statText(st.upBytes)}</td>
          <td>↓ ${statText(st.downBytes)}</td>
          <td>${st.requests != null ? String(st.requests) : '—'}</td>
          <td>${fragCell}</td>
          ${isAdmin() ? `<td class="bm-oversea-cell">${overseaCell}</td>` : ''}
          ${isAdmin() ? `<td class="lk-acts">
            ${toggleBtn}
            <button class="mini-btn" data-act="perm">编辑权限</button><button class="mini-btn" data-act="clear">清空文件</button><button class="mini-btn" data-act="frag">清理碎片</button><button class="mini-btn danger" data-act="destroy">彻底删除</button>
            <button class="mini-btn" data-act="unbind" title="仅移除本地绑定记录，不删除云端存储桶">解绑</button>
          </td>` : ''}
        </tr>`;
      }).join('')}
    </tbody></table>`;

  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const row = cache.find((x) => x.id === tr.dataset.id);
    if (!row) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'clear') confirmClear(row);
        else if (act === 'frag') confirmClearFragments(row);
        else if (act === 'destroy') confirmDestroy(row);
        else if (act === 'unbind') unbind(row);
        else if (act === 'perm') openVisibilityDialog(row);
        else if (act === 'en') toggleBucketEnabled(row, true);
        else if (act === 'dis') toggleBucketEnabled(row, false);
        else if (act === 'block-overseas') toggleBlockOverseas(row, btn.checked);
      };
    });
  });
}

/** 切换某桶的「屏蔽海外 IP」开关（仅管理员） */
async function toggleBlockOverseas(row, want) {
  try {
    const r = await API.setBucketBlockOverseas(row.id, want);
    toast(want
      ? `已为「${row.remark || row.bucket}」开启屏蔽海外 IP（白名单 ${r.chinaRangeCount || ''} 段）`
      : `已为「${row.remark || row.bucket}」关闭屏蔽海外 IP`, { type: 'success' });
    // 就地更新 cache 避免全量刷新
    row.blockOverseasIP = want;
  } catch (e) {
    toast('设置失败：' + e.message, { type: 'error' });
    // 复原 checkbox
    refresh();
  }
}

/** 启用/停用存储桶（仅管理员；停用时自动设为对普通用户不可见，服务端强制至少保留一个启用桶） */
async function toggleBucketEnabled(row, want) {
  const label = want ? '启用' : '停用';
  const ok = await confirmDialog({ allowHtml: true,
    title: `${label}存储桶`,
    message: want
      ? `确定<b>启用</b>存储桶「${escapeHtml(row.remark || row.bucket)}」吗？<br><span style="color:var(--text-2)">启用后该桶可被切换为当前存储桶使用。</span>`
      : `确定<b>停用</b>存储桶「${escapeHtml(row.remark || row.bucket)}」吗？<br><span style="color:var(--text-2)">停用后该桶将<b>自动设为「对普通用户不可见」</b>，且无法被切换为当前存储桶。</span>`,
    okText: label, danger: !want,
  });
  if (!ok) return;
  try {
    await API.toggleBucketEnabled(row.id, want);
    toast(`存储桶已${label}${!want ? '，同时设为对普通用户不可见' : ''}`, { type: 'success' });
    window.dispatchEvent(new CustomEvent('buckets-changed')); // 同步侧边栏/设置页，并触发本页刷新
  } catch (e) {
    toast(`${label}失败：` + e.message, { type: 'error' });
  }
}

/** 当前登录用户是否为管理员（权限按钮仅管理员可见） */
function isAdmin() {
  return !!(App.state.user && App.state.user.role === 'admin');
}

/* ------------------------------ 通用：手输桶名确认弹窗 ------------------------------ */

/**
 * 打开"输入完整存储桶名称"确认弹窗
 * @returns {Promise<string|null>} 输入值（与桶名完全一致时 resolve），取消 resolve(null)
 */
function openNameConfirm({ title, html, bucket }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      ${html}
      <div class="form-item" style="margin-top:14px">
        <label>请输入完整的存储桶名称以确认操作：</label>
        <div class="bm-name-code" title="点击复制">${escapeHtml(bucket)}</div>
        <input type="text" id="bm-confirm-name" class="full" placeholder="输入存储桶名称（须完全一致）" autocomplete="off" spellcheck="false">
        <div class="hint" id="bm-confirm-hint">名称必须与上方显示完全一致（含 APPID 后缀），方可执行。</div>
      </div>`;
    const code = wrap.querySelector('.bm-name-code');
    code.onclick = async () => {
      try { await navigator.clipboard.writeText(bucket); toast('桶名已复制', { type: 'success' }); } catch (e) { /* ignore */ }
    };
    const input = wrap.querySelector('#bm-confirm-name');
    const hint = wrap.querySelector('#bm-confirm-hint');
    input.addEventListener('input', () => {
      if (input.value === bucket) {
        hint.textContent = '✓ 名称已匹配，可以执行操作。';
        hint.style.color = '#16a34a';
      } else {
        hint.textContent = '名称必须与上方显示完全一致（含 APPID 后缀），方可执行。';
        hint.style.color = '';
      }
    });
    openModal({
      title, body: wrap,
      foot: [
        { text: '取消', onClick: (o, close) => { close(); resolve(null); } },
        { text: '确认执行', cls: 'danger', onClick: (o, close) => {
          if (input.value !== bucket) {
            toast('输入的存储桶名称不匹配，操作已取消', { type: 'error' });
            return;
          }
          close();
          resolve(input.value);
        } },
      ],
    });
    setTimeout(() => input.focus(), 50);
  });
}

function afterBucketMutated(row) {
  window.dispatchEvent(new CustomEvent('buckets-changed'));
  if (row.active) { App.refreshStorage(); App.refresh(); }
}

/* ------------------------------ 通用穿梭框组件 ------------------------------ */

/**
 * 通用穿梭框（左列 = 未选集合，右列 = 已选集合）。
 * 供「存储桶可见性权限」与「IP 屏蔽规则 · 作用范围」复用，保证交互一致。
 * @param {object} o
 *  - items: [{ id, label, sub?, active? }]
 *  - selectedIds: 初始选中 id 数组
 *  - leftTitle / rightTitle: 列标题（可含徽标 HTML）
 *  - filterLabels: { all, left, right } 筛选按钮文案
 *  - hint: 顶部提示（HTML，可空）
 *  - countText: (total, selCount) => string 底部计数文案
 * @returns {{ wrap: HTMLElement, getSelected: () => string[] }}
 */
function buildTransferBox(o) {
  const items = o.items || [];
  const selected = new Set(o.selectedIds || []);
  const fl = o.filterLabels || { all: '全部', left: '未选', right: '已选' };
  // 安全默认：标题/hint 按纯文本转义渲染；仅显式传 *Html 才按可信 HTML 处理。
  // （历史实现为原始 HTML 拼接，若将来传入桶名/备注等用户可控数据即成 XSS 注入点）
  const hintHtml = o.hintHtml !== undefined ? String(o.hintHtml) : escapeHtml(o.hint || '');
  const leftTitleHtml = o.leftTitleHtml !== undefined ? String(o.leftTitleHtml) : escapeHtml(o.leftTitle || '');
  const rightTitleHtml = o.rightTitleHtml !== undefined ? String(o.rightTitleHtml) : escapeHtml(o.rightTitle || '');
  const wrap = document.createElement('div');
  wrap.className = 'perm-transfer';
  wrap.innerHTML = `
    <div class="perm-toolbar">
      <div class="perm-search">
        <input type="text" class="perm-q" placeholder="搜索…" autocomplete="off" spellcheck="false">
      </div>
      <div class="perm-filter seg">
        <button data-f="all" class="on">${escapeHtml(fl.all)}</button>
        <button data-f="left">${escapeHtml(fl.left)}</button>
        <button data-f="right">${escapeHtml(fl.right)}</button>
      </div>
    </div>
    ${hintHtml ? `<div class="perm-hint bk-sub">${hintHtml}</div>` : ''}
    <div class="perm-body">
      <div class="perm-col">
        <div class="perm-col-head">${leftTitleHtml}
          <label class="perm-checkall" title="勾选本列全部（受搜索/筛选影响）"><input type="checkbox" class="perm-check-left"> 全选</label>
        </div>
        <ul class="perm-list perm-list-left"></ul>
      </div>
      <div class="perm-switch">
        <button class="mini-btn" data-mv="right" title="将选中项移到右列">›</button>
        <button class="mini-btn" data-mv="all-right" title="全部移到右列">»</button>
        <button class="mini-btn" data-mv="left" title="将选中项移到左列">‹</button>
        <button class="mini-btn" data-mv="all-left" title="全部移到左列">«</button>
      </div>
      <div class="perm-col">
        <div class="perm-col-head">${rightTitleHtml}
          <label class="perm-checkall" title="勾选本列全部（受搜索/筛选影响）"><input type="checkbox" class="perm-check-right"> 全选</label>
        </div>
        <ul class="perm-list perm-list-right"></ul>
      </div>
    </div>
    <div class="perm-foot"><span class="bk-sub perm-count"></span></div>`;

  const q = wrap.querySelector('.perm-q');
  const filterBtns = wrap.querySelectorAll('.perm-filter button');
  const leftUl = wrap.querySelector('.perm-list-left');
  const rightUl = wrap.querySelector('.perm-list-right');
  const checkLeft = wrap.querySelector('.perm-check-left');
  const checkRight = wrap.querySelector('.perm-check-right');
  const countEl = wrap.querySelector('.perm-count');
  let filter = 'all'; // all | left | right

  const itemLabel = (b) => (b.sub && b.sub !== b.label ? `${b.label}（${b.sub}）` : b.label);

  function matches(b) {
    const kw = q.value.trim().toLowerCase();
    if (kw && !itemLabel(b).toLowerCase().includes(kw)) return false;
    if (filter === 'left' && selected.has(b.id)) return false;
    if (filter === 'right' && !selected.has(b.id)) return false;
    return true;
  }

  function renderItem(b) {
    const li = document.createElement('li');
    li.className = 'perm-item';
    li.dataset.id = b.id;
    li.innerHTML = `
      <input type="checkbox">
      <span class="perm-itembody">
        <b>${escapeHtml(b.label)}${b.active ? '<span class="perm-active" title="当前激活桶">当前</span>' : ''}</b>
        <i class="bk-sub">${escapeHtml(b.sub || '')}</i>
      </span>`;
    li.querySelector('input').onchange = (e) => li.classList.toggle('checked', e.target.checked);
    return li;
  }

  function render() {
    leftUl.innerHTML = '';
    rightUl.innerHTML = '';
    for (const b of items.filter(matches)) {
      (selected.has(b.id) ? rightUl : leftUl).appendChild(renderItem(b));
    }
    checkLeft.checked = false;
    checkRight.checked = false;
    countEl.textContent = o.countText(items.length, selected.size);
  }

  const checkedIds = (ul) => [...ul.querySelectorAll('.perm-item.checked')].map((li) => li.dataset.id);
  const setCheckedAll = (ul, checked) => ul.querySelectorAll('.perm-item').forEach((li) => {
    li.classList.toggle('checked', checked);
    const cb = li.querySelector('input');
    if (cb) cb.checked = checked;
  });
  const moveTo = (ids, side) => {
    ids.forEach((id) => (side === 'right' ? selected.add(id) : selected.delete(id)));
    render();
  };

  q.addEventListener('input', render);
  filterBtns.forEach((btn) => {
    btn.onclick = () => {
      filterBtns.forEach((x) => x.classList.remove('on'));
      btn.classList.add('on');
      filter = btn.dataset.f;
      render();
    };
  });
  wrap.querySelector('[data-mv="right"]').onclick = () => moveTo(checkedIds(leftUl), 'right');
  wrap.querySelector('[data-mv="all-right"]').onclick = () => moveTo([...leftUl.querySelectorAll('.perm-item')].map((li) => li.dataset.id), 'right');
  wrap.querySelector('[data-mv="left"]').onclick = () => moveTo(checkedIds(rightUl), 'left');
  wrap.querySelector('[data-mv="all-left"]').onclick = () => moveTo([...rightUl.querySelectorAll('.perm-item')].map((li) => li.dataset.id), 'left');
  checkLeft.onchange = (e) => setCheckedAll(leftUl, e.target.checked);
  checkRight.onchange = (e) => setCheckedAll(rightUl, e.target.checked);

  render();
  return { wrap, getSelected: () => [...selected] };
}

/**
 * 打开"存储桶可见性"配置弹窗（buildTransferBox 复用）：
 *  右列 = 对普通用户可见的桶；点「保存」才提交（PUT /buckets/visibility），取消/关闭丢弃改动。
 */
async function openVisibilityDialog(_row) {
  let buckets;
  let activeBucketId = '';
  try {
    const r = await API.localBuckets();
    buckets = r.buckets || [];
    activeBucketId = r.activeBucketId || '';
  } catch (e) {
    return toast('加载存储桶列表失败：' + e.message, { type: 'error' });
  }
  if (!buckets.length) return toast('尚无存储桶，请先添加', { type: 'info' });

  const { wrap, getSelected } = buildTransferBox({
    items: buckets.map((b) => ({ id: b.id, label: b.remark || b.bucket, sub: b.remark ? b.bucket : b.region, active: b.id === activeBucketId })),
    selectedIds: buckets.filter((b) => b.visibleToUsers !== false).map((b) => b.id),
    leftTitleHtml: '对普通用户<span class="perm-badge off">不可见</span>',
    rightTitleHtml: '对普通用户<span class="perm-badge on">可见</span>',
    filterLabels: { all: '全部', left: '不可见', right: '可见' },
    hintHtml: '把存储桶移动到右侧，表示<b>普通用户可以查看</b>该桶；管理员始终可见全部桶。',
    countText: (total, sel) => `共 ${total} 个桶，其中 ${sel} 个对普通用户可见`,
  });
  const q = wrap.querySelector('.perm-q');

  openModal({
    title: '存储桶可见性权限',
    body: wrap,
    wide: true,
    foot: [
      { text: '取消', onClick: (o, close) => close() }, // 丢弃改动
      {
        text: '保存权限', cls: 'primary',
        onClick: async (o, close) => {
          const saveBtn = o.querySelector('.dialog-foot .btn.primary');
          if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }
          try {
            await API.saveBucketVisibility(getSelected());
            toast(`已保存：${getSelected().length} 个桶对普通用户可见`, { type: 'success' });
            close();
            refresh();
          } catch (e) {
            toast('保存失败：' + e.message, { type: 'error', duration: 6000 });
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存权限'; }
          }
        },
      },
    ],
  });
  setTimeout(() => q.focus(), 50);
}

/* ------------------------------ 清空全部文件 ------------------------------ */

async function confirmClear(row) {
  const st = row.stats || {};
  const sizeNote = st.sizeBytes != null ? `（当前约 ${fmtSize(st.sizeBytes)}${st.objectCount != null ? '，' + st.objectCount + ' 个对象' : ''}）` : '';
  const name = await openNameConfirm({
    title: '⚠️ 清空存储桶全部文件',
    bucket: row.bucket,
    html: `
      <div class="bm-warn-text">即将删除存储桶 <b>${escapeHtml(row.remark || row.bucket)}</b>（${escapeHtml(row.region)}）中的 <b>全部文件</b>${sizeNote}。</div>
      <div class="bm-warn-text bm-strong">此操作不可恢复，删除后无法找回。云端存储桶本身不会被删除。</div>`,
  });
  if (!name) return;
  toast('正在清空存储桶，文件较多时可能需要一些时间…', { type: 'info', duration: 5000 });
  try {
    const r = await API.clearBucket(row.id, name);
    toast(`已清空：删除 ${r.deleted} 个对象，释放 ${fmtSize(r.bytes)}`, { type: 'success' });
    afterBucketMutated(row);
  } catch (e) {
    toast('清空失败：' + e.message, { type: 'error', duration: 6000 });
  }
}

/* ------------------------------ 清空文件碎片 ------------------------------ */

async function confirmClearFragments(row) {
  let list;
  try {
    list = await API.bucketFragments(row.id);
  } catch (e) {
    return toast('查询碎片失败：' + e.message, { type: 'error' });
  }
  const frags = list.fragments || [];
  if (!frags.length) return toast('该存储桶没有未完成的分片上传碎片', { type: 'info' });
  const preview = frags.slice(0, 5).map((f) =>
    `<tr><td class="lk-file">${escapeHtml(f.key)}</td><td>${escapeHtml(f.initiated ? fmtTime(f.initiated) : '—')}</td></tr>`).join('');
  const ok = await confirmDialog({ allowHtml: true,
    title: '清空文件碎片',
    message: `存储桶 <b>${escapeHtml(row.remark || row.bucket)}</b> 有 <b>${frags.length}</b> 个未完成的分片上传任务，碎片会持续占用存储空间。
      <table class="bm-frag-table"><tbody>${preview}${frags.length > 5 ? `<tr><td colspan="2" class="bk-sub">… 以及其余 ${frags.length - 5} 个任务</td></tr>` : ''}</tbody></table>
      确定中止并清除这些碎片吗？<span style="color:var(--text-2)">此操作不影响已上传完成的文件。</span>`,
    okText: '清除碎片', danger: true,
  });
  if (!ok) return;
  try {
    const r = await API.clearFragments(row.id);
    toast(`已清除 ${r.aborted} 个分片上传任务（${r.aborted < frags.length ? `另 ${frags.length - r.aborted} 个失败` : '全部成功'}）`, { type: 'success' });
    refresh();
  } catch (e) {
    toast('清空碎片失败：' + e.message, { type: 'error' });
  }
}

/* ------------------------------ 彻底删除存储桶 ------------------------------ */

async function confirmDestroy(row) {
  // 先实时检查删除条件
  let check;
  try {
    check = await API.destroyCheck(row.id);
  } catch (e) {
    return toast('无法检查删除条件：' + e.message, { type: 'error' });
  }
  const cond1 = check.objectCount === 0;
  const cond2 = check.fragmentCount === 0;
  const cond1Text = cond1
    ? '✓ 桶内文件已清空'
    : `✗ 桶内仍有 ${check.objectCount}${check.objectCountCapped ? '+' : ''} 个对象，请先「清空文件」`;
  const cond2Text = cond2
    ? '✓ 无未完成的分片上传（碎片）'
    : (check.fragmentCount < 0 ? '✗ 碎片查询失败，请重试' : `✗ 存在 ${check.fragmentCount} 个碎片任务，请先「清理碎片」`);
  const condOk = cond1 && cond2;

  const name = await openNameConfirm({
    title: '🗑️ 彻底删除存储桶',
    bucket: row.bucket,
    html: `
      <div class="bm-warn-text">即将 <b>彻底删除</b>存储桶 <b>${escapeHtml(row.remark || row.bucket)}</b>（${escapeHtml(row.region)}）。</div>
      <ul class="bm-cond-list">
        <li class="${cond1 ? 'ok' : 'bad'}">${cond1Text}</li>
        <li class="${cond2 ? 'ok' : 'bad'}">${cond2Text}</li>
      </ul>
      ${condOk
        ? '<div class="bm-warn-text bm-strong">这将会直接从 IDC 服务商层面删除，全部配置将不可恢复，本地绑定记录与统计数据也将一并移除。</div>'
        : '<div class="bm-warn-text bm-strong">当前不满足删除条件，请先完成上述操作后再回来执行删除。（输入名称也无法通过服务端校验）</div>'}`,
  });
  if (!name) return;
  try {
    await API.destroyBucket(row.id, name);
    toast(`存储桶 ${row.bucket} 已彻底删除`, { type: 'success' });
    App.onConfigChanged(); // 重新加载配置 / 目录树 / 文件列表（内部触发 buckets-changed → 本页刷新）
  } catch (e) {
    toast('删除失败：' + e.message, { type: 'error', duration: 6000 });
    refresh();
  }
}

/* ------------------------------ 解绑（仅本地） ------------------------------ */

async function unbind(row) {
  const ok = await confirmDialog({ allowHtml: true,
    title: '解除绑定',
    message: `确定将存储桶 <b>${escapeHtml(row.remark || row.bucket)}</b> 从本地列表移除吗？<br><span style="color:var(--text-2)">仅移除本地绑定记录，<b>不会删除云端存储桶及其数据</b>。彻底删除请使用「彻底删除」。</span>`,
    okText: '解绑', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteBucket(row.id);
    toast('已解除本地绑定', { type: 'success' });
    App.onConfigChanged(); // 内部触发 buckets-changed → 本页刷新
  } catch (e) {
    toast('解绑失败：' + e.message, { type: 'error' });
  }
}

/* ============================== IP 访问屏蔽 ============================== */

/** 本地已绑定存储桶列表（用于作用范围下拉框） */
function boundBuckets() {
  return (App.state.config && App.state.config.buckets) || [];
}

/** 生成存储桶 <option> 列表 */
function bucketOptionsHtml(selectedId) {
  return boundBuckets().map((b) =>
    `<option value="${escapeHtml(b.id)}" ${b.id === selectedId ? 'selected' : ''}>${escapeHtml(b.remark || b.bucket)}${b.remark ? `（${escapeHtml(b.bucket)}）` : ''}</option>`).join('');
}

/** 规则作用范围列的展示（多桶） */
function scopeCell(r) {
  const bids = r.bucketIds || [];
  if (!bids.length) return '<span class="lk-badge">全局</span>';
  const names = (r.bucketNames && r.bucketNames.length) ? r.bucketNames : bids;
  const shown = names.length > 2 ? `${names.slice(0, 2).join('、')} 等 ${names.length} 个桶` : names.join('、');
  const badge = r.bucketMissing ? '<span class="lk-badge warn">桶级 · 含已解绑</span>' : '<span class="lk-badge ok">桶级</span>';
  return `${badge} <span title="${escapeHtml(names.join('、'))}">${escapeHtml(shown)}</span>`;
}

/** 重建预检行的作用范围下拉（保留当前选中） */
function rebuildTestScope() {
  const sel = document.getElementById('ipguard-test-scope');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = `<option value="">全局（无桶上下文）</option><option value="active">当前激活桶</option>${bucketOptionsHtml('')}`;
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}

async function refreshIpGuard() {
  const box = document.getElementById('ipguard-table');
  if (!box) return;
  // 规则接口为管理员专属：卡片已隐藏时既不渲染也不发请求（与"界面不展示"保持一致）
  const card = document.getElementById('ipguard-card');
  if (card && card.hidden) return;
  rebuildTestScope();
  let d;
  try {
    d = await API.ipGuard();
  } catch (e) {
    box.innerHTML = `<div class="lk-empty">IP 屏蔽规则加载失败：${escapeHtml(e.message)}</div>`;
    return;
  }
  ipCache = d;
  const count = document.getElementById('ipguard-count');
  if (count) count.textContent = d.rules.length ? `（${d.rules.length} 条规则）` : '';

  if (!d.rules.length) {
    box.innerHTML = `<div class="lk-empty">尚无屏蔽规则。点击右上角「＋ 添加屏蔽规则」。按桶屏蔽海外 IP 请在上方「存储桶管理」表格中勾选对应列。</div>`;
    return;
  }
  box.innerHTML = `<table class="lk-table ipg-table">
    <thead><tr>
      <th>IP / IP 段</th><th>作用范围</th><th>请求方法</th><th>备注</th><th>状态</th><th>命中</th><th>创建时间</th><th style="width:190px">操作</th>
    </tr></thead>
    <tbody>
      ${d.rules.map((r) => `<tr data-id="${escapeHtml(r.id)}">
        <td class="lk-file" style="font-family:Consolas,monospace">${escapeHtml(r.target)}</td>
        <td>${scopeCell(r)}</td>
        <td>${r.methods && r.methods.length ? r.methods.map((m) => `<span class="ipg-method${['PUT', 'POST', 'DELETE'].includes(m) ? ' m-write' : ''}">${m}</span>`).join(' ') : '<span class="bk-sub">全部方法</span>'}</td>
        <td>${escapeHtml(r.remark || '')}</td>
        <td>${r.enabled ? '<span class="lk-badge ok">生效中</span>' : '<span class="lk-badge">已禁用</span>'}</td>
        <td>${r.hits || 0}</td>
        <td>${r.createdAt ? fmtTime(r.createdAt) : '—'}</td>
        <td class="lk-acts">
          <button class="mini-btn" data-act="toggle">${r.enabled ? '禁用' : '启用'}</button>
          <button class="mini-btn" data-act="edit">编辑</button>
          <button class="mini-btn danger" data-act="del">删除</button>
        </td>
      </tr>`).join('')}
    </tbody></table>`;

  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const rule = d.rules.find((x) => x.id === tr.dataset.id);
    if (!rule) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'toggle') toggleIpRule(rule);
        else if (act === 'edit') openIpRuleDialog(rule);
        else if (act === 'del') deleteIpRule(rule);
      };
    });
  });
}

async function toggleIpRule(rule) {
  try {
    await API.toggleIpRule(rule.id, !rule.enabled);
    toast(`规则 ${rule.target} 已${rule.enabled ? '禁用' : '启用'}`, { type: 'success' });
    refreshIpGuard();
  } catch (e) { toast('操作失败：' + e.message, { type: 'error' }); }
}

async function deleteIpRule(rule) {
  const ok = await confirmDialog({ allowHtml: true,
    title: '删除屏蔽规则',
    message: `确定删除屏蔽规则 <b style="font-family:Consolas,monospace">${escapeHtml(rule.target)}</b> 吗？<br><span style="color:var(--text-2)">删除后该 IP / IP 段将不再被此规则屏蔽（若被桶级「屏蔽海外 IP」或其他规则覆盖则仍会被屏蔽）。</span>`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteIpRule(rule.id);
    toast('规则已删除', { type: 'success' });
    refreshIpGuard();
  } catch (e) { toast('删除失败：' + e.message, { type: 'error' }); }
}

/** 添加 / 编辑屏蔽规则弹窗（作用范围用穿梭框多选桶；右列留空 = 全局） */
function openIpRuleDialog(existing) {
  const methods = (existing && existing.methods) || [];
  const existingBids = (existing && existing.bucketIds) || [];
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item">
      <label>IP 地址或 IP 段（CIDR） *</label>
      <input type="text" id="ipg-target" class="full" placeholder="如 1.2.3.4（单个 IP）或 10.0.0.0/8（IP 段）" value="${escapeHtml(existing ? existing.target : '')}" autocomplete="off" spellcheck="false">
      <div class="hint">单 IP 示例：<code>203.0.113.7</code>；IP 段示例：<code>203.0.113.0/24</code>（屏蔽该段全部 256 个地址）。</div>
    </div>
    <div class="form-item">
      <label>作用范围 *</label>
      <div class="ipg-scope-box"></div>
      <div class="hint">右侧<b>留空 = 全局</b>（对该服务接收到的所有请求生效）；把桶移到右侧 = 仅当访问目标为这些桶时生效（可多选）。桶级规则优先、全局规则其次，任一命中即屏蔽。</div>
    </div>
    <div class="form-item">
      <label>屏蔽的请求方法（不勾选 = 屏蔽全部方法）</label>
      <div class="ipg-methods">
        ${['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].map((m) => `
          <label class="check-line"><input type="checkbox" value="${m}" ${methods.includes(m) ? 'checked' : ''}>${m}</label>`).join('')}
      </div>
      <div class="hint">例如仅勾选 PUT / POST / DELETE → 屏蔽该 IP 的写操作，但放行其读取与下载。</div>
    </div>
    <div class="form-item">
      <label>备注（可选）</label>
      <input type="text" id="ipg-remark" class="full" placeholder="如：恶意刷量来源" value="${escapeHtml(existing ? existing.remark || '' : '')}" maxlength="100">
    </div>`;

  // 穿梭框：候选 = 本地已绑定桶 +（编辑时）已解绑的幽灵项，避免静默丢弃引用
  const bound = boundBuckets();
  const activeId = (App.state.config && App.state.config.activeBucketId) || '';
  const boundIds = new Set(bound.map((b) => b.id));
  const items = bound.map((b) => ({ id: b.id, label: b.remark || b.bucket, sub: b.remark ? b.bucket : b.region, active: b.id === activeId }))
    .concat(existingBids.filter((id) => !boundIds.has(id)).map((id) => ({ id, label: '(已解绑的存储桶)', sub: '' })));
  const box = buildTransferBox({
    items,
    selectedIds: existingBids,
    leftTitle: '未选存储桶',
    rightTitle: '规则生效的存储桶',
    filterLabels: { all: '全部', left: '未选', right: '已选' },
    countText: (total, sel) => sel
      ? `共 ${total} 个桶，规则作用于 ${sel} 个`
      : `共 ${total} 个桶，当前为全局范围（作用于所有存储桶）`,
  });
  wrap.querySelector('.ipg-scope-box').appendChild(box.wrap);

  openModal({
    title: existing ? `编辑屏蔽规则 — ${existing.target}` : '添加 IP 屏蔽规则',
    body: wrap,
    wide: true,
    foot: [
      { text: '取消' },
      { text: existing ? '保存修改' : '添加规则', cls: 'primary', onClick: async (o, close) => {
        const target = wrap.querySelector('#ipg-target').value.trim();
        const remark = wrap.querySelector('#ipg-remark').value.trim();
        const bucketIds = box.getSelected();
        const sel = [...wrap.querySelectorAll('.ipg-methods input:checked')].map((x) => x.value);
        if (!target) return toast('请填写 IP 地址或 IP 段', { type: 'warn' });
        try {
          if (existing) await API.updateIpRule(existing.id, { target, remark, methods: sel, bucketIds });
          else await API.addIpRule({ target, remark, methods: sel, bucketIds });
          toast(existing ? '规则已更新' : '规则已添加并生效', { type: 'success' });
          close();
          refreshIpGuard();
        } catch (e) {
          toast('保存失败：' + e.message, { type: 'error' });
        }
      } },
    ],
  });
  setTimeout(() => wrap.querySelector('#ipg-target').focus(), 50);
}

/** 规则预检：检测某 IP + 方法 + 作用范围是否会被屏蔽 */
async function testIpBlocked() {
  const ipInput = document.getElementById('ipguard-test-ip');
  const methodSel = document.getElementById('ipguard-test-method');
  const scopeSel = document.getElementById('ipguard-test-scope');
  const out = document.getElementById('ipguard-test-result');
  const ip = (ipInput.value || '').trim();
  if (!ip) { out.textContent = '请输入 IP'; out.className = 'bk-sub'; return; }
  out.textContent = '检测中…'; out.className = 'bk-sub';
  try {
    const r = await API.testIpRule(ip, methodSel.value, scopeSel ? scopeSel.value : '');
    if (r.allowed) {
      out.textContent = `✓ ${ip}（${r.method}）未被屏蔽，可正常访问`;
      out.className = 'ipg-test-ok';
    } else if (r.reason === 'overseas') {
      out.textContent = `✗ ${ip}（${r.method}）为海外 IP，被「仅放行国内 IP」模式屏蔽`;
      out.className = 'ipg-test-bad';
    } else {
      const m = r.matchedRule;
      const scope = (m.bucketIds && m.bucketIds.length) ? '桶级规则' : '全局规则';
      out.textContent = `✗ ${ip}（${r.method}）被${scope}屏蔽：${m.target}${m.methods && m.methods.length ? '（' + m.methods.join('/') + '）' : ''}`;
      out.className = 'ipg-test-bad';
    }
  } catch (e) {
    out.textContent = '检测失败：' + e.message;
    out.className = 'ipg-test-bad';
  }
}
