// ── TriRLC Session Store Types ──
// Defines session persistence model for agent conversation recovery.
// Shared-core candidate: TriMMC should adopt same schema for cross-runtime session portability.
//
// Schema v2 (2026-07-22): cloud sync fields added per arch-trilc-daemon §6.

export type SessionStatus = 'active' | 'completed' | 'interrupted' | 'error' | 'expired';

/** Cloud sync status for session replication to TriMMC. */
export type SyncStatus = 'local' | 'pending' | 'syncing' | 'synced' | 'error';

export interface SessionRecord {
  id: string;                    // "sess_{timestamp36}_{random4}"
  status: SessionStatus;
  model: string;
  systemPrompt: string;
  cwd: string;
  messageCount: number;
  createdAt: string;             // ISO 8601
  updatedAt: string;
  closedAt: string | null;
  // v2: cloud sync fields
  title?: string;                // session title (first user message truncated)
  syncStatus?: SyncStatus;       // default 'local'
  lastSyncedAt?: string | null;  // ISO 8601
  cloudSessionId?: string | null;// TriMMC cloud session ID
}

export interface SessionMessageRecord {
  id: number;                    // autoincrement
  sessionId: string;
  seq: number;                   // monotonic within session
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls: string | null;      // JSON-serialized tool_calls array
  toolCallId: string | null;     // for tool result messages
  reasoningContent: string | null;
  createdAt: string;
}

export interface SessionSummary {
  session: SessionRecord;
  messageCount: number;
  lastUserMessage: string | null;
  hasToolCalls: boolean;
  hasEmptyAssistant: boolean;    // true if any assistant msg lacks both content and tool_calls
}

export interface RecoveryResult {
  ok: boolean;
  session: SessionRecord | null;
  messages: SessionMessageRecord[] | null;
  safetyReport: WorkTreeSafetyReport;
  warnings: string[];
}

export interface WorkTreeSafetyReport {
  cwd: string;
  hasUncommittedChanges: boolean;
  changedFiles: string[];
  typeCheckPassed: boolean | null;  // null if no type checker available
  riskLevel: 'low' | 'medium' | 'high';
}
