import test from 'node:test';
import assert from 'node:assert/strict';

import { startAutoUpload } from '../lib/auto-upload.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function makeEngine({ upload, signature = () => 'sig', pending = [], changes = 1, autoUpload = true }) {
  return {
    cfg: { remote: 'ssh://git@example/srv/git/a.git', branch: 'main', autoUpload },
    busy: null,
    status: () => ({
      configured: true,
      local: { pending },
      localChanges: { count: changes },
    }),
    changeSignature: signature,
    upload,
  };
}

const ctx = { get: () => undefined };

test('改动稳定后自动上传一次', async () => {
  let calls = 0;
  const engine = makeEngine({
    upload: async () => {
      calls += 1;
      return { uploaded: true, version: 2, changedCount: 1 };
    },
  });
  const stop = startAutoUpload({ engine, ctx, tickMs: 20 });
  await sleep(90);
  stop();
  assert.equal(calls, 1);
});

test('签名一直在变时不上传', async () => {
  let calls = 0;
  let value = 0;
  const engine = makeEngine({
    signature: () => 'sig-' + value++,
    upload: async () => {
      calls += 1;
      return { uploaded: true, version: 2 };
    },
  });
  const stop = startAutoUpload({ engine, ctx, tickMs: 20 });
  await sleep(90);
  stop();
  assert.equal(calls, 0);
});

test('关闭开关后不上传', async () => {
  let calls = 0;
  const engine = makeEngine({
    autoUpload: false,
    upload: async () => {
      calls += 1;
      return { uploaded: true, version: 2 };
    },
  });
  const stop = startAutoUpload({ engine, ctx, tickMs: 20 });
  await sleep(80);
  stop();
  assert.equal(calls, 0);
});

test('有 pending 或有任务时不上传', async () => {
  let calls = 0;
  const pendingEngine = makeEngine({
    pending: ['sessions/a/x/session.v4.jsonl'],
    upload: async () => {
      calls += 1;
      return { uploaded: true, version: 2 };
    },
  });
  const stop = startAutoUpload({ engine: pendingEngine, ctx, tickMs: 20 });
  await sleep(80);
  stop();
  assert.equal(calls, 0);

  const busyCtx = {
    get: name =>
      name === 'agents'
        ? { list: () => [{ id: 'a1', status: 'running', inbox: { nextTurn: [], nextStep: [] } }] }
        : undefined,
  };
  const taskEngine = makeEngine({
    upload: async () => {
      calls += 1;
      return { uploaded: true, version: 2 };
    },
  });
  const stop2 = startAutoUpload({ engine: taskEngine, ctx: busyCtx, tickMs: 20 });
  await sleep(80);
  stop2();
  assert.equal(calls, 0);
});

test('stale 或需要确认删除时暂停，不再自动重试', async () => {
  let calls = 0;
  const staleEngine = makeEngine({
    upload: async () => {
      calls += 1;
      return { error: 'stale', message: '服务器版本较新' };
    },
  });
  const stop = startAutoUpload({ engine: staleEngine, ctx, tickMs: 20 });
  await sleep(120);
  stop();
  assert.equal(calls, 1);

  let confirmCalls = 0;
  const confirmEngine = makeEngine({
    upload: async () => {
      confirmCalls += 1;
      return { needsConfirm: 'bulk-delete', deletions: ['a', 'b', 'c'] };
    },
  });
  const stop2 = startAutoUpload({ engine: confirmEngine, ctx, tickMs: 20 });
  await sleep(120);
  stop2();
  assert.equal(confirmCalls, 1);
});

test('上传过程中内容变化：本轮跳过，下一轮可以再传', async () => {
  let calls = 0;
  const engine = makeEngine({
    upload: async () => {
      calls += 1;
      if (calls === 1) return { error: 'changed-during-upload', message: '变了' };
      return { uploaded: true, version: 3 };
    },
  });
  const stop = startAutoUpload({ engine, ctx, tickMs: 20 });
  await sleep(160);
  stop();
  assert.ok(calls >= 1);
});
