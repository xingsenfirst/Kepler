/** 上传管理器 —— 队列 / 分块并发 / 断点续传 / 暂停恢复取消 */
import { API, xhrPut } from './api.js';
import { fmtSize, toast, escapeHtml } from './util.js';
import { createMatcher as createGitignoreMatcher } from './gitignore.js';
import { App } from './main.js';

const MAX_FILE_CONCURRENCY = 2;   // 同时上传的文件数
const MAX_CHUNK_CONCURRENCY = 3;  // 单文件并发分片数
const PART_RETRIES = 2;

const tasks = [];

export const uploadMgr = {
  init() {},

  hasActive() {
    return tasks.some((t) => t.state === 'uploading' || t.state === 'waiting');
  },

  /** 文件相对路径（保留目录结构，与原有上传 key 拼接逻辑一致） */
  relPathOf(f) {
    return ((this._isDirectory || f.webkitRelativePath) ? (f.webkitRelativePath || f.name) : f.name).replace(/\\/g, '/');
  },

  async enqueue(files, prefix, isDirectory) {
    let list = [...files].filter((f) => f && f.size !== undefined);
    if (!list.length) return;
    this._isDirectory = isDirectory;
    const ex = App.state.uploadExcludes || {};
    const relPath = (f) => this.relPathOf(f);
    let skipped = 0;

    // 1) 基础排除：.DS_Store / Thumbs.db（按文件名）
    if (ex.dsStore || ex.thumbsDb) {
      list = list.filter((f) => {
        const base = relPath(f).split('/').pop();
        if (ex.dsStore && base === '.DS_Store') { skipped++; return false; }
        if (ex.thumbsDb && base.toLowerCase() === 'thumbs.db') { skipped++; return false; }
        return true;
      });
    }

    // 2) .gitignore 排除：读取选择范围内最顶层的 .gitignore，按标准 git 语法过滤
    let giText = '';
    let giBase = ''; // 项目根目录前缀（.gitignore 所在目录），如 "proj/" 或 ""
    if (ex.gitignore && list.length) {
      const gi = list
        .filter((f) => /(^|\/)\.gitignore$/.test(relPath(f)))
        .sort((a, b) => relPath(a).length - relPath(b).length)[0];
      if (gi) {
        const giPath = relPath(gi);
        giBase = giPath.slice(0, giPath.length - '.gitignore'.length);
        try { giText = await readFileText(gi); } catch (e) { giText = ''; }
        if (giText) {
          const matcher = createGitignoreMatcher(giText);
          const before = list.length;
          list = list.filter((f) => {
            const r = relPath(f);
            const rel = giBase ? (r.startsWith(giBase) ? r.slice(giBase.length) : null) : r;
            if (rel === null || rel === '.gitignore') return true; // 项目外 / .gitignore 自身默认保留
            if (matcher.isIgnored(rel)) { skipped++; return false; }
            return true;
          });
        } else {
          toast('已启用 .gitignore 排除，但未能读取 .gitignore 内容', { type: 'warn' });
        }
      } else {
        toast('已启用 .gitignore 排除，但所选内容中未包含 .gitignore 文件', { type: 'info' });
      }
    }
    if (!list.length) { toast('所选文件均已被上传排除规则过滤，无文件可上传', { type: 'warn' }); return; }
    if (skipped) toast(`已按排除规则跳过 ${skipped} 个文件`, { type: 'info' });

    for (const file of list) {
      const rel = relPath(file);
      const key = (prefix + rel).replace(/\\/g, '/');
      tasks.push({
        id: 't' + Date.now() + Math.random().toString(36).slice(2, 7),
        file, key, prefix,
        size: file.size,
        mtime: Math.floor((file.lastModified || Date.now()) / 1000),
        state: 'waiting',
        loaded: 0, progress: 0, speed: 0,
        sessionId: '', mode: '', chunkSize: 0,
        xhrs: new Set(),
        error: '',
        paused: false, canceled: false,
        gitignore: giText, // 供服务端在上传处理阶段兜底校验
        gitignoreRel: giText && (!giBase || rel.startsWith(giBase)) ? (giBase ? rel.slice(giBase.length) : rel) : '', // 仅当文件位于 .gitignore 目录内时计算相对路径
        _speedLoaded: 0, _speedTime: Date.now(),
      });
    }
    document.getElementById('upload-drawer').hidden = false;
    toast(`已加入 ${list.length} 个上传任务`, { type: 'info' });
    this.render();
    pump();
  },

  pause(id) {
    const t = find(id);
    if (!t || t.state !== 'uploading') return;
    t.paused = true;
    t.xhrs.forEach((x) => { try { x.abort(); } catch (e) { /* ignore */ } });
    t.state = 'paused';
    this.render();
    pump();
  },

  resume(id) {
    const t = find(id);
    if (!t || t.state !== 'paused') return;
    t.paused = false;
    t.state = 'waiting';
    this.render();
    pump();
  },

  async cancel(id) {
    const t = find(id);
    if (!t) return;
    t.canceled = true;
    t.xhrs.forEach((x) => { try { x.abort(); } catch (e) { /* ignore */ } });
    if (['uploading', 'paused', 'waiting'].includes(t.state)) {
      t.state = 'canceled';
      if (t.sessionId) { try { await API.uploadAbort(t.sessionId); } catch (e) { /* ignore */ } }
    }
    this.render();
    pump();
  },

  retry(id) {
    const t = find(id);
    if (!t || (t.state !== 'failed' && t.state !== 'canceled')) return;
    t.state = 'waiting'; t.error = ''; t.paused = false; t.canceled = false;
    // 保留已传分片（断点续传），由 init 重新对齐进度
    this.render();
    pump();
  },

  clearFinished() {
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (['done', 'canceled', 'failed'].includes(tasks[i].state)) tasks.splice(i, 1);
    }
    this.render();
  },

  /** R8-18：登出时清空队列并中止在途请求（由 `forceLogout()` 调用） */
  reset,

  render() {
    const box = document.getElementById('upload-list');
    if (!box) return;
    const active = tasks.filter((t) => t.state === 'uploading' || t.state === 'waiting').length;
    document.getElementById('upload-count').textContent = String(active);
    const doneN = tasks.filter((t) => t.state === 'done').length;
    document.getElementById('upload-summary').textContent = tasks.length
      ? `${doneN}/${tasks.length} 完成 · 进行中 ${active}` : '';
    if (!tasks.length) {
      box.innerHTML = '<div class="up-empty">暂无上传任务，可将文件拖入窗口或点击“上传”</div>';
      return;
    }
    box.innerHTML = tasks.slice().reverse().map((t) => {
      const st = {
        waiting: ['等待中', ''], uploading: ['上传中', ''], paused: ['已暂停', ''],
        done: ['已完成', 'ok'], failed: ['失败：' + escapeHtml(t.error || ''), 'bad'], canceled: ['已取消', ''],
      }[t.state] || ['', ''];
      const actions = [];
      if (t.state === 'uploading') actions.push(`<button class="icon-btn small" data-act="pause" data-id="${t.id}" title="暂停">${window.__SVG.pause}</button>`);
      if (t.state === 'paused') actions.push(`<button class="icon-btn small" data-act="resume" data-id="${t.id}" title="继续">${window.__SVG.play}</button>`);
      if (['uploading', 'paused', 'waiting', 'failed', 'canceled'].includes(t.state)) {
        actions.push(`<button class="icon-btn small" data-act="cancel" data-id="${t.id}" title="取消">${window.__SVG.cancel}</button>`);
      }
      if (t.state === 'failed') actions.push(`<button class="mini-btn" data-act="retry" data-id="${t.id}">重试</button>`);
      const speed = t.state === 'uploading' && t.speed > 0 ? ` · ${fmtSize(t.speed)}/s` : '';
      const resumeHint = t.mode === 'multipart' && ['paused', 'failed'].includes(t.state) ? ' · 支持断点续传' : '';
      return `<div class="up-item">
        <div class="up-row1">
          <span class="up-name" title="${escapeHtml(t.key)}">${escapeHtml(t.key)}</span>
          <span class="up-state ${st[1]}">${st[0]}</span>
          <span class="up-actions">${actions.join('')}</span>
        </div>
        <div class="up-bar"><i style="width:${t.progress.toFixed(1)}%"></i></div>
        <div class="up-sub"><span>${fmtSize(t.loaded)} / ${fmtSize(t.size)}（${t.progress.toFixed(1)}%）${speed}${resumeHint}</span><span>${t.mode === 'multipart' ? '分块上传' : '直传'}</span></div>
      </div>`;
    }).join('');
    box.querySelectorAll('[data-act]').forEach((b) => {
      const { act, id } = b.dataset;
      b.onclick = () => this[act] && this[act](id);
    });
  },
};

function find(id) { return tasks.find((t) => t.id === id); }

/** 读取 File 内容为文本（浏览器 File.text()，兜底 FileReader） */
function readFileText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

/* ------------------------- 调度 ------------------------- */

function pump() {
  const waiting = tasks.filter((t) => t.state === 'waiting');
  const running = tasks.filter((t) => t.state === 'uploading').length;
  waiting.slice(0, Math.max(0, MAX_FILE_CONCURRENCY - running)).forEach((t) => {
    t.state = 'uploading';
    runTask(t).catch((e) => {
      if (!t.canceled && !t.paused) {
        t.state = 'failed';
        t.error = e.message || '上传失败';
        toast(`上传失败：${t.key}（${t.error}）`, { type: 'error' });
      }
      uploadMgr.render();
      pump();
    });
  });
  uploadMgr.render();
}

async function runTask(t) {
  const init = await API.uploadInit(t.key, t.size, t.mtime, { gitignore: t.gitignore, gitignoreRel: t.gitignoreRel });
  if (init.mode === 'simple') {
    t.mode = 'simple';
    t.chunkSize = 0;
    // FUN-09：直传端点此前不收 gitignore 参数，服务端兜底校验形同虚设
    //（排除规则只在分片路径 /fs/upload/init 上生效）。规则文本走 query，
    // 故只在上限内携带 —— 超限部分交由 init 阶段已完成的校验覆盖。
    const giQuery = (t.gitignore && t.gitignoreRel && t.gitignore.length <= 2000)
      ? `&gitignore=${encodeURIComponent(t.gitignore)}&gitignoreRel=${encodeURIComponent(t.gitignoreRel)}`
      : '';
    const p = xhrPut(`/api/fs/upload/simple?path=${encodeURIComponent(t.key)}&mtime=${t.mtime}${giQuery}`, t.file,
      (loaded) => updateProgress(t, loaded));
    if (p.xhr) t.xhrs.add(p.xhr);
    try { await p; } finally { if (p.xhr) t.xhrs.delete(p.xhr); }
  } else {
    t.mode = 'multipart';
    t.sessionId = init.sessionId;
    t.chunkSize = init.chunkSize;
    const uploaded = new Map((init.uploadedParts || []).map((p) => [p.partNumber, p.size || 0]));
    let doneBytes = 0;
    for (const sz of uploaded.values()) doneBytes += sz;
    const partProgress = new Map(); // 进行中分片进度
    const total = Math.ceil(t.size / t.chunkSize);
    let next = 1;
    updateProgress(t, doneBytes);

    async function worker() {
      while (true) {
        if (t.canceled) throw new Error('已取消');
        if (t.paused) return 'paused';
        const part = next++;
        if (part > total) return 'ok';
        if (uploaded.has(part)) continue;
        const start = (part - 1) * t.chunkSize;
        const blob = t.file.slice(start, Math.min(start + t.chunkSize, t.size));
        // R8-13：必须传**工厂函数**而不是 Promise。xhrPut 在 new Promise 的执行体里
        // 就 `xhr.send(blob)` 了，返回的是「已经开始的」Promise；对同一个已结算的
        // 拒绝反复 await 只会立刻抛回同一个错误 —— 重试形同虚设。
        const send = () => {
          const p = xhrPut(
            `/api/fs/upload/chunk?session=${encodeURIComponent(t.sessionId)}&part=${part}`,
            blob,
            (loaded) => { partProgress.set(part, loaded); updateProgress(t, doneBytes, partProgress); },
          );
          if (p.xhr) t.xhrs.add(p.xhr);
          return p;
        };
        try {
          await uploadWithRetry(t, send);
        } finally {
          // 每次尝试的句柄由 uploadWithRetry 自行摘除，这里只清理进度残留
          partProgress.delete(part);
        }
        doneBytes += blob.size;
        updateProgress(t, doneBytes, partProgress);
      }
    }
    const results = await Promise.all(
      Array.from({ length: Math.max(1, Math.min(MAX_CHUNK_CONCURRENCY, total)) }, worker),
    );
    if (t.canceled) return;
    if (results.includes('paused')) { t.state = 'paused'; uploadMgr.render(); return; }
    await API.uploadComplete(t.sessionId);
    t.sessionId = '';
  }
  t.state = 'done';
  t.progress = 100;
  t.loaded = t.size;
  uploadMgr.render();
  App.refreshStorage && App.refreshStorage(); // 立即刷新状态栏存储用量
  notifyCurrentPrefix(t.prefix);
  pump();
}

/**
 * 分片上传的重试。
 *
 * R8-13：第二个参数是**工厂函数**（`() => Promise`），不是 Promise。
 * `xhrPut` 在 `new Promise` 的执行体里就调用了 `xhr.send(blob)`，返回的是
 * 「已经开始的」Promise；旧实现对同一个已 rejected 的 Promise 反复 `await`，
 * 只会立刻抛回同一个错误 —— 所谓「重试 2 次」实际只是白等 0.8s + 1.6s。
 * 弱网或偶发 5xx 下大文件上传几乎必然整体失败，断点续传的容错能力实际为零。
 *
 * 每次尝试的 XHR 句柄在本函数内随用随摘，避免 `t.xhrs` 里堆积已结束的句柄
 * （取消时会对它们逐个 abort，虽无害但会掩盖真正的在途请求）。
 */
async function uploadWithRetry(t, send) {
  let attempt = 0;
  let p = null;
  while (true) {
    try {
      p = send();
      const r = await p;
      if (p.xhr) t.xhrs.delete(p.xhr);
      return r;
    } catch (e) {
      if (p && p.xhr) t.xhrs.delete(p.xhr);
      if (e.aborted || t.canceled || t.paused) throw e;
      if (++attempt > PART_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 800 * attempt));
      // 退避期间用户点了取消/暂停：不要再把这一片重发出去
      if (t.canceled || t.paused) throw e;
    }
  }
}

function updateProgress(t, doneBytes, partProgress) {
  let extra = 0;
  if (partProgress) for (const v of partProgress.values()) extra += v;
  t.loaded = doneBytes + extra;
  t.progress = t.size ? Math.min(100, (t.loaded / t.size) * 100) : 100;
  const now = Date.now();
  const dt = (now - t._speedTime) / 1000;
  if (dt > 0.4) {
    t.speed = Math.max(0, (t.loaded - t._speedLoaded) / dt);
    t._speedLoaded = t.loaded; t._speedTime = now;
  }
  renderThrottled();
}

let renderTimer = null;
function renderThrottled() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; uploadMgr.render(); }, 250);
}

function notifyCurrentPrefix(prefix) {
  if (prefix === App.state.prefix) {
    import('./explorer.js').then((m) => m.explorer.refresh({ silent: true }));
  }
}

/**
 * R8-18：丢弃上传队列并中止在途请求。
 *
 * `tasks` 是模块级数组，每条 task 都带 `key`（**完整对象键**，常含业务语义，
 * 例如 `proj/客户名/合同-2026.pdf`）。登出时若不清空：
 *  · 下一个登录的账号状态栏直接显示上一账号的上传计数，
 *    点开「上传队列」能看到上一账号的全部文件名与路径 —— 跨账号信息泄露；
 *  · 上一账号在途的分片 XHR 不会被中断，会带着已失效的会话继续打服务端。
 *
 * 与 `syssettings.reset()` / `enc.reset()` 同类：模块级状态必须在登出点清空。
 */
function reset() {
  for (const t of tasks) {
    t.canceled = true;
    if (t.xhrs) {
      for (const x of t.xhrs) { try { x.abort(); } catch (e) { /* 已结束 */ } }
      t.xhrs.clear();
    }
  }
  tasks.length = 0;
  uploadMgr.render();
  // render() 在「上传面板未挂载」时会早退（找不到 #upload-list），此时计数会残留
  // 上一账号的值 → 这里再兜一次，保证状态栏与队列同步归零。
  const el = document.getElementById('upload-count');
  if (el) el.textContent = '0';
}
