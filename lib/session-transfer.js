/**
 * 把服务器上的会话写回本机。
 *
 * 三种情况：
 * 1. 本机没有这个会话  → 直接写文件（宿主没打开过它，不存在写入竞争）；
 * 2. 服务器只是本机的延续 → 优先通过宿主的持久化接口追加并读回校验；
 * 3. 两边已经分叉      → 以服务器为准：备份本机原件后整体替换。
 *
 * 第 2 种走宿主接口的原因：DSH 用一个跨进程写入租约保护会话文件。绕过它
 * 直接改文件，可能被宿主下一次写入覆盖，或者让界面里的会话状态错乱。
 */
import fs from 'node:fs';
import { historyRelation, parseSessionLog, deepEqual } from './sessions.js';
import { sessionIdOfLogPath } from './session-path.js';
import { atomicBytes, readIfExists, safePath } from './fs-util.js';

/** 宿主提供的会话持久化服务。 */
export function sessionService(ctx) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get('sessionPersistence') : ctx?.sessionPersistence;
  } catch {
    return undefined;
  }
}

function deferred(reason, hint) {
  return { status: 'deferred', reason, hint };
}

async function appendThroughHost(engine, id, incomingRows) {
  const persistence = sessionService(engine.ctx);
  if (!persistence?.open) return deferred('session-api-unavailable', '当前宿主没有会话写入接口，无法安全追加');
  let handle;
  try {
    handle = await persistence.open(id, 'write');
  } catch (error) {
    if (error?.name === 'SessionAlreadyOwnedError')
      return deferred('session-writer-held', '这个会话正在使用（界面打开或正在生成），关掉它之后再下载');
    return deferred('session-open-failed', '无法取得会话写入权：' + (error?.message || error));
  }
  try {
    const read = await handle.read();
    const events = Array.isArray(read?.events) ? read.events : null;
    if (!events) return deferred('session-read-shape-unknown', '宿主返回的会话内容无法比对');
    const incoming = incomingRows.slice(1);
    if (events.length > incoming.length) return { status: 'local-ahead' };
    if (!deepEqual(incoming.slice(0, events.length), events))
      return deferred('session-shape-mismatch', '会话事件格式与宿主不一致，改为整体替换');
    if (events.length === incoming.length) return { status: 'unchanged' };
    await handle.append(incoming.slice(events.length));
    await handle.flush();
    const readback = await handle.read();
    if (!deepEqual(readback.events?.slice(0, incoming.length), incoming))
      throw new Error('写入后读回不一致');
    return { status: 'appended', events: incoming.length };
  } catch (error) {
    return deferred('session-append-failed', '追加会话失败：' + (error?.message || error));
  } finally {
    try {
      await handle.close();
    } catch {
      /* 关闭失败不影响结果 */
    }
  }
}

/** 备份原件后用服务器内容整体替换。 */
function replaceWithBackup(engine, file, target, localBytes, incomingBytes) {
  if (localBytes) engine.recovery.save('session-overwrite', [{ path: file, bytes: localBytes }]);
  atomicBytes(target, incomingBytes);
  if (!readIfExists(target)?.equals(incomingBytes)) throw new Error('会话写入后读回不一致：' + file);
  return { status: 'replaced', restartRequired: true };
}

/**
 * 应用一份远端会话。
 * @param {object} engine
 * @param {string} file
 * @param {Buffer} incomingBytes
 * @param {{force?: boolean}} [options] `force` 表示下载已经确认过"以服务器为准"，
 *   本机领先时也直接替换（默认保留本机）。
 * @returns {Promise<{status: string, reason?: string, hint?: string, restartRequired?: boolean}>}
 */
export async function applySessionTransfer(engine, file, incomingBytes, options = {}) {
  const id = sessionIdOfLogPath(file);
  if (!id) return deferred('unsupported-session-file', '这不是可识别的会话日志');
  const incoming = parseSessionLog(incomingBytes);
  if (!incoming) return deferred('invalid-session-log', '服务器上的会话日志不完整，已跳过');
  if (incoming[0].id && incoming[0].id !== id)
    return deferred('session-id-mismatch', '服务器上的会话身份与路径不一致，已跳过');

  const target = safePath(engine.home, file);
  const localBytes = readIfExists(target);

  if (!localBytes) {
    atomicBytes(target, incomingBytes);
    return { status: 'created', restartRequired: true };
  }

  const local = parseSessionLog(localBytes);
  if (!local) return deferred('local-session-invalid', '本机会话日志不完整，未覆盖');

  const relation = historyRelation(local, incoming);
  if (relation === 'same') return { status: 'unchanged' };
  if (relation === 'ours-ahead') {
    if (!options.force) return { status: 'local-ahead' };
    return replaceWithBackup(engine, file, target, localBytes, incomingBytes);
  }
  if (relation === 'header-mismatch') return deferred('session-header-mismatch', '会话身份不同，未覆盖');
  if (relation === 'theirs-ahead') {
    const appended = await appendThroughHost(engine, id, incoming);
    // 宿主接口不可用、或事件形状对不上时，退回整体替换（会要求重启 DSH）
    if (appended.status !== 'deferred') return appended;
    if (appended.reason === 'session-writer-held') return appended;
    engine.log('warn', '会话追加未成功，改为整体替换：' + (appended.hint || appended.reason));
    return replaceWithBackup(engine, file, target, localBytes, incomingBytes);
  }
  // divergent：服务器为准
  return replaceWithBackup(engine, file, target, localBytes, incomingBytes);
}

/** 删除一个本机会话文件（先备份）。 */
export function removeSessionFile(engine, file) {
  const target = safePath(engine.home, file);
  const bytes = readIfExists(target);
  if (!bytes) return { status: 'missing' };
  engine.recovery.save('session-remove', [{ path: file, bytes }]);
  fs.unlinkSync(target);
  return { status: 'removed', restartRequired: true };
}
