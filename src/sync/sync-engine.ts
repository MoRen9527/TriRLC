// ── TriRLC Cloud Sync Engine ──
// Core sync engine for TriRLC → TriMMC single-direction session sync (Phase 1).
//
// Responsibilities:
//   1. Single session sync: syncSessionToTriMMC()
//   2. Batch sync: syncPendingSessions()
//   3. State machine gate: sync_status transition guard
//   4. 409 dedup handling
//   5. Message truncation logging
//
// State machine (from arch-trilc-daemon §6.4):
//   local ──(new messages)──→ pending ──(user trigger)──→ syncing ──(200)──→ synced
//                                                        ──(failure)──→ error
//   synced ──(new messages)──→ pending
//   error ──(manual retry)──→ pending

import type { SessionRecord } from '../session-store/types.js';
import type {
  SyncResult,
  BatchSyncResult,
  SyncEngineConfig,
  SyncRequestPayload,
  SyncSuccessResponse,
  SyncConflictResponse,
  SyncErrorResponse,
} from './types.js';
import { DEFAULT_SYNC_CONFIG } from './types.js';
import { buildSyncPayload, type SyncMessageInput } from './payload-builder.js';
import { fetchWithRetry } from './retry.js';

export interface SyncEngineDeps {
  /** session-store 实例（只需同步相关方法） */
  store: {
    getSession(id: string): SessionRecord | null;
    getMessages(sessionId: string): SyncMessageInput[];
    updateSyncStatus(
      id: string,
      syncStatus: string,
      cloudSessionId?: string | null,
    ): void;
    getPendingSyncSessions(limit?: number): SessionRecord[];
  };
  config: SyncEngineConfig;
}

/**
 * 单会话同步到 TriMMC。
 *
 * 状态机门禁：
 *   - 仅接受 status 为 'pending' 或 'error' 的会话
 *   - 'syncing' 状态拒绝（已在同步中）
 *   - 'synced' 或 'local' 跳过（前者已同步，后者无新消息）
 *
 * 409 Conflict 处理：
 *   - TriMMC 返回 409 → 说明 (nodeId, localSessionId) 已存在
 *   - 使用 existingCloudSessionId 标记本地会话为 'synced'
 *   - 返回 ok: true（视为成功）
 *
 * 重试策略（通过 fetchWithRetry）：
 *   - 网络错误 / 超时 / 5xx → 最多 3 次重试，退避 1s/2s/4s
 *   - 4xx（除 409）→ 不重试，直接标记 error
 *   - 全部重试耗尽 → 标记 error，返回 ok: false
 */
export async function syncSessionToTriMMC(
  sessionId: string,
  deps: SyncEngineDeps,
): Promise<SyncResult> {
  // ── 1. 加载会话 + 状态机门禁 ──
  const session = deps.store.getSession(sessionId);
  if (!session) {
    return { ok: false, error: 'session_not_found' };
  }

  const currentStatus = session.syncStatus ?? 'local';

  // 已在同步中 → 拒绝
  if (currentStatus === 'syncing') {
    return { ok: false, error: 'already_syncing' };
  }

  // 不需要同步的状态
  if (currentStatus === 'local' || currentStatus === 'synced') {
    return {
      ok: true,
      cloudSessionId: session.cloudSessionId ?? undefined,
      syncedMessageCount: 0,
    };
  }

  // 只接受 pending 和 error（手动重试）
  if (currentStatus !== 'pending' && currentStatus !== 'error') {
    return { ok: false, error: `invalid_sync_status: ${currentStatus}` };
  }

  // ── 2. 标记为 syncing ──
  deps.store.updateSyncStatus(sessionId, 'syncing');

  // ── 3. 读取消息并构建 payload ──
  const messages = deps.store.getMessages(sessionId);
  const maxMessages = deps.config.maxMessages ?? DEFAULT_SYNC_CONFIG.maxMessages;
  const { payload, truncated } = buildSyncPayload(session, messages, deps.config.nodeId, maxMessages);

  if (truncated) {
    console.warn(
      `[sync-engine] session ${sessionId}: ${messages.length} messages truncated to ${maxMessages} for sync`,
    );
  }

  // ── 4. 发送 HTTP POST（带重试） ──
  const url = `${deps.config.trimcBaseUrl}/internal/v1/sessions/sync`;
  const timeoutMs = deps.config.timeoutMs ?? DEFAULT_SYNC_CONFIG.timeoutMs;
  const backoffs = deps.config.retryBackoffs ?? DEFAULT_SYNC_CONFIG.retryBackoffs;

  try {
    const { response, retried } = await fetchWithRetry(url, payload, {
      backoffs,
      timeoutMs,
    });

    // ── 5a. 409 Conflict：去重，视为成功 ──
    if (response.status === 409) {
      const data = (await response.json()) as SyncConflictResponse;
      deps.store.updateSyncStatus(sessionId, 'synced', data.existingCloudSessionId);
      return {
        ok: true,
        cloudSessionId: data.existingCloudSessionId,
        syncedMessageCount: messages.length,
        retried,
      };
    }

    // ── 5b. 200 OK：同步成功 ──
    if (response.ok) {
      const data = (await response.json()) as SyncSuccessResponse;
      deps.store.updateSyncStatus(sessionId, 'synced', data.cloudSessionId);
      return {
        ok: true,
        cloudSessionId: data.cloudSessionId,
        syncedMessageCount: data.syncedMessageCount,
        retried,
      };
    }

    // ── 5c. 其他 HTTP 错误（非可重试 4xx）──
    const errorBody = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    deps.store.updateSyncStatus(sessionId, 'error');
    return {
      ok: false,
      error: (errorBody as SyncErrorResponse).message || `HTTP ${response.status}`,
      retried,
    };
  } catch (err) {
    // ── 5d. 全部重试耗尽 / 不可重试错误 ──
    deps.store.updateSyncStatus(sessionId, 'error');
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retried: true,
    };
  }
}

/**
 * 批量同步所有 pending 会话。
 * 用于用户手动触发"全部同步"或定时后台任务。
 *
 * 顺序执行（避免并发压 TriMMC）。
 */
export async function syncPendingSessions(
  deps: SyncEngineDeps,
  limit = 50,
): Promise<BatchSyncResult> {
  const pending = deps.store.getPendingSyncSessions(limit);

  const results: BatchSyncResult['results'] = [];
  let synced = 0;
  let failed = 0;

  // 顺序执行（避免并发压 TriMMC）
  for (const session of pending) {
    const result = await syncSessionToTriMMC(session.id, deps);
    results.push({
      sessionId: session.id,
      ok: result.ok,
      cloudSessionId: result.cloudSessionId,
      error: result.error,
    });
    if (result.ok) synced++;
    else failed++;
  }

  return { total: pending.length, synced, failed, results };
}
