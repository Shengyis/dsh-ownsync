import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { registerRoutes, requestRejection } from '../lib/http/guard.js';
import { createRoutes } from '../lib/http/routes.js';
import { SyncEngine } from '../lib/engine.js';

function fakeRequest({ method = 'GET', headers = {}, body = '' } = {}) {
  const request = new PassThrough();
  request.method = method;
  request.headers = headers;
  if (body) request.write(body);
  request.end();
  return request;
}

function fakeResponse() {
  return {
    code: 0,
    headers: null,
    payload: null,
    writeHead(code, headers) {
      this.code = code;
      this.headers = headers;
    },
    end(value) {
      this.payload = value ? JSON.parse(value) : null;
    },
  };
}

function collect() {
  const routes = new Map();
  const webServer = {
    register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  return { webServer, routes };
}

async function call(routes, routePath, options) {
  const route = routes.get(routePath);
  assert.ok(route, '路由未注册：' + routePath);
  const response = fakeResponse();
  await route.handler(fakeRequest(options), response);
  return response;
}

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ownsync-http-'));
  const engine = new SyncEngine({ home, config: { branch: 'main' } });
  const { webServer, routes } = collect();
  registerRoutes(webServer, createRoutes({ engine, home, log: () => {} }), []);
  return { home, engine, routes };
}

test('来源校验：跨站、跨源、非 JSON、超大都被拒', () => {
  assert.equal(requestRejection({ headers: {} }), null);
  assert.equal(requestRejection({ headers: { 'sec-fetch-site': 'cross-site' } }), 'cross-site');
  assert.equal(requestRejection({ headers: { origin: 'null' } }), 'opaque-origin');
  assert.equal(
    requestRejection({ headers: { origin: 'https://evil.example', host: '127.0.0.1:5409' } }),
    'cross-origin',
  );
  assert.equal(requestRejection({ headers: { origin: 'https://127.0.0.1:5409', host: '127.0.0.1:5409' } }), null);
  assert.equal(
    requestRejection({ method: 'POST', headers: { 'content-type': 'text/plain', 'content-length': '2' } }),
    'content-type',
  );
  assert.equal(
    requestRejection({ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) } }),
    'too-large',
  );
});

test('状态接口返回本机版本与配置', async () => {
  const { home, routes } = setup();
  try {
    const response = await call(routes, '/ownsync/api/status', {});
    assert.equal(response.code, 200);
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.configured, false);
    assert.equal(response.payload.local.version, 0);
    assert.equal(response.payload.branch, 'main');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('配置接口保存后立即生效', async () => {
  const { home, engine, routes } = setup();
  try {
    const response = await call(routes, '/ownsync/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remote: 'https://git.example.com/x/y.git', branch: 'main' }),
    });
    assert.equal(response.payload.ok, true);
    assert.equal(response.payload.config.remote, 'https://git.example.com/x/y.git');
    assert.equal(engine.cfg.remote, 'https://git.example.com/x/y.git');
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'ownsync.json'), 'utf8'));
    assert.equal(saved.remote, 'https://git.example.com/x/y.git');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('非法配置返回错误，不写文件', async () => {
  const { home, routes } = setup();
  try {
    const response = await call(routes, '/ownsync/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ remote: 'https://user:pass@host/a.git' }),
    });
    assert.equal(response.payload.ok, false);
    assert.match(response.payload.message, /用户名和密码/);
    assert.equal(fs.existsSync(path.join(home, 'ownsync.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('方法不对、来源可疑、请求体过大都返回对应状态码', async () => {
  const { home, routes } = setup();
  try {
    const wrongMethod = await call(routes, '/ownsync/api/upload', { method: 'GET' });
    assert.equal(wrongMethod.code, 405);

    const crossSite = await call(routes, '/ownsync/api/status', { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossSite.code, 403);

    const tooLarge = await call(routes, '/ownsync/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024) },
      body: '{}',
    });
    assert.equal(tooLarge.code, 413);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('没有配置仓库时上传给出明确提示', async () => {
  const { home, routes } = setup();
  try {
    const response = await call(routes, '/ownsync/api/upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.payload.ok, false);
    assert.equal(response.payload.error, 'unconfigured');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
