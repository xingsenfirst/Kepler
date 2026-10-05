/** 密钥管理页 —— 访问密钥（共享/可见性）/ 自定义域名 / 连接验证 */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, matchesQuery, previewMoreState } from './util.js';
import { openListDialog, providerSelectOptions } from './listdialog.js';
// R37：「限速」列的渲染与对话框（四张列表卡片共用同一实现点）
import { openSpeedLimitDialog, speedCellHtml } from './speedlimit.js';
import { App } from './main.js';
import { providerList, providerLogo, providerMeta } from './provider-logos.js';

let wired = false;
let cache = { credentials: [], activeCredentialId: '' };
let domainCache = { primary: '', backup: '' };
/** 添加密钥表单中当前选中的服务商（默认腾讯云，与服务端默认值保持一致） */
let pickedProvider = 'tencent';

/**
 * 「访问密钥管理」卡片列表的**预览条数上限**（R36 需求 2①）。
 *
 * 与 `USER_PREVIEW_LIMIT` 同理只声明一次：卡片截断（`creds.slice(0, …)`）与
 * 「显示全部」的提示文案都要引用同一个数 —— 两处各写一个字面量，
 * 改一处就会出现「卡片显示 10 条、提示却写 20 条」这种自相矛盾的界面。
 */
const CRED_PREVIEW_LIMIT = 10;

/**
 * 「全部密钥」对话框的句柄（`null` = 未打开）。
 *
 * **必须**放在模块级而不是弹窗闭包里：卡片列表每次刷新（`refresh → render`）都要把
 * 已打开的对话框一并重绘，否则在对话框里删掉一把密钥、卡片上却仍留着它。
 */
let credsDialog = null;

export function refresh() {
  wire();
  const box = document.getElementById('credmgr-table');
  if (!box) return;
  if (!box._loading) {
    box.innerHTML = '<div class="lk-empty">正在加载密钥列表…</div>';
  }
  // 自定义域名卡片对普通用户整卡隐藏（由 main.js 的角色权威渲染点赋值 hidden）。
  // 隐藏时既不回填输入框，也不再拉一次全局配置 —— 只剩「看得见却用不了」的空壳没有意义。
  const domainCard = document.getElementById('credmgr-domain-card');
  const domainVisible = !!domainCard && !domainCard.hidden;
  Promise.all([API.listCredentials(), domainVisible ? API.getConfig() : null])
    .then(([d, cfg]) => {
      cache = d;
      domainCache = (cfg && cfg.domains) || { primary: '', backup: '' };
      const d1 = document.getElementById('credmgr-domain-1');
      const d2 = document.getElementById('credmgr-domain-2');
      // 隐藏时一并清空，避免残留上一个账号填过的域名
      if (d1) d1.value = domainVisible ? (domainCache.primary || '') : '';
      if (d2) d2.value = domainVisible ? (domainCache.backup || '') : '';
      render();
    })
    .catch((e) => {
      box.innerHTML = `<div class="lk-empty">加载失败：${escapeHtml(e.message)}</div>`;
    });
}

function wire() {
  if (wired) return;
  wired = true;
  const rf = document.getElementById('btn-credmgr-refresh');
  if (rf) rf.onclick = () => refresh();
  const sd = document.getElementById('btn-credmgr-save-domain');
  if (sd) sd.onclick = saveDomain;
  const all = document.getElementById('btn-cred-all');
  if (all) all.onclick = showAllCreds;
  // 密钥变更后刷新
  window.addEventListener('buckets-changed', () => {
    const sec = document.getElementById('credmgr');
    if (sec && !sec.hidden) refresh();
  });
}

function isAdmin() {
  return !!(App.state.user && App.state.user.role === 'admin');
}

function render() {
  const box = document.getElementById('credmgr-table');
  const head = document.getElementById('credmgr-count');
  if (!box) return;
  const creds = cache.credentials || [];
  if (head) head.textContent = creds.length ? `（共 ${creds.length} 个）` : '';
  if (!creds.length) {
    box.innerHTML = `<div class="lk-empty">${isAdmin() ? '尚未保存任何密钥。请点击下方「＋ 添加密钥」完成配置。' : '尚无可用密钥，请联系管理员添加。'}</div>`;
    updateCredMore(0);
    repaintAllCreds();
    renderAddForm(box);
    return;
  }
  // 需求 2①：卡片列表最多展示前 CRED_PREVIEW_LIMIT 个密钥
  const shown = creds.slice(0, CRED_PREVIEW_LIMIT);
  box.innerHTML = credTableHtml(shown);
  bindCredRowActions(box, shown);

  updateCredMore(creds.length);
  repaintAllCreds(); // 对话框开着时同步刷新：删/改备注后两边必须一致
  renderAddForm(box);
}

/**
 * 密钥表格 HTML —— 卡片列表与「全部密钥」对话框的**唯一渲染器**（R36）。
 *
 * 两处各写一份表格是这类界面最典型的腐烂方式：新增一列或一个按钮只改了一处，
 * 另一处静默落后，于是出现「卡片里能删、对话框里却不能」这种只能翻代码才解释得通的现象。
 * 因此它只接受「要渲染哪些密钥」，渲染进哪个容器由调用方决定。
 */
function credTableHtml(creds) {
  return `
    <table class="lk-table bm-table">
      <thead><tr>
        <th>服务商</th><th>密钥</th><th>访问密钥 ID</th><th>对普通用户</th><th>状态</th><th style="width:170px">限速</th><th style="width:${isAdmin() ? 300 : 100}px">操作</th>
      </tr></thead>
      <tbody>
        ${creds.map((c) => {
          const disabled = c.enabled === false;
          const name = c.remark || c.secretIdMasked;
          const pid = c.provider || 'tencent';
          const pm = providerMeta(pid);
          return `<tr data-id="${escapeHtml(c.id)}">
            <td class="lk-provider" title="${escapeHtml(pm.name)}">${escapeHtml(pm.name)}<i class="bk-sub">${escapeHtml(pm.shortName)}</i></td>
            <td class="lk-file" title="${escapeHtml(c.remark || '')}">${escapeHtml(name)}${c.remark ? `<i class="bk-sub">（${escapeHtml(c.secretIdMasked)}）</i>` : ''}</td>
            <td style="font-family:Consolas,monospace">${escapeHtml(c.secretIdMasked)}</td>
            <td>${c.visibleToUsers !== false ? '<span class="lk-badge ok">可见</span>' : '<span class="lk-badge">仅管理员</span>'}</td>
            <td>${disabled ? '<span class="lk-badge warn">已停用</span>' : '<span class="lk-badge ok">使用中</span>'}</td>
            <td class="lk-speed">${speedCellHtml('credential', c.id, c.speedLimit, isAdmin())}</td>
            <td class="lk-acts">
              ${isAdmin() ? `<button class="mini-btn" data-act="${disabled ? 'en' : 'dis'}" data-id="${escapeHtml(c.id)}">${disabled ? '启用' : '停用'}</button>` : ''}
              ${isAdmin() ? `<button class="mini-btn" data-act="vis" data-id="${escapeHtml(c.id)}">${c.visibleToUsers !== false ? '设为不可见' : '设为可见'}</button>
                <button class="mini-btn" data-act="edit" data-id="${escapeHtml(c.id)}">备注</button>
                <button class="mini-btn danger" data-act="del" data-id="${escapeHtml(c.id)}">删除</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody></table>`;
}

/**
 * 行内按钮绑定 —— 卡片与对话框共用（R36），否则对话框里的按钮会「看得见、点不动」。
 *
 * 写法与 `syssettings.js` 的 `bindUserRowActions` 严格同型：查询根节点上的
 * `[data-act]`（扁平）、id 由 `getAttribute('data-id')` 取 —— 因此每个行内按钮
 * **自己**带着 `data-id`（挂在 `<tr>` 上不够：扁平查询拿不到行元素）。
 * 四张卡片同一种写法，测试里的假 DOM 才能用同一套实现驱动它们。
 */
function bindCredRowActions(root, creds) {
  root.querySelectorAll('[data-act]').forEach((btn) => {
    const act = btn.getAttribute('data-act');
    const cred = creds.find((x) => x.id === btn.getAttribute('data-id'));
    if (!cred) return;
    btn.onclick = () => {
      if (act === 'vis') toggleVisibility(cred);
      else if (act === 'en') toggleEnabled(cred, true);
      else if (act === 'dis') toggleEnabled(cred, false);
      else if (act === 'edit') editRemark(cred);
      else if (act === 'speed') openSpeedLimitDialog({
        scope: 'credential', id: cred.id, name: cred.remark || cred.secretIdMasked,
        current: cred.speedLimit, onSaved: refresh,
      });
      else if (act === 'del') deleteCredential(cred);
    };
  });
}

/**
 * 「显示全部」按钮的显隐与提示文案（需求 2①）。
 *
 * 判据下沉到 `util.previewMoreState()`（四张卡片共用）—— 那里用的是**严格大于**：
 * 正好 10 个密钥时卡片已完整展示，再摆一个「显示全部」点开只能看到一字不差的副本。
 */
function updateCredMore(total) {
  const more = document.getElementById('cred-more');
  const hint = document.getElementById('cred-more-hint');
  const { over, hint: hintText } = previewMoreState(total, CRED_PREVIEW_LIMIT, '个密钥');
  if (more) more.hidden = !over;
  if (hint) hint.textContent = hintText;
}

/** 重绘「全部密钥」列表（对话框没开时是空操作） */
function repaintAllCreds() {
  if (credsDialog) credsDialog.repaint();
}

/**
 * 按关键词 / 服务商筛选密钥（R36 需求 2②）。
 *
 * 关键词的匹配范围取**卡片「密钥」列所显示的内容**：备注名，没有备注时就是访问密钥掩码 ——
 * 这样「屏幕上看得见的字」都能搜到。规则本身走 `util.matchesQuery()`（四张卡片同一条），
 * 不在这里另写一份，否则会出现「密钥列表能搜大写、桶列表搜不到」这种没人想到去核对的不一致。
 */
function filterCreds(list, query, provider) {
  const want = String(provider == null ? '' : provider).trim();
  return (Array.isArray(list) ? list : []).filter((c) => (!want || String((c && c.provider) || 'tencent') === want)
    && matchesQuery(query, [(c && c.remark) || '', (c && c.secretIdMasked) || '']));
}

/** 打开「全部密钥」对话框（需求 2②：服务商下拉筛选 + 搜索备注） */
function showAllCreds() {
  if (!isAdmin()) return;
  if (credsDialog) return; // 连点两次不得叠出第二层遮罩（句柄在 onClose 里复位）
  const creds = cache.credentials || [];
  credsDialog = openListDialog({
    idPrefix: 'cred-all',
    title: `全部密钥（共 ${creds.length} 个）`,
    placeholder: '搜索备注 / 访问密钥 ID（不区分大小写）',
    cls: 'cred-all-dialog', // 6 列表格要的宽度（见 style.css）
    unit: '个密钥',
    unitShort: '个',
    emptyAll: '尚未保存任何密钥',
    emptyMatch: '没有匹配的密钥',
    // 选项只列**数据集里真实出现过的**服务商，而不是把注册表 11 家全列出来 ——
    // 后者会给出大量「选了必然为空」的选项，用户会以为是自己筛错了。
    selects: [{
      id: 'provider',
      title: '按服务商筛选',
      value: '',
      options: providerSelectOptions(creds, providerMeta, '全部服务商'),
    }],
    items: () => cache.credentials || [],
    filter: (list, st) => filterCreds(list, st.query, st.filters.provider),
    // 卡片与对话框共用同一个表格渲染器与同一套行按钮绑定
    rowHtml: (shown) => credTableHtml(shown),
    bindRows: (list, shown) => bindCredRowActions(list, shown),
    onClose: () => { credsDialog = null; },
  });
}

/** 追加「添加密钥」表单（仅管理员可见） */
function renderAddForm(box) {
  if (!isAdmin()) return;
  const wrap = document.createElement('div');
  wrap.className = 'cred-add';
  /**
   * R30：厂商选项不再追加 `pv-opt--planned`。
   *
   * 那个 class 是「（即将支持）」角标的**唯一挂钩点**（角标文字由
   * `public/css/style.css` 的 `.pv-opt--planned .pv-name::after { content: … }` 生成）。
   * Microsoft Azure 正式接入后，注册表里已不存在 `kind === 'planned'` 的厂商，
   * 该样式规则也已随之删除 —— 保留这个钩子只会留下一个**永远为空的 class**：
   * 将来真按 `planned` 登记一家新厂商时，界面上不会有任何提示，排查者却会以为
   * 「角标逻辑还在，只是没生效」。故连同分支一起去掉；`kind` 仍是服务端注册表的
   * 字段（前端的 `providerSupported()` 读它），只是不再影响这里的 DOM。
   */
  wrap.innerHTML = `
    <div class="hr"></div>
    <div style="font-size:14px;font-weight:bold;color:var(--text-2);margin-bottom:8px">添加新密钥</div>
    <div class="form-item">
      <label>服务商<span class="req">*</span></label>
      <div class="pv-picker" role="radiogroup" aria-label="选择服务商">
        ${providerList().map((p) => `
          <label class="pv-opt" title="${escapeHtml(p.name)}">
            <input type="radio" name="cred-provider" value="${escapeHtml(p.id)}"${p.id === pickedProvider ? ' checked' : ''}>
            ${providerLogo(p.id, { size: 'lg' })}
            <span class="pv-name">${escapeHtml(p.name)}</span>
          </label>`).join('')}
      </div>
      <div class="hint" id="cred-provider-hint"></div>
    </div>
    <div class="form-row">
      <div class="form-item"><label id="cred-sid-label">访问密钥 ID<span class="req">*</span></label>
        <input type="text" id="cred-sid" placeholder="AKIDxxxxxxxxxxxxxxxxxxxxxx" autocomplete="off" spellcheck="false"></div>
      <div class="form-item"><label id="cred-skey-label">访问密钥 Secret<span class="req">*</span></label>
        <input type="password" id="cred-skey" placeholder="请输入访问密钥 Secret" autocomplete="new-password"></div>
      <div class="form-item"><label>备注名（可选）</label>
        <input type="text" id="cred-remark" placeholder="例如：主账号 / 子账号-只读" autocomplete="off" spellcheck="false"></div>
    </div>
    <div class="form-item" id="cred-endpoint-item" hidden>
      <label id="cred-endpoint-label">服务端点<span class="req">*</span></label>
      <input type="text" id="cred-endpoint" autocomplete="off" spellcheck="false">
      <div class="hint" id="cred-endpoint-hint"></div>
    </div>
    <div class="form-item">
      <label class="check-line"><input type="checkbox" id="cred-visible" checked>  对普通用户可见</label>
      <div class="hint">取消勾选后，该密钥仅管理员可见并使用；普通用户登录后无法看到或选择此密钥。</div>
    </div>
    <div class="form-item">
      <button class="mini-btn" id="cred-test">测试连接</button>
      <button class="mini-btn primary" id="cred-add">保存密钥</button>
      <span class="form-msg" id="cred-msg"></span>
    </div>`;
  box.appendChild(wrap);

  const msg = (text, cls) => {
    const m = wrap.querySelector('#cred-msg');
    if (!m) return;
    m.textContent = text;
    m.className = 'form-msg show ' + cls;
  };

  /**
   * 切换服务商后，同步密钥字段名、占位符与说明文案
   *
   * 「服务端点」这一栏**由厂商元数据驱动**，而不是恒显或恒隐：
   *  - `endpointMode='required'`（MinIO）→ 用户必须填写完整访问地址；
   *  - `endpointMode='template'`（Cloudflare R2）→ 用户填的是**账户 ID**，
   *    由服务端 `providers.composeEndpoint()` 拼成完整端点（前端只负责把原值送上去，
   *    绝不在这里拼 URL —— 拼装是唯一实现点，前端再拼一份就会与该实现分叉）；
   *  - `endpointMode='optional'`（Microsoft Azure，R30）→ 端点默认由**存储账户名**推导，
   *    该栏只是为「主权云 / 本地模拟器」留的覆盖口，因此渲染但**不加必填星号**；
   *  - 其余厂商端点由地域推导，**不渲染该栏**（隐藏时一并清空，避免残留值被提交）。
   * 标签文案里的「账户 ID / 服务端点」差异同样取自元数据（同源于服务端 registry）。
   */
  function syncProviderLabels() {
    const meta = providerMeta(pickedProvider);
    wrap.querySelector('#cred-sid-label').innerHTML = `${escapeHtml(meta.idLabel)}<span class="req">*</span>`;
    wrap.querySelector('#cred-skey-label').innerHTML = `${escapeHtml(meta.keyLabel)}<span class="req">*</span>`;
    wrap.querySelector('#cred-sid').placeholder = meta.idPlaceholder;
    wrap.querySelector('#cred-skey').placeholder = `请输入 ${meta.keyLabel}`;
    wrap.querySelector('#cred-provider-hint').textContent = meta.hint;

    const epItem = wrap.querySelector('#cred-endpoint-item');
    const epInput = wrap.querySelector('#cred-endpoint');
    const mode = meta.endpointMode || '';
    epItem.hidden = !mode;
    epInput.value = '';
    if (mode) {
      // 只有 required / template 才加必填星号（optional 的端点栏是覆盖口，留空合法）
      const required = mode === 'required' || mode === 'template';
      wrap.querySelector('#cred-endpoint-label').innerHTML =
        `${escapeHtml(meta.endpointLabel || '服务端点')}${required ? '<span class="req">*</span>' : ''}`;
      epInput.placeholder = meta.endpointPlaceholder || '';
      wrap.querySelector('#cred-endpoint-hint').textContent = meta.endpointHint || '';
    }
  }

  /** 该厂商是否**必须**填端点（optional 不算） */
  function endpointIsRequired() {
    const m = providerMeta(pickedProvider).endpointMode;
    return m === 'required' || m === 'template';
  }

  /** 读取当前应当提交的服务端点：该栏未渲染时提交 undefined（服务端按「未传即保持」处理） */
  function readEndpoint() {
    const meta = providerMeta(pickedProvider);
    if (!meta.endpointMode) return undefined;
    return wrap.querySelector('#cred-endpoint').value.trim();
  }

  wrap.querySelectorAll('input[name="cred-provider"]').forEach((radio) => {
    radio.onchange = () => { pickedProvider = radio.value; syncProviderLabels(); };
  });
  syncProviderLabels();

  wrap.querySelector('#cred-test').onclick = async () => {
    const sid = wrap.querySelector('#cred-sid').value.trim();
    const skey = wrap.querySelector('#cred-skey').value.trim();
    if (!sid || !skey) return msg('请先填写访问密钥', 'bad');
    const endpoint = readEndpoint();
    // R30：端点栏分「必填」与「可选」两种（Azure 的端点默认由账户名推导，留空合法）
    if (endpointIsRequired() && endpoint === '') return msg('请填写服务端点', 'bad');
    msg('正在验证…', 'info');
    try {
      const r = await API.verifyConfig({ provider: pickedProvider, secretId: sid, secretKey: skey, endpoint });
      msg(r.ok ? '✓ ' + r.message : '✗ ' + r.error, r.ok ? 'ok' : 'bad');
    } catch (e) { msg(e.message, 'bad'); }
  };
  wrap.querySelector('#cred-add').onclick = async () => {
    const sid = wrap.querySelector('#cred-sid').value.trim();
    const skey = wrap.querySelector('#cred-skey').value.trim();
    const remark = wrap.querySelector('#cred-remark').value.trim();
    const visibleToUsers = wrap.querySelector('#cred-visible').checked;
    if (!sid || !skey) return msg('请填写访问密钥', 'bad');
    const endpoint = readEndpoint();
    if (endpointIsRequired() && endpoint === '') return msg('请填写服务端点', 'bad');
    try {
      await API.addCredential({ provider: pickedProvider, secretId: sid, secretKey: skey, remark, visibleToUsers, endpoint });
      msg('✓ 密钥已加密保存并启用', 'ok');
      refresh();
      /**
       * R29-02：新增密钥会改变**全局**配置 —— 最典型的是「首次添加密钥」把 `configured`
       * 从 false 翻成 true：侧边栏仍写着「请先在设置中配置访问密钥」、文件区也不发列举请求，
       * 不按 F5 就一直不对。存储桶弹窗的「访问密钥」下拉同样读 `App.state.config`。
       * 这里走**全局刷新**（配置 + 目录树 + 文件列表）。
       */
      App.onConfigChanged();
    } catch (e) { msg(e.message, 'bad'); }
  };
}

async function toggleVisibility(cred) {
  const want = cred.visibleToUsers === false;
  try {
    await API.updateCredential(cred.id, { visibleToUsers: want });
    toast(`该密钥已${want ? '对普通用户可见' : '设为仅管理员可见'}`, { type: 'success' });
    refresh();
    App.reloadConfig(); // R29-02：可见性存在全局配置快照里（仅刷新配置，不动文件列表）
  } catch (e) { toast('设置失败：' + e.message, { type: 'error' }); }
}

async function toggleEnabled(cred, want) {
  const label = want ? '启用' : '停用';
  const ok = await confirmDialog({ allowHtml: true,
    title: `${label}密钥`,
    message: want
      ? `确定<b>启用</b>密钥「${escapeHtml(cred.remark || cred.secretIdMasked)}」吗？<br><span style="color:var(--text-2)">启用后即可用于访问其绑定的存储桶（无需再手动切换）。</span>`
      : `确定<b>停用</b>密钥「${escapeHtml(cred.remark || cred.secretIdMasked)}」吗？<br><span style="color:var(--text-2)">停用后该密钥将<b>自动设为「仅管理员可见」</b>，并停止用于访问存储桶。</span>`,
    okText: label, danger: !want,
  });
  if (!ok) return;
  try {
    await API.updateCredential(cred.id, { enabled: want });
    toast(`密钥已${label}${!want ? '，同时设为仅管理员可见' : ''}`, { type: 'success' });
    App.refreshStorage();
    refresh();
    /**
     * R29-02：启停密钥会改变**生效配置**（服务端按「同厂商启用密钥」回退），因此
     * 侧边栏桶列表、状态栏与文件区都必须重新取数 —— 单靠本卡片的 `refresh()` 不够。
     */
    App.onConfigChanged();
  } catch (e) { toast(`${label}失败：` + e.message, { type: 'error' }); }
}

async function editRemark(cred) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item">
      <label>备注名</label>
      <input type="text" id="cred-edit-remark" class="full" value="${escapeHtml(cred.remark || '')}" autocomplete="off" spellcheck="false" maxlength="100">
    </div>`;
  openModal({
    title: '修改密钥备注', body: wrap,
    foot: [
      { text: '取消' },
      { text: '保存', cls: 'primary', onClick: async (o, close) => {
        const remark = wrap.querySelector('#cred-edit-remark').value.trim();
        try {
          await API.updateCredential(cred.id, { remark });
          close();
          toast('备注已更新', { type: 'success' });
          refresh();
          // R29-02：备注名会出现在存储桶弹窗的密钥下拉里（`App.state.config.credentials`）
          App.reloadConfig();
        } catch (e) { toast('保存失败：' + e.message, { type: 'error' }); }
      } },
    ],
  });
}

async function deleteCredential(cred) {
  const ok = await confirmDialog({ allowHtml: true,
    title: '删除密钥',
    message: `确定删除密钥 <b>${escapeHtml(cred.remark || cred.secretIdMasked)}</b> 吗？<br><span style="color:var(--text-2)">仅从本地删除；删除后绑定该密钥的存储桶将回退使用同厂商的其他启用密钥。</span>`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteCredential(cred.id);
    toast('密钥已删除', { type: 'success' });
    refresh();
    App.onConfigChanged(); // R29-02：删掉服务当前桶的那把密钥 → 生效配置随之改变
  } catch (e) { toast('删除失败：' + e.message, { type: 'error' }); }
}

async function saveDomain() {
  const primary = (document.getElementById('credmgr-domain-1') || {}).value || '';
  const backup = (document.getElementById('credmgr-domain-2') || {}).value || '';
  try {
    await API.saveConfig({ domains: { primary: primary.trim(), backup: backup.trim() } });
    domainCache = { primary: primary.trim(), backup: backup.trim() };
    toast('自定义域名已保存', { type: 'success' });
    App.reloadConfig(); // R29-02：域名同样在全局配置快照里（影响站点地址 / rpId 的展示）
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error' });
  }
}