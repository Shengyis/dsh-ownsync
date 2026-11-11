/**
 * 恢复记录：覆盖任何本机文件之前，先把原件存到 `.ownsync/backup/<时间>/`。
 *
 * 保存的是"文件字节"，不是软件状态：即使插件本身坏了，也能从备份目录里
 * 直接把文件拷回去。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, atomicBytes, digest, safePath } from './fs-util.js';

const BACKUP_ROOT = '.ownsync/backup';
const DEFAULT_KEEP_DAYS = 30;

function timestamp() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

export class RecoveryStore {
  constructor(home) {
    this.home = home;
    this.root = path.join(home, BACKUP_ROOT);
  }

  /** 保存一批原件；返回备份目录名。 */
  save(reason, items) {
    if (!items.length) return null;
    const name = timestamp() + '-' + digest(reason + items.map(item => item.path).join(',')).slice(0, 6);
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true });
    const stored = [];
    for (const item of items) {
      if (!item.bytes) continue;
      const target = safePath(dir, 'files/' + item.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      atomicBytes(target, item.bytes);
      stored.push({ path: item.path, size: item.bytes.length, sha256: digest(item.bytes) });
    }
    atomicJson(path.join(dir, 'record.json'), {
      format: 1,
      reason,
      createdAt: Date.now(),
      files: stored,
    });
    return name;
  }

  /** 列出所有备份（新的在前）。 */
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const recordFile = path.join(this.root, entry.name, 'record.json');
      try {
        const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
        records.push({ name: entry.name, ...record });
      } catch {
        /* 记录坏了就不列，备份文件仍在 */
      }
    }
    return records.sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
  }

  /** 备份占用的总字节数。 */
  size() {
    let total = 0;
    for (const record of this.list()) for (const file of record.files || []) total += Number(file.size) || 0;
    return total;
  }

  /** 把某个备份里的文件还原回数据目录。 */
  restore(name, relative) {
    const dir = safePath(this.root, name);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'record.json'), 'utf8'));
    const recordFile = (record.files || []).find(item => item.path === relative);
    if (!recordFile) throw new Error('这个备份里没有该文件: ' + relative);
    const bytes = fs.readFileSync(safePath(dir, 'files/' + relative));
    if (digest(bytes) !== recordFile.sha256) throw new Error('备份文件校验失败, 未还原: ' + relative);
    atomicBytes(safePath(this.home, relative), bytes);
    return { path: relative, size: bytes.length };
  }

  /** 删除超过保留天数的备份。 */
  prune(keepDays = DEFAULT_KEEP_DAYS) {
    const cutoff = Date.now() - Math.max(1, keepDays) * 24 * 60 * 60 * 1000;
    const removed = [];
    for (const record of this.list()) {
      if ((record.createdAt || 0) >= cutoff) continue;
      fs.rmSync(path.join(this.root, record.name), { recursive: true, force: true });
      removed.push(record.name);
    }
    return removed;
  }

  /** 全部删除（用户在界面上主动清理时调用）。 */
  clear() {
    let entries;
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      fs.rmSync(path.join(this.root, entry.name), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }
}
