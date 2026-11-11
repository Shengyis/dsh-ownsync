/**
 * 自动上传（宿主侧循环，不依赖界面）。
 *
 * 只要 DSH 在运行（界面开着，或窗口关闭留在托盘），这个循环就每 30 秒检查一次：
 * 有稳定改动、没有生成任务、没有 pending、服务器没有更新时，自动上传。
 * 只推不取；批量删除仍需人工确认。
 */
import { activeTasks } from './active-tasks.js';

export const AUTO_TICK_MS = 30_000;
export const AUTO_MIN_INTERVAL_MS = 60_000;
export const AUTO_STALE_PAUSE_MS = 5 * 60_000;
export const AUTO_CONFIRM_PAUSE_MS = 10 * 60_000;
export const AUTO_RETRY_PAUSE_MS = 30_000;
export const AUTO_RETRY_LONG_MS = 10 * 60_000;

export function startAutoUpload({ engine, ctx, log = () => {}, tickMs = AUTO_TICK_MS }) {
  let lastSignature = null;
  let stableCount = 0;
  let lastUploadAt = 0;
  let pausedUntil = 0;
  let failures = 0;
  let stopped = false;

  // 手动操作（下载、改配置）后可以重置暂停状态。
  engine.resetAutoUpload = () => {
    lastSignature = null;
    stableCount = 0;
    pausedUntil = 0;
    failures = 0;
  };

  async function tick() {
    if (stopped) return;
    if (engine.cfg.autoUpload === false) return;
    if (!engine.cfg.remote) return;
    if (engine.busy) return;
    if (Date.now() < pausedUntil) return;

    const status = engine.status();
    if ((status.local?.pending || []).length > 0) return;
    if ((status.localChanges?.count || 0) === 0) {
      lastSignature = null;
      stableCount = 0;
      return;
    }
    if (activeTasks(ctx).active) {
      stableCount = 0;
      return;
    }

    const signature = engine.changeSignature();
    if (!signature) return;
    if (signature !== lastSignature) {
      lastSignature = signature;
      stableCount = 0;
      return;
    }
    stableCount += 1;
    if (Date.now() - lastUploadAt < AUTO_MIN_INTERVAL_MS) return;

    let result = null;
    lastUploadAt = Date.now();
    try {
      result = await engine.upload({});
    } catch (error) {
      result = { error: 'exception', message: String(error?.message || error) };
    }

    if (result?.uploaded) {
      failures = 0;
      lastSignature = null;
      stableCount = 0;
      log('info', '自动上传完成 v' + result.version + ' (' + (result.changedCount || 0) + ' 个改动)');
      return;
    }
    if (result?.upToDate) {
      lastSignature = null;
      stableCount = 0;
      return;
    }
    if (result?.needsConfirm) {
      pausedUntil = Date.now() + AUTO_CONFIRM_PAUSE_MS;
      log('warn', '自动上传已暂停: 有删除需要人工确认');
      return;
    }
    if (result?.error === 'changed-during-upload') {
      lastSignature = null;
      stableCount = 0;
      log('info', '自动上传跳过: 上传过程中内容又变化了');
      return;
    }
    if (result?.error === 'busy' || result?.error === 'session-busy') return;
    if (result?.error === 'stale') {
      pausedUntil = Date.now() + AUTO_STALE_PAUSE_MS;
      log('warn', '自动上传已暂停: 服务器版本较新, 请先下载');
      return;
    }
    failures += 1;
    pausedUntil = Date.now() + (failures >= 2 ? AUTO_RETRY_LONG_MS : AUTO_RETRY_PAUSE_MS);
    log('warn', '自动上传失败: ' + (result?.message || result?.error || '未知错误'));
  }

  const timer = setInterval(() => {
    tick().catch(error => log('warn', '自动上传异常: ' + String(error?.message || error)));
  }, tickMs);
  if (typeof timer?.unref === 'function') timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
