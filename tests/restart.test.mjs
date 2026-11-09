import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  activeTasks,
  buildHelperScript,
  installLocked,
  isDesktopContext,
  parseLaunchArgs,
  resetCooldown,
  restartHost,
  tokenizeCommandLine,
  waitForAck,
} from '../lib/host-restart.js';

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-restart-'));

test('命令行拆分：引号包裹的 exe 路径', () => {
  assert.deepEqual(
    tokenizeCommandLine('"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" --profile desktop'),
    ['C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', '--profile', 'desktop'],
  );
});

test('复用启动参数：exe 必须一致', () => {
  const exe = 'C:\\Apps\\DeepSeek Harness.exe';
  assert.deepEqual(parseLaunchArgs('"C:\\Apps\\DeepSeek Harness.exe" --profile desktop', exe), ['--profile', 'desktop']);
  assert.deepEqual(parseLaunchArgs('"C:\\Apps\\DeepSeek Harness.exe"', exe), []);
  assert.equal(parseLaunchArgs('"C:\\Other\\DeepSeek Harness.exe" --profile desktop', exe), null);
});

test('复用启动参数：拒绝 Chromium / 宿主参数', () => {
  const exe = 'C:\\Apps\\DeepSeek Harness.exe';
  assert.equal(parseLaunchArgs('"C:\\Apps\\DeepSeek Harness.exe" --type=renderer', exe), null);
  assert.equal(parseLaunchArgs('"C:\\Apps\\DeepSeek Harness.exe" --expose-internals', exe), null);
});

test('桌面环境判定', () => {
  assert.equal(isDesktopContext({ get: name => (name === 'desktopProfiles' ? {} : undefined) }), true);
  assert.equal(
    isDesktopContext({ get: name => (name === 'profileContext' ? { name: 'desktop', dir: 'C:\\p' } : undefined) }),
    true,
  );
  assert.equal(isDesktopContext({ get: () => undefined }), false);
});

test('插件安装锁：活 pid 拦截，死 pid 放行', () => {
  const dir = tempHome();
  try {
    assert.equal(installLocked(dir), false);
    const lockDir = path.join(dir, '.plugin-manager');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'run.json'), JSON.stringify({ pid: process.pid }));
    assert.equal(installLocked(dir), true);
    fs.writeFileSync(path.join(lockDir, 'run.json'), JSON.stringify({ pid: 999999 }));
    assert.equal(installLocked(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('活跃任务探测：running 的 agent 与 job 都算', () => {
  const ctx = {
    get: name => {
      if (name === 'agents') {
        return {
          list: () => [
            { id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
            { id: 'a2', status: 'idle', inbox: { nextTurn: [1], nextStep: [] } },
            { id: 'a3', status: 'idle', inbox: { nextTurn: [], nextStep: [] } },
          ],
        };
      }
      if (name === 'jobs') {
        return { list: () => [{ id: 'j1', status: 'running' }, { id: 'j2', status: 'done' }] };
      }
      return undefined;
    },
  };
  const result = activeTasks(ctx);
  assert.equal(result.active, true);
  assert.equal(result.tasks, 2);
  assert.equal(result.jobs, 1);
});

test('活跃任务探测：服务缺失按空闲处理', () => {
  assert.deepEqual(activeTasks({ get: () => undefined }), { active: false, tasks: 0, jobs: 0 });
});

test('非桌面环境不派发重启', async () => {
  resetCooldown();
  const result = await restartHost({ ctx: { get: () => undefined }, platform: 'win32' });
  assert.equal(result.restarted, false);
  assert.equal(result.reason, 'non-desktop');
});

test('安装锁或活跃任务时拒绝派发', async () => {
  resetCooldown();
  const dir = tempHome();
  try {
    const lockDir = path.join(dir, '.plugin-manager');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'run.json'), JSON.stringify({ pid: process.pid }));
    const ctx = {
      get: name => {
        if (name === 'profileContext') return { name: 'desktop', dir };
        return undefined;
      },
    };
    const locked = await restartHost({ ctx, platform: 'win32' });
    assert.equal(locked.restarted, false);
    assert.equal(locked.reason, 'installing');

    fs.rmSync(lockDir, { recursive: true, force: true });
    const busyCtx = {
      get: name => {
        if (name === 'profileContext') return { name: 'desktop', dir };
        if (name === 'agents') return { list: () => [{ id: 'a1', status: 'running', inbox: {} }] };
        return undefined;
      },
    };
    const busy = await restartHost({ ctx: busyCtx, platform: 'win32' });
    assert.equal(busy.restarted, false);
    assert.equal(busy.reason, 'busy');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('助手脚本包含 ack、只杀主进程、清环境', () => {
  const script = buildHelperScript({
    exe: 'C:\\Apps\\DeepSeek Harness.exe',
    mainPid: 1234,
    hostPid: 5678,
    ackPath: 'C:\\Temp\\ack',
    logPath: 'C:\\Temp\\log',
  });
  assert.match(script, /taskkill/);
  assert.match(script, /ACK/);
  assert.match(script, /ELECTRON_RUN_AS_NODE/);
  assert.match(script, /DSH_SESSION_ID/);
  assert.match(script, /detached: true/);
  assert.match(script, /ProcessId=/);
});

test('ack 等待：文件出现返回 true，超时返回 false', async () => {
  const dir = tempHome();
  try {
    const missing = path.join(dir, 'nope.ack');
    assert.equal(await waitForAck(missing, 60), false);
    const present = path.join(dir, 'yes.ack');
    fs.writeFileSync(present, '{}');
    assert.equal(await waitForAck(present, 60), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
