/**
 * 重启宿主。
 *
 * 宿主在 Electron 里时优先用 app.relaunch() + app.quit()；
 * require 拿不到时再试 ESM 的 import('electron')（Electron 新版本对 ESM 有单独入口）。
 * 都拿不到就返回宿主形态，交给界面提示手动重启。
 */
import { createRequire } from 'node:module';

function hostShape() {
  return {
    execPath: process.execPath,
    argv: process.argv.slice(0, 4),
    electron: process.versions.electron || null,
    node: process.versions.node || null,
    type: process.type || null,
    platform: process.platform,
    parentPid: process.ppid || null,
  };
}

async function findApp(host) {
  const errors = [];

  try {
    const require = createRequire(import.meta.url);
    const electron = require('electron');
    if (electron?.app) return { app: electron.app };
    if (electron && typeof electron === 'object') host.requiredKeys = Object.keys(electron).slice(0, 10);
  } catch (error) {
    errors.push('require: ' + String(error?.message || error));
  }

  try {
    const electron = await import('electron');
    const app = electron?.app || electron?.default?.app || null;
    if (app) return { app };
    const keys = Object.keys(electron || {}).slice(0, 10);
    if (keys.length) host.importedKeys = keys;
  } catch (error) {
    errors.push('import: ' + String(error?.message || error));
  }

  host.requireError = errors.join('；') || null;
  return { app: null };
}

export async function restartHost(log = () => {}) {
  const host = hostShape();
  const { app } = await findApp(host);

  if (app && typeof app.relaunch === 'function' && typeof app.quit === 'function') {
    try {
      app.relaunch();
      setTimeout(() => {
        try {
          app.quit();
        } catch (error) {
          log('warn', '退出宿主失败：' + String(error?.message || error));
        }
      }, 300);
      return { restarted: true, mode: 'electron', host };
    } catch (error) {
      host.requireError = 'relaunch: ' + String(error?.message || error);
    }
  }

  log(
    'info',
    '宿主不支持自动重启（electron=' +
      (host.electron || '无') +
      '，type=' +
      (host.type || '未知') +
      '，execPath=' +
      host.execPath +
      '，错误=' +
      (host.requireError || '无') +
      '）',
  );
  return {
    restarted: false,
    mode: 'manual',
    host,
    message: '当前宿主不能自动重启，请完全退出 DSH 后重新打开。',
  };
}
