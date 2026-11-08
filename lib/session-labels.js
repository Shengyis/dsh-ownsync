/**
 * 把"有改动的文件"翻译成给人看的标签：工作区 · 会话标题。
 *
 * 数据来源（只读，不参与同步）：
 * - `storages/workspace.json`：tables.workspaces[*].title / sessionIds
 * - `storages/session_projcache/sessions/<id>.json`：record.rows.title.val
 */
import fs from 'node:fs';
import path from 'node:path';
import { contentKind } from './scope.js';
import { sessionIdOfLogPath } from './session-path.js';

const TITLE_CACHE = new Map();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** sessionId → 工作区标题。 */
export function workspaceTitles(home) {
  const map = new Map();
  const data = readJson(path.join(home, 'storages', 'workspace.json'));
  const workspaces = data?.tables?.workspaces;
  if (!workspaces || typeof workspaces !== 'object') return map;
  for (const item of Object.values(workspaces)) {
    const title = typeof item?.title === 'string' && item.title.trim() ? item.title.trim() : null;
    const label = title || (typeof item?.path === 'string' ? path.basename(item.path) : null);
    for (const id of item?.sessionIds || []) {
      if (typeof id === 'string') map.set(id, label || '未分组');
    }
  }
  return map;
}

/** 会话标题（来自 DSH 的投影缓存；缓存按文件 mtime 复用）。 */
export function sessionTitle(home, sessionId) {
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', sessionId + '.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = TITLE_CACHE.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.title;

  const data = readJson(file);
  const raw = data?.record?.rows?.title?.val;
  const title = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  TITLE_CACHE.set(file, { mtimeMs: stat.mtimeMs, title });
  return title;
}

/** 给一批路径生成 {path, kind, label}。 */
export function describeFiles(home, files) {
  let workspaces = null;
  return files.map(file => {
    const kind = contentKind(file);
    if (kind === 'workspaces') return { path: file, kind, label: '工作区登记' };
    if (kind === 'attachments') return { path: file, kind, label: '附件 · ' + path.basename(file) };

    const sessionId = sessionIdOfLogPath(file);
    if (!sessionId) return { path: file, kind, label: path.basename(file) };

    if (!workspaces) workspaces = workspaceTitles(home);
    const workspace = workspaces.get(sessionId) || '未分组';
    const short = sessionId.replace(/^session-/, '').slice(0, 8);
    const title = sessionTitle(home, sessionId) || '会话 ' + short;
    return { path: file, kind, sessionId, label: workspace + ' · ' + title };
  });
}
