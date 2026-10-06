// ── Boot recovery sweep（LG-064 §八裁决② scope 增补，2026-10-06）──
// 上一 boot 崩溃/强停残留 running 态归位 idle：真 SQLite store 全链实测
// （addJob → updateJobRun state:'running' → resetStaleRunningJobs）。
// 治的是「残留 running → 补跑跳过 + 引擎互斥永不重触发」的 l2-scan 永卡族
// （10-05 补跑轮 running 态实证形态）。
//
// Run: npx tsx --test test/cron-boot-recovery.test.ts
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCronStore } from '../src/cron/store.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'trilc-cron-boot-'));
const stores: Array<ReturnType<typeof createCronStore>> = [];
after(() => {
  for (const s of stores) {
    try { s.db.close(); } catch { /* already closed */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore() {
  const s = createCronStore(join(tmpDir, `cron-${Math.random().toString(36).slice(2)}.db`));
  stores.push(s);
  return s;
}

describe('resetStaleRunningJobs (boot recovery sweep)', () => {
  it('resets running → idle, leaves idle/failed untouched, returns count', () => {
    const store = makeStore();
    const running = store.addJob({ name: 'stale-running', schedule: { kind: 'every', everyMs: 60_000 }, systemPrompt: 't', enabled: true });
    const idle = store.addJob({ name: 'plain-idle', schedule: { kind: 'every', everyMs: 60_000 }, systemPrompt: 't', enabled: true });
    const failed = store.addJob({ name: 'plain-failed', schedule: { kind: 'every', everyMs: 60_000 }, systemPrompt: 't', enabled: true });
    store.updateJobRun(running.id, { state: 'running' });
    store.updateJobRun(failed.id, { state: 'failed' });

    assert.equal(store.getJob(running.id)?.state, 'running', 'precondition: running seeded');

    const changed = store.resetStaleRunningJobs();
    assert.equal(changed, 1);
    assert.equal(store.getJob(running.id)?.state, 'idle', 'running reset to idle');
    assert.equal(store.getJob(idle.id)?.state, 'idle', 'idle untouched');
    assert.equal(store.getJob(failed.id)?.state, 'failed', 'failed untouched');
    // nextRunAt 不被清扫触碰（补跑判据不动）
    assert.equal(store.getJob(running.id)?.runCount, 0, 'runCount untouched');
  });

  it('idempotent: second sweep on clean store returns 0', () => {
    const store = makeStore();
    const job = store.addJob({ name: 'never-ran', schedule: { kind: 'every', everyMs: 60_000 }, systemPrompt: 't', enabled: true });
    assert.equal(store.resetStaleRunningJobs(), 0);
    assert.equal(store.getJob(job.id)?.state, 'idle');
    assert.equal(store.resetStaleRunningJobs(), 0);
  });

  it('multiple stale running jobs all reset in one sweep', () => {
    const store = makeStore();
    const a = store.addJob({ name: 'stale-a', schedule: { kind: 'every', everyMs: 60_000 }, systemPrompt: 't', enabled: true });
    const b = store.addJob({ name: 'stale-b', schedule: { kind: 'every', everyMs: 60_000 }, systemPrompt: 't', enabled: true });
    store.updateJobRun(a.id, { state: 'running' });
    store.updateJobRun(b.id, { state: 'running' });
    assert.equal(store.resetStaleRunningJobs(), 2);
    assert.equal(store.getJob(a.id)?.state, 'idle');
    assert.equal(store.getJob(b.id)?.state, 'idle');
  });
});
