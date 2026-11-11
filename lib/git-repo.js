/**
 * 本地裸仓库与服务器之间的搬运。
 *
 * 本地仓库放在 `<DSH home>/.ownsync/repo.git`，是 bare 仓库：
 * 没有工作树，所以同步过程不会在本机生成第二份数据。
 *
 * 服务器上的 `main` 分支只有一个根提交（每次上传都重建），因此仓库体积等于
 * "当前快照"，不会随着上传次数膨胀。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGit, isOk } from './git.js';
import { describeGitFailure, failureText } from './git-failure.js';

/** 仓库根下的版本文件。 */
export const STATE_FILE = 'state.json';

const CONFIG = {
  'core.autocrlf': 'false',
  'core.safecrlf': 'false',
  'core.longpaths': 'true',
  'commit.gpgsign': 'false',
  'user.name': 'dsh-ownsync',
  'user.email': 'dsh-ownsync@localhost',
};

export function repoDir(home) {
  return path.join(home, '.ownsync', 'repo.git');
}

function ok(result) {
  return isOk(result);
}

function fail(result, fallback) {
  const described = describeGitFailure(result);
  return Object.assign(new Error(described.reason + '. ' + described.hint), { git: described, fallback });
}

/** 初始化（或复用）本地裸仓库，并把配置对齐到当前设置。 */
export async function ensureRepo(home, config) {
  const repo = repoDir(home);
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  if (!fs.existsSync(path.join(repo, 'HEAD'))) {
    const init = await runGit(path.dirname(repo), ['init', '--quiet', '--bare', repo]);
    if (!ok(init)) throw fail(init, '无法初始化本地同步仓库');
  }

  const listed = await runGit(repo, ['config', '--local', '--null', '--list']);
  const current = new Map();
  if (ok(listed)) {
    for (const line of String(listed.stdout).split('\0')) {
      const index = line.indexOf('\n');
      if (index < 0) continue;
      current.set(line.slice(0, index), line.slice(index + 1));
    }
  }

  const wanted = { ...CONFIG };
  if (config.remote) {
    wanted['remote.origin.url'] = config.remote;
    wanted['remote.origin.fetch'] = '+refs/heads/' + config.branch + ':refs/remotes/origin/' + config.branch;
  }
  for (const [key, value] of Object.entries(wanted)) {
    if (current.get(key) === value) continue;
    const set = await runGit(repo, ['config', '--local', '--replace-all', key, value]);
    if (!ok(set)) throw fail(set, '无法写入本地仓库配置: ' + key);
  }
  return repo;
}

/** 取回服务器分支；服务器还没有该分支时返回 `{empty: true}`。 */
export async function fetchRemote(repo, config) {
  if (!config.remote) return { empty: true };
  const result = await runGit(
    repo,
    ['fetch', '--prune', '--quiet', 'origin', '+' + 'refs/heads/' + config.branch + ':refs/remotes/origin/' + config.branch],
    { timeoutMs: 300_000 },
  );
  if (ok(result)) return { empty: false };
  const text = String(result.stderr || '');
  if (/couldn't find remote ref|no such ref|not found/i.test(text) && !/repository not found/i.test(text))
    return { empty: true };
  throw fail(result, '无法连接同步服务器');
}

/** 远端分支的提交 id；没有该分支返回 null。 */
export async function remoteHead(repo, branch) {
  const result = await runGit(repo, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/' + branch]);
  return ok(result) ? String(result.stdout).trim() || null : null;
}

/** 读取某个提交里的 `state.json`。 */
export async function readState(repo, commit) {
  if (!commit) return null;
  const result = await runGit(repo, ['cat-file', '-p', commit + ':' + STATE_FILE]);
  if (!ok(result)) return null;
  try {
    return JSON.parse(String(result.stdout));
  } catch {
    return null;
  }
}

/** 列出一个提交里的全部文件。 */
export async function listTree(repo, commit) {
  const result = await runGit(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  if (!ok(result)) throw fail(result, '无法读取服务器上的文件清单');
  const entries = [];
  for (const row of String(result.stdout).split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, sha] = row.slice(0, tab).split(' ');
    entries.push({ mode, type, sha, path: row.slice(tab + 1) });
  }
  return entries;
}

/** 批量读取 blob 内容（一次进程读多个对象）。 */
export async function readBlobs(repo, shas) {
  const unique = [...new Set(shas)];
  const blobs = new Map();
  if (unique.length === 0) return blobs;
  const result = await runGit(repo, ['cat-file', '--batch'], { input: unique.join('\n') + '\n', binary: true });
  if (!ok(result)) throw fail(result, '无法读取服务器上的文件内容');
  const buffer = result.stdout;
  let offset = 0;
  for (const sha of unique) {
    const newline = buffer.indexOf(10, offset);
    if (newline < 0) throw new Error('读取服务器文件时数据不完整');
    const header = buffer.subarray(offset, newline).toString('utf8');
    const match = /^([0-9a-f]+) blob (\d+)$/.exec(header);
    if (!match) throw new Error('服务器上的对象缺失或类型不对: ' + sha);
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (end > buffer.length) throw new Error('读取服务器文件时数据不完整');
    blobs.set(sha, buffer.subarray(start, end));
    offset = end + 1;
  }
  return blobs;
}

/**
 * 把一组本机文件（外加少量内存里的条目）写成一个 Git 树。
 * 文件按相对路径从 `root` 读取，不会复制到别处。
 */
export async function stageTree(repo, root, files, extra = []) {
  const indexPath = path.join(path.dirname(repo), 'index-' + randomUUID());
  const entries = [];
  try {
    if (files.length > 0) {
      const shas = await hashFiles(repo, root, files);
      for (let index = 0; index < files.length; index += 1) entries.push({ path: files[index], sha: shas[index] });
    }
    for (const item of extra) entries.push({ path: item.path, sha: await blobFor(repo, item.content) });

    if (entries.length === 0) {
      const empty = await runGit(repo, ['read-tree', '--empty'], { env: { GIT_INDEX_FILE: indexPath } });
      if (!ok(empty)) throw fail(empty, '无法建立空快照');
    } else {
      const info = entries.map(entry => `100644 blob ${entry.sha}\t${entry.path}`).join('\n') + '\n';
      const staged = await runGit(repo, ['update-index', '--add', '--index-info'], {
        input: info,
        env: { GIT_INDEX_FILE: indexPath },
      });
      if (!ok(staged)) throw fail(staged, '无法建立文件索引');
    }
    const tree = await runGit(repo, ['write-tree'], { env: { GIT_INDEX_FILE: indexPath } });
    if (!ok(tree)) throw fail(tree, '无法写入快照');
    return { tree: String(tree.stdout).trim(), entries };
  } finally {
    try {
      fs.unlinkSync(indexPath);
    } catch {
      /* 临时索引不存在就算了 */
    }
  }
}

const ASCII_PATH = /^[\x20-\x7e]+$/;

/**
 * 把文件内容写成 blob，返回与 `files` 同序的 blob id。
 *
 * 纯 ASCII 路径走 `--stdin-paths` 批量处理（一次进程）。
 * 含非 ASCII 字符的路径改为把内容从 stdin 喂给 git：不同平台、不同 locale 下
 * Git 对路径参数的编码解释并不一致，而 blob 内容不受这个影响。
 */
async function hashFiles(repo, root, files) {
  const shas = new Array(files.length);
  const batch = [];
  const single = [];
  files.forEach((file, index) => (ASCII_PATH.test(file) ? batch : single).push({ file, index }));

  if (batch.length) {
    const result = await runGit(root, ['hash-object', '-w', '--stdin-paths'], {
      input: batch.map(item => item.file).join('\n') + '\n',
      timeoutMs: 600_000,
      // 工作目录是 DSH 数据目录（不是 Git 仓库），对象要写进同步仓库
      env: { GIT_DIR: path.resolve(repo) },
    });
    if (!ok(result)) throw fail(result, '无法写入本机文件内容');
    const lines = String(result.stdout).trim().split('\n');
    if (lines.length !== batch.length) throw new Error('写入文件内容时数量对不上, 请重试');
    batch.forEach((item, position) => {
      shas[item.index] = lines[position];
    });
  }

  for (const item of single) {
    const bytes = fs.readFileSync(path.join(root, item.file));
    const result = await runGit(repo, ['hash-object', '-w', '--stdin'], { input: bytes, timeoutMs: 600_000 });
    if (!ok(result)) throw fail(result, '无法写入本机文件内容: ' + item.file);
    shas[item.index] = String(result.stdout).trim();
  }
  return shas;
}

/** 把一个额外的小文件（state.json）也放进树里。 */
async function blobFor(repo, content) {
  const result = await runGit(repo, ['hash-object', '-w', '--stdin'], { input: content });
  if (!ok(result)) throw fail(result, '无法写入版本文件');
  return String(result.stdout).trim();
}

/** 用一棵树创建根提交（没有父提交，天然是"单快照"）。 */
export async function commitTree(repo, tree, message) {
  const result = await runGit(repo, ['commit-tree', tree, '-m', message]);
  if (!ok(result)) throw fail(result, '无法创建快照提交');
  return String(result.stdout).trim();
}

/**
 * 推送 main。`expected` 是"我以为服务器上的提交 id"：
 * - 传 null 表示服务器上还没有这个分支；
 * - 传具体 id 时，如果服务器已经变了，Git 会拒绝，绝不会覆盖。
 */
export async function pushMain(repo, config, commit, expected) {
  const lease = 'refs/heads/' + config.branch + ':' + (expected || '');
  const result = await runGit(
    repo,
    ['push', '--porcelain', '--force-with-lease=' + lease, 'origin', commit + ':refs/heads/' + config.branch],
    { timeoutMs: 600_000 },
  );
  if (ok(result)) return { pushed: true };
  const described = describeGitFailure(result);
  if (described.kind === 'stale') return { pushed: false, stale: true, error: failureText(described) };
  return { pushed: false, error: failureText(described), git: described };
}
