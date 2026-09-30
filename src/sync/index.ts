// ── TriRLC Sync Engine Index ──
// 会话云同步：TriRLC → TriMMC 单向推送（Phase 1）

export { syncSessionToTriMMC, syncPendingSessions } from './sync-engine.js';
export type { SyncEngineDeps } from './sync-engine.js';
export { buildSyncPayload } from './payload-builder.js';
export type { SyncMessageInput } from './payload-builder.js';
export { fetchWithRetry, isRetryable, isTimeoutError } from './retry.js';
export type { RetryConfig, RetryAttempt } from './retry.js';
export type {
  SyncResult,
  BatchSyncResult,
  SyncEngineConfig,
  SyncRequestPayload,
  SyncMessagePayload,
  SyncSuccessResponse,
  SyncConflictResponse,
  SyncUnavailableResponse,
  SyncErrorResponse,
} from './types.js';
export { DEFAULT_SYNC_CONFIG } from './types.js';
