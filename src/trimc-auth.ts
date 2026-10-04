/**
 * trimc-auth — TriMMC /internal/* token 鉴权全局 fetch 包装（P0 加固配套，2026-08-25）。
 *
 * 服务器 TriMMC 已启用 TRIMC_INTERNAL_TOKEN 强制校验（TriMMC 9fc919e）。本模块在
 * 进程启动时安装一次全局 fetch 包装：凡请求 TRIMC_BASE_URL 主机的 /internal/
 * 路径，自动附加 X-Internal-Token 头——单点覆盖全部 181+ 调用面（含未来新增），
 * 各调用点无需感知 token 存在与否（未配置时零行为变化）。
 */

const INSTALLED_FLAG = Symbol.for('trilc.trimcAuthInstalled');

export function installTrimcTokenFetch(env: NodeJS.ProcessEnv = process.env): void {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[INSTALLED_FLAG]) return;
  g[INSTALLED_FLAG] = true;

  const base = (env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710').replace(/\/$/, '');
  let host = '';
  try {
    host = new URL(base).host;
  } catch {
    return; // base 非法则不包装
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? new URL(input, base) : input instanceof URL ? input : new URL(input.url);
      if (
        url.host === host &&
        url.pathname.startsWith('/internal/') &&
        !(init?.headers && hasInternalToken(init.headers)) &&
        !('x-internal-token' in (input instanceof Request ? Object.fromEntries(input.headers.entries()) : {}))
      ) {
        const token = env.TRIMC_INTERNAL_TOKEN;
        if (token) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          headers.set('X-Internal-Token', token);
          return original(input, { ...init, headers });
        }
      }
    } catch {
      /* 解析失败按原样透传 */
    }
    return original(input, init);
  };
}

function hasInternalToken(headers: HeadersInit): boolean {
  if (headers instanceof Headers) return headers.has('x-internal-token');
  if (Array.isArray(headers)) return headers.some(([k]) => k.toLowerCase() === 'x-internal-token');
  return Object.keys(headers).some((k) => k.toLowerCase() === 'x-internal-token');
}
