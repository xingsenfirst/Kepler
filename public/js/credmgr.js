/** 密钥管理页 —— 访问密钥（共享/可见性）/ 自定义域名 / 连接验证 */
import { API } from './api.js';
import { toast, confirmDialog, openModal, escapeHtml } from './util.js';
import { App } from './main.js';
import { providerList, providerLogo, providerMeta } from './provider-logos.js';

let wired = false;
let cache = { credentials: [], activeCredentialId: '' };
let domainCache = { primary: '', backup: '' };
/** 添加密钥表单中当前选中的服务商（默认腾讯云，与服务端默认值保持一致） */
let pickedProvider = 'tencent';

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
    renderAddForm(box);
    return;
  }
  box.innerHTML = `
    <table class="lk-table bm-table">
      <thead><tr>
        <th>服务商</th><th>密钥</th><th>访问密钥 ID</th><th>对普通用户</th><th>状态</th><th style="width:${isAdmin() ? 300 : 120}px">操作</th>
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
            <td class="lk-acts">
              ${isAdmin() ? `<button class="mini-btn" data-act="${disabled ? 'en' : 'dis'}">${disabled ? '启用' : '停用'}</button>` : ''}
              ${isAdmin() ? `<button class="mini-btn" data-act="vis">${c.visibleToUsers !== false ? '设为不可见' : '设为可见'}</button>
                <button class="mini-btn" data-act="edit">备注</button>
                <button class="mini-btn danger" data-act="del">删除</button>` : ''}
            </td>
          </tr>`;
        }).join('')}
      </tbody></table>`;

  box.querySelectorAll('tr[data-id]').forEach((tr) => {
    const cred = creds.find((x) => x.id === tr.dataset.id);
    if (!cred) return;
    tr.querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const act = btn.dataset.act;
        if (act === 'vis') toggleVisibility(cred);
        else if (act === 'en') toggleEnabled(cred, true);
        else if (act === 'dis') toggleEnabled(cred, false);
        else if (act === 'edit') editRemark(cred);
        else if (act === 'del') deleteCredential(cred);
      };
    });
  });

  renderAddForm(box);
}

/** 追加「添加密钥」表单（仅管理员可见） */
function renderAddForm(box) {
  if (!isAdmin()) return;
  const wrap = document.createElement('div');
  wrap.className = 'cred-add';
  wrap.innerHTML = `
    <div class="hr"></div>
    <div style="font-size:14px;font-weight:bold;color:var(--text-2);margin-bottom:8px">添加新密钥</div>
    <div class="form-item">
      <label>服务商<span class="req">*</span></label>
      <div class="pv-picker" role="radiogroup" aria-label="选择服务商">
        ${providerList().map((p) => `
          <label class="pv-opt${p.kind === 'planned' ? ' pv-opt--planned' : ''}" title="${escapeHtml(p.name)}">
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

  /** 切换服务商后，同步密钥字段名、占位符与说明文案 */
  function syncProviderLabels() {
    const meta = providerMeta(pickedProvider);
    wrap.querySelector('#cred-sid-label').innerHTML = `${escapeHtml(meta.idLabel)}<span class="req">*</span>`;
    wrap.querySelector('#cred-skey-label').innerHTML = `${escapeHtml(meta.keyLabel)}<span class="req">*</span>`;
    wrap.querySelector('#cred-sid').placeholder = meta.idPlaceholder;
    wrap.querySelector('#cred-skey').placeholder = `请输入 ${meta.keyLabel}`;
    wrap.querySelector('#cred-provider-hint').textContent = meta.hint;
  }

  wrap.querySelectorAll('input[name="cred-provider"]').forEach((radio) => {
    radio.onchange = () => { pickedProvider = radio.value; syncProviderLabels(); };
  });
  syncProviderLabels();

  wrap.querySelector('#cred-test').onclick = async () => {
    const sid = wrap.querySelector('#cred-sid').value.trim();
    const skey = wrap.querySelector('#cred-skey').value.trim();
    if (!sid || !skey) return msg('请先填写访问密钥', 'bad');
    msg('正在验证…', 'info');
    try {
      const r = await API.verifyConfig({ provider: pickedProvider, secretId: sid, secretKey: skey });
      msg(r.ok ? '✓ ' + r.message : '✗ ' + r.error, r.ok ? 'ok' : 'bad');
    } catch (e) { msg(e.message, 'bad'); }
  };
  wrap.querySelector('#cred-add').onclick = async () => {
    const sid = wrap.querySelector('#cred-sid').value.trim();
    const skey = wrap.querySelector('#cred-skey').value.trim();
    const remark = wrap.querySelector('#cred-remark').value.trim();
    const visibleToUsers = wrap.querySelector('#cred-visible').checked;
    if (!sid || !skey) return msg('请填写访问密钥', 'bad');
    try {
      await API.addCredential({ provider: pickedProvider, secretId: sid, secretKey: skey, remark, visibleToUsers });
      msg('✓ 密钥已加密保存并启用', 'ok');
      refresh();
    } catch (e) { msg(e.message, 'bad'); }
  };
}

async function toggleVisibility(cred) {
  const want = cred.visibleToUsers === false;
  try {
    await API.updateCredential(cred.id, { visibleToUsers: want });
    toast(`该密钥已${want ? '对普通用户可见' : '设为仅管理员可见'}`, { type: 'success' });
    refresh();
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
  } catch (e) { toast('删除失败：' + e.message, { type: 'error' }); }
}

async function saveDomain() {
  const primary = (document.getElementById('credmgr-domain-1') || {}).value || '';
  const backup = (document.getElementById('credmgr-domain-2') || {}).value || '';
  try {
    await API.saveConfig({ domains: { primary: primary.trim(), backup: backup.trim() } });
    domainCache = { primary: primary.trim(), backup: backup.trim() };
    toast('自定义域名已保存', { type: 'success' });
  } catch (e) {
    toast('保存失败：' + e.message, { type: 'error' });
  }
}