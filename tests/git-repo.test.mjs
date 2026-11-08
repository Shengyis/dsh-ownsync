import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  commitTree,
  ensureRepo,
  fetchRemote,
  listTree,
  pushMain,
  readBlobs,
  readState,
  remoteHead,
  repoDir,
  stageTree,
} from '../lib/git-repo.js';

const ID = '33333333-3333-3333-3333-333333333333';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-git-'));
  const remote = path.join(root, 'remote.git');
  execFileSync('git', ['init', '--bare', '--quiet', remote]);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const write = (relative, value) => {
    const target = path.join(home, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, value);
    return relative;
  };
  return { root, remote, home, write, config: { remote, branch: 'main' } };
}

function show(remote, ref) {
  return execFileSync('git', ['-C', remote, 'show', ref], { encoding: 'utf8' });
}

test('上传：写树、建根提交、推送 main', async () => {
  const { root, remote, home, write, config } = fixture();
  try {
    const session = `sessions/g/session-${ID}/session.v4.jsonl`;
    write(session, '{"type":"session"}\n');
    write('storages/workspace.json', '{"global":{},"tables":{"workspaces":{}}}\n');

    const repo = await ensureRepo(home, config);
    assert.equal(repo, repoDir(home));
    assert.deepEqual(await fetchRemote(repo, config), { empty: true });
    assert.equal(await remoteHead(repo, 'main'), null);

    const { tree, entries } = await stageTree(repo, home, [session, 'storages/workspace.json'], [
      { path: 'state.json', content: JSON.stringify({ format: 1, version: 1 }) + '\n' },
    ]);
    assert.equal(entries.length, 3);
    const commit = await commitTree(repo, tree, 'ownsync v1');
    assert.match(commit, /^[0-9a-f]{40,64}$/);

    const pushed = await pushMain(repo, config, commit, null);
    assert.equal(pushed.pushed, true);

    await fetchRemote(repo, config);
    assert.equal(await remoteHead(repo, 'main'), commit);
    assert.equal((await readState(repo, commit)).version, 1);
    assert.equal(show(remote, 'main:storages/workspace.json').trim(), '{"global":{},"tables":{"workspaces":{}}}');

    const listing = await listTree(repo, commit);
    assert.deepEqual(listing.map(entry => entry.path).sort(), ['sessions/g/session-' + ID + '/session.v4.jsonl', 'state.json', 'storages/workspace.json'].sort());

    const blobs = await readBlobs(repo, listing.map(entry => entry.sha));
    const sessionBlob = blobs.get(listing.find(entry => entry.path === session).sha);
    assert.equal(sessionBlob.toString('utf8'), '{"type":"session"}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('推送用 force-with-lease 做比较交换：服务器变了就拒绝', async () => {
  const { root, home, write, config } = fixture();
  try {
    write('a.txt', 'one');
    const repo = await ensureRepo(home, config);
    await fetchRemote(repo, config);

    const first = await commitTree(repo, (await stageTree(repo, home, ['a.txt'])).tree, 'v1');
    assert.equal((await pushMain(repo, config, first, null)).pushed, true);
    await fetchRemote(repo, config);
    assert.equal(await remoteHead(repo, 'main'), first);

    // 服务器上已经有 main，却仍然声称"没有" → 必须失败
    const second = await commitTree(repo, (await stageTree(repo, home, ['a.txt'])).tree, 'v2');
    const rejected = await pushMain(repo, config, second, null);
    assert.equal(rejected.pushed, false);
    assert.equal(rejected.stale, true);

    // 以正确的旧提交为基准 → 成功
    assert.equal((await pushMain(repo, config, second, first)).pushed, true);

    // 再拿上一个基准推一次 → 服务器已经前进，必须失败
    const third = await commitTree(repo, (await stageTree(repo, home, ['a.txt'])).tree, 'v3');
    const stale = await pushMain(repo, config, third, first);
    assert.equal(stale.pushed, false);
    assert.equal(stale.stale, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('提交是根提交：每次都只保留当前快照', async () => {
  const { root, home, write, config } = fixture();
  try {
    write('a.txt', 'one');
    const repo = await ensureRepo(home, config);
    await fetchRemote(repo, config);
    const first = await commitTree(repo, (await stageTree(repo, home, ['a.txt'])).tree, 'v1');
    const parents = execFileSync('git', ['-C', repo, 'rev-list', '--parents', '-n', '1', first], { encoding: 'utf8' });
    assert.equal(parents.trim(), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('空快照也能提交', async () => {
  const { root, home, config } = fixture();
  try {
    const repo = await ensureRepo(home, config);
    const { tree } = await stageTree(repo, home, []);
    const commit = await commitTree(repo, tree, 'empty');
    await fetchRemote(repo, config);
    assert.equal((await pushMain(repo, config, commit, null)).pushed, true);
    assert.deepEqual(await listTree(repo, commit), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
