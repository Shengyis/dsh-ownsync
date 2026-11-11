import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { contentKind, listCandidateFiles, normalizeRelative } from '../lib/scope.js';
import { diffManifests, filterWorkspaceRegistry, scanSnapshot, toManifest } from '../lib/snapshot.js';

const ID = '22222222-2222-2222-2222-222222222222';
const EMPTY_ID = '33333333-3333-3333-3333-333333333333';

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-snapshot-'));
  return home;
}

function write(home, relative, value) {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
  return target;
}

function sessionBytes(refs = []) {
  const rows = [
    { type: 'session', version: 4, id: `session-${ID}`, cwd: 'E:/Ownsync/Demo' },
    { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } },
    ...refs.map((hash, index) => ({
      type: 'user/message',
      seq: index + 1,
      time: index + 1,
      data: { content: [{ type: 'file', ref: `sha256:${hash}` }] },
    })),
  ];
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

/** 新建但没发过消息的会话：只有 header 和几条引导事件。 */
function emptySessionBytes() {
  const rows = [
    { type: 'session', version: 4, id: `session-${EMPTY_ID}`, cwd: 'E:/Ownsync/Demo' },
    { type: 'permission/preset', seq: 0, time: 0, data: { preset: 'danger-full-access' } },
    { type: 'sandbox/mode', seq: 1, time: 0, data: { mode: 'danger-full-access' } },
    { type: 'approval/policy', seq: 2, time: 0, data: { policy: 'never' } },
    { type: 'session/end-seed', seq: 3, time: 1, data: {} },
  ];
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

test('同步范围只认三类内容', () => {
  assert.equal(contentKind(`sessions/a/session-${ID}/session.v4.jsonl`), 'sessions');
  assert.equal(contentKind('storages/workspace.json'), 'workspaces');
  assert.equal(contentKind('attachments/v1/a.png'), 'attachments');
  for (const file of [
    'settings.yaml',
    'cordis.patch.yml',
    'profiles/web/package.json',
    'AGENTS.md',
    'skills/x/SKILL.md',
    'sessions/a/session.lock',
    'sessions/a/notes.txt',
    'cache/x.bin',
    'dsh-sync.json',
  ])
    assert.equal(contentKind(file), null, file);
  assert.equal(normalizeRelative('sessions\\a\\b.jsonl'), 'sessions/a/b.jsonl');
});

test('扫描只收被引用的附件，并忽略噪声文件', () => {
  const home = tempHome();
  try {
    const used = Buffer.from('used-bytes');
    const unused = Buffer.from('unused-bytes');
    write(home, `sessions/g/session-${ID}/session.v4.jsonl`, sessionBytes([sha256(used)]));
    write(home, `sessions/g/session-${ID}/session.v3.jsonl`, sessionBytes());
    write(home, `sessions/g/session-${ID}/session.lock`, 'lock');
    write(home, 'attachments/v1/aa/used.png', used);
    write(home, 'attachments/v1/aa/unused.png', unused);
    write(home, 'storages/workspace.json', JSON.stringify({ global: { workspaceIds: [] }, tables: { workspaces: {} } }));
    write(home, 'settings.yaml', 'theme: dark\n');
    write(home, 'cache/wide.bin', 'x');
    write(home, 'sessions/g/session-99999999-9999-9999-9999-999999999999/session.v4.jsonl', 'broken');

    const { sessions, attachments } = listCandidateFiles(home);
    assert.equal(sessions.length, 3);
    assert.equal(attachments.length, 2);

    const snapshot = scanSnapshot(home);
    const paths = snapshot.entries.map(entry => entry.path).sort();
    assert.deepEqual(paths, [
      `sessions/g/session-${ID}/session.v4.jsonl`,
      'attachments/v1/aa/used.png',
      'storages/workspace.json',
    ].sort());
    assert.deepEqual(snapshot.invalidSessions.map(item => item.reason).sort(), ['invalid-session-log']);
    assert.equal(snapshot.entries.find(entry => entry.kind === 'attachments').sha256, sha256(used));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('空对话不进入上传清单', () => {
  const home = tempHome();
  try {
    const real = `sessions/g/session-${ID}/session.v4.jsonl`;
    const empty = `sessions/g/session-${EMPTY_ID}/session.v4.jsonl`;
    write(home, real, sessionBytes());
    write(home, empty, emptySessionBytes());
    write(home, 'storages/workspace.json', JSON.stringify({ global: { workspaceIds: [] }, tables: { workspaces: {} } }));

    const snapshot = scanSnapshot(home);
    const sessions = snapshot.entries.filter(entry => entry.kind === 'sessions').map(entry => entry.path);
    assert.deepEqual(sessions, [real]);
    assert.deepEqual([...snapshot.emptySessions], [`session-${EMPTY_ID}`]);
    assert.equal(snapshot.workspaceUpload, null);
    assert.equal(snapshot.invalidSessions.length, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('上传前从工作区登记里去掉空对话 id', () => {
  const emptyId = `session-${EMPTY_ID}`;
  const realId = `session-${ID}`;
  const registry = {
    global: {
      initialized: true,
      archivedSessionIds: [emptyId],
      pinnedSessionIds: [realId, emptyId],
    },
    tables: {
      workspaces: {
        w1: { path: 'E:/Ownsync/Demo', title: 'Demo', sessionIds: [emptyId, realId] },
      },
    },
  };
  const bytes = Buffer.from(JSON.stringify(registry, null, 2) + '\n', 'utf8');
  const filtered = filterWorkspaceRegistry(bytes, new Set([emptyId]));
  assert.ok(filtered instanceof Buffer);
  const parsed = JSON.parse(filtered.toString('utf8'));
  assert.deepEqual(parsed.tables.workspaces.w1.sessionIds, [realId]);
  assert.deepEqual(parsed.global.archivedSessionIds, []);
  assert.deepEqual(parsed.global.pinnedSessionIds, [realId]);

  // 没有空对话 id 时保持原样（返回 null，调用方直接上传原文件）
  assert.equal(filterWorkspaceRegistry(bytes, new Set()), null);
  assert.equal(filterWorkspaceRegistry(bytes, new Set([`session-${EMPTY_ID}`])).equals(bytes), false);
});

test('已删除的空对话 id 也会从上传的工作区登记里去掉', () => {
  const home = tempHome();
  try {
    const emptyId = `session-${EMPTY_ID}`;
    const realId = `session-${ID}`;
    write(
      home,
      'storages/workspace.json',
      JSON.stringify({
        global: { workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] },
        tables: { workspaces: { w1: { path: 'E:/Ownsync/Demo', title: 'Demo', sessionIds: [emptyId, realId] } } },
      }),
    );
    write(home, '.ownsync/ignored-sessions.json', JSON.stringify([emptyId]));
    // 只留真实会话，emptyId 的会话文件已经删除
    write(home, `sessions/g/session-${ID}/session.v4.jsonl`, sessionBytes());

    const snapshot = scanSnapshot(home);
    assert.ok(snapshot.workspaceUpload, '删除记录没有参与过滤');
    const parsed = JSON.parse(snapshot.workspaceUpload.toString('utf8'));
    assert.deepEqual(parsed.tables.workspaces.w1.sessionIds, [realId]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('只保留最高代际的会话日志', () => {
  const home = tempHome();
  try {
    write(home, `sessions/g/session-${ID}/session.v2.jsonl`, sessionBytes());
    write(home, `sessions/g/session-${ID}/session.v4.jsonl`, sessionBytes());
    const snapshot = scanSnapshot(home);
    assert.equal(snapshot.entries.filter(entry => entry.kind === 'sessions').length, 1);
    assert.match(snapshot.entries[0].path, /v4/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('清单差异能区分新增、修改、删除', () => {
  const before = { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' };
  const after = { 'a.txt': '1', 'b.txt': '9', 'd.txt': '4' };
  const diff = diffManifests(before, after);
  assert.deepEqual(diff.added, ['d.txt']);
  assert.deepEqual(diff.modified, ['b.txt']);
  assert.deepEqual(diff.deleted, ['c.txt']);
  assert.equal(diff.changed, 3);

  const snapshot = { entries: [{ path: 'a.txt', sha256: '1' }] };
  assert.deepEqual(toManifest(snapshot.entries), { 'a.txt': '1' });
});
