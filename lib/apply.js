/**
 * 把服务器快照写进本机。
 *
 * 顺序：附件 → 会话 → 工作区登记。
 * 每个会被覆盖的文件都先存原件；普通文件原子替换，会话走宿主接口。
 */
import fs from 'node:fs';
import { applySessionTransfer, removeSessionFile } from './session-transfer.js';
import { atomicBytes, readIfExists, safePath } from './fs-util.js';
import { contentKind } from './scope.js';

function order(entry) {
  if (entry.kind === 'attachments') return 0;
  if (entry.kind === 'sessions') return 1;
  return 2;
}

/**
 * @param {{home: string, log: Function, recovery: import('./recovery.js').RecoveryStore}} engine
 * @param {Array<{path: string, kind: string, bytes: Buffer}>} incoming
 * @param {{removals?: string[]}} [options]
 */
export async function applyIncoming(engine, incoming, options = {}) {
  const applied = [];
  const skipped = [];
  const deferred = [];
  const failures = [];
  const removed = [];
  let restartRequired = false;

  for (const entry of [...incoming].sort((left, right) => order(left) - order(right))) {
    try {
      if (entry.kind === 'sessions') {
        const result = await applySessionTransfer(engine, entry.path, entry.bytes, { force: options.force === true });
        if (result.status === 'deferred') deferred.push({ path: entry.path, ...result });
        else if (result.status === 'unchanged' || result.status === 'local-ahead') skipped.push({ path: entry.path, ...result });
        else applied.push({ path: entry.path, ...result });
        if (result.restartRequired) restartRequired = true;
        continue;
      }

      const target = safePath(engine.home, entry.path);
      const current = readIfExists(target);
      if (current && current.equals(entry.bytes)) {
        skipped.push({ path: entry.path, status: 'unchanged' });
        continue;
      }
      if (entry.kind === 'workspaces') {
        try {
          JSON.parse(entry.bytes.toString('utf8'));
        } catch {
          failures.push({ path: entry.path, reason: '工作区登记不是合法 JSON, 已跳过' });
          continue;
        }
      }
      if (current) engine.recovery.save('overwrite', [{ path: entry.path, bytes: current }]);
      atomicBytes(target, entry.bytes);
      applied.push({ path: entry.path, status: current ? 'updated' : 'created' });
    } catch (error) {
      failures.push({ path: entry.path, reason: String(error?.message || error) });
    }
  }

  for (const path of options.removals || []) {
    try {
      const kind = contentKind(path);
      if (!kind) continue;
      if (kind === 'sessions') {
        const result = removeSessionFile(engine, path);
        if (result.status === 'removed') removed.push(path);
        if (result.restartRequired) restartRequired = true;
        continue;
      }
      const target = safePath(engine.home, path);
      const current = readIfExists(target);
      if (!current) continue;
      engine.recovery.save('remove', [{ path, bytes: current }]);
      fs.unlinkSync(target);
      removed.push(path);
    } catch (error) {
      failures.push({ path, reason: String(error?.message || error) });
    }
  }

  if (applied.some(item => item.status === 'created' || item.status === 'replaced')) restartRequired = true;

  return { applied, skipped, deferred, removed, failures, restartRequired };
}
