/**
 * 同步引擎：只有两个动作——上传、下载。
 *
 * 服务器（一个 `git init --bare` 仓库的 main 分支）是唯一权威：
 * - 上传 = 把本机快照写成一个根提交，用 `--force-with-lease` 推上去；
 * - 下载 = 取回 main 上的快照，按文件写回本机。
 *
 * 不做合并、不建分支、不保留历史：每次上传都重建单快照提交，仓库体积等于当前内容。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from './fs-util.js';
import { contentKind, listCandidateFiles } from './scope.js';
import { pickHighestGeneration, sessionIdOfLogPath } from './session-path.js';
import { validateSessionLog, sessionContentDigest } from './sessions.js';
import { describeFiles } from './session-labels.js';
import { activeTasks } from './active-tasks.js';
import { contentDigest, diffManifests, scanSnapshot, toManifest } from './snapshot.js';
import { applyIncoming } from './apply.js';
import { RecoveryStore } from './recovery.js';
import { failureText } from './git-failure.js';
import { runGit, isOk } from './git.js';
import {
  STATE_FILE,
  commitTree,
  ensureRepo,
  fetchRemote,
  listTree,
  pushMain,
  readBlobs,
  readState,
  remoteHead,
  stageTree,
} from './git-repo.js';

const LOCAL_STATE = '.ownsync/state.json';
const STATE_FORMAT = 1;
/** 删除达到这个数量就要用户确认一次。 */
const BULK_DELETE_MIN = 3;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_OBJECTS = 64;

function deviceName() {
  try {
    return os.hostname() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function statePath(home) {
  return path.join(home, LOCAL_STATE);
}

function readLocalState(home) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(home), 'utf8'));
    if (value && value.format === STATE_FORMAT && typeof value === 'object')
      return { pending: [], manifest: {}, version: 0, baseSha: null, ...value };
  } catch {
    /* 没有或损坏都当作"从未同步过" */
  }
  return { format: STATE_FORMAT, version: 0, baseSha: null, manifest: {}, pending: [], updatedAt: 0 };
}

function writeLocalState(home, value) {
  atomicJson(statePath(home), { format: STATE_FORMAT, ...value, updatedAt: Date.now() });
}

function missingPaths(manifest, entries) {
  const present = new Set(entries.map(entry => entry.path));
  return Object.keys(manifest || {}).filter(file => contentKind(file) && !present.has(file));
}

export class SyncEngine {
  /**
   * @param {{home: string, ctx?: any, log?: Function, config?: object}} options
   */
  constructor({ home, ctx = null, log = () => {}, config = {} }) {
    this.home = home;
    this.ctx = ctx;
    this.log = log;
    this.cfg = { branch: 'main', ...config };
    this.recovery = new RecoveryStore(home);
    this.busy = null;
    this.lastResult = null;
  }

  /** 本地状态（不联网）。 */
  status() {
    const state = readLocalState(this.home);
    const backups = this.recovery.list();
    const changes = this.localChanges();
    return {
      configured: Boolean(this.cfg.remote),
      remote: this.cfg.remote || '',
      branch: this.cfg.branch || 'main',
      autoUpload: this.cfg.autoUpload !== false,
      autoDownload: this.cfg.autoDownload !== false,
      local: {
        version: state.version || 0,
        baseSha: state.baseSha || null,
        updatedAt: state.updatedAt || 0,
        pending: Array.isArray(state.pending) ? state.pending : [],
      },
      localChanges: changes,
      returnTo: state.returnTo || null,
      backups: { count: backups.length, size: this.recovery.size() },
      busy: Boolean(this.busy),
      lastResult: this.lastResult,
    };
  }

  /** 连一次服务器读远端版本（只读）。与上传/下载共用一把锁，避免 git 并发撞锁。 */
  async check() {
    if (this.busy) return { skipped: 'busy' };
    return this.run('检查', () => this.performCheck());
  }

  async performCheck() {
    if (!this.cfg.remote) return { error: '还没有填写同步仓库地址' };
    try {
      const repo = await ensureRepo(this.home, this.cfg);
      await fetchRemote(repo, this.cfg);
      const sha = await remoteHead(repo, this.cfg.branch);
      const remote = await readState(repo, sha);
      const local = readLocalState(this.home);
      const changes = this.localChanges();
      return {
        remoteSha: sha,
        remoteEmpty: !sha,
        remoteVersion: remote?.version ?? 0,
        remoteUpdatedAt: remote?.updatedAt ?? 0,
        remoteDevice: remote?.device ?? '',
        localVersion: local.version || 0,
        localDirty: changes.count > 0,
        localChanges: changes,
        inSync: Boolean(sha) && sha === local.baseSha && (local.pending || []).length === 0,
      };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  }

  /**
   * 本机自上次同步以来有没有改动。
   *
   * 先按 size + mtime 快速筛出"可能变了"的文件，再用内容指纹确认：
   * 宿主经常把同样的内容原样重写一遍（只改 mtime），那不算用户改动。
   * 只覆盖会话日志和工作区登记，附件不参与。
   */
  localChanges() {
    const state = readLocalState(this.home);
    const recorded = state.stats || {};
    const manifest = state.manifest || {};
    let sessionFiles = [];
    let workspace = null;
    try {
      const listed = listCandidateFiles(this.home);
      sessionFiles = [...pickHighestGeneration(listed.sessions).values()].map(item => item.file);
      workspace = listed.workspace;
    } catch {
      return { count: 1, unknown: true, sample: [] };
    }

    const paths = new Set(sessionFiles);
    if (workspace) paths.add(workspace);
    const changed = [];
    const same = (left, stat) => left && left[0] === stat.size && Math.abs(left[1] - stat.mtimeMs) <= 1;
    for (const file of paths) {
      let stat;
      try {
        stat = fs.statSync(path.join(this.home, file));
      } catch {
        changed.push(file);
        continue;
      }
      if (same(recorded[file], stat)) continue;
      if (same(this._verifiedStats?.get(file), stat)) continue;
      // size/mtime 变了：再用内容确认，原样重写不算改动
      if (this.sameContent(file, manifest[file])) {
        if (!this._verifiedStats) this._verifiedStats = new Map();
        this._verifiedStats.set(file, [stat.size, stat.mtimeMs]);
        continue;
      }
      // 会话：只有宿主追加的 session/end-seed 标记时，不算改动
      if (contentKind(file) === 'sessions') {
        const known = recorded[file]?.[2];
        if (known) {
          try {
            const digest = sessionContentDigest(fs.readFileSync(path.join(this.home, file)));
            if (digest && digest === known) {
              if (!this._verifiedStats) this._verifiedStats = new Map();
              this._verifiedStats.set(file, [stat.size, stat.mtimeMs]);
              continue;
            }
          } catch {
            /* 读不出来就按改动处理 */
          }
        }
      }
      // 空白会话（只有 header）不算改动
      if (contentKind(file) === 'sessions' && this.isBlankSession(file)) continue;
      changed.push(file);
    }
    for (const file of Object.keys(recorded)) {
      if (contentKind(file) !== 'sessions' && contentKind(file) !== 'workspaces') continue;
      if (!paths.has(file)) changed.push(file);
    }
    const sample = changed.slice(0, 5);
    return { count: changed.length, sample, details: describeFiles(this.home, sample) };
  }

  /** 文件当前内容是否与上次同步记录的内容一致。 */
  sameContent(file, expected) {
    if (!expected) return false;
    try {
      const bytes = fs.readFileSync(path.join(this.home, file));
      return contentDigest(file, bytes) === expected;
    } catch {
      return false;
    }
  }

  /** 只有 header、没有事件的会话文件（新建但还没开始用）。 */
  isBlankSession(file) {
    try {
      const checked = validateSessionLog(fs.readFileSync(path.join(this.home, file)));
      return checked.ok && checked.rows.length <= 1;
    } catch {
      return false;
    }
  }

  /** 会话文件相对上次同步是不是只多了 DSH 追加的 end-seed 标记。 */
  isMarkerOnlyChange(file, state) {
    if (contentKind(file) !== 'sessions') return false;
    const known = state.stats?.[file]?.[2];
    if (!known) return false;
    try {
      const digest = sessionContentDigest(fs.readFileSync(path.join(this.home, file)));
      return Boolean(digest) && digest === known;
    } catch {
      return false;
    }
  }

  /** 相对上次同步真正有意义的改动（过滤掉只多了标记的会话）。 */
  meaningfulDiff(state, snapshot) {
    const diff = diffManifests(state.manifest || {}, toManifest(snapshot.entries));
    const files = [...diff.added, ...diff.modified, ...diff.deleted].filter(
      file => !this.isMarkerOnlyChange(file, state),
    );
    return { ...diff, changed: files.length, files };
  }

  /** 快照里的 size/mtime 是否仍与磁盘一致；返回第一个变化的路径，一致返回 null。 */
  firstChangedPath(entries) {
    for (const entry of entries) {
      try {
        const stat = fs.statSync(path.join(this.home, entry.path));
        if (stat.size !== entry.size) return entry.path;
        if (!Number.isFinite(entry.mtimeMs) || Math.abs(stat.mtimeMs - entry.mtimeMs) > 1) return entry.path;
      } catch {
        return entry.path;
      }
    }
    return null;
  }

  /** 用扫描时的 size/mtime 记录统计值，避免把上传过程中的新写入误记为已同步。 */
  statsFromEntries(entries) {
    const stats = {};
    for (const entry of entries) {
      if (!Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs)) continue;
      if (entry.kind === 'sessions' && entry.normalized) {
        stats[entry.path] = [entry.size, entry.mtimeMs, entry.normalized];
      } else {
        stats[entry.path] = [entry.size, entry.mtimeMs];
      }
    }
    return stats;
  }

  /** 当前本地文件的轻量签名（路径 + size + mtime），自动上传用它判断改动是否稳定。 */
  changeSignature() {
    const parts = [];
    try {
      const listed = listCandidateFiles(this.home);
      const files = [...pickHighestGeneration(listed.sessions).values()].map(item => item.file);
      if (listed.workspace) files.push(listed.workspace);
      for (const file of files.sort()) {
        try {
          const stat = fs.statSync(path.join(this.home, file));
          parts.push(file + ':' + stat.size + ':' + stat.mtimeMs);
        } catch {
          parts.push(file + ':missing');
        }
      }
    } catch {
      return null;
    }
    return createHash('sha256').update(parts.join('\n')).digest('hex');
  }

  /** 记录一批文件当前的 size/mtime（会话额外记内容指纹），供下次快速判断"有没有改动"。 */
  statsOf(paths) {
    const stats = {};
    for (const file of paths) {
      try {
        const stat = fs.statSync(path.join(this.home, file));
        if (contentKind(file) === 'sessions') {
          const digest = sessionContentDigest(fs.readFileSync(path.join(this.home, file)));
          stats[file] = [stat.size, stat.mtimeMs, digest || ''];
        } else {
          stats[file] = [stat.size, stat.mtimeMs];
        }
      } catch {
        /* 文件已经不在了 */
      }
    }
    return stats;
  }

  /** 同一时间只允许一个动作。 */
  async run(action, task) {
    if (this.busy) return { error: 'busy', message: '正在' + this.busy + '，请等它结束' };
    this.busy = action;
    const started = Date.now();
    try {
      const result = await task();
      this.lastResult = { action, at: Date.now(), ...result };
      return { ...result, durationMs: Date.now() - started };
    } catch (error) {
      const message = error?.git ? failureText(error.git) : String(error?.message || error);
      this.log('error', action + ' 失败：' + message);
      this.lastResult = { action, at: Date.now(), error: message };
      return { error: 'failed', message };
    } finally {
      this.busy = null;
    }
  }

  upload(options = {}) {
    return this.run('上传', () => this.performUpload(options));
  }

  download(options = {}) {
    return this.run('下载', () => this.performDownload(options));
  }

  /** 扫描时给"正在写入"的会话一点时间稳定下来。 */
  async scan(attempts = 3) {
    let snapshot = scanSnapshot(this.home);
    for (let attempt = 0; attempt < attempts && snapshot.invalidSessions.length > 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      snapshot = scanSnapshot(this.home);
    }
    return snapshot;
  }

  async performUpload(options) {
    if (!this.cfg.remote) return { error: 'unconfigured', message: '还没有填写同步仓库地址' };
    const state = readLocalState(this.home);
    if ((state.pending || []).length)
      return {
        error: 'pending-sessions',
        message:
          '这台电脑还有 ' + state.pending.length + ' 个会话没写回来。先「下载」并重启 DSH，让它们落地后再上传。',
      };

    const repo = await ensureRepo(this.home, this.cfg);
    const fetched = await fetchRemote(repo, this.cfg);
    const remoteSha = fetched.empty ? null : await remoteHead(repo, this.cfg.branch);
    const remoteState = await readState(repo, remoteSha);
    const remoteVersion = remoteState?.version ?? 0;

    if ((state.baseSha || null) !== (remoteSha || null))
      return {
        error: 'stale',
        message: remoteSha
          ? '服务器已经是 v' + remoteVersion + '，本机还停在 v' + (state.version || 0) + '。请先点「下载」。'
          : '服务器上还没有内容，但本机记录里有旧基线。请先「下载」一次再上传。',
        remoteVersion,
      };

    const snapshot = await this.scan();
    if (snapshot.invalidSessions.length)
      return {
        error: 'session-busy',
        message:
          '有会话正在写入，等内容稳定后再上传：' +
          snapshot.invalidSessions.map(item => item.path).join('、'),
        sessions: snapshot.invalidSessions,
      };

    const deletions = missingPaths(state.manifest, snapshot.entries);
    const manifestSize = Object.keys(state.manifest || {}).length;
    const meaningful = this.meaningfulDiff(state, snapshot);
    if (deletions.length === 0 && meaningful.changed === 0)
      return { upToDate: true, version: state.version || remoteVersion, changedCount: 0, changedFiles: [] };
    const bulkDelete = deletions.length >= BULK_DELETE_MIN || (deletions.length > 0 && deletions.length * 2 >= manifestSize);
    if (bulkDelete && options.confirm !== 'bulk-delete')
      return {
        needsConfirm: 'bulk-delete',
        message:
          '这次上传会让服务器删掉 ' +
          deletions.length +
          ' 个本机已经不存在的文件。确认后其他电脑下次下载也会删除它们；删除前会把服务器上的原件备份到本机。',
        deletions,
      };

    // 删除项在服务器上还有旧版本，推之前先取回来存一份
    if (deletions.length && remoteSha) {
      try {
        const tree = await listTree(repo, remoteSha);
        const wanted = tree.filter(entry => deletions.includes(entry.path));
        if (wanted.length) {
          const blobs = await readBlobs(repo, wanted.map(entry => entry.sha));
          this.recovery.save(
            'upload-delete',
            wanted.map(entry => ({ path: entry.path, bytes: blobs.get(entry.sha) })).filter(item => item.bytes),
          );
        }
      } catch (error) {
        this.log('warn', '备份待删除内容失败（不影响上传）：' + String(error?.message || error));
      }
    }

    // 扫描后、提交前，本地文件可能又被写入（用户刚好发了一条消息）。
    // 推之前确认一遍；变了就放弃本轮，交给下一轮自动上传或手动上传。
    const drifted = this.firstChangedPath(snapshot.entries);
    if (drifted)
      return { error: 'changed-during-upload', message: '上传过程中本地内容发生变化，已跳过这次上传：' + drifted };

    const version = remoteVersion + 1;
    const files = snapshot.entries.map(entry => entry.path);
    const { tree } = await stageTree(repo, this.home, files, [
      {
        path: STATE_FILE,
        content:
          JSON.stringify({ format: 1, version, updatedAt: Date.now(), device: deviceName() }) + '\n',
      },
    ]);
    const afterStage = this.firstChangedPath(snapshot.entries);
    if (afterStage)
      return { error: 'changed-during-upload', message: '上传过程中本地内容发生变化，已跳过这次上传：' + afterStage };
    const commit = await commitTree(repo, tree, 'ownsync v' + version);
    const pushed = await pushMain(repo, this.cfg, commit, remoteSha);
    if (!pushed.pushed) return { error: pushed.stale ? 'stale' : 'push-failed', message: pushed.error };

    writeLocalState(this.home, {
      version,
      baseSha: commit,
      remote: this.cfg.remote,
      branch: this.cfg.branch,
      manifest: toManifest(snapshot.entries),
      stats: this.statsFromEntries(snapshot.entries),
      pending: [],
    });
    this._verifiedStats = null;
    this.recovery.prune(30);

    return {
      uploaded: true,
      version,
      files: files.length,
      deleted: deletions.length,
      changedCount: meaningful.changed,
      changedFiles: describeFiles(this.home, meaningful.files.slice(0, 10)),
      skipped: snapshot.skipped,
      commit,
    };
  }

  async performDownload(options) {
    if (!this.cfg.remote) return { error: 'unconfigured', message: '还没有填写同步仓库地址' };
    const repo = await ensureRepo(this.home, this.cfg);
    const fetched = await fetchRemote(repo, this.cfg);
    if (fetched.empty) return { error: 'empty-remote', message: '服务器上还没有内容，先在另一台电脑上传一次。' };
    const remoteSha = await remoteHead(repo, this.cfg.branch);
    if (!remoteSha) return { error: 'empty-remote', message: '服务器上还没有内容。' };

    const remoteState = await readState(repo, remoteSha);
    const remoteVersion = remoteState?.version ?? 0;
    const state = readLocalState(this.home);
    const pending = new Set(state.pending || []);

    if (remoteSha === state.baseSha && pending.size === 0) return { upToDate: true, version: remoteVersion };

    const snapshot = await this.scan();
    const diff = this.meaningfulDiff(state, snapshot);
    // 第一次下载（本机还没有基线）时，本机已有的内容只是"额外文件"，不需要确认
    const dirty = state.baseSha ? diff.files.filter(file => !pending.has(file)) : [];
    if (dirty.length > 0 && options.confirm !== 'overwrite')
      return {
        needsConfirm: 'overwrite',
        message:
          '本机有 ' +
          dirty.length +
          ' 处还没上传的改动。下载会用服务器上的内容覆盖它们（覆盖前会把原件备份）。确认继续？',
        dirty,
      };

    const listing = (await listTree(repo, remoteSha)).filter(
      entry => entry.type === 'blob' && entry.path !== STATE_FILE && contentKind(entry.path),
    );

    const sizes = await this.sizesOf(repo, listing.map(entry => entry.sha));
    const incoming = [];
    let group = [];
    let groupBytes = 0;
    const flush = async () => {
      if (!group.length) return;
      const blobs = await readBlobs(repo, group.map(entry => entry.sha));
      for (const entry of group) {
        const data = blobs.get(entry.sha);
        if (!data) throw new Error('服务器上的文件内容缺失：' + entry.path);
        incoming.push({ path: entry.path, kind: contentKind(entry.path), bytes: data });
      }
      group = [];
      groupBytes = 0;
    };
    for (const entry of listing) {
      const size = sizes.get(entry.sha) || 0;
      if (group.length >= MAX_CHUNK_OBJECTS || groupBytes + size > MAX_CHUNK_BYTES) await flush();
      group.push(entry);
      groupBytes += size;
    }
    await flush();

    const incomingPaths = new Set(listing.map(entry => entry.path));
    const removals = Object.keys(state.manifest || {}).filter(file => contentKind(file) && !incomingPaths.has(file));
    const applied = await applyIncoming(this, incoming, { removals, force: true });

    const pendingNext = [...new Set([...applied.deferred, ...applied.failures].map(item => item.path))];
    const appliedSessions = applied.applied
      .filter(item => contentKind(item.path) === 'sessions')
      .map(item => sessionIdOfLogPath(item.path))
      .filter(Boolean);
    writeLocalState(this.home, {
      version: remoteVersion,
      baseSha: remoteSha,
      remote: this.cfg.remote,
      branch: this.cfg.branch,
      manifest: Object.fromEntries(incoming.map(item => [item.path, contentDigest(item.path, item.bytes)])),
      stats: this.statsOf(incoming.map(item => item.path)),
      pending: pendingNext,
    });
    this._verifiedStats = null;
    this.recovery.prune(30);

    return {
      downloaded: true,
      version: remoteVersion,
      applied: applied.applied.length,
      appliedSessions,
      skipped: applied.skipped.length,
      removed: applied.removed.length,
      deferred: applied.deferred,
      failures: applied.failures,
      restartRequired: applied.restartRequired || pendingNext.length > 0,
    };
  }

  /**
   * 启动时把上次没写回的会话补上。
   *
   * 宿主刚起来、客户端还没连上时，会话还没有被 Agent 占用，这时候写最稳。
   * 连试几次（客户端随时可能把写入权抢走），成功就记下"回到哪个会话"。
   */
  async startupApply() {
    const state = readLocalState(this.home);
    const pending = (state.pending || []).filter(file => contentKind(file) === 'sessions');
    if (!pending.length) return { skipped: 'no-pending' };
    if (!this.cfg?.remote) return { skipped: 'unconfigured' };

    const delays = [0, 600, 1600];
    let waited = 0;
    for (const delay of delays) {
      if (delay > waited) {
        await new Promise(resolve => setTimeout(resolve, delay - waited));
        waited = delay;
      }
      let result = null;
      try {
        result = await this.retryPending();
      } catch (error) {
        this.log('warn', '启动补写失败：' + String(error?.message || error));
        return { error: String(error?.message || error) };
      }
      const remaining = result?.remaining || [];
      if (!result?.error && remaining.length === 0) {
        const id = sessionIdOfLogPath(pending[0]);
        if (id) writeLocalState(this.home, { ...readLocalState(this.home), returnTo: id });
        this.log('info', '启动补写完成：' + (result?.applied || 0) + ' 个会话已写回本机');
        return { applied: result?.applied || 0, returnTo: id || null };
      }
    }
    this.log('warn', '启动补写没能完成：会话仍被占用，保留 pending');
    return { skipped: 'still-held' };
  }

  /**
   * 宿主启动时的同步：先补写上次没写回的会话，再检查服务器。
   * 服务器领先且本机干净时直接下载——此时客户端通常还没连上，会话没有被占用，
   * 写回不需要重启。
   */
  async startupSync() {
    if (this.cfg.autoDownload === false) return { skipped: 'auto-download-off' };
    const before = readLocalState(this.home);
    if ((before.pending || []).length) {
      const applied = await this.startupApply().catch(error => ({ error: String(error?.message || error) }));
      if (applied?.error || applied?.skipped === 'still-held') return { skipped: 'pending' };
    }
    if (!this.cfg?.remote) return { skipped: 'unconfigured' };
    if (this.busy) return { skipped: 'busy' };

    const checked = await this.check();
    if (!checked || checked.error || checked.skipped) return { skipped: 'check' };
    if (checked.remoteEmpty) return { skipped: 'empty' };
    if (checked.inSync) return { skipped: 'in-sync' };

    const state = readLocalState(this.home);
    if ((state.pending || []).length) return { skipped: 'pending' };
    if ((this.localChanges().count || 0) > 0) return { skipped: 'local-dirty' };
    if (activeTasks(this.ctx).active) return { skipped: 'active-tasks' };

    this.log('info', '启动检查：服务器领先（v' + (checked.remoteVersion || 0) + '），开始自动下载');
    return this.download({});
  }

  /** 清掉"补写完成后回到哪个会话"的标记。 */
  clearReturnTo() {
    writeLocalState(this.home, { ...readLocalState(this.home), returnTo: null });
    return { cleared: true };
  }

  /** 记下重启后要回到哪个会话。 */
  setReturnTo(sessionId) {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return { returnTo: null };
    writeLocalState(this.home, { ...readLocalState(this.home), returnTo: id });
    return { returnTo: id };
  }

  /** 只重试 pending 里的会话，不重新跑整轮下载。 */
  async retryPending() {
    const state = readLocalState(this.home);
    const pending = (state.pending || []).filter(file => contentKind(file) === 'sessions');
    if (!pending.length) return { retried: 0, applied: 0, remaining: [] };
    if (!state.baseSha)
      return { error: 'no-base', message: '缺少服务器基线，无法单独重试；请点一次「下载」。' };

    const repo = await ensureRepo(this.home, this.cfg);
    const incoming = [];
    const missing = [];
    for (const file of pending) {
      const result = await runGit(repo, ['cat-file', '-p', state.baseSha + ':' + file], { binary: true });
      if (!isOk(result)) {
        missing.push(file);
        continue;
      }
      incoming.push({ path: file, kind: 'sessions', bytes: result.stdout });
    }

    const applied = await applyIncoming(this, incoming, { force: true });
    const remaining = [
      ...new Set([
        ...missing,
        ...applied.deferred.map(item => item.path),
        ...applied.failures.map(item => item.path),
      ]),
    ];
    writeLocalState(this.home, {
      ...state,
      pending: remaining,
      stats: { ...(state.stats || {}), ...this.statsOf(incoming.map(item => item.path)) },
    });
    return {
      retried: incoming.length,
      applied: applied.applied.length,
      remaining,
      deferred: applied.deferred,
      failures: applied.failures,
    };
  }

  /** 读取一批对象的字节数，用来切成内存可控的批次。 */
  async sizesOf(repo, shas) {
    const unique = [...new Set(shas)];
    if (!unique.length) return new Map();
    const result = await runGit(repo, ['cat-file', '--batch-check'], { input: unique.join('\n') + '\n' });
    const sizes = new Map();
    if (!isOk(result)) return sizes;
    for (const line of String(result.stdout).trim().split('\n')) {
      const match = /^([0-9a-f]+) (\w+) (\d+)$/.exec(line.trim());
      if (match) sizes.set(match[1], Number(match[3]));
    }
    return sizes;
  }
}
