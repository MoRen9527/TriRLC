// ── TriRLC Event Queue SQLite Store ──
// Persists offline events using Node 22's built-in node:sqlite.
// CTO-008-M §3.2.3 schema.

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { QueuedEvent, QueuedEventRow, EventStatus } from './types.js';

const DDL = `
CREATE TABLE IF NOT EXISTS event_queue (
  event_id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  seq_no INTEGER NOT NULL,
  payload TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  retries INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON event_queue(status);
CREATE INDEX IF NOT EXISTS idx_queue_conn ON event_queue(connection_id, seq_no);
`;

export function createEventStore(dbPath: string) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(DDL);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO event_queue
      (event_id, connection_id, type, timestamp, seq_no, payload, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);

  function insert(event: QueuedEvent): void {
    insertStmt.run(
      event.eventId,
      event.connectionId,
      event.type,
      event.timestamp,
      event.sequenceNumber,
      JSON.stringify(event.payload),
    );
  }

  function insertBatch(events: QueuedEvent[]): void {
    db.exec('BEGIN');
    try {
      for (const e of events) insert(e);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getPending(connectionId: string, limit = 100): QueuedEventRow[] {
    const rows = db
      .prepare(
        `SELECT * FROM event_queue WHERE connection_id = ? AND status = 'pending' ORDER BY seq_no LIMIT ?`,
      )
      .all(connectionId, limit) as unknown as QueuedEventRow[];
    return rows.map((r) => {
      const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
      return { ...r, payload };
    });
  }

  function countPending(connectionId?: string): number {
    if (connectionId) {
      const row = db
        .prepare("SELECT COUNT(*) as cnt FROM event_queue WHERE connection_id = ? AND status = 'pending'")
        .get(connectionId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    }
    const row = db
      .prepare("SELECT COUNT(*) as cnt FROM event_queue WHERE status = 'pending'")
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  function markStatus(
    eventIds: string[],
    status: EventStatus,
    error?: string,
  ): void {
    const stmt = db.prepare(
      'UPDATE event_queue SET status = ?, retries = retries + 1, last_error = ? WHERE event_id = ?',
    );
    db.exec('BEGIN');
    try {
      for (const id of eventIds) {
        stmt.run(status, error ?? null, id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getNextSeqNo(connectionId: string): number {
    const row = db
      .prepare(
        'SELECT COALESCE(MAX(seq_no), 0) + 1 as next_seq FROM event_queue WHERE connection_id = ?',
      )
      .get(connectionId) as { next_seq: number | bigint } | undefined;
    return Number(row?.next_seq ?? 1);
  }

  function expireOld(cutoffTimestamp: number): number {
    const result = db
      .prepare(
        "UPDATE event_queue SET status = 'expired' WHERE status = 'pending' AND timestamp < ?",
      )
      .run(cutoffTimestamp);
    return Number(result.changes);
  }

  function close(): void {
    db.close();
  }

  return { insert, insertBatch, getPending, countPending, markStatus, getNextSeqNo, expireOld, close };
}
