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
  restartConfirm: false,
  gate: null,
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
      const remote = remoteFromCheck(checked);
      if (remote) publishSync({ remote });
    }
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '无法读取同步状态: ' + (error.message || error) } });
  }
}

/** 宿主正在上传/下载时检查会被跳过，此时保留上一次的服务器状态。 */
function remoteFromCheck(checked) {
  if (checked?.skipped) return null;
  return checked && checked.ok ? checked.remote : { error: errorText(checked) };
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
/** 启动/唤醒检查最多挡输入这么久；超时就放手，让用户先继续用。 */
const GATE_CHECK_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** 点「检查更新」：立刻连一次服务器。silent=true 用于后台定时检查。返回检查结果（可能为 null）。 */
async function checkServerNow(options = {}) {
  const silent = Boolean(options.silent);
  if (checkInFlight) return null;
  checkInFlight = true;
  if (!silent) publishSync({ checking: true });
  let outcome = null;
  try {
    const checked = await API.check();
    outcome = checked;
    if (checked?.skipped) {
      if (!silent) publishSync({ notice: { kind: 'warn', text: '正在同步, 请稍后再检查.' } });
      return checked;
    }
    publishSync({
      remote: checked && checked.ok ? checked.remote : { error: errorText(checked) },
    });
    if (!silent && (!checked || checked.ok === false)) {
      publishSync({ notice: { kind: 'err', text: '检查失败: ' + errorText(checked) } });
    }
  } catch (error) {
    if (!silent) publishSync({ notice: { kind: 'err', text: '检查失败: ' + (error.message || error) } });
  } finally {
    checkInFlight = false;
    if (!silent) publishSync({ checking: false });
  }
  return outcome;
}

/**
 * 打开 DSH / 托盘唤醒时的版本检查：
 * 检查期间挡住输入；本机不落后就恢复，落后则停在“需要下载”。
 */
async function runGateCheck() {
  if (!syncState.status?.configured) return false;
  if (syncState.busy || syncState.recovering?.active) return false;
  if (syncState.gate?.phase === 'checking') return false;

  publishSync({ gate: { phase: 'checking' } });
  let checked = null;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    checked = await withTimeout(checkServerNow({ silent: true }), GATE_CHECK_TIMEOUT_MS);
    if (!checked) break;
    if (!checked.skipped) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  if (!checked || checked.skipped || checked.ok === false) {
    publishSync({ gate: null });
    return false;
  }
  const local = syncState.status?.local?.version || 0;
  const server = checked.remote?.remoteVersion || 0;
  const behind = Boolean(checked.remote) && !checked.remote.error && !checked.remote.skipped && server > local;
  publishSync({ gate: behind ? { phase: 'need-download', local, server } : null });
  return behind;
}

/** 托盘/窗口从后台回到前台：立即检查一次。 */
async function runForegroundCheck() {
  if (!syncState.status?.configured) return false;
  if (syncState.busy || syncState.recovering?.active) return false;
  return runGateCheck();
}

/** 侧栏卡片挂载时拉一次；重复挂载不重复请求。 */
function ensureSyncLoaded() {
  if (syncLoaded) return;
  syncLoaded = true;
  refreshSync(false)
    .then(() => maybeRecoverPending())
    .then(recovered => {
      if (recovered) return null;
      return runGateCheck();
    })
    .catch(() => {
      publishSync({ gate: null });
    });
}

let pendingRecovered = false;

/** 客户端刚加载时如果还有待写回的会话，按"切空白会话 + 重启"处理一次。 */
async function maybeRecoverPending() {
  if (pendingRecovered) return false;
  const pending = syncState.status?.local?.pending || [];
  if (!pending.length) return false;
  if (!workspaceNavigation?.startSession) return false;
  pendingRecovered = true;
  await recoverSessions(pending.map(file => ({ path: file, reason: 'session-writer-held' })));
  return true;
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
      if (kind === 'download') publishSync({ gate: null });
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
      // 下载已经成功（或有会话待写回），先解除“需要下载”的遮挡
      publishSync({ gate: null });
      // 会话被宿主占用：走自动恢复（遮罩 → 切空白会话 → 探测 → 重试 → 切回）
      const stuck =
        kind === 'download' ? (result.deferred || []).filter(item => item.reason === 'session-writer-held') : [];
      if (stuck.length) {
        await recoverSessions(result.deferred);
      } else if (kind === 'download' && Array.isArray(result.appliedSessions) && result.appliedSessions.length > 0) {
        // 会话已写回磁盘，但界面要重启才能重读；直接重启（不弹确认）
        const returnTo = result.appliedSessions.length === 1 ? result.appliedSessions[0] : null;
        await requestRestart(returnTo);
      } else {
        const text = describeResult(kind, result);
        publishSync({
          notice: {
            kind: result.restartRequired ? 'warn' : 'ok',
            text: text + (result.restartRequired ? '. 请完全退出 DSH 后重新打开.' : ''),
          },
        });
      }
    }
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '操作失败: ' + (error.message || error) } });
    if (kind === 'download') publishSync({ gate: null });
    openPopover();
  } finally {
    publishSync({ busy: '' });
    refreshSync(true);
  }
}

/** 点「重启」：先弹确认框，防止误触。 */
function askRestart() {
  if (syncState.busy || syncState.restartConfirm) return;
  publishSync({ restartConfirm: true, notice: null });
}

function cancelRestart() {
  publishSync({ restartConfirm: false });
}

async function confirmRestart() {
  publishSync({ restartConfirm: false });
  await restartDsh();
}

/**
 * 请求重启；失败时把原因写进提示条。
 * 成功时不发提示——页面马上就会断开重连。
 */
async function requestRestart(returnTo = null) {
  try {
    const result = await API.restart(returnTo || null);
    if (result && result.restarted) return true;
    const text =
      result?.reason === 'busy'
        ? '还有 ' + ((result.tasks || 0) + (result.jobs || 0)) + ' 个任务在运行, 等它结束再重启.'
        : result?.reason === 'installing'
          ? '插件安装/卸载正在进行, 完成后再重启.'
          : result?.reason === 'cooldown'
            ? '刚派发过重启, 请等几秒再试.'
            : result?.message || '当前宿主不能自动重启, 请完全退出 DSH 后重新打开.';
    publishSync({ notice: { kind: 'warn', text } });
    return false;
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '重启失败: ' + (error.message || error) } });
    return false;
  }
}

/** 点「重启」：派发一次应用重启；失败时把原因写进提示条。 */
async function restartDsh() {
  if (syncState.busy) return;
  publishSync({ busy: 'restart', notice: null });
  await requestRestart(null);
  publishSync({ busy: '' });
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
    publishSync({ notice: { kind: 'err', text: '检查失败: ' + (error.message || error) } });
  } finally {
    publishSync({ busy: '' });
    refreshSync(false);
  }
}

/** 切换自动上传开关（存宿主配置，托盘/无界面时也生效）。 */
async function setAutoToggle(request, key, label) {
  publishSync({ notice: null });
  try {
    const result = await request();
    if (!result || result.ok === false) {
      publishSync({ notice: { kind: 'err', text: errorText(result) } });
      return;
    }
    if (result.status) publishSync({ status: result.status });
    publishSync({
      notice: { kind: 'ok', text: label + (result.config?.[key] ? '已开启' : '已关闭') },
    });
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '保存失败: ' + (error.message || error) } });
  }
}

async function setAutoUpload(value) {
  return setAutoToggle(() => API.setAutoUpload(Boolean(value)), 'autoUpload', '自动上传');
}

async function saveSyncConfig(remote, branch) {
  publishSync({ busy: 'config', notice: null });
  try {
    const result = await API.saveConfig(remote, branch);
    if (!result || result.ok === false) publishSync({ notice: { kind: 'err', text: errorText(result) } });
    else publishSync({ notice: { kind: 'ok', text: '仓库设置已保存' } });
  } catch (error) {
    publishSync({ notice: { kind: 'err', text: '保存失败: ' + (error.message || error) } });
  } finally {
    publishSync({ busy: '' });
    refreshSync(true);
  }
}

function dismissSyncConfirm() {
  publishSync({ confirm: null, notice: { kind: 'warn', text: '已取消.' } });
}

/** 提示条上的动作（目前只有"重启 DSH"）。 */
async function runNoticeAction() {
  const action = syncState.notice?.action;
  if (!action || action.kind !== 'restart') return;
  publishSync({ notice: { kind: 'warn', text: '正在重启 DSH...' } });

  let host = null;
  try {
    const result = await API.restart(action.returnTo || null);
    if (result && result.restarted) {
      publishSync({
        notice: { kind: 'warn', text: '正在重启 DSH, 重新打开后会自动回到这个会话.' },
      });
      return;
    }
    host = result?.host || null;
    try {
      console.info('[dsh-ownsync] 自动重启不可用, 宿主信息: ' + JSON.stringify(host || {}));
    } catch {
      /* 没有 console 也无所谓 */
    }
  } catch (error) {
    try {
      console.info('[dsh-ownsync] 重启请求失败: ' + (error.message || error));
    } catch {
      /* ignore */
    }
  }

  const exe = host?.execPath ? String(host.execPath).split(/[\\/]/).pop() : '未知';
  const why = host?.requireError ? ', 原因: ' + String(host.requireError).slice(0, 60) : '';
  publishSync({
    notice: {
      kind: 'warn',
      text:
        '当前宿主不能自动重启 (electron=' +
        (host?.electron || '无') +
        ', type=' +
        (host?.type || '未知') +
        ', 程序=' +
        exe +
        why +
        '). 请完全退出 DSH 再打开, 重新打开后会自动回到这个会话.',
    },
  });
}
