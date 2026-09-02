// ── LG-026-P3-R3/R4 Letter Sweeper 单测 ──
// 超时升级链（重要件重推→再超时 escalate / 急件零等待 / 执行席同构）+
// ttl 到期扫描（重推留痕→重试超限 escalate）+ ttl 写入校验。
// 时间构造：入库流转后原生 SQL 把时间戳拨回过去（time travel），helper 内
// 一并重建 store+sweeper（close→UPDATE→reopen）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createLetterStore, LEAD_AGENT_ID } from '../src/letter-store/store.js';
import type { LetterStore } from '../src/letter-store/store.js';
import { createLetterSweeper } from '../src/letter-store/letter-sweeper.js';
import type { LetterSweeper } from '../src/letter-store/letter-sweeper.js';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `trilc-test-sweeper-${Date.now()}.db`);

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(TEST_DB + suffix); } catch { /* ok */ }
  }
}

describe('LetterSweeper (LG-026-P3-R3/R4)', () => {
  let store: LetterStore;
  let sweeper: LetterSweeper;
  let wakeCount: number;

  const SWEEP_OPTS = {
    cSuiteHours: 4,
    executionHours: 24,
    urgentGraceMs: 30 * 60 * 1000,
    maxRetries: 2,
  };

  /** 把指定信件的某时间列拨回 hoursAgo 小时前，并重建 store+sweeper 绑定 */
  function travel(letterId: string, column: 'created_at' | 'delivered_at', hoursAgo: number): void {
    store.close();
    const raw = new DatabaseSync(TEST_DB);
    raw.prepare(`UPDATE letters SET ${column} = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) WHERE letter_id = ?`)
      .run(`-${Math.round(hoursAgo * 60)} minutes`, letterId);
    raw.close();
    store = createLetterStore(TEST_DB, { leaderId: LEAD_AGENT_ID });
    sweeper = createLetterSweeper({
      letterStore: store,
      wake: () => { wakeCount++; },
      escalateTo: 'COS',
    }, SWEEP_OPTS);
  }

  beforeEach(() => {
    cleanup();
    wakeCount = 0;
    store = createLetterStore(TEST_DB, { leaderId: LEAD_AGENT_ID });
    sweeper = createLetterSweeper({
      letterStore: store,
      wake: () => { wakeCount++; },
      escalateTo: 'COS',
    }, SWEEP_OPTS);
  });

  afterEach(() => {
    sweeper.stop();
    try { store.close(); } catch { /* ok */ }
    cleanup();
  });

  it('important letter to C-suite: re-push after 4h, escalate after 8h', () => {
    const rec = store.insertLetter({ from: 'boss', to: 'COS', priority: '重要', payload: {} });
    store.transition(rec.letterId, 'deliver', LEAD_AGENT_ID);

    // 未超时：不动
    let r = sweeper.sweep();
    assert.equal(r.rescued, 0);

    // 超 4h 未读 → 重推（retries=1 + wake）
    travel(rec.letterId, 'delivered_at', 5);
    r = sweeper.sweep();
    assert.equal(r.rescued, 1);
    assert.equal(wakeCount, 1);
    const after1 = store.getLetter(rec.letterId)!;
    assert.equal(after1.status, 'delivered'); // 重推不改状态
    assert.equal(after1.retries, 1);

    // 再超时（delivered 9h，retries=1）→ escalate（原子：原信冻结 + ref 信封）
    travel(rec.letterId, 'delivered_at', 9);
    r = sweeper.sweep();
    assert.equal(r.escalated, 1);
    const after2 = store.getLetter(rec.letterId)!;
    assert.equal(after2.status, 'escalated');
    const envelope = store.listLetters({}).find((l) => l.refLetterId === rec.letterId);
    assert.ok(envelope);
    assert.equal(envelope!.to, 'COS');
    assert.equal(envelope!.priority, '急件');
  });

  it('important letter to execution seat uses 24h threshold (同构)', () => {
    const rec = store.insertLetter({ from: 'pm', to: '小柯', priority: '重要', payload: {} });
    store.transition(rec.letterId, 'deliver', LEAD_AGENT_ID);
    travel(rec.letterId, 'delivered_at', 5);
    // 5h < 24h 执行席阈值：不动
    const r = sweeper.sweep();
    assert.equal(r.rescued, 0);
    assert.equal(store.getLetter(rec.letterId)!.retries, 0);
  });

  it('urgent letter escalates immediately after grace period (零等待)', () => {
    const rec = store.insertLetter({ from: 'x', to: 'CTO', priority: '急件', payload: {} });
    // 刚入箱（< 30min 宽限）：不动（组长 wake 竞态保护）
    let r = sweeper.sweep();
    assert.equal(r.escalated, 0);

    // 超宽限仍 pending → 即时升
    travel(rec.letterId, 'created_at', 1);
    r = sweeper.sweep();
    assert.equal(r.escalated, 1);
    assert.equal(store.getLetter(rec.letterId)!.status, 'escalated');
  });

  it('ttl expiry on pending letters: re-push with trail, then escalate at retry limit (R4)', () => {
    // ttl=3600s，入箱后拨回 2h → 到期未投；retries 0<2 → 重推
    const rec = store.insertLetter({ from: 'a', to: 'b', priority: '常规', payload: {}, ttlSeconds: 3600 });
    travel(rec.letterId, 'created_at', 2);
    let r = sweeper.sweep();
    assert.equal(r.expired, 1);
    assert.equal(r.rescued, 1);
    const after1 = store.getLetter(rec.letterId)!;
    assert.equal(after1.retries, 1);
    assert.ok(after1.lastError!.includes('ttl'));

    // 补一次重试达 maxRetries=2 且仍超期 → escalate
    store.recordRetry(rec.letterId, 'ttl 到期未投(补一次重试)');
    r = sweeper.sweep();
    assert.equal(r.escalated, 1);
    assert.equal(store.getLetter(rec.letterId)!.status, 'escalated');
  });

  it('ttl write validation: ttl <= 0 rejected at store level', () => {
    assert.throws(
      () => store.insertLetter({ from: 'a', to: 'b', priority: '常规', payload: {}, ttlSeconds: 0 }),
      /invalid_ttl/,
    );
    assert.throws(
      () => store.insertLetter({ from: 'a', to: 'b', priority: '常规', payload: {}, ttlSeconds: -5 }),
      /invalid_ttl/,
    );
    // 合法值过
    assert.equal(store.insertLetter({ from: 'a', to: 'b', priority: '常规', payload: {}, ttlSeconds: 60 }).status, 'pending');
  });
});
