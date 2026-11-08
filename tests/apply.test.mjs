import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecoveryStore } from '../lib/recovery.js';
import { applyIncoming } from '../lib/apply.js';
import { applySessionTransfer } from '../lib/session-transfer.js';
import { parseSessionLog } from '../lib/sessions.js';

const ID = '44444444-4444-4444-4444-444444444444';
const FILE = `sessions/g/session-${ID}/session.v4.jsonl`;

const header = () => ({ type: 'session', version: 4, id: `session-${ID}`, cwd: 'E:/Ownsync/Demo' });
const event = seq => ({ type: 'turn/start', seq, time: seq, data: { turn: seq } });
const encode = count => Buffer.from([header(), ...Array.from({ length: count }, (_, index) => event(index))].map(row => JSON.stringify(row)).join('\n') + '\n');

function homeFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-apply-'));
  return home;
}

function engineFor(home, { persistence = null } = {}) {
  return {
    home,
    log: () => {},
    recovery: new RecoveryStore(home),
    ctx: persistence ? { get: name => (name === 'sessionPersistence' ? persistence : undefined) } : null,
  };
}

/** 用内存句柄模拟宿主持久化接口。 */
function hostPersistence(home, file, { held = false } = {}) {
  const target = path.join(home, file);
  const rows = () => parseSessionLog(fs.readFileSync(target));
  return {
    open() {
      if (held) {
        const error = new Error('writer held');
        error.name = 'SessionAlreadyOwnedError';
        throw error;
      }
      return {
        async read() {
          return { events: rows().slice(1) };
        },
        async append(events) {
          fs.writeFileSync(target, Buffer.from([...rows(), ...events].map(row => JSON.stringify(row)).join('\n') + '\n'));
        },
        async flush() {},
        async close() {},
      };
    },
  };
}

test('恢复记录：保存、列出、还原、清理', () => {
  const home = homeFixture();
  try {
    const store = new RecoveryStore(home);
    const bytes = Buffer.from('original');
    const name = store.save('overwrite', [{ path: 'a/b.txt', bytes }]);
    assert.ok(name);
    const list = store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].files[0].path, 'a/b.txt');
    assert.ok(store.size() >= bytes.length);

    fs.mkdirSync(path.join(home, 'a'), { recursive: true });
    fs.writeFileSync(path.join(home, 'a/b.txt'), 'changed');
    store.restore(name, 'a/b.txt');
    assert.equal(fs.readFileSync(path.join(home, 'a/b.txt'), 'utf8'), 'original');

    assert.equal(store.clear(), 1);
    assert.deepEqual(store.list(), []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('新会话直接写入磁盘', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    const result = await applySessionTransfer(engine, FILE, encode(3));
    assert.equal(result.status, 'created');
    assert.equal(result.restartRequired, true);
    assert.equal(parseSessionLog(fs.readFileSync(path.join(home, FILE))).length, 4);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('内容一致时不动文件', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    const bytes = encode(3);
    await applySessionTransfer(engine, FILE, bytes);
    const before = fs.statSync(path.join(home, FILE)).mtimeMs;
    const result = await applySessionTransfer(engine, FILE, bytes);
    assert.equal(result.status, 'unchanged');
    assert.equal(fs.statSync(path.join(home, FILE)).mtimeMs, before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('服务器是本机的延续时，通过宿主接口追加', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    await applySessionTransfer(engine, FILE, encode(2));
    engine.ctx = { get: () => hostPersistence(home, FILE) };
    const result = await applySessionTransfer(engine, FILE, encode(5));
    assert.equal(result.status, 'appended');
    assert.equal(parseSessionLog(fs.readFileSync(path.join(home, FILE))).length, 6);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('写入权被占用时推迟，不覆盖', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    await applySessionTransfer(engine, FILE, encode(2));
    engine.ctx = { get: () => hostPersistence(home, FILE, { held: true }) };
    const result = await applySessionTransfer(engine, FILE, encode(5));
    assert.equal(result.status, 'deferred');
    assert.equal(result.reason, 'session-writer-held');
    assert.equal(parseSessionLog(fs.readFileSync(path.join(home, FILE))).length, 3);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('分叉时以服务器为准，但先备份本机原件', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    await applySessionTransfer(engine, FILE, encode(2));
    const forked = Buffer.from([header(), event(0), { ...event(1), data: { turn: 99 } }].map(row => JSON.stringify(row)).join('\n') + '\n');
    const result = await applySessionTransfer(engine, FILE, forked);
    assert.equal(result.status, 'replaced');
    assert.equal(result.restartRequired, true);
    assert.equal(engine.recovery.list().length, 1);
    assert.deepEqual(parseSessionLog(fs.readFileSync(path.join(home, FILE))), parseSessionLog(forked));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('本机领先时保留本机', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    await applySessionTransfer(engine, FILE, encode(5));
    const result = await applySessionTransfer(engine, FILE, encode(3));
    assert.equal(result.status, 'local-ahead');
    assert.equal(parseSessionLog(fs.readFileSync(path.join(home, FILE))).length, 6);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('整体应用：附件与会话落地，删除项进备份', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    const attachment = 'attachments/v1/aa/pic.png';
    fs.mkdirSync(path.join(home, 'attachments/v1/aa'), { recursive: true });
    fs.writeFileSync(path.join(home, attachment), 'old-bytes');
    fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(home, 'storages/workspace.json'), '{"old":true}\n');

    const result = await applyIncoming(engine, [
      { path: FILE, kind: 'sessions', bytes: encode(2) },
      { path: attachment, kind: 'attachments', bytes: Buffer.from('new-bytes') },
      { path: 'storages/workspace.json', kind: 'workspaces', bytes: Buffer.from('{"global":{}}\n') },
    ]);

    assert.equal(fs.readFileSync(path.join(home, attachment), 'utf8'), 'new-bytes');
    assert.equal(fs.readFileSync(path.join(home, 'storages/workspace.json'), 'utf8'), '{"global":{}}\n');
    assert.equal(result.applied.length, 3);
    assert.equal(result.restartRequired, true);
    // 附件和工作区登记都被覆盖过，各留一份原件
    assert.equal(engine.recovery.list().length, 2);

    const removal = await applyIncoming(engine, [], { removals: [attachment] });
    assert.deepEqual(removal.removed, [attachment]);
    assert.equal(fs.existsSync(path.join(home, attachment)), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('坏掉的工作区登记不会被写入', async () => {
  const home = homeFixture();
  try {
    const engine = engineFor(home);
    const result = await applyIncoming(engine, [
      { path: 'storages/workspace.json', kind: 'workspaces', bytes: Buffer.from('not json') },
    ]);
    assert.equal(result.failures.length, 1);
    assert.equal(fs.existsSync(path.join(home, 'storages/workspace.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
