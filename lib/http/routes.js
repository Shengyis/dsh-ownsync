/**
 * 接口只有五个：看状态、连服务器、上传、下载、改配置。
 *
 * 没有"自动同步""定时""退出同步"之类的入口——这台机器什么时候动，
 * 完全由点击「上传」「下载」的人决定。
 */
import { normalizeBranch, normalizeRemote, writeConfig } from '../config.js';
import { restartHost } from '../host-restart.js';

export function createRoutes({ engine, home, log }) {
  return [
    {
      method: 'GET',
      path: '/ownsync/api/status',
      handler: async () => engine.status(),
    },
    {
      method: 'POST',
      path: '/ownsync/api/check',
      handler: async () => {
        const result = await engine.check();
        if (result.error) return { error: 'check-failed', message: result.error };
        return { remote: result };
      },
    },
    {
      method: 'POST',
      path: '/ownsync/api/upload',
      handler: async ({ body }) => engine.upload({ confirm: body?.confirm }),
    },
    {
      method: 'POST',
      path: '/ownsync/api/download',
      handler: async ({ body }) => {
        const result = await engine.download({ confirm: body?.confirm });
        if (result?.downloaded) engine.resetAutoUpload?.();
        return result;
      },
    },
    {
      method: 'POST',
      path: '/ownsync/api/pending/retry',
      handler: async () => engine.retryPending(),
    },
    {
      method: 'GET',
      path: '/ownsync/api/host',
      handler: async () => ({
        execPath: process.execPath,
        argv: process.argv.slice(0, 6),
        electron: process.versions.electron || null,
        node: process.versions.node || null,
        type: process.type || null,
        platform: process.platform,
        parentPid: process.ppid || null,
      }),
    },
    {
      method: 'POST',
      path: '/ownsync/api/restart',
      handler: async ({ body }) => {
        if (body?.returnTo) engine.setReturnTo(String(body.returnTo));
        return restartHost({ ctx: engine.ctx, log });
      },
    },
    {
      method: 'POST',
      path: '/ownsync/api/return/ack',
      handler: async () => engine.clearReturnTo(),
    },
    {
      method: 'POST',
      path: '/ownsync/api/config',
      handler: async ({ body }) => {
        const patch = {
          remote: normalizeRemote(body?.remote ?? engine.cfg.remote),
          branch: normalizeBranch(body?.branch ?? engine.cfg.branch),
        };
        if (body?.autoUpload !== undefined) patch.autoUpload = body.autoUpload !== false;
        const saved = writeConfig(home, patch);
        engine.cfg = { ...engine.cfg, ...saved };
        if (saved.autoUpload === false) engine.resetAutoUpload?.();
        log('info', '同步配置已保存 (分支 ' + saved.branch + ')');
        return { config: saved, status: engine.status() };
      },
    },
    {
      method: 'GET',
      path: '/ownsync/api/backups',
      handler: async () => ({
        backups: engine.recovery.list().map(record => ({
          name: record.name,
          reason: record.reason,
          createdAt: record.createdAt,
          files: (record.files || []).length,
          size: (record.files || []).reduce((total, file) => total + (Number(file.size) || 0), 0),
        })),
      }),
    },
  ];
}
