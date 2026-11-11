import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_CONFIG, normalizeBranch, normalizeRemote, readConfig, writeConfig } from '../lib/config.js';

test('仓库地址只接受常见的 Git 形式', () => {
  assert.equal(normalizeRemote('https://git.example.com/a/b.git'), 'https://git.example.com/a/b.git');
  assert.equal(normalizeRemote('ssh://git@host:2222/srv/git/a.git'), 'ssh://git@host:2222/srv/git/a.git');
  assert.equal(normalizeRemote('git@host:srv/git/a.git'), 'git@host:srv/git/a.git');
  assert.equal(normalizeRemote('  https://a/b  '), 'https://a/b');
  assert.equal(normalizeRemote(''), '');
  assert.throws(() => normalizeRemote('https://user:pass@host/a.git'), /不要写用户名和密码/);
  assert.throws(() => normalizeRemote('ftp://host/a.git'), /不支持的地址协议/);
  assert.throws(() => normalizeRemote('notaurl'), /仓库地址需要/);
  assert.throws(() => normalizeRemote('https://a b/c'), /空格或换行/);
});

test('分支名过滤明显非法值', () => {
  assert.equal(normalizeBranch(''), 'main');
  assert.equal(normalizeBranch('main'), 'main');
  assert.equal(normalizeBranch('sync/main'), 'sync/main');
  assert.throws(() => normalizeBranch('bad branch'), /不合法/);
  assert.throws(() => normalizeBranch('a..b'), /不合法/);
});

test('配置读写：默认值、保存、损坏文件', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-config-'));
  try {
    assert.deepEqual(readConfig(home).config, DEFAULT_CONFIG);
    assert.equal(DEFAULT_CONFIG.autoUpload, true);
    const saved = writeConfig(home, { remote: 'https://git.example.com/a/b.git', branch: 'sync/main' });
    assert.deepEqual(saved, {
      remote: 'https://git.example.com/a/b.git',
      branch: 'sync/main',
      autoUpload: true,
    });
    assert.deepEqual(readConfig(home).config, saved);

    const off = writeConfig(home, { autoUpload: false });
    assert.equal(off.autoUpload, false);
    assert.equal(readConfig(home).config.autoUpload, false);
    const on = writeConfig(home, { autoUpload: true });
    assert.equal(on.autoUpload, true);

    // 旧版本留下的 autoDownload 字段：读的时候忽略，保存时清掉
    fs.writeFileSync(
      path.join(home, 'ownsync.json'),
      JSON.stringify({ remote: 'https://git.example.com/a/b.git', branch: 'main', autoDownload: false }),
    );
    assert.equal('autoDownload' in readConfig(home).config, false);
    writeConfig(home, { autoUpload: true });
    assert.equal('autoDownload' in JSON.parse(fs.readFileSync(path.join(home, 'ownsync.json'), 'utf8')), false);

    fs.writeFileSync(path.join(home, 'ownsync.json'), '{broken');
    const damaged = readConfig(home);
    assert.deepEqual(damaged.config, DEFAULT_CONFIG);
    assert.match(damaged.error, /格式不正确/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
