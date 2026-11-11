/**
 * 本机 HTTP 接口的入口防护。
 *
 * 接口只服务于 DSH 自己的页面：跨站来源、非 JSON 的写请求、过大的请求体都会被拒绝。
 * 没有浏览器头部的调用（命令行、测试）不受影响。
 */
export const MAX_REQUEST_BYTES = 1024 * 1024;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

/** 返回拒绝原因；可以放行时返回 null。 */
export function requestRejection(request) {
  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') return null;
  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 'cross-site';
  const origin = headers.origin;
  if (origin === 'null') return 'opaque-origin';
  if (origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return 'invalid-origin';
    }
    const host = String(headers.host || '').toLowerCase();
    if (/^https?:$/.test(parsed.protocol) && host && parsed.host.toLowerCase() !== host) return 'cross-origin';
  }
  if (request.method && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const length = Number(headers['content-length'] || 0);
    const hasBody = length > 0 || Boolean(headers['transfer-encoding']);
    if (length > MAX_REQUEST_BYTES) return 'too-large';
    if (hasBody && !/^application\/json\s*(?:;|$)/i.test(String(headers['content-type'] || ''))) return 'content-type';
  }
  return null;
}

export function json(response, code, payload) {
  response.writeHead(code, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

/** 读完整个请求体再解码：多字节字符可能跨分块。 */
export function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on('data', chunk => {
      if (failed) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_REQUEST_BYTES) {
        failed = true;
        reject(new Error('请求内容过大'));
        return;
      }
      chunks.push(buffer);
    });
    request.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

/**
 * 把路由挂到宿主 webServer 上，统一套用来源校验与响应格式。
 * 处理函数返回对象 → 200 `{ok:true, ...}`；抛错 → 200 `{ok:false, error, message}`。
 */
export function registerRoutes(webServer, routes, disposers) {
  const failures = [];
  for (const route of routes) {
    try {
      const dispose = webServer.register({
        kind: 'exact',
        path: route.path,
        handler: async (request, response) => {
          try {
            const rejection = requestRejection(request);
            if (rejection) {
              json(response, rejection === 'too-large' ? 413 : rejection === 'content-type' ? 415 : 403, {
                ok: false,
                error: 'rejected',
                message: '请求来源或格式不被接受 (' + rejection + ')',
              });
              return;
            }
            const method = String(request.method || 'GET').toUpperCase();
            if (method !== route.method) {
              json(response, 405, { ok: false, error: 'method-not-allowed', message: '只支持 ' + route.method });
              return;
            }
            let body = {};
            if (route.method !== 'GET') {
              const text = await readBody(request);
              if (text.trim()) {
                try {
                  body = JSON.parse(text);
                } catch {
                  json(response, 400, { ok: false, error: 'bad-json', message: '请求内容不是合法 JSON' });
                  return;
                }
              }
            }
            const result = await route.handler({ body, request });
            json(response, 200, { ok: !result?.error, ...result });
          } catch (error) {
            json(response, 200, { ok: false, error: 'failed', message: String(error?.message || error) });
          }
        },
      });
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      failures.push({ path: route.path, message: String(error?.message || error) });
    }
  }
  return failures;
}
