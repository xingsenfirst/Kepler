/** 文件操作 —— 新建 / 重命名 / 移动 / 删除 / 下载 / 复制链接 */
import { API } from './api.js';
import { toast, confirmDialog, promptDialog, openModal, escapeHtml, fmtSize, fmtTime } from './util.js';
import { App } from './main.js';
import { openDownload } from './enc.js';

export const ops = {
  needConfig() {
    const isAdmin = App.state.user && App.state.user.role === 'admin';
    if (isAdmin) {
      toast('请先在密钥管理中配置访问密钥与存储桶', { type: 'warn' });
      import('./settings.js').then((m) => m.settings.open());
    } else {
      toast('尚未配置访问密钥，请联系管理员', { type: 'warn' });
    }
  },

  async newFolder() {
    if (!configured()) return this.needConfig();
    const name = await promptDialog({
      title: '新建文件夹', label: '文件夹名称',
      hint: '支持多级创建：输入 a/b/c 将逐级创建',
    });
    if (!name) return;
    if (/[\\:*?"<>|]/.test(name)) return toast('名称不能包含 \\ / : * ? " < > | 字符', { type: 'error' });
    try {
      // 多级创建：逐级 mkdir
      const parts = name.split('/').filter(Boolean);
      let cur = App.state.prefix;
      for (const p of parts) {
        await API.mkdir(cur + p + '/');
        cur += p + '/';
      }
      toast('文件夹已创建', { type: 'success' });
      refreshTree();
      explorerRefresh();
    } catch (e) {
      toast(e.message, { type: 'error' });
    }
  },

  renameSelected() {
    const s = App.state.selection;
    if (s.size !== 1) return;
    this.renameOne([...s][0]);
  },

  async renameOne(key) {
    const item = currentItems().find((i) => i.key === key);
    const oldName = key.endsWith('/') ? key.slice(0, -1).split('/').pop() : key.split('/').pop();
    const name = await promptDialog({ title: '重命名', label: '新名称', value: oldName });
    if (!name || name === oldName) return;
    if (/[\\/:*?"<>|]/.test(name)) return toast('名称不能包含 \\ / : * ? " < > | 字符', { type: 'error' });
    try {
      toast('正在重命名…');
      await API.rename(key, name, item ? item.size : 0);
      toast('重命名完成', { type: 'success' });
      refreshTree();
      explorerRefresh();
    } catch (e) {
      toast('重命名失败：' + e.message, { type: 'error' });
    }
  },

  deleteSelected() { this.deleteKeys([...App.state.selection]); },

  async deleteKeys(keys) {
    if (!keys.length) return;
    if (!configured()) return this.needConfig();
    const desc = keys.length === 1
      ? `“${escapeHtml(displayName(keys[0]))}”`
      : `${keys.length} 项（含其内部全部内容）`;
    const ok = await confirmDialog({ allowHtml: true,
      title: '确认删除',
      message: `确定要永久删除 ${desc} 吗？<br><b style="color:var(--danger)">删除后无法恢复。</b>`,
      okText: '永久删除', danger: true,
    });
    if (!ok) return;
    try {
      toast('正在删除…');
      const r = await API.del(keys);
      const failed = (r.results || []).filter((x) => !x.ok);
      if (failed.length) toast(`删除完成，${failed.length} 项失败：${failed[0].error}`, { type: 'warn', duration: 6000 });
      else toast(`已删除（共 ${r.deleted} 个对象）`, { type: 'success' });
      App.state.selection.clear();
      explorer.updateOpsButtons && explorer.updateOpsButtons();
      refreshTree();
      explorerRefresh();
      App.refreshStorage && App.refreshStorage(); // 立即刷新状态栏存储用量
    } catch (e) {
      toast('删除失败：' + e.message, { type: 'error' });
    }
  },

  moveSelected() { this.moveKeysTo([...App.state.selection]); },

  moveKeysTo(keys, fixedTarget) {
    if (!keys.length) return;
    if (!configured()) return this.needConfig();
    openFolderPicker({
      title: `移动 ${keys.length} 项到…`,
      confirmText: '移动',
      fixedTarget,
      exclude: keys,
      onPick: async (targetPrefix) => {
        try {
          toast('正在移动…');
          const r = await API.move(keys, targetPrefix);
          const failed = (r.results || []).filter((x) => !x.ok);
          if (failed.length) toast(`移动完成，${failed.length} 项失败：${failed[0].error}`, { type: 'warn', duration: 6000 });
          else toast('移动完成', { type: 'success' });
          App.state.selection.clear();
          explorer.updateOpsButtons && explorer.updateOpsButtons();
          refreshTree();
          explorerRefresh();
        } catch (e) {
          toast('移动失败：' + e.message, { type: 'error' });
        }
      },
    });
  },

  downloadSelected() { this.downloadKeys([...App.state.selection]); },

  downloadKeys(keys) {
    const files = keys.filter((k) => !k.endsWith('/'));
    if (!files.length) return toast('文件夹不支持直接下载，请选择文件', { type: 'warn' });
    if (files.length > 5) {
      toast(`将依次下载 ${files.length} 个文件，请在浏览器下载提示中确认`, { type: 'info', duration: 5000 });
    }
    files.forEach((k, i) => {
      setTimeout(() => openDownload(k), i * 600); // 加密文件自动先验证权限并携带令牌
    });
  },

  copyLinkSelected() { this.copyLinkKeys([...App.state.selection]); },

  /** 创建分享链接（有效期 / 次数 / 密码可任意组合；也可生成预签名直链） */
  async copyLinkKeys(keys) {
    if (keys.length !== 1) return toast('请选择单个对象创建链接', { type: 'warn' });
    const key = keys[0];
    if (key.endsWith('/')) return toast('暂不支持分享文件夹，请选择文件', { type: 'warn' });

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="form-item"><label>文件</label>
        <div class="hint" style="word-break:break-all">${escapeHtml(key)}</div></div>
      <div class="form-item"><label>链接类型</label>
        <div class="link-type-row">
          <label class="radio-line"><input type="radio" name="lk-type" value="managed" checked>  托管链接<i class="rl-sub"> · 支持有效期 / 次数 / 密码，访问者经本服务下载</i></label>
          <label class="radio-line"><input type="radio" name="lk-type" value="direct">  预签名直链<b>（高危）</b><i class="rl-sub"> · 不经过本服务，仅支持有效期</i></label>
        </div></div>
      <div class="form-item"><label>链接有效时间</label>
        <select id="lk-expires" class="full">
          <option value="1">1 小时</option>
          <option value="24">1 天</option>
          <option value="168" selected>7 天</option>
          <option value="720">30 天</option>
          <option value="0">永久有效</option>
        </select>
        <div class="hint">到期后链接自动失效，访问时提示"链接已过期"。</div></div>
      <div id="lk-managed-fields">
        <div class="form-item"><label>可下载次数</label>
          <input id="lk-count" type="number" min="0" step="1" value="0" placeholder="0">
          <div class="hint">允许的最大下载次数，达到上限后链接自动关闭；填 0 表示不限制。</div></div>
        <div class="form-item"><label>访问密码</label>
          <label class="check-line"><input id="lk-pw-on" type="checkbox">  启用密码保护</label>
          <input id="lk-pw" type="text" maxlength="64" placeholder="访问者需输入此密码才能下载" disabled autocomplete="off">
          <div class="hint">启用后，访问者需输入正确密码方可下载。</div></div>
        <div class="form-item"><label>付费下载</label>
          <label class="check-line"><input id="lk-paid-on" type="checkbox">  需要付费后才能下载</label>
          <div id="lk-paid-row" style="display:none;margin-top:8px">
            <input id="lk-paid-amount" type="number" min="0.01" step="0.01" value="1.00" placeholder="1.00">
            <div class="hint">当前仅支持人民币（CNY），最低 <b>0.01</b> 元。下载者完成支付后方可取得下载权限；未支付、支付中或支付失败时会被拦截并给出提示。</div>
          </div></div>
      </div>`;

    const expiresSel = wrap.querySelector('#lk-expires');
    const countInput = wrap.querySelector('#lk-count');
    const pwOn = wrap.querySelector('#lk-pw-on');
    const pwInput = wrap.querySelector('#lk-pw');
    const paidOn = wrap.querySelector('#lk-paid-on');
    const paidRow = wrap.querySelector('#lk-paid-row');
    const paidAmount = wrap.querySelector('#lk-paid-amount');
    const managedFields = wrap.querySelector('#lk-managed-fields');
    pwOn.addEventListener('change', () => { pwInput.disabled = !pwOn.checked; if (pwOn.checked) pwInput.focus(); });
    paidOn.addEventListener('change', () => {
      paidRow.style.display = paidOn.checked ? '' : 'none';
      if (paidOn.checked) paidAmount.focus();
    });
    wrap.querySelectorAll('input[name=lk-type]').forEach((r) => {
      r.addEventListener('change', () => {
        const direct = wrap.querySelector('input[name=lk-type]:checked').value === 'direct';
        managedFields.style.display = direct ? 'none' : '';
        if (direct) expiresSel.value = expiresSel.value === '0' ? '168' : expiresSel.value; // 直链不支持永久
        expiresSel.querySelector('option[value="0"]').disabled = direct;
      });
    });

    const modal = openModal({
      title: '创建分享链接', body: wrap,
      foot: [
        { text: '取消' },
        { text: '生成链接', cls: 'primary', onClick: async (o, close) => {
          const hours = Number(expiresSel.value) || 0;
          const direct = wrap.querySelector('input[name=lk-type]:checked').value === 'direct';
          try {
            if (direct) {
              const r = await API.presign(key, hours || 3600);
              const cfg = App.state.config || {};
              let url = r.url;
              const domain = cfg.domains && cfg.domains.primary;
              if (domain) {
                try {
                  const u = new URL(url);
                  url = 'https://' + domain.replace(/^https?:\/\//, '') + u.pathname + u.search;
                } catch (e) { /* 保持原地址 */ }
              }
              close();
              showLinkResult(url, { direct: true, hours });
              return;
            }
            const body = { path: key, expiresHours: hours || null };
            // 次数校验
            const cnt = countInput.value.trim();
            if (cnt !== '') {
              const n = Number(cnt);
              if (!Number.isInteger(n) || n < 0) return toast('可下载次数必须是不小于 0 的整数（0 表示不限制）', { type: 'error' });
              body.maxDownloads = n;
            }
            // 密码校验
            if (pwOn.checked) {
              const pw = pwInput.value;
              if (!pw) return toast('已启用密码保护，请填写访问密码', { type: 'error' });
              if (pw.length > 64) return toast('密码长度不能超过 64 个字符', { type: 'error' });
              body.password = pw;
            }
            // 付费校验（最低 0.01 元；金额以元提交，服务端转「分」存储）
            if (paidOn.checked) {
              const amount = Number(paidAmount.value);
              if (!Number.isFinite(amount) || amount < 0.01) {
                return toast('付费金额最低 0.01 元', { type: 'error' });
              }
              body.paid = { required: true, amount };
            }
            const r = await API.createLink(body);
            close();
            const url = location.origin + '/s/' + r.id;
            showLinkResult(url, { hours, maxDownloads: r.maxDownloads, hasPassword: r.hasPassword, link: r, warn: r.warn });
          } catch (e) {
            toast('创建链接失败：' + e.message, { type: 'error' });
          }
        } },
      ],
    });
    return modal;
  },
};

/** 链接生成结果弹窗（展示 + 复制） */
function showLinkResult(url, opt = {}) {
  const paidTxt = (opt.link && opt.link.paid && opt.link.paid.required)
    ? ` · 付费：¥${(opt.link.paid.amountFen / 100).toFixed(2)}`
    : ' · 付费：无';
  const remainTxt = opt.direct
    ? ''
    : `有效期：${opt.hours ? (opt.hours >= 24 ? (opt.hours / 24) + ' 天' : opt.hours + ' 小时') : '永久'} · `
      + `下载次数：${opt.maxDownloads > 0 ? opt.maxDownloads + ' 次' : '不限制'} · 密码：${opt.hasPassword ? '已启用' : '无'}`
      + paidTxt;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="ok-note">链接创建成功</div>
    <div class="form-item"><label>分享链接</label>
      <textarea readonly style="width:100%;height:84px;border:1px solid var(--border-strong);border-radius:6px;padding:8px;font-size:12px;resize:none">${escapeHtml(url)}</textarea></div>
    ${remainTxt ? `<div class="hint">${remainTxt}</div>` : ''}
    ${opt.warn ? `<div class="form-msg show bad" style="margin-top:10px">${escapeHtml(opt.warn)}</div>` : ''}
    <div class="hint">${opt.direct
      ? '预签名直链不经过本服务，访问者直接从对象存储下载。'
      : '托管链接由本服务在线时提供下载；可在侧边栏“链接管理”中随时编辑或删除。'}</div>`;
  openModal({
    title: '分享链接', body: wrap,
    foot: [
      { text: '关闭' },
      { text: '复制链接', cls: 'primary', onClick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          toast('链接已复制到剪贴板', { type: 'success' });
        } catch (e) { toast('复制失败，请手动选择复制', { type: 'warn' }); }
      } },
    ],
  });
}

/* ------------------------- 文件夹选择器（移动目标） ------------------------- */

function openFolderPicker({ title, confirmText, onPick, fixedTarget, exclude }) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="hint" style="margin-bottom:8px">选择目标文件夹${fixedTarget ? `：已选定 <b>${escapeHtml(fixedTarget)}</b>` : ''}</div>
    <div id="fp-tree" style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>`;
  const treeEl = wrap.querySelector('#fp-tree');
  let selected = fixedTarget || App.state.prefix;

  function rowHtml(prefix, name, depth, expandable) {
    return `<div class="tree-row ${prefix === selected ? 'active' : ''}" data-prefix="${escapeHtml(prefix)}" style="padding-left:${6 + depth * 16}px" data-expandable="${expandable ? 1 : 0}">
      <span class="tw" style="width:14px">${expandable ? '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 6l6 6-6 6"/></svg>' : ''}</span>
      <svg class="folder" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="color:#e8b339"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
      <span class="nm">${escapeHtml(name)}</span></div>`;
  }

  async function loadChildren(container, prefix, depth) {
    const r = await API.tree(prefix);
    const folders = (r.folders || []).filter((f) => f !== prefix && !(exclude || []).some((k) => f === k || f.startsWith(k)));
    if (!folders.length) {
      container.innerHTML = `<div style="color:#aaa;font-size:12px;padding:4px 20px">（无子文件夹）</div>`;
      return;
    }
    for (const f of folders) {
      const div = document.createElement('div');
      div.innerHTML = rowHtml(f, f.slice(prefix.length).replace(/\/$/, ''), depth, true);
      const row = div.firstElementChild;
      const kidBox = document.createElement('div');
      kidBox.className = 'tree-kids';
      kidBox.hidden = true;
      kidBox.style.marginLeft = '16px';
      row.onclick = () => {
        selected = f;
        treeEl.querySelectorAll('.tree-row').forEach((x) => x.classList.remove('active'));
        row.classList.add('active');
      };
      row.querySelector('.tw').onclick = async (e) => {
        e.stopPropagation();
        if (kidBox.hidden && !kidBox.childNodes.length) {
          await loadChildren(kidBox, f, depth + 1);
        }
        kidBox.hidden = !kidBox.hidden;
      };
      container.appendChild(div);
      container.appendChild(kidBox);
    }
  }

  const rootBox = document.createElement('div');
  rootBox.innerHTML = rowHtml('', '（根目录 /）', 0, true);
  const rootRow = rootBox.firstElementChild;
  const rootKids = document.createElement('div');
  rootKids.className = 'tree-kids';
  rootRow.onclick = () => {
    selected = '';
    treeEl.querySelectorAll('.tree-row').forEach((x) => x.classList.remove('active'));
    rootRow.classList.add('active');
  };
  rootRow.querySelector('.tw').onclick = async (e) => {
    e.stopPropagation();
    if (rootKids.hidden && !rootKids.childNodes.length) await loadChildren(rootKids, '', 1);
    rootKids.hidden = !rootKids.hidden;
  };
  treeEl.appendChild(rootRow);
  treeEl.appendChild(rootKids);

  openModal({
    title, body: wrap, foot: [
      { text: '取消' },
      {
        text: confirmText || '确定', cls: 'primary', onClick: (o, close) => {
          close();
          onPick(selected);
        },
      },
    ],
  });
}
ops.openFolderPicker = openFolderPicker;

/* ------------------------- 工具 ------------------------- */

function configured() {
  return Boolean(App.state.config && App.state.config.configured && App.state.bucket);
}
function displayName(key) { return key.endsWith('/') ? key.slice(0, -1).split('/').pop() : key.split('/').pop(); }
function explorerRefresh() {
  import('./explorer.js').then((m) => m.explorer.refresh());
}
function refreshTree() {
  import('./tree.js').then((m) => m.tree.init());
}
