// ── TriRLC Session Reaper ──
// Periodically sweeps expired / stale sessions from the SQLite session store.
// Cleanup strategy:
//   completed   → 30d after last update
//   interrupted → 7d after last update
//   expired     → immediately
//   active      → skipped
//
// Uses node:sqlite directly against the session-store DB file (no dependency
// on session-store internals beyond the table schema).

import { DatabaseSync } from 'node:sqlite';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour
const LOG_PREFIX = '[trilc:reaper]';

const SWEEP_SQL = `
  DELETE FROM sessions WHERE status = 'expired';
  DELETE FROM sessions WHERE status = 'completed' AND updated_at < datetime('now', '-30 days');
  DELETE FROM sessions WHERE status = 'interrupted' AND updated_at < datetime('now', '-7 days');
`;

export function createSessionReaper(opts: { storePath: string }) {
  let timer: ReturnType<typeof setInterval> | null = null;

  // ── Sweep ──

  async function sweep(): Promise<number> {
    const db = new DatabaseSync(opts.storePath);
    try {
      db.exec('PRAGMA foreign_keys=ON;');
      db.exec('BEGIN');
      db.exec(SWEEP_SQL);
      const changes = db.prepare('SELECT total_changes() as cnt').get() as { cnt: number };
      db.exec('COMMIT');
      const count = Number(changes.cnt);
      if (count > 0) {
        console.log(`${LOG_PREFIX} sweep: ${count} sessions removed`);
      }
      return count;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${LOG_PREFIX} sweep error: ${msg}`);
      return 0;
    } finally {
      db.close();
    }
  }

  // ── Lifecycle ──

  function start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (timer) return; // idempotent
    console.log(`${LOG_PREFIX} started (interval=${intervalMs}ms)`);
    // immediate first sweep
    sweep().catch((err) => {
      console.error(`${LOG_PREFIX} initial sweep failed:`, err instanceof Error ? err.message : String(err));
    });
    timer = setInterval(() => {
      sweep().catch((err) => {
        console.error(`${LOG_PREFIX} sweep failed:`, err instanceof Error ? err.message : String(err));
      });
    }, intervalMs);
    // Allow the process to exit even if this timer is active
    timer.unref();
  }

  function stop(): void {
    if (!timer) return; // idempotent
    clearInterval(timer);
    timer = null;
    console.log(`${LOG_PREFIX} stopped`);
  }

  function isRunning(): boolean {
    return timer !== null;
  }

  return { sweep, start, stop, isRunning };
}
