/**
 * 存储桶管理页 —— 添加 / 清空文件 / 碎片清理 / 彻底删除 / 存储统计
 *
 * R37：「IP 访问屏蔽」卡片整体迁往独立的「IP 地址管理」页（`ipmgr.js`），
 * 本页只保留存储桶自身的「屏蔽海外 IP」开关列（那是**桶的属性**，不是 IP 规则）。
 */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, fmtSize, fmtTime, matchesQuery, previewMoreState } from './util.js';
import { openListDialog, providerSelectOptions, buildTransferBox } from './listdialog.js';
// R37：「限速」列（四张列表卡片共用的唯一实现点）
import { openSpeedLimitDialog, speedCellHtml } from './speedlimit.js';
import { App } from './main.js';
import { providerMeta } from './provider-logos.js';

let wired = false;
let timer = null;
let cache = []; // [{ id, bucket, region, remark, quotaBytes, active, stats, error }]

/**
 * 「存储桶管理」卡片列表的**预览条数上限**（R36 需求 2①）。
 * 只声明一次：卡片截断与「显示全部」的提示文案必须引用同一个数。
 */
const BUCKET_PREVIEW_LIMIT = 10;

/** 「全部存储桶」对话框的句柄（`null` = 未打开）；见 credmgr.js 的同类说明 */
let bucketsDialog = null;

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
  const all = document.getElementById('btn-bucket-all');
  if (all) all.onclick = showAllBuckets;
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
    updateBucketMore(0);
    repaintAllBuckets();
    return;
  }
  // 需求 2①：卡片列表最多展示前 BUCKET_PREVIEW_LIMIT 个存储桶
  const shown = cache.slice(0, BUCKET_PREVIEW_LIMIT);
  box.innerHTML = bucketTableHtml(shown, cache);
  bindBucketRowActions(box, shown);

  updateBucketMore(cache.length);
  repaintAllBuckets(); // 对话框开着时同步刷新：停用/解绑后两边必须一致
}

/**
 * 存储桶表格 HTML —— 卡片列表与「全部存储桶」对话框的**唯一渲染器**（R36）。
 *
 * ⚠️ `all` 是**未经过滤的全量数据**，用于「仅剩最后一个启用桶时禁止停用」这条保护
 * （`disBlocked`）。它**不能**退化成 `rows`：对话框里按服务商筛过之后 `rows` 只是子集，
 * 在子集里数启用桶会得出「这个厂商只剩一个启用桶了」的错觉，把本该可停用的按钮锁死。
 *
 * @param {Array} rows 要渲染的行
 * @param {Array} [all] 用于全局判定的全量数据（缺省时退化为 `rows`）
 */
function bucketTableHtml(rows, all) {
  const total = all || rows;
  const enabledCount = total.filter((x) => x.enabled !== false).length;
  return `<table class="lk-table bm-table">
    <thead><tr>
      <th>服务商</th><th>存储桶</th><th>地域</th><th>已用容量</th><th>累计上传</th><th>累计下载</th><th>请求数</th><th>碎片</th><th style="width:170px">限速</th>
      ${isAdmin() ? '<th style="width:90px">屏蔽海外 IP</th>' : ''}
      ${isAdmin() ? '<th style="width:320px">操作</th>' : ''}
    </tr></thead>
    <tbody>
      ${rows.map((row) => {
        const st = row.stats || {};
        const frag = st.fragmentCount;
        const fragCell = frag === null || frag === undefined ? '—'
          : frag < 0 ? '<span class="bm-sub-bad">查询失败</span>'
          : frag === 0 ? '0'
          : `<span class="lk-badge warn">${frag} 个</span>`;
        // 停用保护：仅剩最后一个启用桶时禁止停用（服务端同样强制校验）
        const disabled = row.enabled === false;
        const disBlocked = !disabled && enabledCount <= 1;
        const rid = escapeHtml(row.id);
        const toggleBtn = isAdmin() ? `<button class="mini-btn" data-act="${disabled ? 'en' : 'dis'}" data-id="${rid}"
          ${disBlocked ? 'disabled title="仅剩一个存储桶时不能停用，请直接解绑。"' : ''}>${disabled ? '启用' : '停用'}</button>` : '';
        const overseaChecked = row.blockOverseasIP === true;
        const overseaCell = isAdmin()
          ? `<label class="check-line" title="开启后，访问该桶时仅中国大陆 / 内网 IP 可放行"><input type="checkbox" data-act="block-overseas" data-id="${rid}"${overseaChecked ? ' checked' : ''} ${disabled ? 'disabled' : ''}></label>`
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
          <td class="lk-speed">${speedCellHtml('bucket', row.id, row.speedLimit, isAdmin())}</td>
          ${isAdmin() ? `<td class="bm-oversea-cell">${overseaCell}</td>` : ''}
          ${isAdmin() ? `<td class="lk-acts">
            ${toggleBtn}
            <button class="mini-btn" data-act="perm" data-id="${rid}">编辑权限</button><button class="mini-btn" data-act="clear" data-id="${rid}">清空文件</button><button class="mini-btn" data-act="frag" data-id="${rid}">清理碎片</button><button class="mini-btn danger" data-act="destroy" data-id="${rid}">彻底删除</button>
            <button class="mini-btn" data-act="unbind" data-id="${rid}" title="仅移除本地绑定记录，不删除云端存储桶">解绑</button>
          </td>` : ''}
        </tr>`;
      }).join('')}
    </tbody></table>`;
}

/**
 * 行内按钮绑定 —— 卡片与对话框共用（R36），否则对话框里的按钮会「看得见、点不动」。
 * 写法与 `syssettings.js` 的 `bindUserRowActions` 严格同型（见 credmgr.js 的同类说明）。
 */
function bindBucketRowActions(root, rows) {
  root.querySelectorAll('[data-act]').forEach((btn) => {
    const act = btn.getAttribute('data-act');
    const row = rows.find((x) => x.id === btn.getAttribute('data-id'));
    if (!row) return;
    btn.onclick = () => {
      if (act === 'clear') confirmClear(row);
      else if (act === 'frag') confirmClearFragments(row);
      else if (act === 'destroy') confirmDestroy(row);
      else if (act === 'unbind') unbind(row);
      else if (act === 'perm') openVisibilityDialog(row);
      else if (act === 'en') toggleBucketEnabled(row, true);
      else if (act === 'dis') toggleBucketEnabled(row, false);
      else if (act === 'block-overseas') toggleBlockOverseas(row, btn.checked);
      // R37：桶级下载限速。与 `quotaBytes` 同为「由管理员设置、对写入者强制生效」的限额，
      // 因此服务端与配额同款：非管理员的该字段会在白名单处被丢弃（见 routes/buckets.js）。
      else if (act === 'speed') openSpeedLimitDialog({
        scope: 'bucket', id: row.id, name: row.remark || row.bucket,
        current: row.speedLimit, onSaved: refresh,
      });
    };
  });
}

/**
 * 「显示全部」按钮的显隐与提示文案（需求 2①）。
 * 判据下沉到 `util.previewMoreState()`（四张卡片共用）—— 用的是**严格大于**：
 * 正好 10 个存储桶时卡片已完整展示，再摆一个「显示全部」点开只能看到一字不差的副本。
 */
function updateBucketMore(total) {
  const more = document.getElementById('bucket-more');
  const hint = document.getElementById('bucket-more-hint');
  const { over, hint: hintText } = previewMoreState(total, BUCKET_PREVIEW_LIMIT, '个存储桶');
  if (more) more.hidden = !over;
  if (hint) hint.textContent = hintText;
}

/** 重绘「全部存储桶」列表（对话框没开时是空操作） */
function repaintAllBuckets() {
  if (bucketsDialog) bucketsDialog.repaint();
}

/**
 * 按关键词 / 服务商筛选存储桶（R36 需求 2②③④）。
 *
 * 需求 ④ 明确要求**只有一个搜索框**同时搜「存储桶名称」与「备注」——
 * 两个输入框会逼用户先判断"我要找的字在哪一栏"，搜不到还得换个框再试一遍。
 * 这里把两个字段一起交给 `util.matchesQuery()`（任一命中即算命中）。
 */
function filterBuckets(list, query, provider) {
  const want = String(provider == null ? '' : provider).trim();
  return (Array.isArray(list) ? list : []).filter((r) => (!want || String((r && r.provider) || 'tencent') === want)
    && matchesQuery(query, [(r && r.bucket) || '', (r && r.remark) || '']));
}

/** 打开「全部存储桶」对话框（需求 2②③④：服务商下拉 + 单框同时搜桶名与备注） */
function showAllBuckets() {
  if (!isAdmin()) return;
  if (bucketsDialog) return; // 连点两次不得叠出第二层遮罩（句柄在 onClose 里复位）
  bucketsDialog = openListDialog({
    idPrefix: 'bucket-all',
    title: `全部存储桶（共 ${cache.length} 个）`,
    placeholder: '搜索存储桶名称或备注（不区分大小写）',
    cls: 'bucket-all-dialog', // 10 列表格要的宽度（见 style.css）
    unit: '个存储桶',
    unitShort: '个',
    emptyAll: '还没有绑定存储桶',
    emptyMatch: '没有匹配的存储桶',
    selects: [{
      id: 'provider',
      title: '按服务商筛选',
      value: '',
      options: providerSelectOptions(cache, providerMeta, '全部服务商'),
    }],
    items: () => cache,
    filter: (list, st) => filterBuckets(list, st.query, st.filters.provider),
    // ⚠️ 第二参数必须是**全量** cache：`disBlocked`（仅剩一个启用桶不能停用）要在
    // 全量上判定。传 `shown` 会让筛过之后的子集被当成全域，把本该可停用的按钮锁死。
    rowHtml: (shown) => bucketTableHtml(shown, cache),
    bindRows: (list, shown) => bindBucketRowActions(list, shown),
    onClose: () => { bucketsDialog = null; },
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
    toast(`存储桶已${label}${!want ? '，同时设为对普通用户可见性关闭' : ''}`, { type: 'success' });
    /**
     * R29-02：这里原来只 `dispatchEvent('buckets-changed')`，并注释说「同步侧边栏」——
     * 但该事件的监听者只有 credmgr / bucketmgr 自己（各自重渲染本卡片），
     * **侧边栏的桶列表由 main.js 渲染、读的是 `App.state.config` 快照**，没人重新取数。
     * 于是刚停用的桶仍留在侧边栏里、且状态栏仍显示它 —— 必须按 F5 才正确。
     * 改为走 `App.onConfigChanged()`（内部：loadConfig → 侧边栏/状态栏，再派发
     * `buckets-changed` 让各卡片自行重渲染，且额外刷新目录树与文件列表）。
     */
    App.onConfigChanged();
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

/**
 * 桶内容 / 启用态 / 可见性被改动后的统一收尾。
 *
 * R29-02：原来只派发 `buckets-changed` + （当前桶时）刷新用量，于是
 * **清空当前桶之后文件列表仍是旧的**（被删掉的文件还挂在屏幕上，双击即报不存在），
 * 侧边栏与状态栏也不会跟着更新。改走 `App.onConfigChanged()` —— 它一次性覆盖
 * 配置快照 / 侧边栏 / 状态栏 / 目录树 / 文件列表，并顺带派发 `buckets-changed`。
 */
function afterBucketMutated(row) {
  App.onConfigChanged();
  if (row && row.active) App.refreshStorage();
}


/**
 * 打开"存储桶可见性"配置弹窗（`listdialog.buildTransferBox` 复用，R37 起组件已迁出本文件）：
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
            // R29-02：可见性存在全局配置快照里（存储桶弹窗的「对普通用户可见」勾选框读它）
            App.reloadConfig();
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
