/** 资源管理器核心 —— 目录列表 / 分页 / 多视图 / 排序 / 多选 / 右键菜单 / 拖拽 / 搜索 */
import { API } from './api.js';
import { escapeHtml, fmtSize, fmtTime, toast, confirmDialog, openModal, iconHtml } from './util.js';
import { App } from './main.js';
import { uploadMgr } from './upload.js';
import { ops } from './ops.js';
import { openDownload } from './enc.js';

/** 加密文件锁标记（云端存储为密文，查看/下载时本地解密） */
const LOCK = '<span class="enc-lock" title="已加密：云端存储为密文，下载/查看时本地解密">🔒</span>';

const state = {
  items: [],
  nextMarker: '',
  isTruncated: false,
  loading: false,
  anchorIndex: -1,
  searchActive: false,
  searchMeta: null,
  // 搜索续扫游标：服务端在单轮扫描上限内停住时返回，原样传回即可继续扫描剩余对象
  searchCursor: '',
  searchMatches: [],
  searchScanned: 0,
  renderedKeys: [],
};

let els = {};

/**
 * 请求序号 —— 文件区所有异步加载（refresh / loadMore / search）**共用一个**计数器。
 *
 * FUN-09：旧写法在 in-flight 时直接 `return`，把用户的后续操作**静默丢弃**：
 * 快速连点两个文件夹 / 前进后退连点 / 自动刷新与手动刷新重叠时，目标目录
 * 会永远停在旧内容且不重试，必须手动 F5。这比不互斥更糟 —— 用户的最后一次
 * 意图被丢了，而界面上毫无提示。
 *
 * 正确语义是「**最后一次意图生效**」：每次发起前自增，await 之后若自己不再是
 * 最新的一次就直接丢弃结果（不渲染、不报错）。渲染必须幂等，晚到的旧响应绝不能
 * 覆盖新响应。
 */
let loadSeq = 0;

/**
 * 在途搜索的取消句柄（请求取消）。
 *
 * 序号机制只解决「旧结果不该覆盖新结果」，解决不了「服务端那一轮还在白扫」——
 * 连按两次回车时，前一轮的若干次云端列举照打不误，而响应最终被丢弃。
 * 这里在发起新搜索前取消上一个，服务端检测到连接断开就会停止翻页。
 */
let searchAbort = null;

/** 取消在途搜索（离开搜索态 / 切目录时调用） */
function abortInFlightSearch() {
  if (!searchAbort) return;
  try { searchAbort.abort(); } catch (e) { /* 已结束 */ }
  searchAbort = null;
}

export const explorer = {
  init() {
    els = {
      area: document.getElementById('file-area'),
      loadMore: document.getElementById('load-more'),
      empty: document.getElementById('empty-hint'),
      breadcrumb: document.getElementById('breadcrumb'),
      banner: document.getElementById('search-banner'),
      bannerText: document.getElementById('search-banner-text'),
    };

    els.loadMore.querySelector('button').onclick = () => this.loadMore();
    els.area.addEventListener('scroll', () => {
      if (els.area.scrollTop + els.area.clientHeight > els.area.scrollHeight - 420) this.loadMore();
    });

    // 拖拽上传 / 内部移动
    els.area.addEventListener('dragover', (e) => {
      if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        els.area.classList.add('dropping');
      } else if ([...e.dataTransfer.types].includes('application/x-cos-keys')) {
        e.preventDefault();
      }
    });
    els.area.addEventListener('dragleave', (e) => { if (e.target === els.area) els.area.classList.remove('dropping'); });
    els.area.addEventListener('drop', async (e) => {
      e.preventDefault();
      els.area.classList.remove('dropping');
      if ([...e.dataTransfer.types].includes('application/x-cos-keys')) {
        // 内部拖拽 → 移动到空白区域 = 当前目录
        return;
      }
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (files.length) uploadMgr.enqueue(files.map((f) => f.file), App.state.prefix, files.some((f) => f.path));
    });

    // 空白区域点击取消选择
    els.area.addEventListener('mousedown', (e) => {
      if (e.button === 0 && !e.target.closest('.grid-item') && !e.target.closest('tr[data-key]') && !e.target.closest('thead')) {
        clearSelection();
      }
    });
    els.area.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.grid-item') || e.target.closest('tr[data-key]')) return;
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, null);
    });

    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#ctx-menu')) document.getElementById('ctx-menu').hidden = true;
    });
  },

  /* ------------------------- 导航 ------------------------- */

  async navigate(prefix, { push = true } = {}) {
    abortInFlightSearch(); // 切目录后旧搜索的续扫结果已无意义，别让它继续扫云端
    App.state.prefix = prefix || '';
    App.state.selection.clear();
    state.anchorIndex = -1;
    state.searchActive = false;
    els.banner.hidden = true;
    document.getElementById('btn-search-clear').hidden = !document.getElementById('search-input').value;
    if (push) {
      const h = App.state.history;
      h.splice(App.state.historyIndex + 1);
      if (h[h.length - 1] !== App.state.prefix) h.push(App.state.prefix);
      if (h.length > 100) h.shift();
      App.state.historyIndex = h.length - 1;
      App.updateNavButtons();
    }
    if (App.backToExplorer) App.backToExplorer();
    renderBreadcrumb();
    renderTreeActive(prefix);
    await this.refresh();
  },

  historyGo(delta) {
    const s = App.state;
    const i = s.historyIndex + delta;
    if (i < 0 || i >= s.history.length) return;
    s.historyIndex = i;
    App.updateNavButtons();
    this.navigate(s.history[i], { push: false });
  },

  /* ------------------------- 列表加载 ------------------------- */

  async refresh({ silent } = {}) {
    const seq = ++loadSeq; // FUN-09：不再用 `if (loading) return` 丢弃意图
    state.loading = true;
    if (!silent) showLoadingHint();
    try {
      const r = await API.list({ prefix: App.state.prefix, marker: '', maxKeys: 200 });
      if (seq !== loadSeq) return; // 期间又有更新的请求：本次结果作废
      state.items = mergePage([], r);
      state.nextMarker = r.nextMarker || '';
      state.isTruncated = r.isTruncated;
      preserveSelection();
      explorer.render();
      App.updateStatusbar();
    } catch (e) {
      if (seq !== loadSeq) return;
      handleFsError(e);
    } finally {
      // 只有「仍是最新一次请求」才收尾，否则会把新请求的加载态提前清掉
      if (seq === loadSeq) {
        state.loading = false;
        hideLoadingHint();
      }
    }
  },

  async loadMore() {
    if (state.loading) return;
    // 搜索态下同一个「加载更多」按钮承担「继续搜索」语义：
    // 服务端一轮最多扫 SCAN 个对象，扫不完时返回 cursor，这里带回去续扫
    if (state.searchActive) {
      if (!state.searchCursor) return;
      return this.search({ continue: true });
    }
    if (!state.isTruncated || !state.nextMarker) return;
    const seq = ++loadSeq;
    state.loading = true;
    els.loadMore.querySelector('.loading-spin').hidden = false;
    try {
      const r = await API.list({ prefix: App.state.prefix, marker: state.nextMarker, maxKeys: 200 });
      if (seq !== loadSeq) return; // 已切到别的请求：不追加，避免把旧页拼进新列表
      state.items = mergePage(state.items, r);
      state.nextMarker = r.nextMarker || '';
      state.isTruncated = r.isTruncated;
      explorer.render();
    } catch (e) {
      if (seq !== loadSeq) return;
      handleFsError(e);
    } finally {
      if (seq === loadSeq) {
        state.loading = false;
        els.loadMore.querySelector('.loading-spin').hidden = true;
        updateLoadMore();
      }
    }
  },

  /* ------------------------- 搜索 ------------------------- */

  /**
   * 搜索。`{ continue: true }` 时从 `state.searchCursor` 续扫下一段。
   *
   * 首轮与续扫刻意共用同一条代码路径：拆成两个函数就会多出一份「发请求 → 合并结果
   * → 更新横幅」的实现，而「同一类逻辑多份实现」正是本项目反复产生漏网之鱼的源头。
   */
  async search({ continue: cont = false } = {}) {
    const q = document.getElementById('search-input').value.trim();
    const f = window.__filter || {};
    if (!cont) {
      if (!q && !f.type && !f.from && !f.to && !f.minMB && !f.maxMB) return;
      if (!App.state.config || !App.state.config.configured) return ops.needConfig();
      state.searchCursor = '';
      state.searchMatches = [];
      state.searchScanned = 0;
    }
    // 请求取消：上一轮搜索（若有）发起新的一轮前先取消。
    // 它的结果反正会被序号判为过期而丢弃，不如连同服务端的翻页一起停下。
    abortInFlightSearch();
    const ac = new AbortController();
    searchAbort = ac;
    // RE-02：序号必须在**确认会发请求之后**才自增。
    // 上面两个早退分支（条件为空 / 未配置）不发请求，若也先自增，就会把在途的
    // refresh/loadMore 判为"过期"而作废其响应 —— 而自己又不发请求，没人再来收尾，
    // state.loading 永远停在 true（表现为「加载更多」点不动）。
    // 这正是 FUN-09 同一模式的漏改点：refresh/loadMore 的自增已在校验之后，这里漏了。
    const seq = ++loadSeq; // 与 refresh / loadMore 共用序号：最后一次意图生效
    state.loading = true;
    showLoadingHint();
    try {
      const r = await API.search({
        prefix: App.state.prefix, q,
        type: f.type || '', from: f.from || '', to: f.to || '',
        min: f.minMB ? f.minMB * 1048576 : 0,
        max: f.maxMB ? f.maxMB * 1048576 : '',
        // 单轮结果数：200 而非 1000 —— 非选择性筛选能更早停下（少翻几页云端），
        // 单次渲染的 DOM 也从 1000 条降到 200 条（缓解 PERF-05）。
        // 结果更多时由「继续搜索」/ 滚动到底自动续扫接着取，总量不变。
        limit: 200,
        scope: App.state.searchCurrentOnly ? 'current' : '',
        cursor: cont ? state.searchCursor : '',
      }, { signal: ac.signal });
      if (seq !== loadSeq) return; // 已经有更新的搜索/刷新：丢弃本次结果
      state.searchActive = true;
      // 续扫是**追加**而非替换：把 matches 累积到 searchMatches，items 指向它
      state.searchMatches = cont ? state.searchMatches.concat(r.matches) : r.matches;
      state.items = state.searchMatches;
      state.searchCursor = r.cursor || '';
      state.searchScanned += r.scanned || 0;
      state.searchMeta = { q, filter: f, scanned: state.searchScanned, truncated: !!r.truncated };
      if (!cont) App.state.selection.clear();
      els.banner.hidden = false;
      const cond = [
        q ? `名称含“${q}”` : '',
        f.type ? '类型=' + f.type : '',
        f.from || f.to ? `日期 ${f.from || '…'}~${f.to || '…'}` : '',
        f.minMB || f.maxMB ? `大小 ${f.minMB || 0}~${f.maxMB || '∞'} MB` : '',
      ].filter(Boolean).join('，');
      const tail = state.searchCursor ? '，下方「继续搜索」可扫描剩余部分' : '';
      const scopeText = App.state.searchCurrentOnly ? '当前目录' : '当前目录及子目录';
      els.bannerText.innerHTML = `搜索结果：<b>${state.searchMatches.length}</b> 项（${scopeText}，已扫描 ${state.searchScanned} 个对象${tail}）${cond ? ' · 条件：' + escapeHtml(cond) : ''}`;
      explorer.render();
    } catch (e) {
      // 被更新的搜索（或切目录 / 退出搜索）取消：不是故障，静默丢弃即可
      if (e && e.name === 'AbortError') return;
      if (seq !== loadSeq) return;
      handleFsError(e);
    } finally {
      if (searchAbort === ac) searchAbort = null;
      if (seq === loadSeq) {
        state.loading = false;
        hideLoadingHint();
      }
    }
  },

  exitSearch() {
    abortInFlightSearch();
    document.getElementById('search-input').value = '';
    document.getElementById('btn-search-clear').hidden = true;
    window.__filter = null;
    state.searchActive = false;
    state.searchCursor = '';
    state.searchMatches = [];
    state.searchScanned = 0;
    els.banner.hidden = true;
    this.navigate(App.state.prefix, { push: false });
  },

  /* ------------------------- 渲染 ------------------------- */

  render() {
    if (document.getElementById('explorer').hidden) return;
    sortItems();
    const view = App.state.view;
    els.area.className = 'view-' + view;
    updateLoadMore();
    if (!state.items.length) {
      els.area.innerHTML = '';
      els.empty.hidden = false;
      const isRoot = !App.state.prefix;
      els.empty.innerHTML = `<div class="big">${state.searchActive ? '🔍' : '📂'}</div>
        <p>${state.searchActive ? '没有符合条件的结果' : isRoot ? '该存储桶是空的，上传文件或新建文件夹开始使用' : '此文件夹为空'}</p>
        ${!state.searchActive ? '<p style="margin-top:8px"><button class="mini-btn" id="eh-upload">上传文件</button></p>' : ''}`;
      const b = document.getElementById('eh-upload');
      if (b) b.onclick = () => document.getElementById('file-input').click();
      App.updateStatusbar && App.updateStatusbar();
      return;
    }
    els.empty.hidden = true;
    state.renderedKeys = state.items.map((i) => i.key);
    if (view === 'list') renderList();
    else renderGrid(view);
    updateOpsButtons();
    App.updateStatusbar && App.updateStatusbar();
  },

  /* ------------------------- 选择 ------------------------- */

  selectAll() {
    App.state.selection = new Set(state.items.map((i) => i.key));
    syncSelectionUi();
  },
  clearSelection() { clearSelection(); },

  openItem(key) {
    const item = state.items.find((i) => i.key === key);
    if (!item) return;
    if (item.isFolder) this.navigate(item.key);
    else if (item.type === 'image') previewImage(item);
    else openDownload(item.key); // 加密文件自动先验证权限
  },
};

/* ------------------------- 数据处理 ------------------------- */

function mergePage(items, r) {
  const out = items.slice();
  const seen = new Set(items.map((i) => i.key));
  const prefix = App.state.prefix;
  for (const p of r.prefixes || []) {
    if (!seen.has(p.prefix)) {
      seen.add(p.prefix);
      out.push({ key: p.prefix, name: p.name, size: 0, lastModified: '', etag: '', isFolder: true, type: 'folder' });
    }
  }
  for (const c of r.contents || []) {
    if (c.key === prefix || seen.has(c.key)) continue;
    if (c.isFolder) continue; // 子文件夹标记对象已在 CommonPrefixes 中
    seen.add(c.key);
    out.push(c);
  }
  return out;
}

function sortItems() {
  const { key, dir } = App.state.sort;
  const mul = dir === 'desc' ? -1 : 1;
  state.items.sort((a, b) => {
    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1; // 文件夹始终在前
    let cmp = 0;
    if (key === 'name') cmp = a.name.localeCompare(b.name, 'zh-CN');
    else if (key === 'size') cmp = (a.size || 0) - (b.size || 0);
    else if (key === 'modified') cmp = new Date(a.lastModified || 0) - new Date(b.lastModified || 0);
    else if (key === 'type') cmp = String(a.type).localeCompare(String(b.type));
    return cmp * mul || a.name.localeCompare(b.name, 'zh-CN');
  });
}

function preserveSelection() {
  const sel = App.state.selection;
  if (sel.size) {
    const valid = new Set(state.items.map((i) => i.key));
    for (const k of [...sel]) if (!valid.has(k)) sel.delete(k);
  }
}

/* ------------------------- 渲染：列表 ------------------------- */

function renderList() {
  const cols = App.state.columns;
  const colHtml = (id) => {
    const def = { name: ['c-name', '名称'], size: ['c-size', '大小'], type: ['c-type', '类型'], modified: ['c-date', '修改时间'] }[id];
    if (!def) return '';
    const sortable = ['name', 'size', 'modified'].includes(id) || id === 'type';
    const sortKey = { name: 'name', size: 'size', type: 'type', modified: 'modified' }[id];
    const arr = App.state.sort.key === sortKey ? `<span class="arr">${App.state.sort.dir === 'asc' ? '▲' : '▼'}</span>` : '';
    return `<th class="${def[0]}" data-sort="${sortable ? sortKey : ''}">${def[1]}${arr}</th>`;
  };
  const rows = state.items.map((item, idx) => {
    const sel = App.state.selection.has(item.key) ? ' selected' : '';
    const tds = cols.map((id) => {
      if (id === 'name') {
        return `<td class="c-name"><span class="f-ic">${iconHtml(item)}<span class="f-name" title="${escapeHtml(item.key)}">${escapeHtml(item.name || item.key)}</span></span>${item.encrypted ? LOCK : ''}</td>`;
      }
      if (id === 'size') return `<td class="c-size">${item.isFolder ? '—' : fmtSize(item.size)}</td>`;
      if (id === 'type') return `<td class="c-type">${item.isFolder ? '文件夹' : typeLabel(item.type)}</td>`;
      if (id === 'modified') return `<td class="c-date">${fmtTime(item.lastModified)}</td>`;
      return '';
    }).join('');
    return `<tr data-key="${escapeHtml(item.key)}" data-idx="${idx}" class="${sel}" draggable="true">${tds}</tr>`;
  }).join('');
  els.area.innerHTML = `
    <table class="file-list">
      <thead><tr>${cols.map(colHtml).join('')}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  bindRowEvents();
}

function typeLabel(t) { return ({ image: '图片', video: '视频', audio: '音频', doc: '文档', archive: '压缩包', other: '文件', folder: '文件夹' })[t] || t; }

function renderGrid(view) {
  const items = state.items.map((item, idx) => {
    const sel = App.state.selection.has(item.key) ? ' selected' : '';
    const thumb = item.type === 'image' && !item.isFolder && item.size < 20 * 1048576
      ? `<div class="thumb"><span class="badge t-image" style="width:32px;height:32px;font-size:10px">${extShort(item.name)}</span><img loading="lazy" src="${API.thumbUrl(item.key)}" data-thumb></div>`
      : `<div class="thumb">${iconHtml(item, 'badge t-' + item.type)}</div>`;
    return `<div class="grid-item${sel}" data-key="${escapeHtml(item.key)}" data-idx="${idx}" draggable="true" title="${escapeHtml(item.key)}${item.encrypted ? '（已加密）' : ''}">
      ${thumb}<div class="nm">${escapeHtml(item.name || item.key)}${item.encrypted ? LOCK : ''}</div></div>`;
  }).join('');
  els.area.innerHTML = `<div class="grid-wrap">${items}</div>`;
  bindRowEvents();
}

function extShort(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1, i + 5).toUpperCase() : 'FILE';
}

function bindRowEvents() {
  // 缩略图：加载完成淡入、失败则从 DOM 移除（回退到类型角标）
  //
  // SEC-06：这两行为**原来用内联的 onload/onerror 属性**实现，那是全项目唯一的
  // `script-src 'unsafe-inline'` 需求来源 —— 一旦 CSP 里保留 unsafe-inline，
  // 任何一处 XSS 注入都能直接升级为脚本执行。改为 addEventListener 后
  // 即可彻底移除 unsafe-inline。
  // 注意：图片可能在绑定前就已 load 完成，故需补查 `complete` 状态处理竞态。
  els.area.querySelectorAll('img[data-thumb]').forEach((img) => {
    if (img.dataset.thumbBound === '1') return;
    img.dataset.thumbBound = '1';
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
    if (img.complete) {
      // 绑定太晚：图片早已完成（缓存命中或极快响应）
      if (img.naturalWidth > 0) img.classList.add('loaded');
      else img.remove();
    }
  });
  // 表头排序
  els.area.querySelectorAll('th[data-sort]').forEach((th) => {
    if (!th.dataset.sort) return;
    th.onclick = () => {
      const k = th.dataset.sort;
      if (App.state.sort.key === k) App.state.sort.dir = App.state.sort.dir === 'asc' ? 'desc' : 'asc';
      else App.state.sort = { key: k, dir: 'asc' };
      if (window.__savePrefs) window.__savePrefs();
      explorer.render();
    };
  });

  const rows = els.area.querySelectorAll('[data-key]');
  rows.forEach((row) => {
    const key = row.dataset.key;
    const idx = Number(row.dataset.idx);
    row.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        // 右键：若未选中则单选该项
        if (!App.state.selection.has(key)) {
          App.state.selection.clear();
          App.state.selection.add(key);
          syncSelectionUi();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        toggleSel(key);
        state.anchorIndex = idx;
      } else if (e.shiftKey && state.anchorIndex >= 0) {
        const [a, b] = [Math.min(state.anchorIndex, idx), Math.max(state.anchorIndex, idx)];
        if (!e.ctrlKey && !e.metaKey) App.state.selection.clear();
        for (let i = a; i <= b; i++) App.state.selection.add(state.items[i].key);
      } else {
        App.state.selection.clear();
        App.state.selection.add(key);
        state.anchorIndex = idx;
      }
      syncSelectionUi();
    });
    row.addEventListener('dblclick', () => explorer.openItem(key));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, key);
    });
    row.addEventListener('dragstart', (e) => {
      const keys = App.state.selection.has(key) ? [...App.state.selection] : [key];
      e.dataTransfer.setData('application/x-cos-keys', JSON.stringify(keys));
      e.dataTransfer.effectAllowed = 'move';
    });
    if (row.classList.contains('grid-item') && state.items[idx] && state.items[idx].isFolder) {
      row.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('application/x-cos-keys')) { e.preventDefault(); e.stopPropagation(); row.style.background = 'var(--selected)'; }
      });
      row.addEventListener('dragleave', () => { row.style.background = ''; });
      row.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation(); row.style.background = '';
        const keys = JSON.parse(e.dataTransfer.getData('application/x-cos-keys') || '[]');
        const target = state.items[idx];
        const toMove = keys.filter((k) => k !== target.key && !target.key.startsWith(k));
        if (toMove.length) ops.moveKeysTo(toMove, target.key);
      });
    }
  });
}

function toggleSel(key) {
  const s = App.state.selection;
  if (s.has(key)) s.delete(key); else s.add(key);
}

function clearSelection() {
  App.state.selection.clear();
  syncSelectionUi();
}

function syncSelectionUi() {
  els.area.querySelectorAll('[data-key]').forEach((row) => {
    row.classList.toggle('selected', App.state.selection.has(row.dataset.key));
  });
  updateOpsButtons();
  App.updateStatusbar && App.updateStatusbar();
}

function updateOpsButtons() {
  const n = App.state.selection.size;
  const set = (id, dis) => { document.getElementById(id).disabled = dis; };
  set('op-download', n === 0);
  set('op-rename', n !== 1);
  set('op-move', n === 0);
  set('op-copylink', n === 0);
  set('op-delete', n === 0);
}
explorer.updateOpsButtons = updateOpsButtons;
explorer.syncSelectionUi = syncSelectionUi;

function updateLoadMore() {
  // 搜索态：按钮语义变为「继续搜索」，可见性由续扫游标决定
  if (state.searchActive) {
    els.loadMore.hidden = !state.searchCursor;
    const btn = els.loadMore.querySelector('button');
    if (btn) btn.textContent = '继续搜索';
    return;
  }
  els.loadMore.hidden = !state.isTruncated || !state.items.length;
  const btn = els.loadMore.querySelector('button');
  if (btn) btn.textContent = '加载更多';
}

/* ------------------------- 面包屑 / 树 ------------------------- */

function renderBreadcrumb() {
  const bc = els.breadcrumb;
  const bucket = App.state.bucketDisplay || App.state.bucket || '存储桶';
  const parts = App.state.prefix ? App.state.prefix.replace(/\/$/, '').split('/') : [];
  let path = '';
  const html = [`<span class="crumb ${parts.length ? '' : 'current'}" data-p="">🪣 ${escapeHtml(bucket)}</span>`];
  parts.forEach((seg, i) => {
    path += seg + '/';
    html.push(`<span class="sep">›</span><span class="crumb ${i === parts.length - 1 ? 'current' : ''}" data-p="${escapeHtml(path)}">${escapeHtml(seg)}</span>`);
  });
  bc.innerHTML = html.join('');
  bc.querySelectorAll('.crumb').forEach((el) => {
    el.onclick = () => explorer.navigate(el.dataset.p);
  });
}

function renderTreeActive(prefix) {
  document.querySelectorAll('#tree .tree-row').forEach((r) => {
    r.classList.toggle('active', r.dataset.prefix === prefix);
  });
}
explorer.renderBreadcrumb = renderBreadcrumb;
explorer.renderTreeActive = renderTreeActive;

/* ------------------------- 右键菜单 ------------------------- */

function showContextMenu(x, y, key) {
  const menu = document.getElementById('ctx-menu');
  const sel = App.state.selection;
  const multi = sel.size > 1 && key && sel.has(key);
  const items = [];
  if (key && !multi) {
    const item = state.items.find((i) => i.key === key);
    if (item && item.isFolder) items.push({ text: '打开', onClick: () => explorer.navigate(key) });
    if (item && !item.isFolder) {
      items.push({ text: '下载', onClick: () => ops.downloadKeys([key]) });
      if (item.type === 'image') items.push({ text: '预览', onClick: () => previewImage(item) });
    }
    items.push({ text: '复制链接', onClick: () => ops.copyLinkKeys([key]) });
    items.push({ sep: true });
    items.push({ text: '重命名', k: 'F2', onClick: () => { App.state.selection = new Set([key]); syncSelectionUi(); ops.renameSelected(); } });
    items.push({ text: '移动到…', onClick: () => ops.moveKeysTo([key]) });
    items.push({ sep: true });
    items.push({ text: '删除', k: 'Del', danger: true, onClick: () => ops.deleteKeys([key]) });
    items.push({ sep: true });
    items.push({ text: '属性', onClick: () => showProperties(item) });
  } else if (multi) {
    items.push({ text: `下载（${sel.size} 项）`, onClick: () => ops.downloadSelected() });
    items.push({ text: `移动到…（${sel.size} 项）`, onClick: () => ops.moveSelected() });
    items.push({ sep: true });
    items.push({ text: `删除（${sel.size} 项）`, danger: true, onClick: () => ops.deleteSelected() });
  } else {
    items.push({ text: '刷新', k: 'F5', onClick: () => explorer.refresh() });
    items.push({ text: '新建文件夹', onClick: () => ops.newFolder() });
    items.push({ sep: true });
    items.push({ text: '上传文件', onClick: () => document.getElementById('file-input').click() });
    items.push({ text: '上传文件夹', onClick: () => document.getElementById('folder-input').click() });
    items.push({ sep: true });
    items.push({ text: '全选', k: 'Ctrl+A', onClick: () => explorer.selectAll() });
  }
  menu.innerHTML = items.map((it, i) => it.sep ? '<div class="sep"></div>' : `<div class="mi ${it.danger ? 'danger' : ''}" data-i="${i}">${it.text}${it.k ? `<span class="k">${it.k}</span>` : ''}</div>`).join('');
  menu.hidden = false;
  menu.style.left = Math.min(x, innerWidth - 200) + 'px';
  menu.style.top = Math.min(y, innerHeight - items.length * 36 - 12) + 'px';
  menu.querySelectorAll('.mi').forEach((el) => {
    el.onclick = () => { menu.hidden = true; items[Number(el.dataset.i)].onClick(); };
  });
}

/* ------------------------- 属性面板 ------------------------- */

/** 右键「属性」：文件 → 名称/创建时间/大小；文件夹 → 名称/创建时间/对象总数 */
async function showProperties(item) {
  const m = openModal({
    title: (item.isFolder ? '文件夹属性' : '属性') + ' — ' + item.name,
    body: '<div class="prop-loading"><div class="loading-spin"></div><p>正在获取属性…</p></div>',
    foot: [{ text: '关闭' }],
  });
  const row = (label, value) =>
    `<div class="prop-row"><span class="prop-label">${label}</span><span class="prop-value">${value}</span></div>`;
  try {
    const st = await API.stat(item.key);
    const fullPath = `<div class="prop-path" title="${escapeHtml(st.key)}">${escapeHtml(st.key)}</div>`;
    if (st.isFolder) {
      m.bodyEl.innerHTML = fullPath +
        row('名称', escapeHtml(st.name)) +
        row('类型', '文件夹') +
        row('创建时间', st.lastModified ? fmtTime(st.lastModified) : '—') +
        row('对象总数', st.reachedCap ? `≥ ${st.objectCount}（已达统计上限）` : String(st.objectCount));
    } else {
      m.bodyEl.innerHTML = fullPath +
        row('名称', escapeHtml(st.name)) +
        row('类型', typeLabel(item.type)) +
        row('创建时间', st.lastModified ? fmtTime(st.lastModified) : '—') +
        row('大小', `${fmtSize(st.size)}（${Number(st.size).toLocaleString()} 字节）`) +
        (st.encrypted ? row('加密', '已加密（云端存储为密文，此为解密后大小）') : '');
    }
  } catch (e) {
    m.bodyEl.innerHTML = `<div class="prop-loading"><p style="color:var(--danger)">获取属性失败：${escapeHtml(e.message)}</p></div>`;
  }
}

/* ------------------------- 图片预览 ------------------------- */

function previewImage(item) {
  const m = openModal({
    title: item.name, wide: true, foot: [
      { text: '下载', onClick: () => openDownload(item.key) },
      { text: '关闭' },
    ],
  });
  if (item.encrypted) {
    // 加密图片：缩略图/预览均为密文占位，需下载解密后查看
    m.bodyEl.innerHTML = `<div style="text-align:center;min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px">
      <div style="font-size:44px">🔒</div>
      <p style="margin:0">该图片已加密存储（云端为密文）</p>
      <p style="margin:0;color:var(--text-2);font-size:12px">点击下方「下载」验证权限并解密查看</p>
    </div>
    <p style="color:var(--text-2);font-size:12px;text-align:center;margin-top:8px">${escapeHtml(item.key)} · ${fmtSize(item.size)} · ${fmtTime(item.lastModified)}</p>`;
    return;
  }
  m.bodyEl.innerHTML = `<div style="text-align:center;min-height:200px;display:flex;align-items:center;justify-content:center">
    <img src="${API.thumbUrl(item.key)}" style="max-width:100%;max-height:64vh;border-radius:6px" alt="">
  </div>
  <p style="color:var(--text-2);font-size:12px;text-align:center;margin-top:8px">${escapeHtml(item.key)} · ${fmtSize(item.size)} · ${fmtTime(item.lastModified)}</p>`;
}

/* ------------------------- 拖拽文件提取（支持文件夹） ------------------------- */

async function filesFromDataTransfer(dt) {
  const out = [];
  const entries = [];
  for (const item of dt.items) {
    const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
    if (entry) entries.push(entry);
    else {
      const f = item.getAsFile && item.getAsFile();
      if (f) out.push({ file: f, path: '' });
    }
  }
  async function walk(entry, base) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: base + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const kids = await new Promise((res) => {
        const acc = [];
        const read = () => reader.readEntries((batch) => {
          if (!batch.length) return res(acc);
          acc.push(...batch); read();
        }, () => res(acc));
        read();
      });
      for (const k of kids) await walk(k, base + entry.name + '/');
    }
  }
  for (const en of entries) await walk(en, '');
  return out;
}

/* ------------------------- 其他 ------------------------- */

function showLoadingHint() {
  if (!state.items.length) {
    els.empty.hidden = false;
    els.empty.innerHTML = '<div class="loading-spin" style="margin:0 auto 12px"></div><p>正在加载…</p>';
  }
}
function hideLoadingHint() {
  if (state.loading) return;
  if (!state.items.length && els.empty.textContent.includes('正在加载')) els.empty.hidden = true;
}

function handleFsError(e) {
  if (e.status === 428) {
    const isAdmin = App.state.user && App.state.user.role === 'admin';
    toast(e.message + (isAdmin ? '，正在打开密钥管理…' : '，请联系管理员配置访问密钥'), { type: 'warn' });
    if (isAdmin) import('./settings.js').then((m) => m.settings.open());
    return;
  }
  toast(e.message, { type: 'error' });
  if (!state.items.length) {
    els.empty.hidden = false;
    els.empty.innerHTML = `<div class="big">⚠️</div><p>${escapeHtml(e.message)}</p>`;
  }
}

/* 供 header 排序持久化 */
window.__savePrefs = () => {
  try {
    const p = JSON.parse(localStorage.getItem('cosmgr.prefs.v1') || '{}');
    p.sort = App.state.sort;
    localStorage.setItem('cosmgr.prefs.v1', JSON.stringify(p));
  } catch (e) { /* ignore */ }
};
