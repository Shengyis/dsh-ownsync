/**
 * 会话文件的路径契约。
 *
 * DSH 的会话目录形如 `sessions/<分组>/<会话 id>/session[.vN].jsonl[.zstd]`：
 * - 会话 id 是 UUID，可能带 `cli-`、`acp-` 之类的前缀；
 * - `.vN` 是格式代际，没有后缀表示第 0 代；
 * - `.jsonl.zstd` 表示整份日志被压缩，代际与是否压缩无关。
 *
 * 这里只做字符串判断，不碰文件系统。
 */
const ID_SOURCE = '(?:[a-z][a-z0-9_-]{0,63}-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export const sessionIdPattern = new RegExp('^' + ID_SOURCE + '$', 'i');

const LOG_PATH_PATTERN = new RegExp(
  '^sessions/[^/]+/(' + ID_SOURCE + ')/(?:session|log)(?:\\.v\\d+)?\\.jsonl(?:\\.zstd)?$',
  'i',
);

/** 会话日志路径 → 会话 id；不是会话日志返回 null。 */
export function sessionIdOfLogPath(file) {
  return LOG_PATH_PATTERN.exec(String(file || '').replace(/\\/g, '/'))?.[1] ?? null;
}

/** 日志代际：`.vN` → N，无后缀 → 0，无法识别 → null。 */
export function sessionLogGeneration(file) {
  const match = /(?:^|\/)(?:session|log)(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/i.exec(
    String(file || '').replace(/\\/g, '/'),
  );
  if (!match) return null;
  const version = Number(match[1] ?? 0);
  return Number.isSafeInteger(version) ? version : null;
}

/** 同一个会话可能并存多代日志，只有最高代是"当前"的那份。 */
export function pickHighestGeneration(files) {
  const best = new Map();
  for (const file of files) {
    const id = sessionIdOfLogPath(file);
    if (!id) continue;
    const generation = sessionLogGeneration(file);
    if (generation === null) throw new Error('无法识别会话日志代际: ' + file);
    const current = best.get(id);
    if (!current || generation > current.generation) best.set(id, { generation, file });
    else if (generation === current.generation && file !== current.file)
      throw new Error('同一会话存在两份同代日志, 无法确定哪份有效: ' + id);
  }
  return best;
}
