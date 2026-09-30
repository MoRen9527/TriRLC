// ── TriRLC Sync Retry Logic ──
// Job: Exponential backoff retry for fetch requests to TriMMC.
//
// Retry judgment rules (9 error classifications):
//   - Network error (fetch throws)               → retry
//   - Timeout (AbortError / DOMException)        → retry
//   - HTTP 500-599                               → retry
//   - HTTP 429 (rate limit)                      → retry
//   - DNS resolution failure                     → retry
//   - HTTP 413 (Payload Too Large)               → NO retry
//   - HTTP 409 (Conflict / duplicate)            → NO retry (handled by engine)
//   - HTTP 400, 401, 403, 404                    → NO retry (client errors)
//   - Non-retryable unknown errors               → NO retry

import type { SyncRequestPayload } from './types.js';

export interface RetryConfig {
  backoffs: number[];   // 退避序列，如 [1000, 2000, 4000]
  timeoutMs: number;
}

export interface RetryAttempt {
  attempt: number;       // 从 1 开始
  delayMs: number;       // 本次尝试前的等待时间（第一次为 0）
}

/**
 * 判断 HTTP 状态码是否可重试。
 *
 * 重试: 5xx（服务器临时故障）、429（限流）
 * 不重试: 4xx（客户端错误，重试无意义）
 */
export function isRetryable(status: number): boolean {
  // 5xx 可重试（服务器临时故障）
  if (status >= 500 && status < 600) return true;
  // 429 可重试（限流）
  if (status === 429) return true;
  // 4xx 不可重试（客户端错误，重试无意义）
  return false;
}

/**
 * 判断是否是超时错误。
 * Node 22 的 AbortSignal.timeout() 触发时，fetch 抛出 DOMException(name='AbortError')。
 */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * 带重试的 fetch 包装。
 *
 * 退避序列：backoffs[0], backoffs[1], ... — 共 backoffs.length + 1 次 HTTP 调用。
 * 默认退避：[1000, 2000, 4000] → 共 4 次尝试，总耗时 ≤ 7s + 超时×4。
 *
 * @param url   TriMMC 端点 URL
 * @param body  同步 payload
 * @param config  重试配置（退避序列 + 超时）
 * @returns 最后一次响应 + retried 标记
 * @throws 全部重试耗尽时抛出最后一次错误
 */
export async function fetchWithRetry(
  url: string,
  body: SyncRequestPayload,
  config: RetryConfig,
): Promise<{
  response: Response;
  retried: boolean;
}> {
  let lastError: unknown = null;
  let retried = false;

  for (let i = 0; i < config.backoffs.length + 1; i++) {
    // 非首次尝试：等待退避时间
    if (i > 0) {
      retried = true;
      const delayMs = config.backoffs[i - 1];
      await sleep(delayMs);
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      // 409 Conflict：直接返回（不当作错误）
      if (res.status === 409) {
        return { response: res, retried };
      }

      // 可重试错误：继续循环
      if (!res.ok && isRetryable(res.status)) {
        lastError = new Error(`HTTP ${res.status}: ${res.statusText}`);
        continue;
      }

      // 其他情况（2xx 或不可重试的 4xx/5xx）：直接返回
      return { response: res, retried };
    } catch (err) {
      // 网络错误或超时：重试
      lastError = err;
      continue;
    }
  }

  // 全部重试耗尽
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
