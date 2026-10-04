// ── TriRLC Sync Engine Types ──
// Session cloud sync: TriRLC → TriMMC (Phase 1 single-direction)
//
// 17 type contracts across this module:
//   types.ts:     SyncResult, BatchSyncResult, SyncEngineConfig, SyncRequestPayload,
//                 SyncMessagePayload, SyncSuccessResponse, SyncConflictResponse,
//                 SyncUnavailableResponse, SyncErrorResponse, DEFAULT_SYNC_CONFIG (10)
//   retry.ts:     RetryConfig, RetryAttempt (2)
//   sync-engine.ts: SyncEngineDeps (1)
//   + 5 function contracts: buildSyncPayload, fetchWithRetry, syncSessionToTriMMC,
//                            syncPendingSessions, isRetryable/isTimeoutError

/** 单次同步操作结果 */
export interface SyncResult {
  ok: boolean;
  cloudSessionId?: string;     // 成功时 TriMMC 返回的云端 ID
  syncedMessageCount?: number;  // 成功时同步消息数
  error?: string;               // 失败时的错误信息
  retried?: boolean;            // 是否经历了重试
}

/** 批量同步结果 */
export interface BatchSyncResult {
  total: number;
  synced: number;
  failed: number;
  results: Array<{ sessionId: string; ok: boolean; cloudSessionId?: string; error?: string }>;
}

/** 同步引擎配置 */
export interface SyncEngineConfig {
  /** TriMMC base URL，如 "http://127.0.0.1:8710" */
  trimcBaseUrl: string;
  /** 本节点 ID */
  nodeId: string;
  /** 消息截断上限（默认 5000） */
  maxMessages?: number;
  /** 请求超时毫秒（默认 30000） */
  timeoutMs?: number;
  /** 重试退避序列（默认 [1000, 2000, 4000]） */
  retryBackoffs?: number[];
}

/** 默认配置 */
export const DEFAULT_SYNC_CONFIG: Required<SyncEngineConfig> = {
  trimcBaseUrl: 'http://127.0.0.1:8710',
  nodeId: 'trilc-unknown',
  maxMessages: 5000,
  timeoutMs: 30_000,
  retryBackoffs: [1000, 2000, 4000],
};

/**
 * 构建发送给 TriMMC 的同步 payload。
 * nodeId + localSessionId 组成幂等键。
 */
export interface SyncRequestPayload {
  nodeId: string;
  syncType: 'full';              // Phase 1 仅支持全量同步
  session: {
    localSessionId: string;
    title: string;
    status: string;              // session status 枚举值
    createdAt: string;           // ISO 8601
    updatedAt: string;
    messages: SyncMessagePayload[];
  };
  syncedAt: string;              // ISO 8601
}

export interface SyncMessagePayload {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  timestamp: string;
  toolCalls?: Array<{
    toolName: string;
    input: Record<string, unknown>;
    output?: string;
    durationMs?: number;
  }> | null;
  toolCallId?: string | null;
}

/** TriMMC 200 OK 响应 */
export interface SyncSuccessResponse {
  ok: true;
  cloudSessionId: string;
  localSessionId: string;
  syncedMessageCount: number;
  syncedAt: string;
}

/** TriMMC 409 Conflict 响应（去重） */
export interface SyncConflictResponse {
  ok: false;
  error: 'duplicate_session';
  message: string;
  existingCloudSessionId: string;
}

/** TriMMC 503 不可用响应 */
export interface SyncUnavailableResponse {
  ok: false;
  error: 'service_unavailable';
  message: string;
}

/** TriMMC 错误响应联合类型 */
export type SyncErrorResponse =
  | SyncConflictResponse
  | SyncUnavailableResponse
  | { ok: false; error: string; message: string };
