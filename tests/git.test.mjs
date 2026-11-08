import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOk, runGit } from '../lib/git.js';
import { describeGitFailure, failureText } from '../lib/git-failure.js';

test('正常执行 git 命令', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-git-'));
  try {
    const result = await runGit(cwd, ['--version']);
    assert.equal(isOk(result), true);
    assert.match(String(result.stdout), /git version/i);
    assert.equal(result.spawnError, null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('找不到 git 时返回 spawnError，而不是抛异常', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-git-'));
  try {
    const result = await runGit(cwd, ['--version'], { command: 'ownsync-no-such-git' });
    assert.equal(result.spawnError, 'ENOENT');
    assert.equal(result.code, -1);
    assert.equal(result.timedOut, false);
    assert.equal(isOk(result), false);

    const failure = describeGitFailure(result);
    assert.equal(failure.kind, 'git-missing');
    assert.match(failure.reason, /找不到 git/);
    assert.match(failure.hint, /Git for Windows/);
    assert.match(failureText(failure), /Git for Windows/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('权限不足与其它失败分类', () => {
  assert.equal(describeGitFailure({ spawnError: 'EACCES' }).kind, 'git-missing');
  assert.match(describeGitFailure({ spawnError: 'EACCES' }).hint, /权限/);

  assert.equal(describeGitFailure({ timedOut: true }).kind, 'timeout');
  assert.equal(describeGitFailure({ code: 128, stderr: "fatal: could not read Username for 'https://git.example.com'" }).kind, 'auth');
  assert.equal(describeGitFailure({ code: 128, stderr: 'Permission denied (publickey).' }).kind, 'auth');
  assert.equal(describeGitFailure({ code: 128, stderr: 'fatal: unable to access: Could not resolve host: git.example.com' }).kind, 'network');
  assert.equal(describeGitFailure({ code: 128, stderr: 'fatal: repository not found' }).kind, 'missing');
  assert.equal(describeGitFailure({ code: 1, stderr: '! [rejected] main -> main (stale info)' }).kind, 'stale');
  assert.equal(describeGitFailure({ code: 1, stderr: 'something odd happened' }).kind, 'unknown');
  assert.match(describeGitFailure({ code: 1, stderr: 'something odd happened' }).detail, /something odd/);
});
