/**
 * 重启 DSH 桌面版（最小可用版，协议参考 dsh-restart-now）。
 *
 * 宿主是 Electron 主进程的子进程：只要外部助手结束主进程，宿主就会因 IPC 断开
 * 走官方优雅关闭（会话落盘），随后助手用原启动参数把应用重新拉起。
 *
 * 安全底线：
 *  - 助手先写 ack，宿主收到才继续；否则什么都不做；
 *  - 只杀主进程（taskkill /F，不带 /T），绝不杀进程树；
 *  - 拉起前清掉"上一次运行"的环境变量，保留 DSH_HOME / DSH_PROFILE / DSH_PROFILE_DIR。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

const COOLDOWN_MS = 5000;
const ACK_TIMEOUT_MS = 800;

let lastRestartAt = 0;

/** 清空冷却（测试用）。 */
export function resetCooldown() {
  lastRestartAt = 0;
}

/** 平台是否支持：最小版只做 Windows。 */
export function supportedPlatform(platform = process.platform) {
  return platform === 'win32';
}

/** 是否运行在 DSH 桌面版（而不是 `dsh web` / CLI）。 */
export function isDesktopContext(ctx) {
  try {
    if (ctx && typeof ctx.get === 'function' && ctx.get('desktopProfiles') != null) return true;
  } catch {
    /* 服务未就绪 */
  }
  try {
    const pc = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    const launchedByCli = Array.isArray(process.argv) && process.argv.includes('--profile');
    if (!launchedByCli && pc && String(pc.name ?? '').toLowerCase() === 'desktop') return true;
  } catch {
    /* 同上 */
  }
  return false;
}

/** 当前 profile 目录。 */
export function resolveProfileDir(ctx) {
  try {
    const pc = ctx && typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined;
    if (pc && typeof pc.dir === 'string' && pc.dir) return pc.dir;
  } catch {
    /* 继续兜底 */
  }
  const env = process.env;
  if (env.DSH_PROFILE_DIR) return env.DSH_PROFILE_DIR;
  if (env.DSH_HOME) return join(env.DSH_HOME, 'profiles', env.DSH_PROFILE || 'desktop');
  if (env.USERPROFILE) return join(env.USERPROFILE, '.dsh', 'profiles', 'desktop');
  return '';
}

/** 插件安装/卸载进行中（<profile>/.plugin-manager/run.json 里的 pid 还活着）。 */
export function installLocked(profileDir) {
  if (!profileDir) return false;
  const file = join(profileDir, '.plugin-manager', 'run.json');
  try {
    if (!existsSync(file)) return false;
    const record = JSON.parse(readFileSync(file, 'utf8'));
    const pid = Number(record?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  } catch {
    return false;
  }
}

/** 有没有会被重启打断的回合或后台作业。 */
export function activeTasks(ctx) {
  const result = { active: false, tasks: 0, jobs: 0 };
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const jobs = ctx && typeof ctx.get === 'function' ? ctx.get('jobs') : undefined;
    if (!agents || typeof agents.list !== 'function') return result;
    const live = agents.list() || [];

    const busy = live.filter(agent => {
      if (!agent) return false;
      if (agent.status === 'running') return true;
      const nextTurn = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0;
      const nextStep = Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0;
      return nextTurn + nextStep > 0;
    });
    result.tasks = busy.length;

    if (jobs && typeof jobs.list === 'function') {
      const seen = new Set();
      for (const agent of [undefined, ...live]) {
        let list = [];
        try {
          list = jobs.list(agent ? agent.id : undefined) || [];
        } catch {
          list = [];
        }
        for (const job of list) {
          if (!job || (job.status !== 'running' && job.status !== 'stopping')) continue;
          const key = job.id === undefined || job.id === null ? job : 'id:' + job.id;
          if (seen.has(key)) continue;
          seen.add(key);
          result.jobs += 1;
        }
      }
    }
    result.active = result.tasks > 0 || result.jobs > 0;
  } catch {
    return { active: false, tasks: 0, jobs: 0 };
  }
  return result;
}

/** 应用可执行文件：桌面宿主是应用目录下的 DeepSeek Harness.exe。 */
export function resolveExe(execPath = process.execPath, platform = process.platform) {
  if (platform === 'win32') {
    const candidate = win32.join(win32.dirname(execPath), 'DeepSeek Harness.exe');
    if (existsSync(candidate)) return candidate;
  }
  return execPath;
}

/** 按 Windows 规则拆命令行（只处理引号与反斜杠转义引号）。 */
export function tokenizeCommandLine(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && text[index + 1] === '"') {
      current += '"';
      started = true;
      index += 1;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && (char === ' ' || char === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * 从主进程命令行里取出可复用的启动参数。
 * 第 0 段必须是同一个 exe；出现 --type= / --expose-internals 一律不猜。
 */
export function parseLaunchArgs(commandLine, exe, platform = 'win32') {
  if (typeof commandLine !== 'string') return null;
  const text = commandLine.trim();
  if (!text) return null;
  const tokens = tokenizeCommandLine(text);
  if (tokens.length === 0) return null;
  const norm = value =>
    platform === 'win32' ? String(value).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : String(value);
  if (norm(tokens[0]) !== norm(exe)) return null;
  const args = tokens.slice(1);
  for (const arg of args) {
    if (/^--type=/i.test(arg) || arg === '--expose-internals') return null;
  }
  return args;
}

/** 生成重启助手脚本（CommonJS，由应用自身 exe 以 ELECTRON_RUN_AS_NODE 运行）。 */
export function buildHelperScript(options) {
  const { exe, mainPid, hostPid, ackPath, logPath, hostGraceMs = 15000 } = options;
  const j = value => JSON.stringify(value);
  return `'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXE = ${j(exe)};
const MAIN = ${j(mainPid)};
const HOST = ${j(hostPid)};
const ACK = ${j(ackPath)};
const LOG = ${j(logPath)};
const HOST_GRACE_MS = ${j(hostGraceMs)};
const DROP = ['ELECTRON_RUN_AS_NODE', 'DSH_SESSION_ID', 'DSH_WEB_URL', 'DSH_SHELL'];

function log(message) {
  try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + message + '\\n'); } catch (error) {}
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function alive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error && error.code === 'EPERM'; }
}
function kill(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch (error) {
    log('taskkill ' + pid + ' failed: ' + ((error && error.message) || error));
    return false;
  }
}

// 问系统"主进程当初是怎么被启动的"；问不到或不可信就不带参数。
function readLaunchArgs() {
  if (!Number.isInteger(MAIN) || MAIN <= 1) return [];
  const probe = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; "
    + "$p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=" + MAIN + "'; "
    + 'if ($p -and $p.CommandLine) { $p.CommandLine }';
  let text = '';
  try {
    text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      encoding: 'utf8', windowsHide: true, timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (error) {
    log('launch-args probe failed: ' + ((error && error.message) || error));
    return [];
  }
  const commandLine = String(text || '').trim();
  if (!commandLine) return [];
  const tokens = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (char === '\\\\' && commandLine[index + 1] === '"') { current += '"'; started = true; index += 1; continue; }
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && (char === ' ' || char === '\\t')) {
      if (started) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) tokens.push(current);
  if (tokens.length === 0) return [];
  const norm = value => String(value).replace(/\\//g, '\\\\').replace(/\\\\+$/, '').toLowerCase();
  if (norm(tokens[0]) !== norm(EXE)) { log('launch args rejected: exe mismatch'); return []; }
  const args = tokens.slice(1);
  for (const arg of args) {
    if (/^--type=/i.test(arg) || arg === '--expose-internals') { log('launch args rejected: chromium/host arg'); return []; }
  }
  return args;
}

(async () => {
  if (!Number.isInteger(MAIN) || MAIN <= 1) { log('invalid main pid: ' + MAIN); return; }
  try {
    fs.writeFileSync(ACK, JSON.stringify({ at: new Date().toISOString(), helperPid: process.pid }));
  } catch (error) {
    log('ack write failed: ' + ((error && error.message) || error));
    return;
  }

  const args = readLaunchArgs();
  await sleep(500);

  kill(MAIN);
  let deadline = Date.now() + 30000;
  while (alive(MAIN) && Date.now() < deadline) await sleep(200);
  if (alive(MAIN)) { log('main still alive'); return; }

  deadline = Date.now() + HOST_GRACE_MS;
  while (Date.now() < deadline && alive(HOST)) await sleep(200);
  if (alive(HOST)) { log('host alive after grace, killing'); kill(HOST); }

  const env = Object.assign({}, process.env);
  for (const key of DROP) delete env[key];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await sleep(attempt === 1 ? 400 : 900);
    try {
      const child = spawn(EXE, args, { detached: true, stdio: 'ignore', cwd: path.dirname(EXE), env });
      child.unref();
      await sleep(1500);
      if (child.pid && alive(child.pid)) { log('restarted pid ' + child.pid); return; }
      log('respawn attempt ' + attempt + ' exited early');
    } catch (error) {
      log('respawn failed: ' + ((error && error.message) || error));
    }
  }
  log('respawn failed after 2 attempts');
})();
`;
}

function stampOf(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** 等助手写下 ack（最多 800ms）。 */
export function waitForAck(ackPath, timeoutMs = ACK_TIMEOUT_MS) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      if (existsSync(ackPath)) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

/**
 * 执行一次重启。
 * @returns {Promise<object>} { restarted, mode, reason?, message?, tasks?, jobs? }
 */
export async function restartHost(options = {}) {
  const { ctx, log = () => {}, platform = process.platform } = options;
  const host = { execPath: process.execPath, parentPid: process.ppid, platform };

  if (!isDesktopContext(ctx)) {
    return {
      restarted: false,
      mode: 'manual',
      reason: 'non-desktop',
      host,
      message: '只有 DSH 桌面版可以自动重启；请完全退出后再打开。',
    };
  }
  if (!supportedPlatform(platform)) {
    return {
      restarted: false,
      mode: 'manual',
      reason: 'unsupported-platform',
      host,
      message: '当前系统暂不支持自动重启；请完全退出后再打开。',
    };
  }

  const profileDir = resolveProfileDir(ctx);
  if (installLocked(profileDir)) {
    return { restarted: false, mode: 'busy', reason: 'installing', host, message: '插件安装/卸载正在进行，完成后再重启。' };
  }

  const tasks = activeTasks(ctx);
  if (tasks.active) {
    return {
      restarted: false,
      mode: 'busy',
      reason: 'busy',
      tasks: tasks.tasks,
      jobs: tasks.jobs,
      host,
      message: '还有 ' + (tasks.tasks + tasks.jobs) + ' 个任务在运行，等结束再重启。',
    };
  }

  const now = Date.now();
  if (now - lastRestartAt < COOLDOWN_MS) {
    return {
      restarted: false,
      mode: 'busy',
      reason: 'cooldown',
      retryAfterMs: COOLDOWN_MS - (now - lastRestartAt),
      host,
    };
  }

  const mainPid = process.ppid;
  if (!Number.isInteger(mainPid) || mainPid <= 1) {
    return { restarted: false, mode: 'manual', reason: 'no-main-process', host, message: '找不到主进程，请手动重启。' };
  }

  const exe = resolveExe(process.execPath, platform);
  if (!exe || !existsSync(exe)) {
    return { restarted: false, mode: 'manual', reason: 'exe-not-found', host, message: '找不到应用可执行文件，请手动重启。' };
  }

  const stamp = stampOf(now);
  const helperPath = join(tmpdir(), 'dsh-ownsync-helper-' + stamp + '.cjs');
  const ackPath = join(tmpdir(), 'dsh-ownsync-helper-' + stamp + '.ack');
  const logPath = join(tmpdir(), 'dsh-ownsync-restart-' + stamp + '.log');

  try {
    writeFileSync(helperPath, buildHelperScript({ exe, mainPid, hostPid: process.pid, ackPath, logPath }));
  } catch (error) {
    log('重启助手写入失败：' + String(error?.message || error));
    return { restarted: false, mode: 'manual', reason: 'helper-write-failed', host, message: '无法写入重启助手，请手动重启。' };
  }

  lastRestartAt = now;

  try {
    const child = spawn(process.execPath, [helperPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', error => log('重启助手启动失败：' + String(error?.message || error)));
    child.unref();
  } catch (error) {
    log('重启助手派发失败：' + String(error?.message || error));
    return { restarted: false, mode: 'manual', reason: 'helper-dispatch-failed', host, message: '无法派发重启助手，请手动重启。' };
  }

  const acked = await waitForAck(ackPath);
  if (!acked) {
    log('重启助手没有确认（ack 超时），未结束任何进程');
    return {
      restarted: false,
      mode: 'manual',
      reason: 'helper-not-responding',
      host,
      message: '重启助手没有响应，未执行重启；请手动退出后再打开。',
    };
  }

  log('已派发重启（助手将结束主进程并重新拉起）');
  return { restarted: true, mode: 'helper', stamp, host };
}
