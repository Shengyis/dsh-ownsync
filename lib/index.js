/**
 * dsh-ownsync —— 宿主端入口。
 *
 * 只做一件事：把本机的「工作区 + 会话 + 被引用的聊天附件」上传到自建的
 * Git 仓库，或者从仓库取回。没有自动同步、没有分支、没有合并。
 *
 * 安装：
 *   dsh plugin --profile web add dsh-ownsync
 * 使用：
 *   侧栏「同步」→ 填仓库地址 → 上传 / 下载。
 */
import os from 'node:os';
import path from 'node:path';
import { SyncEngine } from './engine.js';
import { readConfig } from './config.js';
import { registerRoutes } from './http/guard.js';
import { createRoutes } from './http/routes.js';

export const name = 'dsh-ownsync';
export const inject = ['webServer'];

function makeLogger(ctx) {
  return (level, message) => {
    const line = '[dsh-ownsync] ' + message;
    try {
      const logger = ctx?.logger;
      if (typeof logger === 'function') {
        logger(line);
        return;
      }
      if (logger && typeof logger[level] === 'function') {
        logger[level](line);
        return;
      }
    } catch {
      /* 落到 console */
    }
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
}

function resolveHome(config) {
  if (typeof config?.home === 'string' && config.home.trim()) return path.resolve(config.home.trim());
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}

export function apply(ctx, config = {}) {
  const home = resolveHome(config);
  const log = makeLogger(ctx);
  const loaded = readConfig(home);
  if (loaded.error) log('warn', loaded.error);

  const overrides = {};
  if (typeof config.remote === 'string') overrides.remote = config.remote;
  if (typeof config.branch === 'string') overrides.branch = config.branch;

  const engine = new SyncEngine({
    home,
    ctx,
    log,
    config: { ...loaded.config, ...overrides },
  });

  const disposers = [];
  try {
    const failures = registerRoutes(ctx.webServer, createRoutes({ engine, home, log }), disposers);
    for (const failure of failures) log('warn', '同步接口注册失败：' + failure.path + '（' + failure.message + '）');
  } catch (error) {
    log('warn', '同步接口注册失败（插件仍已加载）：' + String(error?.message || error));
  }

  // 宿主刚启动、客户端还没连上：先把上次没写回的会话补掉（拿不到写入权就等下次）
  engine
    .startupApply()
    .catch(error => log('warn', '启动补写异常：' + String(error?.message || error)));

  ctx.effect?.(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* 已经卸载 */
      }
    }
  });

  log(
    'info',
    'dsh-ownsync 已加载（数据目录 ' +
      home +
      '，仓库 ' +
      (engine.cfg.remote || '未配置') +
      '，分支 ' +
      engine.cfg.branch +
      '）',
  );
}
