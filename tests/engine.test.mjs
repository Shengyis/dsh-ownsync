import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { SyncEngine } from '../lib/engine.js';
import { parseSessionLog } from '../lib/sessions.js';

const ID_A = '55555555-5555-5555-5555-555555555555';
const ID_B = '66666666-6666-6666-6666-666666666666';

function sessionPath(id) {
  return `sessions/g/session-${id}/session.v4.jsonl`;
}

function sessionBytes(id, count) {
  const rows = [
    { type: 'session', version: 4, id: `session-${id}`, cwd: 'E:/Ownsync/Demo' },
    ...Array.from({ length: count }, (_, seq) => ({ type: 'turn/start', seq, time: seq, data: { turn: seq } })),
  ];
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function writeFile(home, relative, value) {
  const target = path.join(home, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function workspace(home) {
  writeFile(
    home,
    'storages/workspace.json',
    JSON.stringify({ global: { workspaceIds: ['w1'] }, tables: { workspaces: { w1: { path: 'E:/Ownsync/Demo', title: 'Demo', sessionIds: [] } } } }) + '\n',
  );
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-engine-'));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', remote]);
  const homeA = path.join(root, 'A');
  const homeB = path.join(root, 'B');
  fs.mkdirSync(homeA);
  fs.mkdirSync(homeB);
  const config = { remote, branch: 'main' };
  return { root, remote, homeA, homeB, config };
}

function engineFor(home, config, ctx = null) {
  return new SyncEngine({ home, config, ctx });
}

/** 用内存句柄模拟宿主的会话写入接口。 */
function hostPersistence(home, file) {
  const target = path.join(home, file);
  const rows = () => parseSessionLog(fs.readFileSync(target));
  return {
    open() {
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

test('A 上传 → B 下载：服务器为准的单向同步', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    workspace(homeA);
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 3));

    const a = engineFor(homeA, config);
    const uploaded = await a.upload();
    assert.equal(uploaded.uploaded, true);
    assert.equal(uploaded.version, 1);
    assert.equal(uploaded.files, 2);

    const b = engineFor(homeB, config);
    const checked = await b.check();
    assert.equal(checked.remoteVersion, 1);
    assert.equal(checked.inSync, false);

    const downloaded = await b.download();
    assert.equal(downloaded.downloaded, true);
    assert.equal(downloaded.version, 1);
    assert.equal(downloaded.restartRequired, true);
    assert.deepEqual(downloaded.appliedSessions, [`session-${ID_A}`]);
    assert.deepEqual(parseSessionLog(fs.readFileSync(path.join(homeB, sessionPath(ID_A)))), parseSessionLog(sessionBytes(ID_A, 3)));
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(homeB, 'storages/workspace.json'), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(homeA, 'storages/workspace.json'), 'utf8')),
    );
    assert.equal((await b.check()).inSync, true);
    assert.equal((await b.download()).upToDate, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('忘记下载就上传会被拒绝，提示先下载', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    const a = engineFor(homeA, config);
    const b = engineFor(homeB, config);
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    await a.upload();

    await b.download();
    writeFile(homeB, sessionPath(ID_B), sessionBytes(ID_B, 2));
    const second = await b.upload();
    assert.equal(second.version, 2);

    const stale = await a.upload();
    assert.equal(stale.error, 'stale');
    assert.match(stale.message, /请先点「下载」/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('继续聊过的会话按追加方式写回，不整体替换', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    await engineFor(homeA, config).upload();
    await engineFor(homeB, config).download();

    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 6));
    await engineFor(homeA, config).upload();

    const b = engineFor(homeB, config, { get: name => (name === 'sessionPersistence' ? hostPersistence(homeB, sessionPath(ID_A)) : undefined) });
    const result = await b.download();
    assert.equal(result.downloaded, true);
    assert.equal(parseSessionLog(fs.readFileSync(path.join(homeB, sessionPath(ID_A)))).length, 7);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('本机有未上传改动时下载要先确认', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    await engineFor(homeA, config).upload();
    await engineFor(homeB, config).download();

    // B 本地改了一点东西（没有上传）
    writeFile(homeB, sessionPath(ID_A), sessionBytes(ID_A, 4));
    // A 又上传了新内容
    writeFile(homeA, sessionPath(ID_B), sessionBytes(ID_B, 2));
    await engineFor(homeA, config).upload();

    const b = engineFor(homeB, config);
    const blocked = await b.download();
    assert.equal(blocked.needsConfirm, 'overwrite');
    assert.ok(blocked.dirty.includes(sessionPath(ID_A)));

    const forced = await b.download({ confirm: 'overwrite' });
    assert.equal(forced.downloaded, true);
    // 服务器为准：A 上传的 ID_A 是 2 条，B 的 4 条被覆盖
    assert.equal(parseSessionLog(fs.readFileSync(path.join(homeB, sessionPath(ID_A)))).length, 3);
    assert.equal(fs.existsSync(path.join(homeB, sessionPath(ID_B))), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('一次删掉多个文件时上传要先确认', async () => {
  const { root, homeA, config } = setup();
  try {
    for (const id of [ID_A, ID_B, '77777777-7777-7777-7777-777777777777']) {
      writeFile(homeA, sessionPath(id), sessionBytes(id, 2));
    }
    const a = engineFor(homeA, config);
    await a.upload();

    for (const id of [ID_A, ID_B]) fs.rmSync(path.join(homeA, sessionPath(id)), { recursive: true });
    const blocked = await a.upload();
    assert.equal(blocked.needsConfirm, 'bulk-delete');
    assert.equal(blocked.deletions.length, 2);

    const forced = await a.upload({ confirm: 'bulk-delete' });
    assert.equal(forced.uploaded, true);
    assert.equal(forced.version, 2);
    // 删除的内容在服务器上还有旧版本，上传前已备份到本机
    const backups = a.recovery.list();
    assert.ok(backups.some(record => record.reason === 'upload-delete' && record.files.length === 2));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('有改动的文件显示工作区与会话标题', async () => {
  const { root, homeA, config } = setup();
  try {
    const file = sessionPath(ID_A);
    writeFile(homeA, file, sessionBytes(ID_A, 2));
    writeFile(
      homeA,
      'storages/workspace.json',
      Buffer.from(
        JSON.stringify({
          tables: {
            workspaces: {
              w1: { path: 'E:/Demo', title: 'Demo 工作区', sessionIds: [`session-${ID_A}`] },
            },
          },
        }),
      ),
    );
    writeFile(
      homeA,
      `storages/session_projcache/sessions/session-${ID_A}.json`,
      Buffer.from(JSON.stringify({ record: { rows: { title: { val: '测试会话标题' } } } })),
    );
    const a = engineFor(homeA, config);
    await a.upload();

    writeFile(homeA, file, sessionBytes(ID_A, 3));
    const changes = a.status().localChanges;
    assert.equal(changes.count, 1);
    assert.equal(changes.details[0].label, 'Demo 工作区 · 测试会话标题');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('服务器为空时检查标记 remoteEmpty，首次上传建出 v1', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    const a = engineFor(homeA, config);

    const checked = await a.check();
    assert.equal(checked.remoteEmpty, true);
    assert.equal(checked.remoteVersion, 0);
    assert.equal(checked.inSync, false);

    const uploaded = await a.upload();
    assert.equal(uploaded.version, 1);

    const after = await a.check();
    assert.equal(after.remoteEmpty, false);
    assert.equal(after.remoteVersion, 1);
    assert.equal(after.inSync, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('服务器为空时下载给出明确提示', async () => {
  const { root, homeB, config } = setup();
  try {
    const result = await engineFor(homeB, config).download();
    assert.equal(result.error, 'empty-remote');
    assert.match(result.message, /先在另一台电脑上传/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('上传后本机版本号、清单与服务器一致', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    workspace(homeA);
    const a = engineFor(homeA, config);
    const uploaded = await a.upload();
    assert.ok(uploaded.changedCount >= 1);
    assert.ok(uploaded.changedFiles.length >= 1);
    const state = a.status();
    assert.equal(state.local.version, 1);
    assert.equal(state.local.pending.length, 0);
    const checked = await a.check();
    assert.equal(checked.inSync, true);
    assert.equal(checked.localVersion, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工作区登记只是重新排版时不算改动', async () => {
  const { root, homeA, config } = setup();
  try {
    const value = { global: { workspaceIds: ['w1'] }, tables: { workspaces: { w1: { path: 'E:/Ownsync/Demo', title: 'Demo', sessionIds: [] } } } };
    writeFile(homeA, 'storages/workspace.json', JSON.stringify(value) + '\n');
    const a = engineFor(homeA, config);
    await a.upload();

    // 换个键序、换行重新写一遍，内容完全相同
    writeFile(homeA, 'storages/workspace.json', JSON.stringify({ tables: value.tables, global: value.global }, null, 2) + '\n');
    const again = await a.upload();
    assert.equal(again.upToDate, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('含中文和空格的附件路径也能上传下载', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    const bytes = Buffer.from('attachment-bytes');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const relative = 'attachments/v1/中文目录/图片 01.png';
    writeFile(homeA, relative, bytes);
    const rows = [
      { type: 'session', version: 4, id: `session-${ID_A}`, cwd: 'E:/Ownsync/Demo' },
      { type: 'user/message', seq: 0, time: 0, data: { content: [{ type: 'file', ref: `sha256:${hash}` }] } },
    ];
    writeFile(homeA, sessionPath(ID_A), Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));

    const uploaded = await engineFor(homeA, config).upload();
    assert.equal(uploaded.uploaded, true);
    assert.equal(uploaded.files, 2);

    const b = engineFor(homeB, config);
    assert.equal((await b.download()).downloaded, true);
    assert.deepEqual(fs.readFileSync(path.join(homeB, relative)), bytes);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('本机改动不改变版本号，但会被标记为未上传', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    const a = engineFor(homeA, config);
    await a.upload();

    const before = await a.check();
    assert.equal(before.inSync, true);
    assert.equal(before.localDirty, false);
    assert.equal(before.localVersion, 1);
    assert.equal(a.status().localChanges.count, 0);

    // 本机继续聊了两条，但没有上传
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 4));
    assert.ok(a.status().localChanges.count >= 1);
    const dirty = await a.check();
    assert.equal(dirty.localVersion, 1);
    assert.equal(dirty.remoteVersion, 1);
    assert.equal(dirty.inSync, true);
    assert.equal(dirty.localDirty, true);
    assert.ok(dirty.localChanges.count >= 1);

    const uploaded = await a.upload();
    assert.equal(uploaded.version, 2);
    const after = await a.check();
    assert.equal(after.localDirty, false);
    assert.equal(after.localVersion, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('空白会话（只有 header）不上传，也不算改动', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    const a = engineFor(homeA, config);
    await a.upload();

    const blank = `sessions/g/session-${ID_B}/session.v4.jsonl`;
    writeFile(
      homeA,
      blank,
      Buffer.from(JSON.stringify({ type: 'session', version: 4, id: `session-${ID_B}`, cwd: 'E:/Demo' }) + '\n'),
    );

    assert.equal(a.status().localChanges.count, 0);
    const again = await a.upload();
    assert.equal(again.upToDate, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('只多了 end-seed 标记时下载不再要求覆盖确认', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    const file = sessionPath(ID_A);
    writeFile(homeA, file, sessionBytes(ID_A, 2));
    await engineFor(homeA, config).upload();
    const b = engineFor(homeB, config);
    await b.download();

    writeFile(homeA, file, sessionBytes(ID_A, 3));
    await engineFor(homeA, config).upload();

    // B 打开过这个会话，DSH 追了一条标记
    fs.appendFileSync(
      path.join(homeB, file),
      JSON.stringify({ type: 'session/end-seed', seq: 99, time: 99, data: {} }) + '\n',
    );
    assert.equal(b.status().localChanges.count, 0);

    const result = await b.download();
    assert.equal(result.needsConfirm, undefined);
    assert.equal(result.downloaded, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('打开会话时追加的 session/end-seed 不算改动', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    const a = engineFor(homeA, config);
    await a.upload();
    assert.equal(a.status().localChanges.count, 0);

    const target = path.join(homeA, sessionPath(ID_A));
    fs.appendFileSync(
      target,
      JSON.stringify({ type: 'session/end-seed', seq: 99, time: 99, data: {} }) + '\n',
    );
    assert.equal(a.status().localChanges.count, 0);

    fs.appendFileSync(
      target,
      JSON.stringify({ type: 'user/message', seq: 100, time: 100, data: { content: [] } }) + '\n',
    );
    assert.equal(a.status().localChanges.count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('文件只是被原样重写（mtime 变化）不算改动', async () => {
  const { root, homeA, config } = setup();
  try {
    const bytes = sessionBytes(ID_A, 2);
    writeFile(homeA, sessionPath(ID_A), bytes);
    const a = engineFor(homeA, config);
    await a.upload();
    assert.equal(a.status().localChanges.count, 0);

    // 内容不变，只把修改时间往后推
    const target = path.join(homeA, sessionPath(ID_A));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(target, later, later);
    assert.equal(a.status().localChanges.count, 0);

    // 真的追加内容才算改动
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 3));
    assert.equal(a.status().localChanges.count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('待写回会话：启动时补写并记下要回到哪个会话', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    const file = sessionPath(ID_A);
    writeFile(homeA, file, sessionBytes(ID_A, 2));
    await engineFor(homeA, config).upload();

    const handleFor = () => {
      const target = path.join(homeB, file);
      const rows = () => parseSessionLog(fs.readFileSync(target));
      return {
        async read() {
          return { events: rows().slice(1) };
        },
        async append(events) {
          fs.writeFileSync(
            target,
            Buffer.from([...rows(), ...events].map(row => JSON.stringify(row)).join('\n') + '\n'),
          );
        },
        async flush() {},
        async close() {},
      };
    };

    let held = false;
    const persistence = {
      open() {
        if (held) {
          const error = new Error('writer held');
          error.name = 'SessionAlreadyOwnedError';
          throw error;
        }
        return handleFor();
      },
    };
    const b = new SyncEngine({
      home: homeB,
      config,
      ctx: { get: name => (name === 'sessionPersistence' ? persistence : undefined) },
    });
    await b.download();
    assert.equal(parseSessionLog(fs.readFileSync(path.join(homeB, file))).length, 3);

    writeFile(homeA, file, sessionBytes(ID_A, 5));
    await engineFor(homeA, config).upload();

    held = true;
    const blocked = await b.download();
    assert.equal(blocked.deferred[0].reason, 'session-writer-held');
    assert.equal(b.status().local.pending.length, 1);

    // 重启后写入权释放：启动补写应该把这条会话写回，并记下要回到哪个会话
    held = false;
    const started = await b.startupApply();
    assert.equal(started.applied, 1);
    assert.equal(b.status().local.pending.length, 0);
    assert.equal(b.status().returnTo, `session-${ID_A}`);
    assert.equal(parseSessionLog(fs.readFileSync(path.join(homeB, file))).length, 6);

    b.clearReturnTo();
    assert.equal(b.status().returnTo, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('没有改动时上传不产生新版本', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), sessionBytes(ID_A, 2));
    const a = engineFor(homeA, config);
    await a.upload();
    const again = await a.upload();
    assert.equal(again.upToDate, true);
    assert.equal(again.version, 1);
    const checked = await a.check();
    assert.equal(checked.remoteVersion, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('zstd 压缩的会话原样上传、原样取回', async () => {
  const { root, homeA, homeB, config } = setup();
  try {
    const compressed = zstdCompressSync(sessionBytes(ID_A, 4));
    writeFile(homeA, sessionPath(ID_A), compressed);
    const uploaded = await engineFor(homeA, config).upload();
    assert.equal(uploaded.uploaded, true);

    const b = engineFor(homeB, config);
    const downloaded = await b.download();
    assert.equal(downloaded.downloaded, true);
    assert.deepEqual(fs.readFileSync(path.join(homeB, sessionPath(ID_A))), compressed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('会话还在写入时上传被拒绝', async () => {
  const { root, homeA, config } = setup();
  try {
    writeFile(homeA, sessionPath(ID_A), Buffer.from('{"type":"session","version":4}\n{"type":"turn/start"'));
    const a = engineFor(homeA, config);
    const result = await a.upload();
    assert.equal(result.error, 'session-busy');
    assert.match(result.message, /正在写入/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
