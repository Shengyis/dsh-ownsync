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

function pillButton(tree) {
  let found = null;
  const walk = node => {
    if (!node || typeof node !== 'object' || found) return;
    if (
      node.type === 'button' &&
      typeof node.props?.className === 'string' &&
      node.props.className.includes('os-pill')
    ) {
      found = node;
      return;
    }
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  return found;
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

test('点「设置」齿轮在按钮上方打开设置弹层；再点收起', () => {
  const { find, harness } = mount();
  const dock = find('sidebar.footer.action');
  const popover = find('shell.overlay');
  assert.ok(popover, '没有注册 shell.overlay');

  assert.equal(draw(harness, popover.component), null);

  const tree = draw(harness, dock.component);
  const foot = tree.children[1];
  assert.equal(foot.type, 'div');
  const gear = foot.children[0];
  assert.equal(gear.type, 'button');
  const labels = foot.children.map(child => texts(child));
  assert.equal(foot.children.length, 2);
  assert.match(labels[1], /重启/);
  gear.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 700 }) } });

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
  again.children[1].children[0].props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 20, top: 700 }) } });
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

test('点击状态胶囊显示有改动的文件', async () => {
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
            localChanges: {
              count: 2,
              sample: ['sessions/g/session-x/a.jsonl', 'sessions/g/session-y/a.jsonl'],
              details: [
                { path: 'sessions/g/session-x/a.jsonl', kind: 'sessions', label: 'Ownsync · 学习源码' },
                { path: 'sessions/g/session-y/a.jsonl', kind: 'sessions', label: 'Ownsync · M0' },
              ],
            },
          }),
  }));
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));

  let tree = draw(harness, dock.component);
  assert.match(texts(tree), /本机有 2 处未上传改动/);
  assert.doesNotMatch(texts(tree), /学习源码/);

  const pill = pillButton(tree);
  assert.ok(pill, '状态胶囊不是可点击的');
  pill.props.onClick();

  tree = draw(harness, dock.component);
  assert.match(texts(tree), /有改动的文件（2）/);
  assert.match(texts(tree), /Ownsync · 学习源码/);
  assert.match(texts(tree), /Ownsync · M0/);
});

test('上传后点「已同步」显示本次改动', async () => {
  const now = Date.now();
  let uploaded = false;
  const { find, harness } = mount(async url => {
    if (String(url).includes('/upload')) {
      uploaded = true;
      return {
        json: async () => ({
          ok: true,
          uploaded: true,
          version: 46,
          files: 142,
          changedCount: 2,
          changedFiles: [
            { path: 'a', label: 'Ownsync · 学习源码' },
            { path: 'b', label: 'Ownsync · M0' },
          ],
        }),
      };
    }
    if (String(url).includes('/check')) {
      return {
        json: async () => ({
          ok: true,
          remote: {
            inSync: true,
            localDirty: !uploaded,
            localChanges: { count: uploaded ? 0 : 2 },
            remoteVersion: uploaded ? 46 : 45,
            remoteUpdatedAt: now,
          },
        }),
      };
    }
    return {
      json: async () =>
        statusPayload({
          configured: true,
          remote: 'ssh://git@example/srv/git/dsh-sync.git',
          local: { version: uploaded ? 46 : 45, baseSha: 'abc', updatedAt: now, pending: [] },
          localChanges: uploaded
            ? { count: 0 }
            : {
                count: 2,
                sample: ['a', 'b'],
                details: [
                  { path: 'a', label: 'Ownsync · 学习源码' },
                  { path: 'b', label: 'Ownsync · M0' },
                ],
              },
        }),
    };
  });
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));

  let tree = draw(harness, dock.component);
  const upload = buttonByLabel(tree, '上传');
  assert.ok(upload, '没找到上传按钮');
  upload.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 30));

  tree = draw(harness, dock.component);
  assert.match(texts(tree), /已同步/);
  assert.doesNotMatch(texts(tree), /已上传 v46/);

  const pill = pillButton(tree);
  assert.ok(pill, '已同步状态下胶囊不可点击');
  pill.props.onClick();

  tree = draw(harness, dock.component);
  assert.match(texts(tree), /已上传 v46，这次更新了 2 个改动/);
  assert.match(texts(tree), /Ownsync · 学习源码/);
  assert.match(texts(tree), /Ownsync · M0/);
});

test('打开页面发现服务器领先时不会自动下载', async () => {
  let downloadCalls = 0;
  let restartCalls = 0;
  const now = Date.now();
  const { find, harness } = mount(async url => {
    const href = String(url);
    if (href.includes('/download')) {
      downloadCalls += 1;
      return { json: async () => ({ ok: true, downloaded: true, version: 2, appliedSessions: [] }) };
    }
    if (href.includes('/restart')) {
      restartCalls += 1;
      return { json: async () => ({ ok: true, restarted: true, mode: 'helper' }) };
    }
    if (href.includes('/check')) {
      return {
        json: async () => ({
          ok: true,
          remote: { inSync: false, localDirty: false, remoteVersion: 2, remoteUpdatedAt: now },
        }),
      };
    }
    return {
      json: async () =>
        statusPayload({
          configured: true,
          remote: 'ssh://git@example/srv/git/dsh-sync.git',
          local: { version: 1, baseSha: 'abc', updatedAt: now, pending: [] },
        }),
    };
  });
  const dock = find('sidebar.footer.action');
  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 80));

  assert.equal(downloadCalls, 0, '打开页面不应自动下载');
  assert.equal(restartCalls, 0, '打开页面不应自动重启');
  const tree = draw(harness, dock.component);
  assert.equal(buttonByLabel(tree, '下载').props.disabled, false);
});

test('点重启先弹确认框，确认后才请求重启', async () => {
  let restartCalls = 0;
  const { find, harness, registered } = mount(async url => {
    if (String(url).includes('/restart')) {
      restartCalls += 1;
      return { json: async () => ({ ok: true, restarted: false, message: '当前宿主不能自动重启' }) };
    }
    return {
      json: async () =>
        statusPayload({
          configured: true,
          remote: 'ssh://git@example/srv/git/dsh-sync.git',
          local: { version: 1, baseSha: 'abc', updatedAt: Date.now(), pending: [] },
        }),
    };
  });
  const dock = find('sidebar.footer.action');
  const confirm = registered.find(item => item.meta.id === 'dsh-ownsync-restart-confirm');
  assert.ok(confirm, '没有注册重启确认框');
  assert.equal(confirm.component({}), null);

  draw(harness, dock.component);
  await new Promise(resolve => setTimeout(resolve, 20));

  let tree = draw(harness, dock.component);
  tree.children[1].children[1].props.onClick();

  let dialog = confirm.component({});
  assert.ok(dialog, '点重启后应弹出确认框');
  assert.match(texts(dialog), /重启 DSH？/);
  assert.equal(restartCalls, 0);

  buttonByLabel(dialog, '取消').props.onClick();
  assert.equal(confirm.component({}), null);
  assert.equal(restartCalls, 0);

  tree = draw(harness, dock.component);
  tree.children[1].children[1].props.onClick();
  dialog = confirm.component({});
  buttonByLabel(dialog, '重启').props.onClick();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(restartCalls, 1);
});

test('设置里可以关闭自动上传', async () => {
  const calls = [];
  const { find, harness } = mount(async (url, options) => {
    if (String(url).includes('/config')) {
      calls.push(JSON.parse(options.body));
      return {
        json: async () => ({
          ok: true,
          config: { autoUpload: false },
          status: statusPayload({ configured: true, autoUpload: false }),
        }),
      };
    }
    return { json: async () => statusPayload({ configured: true }) };
  });
  const section = find('settings.section');
  const tree = draw(harness, section.component);

  const checkboxes = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'input' && node.props?.type === 'checkbox') checkboxes.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(tree);
  assert.equal(checkboxes.length, 1, '设置里只应剩自动上传一个开关');
  assert.equal(checkboxes[0].props.checked, true);

  checkboxes[0].props.onChange({ target: { checked: false } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].autoUpload, false);
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
