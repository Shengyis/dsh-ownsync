/**
 * 工作区登记（`storages/workspace.json`）的语义视图。
 *
 * 这份文件由 DSH 宿主写，每次写都会做几件跟同步无关的抖动：
 *
 * 1. 顶一下 `tables.workspaces[*].updatedAt`；
 * 2. 新建会话时把新 id 插到 `sessionIds` 最前面（顺序变）；
 * 3. 新建但没发过消息的会话，本身不会被上传（见 `snapshot.js` 的 emptySessions），
 *    它的 id 却已经进了登记。
 *
 * 直接按文件内容比对，就会把上面三类抖动当成"本机有未上传改动"。这里把登记
 * 归一到"同步语义"再比：
 *
 * - 去掉每写一次都会变的时间戳；
 * - 会话 id 列表按集合看（排序）；
 * - 剔除没有内容可同步的 id：本机找不到对应日志，或日志是空对话。
 *
 * 判定分两级，保证轮询（客户端每 5 秒一次）不卡：
 *
 * 1. 先比"归一化摘要"——时间戳/顺序抖动在这一步就被抹平；
 * 2. 摘要不等时，只看比上次同步**多出来**的 id；查清它们为空、才去掉再比。
 *
 * 会话被删除时不用靠登记发现：`engine.localChanges()` 会看到清单里的会话文件
 * 已经不在了，那一步照样算改动。
 */
import fs from 'node:fs';
import path from 'node:path';
import { digest } from './fs-util.js';
import { listCandidateFiles } from './scope.js';
import { pickHighestGeneration } from './session-path.js';
import { isEmptySession, validateSessionLog } from './sessions.js';

/** 可能被判成"空对话"的日志上限；超过这个大小的一律当作有内容，不去解码。 */
export const EMPTY_SESSION_MAX_BYTES = 64 * 1024;

/** 键序无关的 JSON 序列化（数组顺序保留）。 */
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/** 登记里所有「会话 id 列表」的位置。 */
function idLists(data) {
  const lists = [];
  for (const item of Object.values(data?.tables?.workspaces || {})) {
    if (!item || typeof item !== 'object' || !Array.isArray(item.sessionIds)) continue;
    lists.push({ owner: item, key: 'sessionIds' });
  }
  for (const key of ['archivedSessionIds', 'pinnedSessionIds']) {
    if (!Array.isArray(data?.global?.[key])) continue;
    lists.push({ owner: data.global, key });
  }
  return lists;
}

function collectIds(data) {
  const ids = new Set();
  for (const { owner, key } of idLists(data)) {
    for (const id of owner[key]) if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function digestOf(data) {
  return digest(Buffer.from(canonical(data), 'utf8'));
}

/**
 * 归一到"同步语义"：去时间戳、id 列表当集合。
 * 内容不是合法登记时返回 null。
 */
export function normalizeRegistry(bytes) {
  if (!Buffer.isBuffer(bytes)) return null;
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  for (const item of Object.values(data?.tables?.workspaces || {})) {
    if (item && typeof item === 'object' && Object.hasOwn(item, 'updatedAt')) delete item.updatedAt;
  }
  for (const { owner, key } of idLists(data)) owner[key] = [...owner[key]].sort();

  return { data, digest: digestOf(data), ids: collectIds(data) };
}

/** 本机所有会话日志：会话 id → 当前那份文件（最高代际）。 */
function sessionLogs(home) {
  try {
    return pickHighestGeneration(listCandidateFiles(home).sessions);
  } catch {
    return new Map();
  }
}

/** 会话日志不承载对话内容（只有 header / 引导 / end-seed 标记）。 */
export function isBlankSessionFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile() || stat.size > EMPTY_SESSION_MAX_BYTES) return false;
  try {
    const checked = validateSessionLog(fs.readFileSync(file));
    return checked.ok && isEmptySession(checked.rows);
  } catch {
    return false;
  }
}

/** 这个 id 有没有可同步的内容：日志存在且不是空对话。 */
function syncable(home, id, logs, ignored) {
  if (ignored.has(id)) return false;
  const picked = logs.get(id);
  if (!picked) return false;
  return !isBlankSessionFile(path.join(home, picked.file));
}

/**
 * 剔除"没有内容可同步"的 id，得到真正需要比较的登记。
 *
 * @returns {{data: object, digest: string, ids: Set<string>, dropped: string[]} | null}
 */
export function effectiveRegistry(home, bytes, options = {}) {
  const normalized = options.normalized || normalizeRegistry(bytes);
  if (!normalized) return null;
  const ignored = options.ignored instanceof Set ? options.ignored : new Set();
  const logs = options.logs || sessionLogs(home);

  const dropped = [];
  for (const id of normalized.ids) if (!syncable(home, id, logs, ignored)) dropped.push(id);
  if (!dropped.length) return normalized;

  const drop = new Set(dropped);
  for (const { owner, key } of idLists(normalized.data)) owner[key] = owner[key].filter(id => !drop.has(id));
  return { data: normalized.data, digest: digestOf(normalized.data), ids: collectIds(normalized.data), dropped };
}

/**
 * 写进 `state.json` 的基线。
 *
 * - `digest`：归一化摘要（时间戳与顺序已抹平）；
 * - `effective`：再剔除无内容 id 之后的摘要；
 * - `ids`：上次同步时真正带内容的会话 id，用来快速判断"哪些是新冒出来的"。
 */
export function baselineOf(home, bytes, options = {}) {
  const normalized = normalizeRegistry(bytes);
  if (!normalized) return null;
  const effective = effectiveRegistry(home, bytes, { ...options, normalized });
  if (!effective) return null;
  return { digest: normalized.digest, effective: effective.digest, ids: [...effective.ids] };
}

/**
 * 当前登记相对基线有没有真实改动。
 *
 * @returns {{status: 'clean'|'dirty'|'unknown', digest: string|null, dropped: string[]}}
 *   `unknown` 表示还没有基线（旧版本的 state），调用方自己决定怎么退化。
 */
export function compareRegistry(home, bytes, baseline, options = {}) {
  const normalized = normalizeRegistry(bytes);
  if (!normalized) return { status: 'dirty', digest: null, dropped: [], reason: 'invalid-registry' };
  if (!baseline || typeof baseline.digest !== 'string')
    return { status: 'unknown', digest: normalized.digest, dropped: [] };
  if (normalized.digest === baseline.digest) return { status: 'clean', digest: normalized.digest, dropped: [] };

  // 摘要不等：只有"比上次多出来的 id"可能是空对话/已删除的噪声，逐个查清
  const known = new Set(Array.isArray(baseline.ids) ? baseline.ids : []);
  const fresh = [...normalized.ids].filter(id => !known.has(id));
  if (!fresh.length) return { status: 'dirty', digest: normalized.digest, dropped: [] };

  const ignored = options.ignored instanceof Set ? options.ignored : new Set();
  const logs = options.logs || sessionLogs(home);
  const dropped = [];
  for (const id of fresh) {
    if (syncable(home, id, logs, ignored)) return { status: 'dirty', digest: normalized.digest, dropped };
    dropped.push(id);
  }

  const drop = new Set(dropped);
  for (const { owner, key } of idLists(normalized.data)) owner[key] = owner[key].filter(id => !drop.has(id));
  const effective = digestOf(normalized.data);
  const expected = typeof baseline.effective === 'string' ? baseline.effective : null;
  return { status: expected && effective === expected ? 'clean' : 'dirty', digest: effective, dropped };
}
