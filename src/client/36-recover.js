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
