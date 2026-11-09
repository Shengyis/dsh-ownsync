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

  const originalId = sessionIdFromPath(target.path);
  publishSync({
    notice: null,
    recovering: { active: true, phase: 'switching', message: '正在切到空白会话…' },
  });

  try {
    // 切到空白会话：DSH 会记住这个选择，重启后恢复的也是它，目标会话就不会被占用
    workspaceNavigation.startSession(undefined, { clearPreviousDraft: false });
    await sleep(500);

    publishSync({
      recovering: { active: true, phase: 'restarting', message: '正在重启 DSH…' },
    });

    // 直接重启，不再弹手动重启对话框；失败时提示条会说明原因
    const restarted = await requestRestart(originalId);
    if (!restarted) publishSync({ recovering: null });
  } catch (error) {
    publishSync({
      recovering: null,
      notice: { kind: 'err', text: '重启失败：' + (error.message || error) },
    });
  }
}
