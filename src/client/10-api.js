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
  setAutoUpload: value => post('/ownsync/api/config', { autoUpload: value }),
  backups: () => fetch('/ownsync/api/backups').then(response => response.json()),
};
