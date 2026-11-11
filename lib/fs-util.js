/**
 * 文件系统工具：路径消毒、原子写入、摘要。
 *
 * 同步器碰到的每个路径都来自"别的地方"（配置、远端仓库、会话日志），
 * 所以一律先过 `safePath`：拒绝绝对路径、`..`、盘符、反斜杠和符号链接。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const REPLACE_TEMP_SUFFIX = '.ownsync-tmp';

/** SHA-256 摘要（十六进制）。 */
export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** 流式计算文件 SHA-256，避免把大附件整个读进内存。 */
export function sha256File(file) {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let read = 0;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 读文件；不存在返回 null。 */
export function readIfExists(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 解析相对路径并拒绝一切越界可能。
 * 不跟随符号链接：只要路径中任意一段是链接就报错。
 */
export function safePath(root, relative) {
  if (
    typeof relative !== 'string' ||
    !relative ||
    relative.includes('\0') ||
    relative.includes('\\') ||
    relative.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':')) ||
    path.isAbsolute(relative)
  )
    throw new Error('无效的文件路径: ' + relative);
  const base = path.resolve(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不支持符号链接: ' + relative);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

/** 原子写入：先写临时文件，再 rename（父目录不存在时自动建）。 */
export function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', flush: true });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function atomicJson(file, value) {
  atomicBytes(file, Buffer.from(JSON.stringify(value, null, 2) + '\n', 'utf8'));
}

/**
 * 覆盖一个已存在的文件，但不暴露"写了一半"的中间状态。
 * 保留权限位；符号链接按原样写穿（用户可能把设置文件链接到别处）。
 */
export function replaceBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat?.isSymbolicLink()) {
    fs.writeFileSync(file, bytes);
    return;
  }
  const mode = stat ? stat.mode & 0o7777 : undefined;
  const temp = file + '.' + randomUUID() + REPLACE_TEMP_SUFFIX;
  try {
    fs.writeFileSync(temp, bytes, { flag: 'wx', flush: true, ...(mode !== undefined && { mode }) });
    if (mode !== undefined) fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* 删除失败也不影响抛出原始错误 */
    }
    throw error;
  }
}

/** 删除文件（不存在不报错），返回是否真的删掉了。 */
export function removeIfExists(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
