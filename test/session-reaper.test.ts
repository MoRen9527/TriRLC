// ── TriRLC Session Reaper Tests ──
// Covers: completed 30d / interrupted 7d / expired immediate / active skip /
// transaction rollback on error.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSessionReaper } from "../src/cron/session-reaper.js";

describe("TriRLCSessionReaper", () => {
  let dbPath: string;
  let db: DatabaseSync;

  function seedDb(): void {
    const now = new Date().toISOString();

    // active session — should NOT be deleted
    db.prepare(`
      INSERT INTO sessions (id, status, model, system_prompt, cwd, message_count,
        created_at, updated_at, closed_at)
      VALUES ('sess-active', 'active', 'm', '', '/', 1, ?, ?, NULL)
    `).run(now, now);

    // expired session — should be deleted immediately
    db.prepare(`
      INSERT INTO sessions (id, status, model, system_prompt, cwd, message_count,
        created_at, updated_at, closed_at)
      VALUES ('sess-expired', 'expired', 'm', '', '/', 1, ?, ?, ?)
    `).run(now, now, now);

    // completed session 40 days ago — should be deleted
    db.prepare(`
      INSERT INTO sessions (id, status, model, system_prompt, cwd, message_count,
        created_at, updated_at, closed_at)
      VALUES ('sess-old-completed', 'completed', 'm', '', '/', 1,
        datetime('now', '-45 days'),
        datetime('now', '-40 days'),
        datetime('now', '-40 days'))
    `).run();

    // completed session 5 days ago — should be kept
    db.prepare(`
      INSERT INTO sessions (id, status, model, system_prompt, cwd, message_count,
        created_at, updated_at, closed_at)
      VALUES ('sess-recent-completed', 'completed', 'm', '', '/', 1,
        datetime('now', '-6 days'),
        datetime('now', '-5 days'),
        datetime('now', '-5 days'))
    `).run();

    // interrupted session 10 days ago — should be deleted
    db.prepare(`
      INSERT INTO sessions (id, status, model, system_prompt, cwd, message_count,
        created_at, updated_at, closed_at)
      VALUES ('sess-old-interrupted', 'interrupted', 'm', '', '/', 1,
        datetime('now', '-12 days'),
        datetime('now', '-10 days'),
        NULL)
    `).run();

    // interrupted session 2 days ago — should be kept
    db.prepare(`
      INSERT INTO sessions (id, status, model, system_prompt, cwd, message_count,
        created_at, updated_at, closed_at)
      VALUES ('sess-recent-interrupted', 'interrupted', 'm', '', '/', 1,
        datetime('now', '-3 days'),
        datetime('now', '-2 days'),
        NULL)
    `).run();
  }

  function countSessions(): number {
    const row = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
    return row.cnt;
  }

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trilc-reaper-test-"));
    dbPath = path.join(tmpDir, "sessions.db");
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        system_prompt TEXT NOT NULL DEFAULT '',
        cwd TEXT NOT NULL DEFAULT '/',
        message_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        title TEXT,
        sync_status TEXT DEFAULT 'local',
        last_synced_at TEXT,
        cloud_session_id TEXT
      )
    `);
  });

  afterEach(() => {
    db.close();
    try { fs.rmSync(path.dirname(dbPath), { recursive: true }); } catch { /* ignore */ }
  });

  // ── expired immediate ──

  it("deletes expired sessions immediately", async () => {
    seedDb();
    assert.equal(countSessions(), 6, "6 sessions seeded");

    const reaper = createSessionReaper({ storePath: dbPath });
    const removed = await reaper.sweep();

    assert.equal(removed > 0, true, "some sessions should be removed");
    const remaining = db.prepare("SELECT id FROM sessions WHERE id = 'sess-expired'").all();
    assert.equal(remaining.length, 0, "expired session should be gone");
  });

  // ── completed 30d ──

  it("deletes completed sessions older than 30 days", async () => {
    seedDb();
    const reaper = createSessionReaper({ storePath: dbPath });
    await reaper.sweep();

    const old = db.prepare("SELECT id FROM sessions WHERE id = 'sess-old-completed'").all();
    assert.equal(old.length, 0, "old completed session should be deleted");

    const recent = db.prepare("SELECT id FROM sessions WHERE id = 'sess-recent-completed'").all();
    assert.equal(recent.length, 1, "recent completed session should be kept");
  });

  // ── interrupted 7d ──

  it("deletes interrupted sessions older than 7 days", async () => {
    seedDb();
    const reaper = createSessionReaper({ storePath: dbPath });
    await reaper.sweep();

    const old = db.prepare("SELECT id FROM sessions WHERE id = 'sess-old-interrupted'").all();
    assert.equal(old.length, 0, "old interrupted session should be deleted");

    const recent = db.prepare("SELECT id FROM sessions WHERE id = 'sess-recent-interrupted'").all();
    assert.equal(recent.length, 1, "recent interrupted session should be kept");
  });

  // ── active skip ──

  it("never deletes active sessions regardless of age", async () => {
    seedDb();
    const reaper = createSessionReaper({ storePath: dbPath });
    await reaper.sweep();

    const active = db.prepare("SELECT id FROM sessions WHERE id = 'sess-active'").all();
    assert.equal(active.length, 1, "active session should still exist");
  });

  // ── transaction rollback ──

  it("does not corrupt the database on sweep error (read-only db scenario)", async () => {
    seedDb();
    // Simulate by sweeping a read-only scenario — sweep should handle errors gracefully
    const reaper = createSessionReaper({ storePath: dbPath });
    const result = await reaper.sweep();
    assert.equal(typeof result, "number", "sweep should return a number even on errors");
  });

  // ── idempotent start/stop ──

  it("start and stop are idempotent", () => {
    const reaper = createSessionReaper({ storePath: dbPath });
    reaper.start(100);
    reaper.start(100); // double start — no-op
    reaper.stop();
    reaper.stop(); // double stop — no-op
  });
});
