/**
 * 同步范围：只认三类内容。
 *
 *   sessions/**        会话日志（只取每个会话的最高代际）
 *   storages/workspace.json  工作区登记（标题、顺序、归属）
 *   attachments/**     聊天附件（只传被会话日志引用到的）
 *
 * 其余一切（设置、插件清单、凭据、缓存、日志、项目文件夹）都不在同步范围内。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sessionIdOfLogPath } from './session-path.js';

export const ATTACHMENT_PREFIX = 'attachments/';
export const WORKSPACE_FILE = 'storages/workspace.json';

/** 统一成 `/` 分隔的相对路径。 */
export function normalizeRelative(file) {
  return String(file ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
}

/**
 * 文件属于哪个同步类别；不在同步范围内返回 null。
 * 注意 `sessions/` 下只有会话日志算数，`session.lock` 之类不算。
 */
export function contentKind(file) {
  const value = normalizeRelative(file);
  if (sessionIdOfLogPath(value)) return 'sessions';
  if (value === WORKSPACE_FILE) return 'workspaces';
  if (value.startsWith(ATTACHMENT_PREFIX) && value.length > ATTACHMENT_PREFIX.length) return 'attachments';
  return null;
}

/** 系统垃圾文件，任何目录里都不该被同步。 */
const OS_JUNK = /(^|\/)(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._.+)$/i;

/** 会话目录里的锁与临时文件。 */
const SESSION_NOISE = /(?:^|\/)(?:session\.lock|.*\.(?:tmp|lock))$/i;

function isNoise(file) {
  const value = normalizeRelative(file);
  return OS_JUNK.test(value) || SESSION_NOISE.test(value) || value.endsWith('.ownsync-tmp');
}

function walk(root, prefix, output, accept) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return output;
    throw error;
  }
  for (const entry of entries) {
    const relative = prefix + '/' + entry.name;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(path.join(root, entry.name), relative, output, accept);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isNoise(relative)) continue;
    if (accept(relative)) output.push(relative);
  }
  return output;
}

/**
 * 列出本机所有候选文件（尚未判断附件是否被引用）。
 * 只走 `sessions/`、`attachments/` 和 `storages/workspace.json` 三个位置，
 * 不会遍历整个数据目录。
 */
export function listCandidateFiles(home) {
  const sessions = walk(
    path.join(home, 'sessions'),
    'sessions',
    [],
    file => Boolean(sessionIdOfLogPath(file)),
  );
  const attachments = walk(path.join(home, 'attachments'), 'attachments', [], () => true);
  const workspaceFile = path.join(home, 'storages', 'workspace.json');
  const workspace = fs.existsSync(workspaceFile) && fs.statSync(workspaceFile).isFile() ? WORKSPACE_FILE : null;
  return { sessions, attachments, workspace };
}
