import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { apply } from '../lib/index.js';

const ID = '88888888-8888-8888-8888-888888888888';
const FILE = `sessions/g/session-${ID}/session.v4.jsonl`;

function sessionBytes(count) {
  const rows = [
    { type: 'session', version: 4, id: `session-${ID}`, cwd: 'E:/Ownsync/Demo' },
    ...Array.from({ length: count }, (_, seq) => ({ type: 'turn/start', seq, time: seq, data: { turn: seq } })),
  ];
  return Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

/** 最小宿主：只提供 webServer.register 与 effect。 */
function host(home) {
  const routes = new Map();
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  apply(ctx, { home });
  return routes;
}

async function call(routes, routePath, body) {
  const route = routes.get(routePath);
  assert.ok(route, '路由未注册：' + routePath);
  const request = new PassThrough();
  request.method = body === undefined ? 'GET' : 'POST';
  request.headers = body === undefined ? {} : { 'content-type': 'application/json' };
  if (body !== undefined) request.write(JSON.stringify(body));
  request.end();
  let payload = null;
  const response = {
    writeHead() {},
    end(value) {
      payload = JSON.parse(value);
    },
  };
  await route.handler(request, response);
  return payload;
}

test('两个数据目录通过裸仓库完成 上传 → 下载', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-plugin-'));
  try {
    const remote = path.join(root, 'remote.git');
    execFileSync('git', ['init', '--bare', '--quiet', remote]);
    const homeA = path.join(root, 'A');
    const homeB = path.join(root, 'B');
    fs.mkdirSync(homeA);
    fs.mkdirSync(homeB);

    const routesA = host(homeA);
    const configured = await call(routesA, '/ownsync/api/config', { remote, branch: 'main' });
    assert.equal(configured.ok, true);

    fs.mkdirSync(path.join(homeA, 'sessions/g', 'session-' + ID), { recursive: true });
    fs.writeFileSync(path.join(homeA, FILE), sessionBytes(3));
    fs.mkdirSync(path.join(homeA, 'storages'), { recursive: true });
    fs.writeFileSync(path.join(homeA, 'storages/workspace.json'), '{"global":{"workspaceIds":[]},"tables":{"workspaces":{}}}\n');

    const uploaded = await call(routesA, '/ownsync/api/upload', {});
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.version, 1);
    assert.equal(uploaded.files, 2);

    const routesB = host(homeB);
    await call(routesB, '/ownsync/api/config', { remote, branch: 'main' });
    const checked = await call(routesB, '/ownsync/api/check', {});
    assert.equal(checked.ok, true);
    assert.equal(checked.remote.remoteVersion, 1);

    const downloaded = await call(routesB, '/ownsync/api/download', {});
    assert.equal(downloaded.ok, true);
    assert.equal(downloaded.version, 1);
    assert.equal(downloaded.restartRequired, true);
    assert.equal(fs.existsSync(path.join(homeB, FILE)), true);
    assert.deepEqual(fs.readFileSync(path.join(homeB, FILE)), sessionBytes(3));

    const statusB = await call(routesB, '/ownsync/api/status');
    assert.equal(statusB.local.version, 1);
    assert.equal(statusB.configured, true);

    const again = await call(routesB, '/ownsync/api/download', {});
    assert.equal(again.ok, true);
    assert.equal(again.upToDate, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
