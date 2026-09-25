/** 加密文件访问助手 —— 查看密码验证（权限验证）+ 安全下载入口 */
import { API } from './api.js';
import { openModal, toast } from './util.js';
import { App } from './main.js';

let token = '';
let tokenExp = 0; // 令牌过期时间戳（毫秒）

function unlocked() { return !!token && Date.now() < tokenExp - 60000; }

/**
 * R8-04：丢弃本模块持有的加密访问令牌。
 *
 * 令牌是**凭据**而不是界面状态：它由「加密访问密码」验证通过后签发，30 分钟有效。
 * 登出时若不丢弃，同一浏览器里下一个登录的账号（任意角色）点任一密文文件时，
 * `ensureUnlocked()` 会因为 `unlocked()` 为真而**直接放行**，请求带上上一个账号的
 * `x-enc-token` → 服务端验签通过 → 免密拿到明文。
 *
 * 与 `syssettings.reset()` / `ordermgr.reset()` 同类：模块级缓存必须在登出点清空，
 * 漏一个就是一个跨账号残留。由 `forceLogout()` 调用。
 */
export function reset() {
  token = '';
  tokenExp = 0;
}

/** 当前是否持有有效令牌（仅供测试与诊断，不用于鉴权判定） */
export function hasToken() { return unlocked(); }

/** 确保已通过加密访问密码验证（未设密码 / 已持有效令牌时直接通过） */
export async function ensureUnlocked() {
  const enc = App.state.enc;
  if (!enc || !enc.passwordSet) return true;
  if (unlocked()) return true;
  return await promptPassword();
}

/** 弹出密码验证弹窗；验证通过返回 true，取消返回 false */
function promptPassword() {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="form-item">
        <label>加密访问密码</label>
        <input type="password" id="enc-pw" class="full" placeholder="请输入系统设置中配置的查看密码" autocomplete="off">
        <div class="hint">该文件已加密存储。通过验证后（30 分钟内有效）才能在线查看或下载。</div>
      </div>`;
    openModal({
      title: '🔒 加密文件访问验证',
      body: wrap,
      foot: [
        { text: '取消', onClick: (o, close) => { close(); resolve(false); } },
        { text: '验证并继续', cls: 'primary', onClick: async (o, close) => {
          const pw = wrap.querySelector('#enc-pw').value;
          if (!pw) return toast('请输入密码', { type: 'warn' });
          try {
            const r = await API.encUnlock(pw);
            token = r.token;
            tokenExp = Date.now() + (r.expiresIn || 0);
            close();
            resolve(true);
          } catch (e) {
            toast('验证失败：' + e.message, { type: 'error' });
          }
        } },
      ],
    });
    setTimeout(() => wrap.querySelector('#enc-pw').focus(), 50);
  });
}

/**
 * R8-14：处理下载响应里的 401。
 *
 * 服务端对「密文对象 + 已设查看密码 + 令牌无效」回答 401 并带 `needUnlock: true`
 * （见 routes/fs.js `/fs/download`）。这**不是**会话过期，唯一的正确反应是
 * 重新走一次查看密码验证；旧实现直接把它当「令牌过期」清空重试，而
 * `App.state.enc.passwordSet` 对普通用户恒为 false → `ensureUnlocked()` 恒真 →
 * 不弹框、不换令牌，重试一次再失败，用户只看到「下载失败（HTTP 401）」，
 * 服务端专门给出的 needUnlock 与提示文案被整段丢弃。
 *
 * R9-10：用户**取消**密码验证时必须与「验证失败」区分开。`ensureUnlocked()` 返回
 * false 表示用户关掉了密码框 —— 这不是错误，调用方应当直接把整个下载过程**结束**，
 * 而不是抛出一个会被 catch 住的错误。因此这里返回 `false`，由调用方用
 * `CANCELLED` 哨兵提前 return（见 `openDownload`）。
 *
 * @returns {Promise<boolean>} 是否已重新取得令牌（false = 用户取消 / 非密码问题）
 */
async function handleUnauthorized(res) {
  let needUnlock = true;
  try {
    const d = await res.json();
    needUnlock = !!d && d.needUnlock !== false;
  } catch (e) { /* 非 JSON：按需要解锁处理 */ }
  if (!needUnlock) return false;
  reset();
  return await ensureUnlocked();
}

/**
 * R9-10：内部哨兵 —— 表示「用户主动取消」，用于**穿透** `catch` 而不触发降级/报错。
 *
 * 为什么需要它：`openDownload` 的流式分支有一个"其余错误回退到 blob 方式"的 catch。
 * 旧实现在用户取消时抛的正是普通 `Error('下载失败（HTTP 401）')`，于是这个错误
 * 被自己的 catch 接住 → ① 走到 blob 分支**第二次** `fetch` → 再次 401 →
 * **密码框弹第二次**；② 本次下载被静默降级为「整文件读进内存」的 blob 方式
 * （该分支代码自陈"仅适合中小文件"）。对 R8-14 特意补上的 `needUnlock` 流程而言
 * 这是行为回退。用带标记的对象作哨兵，`catch` 里显式识别并原样放行。
 */
const CANCELLED = { __encCancelled: true };
function isCancelled(e) { return !!(e && e.__encCancelled); }

/**
 * 安全下载：先验证权限，再用 fetch 携带 x-enc-token 请求头下载（服务端解密后下发明文）
 * 令牌仅经请求头传递，不出现在 URL / 浏览器历史 / Referer 与访问日志中（S5）
 *
 * 传输策略（M6 修复）：优先使用 File System Access API（showSaveFilePicker）流式落盘，
 * 避免 `res.blob()` 把整个文件读进内存 —— 加密大文件（数百 MB+）会撑爆浏览器内存，
 * 也与后端精心设计的流式转发 + 背压不匹配。浏览器不支持时回退到 blob 方式（旧行为）。
 *
 * @param {string} key 对象 Key
 * @param {boolean} isRetry 内部递归重试标记（令牌失效时重新验证一次）
 */
export async function openDownload(key, isRetry) {
  if (!(await ensureUnlocked())) return;
  const fname = (String(key).split('/').filter(Boolean).pop()) || 'download';

  // 优先：流式落盘（需 File System Access API，仅安全上下文 + Chromium 系可用）
  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fname });
      const res = await fetch(API.downloadUrl(key), { headers: token ? { 'X-Enc-Token': token } : {} });
      if (res.status === 401 && !isRetry) {
        // R9-10：用户取消密码验证 → 用哨兵结束整个下载，不落进下面的 blob 回退
        if (!(await handleUnauthorized(res))) throw CANCELLED;
        return await openDownload(key, true);
      }
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
      const writable = await handle.createWritable();
      await res.body.pipeTo(writable); // 流式，不整体驻留内存
      toast('下载完成：' + fname, { type: 'success' });
      return;
    } catch (e) {
      // 用户主动取消（AbortError）不算失败，直接返回
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
      // R9-10：用户取消密码验证同样直接结束（否则会弹第二次密码框并降级为 blob）
      if (isCancelled(e)) return;
      // 其余错误回退到 blob 方式（如权限/环境不支持）
    }
  }

  // 回退：blob 方式（整文件入内存，仅适合中小文件）
  try {
    const res = await fetch(API.downloadUrl(key), { headers: token ? { 'X-Enc-Token': token } : {} });
    if (res.status === 401 && !isRetry) {
      // 令牌过期或被拒 → 重新走一次查看密码验证
      if (!(await handleUnauthorized(res))) return; // R9-10：用户取消 → 静默结束
      return await openDownload(key, true);
    }
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) {
    if (isCancelled(e)) return; // R9-10：兜底（不应到达，防御性）
    toast('下载失败：' + e.message, { type: 'error' });
  }
}
