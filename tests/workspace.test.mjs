import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EMPTY_SESSION_MAX_BYTES,
  baselineOf,
  compareRegistry,
  effectiveRegistry,
  isBlankSessionFile,
  normalizeRegistry,
} from '../lib/workspace.js';

const REAL = '11111111-1111-1111-1111-111111111111';
const BLANK = '22222222-2222-2222-2222-222222222222';
const GONE = '33333333-3333-3333-3333-333333333333';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-workspace-'));
}

function write(home, relative, value) {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function sessionBytes(id, count) {
  const rows = [
    { type: 'session', version: 4, id: 'session-' + id, cwd: 'E:/Ownsync/Demo' },
    ...Array.from({ length: count }, (_, seq) => ({ type: 'turn/start', seq, time: seq, data: { turn: seq } })),
  ];
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function blankSessionBytes(id) {
  const rows = [
    { type: 'session', version: 4, id: 'session-' + id, cwd: 'E:/Ownsync/Demo' },
    { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', seq: 1, time: 0, data: { mode: 'workspace-write' } },
    { type: 'session/end-seed', seq: 2, time: 1, data: {} },
  ];
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function registry({ sessionIds = [], updatedAt = '2026-01-01T00:00:00.000Z', archived = [], pinned = [] } = {}) {
  const data = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      defaultWorkspaceId: 'w1',
      workspaceIds: ['w1'],
      archivedSessionIds: archived,
      pinnedSessionIds: pinned,
    },
    tables: {
      workspaces: {
        w1: { path: 'E:/Ownsync/Demo', title: 'Demo', sessionIds, createdAt: '2026-01-01T00:00:00.000Z', updatedAt },
      },
    },
  };
  return Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** 本机装好：一个有内容的会话、一个空对话，GONE 没有对应文件。 */
function seededHome() {
  const home = tempHome();
  write(home, 'sessions/g/session-' + REAL + '/session.v4.jsonl', sessionBytes(REAL, 3));
  write(home, 'sessions/g/session-' + BLANK + '/session.v4.jsonl', blankSessionBytes(BLANK));
  return home;
}

test('归一化忽略时间戳和 id 顺序', () => {
  const left = normalizeRegistry(registry({ sessionIds: ['b', 'a'], updatedAt: '2026-01-01T00:00:00.000Z' }));
  const right = normalizeRegistry(registry({ sessionIds: ['a', 'b'], updatedAt: '2026-09-09T09:09:09.000Z' }));
  assert.ok(left && right);
  assert.equal(left.digest, right.digest);
  assert.deepEqual([...left.ids].sort(), ['a', 'b']);
  assert.equal(normalizeRegistry(Buffer.from('not json')), null);
});

test('空对话和找不到文件的 id 不算改动', () => {
  const home = seededHome();
  try {
    const baseline = baselineOf(home, registry({ sessionIds: ['session-' + REAL] }));
    assert.ok(baseline);

    const current = registry({
      sessionIds: ['session-' + BLANK, 'session-' + GONE, 'session-' + REAL],
      archived: ['session-' + BLANK],
      pinned: ['session-' + GONE, 'session-' + BLANK],
      updatedAt: '2026-11-11T10:53:28.532Z',
    });
    const verdict = compareRegistry(home, current, baseline);
    assert.equal(verdict.status, 'clean');
    assert.deepEqual(verdict.dropped.sort(), ['session-' + BLANK, 'session-' + GONE]);

    const effective = effectiveRegistry(home, current);
    const parsed = JSON.parse(JSON.stringify(effective.data));
    assert.deepEqual(parsed.tables.workspaces.w1.sessionIds, ['session-' + REAL]);
    assert.deepEqual(parsed.global.archivedSessionIds, []);
    assert.deepEqual(parsed.global.pinnedSessionIds, []);
    assert.equal(parsed.tables.workspaces.w1.updatedAt, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('真正的登记变化仍然算改动', () => {
  const home = seededHome();
  try {
    const baseline = baselineOf(home, registry({ sessionIds: ['session-' + REAL] }));

    // 多了一个有内容的会话 id
    const added = 'session-44444444-4444-4444-4444-444444444444';
    write(home, 'sessions/g/' + added + '/session.v4.jsonl', sessionBytes('44444444-4444-4444-4444-444444444444', 2));
    assert.equal(compareRegistry(home, registry({ sessionIds: ['session-' + REAL, added] }), baseline).status, 'dirty');

    // 会话 id 被移除
    assert.equal(compareRegistry(home, registry({ sessionIds: [] }), baseline).status, 'dirty');

    // 标题改了
    const renamed = JSON.parse(registry({ sessionIds: ['session-' + REAL] }).toString('utf8'));
    renamed.tables.workspaces.w1.title = 'Renamed';
    const bytes = Buffer.from(JSON.stringify(renamed, null, 2) + '\n', 'utf8');
    assert.equal(compareRegistry(home, bytes, baseline).status, 'dirty');

    // 没有基线时交给调用方决定
    assert.equal(compareRegistry(home, registry({ sessionIds: [] }), null).status, 'unknown');
    // 不是合法 JSON 一律算改动
    assert.equal(compareRegistry(home, Buffer.from('{'), baseline).status, 'dirty');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('空对话判定有大小上限', () => {
  const home = seededHome();
  try {
    assert.equal(isBlankSessionFile(path.join(home, 'sessions/g/session-' + BLANK + '/session.v4.jsonl')), true);
    assert.equal(isBlankSessionFile(path.join(home, 'sessions/g/session-' + REAL + '/session.v4.jsonl')), false);
    assert.equal(isBlankSessionFile(path.join(home, 'sessions/g/nope.jsonl')), false);

    const big = write(home, 'big.jsonl', Buffer.alloc(EMPTY_SESSION_MAX_BYTES + 1, 0x20));
    assert.equal(isBlankSessionFile(big), false, '超过上限不解码, 直接按有内容处理');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
