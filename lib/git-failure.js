/**
 * 把 Git 的报错翻译成「原因 + 下一步」。
 *
 * 用户看到的不该是 `fatal: could not read Username for 'https://…'`，
 * 而是「服务器要求登录，但这台电脑还没有可用凭据」。
 */
import path from 'node:path';

const RULES = [
  {
    kind: 'auth',
    test: /could not read Username|could not read Password|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|no such identity|returned error: 40[13]\b/i,
    reason: '服务器要求登录，但这台电脑没有可用凭据',
    hint: '先在终端里执行一次 git ls-remote <仓库地址> 完成登录（HTTPS 输入账号与访问令牌，SSH 配置好密钥），再回来重试。',
  },
  {
    kind: 'network',
    test: /Could not resolve host|Failed to connect|Connection timed out|Connection refused|Network is unreachable|SSL certificate problem|TLS|proxy/i,
    reason: '连不上同步服务器',
    hint: '检查地址、端口、网络或代理；服务器在内网时要先连上内网。',
  },
  {
    kind: 'missing',
    test: /repository not found|does not appear to be a git repository|not found|No such file or directory/i,
    reason: '服务器上找不到这个仓库',
    hint: '确认仓库已经在服务器上执行过 git init --bare，且地址拼写正确。',
  },
  {
    kind: 'stale',
    test: /stale info|\[rejected\]|non-fast-forward|failed to push some refs|fetch first/i,
    reason: '服务器上的内容已经变了',
    hint: '另一台电脑在这之前上传过，请先点「下载」，确认内容后再上传。',
  },
  {
    kind: 'repo-locked',
    test: /cannot lock ref|Unable to create .*\.lock|index\.lock|shallow\.lock|refs.*\.lock/i,
    reason: '本地同步仓库被占用或有残留锁',
    hint: '稍等再试；如果持续出现，删除本机数据目录下的 .ownsync/repo.git 后重新检查（内容会从服务器重新取回）。',
  },
  {
    kind: 'permission',
    test: /Permission denied|Read-only file system|EBUSY|EPERM/i,
    reason: '本机文件无法写入',
    hint: '关掉占用该文件的程序（或安全软件），再重试。',
  },
];

/**
 * @param {{stderr?: string, stdout?: string, code?: number|null, timedOut?: boolean}} result
 * @returns {{kind: string, reason: string, hint: string, detail: string}}
 */
export function describeGitFailure(result) {
  const detail = String(result?.stderr || result?.stdout || '').trim();

  // 命令根本没起来：最常见的是这台电脑没装 Git，或者 DSH 的 PATH 里没有它
  if (result?.spawnError) {
    const shown = String(process.env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .slice(0, 6)
      .join('；');
    const hint =
      result.spawnError === 'EACCES'
        ? 'git 存在但不能执行（权限不足）。请检查 Git 安装目录的权限，或重新安装 Git for Windows。'
        : '请安装 Git for Windows（https://git-scm.com/download/win），装好后完全退出并重新打开 DSH。' +
          '如果已经装过，确认 git.exe 在 PATH 里。当前 PATH 前几项：' +
          (shown || '（空）');
    return { kind: 'git-missing', reason: '这台电脑上找不到 git 命令', hint, detail: detail || result.spawnError };
  }

  if (result?.timedOut)
    return {
      kind: 'timeout',
      reason: 'Git 操作超时',
      hint: '检查网络后重试；如果仓库很大，第一次取回会比较慢。',
      detail,
    };
  for (const rule of RULES) {
    if (!rule.test.test(detail)) continue;
    return { kind: rule.kind, reason: rule.reason, hint: rule.hint, detail };
  }
  const first = detail.split('\n').map(line => line.trim()).filter(Boolean)[0] || '未知错误';
  return { kind: 'unknown', reason: 'Git 操作失败', hint: '把下面的原始报错发给我，或先在终端里手动跑一次同样的命令。', detail: first };
}

/** 一条可以直接放进结果/界面的短句。 */
export function failureText(failure) {
  return failure.reason + (failure.hint ? '。' + failure.hint : '');
}
