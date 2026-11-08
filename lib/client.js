// 由 scripts/build-client.mjs 从 src/client/ 生成；请修改 src/client/ 后运行 npm run build:client。
/**
 * dsh-ownsync 浏览器端 bundle（由 scripts/build-client.mjs 从 src/client 拼接生成）。
 *
 * 只有一个页面：配置仓库地址、看状态、点「上传」或「下载」。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ownsync',
  factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
const react = require('react');
const e = react.createElement;
const { useState, useEffect, useCallback, useRef } = react;
/* ---------- 接口 ---------- */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(async response => {
    const data = await response.json().catch(() => null);
    if (!data) throw new Error('服务器没有返回结果');
    return data;
  });
}

const API = {
  status: () => fetch('/ownsync/api/status').then(response => response.json()),
  check: () => post('/ownsync/api/check', {}),
  upload: confirm => post('/ownsync/api/upload', { confirm }),
  download: confirm => post('/ownsync/api/download', { confirm }),
  retryPending: () => post('/ownsync/api/pending/retry', {}),
  restart: returnTo => post('/ownsync/api/restart', returnTo ? { returnTo } : {}),
  ackReturn: () => post('/ownsync/api/return/ack', {}),
  saveConfig: (remote, branch) => post('/ownsync/api/config', { remote, branch }),
  backups: () => fetch('/ownsync/api/backups').then(response => response.json()),
};
/* ---------- 样式 ---------- */
const STYLE = `
.os-wrap{display:flex;flex-direction:column;gap:14px;padding:16px}
.os-pill{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border-radius:999px;border:1px solid transparent;font-size:12px;line-height:1.2;max-width:100%}
.os-dot{flex:none;width:6px;height:6px;border-radius:50%;background:#16a34a}
.os-pill-warn .os-dot{background:#d97706}
.os-pill-err .os-dot{background:#dc2626}
.os-pill-muted .os-dot{background:#94a3b8}
.os-pill-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
.os-pill-warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
.os-pill-err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4)}
.os-pill-muted{background:rgba(100,116,139,.12);border-color:rgba(100,116,139,.3)}
.os-btn{padding:8px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d7dce3);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-family:inherit;font-size:13px;line-height:1.2;cursor:pointer;white-space:nowrap}
.os-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
.os-btn:disabled{opacity:.45;cursor:not-allowed}
.os-btn:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:1px}
.os-btn-primary{background:var(--dsw-alias-accent,#2563eb);border-color:var(--dsw-alias-accent,#2563eb);color:#fff}
.os-btn-primary:hover:not(:disabled){background:var(--dsw-alias-accent,#2563eb);filter:brightness(1.06)}
.os-btn-danger{background:#dc2626;border-color:#dc2626;color:#fff}
.os-btn-danger:hover:not(:disabled){background:#dc2626;filter:brightness(1.06)}
.os-btn-check{background:#f0b400;border-color:#f0b400;color:#3b2f00}
.os-btn-check:hover:not(:disabled){background:#f0b400;filter:brightness(1.06)}
.os-note{padding:10px 12px;border-radius:8px;border:1px solid transparent;font-size:13px;line-height:1.6;overflow-wrap:anywhere}
.os-note-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
.os-note-warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
.os-note-err{background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4)}
.os-list{margin:4px 0 0;padding-left:18px;font-size:12px;line-height:1.7;max-height:140px;overflow:auto;overflow-wrap:anywhere}
.os-confirm{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:10px;border:1px solid rgba(245,158,11,.45);background:rgba(245,158,11,.1)}
.os-confirm-text{font-size:13px;line-height:1.6}
.os-confirm-actions{display:flex;gap:8px}
.os-settings-body{display:flex;flex-direction:column;gap:10px}
.os-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.os-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}
.os-field-inline{display:flex;align-items:center;gap:8px}
.os-field-inline .os-field-label{flex:1 1 auto;min-width:0}
.os-field-inline .os-btn{box-sizing:border-box;height:24px;padding:0 10px;font-size:12px;flex:0 0 auto}
.os-input-num{box-sizing:border-box;flex:0 0 64px;width:64px;text-align:right}
.os-input-branch{box-sizing:border-box;flex:0 0 64px;width:64px}
.os-field-unit{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);flex:0 0 auto}
.os-input{box-sizing:border-box;width:100%;height:24px;padding:0 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d7dce3);background:var(--dsw-alias-bg-layer-1,#fff);color:inherit;font-family:inherit;font-size:13px;line-height:22px}
.os-input:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:1px}
.os-input-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
.os-hint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#9ca3af);overflow-wrap:anywhere}
.os-foot{display:inline-flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer;text-align:left}
.os-foot:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.os-foot-on{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14))}
.os-foot:focus-visible{outline:2px solid var(--dsw-alias-accent,#2563eb);outline-offset:2px}
.os-foot-label{font-size:13px;white-space:nowrap}
.os-nav{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;font-size:15px;line-height:1}
.os-dock{display:flex;flex-direction:column;gap:6px;flex:1 1 100%;min-width:0;padding:0 2px}
.os-dock-card{display:flex;flex-direction:column;gap:5px;padding:8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#e2e6ec);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}
.os-dock-row{display:flex;min-width:0}
.os-dock .os-pill{font-size:11px;padding:3px 8px}
.os-pill-button{cursor:pointer;border:0;font:inherit;text-align:left}
.os-caret{margin-left:2px;font-size:9px;opacity:.75}
.os-dock-changes{display:flex;flex-direction:column;gap:2px;margin-top:2px;padding:6px 8px;border-radius:6px;border:1px solid transparent;font-size:11px;line-height:1.5;max-height:120px;overflow:auto}
.os-dock-changes-warn{background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.4)}
.os-dock-changes-ok{background:rgba(34,197,94,.12);border-color:rgba(34,197,94,.35)}
.os-dock-changes ul{margin:2px 0 0;padding-left:14px}
.os-dock-paths{overflow-wrap:anywhere}
.os-dock-more{opacity:.75}
.os-dock-meta{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:1.4;color:var(--dsw-alias-label-secondary,#6b7280);font-variant-numeric:tabular-nums;min-width:0}
.os-dock-meta>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.os-dock-actions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:2px}
.os-dock-actions .os-btn{box-sizing:border-box;height:26px;padding:0 8px;font-size:12px;border-radius:7px}
.os-dock .os-foot{justify-content:center;align-self:flex-start;width:fit-content;min-width:0}
.os-dock-note{display:flex;flex-direction:column;gap:4px;padding:6px 8px;border-radius:6px;border:1px solid transparent;font-size:11px;line-height:1.5;overflow-wrap:anywhere;max-height:7em;overflow:auto}
.os-dock-note .os-link{align-self:flex-start;font-size:11px;padding:0}
.os-popover{position:fixed;z-index:900;display:flex;flex-direction:column;overflow:hidden;border-radius:14px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 16px 44px rgba(15,23,42,.2);pointer-events:auto}
.os-popover-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px 4px;background:transparent}
.os-popover-title{font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#6b7280)}
.os-popover-close{width:26px;height:26px;line-height:1;border:0;border-radius:6px;background:transparent;color:inherit;font-size:18px;cursor:pointer}
.os-popover-close:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.os-popover-body{flex:1;min-height:0;overflow:auto}
.os-popover .os-wrap{padding:8px 16px 16px}
.os-section{display:block}
.os-lock{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(15,23,42,.5)}
.os-lock-card{display:flex;flex-direction:column;gap:12px;width:min(360px,100%);padding:20px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 24px 64px rgba(0,0,0,.3);outline:none}
.os-lock-title{font-size:15px;font-weight:600}
.os-lock-text{margin:0;font-size:13px;line-height:1.7;color:var(--dsw-alias-label-secondary,#6b7280)}
.os-lock-actions{display:flex;gap:8px;justify-content:flex-end}
`;

let stylesInjected = false;
function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  try {
    const element = document.createElement('style');
    element.setAttribute('data-dsh-ownsync', '');
    element.textContent = STYLE;
    document.head.appendChild(element);
  } catch {
    /* 样式注入失败不影响功能 */
  }
}
/* ---------- 状态与文案 ---------- */
function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = number => String(number).padStart(2, '0');
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    ' ' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

function fmtSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KiB';
  if (value < 1024 * 1024 * 1024) return (value / 1048576).toFixed(1) + ' MiB';
  return (value / 1073741824).toFixed(2) + ' GiB';
}

/** 本机与服务器的关系，给状态卡用。 */
function relationOf(status, remote) {
  if (!status || !status.configured) return { id: 'unconfigured', level: 'muted', text: '未填写仓库地址' };
  const local = status.local?.version || 0;
  const changes = status.localChanges?.count || 0;
  const dirty = changes > 0;
  if ((status.local?.pending?.length || 0) > 0)
    return { id: 'pending', level: 'warn', text: '有会话待写回本机' };

  // 还没连服务器：本机有没有改动仍然能判断出来
  if (!remote) {
    return dirty
      ? { id: 'dirty-unknown', level: 'warn', text: '本机有 ' + changes + ' 处未上传改动' }
      : { id: 'unchecked', level: 'muted', text: '尚未检查服务器' };
  }
  if (remote.error) return { id: 'error', level: 'err', text: '无法连接服务器：' + remote.error };
  // 服务器还是空的：不管本机有没有内容，都应该先上传
  if (remote.remoteEmpty) return { id: 'server-empty', level: 'warn', text: '服务器上还没有内容，建议上传' };

  const server = remote.remoteVersion || 0;
  if (remote.inSync) {
    const count = changes || remote.localChanges?.count || 0;
    if (remote.localDirty || dirty)
      return { id: 'dirty', level: 'warn', text: '本机有 ' + Math.max(count, 1) + ' 处未上传改动' };
    return { id: 'synced', level: 'ok', text: '已同步' };
  }
  if (local === 0) return { id: 'empty', level: 'warn', text: '本机尚未下载' };
  if (local < server) return { id: 'server-ahead', level: 'warn', text: '服务器版本较新，建议下载' };
  if (local > server) return { id: 'local-ahead', level: 'warn', text: '本机版本较新，建议上传' };
  return { id: 'mismatch', level: 'warn', text: '本机与服务器内容不同' };
}

/**
 * 每个状态允许按哪个按钮。
 * 没配地址 / 没检查 / 连不上 / 已同步：两个都不按；
 * 本机有改动：只能上传；服务器较新或本机没下载过：只能下载。
 */
const ACTION_RULES = {
  unconfigured: { upload: false, download: false, reason: '还没有填写仓库地址' },
  unchecked: { upload: false, download: false, reason: '请先检查服务器' },
  error: { upload: false, download: false, reason: '无法连接服务器' },
  synced: { upload: false, download: false, reason: '已经是最新' },
  pending: { upload: false, download: true, reason: '有会话待写回本机，请先下载' },
  'server-empty': { upload: true, download: false, reason: '服务器上还没有内容，请先上传' },
  empty: { upload: false, download: true, reason: '本机还没有服务器上的内容' },
  'server-ahead': { upload: false, download: true, reason: '服务器版本较新，请先下载' },
  'dirty-unknown': { upload: true, download: false, reason: '本机有未上传改动，请先上传' },
  dirty: { upload: true, download: false, reason: '本机有未上传改动，请先上传' },
  'local-ahead': { upload: true, download: false, reason: '本机版本较新，请先上传' },
  mismatch: { upload: true, download: true, reason: '' },
};

function actionsFor(relation) {
  return ACTION_RULES[relation?.id] || { upload: true, download: true, reason: '' };
}

function describeResult(action, result) {
  if (!result) return '';
  if (result.upToDate) return '服务器和本机已经是同一版本（v' + (result.version || 0) + '）';
  if (action === 'upload') {
    const parts = ['已上传 v' + result.version];
    parts.push('包含 ' + (result.files || 0) + ' 个文件');
    if (result.deleted) parts.push('移除 ' + result.deleted + ' 个');
    let text = parts.join('，');
    if (result.skipped?.length) text += '；' + result.skipped.length + ' 个附件超过大小上限未上传';
    return text;
  }
  const parts = ['已取回 v' + result.version];
  parts.push('写入 ' + (result.applied || 0) + ' 个文件');
  if (result.skipped) parts.push('跳过 ' + result.skipped + ' 个未变化的');
  if (result.removed) parts.push('删除 ' + result.removed + ' 个');
  let text = parts.join('，');
  if (result.deferred?.length) text += '；' + result.deferred.length + ' 个会话等待关闭后应用';
  if (result.failures?.length) text += '；' + result.failures.length + ' 个文件写入失败';
  return text;
}

function errorText(result) {
  if (!result) return '操作失败';
  return result.message || result.error || '操作失败';
}
/* ---------- 共享状态 ---------- */
// 侧栏卡片和设置弹层读同一份状态：版本、状态、忙碌、提示、待确认。
// 每次发布都换新对象（React 用 Object.is 判断是否重渲染）。
const DEFAULT_INTERVALS = { statusMs: 5000, checkMs: 10_000 };
const INTERVALS_KEY = 'dsh-ownsync.intervals';

function clampInterval(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(600_000, Math.max(1000, Math.round(number)));
}

/** 刷新间隔存在浏览器本地：本机状态轮询 + 服务器自动检查。 */
function readIntervals() {
  try {
    const raw = window.localStorage.getItem(INTERVALS_KEY);
    if (!raw) return { ...DEFAULT_INTERVALS };
    const parsed = JSON.parse(raw);
    return {
      statusMs: clampInterval(parsed?.statusMs, DEFAULT_INTERVALS.statusMs),
      checkMs: clampInterval(parsed?.checkMs, DEFAULT_INTERVALS.checkMs),
    };
  } catch {
    return { ...DEFAULT_INTERVALS };
  }
}

function saveIntervals(patch) {
  const next = {
    statusMs: clampInterval(patch?.statusMs ?? syncState.intervals.statusMs, DEFAULT_INTERVALS.statusMs),
    checkMs: clampInterval(patch?.checkMs ?? syncState.intervals.checkMs, DEFAULT_INTERVALS.checkMs),
  };
  try {
    window.localStorage.setItem(INTERVALS_KEY, JSON.stringify(next));
  } catch {
    /* 存不了就只在本页生效 */
  }
  publishSync({ intervals: next });
}

const syncState = {
  status: null,
  remote: null,
  busy: '',
  checking: false,
  intervals: readIntervals(),
  lastUpload: null,
  notice: null,
  confirm: null,
  recovering: null,
};
const syncListeners = new Set();
let syncLoaded = false;

function publishSync(patch) {
  Object.assign(syncState, patch);
  const snapshot = { ...syncState };
  for (const listener of [...syncListeners]) {
    try {
      listener(snapshot);
    } catch {
      /* 一个订阅者出错不影响其他订阅者 */
    }
  }
}

function useSyncStore() {
  const [snapshot, setSnapshot] = useState({ ...syncState });
  useEffect(() => {
    syncListeners.add(setSnapshot);
    setSnapshot({ ...syncState });
    return () => {
      syncListeners.delete(setSnapshot);
    };
  }, []);
  return snapshot;
}

async function refreshSync(withCheck) {
  try {
    const data = await API.status();
    publishSync({ status: data });
    void maybeReturnToSession(data);
    if (withCheck && data.configured) {
      const checked = await API.check();
      publishSync({ remote: checked && checked.ok ? checked.remote : { error: errorText(checked) } });
    }
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '无法读取同步状态：' + (error.message || error) } });
  }
}

/** 只刷新本机状态（不连服务器），用于侧栏卡片的定时刷新。 */
async function refreshStatusOnly() {
  try {
    const data = await API.status();
    publishSync({ status: data });
    void maybeReturnToSession(data);
  } catch {
    /* 轮询失败不打扰用户，下一次再试 */
  }
}

let returnedToSession = false;
let returnRetry = null;
let returnAttempts = 0;

/** 重启后补写完成时，宿主会记下"回到哪个会话"，客户端连上后跳回去。 */
async function maybeReturnToSession(data) {
  if (returnedToSession) return;
  const target = data?.returnTo;
  if (!target) return;
  if ((data.local?.pending || []).length > 0) return;
  // 导航服务还没就绪时先不动，稍后重试（不用等 5 秒轮询）
  if (!workspaceNavigation?.openSession) {
    scheduleReturnRetry();
    return;
  }
  try {
    workspaceNavigation.openSession(target);
  } catch {
    // 没跳成功就不清标记，稍后再试
    if (returnAttempts < 3) {
      returnAttempts += 1;
      scheduleReturnRetry();
    }
    return;
  }
  returnedToSession = true;
  try {
    await API.ackReturn();
  } catch {
    /* 清标记失败下次再说 */
  }
  publishSync({ status: { ...data, returnTo: null } });
}

function scheduleReturnRetry() {
  if (returnRetry) return;
  returnRetry = setTimeout(() => {
    returnRetry = null;
    refreshStatusOnly();
  }, 800);
}

let checkInFlight = false;

/** 点「检查更新」：立刻连一次服务器。silent=true 用于后台定时检查。 */
async function checkServerNow(options = {}) {
  const silent = Boolean(options.silent);
  if (checkInFlight) return;
  checkInFlight = true;
  if (!silent) publishSync({ checking: true });
  try {
    const checked = await API.check();
    publishSync({
      remote: checked && checked.ok ? checked.remote : { error: errorText(checked) },
    });
    if (!silent && (!checked || checked.ok === false)) {
      publishSync({ notice: { kind: 'err', text: '检查失败：' + errorText(checked) } });
    }
  } catch (error) {
    if (!silent) publishSync({ notice: { kind: 'err', text: '检查失败：' + (error.message || error) } });
  } finally {
    checkInFlight = false;
    if (!silent) publishSync({ checking: false });
  }
}

/** 侧栏卡片挂载时拉一次；重复挂载不重复请求。 */
function ensureSyncLoaded() {
  if (syncLoaded) return;
  syncLoaded = true;
  refreshSync(true);
}

async function runSyncAction(kind, token) {
  publishSync({ busy: kind, notice: null, confirm: null });
  try {
    const result = kind === 'upload' ? await API.upload(token) : await API.download(token);
    if (result && result.needsConfirm) {
      publishSync({
        confirm: {
          kind,
          token: result.needsConfirm,
          message: result.message,
          items: result.deletions || result.dirty || [],
        },
      });
      openPopover();
    } else if (!result || result.ok === false || result.error) {
      publishSync({ notice: { kind: 'err', text: errorText(result) } });
      openPopover();
    } else if (kind === 'upload') {
      // 上传结果不直接弹提示条，改成点「已同步」时在卡片里展开
      publishSync({
        lastUpload: {
          version: result.version,
          files: result.files,
          changedCount: result.upToDate ? 0 : result.changedCount || 0,
          changedFiles: result.changedFiles || [],
        },
        notice: null,
      });
    } else {
      // 会话被宿主占用：走自动恢复（遮罩 → 切空白会话 → 探测 → 重试 → 切回）
      const stuck =
        kind === 'download' ? (result.deferred || []).filter(item => item.reason === 'session-writer-held') : [];
      if (stuck.length) {
        await recoverSessions(result.deferred);
      } else if (kind === 'download' && Array.isArray(result.appliedSessions) && result.appliedSessions.length > 0) {
        publishSync({
          notice: {
            kind: 'warn',
            text:
              '已取回 v' +
              result.version +
              '，' +
              result.appliedSessions.length +
              ' 个会话已写回本机。DSH 里显示的还是旧内容，完全退出再打开 DSH 后即可看到。',
          },
        });
      } else {
        const text = describeResult(kind, result);
        publishSync({
          notice: {
            kind: result.restartRequired ? 'warn' : 'ok',
            text: text + (result.restartRequired ? '。请完全退出 DSH 后重新打开。' : ''),
          },
        });
      }
    }
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '操作失败：' + (error.message || error) } });
    openPopover();
  } finally {
    publishSync({ busy: '' });
    refreshSync(true);
  }
}

async function checkServer() {
  publishSync({ busy: 'check', notice: null });
  try {
    const data = await API.check();
    if (data && data.ok) publishSync({ remote: data.remote });
    else {
      publishSync({ remote: { error: errorText(data) }, notice: { kind: 'err', text: errorText(data) } });
    }
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '检查失败：' + (error.message || error) } });
  } finally {
    publishSync({ busy: '' });
    refreshSync(false);
  }
}

async function saveSyncConfig(remote, branch) {
  publishSync({ busy: 'config', notice: null });
  try {
    const result = await API.saveConfig(remote, branch);
    if (!result || result.ok === false) publishSync({ notice: { kind: 'err', text: errorText(result) } });
    else publishSync({ notice: { kind: 'ok', text: '仓库设置已保存' } });
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '保存失败：' + (error.message || error) } });
  } finally {
    publishSync({ busy: '' });
    refreshSync(true);
  }
}

function dismissSyncConfirm() {
  publishSync({ confirm: null, notice: { kind: 'warn', text: '已取消。' } });
}

/** 提示条上的动作（目前只有"重启 DSH"）。 */
async function runNoticeAction() {
  const action = syncState.notice?.action;
  if (!action || action.kind !== 'restart') return;
  publishSync({ notice: { kind: 'warn', text: '正在重启 DSH…' } });

  let host = null;
  try {
    const result = await API.restart(action.returnTo || null);
    if (result && result.restarted) {
      publishSync({
        notice: { kind: 'warn', text: '正在重启 DSH，重新打开后会自动回到这个会话。' },
      });
      return;
    }
    host = result?.host || null;
    try {
      console.info('[dsh-ownsync] 自动重启不可用，宿主信息：' + JSON.stringify(host || {}));
    } catch {
      /* 没有 console 也无所谓 */
    }
  } catch (error) {
    try {
      console.info('[dsh-ownsync] 重启请求失败：' + (error.message || error));
    } catch {
      /* ignore */
    }
  }

  const exe = host?.execPath ? String(host.execPath).split(/[\\/]/).pop() : '未知';
  const why = host?.requireError ? '，原因：' + String(host.requireError).slice(0, 60) : '';
  publishSync({
    notice: {
      kind: 'warn',
      text:
        '当前宿主不能自动重启（electron=' +
        (host?.electron || '无') +
        '，type=' +
        (host?.type || '未知') +
        '，程序=' +
        exe +
        why +
        '）。请完全退出 DSH 再打开，重新打开后会自动回到这个会话。',
    },
  });
}
/* ---------- 会话被占用：切空白会话 + 重启 DSH ---------- */
// DSH 的写入权归活着的 Agent，界面切走不会释放；只有进程退出才释放。
// 所以这里的流程是：切到空白会话（重启后会恢复它）→ 重启 DSH → 启动时补写并跳回。
// 没有轮询、没有 12 秒等待。

let workspaceNavigation = null;

function setWorkspaceNavigation(navigation) {
  workspaceNavigation = navigation;
}

/** 从 `sessions/<分组>/<会话 id>/session…` 里取出会话 id。 */
function sessionIdFromPath(path) {
  const match = /^sessions\/[^/]+\/([^/]+)\//.exec(String(path || '').replace(/\\/g, '/'));
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function closeRecoverOverlay() {
  publishSync({ recovering: null });
}

/** 遮罩上的「重启 DSH」：先尝试自动重启，失败就把手动步骤写在遮罩里。 */
async function restartFromRecover() {
  const current = syncState.recovering;
  if (!current) return;
  publishSync({ recovering: { ...current, phase: 'restarting', message: '正在重启 DSH…' } });

  let result = null;
  try {
    result = await API.restart(current.sessionId || null);
  } catch (error) {
    result = { restarted: false, error: String(error?.message || error) };
  }

  if (result && result.restarted) {
    publishSync({
      recovering: {
        ...current,
        phase: 'restarting',
        message: '正在重启 DSH，重新打开后会自动写回并回到这个会话。',
      },
    });
    return;
  }

  const exe = result?.host?.execPath ? String(result.host.execPath).split(/[\\/]/).pop() : '未知';
  const why = result?.host?.requireError ? '，原因：' + String(result.host.requireError).slice(0, 60) : '';
  publishSync({
    recovering: {
      ...current,
      phase: 'manual',
      message:
        '当前宿主不能自动重启（electron=' +
        (result?.host?.electron || '无') +
        '，type=' +
        (result?.host?.type || '未知') +
        '，程序=' +
        exe +
        why +
        '）。请完全退出 DSH 再打开；重新打开后会自动写回并回到这个会话。',
    },
  });
}

async function recoverSessions(deferred) {
  const target = deferred.find(item => item.reason === 'session-writer-held');
  if (!target) return;

  if (!workspaceNavigation?.startSession) {
    publishSync({
      notice: {
        kind: 'warn',
        text: '这个会话正在使用。请完全退出 DSH 后重新打开，再点一次「下载」。',
      },
    });
    return;
  }

  publishSync({
    notice: null,
    recovering: { active: true, phase: 'switching', message: '正在切到空白会话…' },
  });

  try {
    // 切到空白会话：DSH 会记住这个选择，重启后恢复的也是它，目标会话就不会被占用
    workspaceNavigation.startSession(undefined, { clearPreviousDraft: false });
    await sleep(500);

    publishSync({
      recovering: { active: true, phase: 'restarting', message: '已切到空白会话，正在重启 DSH…' },
    });

    const result = await API.restart(sessionIdFromPath(target.path));
    if (result && result.restarted) {
      publishSync({
        recovering: {
          active: true,
          phase: 'restarting',
          message: '正在重启 DSH。重新打开后会自动写回，并回到原来的会话。',
        },
      });
      return; // 页面随后断开
    }

    publishSync({
      recovering: {
        active: true,
        phase: 'manual',
        message: '已切到空白会话。请完全退出 DSH 再打开；重新打开后会自动写回，并回到原来的会话。',
        sessionId: sessionIdFromPath(target.path),
      },
    });
  } catch (error) {
    publishSync({
      recovering: {
        active: true,
        phase: 'manual',
        message: '已切到空白会话。请完全退出 DSH 再打开；重新打开后会自动写回。',
      },
    });
  }
}
/* ---------- 设置面板（弹层与设置页共用） ---------- */
function OwnsyncPanel(props) {
  const state = useSyncStore();
  const [draft, setDraft] = useState({ remote: '', branch: 'main' });
  const draftTouched = useRef(false);
  const busy = Boolean(state.busy);
  const relation = relationOf(state.status, state.remote);
  const showStatus = Boolean(props && props.showStatus);

  useEffect(() => {
    if (draftTouched.current || !state.status) return;
    setDraft({ remote: state.status.remote || '', branch: state.status.branch || 'main' });
  }, [state.status]);

  const save = () => saveSyncConfig(draft.remote.trim(), (draft.branch || 'main').trim());

  return e(
    'div',
    { className: 'os-wrap' },
    showStatus
      ? e(
          'span',
          {
            className:
              'os-pill os-pill-' +
              (relation.level === 'ok'
                ? 'ok'
                : relation.level === 'err'
                  ? 'err'
                  : relation.level === 'muted'
                    ? 'muted'
                    : 'warn'),
          },
          e('span', { className: 'os-dot', 'aria-hidden': 'true' }),
          relation.text,
        )
      : null,
    state.confirm
      ? e(
          'section',
          { className: 'os-confirm' },
          e('div', { className: 'os-confirm-text' }, state.confirm.message),
          state.confirm.items.length
            ? e(
                'ul',
                { className: 'os-list' },
                state.confirm.items.slice(0, 50).map(item => e('li', { key: item }, item)),
                state.confirm.items.length > 50
                  ? e('li', { key: 'more' }, '……共 ' + state.confirm.items.length + ' 个')
                  : null,
              )
            : null,
          e(
            'div',
            { className: 'os-confirm-actions' },
            e(
              'button',
              {
                type: 'button',
                className: 'os-btn os-btn-danger',
                onClick: () => runSyncAction(state.confirm.kind, state.confirm.token),
              },
              state.confirm.kind === 'upload' ? '确认上传' : '确认下载',
            ),
            e('button', { type: 'button', className: 'os-btn', onClick: dismissSyncConfirm }, '取消'),
          ),
        )
      : null,
    e(
      'div',
      { className: 'os-settings-body' },
      e(
        'label',
        { className: 'os-field' },
        e('span', { className: 'os-field-label' }, '仓库地址'),
        e('input', {
          className: 'os-input os-input-url',
          type: 'text',
          placeholder: 'ssh://git@server:2222/srv/git/dsh-sync.git',
          value: draft.remote,
          spellCheck: false,
          onChange: event => {
            draftTouched.current = true;
            setDraft(current => ({ ...current, remote: event.target.value }));
          },
        }),
      ),
      e(
        'div',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '分支'),
        e('input', {
          className: 'os-input os-input-branch',
          type: 'text',
          placeholder: 'main',
          value: draft.branch,
          spellCheck: false,
          onChange: event => {
            draftTouched.current = true;
            setDraft(current => ({ ...current, branch: event.target.value }));
          },
        }),
        e(
          'button',
          { type: 'button', className: 'os-btn', disabled: busy, onClick: save },
          state.busy === 'config' ? '保存中…' : '保存',
        ),
      ),
      e(
        'label',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '本机状态刷新间隔'),
        e('input', {
          className: 'os-input os-input-num',
          type: 'number',
          min: 1,
          max: 600,
          step: 1,
          value: Math.round((state.intervals?.statusMs || 5000) / 1000),
          onChange: event => saveIntervals({ statusMs: Number(event.target.value) * 1000 }),
        }),
        e('span', { className: 'os-field-unit' }, '秒'),
      ),
      e(
        'label',
        { className: 'os-field-inline' },
        e('span', { className: 'os-field-label' }, '服务器自动检查间隔'),
        e('input', {
          className: 'os-input os-input-num',
          type: 'number',
          min: 1,
          max: 600,
          step: 1,
          value: Math.round((state.intervals?.checkMs || 10_000) / 1000),
          onChange: event => saveIntervals({ checkMs: Number(event.target.value) * 1000 }),
        }),
        e('span', { className: 'os-field-unit' }, '秒'),
      ),
    ),
  );
}

/** 设置页里的同一份面板（多显示一行状态，设置页没有侧栏卡片）。 */
function OwnsyncSection() {
  return e('div', { className: 'os-section' }, e(OwnsyncPanel, { showStatus: true }));
}
/* ---------- 设置弹层 ---------- */
// 侧栏卡片负责日常状态与上传/下载；这个弹层只放设置、提示和需要确认的操作。
// 不用遮罩、不铺满屏：打开时仍然可以点开别的对话。
let popoverState = { open: false, anchor: null };
const popoverListeners = new Set();

function publishPopover(next) {
  popoverState = next;
  for (const listener of [...popoverListeners]) {
    try {
      listener(next);
    } catch {
      /* 一个订阅者出错不影响其他订阅者 */
    }
  }
}

function togglePopover(anchor) {
  publishPopover(
    popoverState.open
      ? { open: false, anchor: null }
      : { open: true, anchor: anchor || popoverState.anchor || null },
  );
}

function openPopoverAt(anchor) {
  publishPopover({ open: true, anchor: anchor || popoverState.anchor || null });
}

/** 供状态层在"需要确认/出错"时把设置弹层拉出来。 */
function openPopover() {
  if (!popoverState.open) publishPopover({ open: true, anchor: popoverState.anchor || null });
}

function closePopover() {
  publishPopover({ open: false, anchor: null });
}

function usePopoverState() {
  const [state, setState] = useState(popoverState);
  useEffect(() => {
    popoverListeners.add(setState);
    setState(popoverState);
    return () => {
      popoverListeners.delete(setState);
    };
  }, []);
  return state;
}

function OwnsyncPopover() {
  const state = usePopoverState();

  useEffect(() => {
    if (!state.open || typeof document === 'undefined') return undefined;
    const onKey = event => {
      if (event.key === 'Escape') closePopover();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [state.open]);

  if (!state.open) return null;

  const rect = state.anchor;
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight || 800;
  const top = rect && Number.isFinite(rect.top) ? rect.top : viewportHeight - 90;
  const left = rect && Number.isFinite(rect.left) ? rect.left : 12;
  const style = {
    left: Math.max(8, left) + 'px',
    bottom: Math.max(8, viewportHeight - top + 8) + 'px',
    width: 'min(280px, calc(100vw - 24px))',
    maxHeight: 'min(72vh, 640px)',
  };

  return e(
    'div',
    { className: 'os-popover', style, role: 'dialog', 'aria-label': '同步设置' },
    e(
      'div',
      { className: 'os-popover-head' },
      e('span', { className: 'os-popover-title' }, '同步设置'),
      e(
        'button',
        { type: 'button', className: 'os-popover-close', onClick: closePopover, 'aria-label': '关闭' },
        '×',
      ),
    ),
    e('div', { className: 'os-popover-body' }, e(OwnsyncPanel)),
  );
}

/* ---------- 写回遮罩 ---------- */
// 自动恢复期间盖住整个界面：阻止点击与输入，直到写完或超时/取消。
function OwnsyncRecovering() {
  const state = useSyncStore();
  const recovering = state.recovering;
  const cardRef = useRef(null);

  useEffect(() => {
    if (!recovering || !recovering.active) return;
    try {
      cardRef.current?.focus?.();
    } catch {
      /* 拿不到焦点也不影响流程 */
    }
  }, [recovering && recovering.active]);

  if (!recovering || !recovering.active) return null;
  return e(
    'div',
    { className: 'os-lock' },
    e(
      'div',
      {
        className: 'os-lock-card',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '正在写回本机',
        tabIndex: -1,
        ref: cardRef,
      },
      e('div', { className: 'os-lock-title' }, '需要重启 DSH 才能写回'),
      e('p', { className: 'os-lock-text' }, recovering.message || '请稍候。'),
      recovering.phase === 'manual'
        ? e(
            'div',
            { className: 'os-lock-actions' },
            e('button', { type: 'button', className: 'os-btn os-btn-primary', onClick: restartFromRecover }, '重启 DSH'),
            e('button', { type: 'button', className: 'os-btn', onClick: closeRecoverOverlay }, '稍后'),
          )
        : null,
    ),
  );
}
/* ---------- 侧栏底部卡片 ---------- */
// 注册在 sidebar.footer.action（左下角、头像上方）。侧栏展开时显示一张紧凑卡片：
// 状态、本机/服务器版本、上次同步、上传/下载；点下面的「同步」打开设置弹层。
// 侧栏收起成图标栏时只保留一个图标按钮，避免撑破 56px 宽度。
function OwnsyncDock(props) {
  const state = useSyncStore();
  const [showChanges, setShowChanges] = useState(false);
  const wide = !props || props.wide !== false;
  useEffect(() => {
    ensureSyncLoaded();
  }, []);

  const statusMs = state.intervals?.statusMs || 5000;
  const checkMs = state.intervals?.checkMs || 10_000;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
    // 按设置里的间隔刷新本机状态（只查本机，不联网）
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      refreshStatusOnly();
    }, statusMs);
    // 按设置里的间隔自动检查服务器版本：不动焦点、不打断输入
    const checkTimer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (syncState.busy) return;
      checkServerNow({ silent: true });
    }, checkMs);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(checkTimer);
    };
  }, [statusMs, checkMs]);

  const busy = Boolean(state.busy);
  const local = state.status?.local?.version || 0;
  const server = state.remote && !state.remote.error ? 'v' + (state.remote.remoteVersion || 0) : '—';
  const lastSync = !state.status
    ? '—'
    : state.status.local?.updatedAt
      ? fmtTime(state.status.local.updatedAt)
      : '从未同步';
  const relation = relationOf(state.status, state.remote);
  const actions = actionsFor(relation);
  const dirtyCount = state.status?.localChanges?.count || 0;
  const dirtyDetails = state.status?.localChanges?.details || [];
  const dirtySample = state.status?.localChanges?.sample || [];
  const lastUpload = state.lastUpload;
  const canExpand = dirtyCount > 0 || Boolean(lastUpload);
  const pillClass =
    'os-pill os-pill-' +
    (relation.level === 'ok' ? 'ok' : relation.level === 'err' ? 'err' : relation.level === 'muted' ? 'muted' : 'warn');

  const pillChildren = [
    e('span', { className: 'os-dot', 'aria-hidden': 'true', key: 'dot' }),
    relation.text,
    canExpand
      ? e('span', { className: 'os-caret', 'aria-hidden': 'true', key: 'caret' }, showChanges ? '▴' : '▾')
      : null,
  ];

  const pill = canExpand
    ? e(
        'button',
        {
          type: 'button',
          className: pillClass + ' os-pill-button',
          title: dirtyCount > 0 ? '查看有改动的文件' : '查看上次上传结果',
          onClick: () => setShowChanges(value => !value),
        },
        ...pillChildren,
      )
    : e('span', { className: pillClass }, ...pillChildren);

  const changeList = !showChanges || !canExpand
    ? null
    : dirtyCount > 0
      ? e(
          'div',
          { className: 'os-dock-changes os-dock-changes-warn' },
          '有改动的文件（' + dirtyCount + '）：',
          dirtyDetails.length
            ? e(
                'ul',
                null,
                ...dirtyDetails.map(item => e('li', { key: item.path, title: item.path }, item.label)),
              )
            : e('div', { className: 'os-dock-paths' }, dirtySample.join('、')),
          dirtyDetails.length && dirtyCount > dirtyDetails.length
            ? e('div', { className: 'os-dock-more' }, '……还有 ' + (dirtyCount - dirtyDetails.length) + ' 个')
            : null,
        )
      : e(
          'div',
          { className: 'os-dock-changes os-dock-changes-ok' },
          lastUpload.changedCount > 0
            ? '已上传 v' + lastUpload.version + '，这次更新了 ' + lastUpload.changedCount + ' 个改动：'
            : '已是最新 v' + lastUpload.version,
          (lastUpload.changedFiles || []).length
            ? e(
                'ul',
                null,
                ...(lastUpload.changedFiles || []).map(item =>
                  e('li', { key: item.path, title: item.path }, item.label),
                ),
              )
            : null,
          (lastUpload.changedFiles || []).length && lastUpload.changedCount > lastUpload.changedFiles.length
            ? e(
                'div',
                { className: 'os-dock-more' },
                '……还有 ' + (lastUpload.changedCount - lastUpload.changedFiles.length) + ' 个',
              )
            : null,
        );

  const settingsButton = e(
    'button',
    {
      type: 'button',
      className: 'os-foot',
      title: '打开同步设置',
      'aria-label': '打开同步设置',
      onClick: event => {
        let rect = null;
        try {
          rect = event?.currentTarget?.getBoundingClientRect?.() || null;
        } catch {
          rect = null;
        }
        ensureSyncLoaded();
        togglePopover(rect);
      },
    },
    e('span', { className: 'os-nav', 'aria-hidden': 'true' }, '⟳'),
    wide ? e('span', { className: 'os-foot-label' }, '同步') : null,
  );

  if (!wide) return settingsButton;

  return e(
    'div',
    { className: 'os-dock' },
    e(
      'div',
      { className: 'os-dock-card' },
      changeList,
      e('div', { className: 'os-dock-row' }, pill),
      e(
        'div',
        { className: 'os-dock-meta' },
        e('span', null, '本机'),
        e('span', null, 'v' + local),
      ),
      e(
        'div',
        { className: 'os-dock-meta' },
        e('span', null, '服务器'),
        e('span', null, server),
      ),
      e(
        'div',
        { className: 'os-dock-meta' },
        e('span', null, '上次同步'),
        e('span', null, lastSync),
      ),
      e(
        'div',
        { className: 'os-dock-actions' },
        e(
          'button',
          {
            type: 'button',
            className: 'os-btn os-btn-primary',
            disabled: busy || !actions.upload,
            title: !actions.upload && !busy ? actions.reason : '上传',
            onClick: () => runSyncAction('upload'),
          },
          state.busy === 'upload' ? '上传中…' : '上传',
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'os-btn os-btn-danger',
            disabled: busy || !actions.download,
            title: !actions.download && !busy ? actions.reason : '下载',
            onClick: () => runSyncAction('download'),
          },
          state.busy === 'download' ? '下载中…' : '下载',
        ),
        e(
          'button',
          {
            type: 'button',
            className: 'os-btn os-btn-check',
            title: '检查服务器上有没有更新版本',
            onClick: () => checkServerNow(),
          },
          state.checking ? '检查中…' : '检查更新',
        ),
      ),
      state.notice
        ? e(
            'div',
            {
              className:
                'os-dock-note os-note-' +
                (state.notice.kind === 'err' ? 'err' : state.notice.kind === 'warn' ? 'warn' : 'ok'),
            },
            e('span', null, state.notice.text),
            state.notice.action
              ? e(
                  'button',
                  { type: 'button', className: 'os-link', onClick: runNoticeAction },
                  state.notice.action.label,
                )
              : null,
          )
        : null,
    ),
    settingsButton,
  );
}
/* ---------- 挂载 ---------- */
function apply(ctx) {
  injectStyles();

  // 会话导航：自动恢复时切到空白会话、写完再切回来
  if (typeof ctx.inject === 'function') {
    ctx.inject(['uiWorkspace'], guarded => {
      setWorkspaceNavigation(guarded.uiWorkspace);
      guarded.effect?.(() => () => setWorkspaceNavigation(null));
    });
  }

  // 左下角、头像上方：状态卡片 + 「同步」按钮（点击打开设置弹层）
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'dsh-ownsync', order: 40, label: '同步' },
      OwnsyncDock,
    ),
  );

  // 点击按钮后贴着按钮上沿展开的设置弹层（不是整屏弹窗）
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ownsync-popover', order: 900 }, OwnsyncPopover),
  );

  // 自动写回期间的全屏遮罩，阻止输入
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ownsync-recovering', order: 950 }, OwnsyncRecovering),
  );

  // 设置页里也保留一份，找不到侧栏按钮时仍可进入
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'dsh-ownsync-section', order: 420, label: '同步' },
      OwnsyncSection,
    ),
  );
}

module.exports = {
  name: 'dsh-ownsync',
  inject: ['slots'],
  apply,
};
    return module.exports;
  },
});
