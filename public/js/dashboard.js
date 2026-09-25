/** 监控仪表盘 —— 存储用量 / 流量趋势 / 请求统计 / 操作日志 */
import { API } from './api.js';
import { fmtSize, fmtTime, escapeHtml, drawDonut, drawGroupedBars, drawStackedBars, drawHBars } from './util.js';
import { App } from './main.js';

/** 操作日志为管理员专属（日志详情含用户名 / 客户端 IP / 对象键 / 桶名）—— SEC-07 */
function isAdmin() {
  return !!(App.state.user && App.state.user.role === 'admin');
}

let logsShown = false;
let timer = null;

export const dashboard = {
  init() {
    const btn = document.getElementById('btn-logs-refresh');
    const sel = document.getElementById('logs-level');
    if (btn) btn.onclick = () => loadLogs();
    if (sel) sel.onchange = () => loadLogs();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearInterval(timer);
      else if (logsShown) startTimer();
    });
  },

  async refresh() {
    // 日志卡片按角色显隐：普通用户整卡隐藏且**不发起请求**（避免必然 403）
    const logsCard = document.getElementById('dash-logs-card');
    if (logsCard) logsCard.hidden = !isAdmin();
    logsShown = true;
    startTimer();
    const jobs = [loadStorage(), loadSummary()];
    if (isAdmin()) jobs.push(loadLogs());
    await Promise.all(jobs);
  },

  showLogs() {
    // 从侧边栏“操作日志”进入：滚到日志卡片（普通用户该卡片已被隐藏）
    if (!isAdmin()) return;
    setTimeout(() => {
      const el = document.getElementById('logs-table');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 300);
  },
};

function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (document.getElementById('dashboard').hidden) return;
    loadStorage(); loadSummary();
  }, 30000);
}

/* PERF-04：请求序号 —— 自动刷新（30s）与手动刷新会并发，慢的旧响应后到
   会把新结果覆盖掉。每次发起前自增，await 之后若自己不再是最新一次就丢弃。 */
let storageSeq = 0;
let summarySeq = 0;

async function loadStorage() {
  const seq = ++storageSeq;
  try {
    const st = await API.storage();
    if (seq !== storageSeq) return; // 已有更新的刷新：丢弃本次响应
    App.state.storageInfo = st;
    const quota = App.state.quotaBytes || 0;
    const used = st.usedBytes || 0;
    drawDonut(document.getElementById('chart-donut'), used, quota);
    const pct = quota ? (used / quota * 100) : 0;
    document.getElementById('storage-legend').innerHTML = `
      <div class="lg-row"><span><i class="dot" style="background:#4f8ef7"></i>已用容量</span><b>${fmtSize(used)}${quota ? `（${pct.toFixed(1)}%）` : ''}</b></div>
      <div class="lg-row"><span><i class="dot" style="background:#e6ebf2"></i>剩余容量</span><b>${quota ? fmtSize(Math.max(0, quota - used)) : '无限制'}</b></div>
      <div class="lg-row"><span><i class="dot" style="background:#39b97b"></i>对象数量</span><b>${st.objectCount ?? '—'} 个</b></div>
      <div class="lg-row"><span><i class="dot" style="background:#d97706"></i>配额上限</span><b>${quota ? fmtSize(quota) : '无限制'}</b></div>`;
    document.getElementById('storage-note').innerHTML =
      `数据来源：${escapeHtml(st.source === 'GetBucketStat' ? '服务商官方统计接口' : '实时列出生成量（估算）')} · 更新时间 ${escapeHtml(fmtTime(st.statTime))}${st.estimated ? ' · 官方统计数据每日更新，此处为实时估算' : '（官方统计存在延迟）'}<br>配额用于百分比展示，可点击左侧桶列表的编辑按钮按桶调整。`;
  } catch (e) {
    if (seq !== storageSeq) return;
    setDashError('存储用量加载失败：' + e.message);
  }
}

async function loadSummary() {
  const seq = ++summarySeq;
  try {
    const s = await API.summary();
    if (seq !== summarySeq) return;
    App.state.statsSummary = s;
    const t = s.traffic;
    document.getElementById('today-up').textContent = fmtSize(t.todayUp);
    document.getElementById('today-down').textContent = fmtSize(t.todayDown);
    const rq = s.requests;
    document.getElementById('today-ok').textContent = rq.today.ok;
    document.getElementById('today-fail').textContent = rq.today.fail;
    const total = rq.today.ok + rq.today.fail;
    document.getElementById('today-rate').textContent = total ? ((rq.today.ok / total) * 100).toFixed(1) + '%' : '—';
    // 状态栏（正文为实时速度，今日累计放入悬停提示）
    document.getElementById('status-traffic').title =
      `今日流量 ↑${fmtSize(t.todayUp)} ↓${fmtSize(t.todayDown)}（正文为实时速度，近 10 秒平均）`;

    const labels = rq.days.map((d) => d.date.slice(5)); // MM-DD
    drawGroupedBars(document.getElementById('chart-traffic'), labels, [
      { name: '上传', color: '#4f8ef7', values: t.days.map((d) => d.up) },
      { name: '下载', color: '#39b97b', values: t.days.map((d) => d.down) },
    ]);
    drawStackedBars(document.getElementById('chart-requests'), labels, [
      { name: '成功', color: '#4f8ef7', values: rq.days.map((d) => d.ok) },
      { name: '失败', color: '#e5484d', values: rq.days.map((d) => d.fail) },
    ]);
    drawHBars(document.getElementById('chart-types'), rq.byType.map((x) => ({ type: x.type, ok: x.ok, fail: x.fail })));
  } catch (e) {
    if (seq !== summarySeq) return;
    setDashError('统计数据加载失败：' + e.message);
  }
}

async function loadLogs() {
  const box = document.getElementById('logs-table');
  try {
    const level = document.getElementById('logs-level').value;
    const r = await API.logs({ limit: 200, level });
    if (!r.logs.length) {
      box.innerHTML = '<div style="color:#aaa;padding:16px;text-align:center">暂无日志</div>';
      return;
    }
    box.innerHTML = `<table><thead><tr><th style="width:150px">时间</th><th style="width:70px">级别</th><th style="width:110px">操作</th><th>详情</th></tr></thead>
      <tbody>${r.logs.map((l) => `<tr>
        <td>${escapeHtml(fmtTime(l.t))}</td>
        <td><span class="lv ${escapeHtml(l.level)}">${escapeHtml(l.level)}</span></td>
        <td>${escapeHtml(l.action)}</td>
        <td class="det">${escapeHtml(l.detail)}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (e) {
    box.innerHTML = `<div style="color:var(--danger);padding:10px">日志加载失败：${escapeHtml(e.message)}</div>`;
  }
}

function setDashError(msg) {
  let el = document.querySelector('.dash-err');
  if (!el) {
    el = document.createElement('div');
    el.className = 'dash-err';
    document.getElementById('dashboard').prepend(el);
  }
  el.textContent = msg + '（若未配置密钥请先完成设置）';
}
