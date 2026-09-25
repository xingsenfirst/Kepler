/** 侧边栏文件夹树 —— 懒加载子目录 */
import { API } from './api.js';
import { App } from './main.js';
import { toast, escapeHtml } from './util.js';

export const tree = {
  init() {
    const el = document.getElementById('tree');
    el.innerHTML = '';
    const root = buildNode({ prefix: '', name: App.state.bucketDisplay || App.state.bucket || '全部文件', depth: 0 });
    el.appendChild(root);
    loadChildren(root, '');
  },
};

function buildNode({ prefix, name, depth }) {
  const node = document.createElement('div');
  node.className = 'tree-node';
  node.dataset.prefix = prefix;
  node.innerHTML = `
    <div class="tree-row" data-prefix="${escapeAttr(prefix)}" style="padding-left:${6 + depth * 14}px">
      <span class="tw">${depth === 0 ? '' : caretHtml()}</span>
      <svg class="folder" viewBox="0 0 24 24" fill="currentColor"><path d="M4 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>
      <span class="nm" title="${escapeAttr(name)}">${escapeHtml(name)}</span>
    </div>
    <div class="tree-kids" hidden></div>`;
  const row = node.querySelector('.tree-row');
  const kids = node.querySelector('.tree-kids');
  const tw = node.querySelector('.tw');

  row.onclick = () => App.navigate(prefix);
  row.ondblclick = () => toggle();

  function toggle() {
    if (!kids.childNodes.length) loadChildren(node, prefix);
    else kids.hidden = !kids.hidden;
    tw.innerHTML = kids.hidden ? caretHtml() : caretOpenHtml();
  }
  tw.onclick = (e) => { e.stopPropagation(); if (depth > 0) toggle(); };
  tw.dataset.role = 'toggle';
  return node;
}

function caretHtml() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M9 6l6 6-6 6"/></svg>'; }
function caretOpenHtml() { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M6 9l6 6 6-6"/></svg>'; }

async function loadChildren(node, prefix) {
  const kids = node.querySelector('.tree-kids');
  try {
    const r = await API.tree(prefix);
    kids.innerHTML = '';
    const folders = (r.folders || []).filter((f) => f !== prefix);
    if (!folders.length) {
      kids.hidden = true;
      node.querySelector('.tw').innerHTML = '';
      return;
    }
    for (const f of folders) {
      const name = f.slice(prefix.length).replace(/\/$/, '');
      kids.appendChild(buildNode({ prefix: f, name, depth: prefix ? prefix.split('/').length : 1 }));
    }
    kids.hidden = false;
    node.querySelector('.tw').innerHTML = caretOpenHtml();
  } catch (e) {
    if (e.status !== 428) toast('加载目录树失败：' + e.message, { type: 'warn' });
    kids.hidden = true;
  }
}

/** 属性值转义（含引号）—— 仅用于 HTML 属性；文本节点用 util.js 的 escapeHtml */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
