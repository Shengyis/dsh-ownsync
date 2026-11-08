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
