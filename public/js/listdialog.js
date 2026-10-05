/**
 * 通用对话框组件（R36 起）
 *
 * 三个导出都是**可复用的界面组件**，与具体卡片无关：
 *   - `openListDialog()`       「显示全部」对话框（带搜索 + 下拉筛选 + 滚动列表）
 *   - `providerSelectOptions()` / `bucketSelectOptions()`  下拉选项推导
 *   - `buildTransferBox()`      穿梭框（存储桶可见性 / IP 规则作用范围共用，R37 迁入）
 *
 * 背景：R35 为「用户管理」卡片做了「卡片只显示前 N 条 + 显示全部对话框（带搜索/滚动）」，
 * R36 要把同一套交互复制到访问密钥 / 存储桶 / 分享链接三张卡片。四份各写一遍必然分叉
 * （最典型的是「其中一张卡片的对话框忘了绑定行内按钮」—— 看得见、点不动），
 * 因此把对话框**骨架与状态**下沉到这里，卡片只提供数据与行渲染：
 *
 *   - `items()`     取当前数据集（每次重绘**现取**，这样后台刷新后的新数据会立刻反映到
 *                   已打开的对话框里；若在打开时快照一份，删除一条后对话框里却还留着它）
 *   - `filter()`    过滤规则（各卡片不同：用户按角色、桶按服务商……但关键词规则统一走
 *                   `util.matchesQuery`）
 *   - `rowHtml()`   行渲染（**必须**与卡片共用同一个渲染器 —— 两处各写一份表格，
 *                   新增一列或一个按钮时只会改到一处）
 *   - `bindRows()`  行内按钮绑定（同上，卡片与对话框共用）
 *
 * ⚠️ 本模块**必须**是独立文件而不是 util.js 的一部分：测试沙箱会用桩替换 util.js 里的
 * `openModal`（它直接操作真实 DOM），再把本文件原样拷进沙箱 —— 于是**真实**的对话框逻辑
 * 能跑在桩化的弹窗原语上。若把它写进 util.js，沙箱只能连它一起换成桩，测到的就是
 * 「测试自己写的一份副本」，只能证明自洽（R30 假 Azure 的教训）。
 */
import { openModal, escapeHtml } from './util.js';

/**
 * 打开「全部列表」对话框。
 *
 * @param {object} o
 *  - `idPrefix`   元素 id / class 前缀（如 `'user-all'` → `#user-all-search`、
 *                 `#user-all-body`、`#user-all-count`）。样式规则按这些前缀分组，
 *                 保留前缀是为了让每张卡片的样式断言能各自锚定。
 *  - `title`      弹窗标题（通常含总数）
 *  - `cls`        弹窗专属尺寸类（7 列 / 10 列表格需要的宽度不同）
 *  - `placeholder` 搜索框占位符（写明搜的是哪些字段）
 *  - `selects`    下拉筛选：[{ id, title, value, options: [{ value, text }] }]；
 *                 **约定 `value === ''` 表示「全部」**
 *  - `items` / `filter` / `rowHtml` / `bindRows`  见文件头
 *  - `unit`       总数文案的单位（如 `'位用户'` → 「共 12 位用户」）
 *  - `unitShort`  匹配文案的单位（缺省同 `unit`；用户卡片用 `'位'` → 「匹配 3 / 共 12 位」）
 *  - `emptyAll` / `emptyMatch`  两种空态文案
 *  - `onClose`    关闭回调（卡片据此清掉自己的句柄）
 * @returns {{ open: boolean, repaint: Function, close: Function }}
 */
export function openListDialog(o) {
  const idp = o.idPrefix;
  const selects = o.selects || [];
  const unit = o.unit || '项';
  const unitShort = o.unitShort || unit;

  const wrap = document.createElement('div');
  wrap.className = idp;
  wrap.innerHTML = `
    <div class="${idp}-bar">
      <input type="search" id="${idp}-search" class="${idp}-search"
        placeholder="${escapeHtml(o.placeholder || '搜索…')}" autocomplete="off" spellcheck="false">
      ${selects.map((s) => `<select id="${idp}-${s.id}" class="${idp}-select" title="${escapeHtml(s.title || '')}">${
        (s.options || []).map((op) => `<option value="${escapeHtml(op.value)}"${op.value === s.value ? ' selected' : ''}>${escapeHtml(op.text)}</option>`).join('')
      }</select>`).join('')}
      <span class="${idp}-count" id="${idp}-count"></span>
    </div>
    <div class="${idp}-body" id="${idp}-body"></div>`;

  /** 对话框自己的筛选状态（跨重绘保持：刷新一次就把关键词清掉，用户会以为界面抽风） */
  const state = { query: '', filters: {} };
  selects.forEach((s) => { state.filters[s.id] = s.value == null ? '' : String(s.value); });

  const api = { open: true, repaint, close: () => modal.close() };
  const modal = openModal({
    title: o.title,
    body: wrap,
    foot: o.foot || [{ text: '关闭' }],
    wide: o.wide !== false,
    cls: o.cls,
    onClose: () => { api.open = false; if (o.onClose) o.onClose(); },
  });

  function currentAll() {
    return (o.items && o.items()) || [];
  }
  function currentShown(all) {
    return o.filter ? (o.filter(all, state) || []) : all;
  }
  /** 是否有任何筛选条件生效（决定计数文案写「共 N」还是「匹配 x / 共 N」） */
  function filtering() {
    return String(state.query == null ? '' : state.query).trim() !== ''
      || Object.keys(state.filters).some((k) => state.filters[k] !== '');
  }

  function repaint() {
    if (!api.open) return;
    const list = document.getElementById(idp + '-body');
    if (!list) { api.open = false; return; } // 弹窗已被移除（例如登出），别再往空气里渲染
    const all = currentAll();
    const shown = currentShown(all);

    const countEl = document.getElementById(idp + '-count');
    if (countEl) {
      countEl.textContent = filtering()
        ? `匹配 ${shown.length} / 共 ${all.length} ${unitShort}`
        : `共 ${all.length} ${unit}`;
    }
    if (!shown.length) {
      // 「筛不到」与「一条都没有」是两件事，文案必须分开 —— 否则用户会以为数据丢了
      list.innerHTML = `<div class="lk-empty">${all.length ? (o.emptyMatch || '没有匹配的项') : (o.emptyAll || '暂无数据')}</div>`;
      return;
    }
    list.innerHTML = o.rowHtml(shown);
    if (o.bindRows) o.bindRows(list, shown);
  }

  const search = document.getElementById(idp + '-search');
  // 本地内存过滤（数据已经在手）：既不防抖也不发请求。
  // 用 `oninput` 而不是 addEventListener：与列表按钮同一写法，且假 DOM 里可直接驱动。
  search.oninput = () => { state.query = search.value; repaint(); };
  selects.forEach((s) => {
    const sel = document.getElementById(idp + '-' + s.id);
    if (!sel) return;
    sel.onchange = () => { state.filters[s.id] = sel.value; repaint(); };
  });

  repaint();
  if (search.focus) search.focus();
  return api;
}

/**
 * 由数据集推导「服务商下拉」的选项（R36：密钥卡片与存储桶卡片共用）。
 *
 * 选项**只列数据集里真实出现过的服务商**，而不是把注册表里 11 家全列出来 ——
 * 后者会给出大量「选了必然为空」的选项，用户会以为是自己筛错了。
 * 名称取自 `providerMeta()`（与服务端注册表同源），因此不会出现「下拉写着腾讯云、
 * 表格里写着 Tencent Cloud」这种两套叫法。
 *
 * @param {Array<{provider?: string}>} rows
 * @param {(id: string) => { name: string }} metaOf  通常传 `providerMeta`
 * @param {string} allText 「全部」选项的文案
 */
export function providerSelectOptions(rows, metaOf, allText) {
  const seen = [];
  (rows || []).forEach((r) => {
    const pid = String((r && r.provider) || 'tencent');
    if (!seen.includes(pid)) seen.push(pid);
  });
  return [{ value: '', text: allText || '全部服务商' }].concat(
    seen.map((pid) => ({ value: pid, text: (metaOf(pid) || {}).name || pid })),
  );
}

/**
 * 由数据集推导「存储桶下拉」的选项（R36：分享链接卡片用）。
 * 同理只列真实出现过的桶；历史链接的 `bucket` 可能为空，那类条目在「全部」下仍可见。
 */
export function bucketSelectOptions(rows, allText) {
  const seen = [];
  (rows || []).forEach((r) => {
    const b = String((r && r.bucket) || '');
    if (b && !seen.includes(b)) seen.push(b);
  });
  return [{ value: '', text: allText || '全部存储桶' }]
    .concat(seen.map((b) => ({ value: b, text: b })));
}

/**
 * 通用穿梭框（左列 = 未选集合，右列 = 已选集合）。
 *
 * R37：从 `bucketmgr.js` 迁到这里 —— 它原本只服务「存储桶可见性」与「IP 屏蔽规则 ·
 * 作用范围」两处，而 IP 规则整体迁去 `ipmgr.js` 之后就成了**跨模块共用件**。
 * 留在任一侧都会让另一侧 import 一个"管理页"模块（并牵出 main.js 的循环依赖），
 * 因此与 `openListDialog` 一起放在本模块：两者都是「可复用的对话框组件」。
 *
 * @param {object} o
 *  - items: [{ id, label, sub?, active? }]
 *  - selectedIds: 初始选中 id 数组
 *  - leftTitle / rightTitle: 列标题（可含徽标 HTML）
 *  - filterLabels: { all, left, right } 筛选按钮文案
 *  - hint / hintHtml: 顶部提示（默认按纯文本转义；显式传 `*Html` 才按可信 HTML 处理）
 *  - countText: (total, selCount) => string 底部计数文案
 * @returns {{ wrap: HTMLElement, getSelected: () => string[] }}
 */
export function buildTransferBox(o) {
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
