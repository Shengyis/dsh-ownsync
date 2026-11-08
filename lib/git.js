/**
 * Git 子进程封装。
 *
 * 只做三件事：带超时地跑 `git`、把 stdout/stderr 收好、把失败翻译成
 * 能直接展示给用户的原因。所有调用都是非交互的：DSH 里没有终端，
 * 一旦 git 想弹凭据窗口就会永久卡住，所以显式关掉交互。
 *
 * `git` 本身来自系统 PATH（Windows 上是 Git for Windows）。找不到时不会抛异常，
 * 而是回一个 `spawnError`，由 git-failure.js 翻译成可执行的提示。
 */
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;

/** 交互一律关闭；凭据必须事先在终端里配置好。 */
const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CREDENTIAL_NONINTERACTIVE: '1',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
};

/**
 * 运行一条 git 命令。
 * @param {string} cwd  git 的 `-C` 目录
 * @param {string[]} args
 * @param {{input?: string|Buffer, env?: Record<string,string>, timeoutMs?: number, binary?: boolean, command?: string}} [options]
 * @returns {Promise<{code: number|null, stdout: Buffer|string, stderr: string, timedOut: boolean, spawnError: string|null}>}
 */
export function runGit(cwd, args, options = {}) {
  const {
    input = null,
    env = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    binary = false,
    command = 'git',
  } = options;
  return new Promise(resolve => {
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let child = null;
    let timer = null;

    const build = () => ({
      code: spawnError ? -1 : timedOut ? -1 : (child && child.exitCode) ?? -1,
      stdout: binary ? Buffer.concat(out) : Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
      timedOut,
      spawnError,
    });

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(build());
    };

    try {
      child = spawn(command, ['-C', cwd, ...args], {
        windowsHide: true,
        env: { ...process.env, ...BASE_ENV, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      spawnError = error?.code || 'spawn-failed';
      err.push(Buffer.from(String(error?.message || error)));
      finish();
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    }, Math.max(1000, timeoutMs));

    child.stdout?.on('data', chunk => out.push(chunk));
    child.stderr?.on('data', chunk => err.push(chunk));
    child.stdin?.on('error', () => {
      /* 命令不存在时写入 stdin 会 EPIPE，忽略即可 */
    });
    child.on('error', error => {
      spawnError = error?.code || 'spawn-failed';
      err.push(Buffer.from(String(error?.message || error)));
      finish();
    });
    child.on('close', finish);

    try {
      if (input === null) child.stdin?.end();
      else child.stdin?.end(input);
    } catch (error) {
      err.push(Buffer.from(String(error?.message || error)));
      finish();
    }
  });
}

/** 命令是否成功。 */
export function isOk(result) {
  return Boolean(result) && result.code === 0 && !result.timedOut && !result.spawnError;
}
