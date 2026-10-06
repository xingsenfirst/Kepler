/**
 * R38：设置页「备份配置」卡片 —— 实时码展示 + 导出（加密）/ 导入。
 *
 * ## 三种码的关系（这是本卡片最容易看错的地方）
 *
 *  - **实时码**：页面里那串一直显示的码，由服务端按当前配置算出来，改设置就变。
 *    明文，管理员专属。**它不能用来导入** —— 服务端只接受加密导出码
 *    （实时码没有完整性保护，谁都能改一个字节再让服务端吃进去）。
 *  - **导出码**：点「复制备份码 / 导出为 JSON」时，先验证**账户密码**、再设一个
 *    **独立的备份密码**，服务端据此把实时码加密成导出码。**只有它**能跨实例搬运。
 *  - **导入**：粘贴导出码 + 输入备份密码，**仅在全新实例上**由服务端放行。
 *
 * 因此这里的按钮名字都带「…」（表示会先弹一个对话框），而不是直接执行 ——
 * 避免用户以为「复制」就是把上面那串明文拿去别处用。
 *
 * ## 两个必须守住的交互细节
 *
 * ① `refresh()` 会**覆盖** textarea 的内容。因此实现里绝不把用户手输的内容写回它 ——
 *    导入用的是一个**独立对话框里的 textarea**，与实时码那块互不影响。
 * ② 换账号 / 登出必须 `reset()`：实时码含密钥明文，留着就是「上一个账号的配置」
 *    静静躺在新账号的 DOM 里（R36 的用户列表踩过同一个坑）。
 */
import { API } from './api.js';
import { toast, openModal } from './util.js';

let wired = false;
/** 当前实时码（导出时不用它 —— 导出由服务端重新按当前配置生成，避免用到过期副本） */
let liveCode = '';

function el(id) { return document.getElementById(id); }

export function refresh() {
  wire();
  const card = el('sysset-backup-card');
  if (!card || card.hidden) return; // 非管理员：整卡隐藏，不发注定 403 的请求
  loadStatus();
  loadCode();
}

export function reset() {
  liveCode = '';
  const ta = el('backup-code');
  if (ta) ta.value = '';
  const meta = el('backup-meta-text');
  if (meta) meta.textContent = '';
  const hint = el('backup-import-hint');
  if (hint) hint.textContent = '';
}

function wire() {
  if (wired) return;
  wired = true;
  const copy = el('btn-backup-copy');
  if (copy) copy.onclick = () => openExportDialog('copy');
  const exp = el('btn-backup-export');
  if (exp) exp.onclick = () => openExportDialog('file');
  const imp = el('btn-backup-import');
  if (imp) imp.onclick = openImportDialog;
  const rf = el('btn-backup-refresh');
  if (rf) rf.onclick = () => { loadStatus(); loadCode(); };
}

async function loadStatus() {
  const hint = el('backup-import-hint');
  try {
    const s = await API.backupStatus();
    if (hint) {
      hint.textContent = s.canImport
        ? '本实例尚未配置任何项目，可以导入。'
        : '本实例已有配置，导入已关闭（导入会覆盖并全部丢失）。';
      hint.classList.toggle('backup-import-open', !!s.canImport);
    }
    const imp = el('btn-backup-import');
    if (imp) imp.disabled = !s.canImport;
  } catch (e) {
    if (hint) hint.textContent = '备份状态读取失败：' + e.message;
  }
}

async function loadCode() {
  const ta = el('backup-code');
  const meta = el('backup-meta-text');
  try {
    const r = await API.backupCode();
    liveCode = String(r.code || '');
    if (ta) ta.value = liveCode;
    if (meta) {
      const s = r.summary || {};
      meta.textContent = `指纹 ${r.fingerprint} · 长度 ${liveCode.length} 字符 · `
        + `密钥 ${s.credentials || 0} · 桶 ${s.buckets || 0} · WebDAV 账户 ${s.webdavAccounts || 0} · IP 规则 ${s.ipRules || 0}`;
    }
  } catch (e) {
    if (ta) ta.value = '';
    if (meta) meta.textContent = '实时码读取失败：' + e.message;
  }
}

/* ------------------------------ 导出 ------------------------------ */

/**
 * 导出对话框：先验证**账户密码**，再设**独立备份密码**。
 *
 * 两个密码刻意放在同一个对话框里一次收齐：分成两步会让用户以为「验证通过了就等于
 * 拿到码了」，而真正保护备份的是第二把密码。字段顺序也按这个心智模型排。
 */
function openExportDialog(mode) {
  const wrap = document.createElement('div');
  wrap.className = 'backup-form';
  wrap.innerHTML = `
    <div class="form-item"><label>账户密码（权限验证）</label>
      <input id="bk-account-pass" class="sl-input bk-input" type="password" autocomplete="current-password"
        placeholder="当前登录账户的密码">
      <div class="hint">用于确认「是你本人在导出配置」。</div></div>
    <div class="form-item"><label>备份密码（独立设置）</label>
      <input id="bk-backup-pass" class="sl-input bk-input" type="password" autocomplete="new-password"
        placeholder="至少 8 位">
      <div class="hint">这份备份的独立密码，<b>与账户密码无关</b>，也<b>不会被保存</b>在任何地方 ——
        忘了它，这份导出码就再也解不开。导入时需要输入同一个。</div></div>
    <div class="form-item"><label>再输一次备份密码</label>
      <input id="bk-backup-pass2" class="sl-input bk-input" type="password" autocomplete="new-password"
        placeholder="重复输入"></div>
    <div class="sl-err" id="bk-err" hidden></div>
    <div class="sl-note">导出码只含<b>备份范围内</b>的 8 项配置；用户列表、分享链接、订单与各类密钥文件
      （<code>secret.key</code> / <code>enc.key</code> 等）一律不含，也无法备份。</div>`;

  const fail = (msg) => {
    const box = wrap.querySelector('#bk-err');
    if (box) { box.textContent = msg; box.hidden = false; }
  };

  openModal({
    title: mode === 'copy' ? '复制备份码' : '导出配置为 JSON',
    body: wrap,
    cls: 'backup-dialog',
    foot: [
      { text: '取消', value: null },
      {
        text: '生成导出码',
        primary: true,
        onClick: async (overlay, close) => {
          const account = wrap.querySelector('#bk-account-pass').value;
          const bp = wrap.querySelector('#bk-backup-pass').value;
          const bp2 = wrap.querySelector('#bk-backup-pass2').value;
          if (!account) return fail('请输入账户密码');
          if (!bp) return fail('请设置备份密码');
          if (bp !== bp2) return fail('两次输入的备份密码不一致');
          const btn = overlay.querySelector('.dialog-foot .primary');
          if (btn) btn.disabled = true;
          try {
            const r = await API.backupExport(account, bp);
            close(null);
            deliver(r.code, r.fingerprint, mode);
          } catch (e) {
            fail(e.message);
          } finally {
            if (btn) btn.disabled = false;
          }
        },
      },
    ],
  });
}

/** 拿到导出码之后的落地：复制到剪贴板，或下载成 .json */
async function deliver(code, fingerprint, mode) {
  if (mode === 'copy') {
    const ok = await copyText(code);
    toast(ok ? '导出码已复制（请连同备份密码一起妥善保存）' : '复制失败，请改为「导出为 JSON」',
      { type: ok ? 'success' : 'error' });
    return;
  }
  const payload = JSON.stringify({
    app: 'kepler',
    kind: 'config-backup',
    exportedAt: new Date().toISOString(),
    fingerprint,
    // 备份密码**不写进文件** —— 那是唯一挡在密钥明文前面的东西
    passwordHint: '导入时需要输入导出时设置的备份密码',
    code,
  }, null, 2);
  downloadJson(`kepler-config-backup-${fingerprint}.json`, payload);
  toast('已导出 JSON（备份密码未写入文件，请自行保存）', { type: 'success' });
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* 回落到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------ 导入 ------------------------------ */

/**
 * 导入对话框。
 *
 * ⚠️ 用的是**对话框里自己的** textarea，绝不复用页面上那块实时码 —— 后者在配置变化时
 * 会被 `refresh()` 覆盖掉，用户粘进去的内容会在他输密码的过程中被悄悄冲掉。
 */
function openImportDialog() {
  const wrap = document.createElement('div');
  wrap.className = 'backup-form';
  wrap.innerHTML = `
    <div class="enc-warn backup-import-warn">
      <b>导入会直接覆盖本实例的配置，原有设置项全部丢失、不可撤销。</b>
      因此只有在<b>全新部署、尚未配置任何项目</b>的实例上才允许导入。
    </div>
    <div class="form-item"><label>导出码</label>
      <textarea id="bk-import-code" class="backup-code" spellcheck="false"
        placeholder="粘贴「导出」得到的那串 KEPLER-CONFIG-SEALED-V1.… 代码"></textarea></div>
    <div class="form-item"><label>备份密码</label>
      <input id="bk-import-pass" class="sl-input bk-input" type="password" autocomplete="off"
        placeholder="导出时设置的备份密码"></div>
    <div class="sl-err" id="bk-import-err" hidden></div>`;

  const fail = (msg) => {
    const box = wrap.querySelector('#bk-import-err');
    if (box) { box.textContent = msg; box.hidden = false; }
  };

  openModal({
    title: '导入配置',
    body: wrap,
    cls: 'backup-dialog',
    foot: [
      { text: '取消', value: null },
      {
        text: '开始导入',
        danger: true,
        onClick: async (overlay, close) => {
          const code = wrap.querySelector('#bk-import-code').value.trim();
          const pass = wrap.querySelector('#bk-import-pass').value;
          if (!code) return fail('请粘贴导出码');
          if (!pass) return fail('请输入备份密码');
          const btn = overlay.querySelector('.dialog-foot .danger');
          if (btn) btn.disabled = true;
          try {
            const r = await API.backupImport(code, pass);
            close(null);
            const s = (r && r.summary) || {};
            toast(`导入完成：密钥 ${s.credentials || 0} · 桶 ${s.buckets || 0} · `
              + `WebDAV 账户 ${s.webdavAccounts || 0} · IP 规则 ${s.ipRules || 0}`, { type: 'success' });
            loadStatus();
            loadCode();
          } catch (e) {
            fail(e.message);
          } finally {
            if (btn) btn.disabled = false;
          }
        },
      },
    ],
  });
}

/**
 * 供调试 / 测试读取当前实时码（不参与渲染逻辑）。
 *
 * ⚠️ 这里刻意**不**再导出一份「备份范围 8 项」的常量：清单由服务端 `GET /backup/status`
 * 下发（`server/backup.js` 的 `SCOPES` 是唯一实现点）。前端再抄一份，下次加一项必然只改
 * 服务端，界面上却还少一项 —— 而两边都「看起来写了」。
 */
export function currentLiveCode() { return liveCode; }
