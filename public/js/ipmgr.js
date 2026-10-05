/**
 * IP 地址管理页（R37）
 *
 * ## 这一页从哪来
 *
 * 「IP 访问屏蔽」原先挂在「存储桶管理」页里（`bucketmgr.js`），但它的规则是
 * **全局 / 桶级两级**的，与「存储桶」这个实体并没有绑定关系 —— 放在桶页里，
 * 用户要为「屏蔽一个 IP」先进入存储桶页，语义上也不成立。R37 把它整体迁到这里，
 * 与新增的「IP 地址限速」并列，两张卡片共用**同一份规则表**（`/api/ipguard`）。
 *
 * ## 屏蔽与限速为什么共用一张规则表
 *
 * 两者除了「命中后做什么」之外，其余判定完全相同：CIDR 匹配、作用范围（全局 / 桶级）、
 * 请求方法过滤、启用状态。若各存一份表、各写一套匹配，就会出现「同一个 IP 段里，
 * 屏蔽规则的部分与限速规则的部分各判各的」——`ip-guard.js` 因此用一条规则上的
 * `kind` 字段承载类型，并用 `matchRules`（只认 `block`）/ `speedLimitFor`（只认 `speed`）
 * 两个互斥的判据分别求值（见那里的 `RULE_KINDS` 注释）。
 * 本页的两张卡片只是把同一份数据**按类型分成两栏展示**。
 *
 * ## 管理员专属
 *
 * 规则详情含其它用户的来源 IP，且增删改与预检全部是管理员专属，因此整页仅管理员可见：
 * 导航按钮与两张卡片由 `main.js` 的**角色权威渲染点**（`renderUserMenu`）统一 `hidden`，
 * 数据侧 `refreshIpGuard()` 发现卡片已隐藏就**直接返回、不发请求**（否则普通用户
 * 每次切页都会收到 403 噪音）。
 */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml, fmtTime } from './util.js';
import { buildTransferBox } from './listdialog.js';
import { App } from './main.js';
// R37：IP 限速值也用 MB/s 输入（与四张列表卡片的限速对话框同一套换算与校验）
import { parseMbpsInput, toMBps, speedText } from './speedlimit.js';

let wired = false;
/** 最近一次拉到的规则集（`{ rules, chinaRangeCount, methods }`）；两张卡片共用 */
let ipCache = null;

/** 渲染期角色判断（真正的强制校验在服务端；此处仅避免发起注定 403 的请求与闪现错误） */
function isAdmin() {
  return !!(App.state.user && App.state.user.role === 'admin');
}

/* ============================== 页面级入口 ============================== */

/** 切到本页时调用（main.js 的 switchMainView） */
export function refresh() {
  refreshIpGuard();
}

/** 登出 / 换账号时调用：丢弃上一个账号的规则缓存（规则详情含他人 IP） */
export function reset() {
  ipCache = null;
}

function wire() {
  if (wired) return;
  wired = true;
  const rfIp = document.getElementById('btn-ipguard-refresh');
  if (rfIp) rfIp.onclick = () => refreshIpGuard();
  const addIp = document.getElementById('btn-ipguard-add');
  if (addIp) addIp.onclick = () => openIpRuleDialog(null, 'block');
  const rfSp = document.getElementById('btn-ipspeed-refresh');
  if (rfSp) rfSp.onclick = () => refreshIpGuard();
  const addSp = document.getElementById('btn-ipspeed-add');
  if (addSp) addSp.onclick = () => openIpRuleDialog(null, 'speed');
  const testBtn = document.getElementById('btn-ipguard-test');
  if (testBtn) testBtn.onclick = testIpBlocked;
}

/* ============================== 作用范围 ============================== */

/** 本地已绑定存储桶列表（用于作用范围穿梭框 / 预检下拉框） */
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

/* ============================== 规则列表 ============================== */

/**
 * 规则表格 HTML —— 屏蔽卡片与限速卡片共用的渲染器（只有「限速」一列有无之分）。
 *
 * @param {Array} rules 已经按 `kind` 过滤好的规则
 * @param {boolean} withSpeed 是否显示「限速」列（限速卡片为真）
 */
function ruleTableHtml(rules, withSpeed) {
  return `<table class="lk-table ipg-table">
    <thead><tr>
      <th>IP / IP 段</th><th>作用范围</th><th>请求方法</th>${withSpeed ? '<th>限速</th>' : ''}<th>备注</th><th>状态</th><th>命中</th><th>创建时间</th><th style="width:190px">操作</th>
    </tr></thead>
    <tbody>
      ${rules.map((r) => `<tr data-id="${escapeHtml(r.id)}">
        <td class="lk-file" style="font-family:Consolas,monospace">${escapeHtml(r.target)}</td>
        <td>${scopeCell(r)}</td>
        <td>${r.methods && r.methods.length ? r.methods.map((m) => `<span class="ipg-method${['PUT', 'POST', 'DELETE'].includes(m) ? ' m-write' : ''}">${m}</span>`).join(' ') : '<span class="bk-sub">全部方法</span>'}</td>
        ${withSpeed ? `<td><span class="lk-badge warn">${escapeHtml(speedText(r.speedLimit))}</span></td>` : ''}
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
}

/** 绑定某张卡片表格里的行内按钮（屏蔽卡与限速卡各绑各的，避免互相串到对方的数据上） */
function bindRuleRowActions(box, rules) {
  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const rule = rules.find((x) => x.id === tr.dataset.id);
    if (!rule) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'toggle') toggleIpRule(rule);
        else if (act === 'edit') openIpRuleDialog(rule, rule.kind || 'block');
        else if (act === 'del') deleteIpRule(rule);
      };
    });
  });
}

/**
 * 拉取规则并分别渲染两张卡片。
 *
 * 一次请求填两栏（同一份数据）：分成两个接口就是同一份状态的**两条读路径**，
 * 一张卡片刷新后另一张还停在旧数据上，属于本项目反复修掉的失效模式。
 */
async function refreshIpGuard() {
  wire();
  // 整页仅管理员：角色不符或卡片已隐藏时**既不渲染也不发请求**
  //（否则普通用户每次切页都会收到 403 噪音，界面还会闪现一句「加载失败」）
  if (!isAdmin()) return;
  const card = document.getElementById('ipguard-card');
  if (card && card.hidden) return;
  const box = document.getElementById('ipguard-table');
  const spBox = document.getElementById('ipspeed-table');
  if (!box && !spBox) return;
  rebuildTestScope();

  let d;
  try {
    d = await API.ipGuard();
  } catch (e) {
    if (box) box.innerHTML = `<div class="lk-empty">IP 规则加载失败：${escapeHtml(e.message)}</div>`;
    if (spBox) spBox.innerHTML = '';
    return;
  }
  ipCache = d;
  /**
   * ⚠️ 历史数据没有 `kind` 字段（R37 之前只有屏蔽规则），这里按 `'block'` 兜底 ——
   * 与服务端 `ip-guard.load()` 的归一化同口径。**不能**写成 `kind !== 'speed'` 之外的
   * 宽松判据后又依赖别处已归一化，那样两边只要有一处漏改就会分栏错位。
   */
  const all = d.rules || [];
  const blocks = all.filter((r) => (r.kind || 'block') === 'block');
  const speeds = all.filter((r) => r.kind === 'speed');

  const count = document.getElementById('ipguard-count');
  if (count) count.textContent = blocks.length ? `（${blocks.length} 条规则）` : '';
  const spCount = document.getElementById('ipspeed-count');
  if (spCount) spCount.textContent = speeds.length ? `（${speeds.length} 条规则）` : '';

  if (box) {
    if (!blocks.length) {
      box.innerHTML = '<div class="lk-empty">尚无屏蔽规则。点击右上角「＋ 添加屏蔽规则」。按桶屏蔽海外 IP 请在「存储桶管理」表格中勾选对应列。</div>';
    } else {
      box.innerHTML = ruleTableHtml(blocks, false);
      bindRuleRowActions(box, blocks);
    }
  }
  if (spBox) {
    if (!speeds.length) {
      spBox.innerHTML = '<div class="lk-empty">尚无限速规则。点击右上角「＋ 添加限速规则」，对固定 IP 或 CIDR 地址段设置下载限速。</div>';
    } else {
      spBox.innerHTML = ruleTableHtml(speeds, true);
      bindRuleRowActions(spBox, speeds);
    }
  }
}

async function toggleIpRule(rule) {
  const what = rule.kind === 'speed' ? '限速' : '屏蔽';
  try {
    await API.toggleIpRule(rule.id, !rule.enabled);
    toast(`规则 ${rule.target} 已${rule.enabled ? '禁用' : '启用'}（${what}）`, { type: 'success' });
    refreshIpGuard();
  } catch (e) { toast('操作失败：' + e.message, { type: 'error' }); }
}

async function deleteIpRule(rule) {
  const what = rule.kind === 'speed' ? '限速' : '屏蔽';
  const tail = rule.kind === 'speed'
    ? '删除后该 IP / IP 段不再受本条限速约束（若被其它限速规则覆盖则仍会限速）。'
    : '删除后该 IP / IP 段将不再被此规则屏蔽（若被桶级「屏蔽海外 IP」或其他规则覆盖则仍会被屏蔽）。';
  const ok = await confirmDialog({ allowHtml: true,
    title: `删除${what}规则`,
    message: `确定删除${what}规则 <b style="font-family:Consolas,monospace">${escapeHtml(rule.target)}</b> 吗？<br><span style="color:var(--text-2)">${tail}</span>`,
    okText: '删除', danger: true,
  });
  if (!ok) return;
  try {
    await API.deleteIpRule(rule.id);
    toast('规则已删除', { type: 'success' });
    refreshIpGuard();
  } catch (e) { toast('删除失败：' + e.message, { type: 'error' }); }
}

/* ============================== 规则弹窗 ============================== */

/**
 * 添加 / 编辑规则弹窗（作用范围用穿梭框多选桶；右列留空 = 全局）。
 *
 * `kind` 决定这是「屏蔽」还是「限速」规则：
 *  - 屏蔽：不进 `speedLimit`，命中即 403；
 *  - 限速：必须填速率（MB/s），命中后**不拦截**，只把下载速率压到该值。
 *
 * 两者共用同一个弹窗而不是各写一个：字段（目标 / 作用范围 / 方法 / 备注）完全重合，
 * 各写一份必然出现「限速弹窗忘了校验 IP 格式」这类分叉。差异只有「限速值」一项。
 *
 * @param {object|null} existing 编辑时传原规则，新增传 null
 * @param {'block'|'speed'} kind 类型（编辑时以规则自身为准）
 */
function openIpRuleDialog(existing, kind) {
  const type = (existing && existing.kind) || kind || 'block';
  const isSpeed = type === 'speed';
  const methods = (existing && existing.methods) || [];
  const existingBids = (existing && existing.bucketIds) || [];
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="form-item">
      <label>IP 地址或 IP 段（CIDR） *</label>
      <input type="text" id="ipg-target" class="full" placeholder="如 1.2.3.4（单个 IP）或 10.0.0.0/8（IP 段）" value="${escapeHtml(existing ? existing.target : '')}" autocomplete="off" spellcheck="false">
      <div class="hint">单 IP 示例：<code>203.0.113.7</code>；IP 段示例：<code>203.0.113.0/24</code>（作用于该段全部 256 个地址）。</div>
    </div>
    ${isSpeed ? `
    <div class="form-item">
      <label>下载限速（MB/s） *</label>
      <input type="number" id="ipg-speed" class="full" min="0" step="0.1" placeholder="如 5" value="${escapeHtml(existing && existing.speedLimit ? String(toMBps(existing.speedLimit)) : '')}" autocomplete="off">
      <div class="hint">命中该 IP / IP 段的<b>下载</b>会被压到该速率（按 IP 段<b>聚合</b>：段内多台设备共享这份带宽）。填 <b>0</b> 表示不限速 —— 那这条规则就不起作用，建议改用「禁用」而不是填 0。<br>限速规则<b>不会拦截</b>请求（与上面的屏蔽规则互斥），因此它不会影响上传、列表等其它操作。</div>
    </div>` : ''}
    <div class="form-item">
      <label>作用范围 *</label>
      <div class="ipg-scope-box"></div>
      <div class="hint">右侧<b>留空 = 全局</b>（对该服务接收到的所有请求生效）；把桶移到右侧 = 仅当访问目标为这些桶时生效（可多选）。桶级规则优先、全局规则其次，两者独立、叠加生效。</div>
    </div>
    <div class="form-item">
      <label>${isSpeed ? '限速适用的请求方法（不勾选 = 全部方法）' : '屏蔽的请求方法（不勾选 = 屏蔽全部方法）'}</label>
      <div class="ipg-methods">
        ${['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].map((m) => `
          <label class="check-line"><input type="checkbox" value="${m}" ${methods.includes(m) ? 'checked' : ''}>${m}</label>`).join('')}
      </div>
      <div class="hint">${isSpeed
        ? '下载走 GET / HEAD；不勾选表示对所有方法都限制速率。'
        : '例如仅勾选 PUT / POST / DELETE → 屏蔽该 IP 的写操作，但放行其读取与下载。'}</div>
    </div>
    <div class="form-item">
      <label>备注（可选）</label>
      <input type="text" id="ipg-remark" class="full" placeholder="${isSpeed ? '如：爬虫限速' : '如：恶意刷量来源'}" value="${escapeHtml(existing ? existing.remark || '' : '')}" maxlength="100">
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

  const kindName = isSpeed ? '限速' : '屏蔽';
  openModal({
    title: existing ? `编辑${kindName}规则 — ${existing.target}` : `添加 IP ${kindName}规则`,
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
        // 限速值走与四张列表卡片同一个校验（非法值必须当场报错，绝不静默归一化成 0 = 不限速）
        let speedLimit;
        if (isSpeed) {
          const r = parseMbpsInput(wrap.querySelector('#ipg-speed').value);
          if (!r.ok) return toast(r.error, { type: 'warn' });
          if (r.bytes <= 0) return toast('请填写大于 0 的限速值（不限制速的规则不会生效）', { type: 'warn' });
          speedLimit = r.bytes;
        }
        const payload = { target, remark, methods: sel, bucketIds, kind: type };
        if (isSpeed) payload.speedLimit = speedLimit;
        try {
          if (existing) await API.updateIpRule(existing.id, payload);
          else await API.addIpRule(payload);
          toast(existing ? '规则已更新' : `规则已添加并生效（IP ${kindName}）`, { type: 'success' });
          close();
          refreshIpGuard();
        } catch (e) {
          toast('保存失败：' + e.message, { type: 'error' });
        }
      } },
    ],
  });
  setTimeout(() => {
    const t = wrap.querySelector('#ipg-target');
    if (t) t.focus();
  }, 50);
}

/**
 * 规则预检：检测某 IP + 方法 + 作用范围是否会被屏蔽**以及**是否会被限速。
 *
 * 两件事必须一次答清（见 `server/routes/ipguard.js` 的说明）：两类规则互斥，
 * 只报屏蔽结果会让「刚加的限速规则」看起来没生效。
 */
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
    const speed = r.speedRule ? `；受限速规则 ${r.speedRule.target} 限制为 ${toMBps(r.speedRule.bytesPerSec)} MB/s` : '';
    if (r.allowed) {
      out.textContent = `✓ ${ip}（${r.method}）未被屏蔽，可正常访问${speed}`;
      out.className = r.speedRule ? 'ipg-test-warn' : 'ipg-test-ok';
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
