import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import {
  ZSTD_MAGIC,
  attachmentRefs,
  decodeSessionText,
  deepEqual,
  historyRelation,
  isEmptySession,
  mergeSessionHistory,
  parseSessionLog,
  validateSessionLog,
} from '../lib/sessions.js';
import { pickHighestGeneration, sessionIdOfLogPath, sessionLogGeneration } from '../lib/session-path.js';

const ID = '11111111-1111-1111-1111-111111111111';
const PATH = `sessions/demo/session-${ID}/session.v4.jsonl`;

const header = (extra = {}) => ({ type: 'session', version: 4, id: `session-${ID}`, cwd: 'E:/Cloud/Projects/Demo', ...extra });
const event = seq => ({ type: 'turn/start', seq, time: seq, data: { turn: seq } });
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8');

function log(count) {
  return encode([header(), ...Array.from({ length: count }, (_, index) => event(index))]);
}

test('会话路径解析出 id 与代际', () => {
  assert.equal(sessionIdOfLogPath(PATH), `session-${ID}`);
  assert.equal(sessionIdOfLogPath(`sessions/x/session-${ID}/session.jsonl.zstd`), `session-${ID}`);
  assert.equal(sessionIdOfLogPath('sessions/x/session-abc/session.jsonl'), null);
  assert.equal(sessionLogGeneration(PATH), 4);
  assert.equal(sessionLogGeneration(`sessions/x/session-${ID}/session.jsonl`), 0);
  assert.equal(sessionLogGeneration(`sessions/x/session-${ID}/session.v12.jsonl.zstd`), 12);
});

test('最高代际只保留一份，同代多份直接报错', () => {
  const v2 = `sessions/g/session-${ID}/session.v2.jsonl`;
  const v4 = `sessions/g/session-${ID}/session.v4.jsonl`;
  const picked = pickHighestGeneration([v2, v4]);
  assert.equal(picked.get(`session-${ID}`).file, v4);
  assert.throws(() => pickHighestGeneration([v4, v4 + '.zstd']), /同代/);
});

test('合法日志能解析出行数组', () => {
  const rows = parseSessionLog(log(3));
  assert.equal(rows.length, 4);
  assert.equal(rows[3].seq, 2);
});

test('seq 缺口、重复 header、无结尾换行、坏 JSON 都被拒绝', () => {
  const gap = encode([header(), event(0), event(2)]);
  assert.equal(validateSessionLog(gap).reason, 'session-seq-gap');
  const duplicate = encode([header(), event(0), header()]);
  assert.equal(validateSessionLog(duplicate).ok, false);
  const truncated = log(2).subarray(0, -1);
  assert.equal(validateSessionLog(truncated).ok, false);
  const broken = Buffer.from('{"type":"session"}\n{not json}\n');
  assert.equal(validateSessionLog(broken).ok, false);
  assert.equal(validateSessionLog(Buffer.alloc(0)).ok, false);
});

test('seed 行允许没有 seq，普通事件不允许', () => {
  const ok = encode([header(), { type: 'session/seed/tools', data: {} }, event(0)]);
  assert.equal(validateSessionLog(ok).ok, true);
  const bad = encode([header(), { type: 'assistant/message', data: {} }, event(0)]);
  assert.equal(validateSessionLog(bad).ok, false);
});

test('空对话只认 header 与引导/标记事件', () => {
  const bootstrap = [
    header(),
    { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', seq: 1, time: 0, data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', seq: 2, time: 0, data: { policy: 'never' } },
    { type: 'session/end-seed', seq: 3, time: 1, data: {} },
  ];
  assert.equal(isEmptySession([header()]), true);
  assert.equal(isEmptySession(bootstrap), true);
  assert.equal(isEmptySession([header(), event(0)]), false);
  assert.equal(isEmptySession([header(), { type: 'user/message', seq: 0, time: 0, data: {} }]), false);
  // 未知事件按“有内容”处理，避免漏传真实对话
  assert.equal(isEmptySession([header(), { type: 'future/event', seq: 0, time: 0, data: {} }]), false);
});

test('zstd 压缩日志能解出原文，多帧拼接也能解', () => {
  const plain = log(4);
  const compressed = zstdCompressSync(plain);
  assert.equal(validateSessionLog(compressed).ok, true);
  assert.equal(decodeSessionText(compressed), plain.toString('utf8'));

  const twoFrames = Buffer.concat([zstdCompressSync(encode([header(), event(0)])), zstdCompressSync(encode([event(1), event(2)]))]);
  assert.equal(validateSessionLog(twoFrames).ok, true);
  assert.equal(parseSessionLog(twoFrames).length, 4);
});

test('截断的 zstd 帧不会被当成完整日志', () => {
  const compressed = zstdCompressSync(log(4));
  const cut = compressed.subarray(0, compressed.length - 3);
  assert.equal(decodeSessionText(cut), null);
  assert.equal(validateSessionLog(cut).ok, false);
});

test('旧版打包行按事件跨度校验', () => {
  const packed = {
    type: 'text-chunks',
    seq0: 0,
    time0: 100,
    data: { turn: 0, step: 0, index: 0, dt: [1], texts: ['a', 'b'] },
  };
  const rows = [header({ version: 1 }), packed, event(2)];
  assert.equal(validateSessionLog(encode(rows)).ok, true);
  const gap = [header({ version: 1 }), { ...packed, seq0: 1 }, event(2)];
  assert.equal(validateSessionLog(encode(gap)).reason, 'session-seq-gap');
  const badEnvelope = [header({ version: 1 }), { ...packed, data: { ...packed.data, dt: [] } }];
  assert.equal(validateSessionLog(encode(badEnvelope)).ok, false);
  // v4 不允许再出现打包行
  const modern = [header(), packed];
  assert.equal(validateSessionLog(encode(modern)).ok, false);
});

test('两份历史的关系判定', () => {
  const base = [header(), event(0), event(1)];
  const longer = [header(), event(0), event(1), event(2)];
  const forked = [header(), event(0), { ...event(1), time: 999 }];
  assert.equal(historyRelation(base, base), 'same');
  assert.equal(historyRelation(base, longer), 'theirs-ahead');
  assert.equal(historyRelation(longer, base), 'ours-ahead');
  assert.equal(historyRelation(base, forked), 'divergent');
  assert.equal(historyRelation(base, [header({ id: 'other' }), event(0), event(1)]), 'header-mismatch');
});

test('合并只选可严格接续的一侧，不改写内容', () => {
  const base = log(2);
  const longer = log(5);
  assert.equal(mergeSessionHistory(base, longer).relation, 'theirs-ahead');
  assert.deepEqual(mergeSessionHistory(base, longer).value, longer);
  assert.deepEqual(mergeSessionHistory(longer, base).value, longer);
  assert.equal(mergeSessionHistory(base, base).value, base);
  const fork = encode([header(), event(0), { ...event(1), data: { turn: 99 } }]);
  assert.equal(mergeSessionHistory(base, fork).reason, 'divergent-session-history');
});

test('从会话日志里收集附件引用', () => {
  const hash = 'a'.repeat(64);
  const rows = encode([
    header(),
    { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'file', ref: `sha256:${hash}` }] } },
  ]);
  assert.deepEqual(attachmentRefs(rows), [hash]);
  assert.deepEqual(attachmentRefs(zstdCompressSync(rows)), [hash]);
});

test('深比较按顺序比较数组、忽略对象键顺序', () => {
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true);
  assert.equal(deepEqual([1, 2], [2, 1]), false);
  assert.equal(deepEqual({ a: 1 }, { a: '1' }), false);
  assert.equal(ZSTD_MAGIC.length, 4);
});
