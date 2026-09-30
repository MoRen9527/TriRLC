// ── TriRLC Session Store (SQLite) ──
// Persists agent conversation sessions for recovery after abnormal interruption.
// Uses Node 22 built-in node:sqlite (same pattern as event-queue store).
//
// Schema:
//   sessions: metadata + status tracking + cloud sync fields (v2)
//   session_messages: ordered message history with full field preservation
//
// Key behaviors:
//   - Auto-save on agent-loop completion (all messages flushed at once)
//   - Interrupted sessions detected via status='active' without close event
//   - Empty assistant message detection tracked in hasEmptyAssistant flag
//   - Reasoning content preserved for DeepSeek reasoning model compatibility
//   - Schema version tracked via PRAGMA user_version (v1 → v2 on first open)

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  SessionRecord,
  SessionMessageRecord,
  SessionStatus,
  SyncStatus,
  SessionSummary,
} from './types.js';

const CURRENT_SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  reasoning_content TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_msgs_session ON session_messages(session_id, seq);
`;

// CTO-009-4: cloud sync schema migration — Phase 1 TriRLC→TriMMC single-direction push.
// Uses ALTER TABLE ADD COLUMN (no table rebuild) — safe on existing data.
const MIGRATIONS: Record<number, string> = {
  2: `
    ALTER TABLE sessions ADD COLUMN title TEXT;
    ALTER TABLE sessions ADD COLUMN sync_status TEXT DEFAULT 'local';
    ALTER TABLE sessions ADD COLUMN last_synced_at TEXT;
    ALTER TABLE sessions ADD COLUMN cloud_session_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_sessions_sync ON sessions(sync_status, updated_at);
  `,
};

export function createSessionStore(dbPath: string) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(DDL);

  // ── Schema migration ──
  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    for (let v = currentVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
      if (MIGRATIONS[v]) {
        db.exec(MIGRATIONS[v]);
      }
    }
    db.prepare(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION}`).run();
    console.log(`[session-store] migrated schema v${currentVersion} → v${CURRENT_SCHEMA_VERSION}`);
  }

  // ── Prepared statements ──

  const insertSessionStmt = db.prepare(`
    INSERT OR REPLACE INTO sessions
      (id, status, model, system_prompt, cwd, message_count, created_at, updated_at, title)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
  `);

  const updateSessionStmt = db.prepare(`
    UPDATE sessions SET
      status = ?, message_count = ?, updated_at = datetime('now'), closed_at = ?
    WHERE id = ?
  `);

  const updateSyncStatusStmt = db.prepare(`
    UPDATE sessions SET
      sync_status = ?, last_synced_at = ?, cloud_session_id = ?
    WHERE id = ?
  `);

  const setPendingSyncStmt = db.prepare(`
    UPDATE sessions SET sync_status = 'pending'
    WHERE id = ? AND sync_status IN ('local', 'synced')
  `);

  const insertMessageStmt = db.prepare(`
    INSERT INTO session_messages
      (session_id, seq, role, content, tool_calls, tool_call_id, reasoning_content)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // ── Session CRUD ──

  function createSession(params: {
    id: string;
    model: string;
    systemPrompt?: string;
    cwd?: string;
    title?: string;
  }): SessionRecord {
    insertSessionStmt.run(
      params.id,
      'active',
      params.model,
      params.systemPrompt ?? '',
      params.cwd ?? '',
      0,
      params.title ?? null,
    );
    return getSession(params.id)!;
  }

  function getSession(id: string): SessionRecord | null {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  function updateSessionStatus(
    id: string,
    status: SessionStatus,
    messageCount?: number,
  ): void {
    const closedAt = status === 'completed' || status === 'interrupted' || status === 'error'
      ? new Date().toISOString()
      : null;
    const count = messageCount ?? getMessageCount(id);
    updateSessionStmt.run(status, count, closedAt, id);
  }

  function listSessions(filter?: {
    status?: SessionStatus;
    limit?: number;
    offset?: number;
  }): SessionRecord[] {
    let sql = 'SELECT * FROM sessions WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    sql += ' ORDER BY updated_at DESC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    if (filter?.offset) {
      sql += ' OFFSET ?';
      params.push(filter.offset);
    }
    const rows = (db.prepare(sql).all as (...args: unknown[]) => unknown[])(...params) as unknown as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  // ── Message CRUD ──

  function saveMessages(
    sessionId: string,
    messages: Array<{
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string | null;
      toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> | null;
      toolCallId?: string | null;
      reasoningContent?: string | null;
    }>,
  ): void {
    const existingCount = getMessageCount(sessionId);
    db.exec('BEGIN');
    try {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        insertMessageStmt.run(
          sessionId,
          existingCount + i + 1,
          msg.role,
          msg.content,
          msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          msg.toolCallId ?? null,
          msg.reasoningContent ?? null,
        );
      }
      // Update session metadata
      const newCount = existingCount + messages.length;
      const hasEmptyAssistant = messages.some(
        (m) => m.role === 'assistant' && !m.content && (!m.toolCalls || m.toolCalls.length === 0),
      );
      updateSessionStmt.run(
        hasEmptyAssistant ? 'interrupted' : 'active',
        newCount,
        null,
        sessionId,
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getMessages(sessionId: string): SessionMessageRecord[] {
    const rows = db
      .prepare('SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq')
      .all(sessionId) as unknown as Record<string, unknown>[];
    return rows.map(rowToMessage);
  }

  function getMessageCount(sessionId: string): number {
    const row = db
      .prepare('SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = ?')
      .get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  // ── Recovery helpers ──

  function findInterruptedSessions(): SessionRecord[] {
    const rows = db
      .prepare("SELECT * FROM sessions WHERE status = 'active' OR status = 'interrupted' ORDER BY updated_at DESC")
      .all() as unknown as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  function getSessionSummary(id: string): SessionSummary | null {
    const session = getSession(id);
    if (!session) return null;

    const messages = getMessages(id);
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    const hasToolCalls = messages.some((m) => m.toolCalls !== null);
    const hasEmptyAssistant = messages.some(
      (m) => m.role === 'assistant' && !m.content && !m.toolCalls,
    );

    return {
      session,
      messageCount: messages.length,
      lastUserMessage: lastUserMsg?.content ?? null,
      hasToolCalls,
      hasEmptyAssistant,
    };
  }

  // ── Maintenance ──

  function expireOldSessions(maxAgeHours = 72): number {
    const result = db
      .prepare(
        `UPDATE sessions SET status = 'expired'
         WHERE status IN ('active', 'interrupted')
         AND updated_at < datetime('now', ? || ' hours')`,
      )
      .run(String(-maxAgeHours));
    return Number(result.changes);
  }

  // ── Cloud sync (v2) ──

  function updateSyncStatus(
    id: string,
    syncStatus: SyncStatus,
    cloudSessionId?: string | null,
  ): void {
    const lastSyncedAt = syncStatus === 'synced' ? new Date().toISOString() : null;
    updateSyncStatusStmt.run(syncStatus, lastSyncedAt, cloudSessionId ?? null, id);
  }

  function markPendingSync(id: string): void {
    setPendingSyncStmt.run(id);
  }

  function getPendingSyncSessions(limit = 50): SessionRecord[] {
    const rows = db
      .prepare(
        `SELECT * FROM sessions WHERE sync_status = 'pending'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as unknown as Record<string, unknown>[];
    return rows.map(rowToSession);
  }

  function getSessionByCloudId(cloudSessionId: string): SessionRecord | null {
    const row = db
      .prepare('SELECT * FROM sessions WHERE cloud_session_id = ?')
      .get(cloudSessionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToSession(row);
  }

  // ── Deletion ──

  function deleteSession(id: string): boolean {
    const result = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  function close(): void {
    db.close();
  }

  return {
    createSession,
    getSession,
    updateSessionStatus,
    listSessions,
    saveMessages,
    getMessages,
    getMessageCount,
    findInterruptedSessions,
    getSessionSummary,
    expireOldSessions,
    deleteSession,
    updateSyncStatus,
    markPendingSync,
    getPendingSyncSessions,
    getSessionByCloudId,
    close,
  };
}

// ── Row mappers ──

function rowToSession(row: Record<string, unknown>): SessionRecord {
  return {
    id: row.id as string,
    status: row.status as SessionStatus,
    model: row.model as string,
    systemPrompt: (row.system_prompt as string) ?? '',
    cwd: (row.cwd as string) ?? '',
    messageCount: (row.message_count as number) ?? 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    closedAt: (row.closed_at as string) ?? null,
    // v2: cloud sync fields
    title: (row.title as string) ?? undefined,
    syncStatus: (row.sync_status as SyncStatus) ?? 'local',
    lastSyncedAt: (row.last_synced_at as string) ?? null,
    cloudSessionId: (row.cloud_session_id as string) ?? null,
  };
}

function rowToMessage(row: Record<string, unknown>): SessionMessageRecord {
  return {
    id: row.id as number,
    sessionId: row.session_id as string,
    seq: row.seq as number,
    role: row.role as SessionMessageRecord['role'],
    content: (row.content as string) ?? null,
    toolCalls: (row.tool_calls as string) ?? null,
    toolCallId: (row.tool_call_id as string) ?? null,
    reasoningContent: (row.reasoning_content as string) ?? null,
    createdAt: row.created_at as string,
  };
}
