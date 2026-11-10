/**
 * 本机快照：把"要同步什么"变成一份确定的清单。
 *
 * 清单里每一项只有 `{path, kind, size, sha256}`。`sha256` 既用于判断"本机是否
 * 有未上传改动"，也用于判断附件是否被会话引用（DSH 的附件引用就是 `sha256:<hex>`）。
 *
 * 这里不做任何写入，也不调用 Git。
 */
import fs from 'node:fs';
import { digest, safePath, sha256File } from './fs-util.js';
import { pickHighestGeneration } from './session-path.js';
import { attachmentRefs, validateSessionLog, sessionContentDigest } from './sessions.js';
import { contentKind, listCandidateFiles } from './scope.js';

/** 单个附件的上限，超过就跳过并在结果里列出。 */
export const MAX_ATTACHMENT_BYTES = 256 * 1024 * 1024;

/** 键序无关的 JSON 序列化，用来判断"内容是否真的变了"。 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(key => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/**
 * 文件的内容指纹。
 * 工作区登记按"解析后的 JSON"算：DSH 只是重新排版（换行、键序）时，
 * 不应该被当成一次真实修改。
 */
export function contentDigest(path, bytes) {
  if (contentKind(path) === 'workspaces') {
    try {
      return digest(Buffer.from(canonical(JSON.parse(bytes.toString('utf8'))), 'utf8'));
    } catch {
      return digest(bytes);
    }
  }
  return digest(bytes);
}

/**
 * 扫描本机，得到要同步的文件清单。
 *
 * @returns {{
 *   entries: Array<{path: string, kind: string, size: number, sha256: string}>,
 *   skipped: Array<{path: string, size: number, reason: string}>,
 *   invalidSessions: Array<{path: string, reason: string}>,
 *   referenced: Set<string>,
 * }}
 */
export function scanSnapshot(home) {
  const { sessions, attachments, workspace } = listCandidateFiles(home);
  const entries = [];
  const skipped = [];
  const invalidSessions = [];
  const referenced = new Set();

  const selected = pickHighestGeneration(sessions);
  for (const [id, picked] of selected) {
    const full = safePath(home, picked.file);
    let bytes;
    let stat;
    try {
      stat = fs.statSync(full);
      bytes = fs.readFileSync(full);
    } catch (error) {
      invalidSessions.push({ path: picked.file, reason: 'unreadable: ' + error.message });
      continue;
    }
    const checked = validateSessionLog(bytes);
    if (!checked.ok) {
      invalidSessions.push({ path: picked.file, reason: checked.reason });
      continue;
    }
    // 只有 header、没有任何事件的空白会话不上传（新建了但还没开始用）
    if (checked.rows.length <= 1) continue;
    const header = checked.rows[0];
    if (header.id && header.id !== id) {
      invalidSessions.push({ path: picked.file, reason: 'session-id-mismatch' });
      continue;
    }
    for (const ref of attachmentRefs(bytes)) referenced.add(ref);
    entries.push({
      path: picked.file,
      kind: 'sessions',
      size: bytes.length,
      mtimeMs: stat.mtimeMs,
      sha256: digest(bytes),
      normalized: sessionContentDigest(bytes),
    });
  }

  for (const file of attachments) {
    const full = safePath(home, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      skipped.push({ path: file, size: stat.size, reason: 'attachment-too-large' });
      continue;
    }
    const sha256 = sha256File(full);
    if (!referenced.has(sha256)) continue;
    entries.push({ path: file, kind: 'attachments', size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
  }

  if (workspace) {
    const full = safePath(home, workspace);
    const stat = fs.statSync(full);
    const bytes = fs.readFileSync(full);
    entries.push({
      path: workspace,
      kind: 'workspaces',
      size: bytes.length,
      mtimeMs: stat.mtimeMs,
      sha256: contentDigest(workspace, bytes),
    });
  }

  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries, skipped, invalidSessions, referenced };
}

/** 清单 → `{path: sha256}`，用于和上次同步记录比较。 */
export function toManifest(entries) {
  const manifest = {};
  for (const entry of entries) manifest[entry.path] = entry.sha256;
  return manifest;
}

/**
 * 比较两份清单。
 * `deleted` 只表示"上次有、这次没有"；是否需要真的从仓库删掉，由调用方决定。
 */
export function diffManifests(previous = {}, current = {}) {
  const added = [];
  const modified = [];
  const deleted = [];
  for (const [file, hash] of Object.entries(current)) {
    if (!Object.hasOwn(previous, file)) added.push(file);
    else if (previous[file] !== hash) modified.push(file);
  }
  for (const file of Object.keys(previous)) if (!Object.hasOwn(current, file)) deleted.push(file);
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted, changed: added.length + modified.length + deleted.length };
}

/** 两次扫描之间本机是否变化。 */
export function hasLocalChanges(manifest, entries) {
  return diffManifests(manifest || {}, toManifest(entries)).changed > 0;
}
