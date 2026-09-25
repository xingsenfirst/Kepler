/**
 * 我的资料 —— 账户菜单「编辑资料」弹窗（**所有角色可用**，含管理员）。
 *
 * 从这里**独立出来**是本次重构的关键：
 *   - 此前「编辑自己资料」与「管理全部用户」共用系统设置里的同一张卡片，
 *     卡片需要在「我的资料 / 用户管理」两种形态间来回切换。只要有一条分支漏改，
 *     换账号时就会残留上一个角色的 DOM（普通用户看到全部用户、看到添加按钮）。
 *   - 现在两种用途物理分离：用户管理卡片对普通用户**整体隐藏**（只有管理员看得到），
 *     自助资料编辑走本弹窗。角色切换只剩"显示 / 隐藏一个整块"，不存在需要还原的中间态。
 *
 * 支持的字段：用户名、密码、自己的 Windows Hello 开关。
 * 明确不支持改角色 / 权限（服务端 /users/me 同样拒绝，避免自行提权）。
 */
import { API } from './api.js';
import { toast, escapeHtml, openModal } from './util.js';
import { App } from './main.js';
import { registerWindowsHello, webauthnSupported, isSecureContextOK } from './webauthn.js';

/** 打开「编辑资料」弹窗 */
export function openProfileDialog() {
  const me = App.state.user;
  if (!me) { toast('请先登录', { type: 'warn' }); return; }

  const helloEnabled = !!me.webauthnEnabled;
  const helloUsable = webauthnSupported() && isSecureContextOK();

  const form = document.createElement('div');
  form.innerHTML = `
    <div class="form-item">
      <label>用户名 <span class="req">*</span></label>
      <input type="text" id="p-f-username" maxlength="32" placeholder="2-32 位，支持中英文/数字/@.-_"
        value="${escapeHtml(me.username || '')}" autocomplete="off" spellcheck="false">
      <div class="hint">用户名用于登录，2-32 个字符，支持中文、英文字母、数字及 @ . - _ 符号。修改后需要重新登录。</div>
    </div>
    <div class="form-item">
      <label>当前角色</label>
      <input type="text" value="${me.role === 'admin' ? '管理员' : '普通用户'}" disabled>
      <div class="hint">角色由管理员分配，不能自行修改。</div>
    </div>
    <div class="form-item">
      <label>新密码 <span class="hint" style="margin-left:6px">留空则不修改密码</span></label>
      <input type="password" id="p-f-password" maxlength="128" placeholder="留空保持原密码不变" autocomplete="new-password">
    </div>
    <div class="form-item">
      <label>确认新密码 <span class="hint" style="margin-left:6px">留空则不修改</span></label>
      <input type="password" id="p-f-confirm" maxlength="128" placeholder="留空保持原密码不变" autocomplete="new-password">
    </div>
    <div class="form-item">
      <label class="u-hello-label">
        <input type="checkbox" id="p-f-hello" ${helloEnabled ? 'checked' : ''} ${helloUsable ? '' : 'disabled'}>
        <span>启用 Windows Hello 验证</span>
      </label>
      <div class="hint">
        ${helloUsable
          ? '启用后，登录时在输入密码之后<b>还需通过本机 Windows Hello</b>验证才能真正进入系统。需输入当前密码才能绑定 Windows Hello。'
          : '当前环境不可用：需使用支持 WebAuthn 的浏览器，并通过 HTTPS 或 127.0.0.1 / localhost 访问。'}
      </div>
      <div id="p-f-hello-msg" class="form-msg"></div>
    </div>
    <div id="p-f-msg" class="form-msg"></div>
  `;

  const m = openModal({
    title: '编辑资料',
    body: form,
    foot: [
      { text: '取消', onClick: (o, close) => close() },
      { text: '保存修改', cls: 'primary', onClick: (o, close) => save(o, close) },
    ],
  });

  const q = (sel) => form.querySelector(sel);
  const msgEl = q('#p-f-msg');
  const showMsg = (text, cls) => {
    if (!msgEl) return;
    msgEl.textContent = text;
    msgEl.className = 'form-msg show ' + cls;
  };

  form.querySelectorAll('input[type="text"], input[type="password"]').forEach((inp) => {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(m.overlay, m.close); } });
  });

  // 勾选启用 → 立即要求输入当前密码并唤起 Windows Hello 完成注册（服务端会校验密码）
  const helloBox = q('#p-f-hello');
  const helloMsg = q('#p-f-hello-msg');
  if (helloBox) {
    helloBox.addEventListener('change', async () => {
      if (!helloBox.checked) return; // 取消勾选只改 UI，真正关闭在保存时处理
      const pwd = (q('#p-f-password') || {}).value || '';
      if (!pwd) {
        helloBox.checked = false;
        if (helloMsg) { helloMsg.textContent = '请先在「新密码」栏输入当前密码，用于确认是本人在操作'; helloMsg.className = 'form-msg show bad'; }
        return;
      }
      if (helloMsg) { helloMsg.textContent = '正在唤起 Windows Hello，请按系统提示完成验证…'; helloMsg.className = 'form-msg show'; }
      try {
        const r = await registerWindowsHello(API, pwd);
        if (r && r.user) {
          me.webauthnEnabled = true; // 同步本地会话状态，避免界面与实际不一致
          if (helloMsg) { helloMsg.textContent = '已启用：登录时将要求 Windows Hello 验证'; helloMsg.className = 'form-msg show ok'; }
          toast('Windows Hello 已启用', { type: 'success' });
        }
      } catch (e) {
        helloBox.checked = false;
        if (helloMsg) { helloMsg.textContent = e.message || '启用失败'; helloMsg.className = 'form-msg show bad'; }
      }
    });
  }

  async function save(overlay, close) {
    const username = (overlay.querySelector('#p-f-username') || {}).value || '';
    const password = (overlay.querySelector('#p-f-password') || {}).value || '';
    const confirm = (overlay.querySelector('#p-f-confirm') || {}).value || '';

    if (!username.trim()) { showMsg('用户名不能为空', 'bad'); return; }
    if (password && password.length < 6) { showMsg('密码长度不能少于 6 位', 'bad'); return; }
    if (password !== confirm) { showMsg('两次输入的密码不一致', 'bad'); return; }

    const body = { username: username.trim() };
    if (password) { body.password = password; body.confirmPassword = confirm; }

    // 关闭 Windows Hello：勾选被取消时必须提供当前密码（服务端同样要求）
    const wantDisable = !!me.webauthnEnabled && helloBox && helloBox.checked === false;
    if (wantDisable && !password) {
      showMsg('关闭 Windows Hello 需要在此输入当前密码以确认身份', 'bad');
      return;
    }

    try {
      const r = await API.updateMyProfile(body);
      if (r && r.reauthRequired) {
        close();
        toast('用户名已修改，请使用新用户名重新登录', { type: 'warn', duration: 6000 });
        if (App.forceLogout) App.forceLogout('用户名已修改，请重新登录');
        return;
      }
      if (wantDisable) {
        await API.webauthnDisable(password);
        me.webauthnEnabled = false;
      }
      // 同步本地显示（用户名 / 账户菜单抬头）
      me.username = body.username;
      const nameEl = document.getElementById('user-name');
      if (nameEl) nameEl.textContent = body.username;
      const headEl = document.getElementById('um-head');
      if (headEl) headEl.textContent = `${body.username}（${me.role === 'admin' ? '管理员' : '普通用户'}）`;
      close();
      toast('资料已更新', { type: 'success' });
    } catch (e) {
      showMsg(e.message || '保存失败', 'bad');
    }
  }
}
