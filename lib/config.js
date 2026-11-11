/**
 * 配置：只放在本机数据目录的 `ownsync.json`，不参与同步。
 *
 * 字段只有三个：仓库地址、分支、自动上传开关（存在本机，不参与同步）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './fs-util.js';

export const CONFIG_FILE = 'ownsync.json';

export const DEFAULT_CONFIG = {
  remote: '',
  branch: 'main',
  autoUpload: true,
};

/** scp 风格地址（git@host:path）也算合法。 */
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;

/**
 * 校验并规范化仓库地址。
 * 拒绝带明文密码的地址：凭据应该交给 SSH key 或系统凭据管理器。
 */
export function normalizeRemote(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/\s/.test(text)) throw new Error('仓库地址不能包含空格或换行');
  const credentials = /^[a-z]+:\/\/[^/@\s]+:[^/@\s]+@/i.test(text);
  if (credentials) throw new Error('仓库地址里不要写用户名和密码, 请使用 SSH 密钥或系统的 Git 凭据');
  const scheme = /^([a-z]+):\/\//i.exec(text);
  if (scheme) {
    if (!['http', 'https', 'ssh', 'git', 'file'].includes(scheme[1].toLowerCase()))
      throw new Error('不支持的地址协议: ' + scheme[1]);
    return text;
  }
  if (SCP_LIKE.test(text)) return text;
  if (path.isAbsolute(text)) return text;
  throw new Error('仓库地址需要是 https://, ssh://, git@host:path 或服务器上的绝对路径');
}

export function normalizeBranch(value) {
  const text = String(value ?? '').trim() || DEFAULT_CONFIG.branch;
  if (!/^[A-Za-z0-9._\/-]+$/.test(text) || text.includes('..')) throw new Error('分支名不合法');
  return text;
}

/** 读取配置；文件不存在或损坏时返回默认值，并把错误交给调用方展示。 */
export function readConfig(home) {
  const file = path.join(home, CONFIG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { config: { ...DEFAULT_CONFIG }, error: null };
    return { config: { ...DEFAULT_CONFIG }, error: '读取配置失败: ' + error.message };
  }
  try {
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return {
      config: {
        remote: typeof parsed.remote === 'string' ? parsed.remote : '',
        branch: normalizeBranch(parsed.branch),
        autoUpload: parsed.autoUpload !== false,
      },
      error: null,
    };
  } catch (error) {
    return { config: { ...DEFAULT_CONFIG }, error: '配置文件格式不正确: ' + error.message };
  }
}

/** 合并保存（未知字段保留，方便以后加）。 */
export function writeConfig(home, patch) {
  const file = path.join(home, CONFIG_FILE);
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    current = {};
  }
  const next = {
    ...current,
    ...(patch.remote !== undefined && { remote: normalizeRemote(patch.remote) }),
    ...(patch.branch !== undefined && { branch: normalizeBranch(patch.branch) }),
    ...(patch.autoUpload !== undefined && { autoUpload: patch.autoUpload !== false }),
  };
  // 1.2.0 留下的「自动下载」开关，保存时一并清掉
  delete next.autoDownload;
  atomicJson(file, next);
  return {
    remote: next.remote || '',
    branch: next.branch || DEFAULT_CONFIG.branch,
    autoUpload: next.autoUpload !== false,
  };
}
