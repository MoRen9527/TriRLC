// ── LG-026 P1 Letter Store Unit Tests ──
// Tests for TriRLC/src/letter-store/* — DDL 迁移 / seq 全局单调含重启续号 /
// 状态机门禁（非法流转拒绝）/ escalate 冻结语义 / actor 门禁与台账留痕。
// Uses Node 22 native test runner + node:sqlite (tmp file, same style as event-queue.test.ts).

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createLetterStore } from '../src/letter-store/store.js';
import type { LetterStore } from '../src/letter-store/store.js';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `trilc-test-letters-${Date.now()}.db`);

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
}

const LEADER = '组长甲';
const ALICE = 'alice';
const BOB = 'bob';

function envelope(overrides: Partial<Parameters<LetterStore['insertLetter']>[0]> = {}) {
  return {
    from: ALICE,
    to: BOB,
    priority: '常规' as const,
    payload: { text: 'hello' },
    ...overrides,
  };
}

describe('LetterStore', () => {
  let store: LetterStore;

  beforeEach(() => {
    cleanup();
    store = createLetterStore(TEST_DB, { leaderId: LEADER });
  });

  afterEach(() => {
    // 部分用例在测试体内已手动 close（重开幂等/原生 CHECK 验证）——防二次 close
    try { store.close(); } catch { /* already closed */ }
    cleanup();
  });

  // ── ① DDL 迁移 ──

  describe('DDL / migration', () => {
    it('creates schema and stamps user_version=1', () => {
      // 建表即用：寄一封走通全链
      const rec = store.insertLetter(envelope());
      assert.equal(rec.status, 'pending');
      assert.equal(rec.seqNo, 1);
      assert.ok(rec.letterId.startsWith('LT-'));
      assert.ok(rec.createdAt.length > 0);
    });

    it('reopening is idempotent — existing data preserved', () => {
      const rec = store.insertLetter(envelope());
      store.close();
      const reopened = createLetterStore(TEST_DB, { leaderId: LEADER });
      const got = reopened.getLetter(rec.letterId);
      assert.ok(got);
      assert.equal(got!.letterId, rec.letterId);
      assert.equal(got!.status, 'pending');
      assert.deepStrictEqual(got!.payload, { text: 'hello' });
      reopened.close();
    });

    it('DB CHECK rejects invalid status / priority values', () => {
      store.close();
      const db = new DatabaseSync(TEST_DB);
      assert.throws(
        () => db.prepare("INSERT INTO letters (letter_id, seq_no, \"from\", \"to\", priority, status, payload) VALUES ('y', 98, 'a', 'b', '紧急', 'pending', '{}')").run(),
      );
      assert.throws(
        () => db.prepare("INSERT INTO letters (letter_id, seq_no, \"from\", \"to\", priority, status, payload) VALUES ('z', 97, 'a', 'b', '常规', 'lost', '{}')").run(),
      );
      db.close();
    });

    it('rejects invalid priority at store level', () => {
      assert.throws(
        () => store.insertLetter(envelope({ priority: '紧急' as never })),
        /invalid_priority/,
      );
    });

    it('rejects duplicate explicit letter_id', () => {
      const rec = store.insertLetter(envelope({ letterId: 'LT-fixed-1' }));
      assert.equal(rec.letterId, 'LT-fixed-1');
      assert.throws(
        () => store.insertLetter(envelope({ letterId: 'LT-fixed-1' })),
        /duplicate_id/,
      );
    });
  });

  // ── ② seq 全局单调（含重启续号）──

  describe('global monotonic seq', () => {
    it('assigns strictly increasing seq across senders/recipients', () => {
      const a = store.insertLetter(envelope());
      const b = store.insertLetter(envelope({ from: BOB, to: ALICE, payload: { n: 2 } }));
      const c = store.insertLetter(envelope({ to: 'carol', priority: '急件', payload: null }));
      assert.ok(a.seqNo < b.seqNo);
      assert.ok(b.seqNo < c.seqNo);
      assert.equal(store.getLastSeq(), c.seqNo);
    });

    it('continues seq numbering after store close/reopen (restart)', () => {
      const s1 = createLetterStore(TEST_DB + '.restart', { leaderId: LEADER });
      const last1 = s1.insertLetter(envelope({ to: 'x1' })).seqNo;
      const last2 = s1.insertLetter(envelope({ to: 'x2' })).seqNo;
      s1.close();

      const s2 = createLetterStore(TEST_DB + '.restart', { leaderId: LEADER });
      assert.equal(s2.getLastSeq(), last2);
      const next = s2.insertLetter(envelope({ to: 'x3' }));
      assert.equal(next.seqNo, last2 + 1);
      s2.close();
      try { unlinkSync(TEST_DB + '.restart'); } catch { /* ok */ }
      try { unlinkSync(TEST_DB + '.restart-wal'); } catch { /* ok */ }
      try { unlinkSync(TEST_DB + '.restart-shm'); } catch { /* ok */ }
    });

    it('listLetters sinceSeq returns only newer letters in seq order (积压重放语义)', () => {
      const r1 = store.insertLetter(envelope({ to: 'x1' }));
      store.insertLetter(envelope({ to: 'x2' }));
      const r3 = store.insertLetter(envelope({ to: 'x3', priority: '重要' }));

      const newer = store.listLetters({ sinceSeq: r1.seqNo });
      assert.equal(newer.length, 2);
      assert.equal(newer[0].to, 'x2');
      assert.equal(newer[1].to, 'x3');

      const byStatus = store.listLetters({ status: 'pending', to: 'x3' });
      assert.equal(byStatus.length, 1);
      assert.equal(byStatus[0].letterId, r3.letterId);
    });
  });

  // ── ③ 状态机门禁（非法流转拒绝）──

  describe('state machine gating', () => {
    it('walks the full happy path pending → delivered → read → done', () => {
      const rec = store.insertLetter(envelope());
      assert.equal(store.transition(rec.letterId, 'deliver', LEADER).status, 'delivered');
      const read = store.transition(rec.letterId, 'read', BOB);
      assert.equal(read.status, 'read');
      assert.ok(read.readAt);
      const done = store.transition(rec.letterId, 'done', BOB);
      assert.equal(done.status, 'done');
    });

    it('rejects read before deliver (未投先读)', () => {
      const rec = store.insertLetter(envelope());
      assert.throws(
        () => store.transition(rec.letterId, 'read', BOB),
        /illegal_transition/,
      );
    });

    it('rejects double deliver and re-delivery after read', () => {
      const rec = store.insertLetter(envelope());
      store.transition(rec.letterId, 'deliver', LEADER);
      assert.throws(() => store.transition(rec.letterId, 'deliver', LEADER), /illegal_transition/);
      store.transition(rec.letterId, 'read', BOB);
      assert.throws(() => store.transition(rec.letterId, 'deliver', LEADER), /illegal_transition/);
    });

    it('rejects done before read (未读办结)', () => {
      const rec = store.insertLetter(envelope());
      store.transition(rec.letterId, 'deliver', LEADER);
      assert.throws(() => store.transition(rec.letterId, 'done', BOB), /illegal_transition/);
    });

    it('done is terminal — every action rejected afterwards', () => {
      const rec = store.insertLetter(envelope());
      store.transition(rec.letterId, 'deliver', LEADER);
      store.transition(rec.letterId, 'read', BOB);
      store.transition(rec.letterId, 'done', BOB);
      for (const action of ['deliver', 'read', 'escalate', 'done'] as const) {
        assert.throws(
          () => store.transition(rec.letterId, action, action === 'read' ? BOB : LEADER),
          /illegal_transition/,
          `done 后 ${action} 应拒绝`,
        );
      }
    });

    it('rejects transition on missing letter', () => {
      assert.throws(() => store.transition('LT-none', 'deliver', LEADER), /not_found/);
    });
  });

  // ── ④ escalate 冻结语义 ──

  describe('escalate / freeze semantics', () => {
    it('escalates from any mainline state; frozen letter only allows done', () => {
      for (const pre of ['none', 'deliver', 'read'] as const) {
        const rec = store.insertLetter(envelope({ to: `frozen-${pre}` }));
        if (pre === 'deliver' || pre === 'read') store.transition(rec.letterId, 'deliver', LEADER);
        if (pre === 'read') store.transition(rec.letterId, 'read', `frozen-${pre}`);
        const esc = store.transition(rec.letterId, 'escalate', LEADER);
        assert.equal(esc.status, 'escalated');
        assert.ok(esc.escalatedAt);
        // 冻结：主链动作全拒
        assert.throws(() => store.transition(rec.letterId, 'deliver', LEADER), /illegal_transition/);
        assert.throws(() => store.transition(rec.letterId, 'read', `frozen-${pre}`), /illegal_transition/);
        assert.throws(() => store.transition(rec.letterId, 'escalate', LEADER), /illegal_transition/);
        // 冻结后仅 done 可达
        assert.equal(store.transition(rec.letterId, 'done', LEADER).status, 'done');
      }
    });

    it('ref_letter_id requires the referenced letter to be escalated (原件冻结校验)', () => {
      const pending = store.insertLetter(envelope({ to: 'p' }));
      assert.throws(
        () => store.insertLetter(envelope({ to: 'cos', refLetterId: pending.letterId })),
        /ref_not_frozen/,
      );
      const delivered = store.transition(pending.letterId, 'deliver', LEADER);
      assert.equal(delivered.status, 'delivered');
      assert.throws(
        () => store.insertLetter(envelope({ to: 'cos', refLetterId: pending.letterId })),
        /ref_not_frozen/,
      );
    });

    it('ref_letter_id to a missing letter is rejected', () => {
      assert.throws(
        () => store.insertLetter(envelope({ to: 'cos', refLetterId: 'LT-ghost' })),
        /not_found/,
      );
    });

    it('escalateLetter is atomic: freeze original + envelope ref in one transaction', () => {
      const rec = store.insertLetter(envelope({ to: 'esc-atomic' }));
      const { original, envelope: env } = store.escalateLetter(rec.letterId, LEADER, {
        from: LEADER,
        to: 'COS',
        priority: '急件',
        payload: { reason: '超时未读' },
      });
      assert.equal(original.status, 'escalated');
      assert.equal(env.refLetterId, rec.letterId);
      assert.equal(env.to, 'COS');
      assert.equal(env.status, 'pending');
      assert.ok(env.seqNo > rec.seqNo);
      // 原信冻结 + 新信封可正常投递
      assert.throws(() => store.transition(rec.letterId, 'deliver', LEADER), /illegal_transition/);
      assert.equal(store.transition(env.letterId, 'deliver', LEADER).status, 'delivered');
    });

    it('escalateLetter rolls back the freeze when envelope creation fails', () => {
      const rec = store.insertLetter(envelope({ to: 'esc-rollback' }));
      assert.throws(
        () => store.escalateLetter(rec.letterId, LEADER, {
          from: LEADER,
          to: 'COS',
          priority: '紧急' as never, // 非法 priority → 新信封创建失败 → 整事务回滚
          payload: {},
        }),
        /invalid_priority/,
      );
      // 原信未被冻结（回滚生效）
      const after = store.getLetter(rec.letterId);
      assert.equal(after!.status, 'pending');
    });

    it('ref via insertLetter after manual freeze keeps the chain auditable', () => {
      const rec = store.insertLetter(envelope({ to: 'chain' }));
      store.transition(rec.letterId, 'escalate', LEADER);
      const env = store.insertLetter(envelope({ from: LEADER, to: 'COS', priority: '急件', refLetterId: rec.letterId }));
      assert.equal(env.refLetterId, rec.letterId);
      const frozen = store.getLetter(rec.letterId)!;
      assert.equal(frozen.status, 'escalated');
    });
  });

  // ── ⑤ actor 门禁 + 台账留痕 ──

  describe('actor gating & ledger audit trail', () => {
    it('deliver requires the leader (唯一投递执行者)', () => {
      const rec = store.insertLetter(envelope());
      assert.throws(() => store.transition(rec.letterId, 'deliver', ALICE), /actor_forbidden/);
      assert.throws(() => store.transition(rec.letterId, 'deliver', 'COS'), /actor_forbidden/);
      assert.equal(store.transition(rec.letterId, 'deliver', LEADER).status, 'delivered');
    });

    it('read requires the recipient — leader must not mark-read on behalf (不得代标)', () => {
      const rec = store.insertLetter(envelope());
      store.transition(rec.letterId, 'deliver', LEADER);
      assert.throws(() => store.transition(rec.letterId, 'read', LEADER), /actor_forbidden/);
      assert.throws(() => store.transition(rec.letterId, 'read', ALICE), /actor_forbidden/);
      assert.equal(store.transition(rec.letterId, 'read', BOB).status, 'read');
    });

    it('ledger records full lifecycle: send + transitions, filterable per letter', () => {
      const rec = store.insertLetter(envelope());
      store.transition(rec.letterId, 'deliver', LEADER);
      store.transition(rec.letterId, 'read', BOB);

      const trail = store.listLedger({ letterId: rec.letterId });
      assert.deepStrictEqual(
        trail.map((e) => [e.actor, e.action]),
        [[ALICE, 'send'], [LEADER, 'deliver'], [BOB, 'read']],
      );
      assert.ok(trail.every((e) => e.at.length > 0));

      const tail = store.listLedger({ letterId: rec.letterId, sinceId: trail[0].id });
      assert.equal(tail.length, 2);
    });

    it('recordRetry increments retries and keeps last_error without touching status', () => {
      const rec = store.insertLetter(envelope());
      assert.equal(store.recordRetry(rec.letterId, 'SSE offline'), 1);
      assert.equal(store.recordRetry(rec.letterId, 'SSE offline again'), 2);
      const got = store.getLetter(rec.letterId)!;
      assert.equal(got.retries, 2);
      assert.equal(got.lastError, 'SSE offline again');
      assert.equal(got.status, 'pending');
      assert.throws(() => store.recordRetry('LT-none', 'x'), /not_found/);
    });
  });
});
