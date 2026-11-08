/**
 * 会话日志的解析与校验。
 *
 * DSH 的会话日志是"只追加"的：第一行是 header（`type: "session"`），之后每一行
 * 是一个事件，`seq` 从 0 开始连续递增。旧版本（header version 0/1）会把多个连续
 * 事件打包进一行（`text-chunks` 等），这里按官方信封还原它们的"事件跨度"。
 *
 * 本模块只有纯函数，不读文件、不碰 Git，方便直接单测。
 *
 * 两条硬规则：
 * 1. `seq` 必须从 0 开始连续，缺一个都算损坏；
 * 2. 两份日志之间只有"互为前缀"时才能接续，否则就是分叉，不许拼。
 */
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
/** zstd 帧魔数（小端 0xFD2FB528）。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 单份会话日志的处理上限。 */
export const MAX_SESSION_BYTES = 256 * 1024 * 1024;

const PACKED_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);
const SEED_TYPE = /^session\/(?:[^/]+\/)*seed(?:\/.*)?$/i;

/**
 * 计算一个 zstd 帧的结束位置。
 * 按 Zstandard 规范走帧头与块头：Node 对截断帧可能返回部分解压结果，
 * 所以先把帧边界算清楚，再决定要不要解。
 */
function frameEnd(buf, offset) {
  if (offset + 5 > buf.length || !buf.subarray(offset, offset + 4).equals(ZSTD_MAGIC))
    throw new Error('zstd frame magic missing');
  const descriptor = buf[offset + 4];
  if (descriptor & 0x08) throw new Error('reserved frame bit');
  const singleSegment = Boolean(descriptor & 0x20);
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6];
  const dictionaryIdBytes = [0, 1, 2, 4][descriptor & 0x03];
  let cursor = offset + 5 + (singleSegment ? 0 : 1) + dictionaryIdBytes + contentSizeBytes;
  let last = false;
  while (!last) {
    if (cursor + 3 > buf.length) throw new Error('truncated block header');
    const header = buf.readUIntLE(cursor, 3);
    const type = (header >>> 1) & 0x03;
    if (type === 3) throw new Error('reserved block type');
    last = Boolean(header & 0x01);
    cursor += 3 + (type === 1 ? 1 : header >>> 3);
    if (cursor > buf.length) throw new Error('truncated block');
  }
  if (descriptor & 0x04) cursor += 4;
  if (cursor > buf.length) throw new Error('truncated checksum');
  return cursor;
}

/**
 * 把一份会话日志还原成 UTF-8 文本。
 * 非 zstd 内容按原样解码；zstd 内容必须整条流都能完整解开，否则返回 null
 * （宁可拒绝，也不要把半截解压结果当成完整日志）。
 */
export function decodeSessionText(buffer, maxBytes = MAX_SESSION_BYTES) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(ZSTD_MAGIC)) return buffer.toString('utf8');
  if (typeof zstdDecompressSync !== 'function') return null;
  const chunks = [];
  let total = 0;
  let offset = 0;
  try {
    while (offset < buffer.length) {
      // 可跳过帧：0x184D2A50..5F，保留给应用层自定义数据
      if (offset + 8 <= buffer.length && (buffer.readUInt32LE(offset) & 0xfffffff0) === 0x184d2a50) {
        const end = offset + 8 + buffer.readUInt32LE(offset + 4);
        if (end > buffer.length) return null;
        offset = end;
        continue;
      }
      const end = frameEnd(buffer, offset);
      const chunk = zstdDecompressSync(buffer.subarray(offset, end), {
        maxOutputLength: maxBytes - total,
      });
      total += chunk.length;
      if (total > maxBytes) return null;
      chunks.push(chunk);
      offset = end;
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 会话内容的指纹：忽略 DSH 打开会话时追加的 `session/end-seed` 标记事件。
 * 只有这类标记变化时不算内容改动。解码失败返回 null。
 */
export function sessionContentDigest(buffer) {
  const text = decodeSessionText(buffer);
  if (typeof text !== 'string') return null;
  const kept = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let type = null;
    try {
      type = JSON.parse(trimmed)?.type || null;
    } catch {
      /* 解不开的行原样保留 */
    }
    if (type === 'session/end-seed') continue;
    kept.push(trimmed);
  }
  return createHash('sha256').update(kept.join('\n'), 'utf8').digest('hex');
}

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const hasExactKeys = (value, required, optional = []) =>
  isRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/** 旧版打包行包含的事件个数；信封不合规返回 null。 */
function packedEventCount(row) {
  if (!hasExactKeys(row, ['type', 'seq0', 'time0', 'data']) || !isCount(row.seq0) || !Number.isSafeInteger(row.time0))
    return null;
  const tool = row.type === 'tool-call-chunks';
  const fields = tool ? ['turn', 'step', 'index', 'id', 'dt', 'args'] : ['turn', 'step', 'index', 'dt', 'texts'];
  const data = row.data;
  if (!hasExactKeys(data, fields, tool ? ['name'] : [])) return null;
  if (!['turn', 'step', 'index'].every(key => isCount(data[key]))) return null;
  if (
    tool &&
    (typeof data.id !== 'string' || !data.id || (Object.hasOwn(data, 'name') && typeof data.name !== 'string'))
  )
    return null;
  const payload = data[tool ? 'args' : 'texts'];
  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    payload.some(item => typeof item !== 'string') ||
    !Array.isArray(data.dt) ||
    data.dt.length !== payload.length - 1 ||
    !isCount(row.seq0 + payload.length - 1)
  )
    return null;
  let clock = row.time0;
  for (const gap of data.dt) {
    if (!Number.isSafeInteger(gap) || !Number.isSafeInteger((clock += gap))) return null;
  }
  return payload.length;
}

/**
 * 校验一份日志的事件序列。
 * @returns {{ok: true, rows: object[], version: number} | {ok: false, reason: string, line?: number, expected?: number, actual?: number}}
 */
export function validateSessionLog(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, reason: 'empty-session-log' };
  if (buffer.length > MAX_SESSION_BYTES) return { ok: false, reason: 'session-log-too-large' };
  const text = decodeSessionText(buffer);
  if (text === null) return { ok: false, reason: 'invalid-session-log', detail: 'decode' };
  if (!text.endsWith('\n')) return { ok: false, reason: 'invalid-session-log', detail: 'truncated' };
  let rows;
  try {
    rows = text
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch {
    return { ok: false, reason: 'invalid-session-log', detail: 'json' };
  }
  if (rows.length === 0 || !isRecord(rows[0]) || rows[0].type !== 'session')
    return { ok: false, reason: 'invalid-session-log', detail: 'header' };
  if (rows.some(row => !isRecord(row))) return { ok: false, reason: 'invalid-session-log', detail: 'row' };
  if (rows.slice(1).some(row => row.type === 'session'))
    return { ok: false, reason: 'invalid-session-log', detail: 'duplicate-header' };

  const version = Number(rows[0].version ?? 0);
  let expected = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (PACKED_TYPES.has(row.type)) {
      const count = version <= 1 ? packedEventCount(row) : null;
      if (count === null)
        return { ok: false, reason: 'invalid-session-log', detail: 'packed', line: index + 1 };
      if (row.seq0 !== expected)
        return { ok: false, reason: 'session-seq-gap', line: index + 1, expected, actual: row.seq0 };
      expected += count;
      continue;
    }
    if (!Object.hasOwn(row, 'seq')) {
      // seed / 控制行没有 seq，只允许官方命名
      if (typeof row.type === 'string' && SEED_TYPE.test(row.type)) continue;
      return { ok: false, reason: 'invalid-session-log', detail: 'missing-seq', line: index + 1 };
    }
    if (!Number.isSafeInteger(row.seq) || row.seq !== expected)
      return { ok: false, reason: 'session-seq-gap', line: index + 1, expected, actual: row.seq };
    expected += 1;
  }
  return { ok: true, rows, version };
}

/** 解析成行数组；不合法返回 null。 */
export function parseSessionLog(buffer) {
  const checked = validateSessionLog(buffer);
  return checked.ok ? checked.rows : null;
}

/** 顺序无关的深比较；数组按顺序比较。 */
export function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1)
      if (!deepEqual(left[index], right[index])) return false;
    return true;
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys)
      if (!Object.prototype.hasOwnProperty.call(right, key) || !deepEqual(left[key], right[key])) return false;
    return true;
  }
  return false;
}

function isPrefix(shorter, longer) {
  if (shorter.length > longer.length) return false;
  for (let index = 0; index < shorter.length; index += 1)
    if (!deepEqual(shorter[index], longer[index])) return false;
  return true;
}

/**
 * 两份历史的关系：
 * - `same`：完全一致
 * - `theirs-ahead`：对方是严格超集（本机只差尾部）
 * - `ours-ahead`：本机是严格超集（对方只差尾部）
 * - `divergent`：两边各有对方没有的内容，绝不能拼
 * - `header-mismatch`：连 header 都不同，根本不是同一个会话
 */
export function historyRelation(ours, theirs) {
  if (!Array.isArray(ours) || !Array.isArray(theirs) || ours.length === 0 || theirs.length === 0)
    return 'invalid';
  if (!deepEqual(ours[0], theirs[0])) return 'header-mismatch';
  if (deepEqual(ours, theirs)) return 'same';
  if (isPrefix(ours, theirs)) return 'theirs-ahead';
  if (isPrefix(theirs, ours)) return 'ours-ahead';
  return 'divergent';
}

/**
 * 取两份日志中"更长且能严格接续"的那一份原始字节。
 * 不做任何重排、重编号——会话日志不是可以随意合并的数据结构。
 */
export function mergeSessionHistory(oursBuffer, theirsBuffer) {
  const ours = parseSessionLog(oursBuffer);
  const theirs = parseSessionLog(theirsBuffer);
  if (!ours) return { ok: false, reason: 'invalid-session-log', side: 'local' };
  if (!theirs) return { ok: false, reason: 'invalid-session-log', side: 'remote' };
  switch (historyRelation(ours, theirs)) {
    case 'same':
    case 'ours-ahead':
      return { ok: true, value: oursBuffer, relation: 'ours-ahead' };
    case 'theirs-ahead':
      return { ok: true, value: theirsBuffer, relation: 'theirs-ahead' };
    case 'header-mismatch':
      return { ok: false, reason: 'header-mismatch' };
    default:
      return { ok: false, reason: 'divergent-session-history' };
  }
}

/**
 * 会话可能正写到一半：读一次不合法时短暂重读几次。
 * 内容稳定下来仍然不合法，就把原始的"仍在变化"标记交给调用方。
 */
export async function readSettledSession(file, firstBytes, { attempts = 4, delayMs = 400 } = {}) {
  const fs = await import('node:fs');
  let current = firstBytes;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const next = fs.readFileSync(file);
    if (validateSessionLog(next).ok) return { bytes: next };
    if (next.equals(current)) return { bytes: next };
    current = next;
  }
  return { bytes: current, changing: true };
}

/** 会话日志里引用的附件（`sha256:<hex>`）。 */
export function attachmentRefs(buffer) {
  const text = decodeSessionText(buffer);
  if (text === null) return [];
  const refs = [];
  for (const match of text.matchAll(/sha256:([a-f0-9]{64})/gi)) refs.push(match[1].toLowerCase());
  return refs;
}
