import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 极小的 React 替身 + 渲染器。
 *
 * `useState` 的 setter 按 Object.is 判断是否真的变化（和 React 一致），并记录
 * 每一次调用，这样"原地修改同一个对象"的 bug 会被测试抓住。
 */
function createHarness() {
  const stateStore = new Map();
  const effectStore = new Map();
  const updates = [];
  let current = null;
  let stateIndex = 0;
  let effectIndex = 0;

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const list = stateStore.get(current) || [];
      const index = stateIndex++;
      if (!(index in list)) list[index] = typeof initial === 'function' ? initial() : initial;
      stateStore.set(current, list);
      const set = next => {
        const value = typeof next === 'function' ? next(list[index]) : next;
        updates.push({ component: current, same: Object.is(value, list[index]) });
        if (Object.is(value, list[index])) return;
        list[index] = value;
      };
      return [list[index], set];
    },
    useEffect(fn) {
      const list = effectStore.get(current) || [];
      const index = effectIndex++;
      if (list[index]) return;
      list[index] = true;
      effectStore.set(current, list);
      try {
        fn();
      } catch {
        /* 测试环境里没有 document 之类的宿主能力 */
      }
    },
    useCallback: fn => fn,
    useRef: value => ({ current: value }),
  };

  const begin = component => {
    current = component;
    stateIndex = 0;
    effectIndex = 0;
  };

  const renderNode = node => {
    if (node === null || node === undefined || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(renderNode);
    if (typeof node.type === 'function') {
      begin(node.type);
      return renderNode(node.type(node.props || {}));
    }
    return { ...node, children: (node.children || []).map(renderNode) };
  };

  return { react, renderNode, updates };
}

function loadBundle(react, fetchImpl) {
  const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  let loaded = null;
  const sandbox = {
    window: {
      innerHeight: 800,
      __ModuleLoader__: {
        load(definition) {
          loaded = definition;
        },
      },
    },
    console,
  };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: 'lib/client.js' }).runInContext(sandbox);
  assert.ok(loaded, 'bundle 没有调用 window.__ModuleLoader__.load');
  assert.equal(loaded.id, 'dsh-ownsync');
  return loaded.factory(name => {
    if (name === 'react') return react;
    throw new Error('bundle 请求了未提供的模块：' + name);
  });
}

function mount(fetchImpl) {
  const harness = createHarness();
  const client = loadBundle(harness.react, fetchImpl);
  const registered = [];
  client.apply({
    slots: {
      inject: (name, build) => {
        build();
        return () => {};
      },
      register: (meta, component) => {
        registered.push({ meta, component });
        return () => {};
      },
    },
  });
  const find = name => registered.find(item => item.meta.name === name);
  return { client, registered, find, harness };
}

const draw = (harness, component, props) => harness.renderNode({ type: component, props: props || {} });

function texts(node) {
  const collected = [];
  const walk = value => {
    if (typeof value === 'string' || typeof value === 'number') {
      collected.push(String(value));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const child of value.children || []) walk(child);
  };
  walk(node);
  return collected.join('|');
}

const statusPayload = overrides => ({
  configured: false,
  remote: '',
  branch: 'main',
  local: { version: 0, baseSha: null, updatedAt: 0, pending: [] },
  backups: { count: 0, size: 0 },
  busy: false,
  ...overrides,
});

function buttonByLabel(tree, label) {
  let found = null;
  const walk = node => {
    if (!node || typeof node !== 'object' || found) return;
    if (node.type === 'button') {
      const text = (node.children || []).filter(child => typeof child === 'string').join('');
      if (text === label) {
        found = node;
        return;
      }
    }
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return found;
}

test('bundle 导出插件名，底部槽位注册的是卡片', () => {
  const { client, find, harness } = mount();
  assert.equal(client.name, 'dsh-ownsync');
  assert.equal([...client.inject].join(','), 'slots');
  assert.equal(typeof client.apply, 'function');

  const dock = find('sidebar.footer.action');
  assert.ok(dock, '没有注册 sidebar.footer.action');
  assert.equal(dock.meta.label, '同步');
  assert.equal(dock.meta.order, 40);

  const tree = draw(harness, dock.component);
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.className, 'os-dock');

  // 侧栏收起成图标栏时只渲染一个按钮
  const narrow = draw(harness, dock.component, { wide: false });
  assert.equal(narrow.type, 'button');
  assert.equal(narrow.props.className, 'os-foot');
});

test('卡片上有状态、版本、上次同步和上传/下载', () => {
  const { find, harness } = mount();
  const dock = find('sidebar.footer.action');
  const content = texts(draw(harness, dock.component));
  assert.match(content, /未填写仓库地址/);
  assert.match(content, /本机\|v0/);
  assert.match(content, /服务器/);
  assert.match(content, /上次同步/);
  assert.match(content, /上传/);
  assert.match(content, /下载/);
});

test('点「同步」在按钮上方打开设置弹层；再点收起', () => {
  const { find, harness } = mount();
  const dock = find('sidebar.footer.action');
  const popover = find('shell.overlay');
  assert.ok(popover, '没有注册 shell.overlay');

  assert.equal(draw(harness, popover.component), null);

  const tree = draw(harness, dock.component);
  const button = tree.children[1];
  assert.equal(button.type, 'button');
  button.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 700 }) } });

  const panel = draw(harness, popover.component);
  assert.ok(panel, '点击后弹层应当渲染');
  assert.equal(panel.props.className, 'os-popover');
  assert.equal(panel.props.style.left, '20px');
  assert.equal(panel.props.style.bottom, '108px');
  assert.match(String(panel.props.style.width), /280px/);
  // 弹层里不再重复显示状态
  assert.equal(texts(panel).includes('未填写仓库地址'), false);

  // 再点一次收起
  const again = draw(harness, dock.component);
  again.children[1].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 700 }) } });
  assert.equal(draw(harness, popover.component), null);
});

test('设置面板包含地址、分支、保存与刷新间隔', () => {
  const { find, harness } = mount();
  const section = find('settings.section');
  assert.ok(section, '没有注册设置分节');
  const content = texts(draw(harness, section.component));
  assert.match(content, /仓库地址/);
  assert.match(content, /分支/);
  assert.match(content, /保存/);
  assert.match(content, /本机状态刷新间隔/);
  assert.match(content, /服务器自动检查间隔/);
  // 设置页没有侧栏卡片，这里保留状态行
  assert.match(content, /未填写仓库地址/);
});

test('从未同步时显示「从未同步」', async () => {
  const { find, harness } = mount(async () => ({
    json: async () => statusPayload({}),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));
  const content = texts(draw(harness, dock.component));
  assert.match(content, /上次同步/);
  assert.match(content, /从未同步/);
});

test('本机有改动时卡片显示未上传数量', async () => {
  const now = Date.now();
  const { find, harness } = mount(async url => ({
    json: async () =>
      String(url).includes('/check')
        ? {
            ok: true,
            remote: {
              inSync: true,
              localDirty: true,
              localChanges: { count: 2 },
              remoteVersion: 1,
              remoteUpdatedAt: now,
            },
          }
        : statusPayload({
            configured: true,
            remote: 'ssh://git@example/srv/git/dsh-sync.git',
            local: { version: 1, baseSha: 'abc', updatedAt: now, pending: [] },
            localChanges: { count: 2 },
          }),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));
  const content = texts(draw(harness, dock.component));
  assert.match(content, /本机有 2 处未上传改动/);
});

test('写回遮罩已注册，默认不渲染', () => {
  const { registered } = mount();
  const lock = registered.find(item => item.meta.id === 'dsh-ownsync-recovering');
  assert.ok(lock, '没有注册写回遮罩');
  assert.equal(lock.component({}), null);
});

test('服务器为空时建议上传并只启用上传', async () => {
  const { find, harness } = mount(async url => ({
    json: async () =>
      String(url).includes('/check')
        ? {
            ok: true,
            remote: {
              remoteEmpty: true,
              inSync: false,
              remoteVersion: 0,
              remoteUpdatedAt: 0,
              remoteDevice: '',
            },
          }
        : statusPayload({
            configured: true,
            remote: 'ssh://git@example/srv/git/dsh-sync.git',
            local: { version: 0, baseSha: null, updatedAt: 0, pending: [] },
            localChanges: { count: 1 },
          }),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));
  const tree = draw(harness, dock.component);
  assert.match(texts(tree), /服务器上还没有内容，建议上传/);
  assert.equal(buttonByLabel(tree, '上传').props.disabled, false);
  assert.equal(buttonByLabel(tree, '下载').props.disabled, true);
});

test('未配置仓库时两个按钮都不可按', () => {
  const { find, harness } = mount();
  const dock = find('sidebar.footer.action');
  const tree = draw(harness, dock.component);
  assert.equal(buttonByLabel(tree, '上传').props.disabled, true);
  assert.equal(buttonByLabel(tree, '下载').props.disabled, true);
});

test('服务器较新时只能下载', async () => {
  const now = Date.now();
  const { find, harness } = mount(async url => ({
    json: async () =>
      String(url).includes('/check')
        ? { ok: true, remote: { inSync: false, localDirty: false, remoteVersion: 2, remoteUpdatedAt: now } }
        : statusPayload({
            configured: true,
            remote: 'ssh://git@example/srv/git/dsh-sync.git',
            local: { version: 1, baseSha: 'a', updatedAt: now, pending: [] },
            localChanges: { count: 0 },
          }),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));
  const tree = draw(harness, dock.component);
  assert.equal(buttonByLabel(tree, '上传').props.disabled, true);
  assert.equal(buttonByLabel(tree, '下载').props.disabled, false);
});

test('本机有未上传改动时只能上传', async () => {
  const now = Date.now();
  const { find, harness } = mount(async url => ({
    json: async () =>
      String(url).includes('/check')
        ? { ok: true, remote: { inSync: true, localDirty: true, localChanges: { count: 1 }, remoteVersion: 1 } }
        : statusPayload({
            configured: true,
            remote: 'ssh://git@example/srv/git/dsh-sync.git',
            local: { version: 1, baseSha: 'a', updatedAt: now, pending: [] },
            localChanges: { count: 1 },
          }),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));
  const tree = draw(harness, dock.component);
  assert.equal(buttonByLabel(tree, '上传').props.disabled, false);
  assert.equal(buttonByLabel(tree, '下载').props.disabled, true);
});

test('已同步时两个按钮都不可按', async () => {
  const now = Date.now();
  const { find, harness } = mount(async url => ({
    json: async () =>
      String(url).includes('/check')
        ? { ok: true, remote: { inSync: true, localDirty: false, remoteVersion: 1, remoteUpdatedAt: now } }
        : statusPayload({
            configured: true,
            remote: 'ssh://git@example/srv/git/dsh-sync.git',
            local: { version: 1, baseSha: 'a', updatedAt: now, pending: [] },
            localChanges: { count: 0 },
          }),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));
  const tree = draw(harness, dock.component);
  assert.equal(buttonByLabel(tree, '上传').props.disabled, true);
  assert.equal(buttonByLabel(tree, '下载').props.disabled, true);
});
