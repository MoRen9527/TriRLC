// ── β-1 事务回执最小件自测（形三 α+β · 任务书验收门三面+补强三面）──
// 验收门①乱序注入 behind 防护断言 ②撤回案（withdraw pending-only+targetGone/
// targetIgnored settle 案）③形二 98s 链状态史对拍投影（accepted→sent 全链可追溯）
// 补强：幂等双 send / Later 免 settle 语义 / 事务原子性回滚零残留。
// 形制照 letter-store.test.ts（node:test + node:sqlite tmp 文件）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReceiptsStore, Later, FAILURES_BEFORE_ERROR } from '../src/v2/receipts.js';
import type { ReceiptTransport } from '../src/v2/receipts.js';
import { Effects } from '../src/v2/effects.js'; // β-2 改形：effect 表 DDL/enqueue/cancel 归 Effects（构造序先于 ReceiptsStore）

const TEST_DB = join(tmpdir(), `trirlc-test-v2-receipts-${process.pid}-${Date.now()}.db`);

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
}

let db: DatabaseSync;
let effects: Effects;
let store: ReceiptsStore;

beforeEach(() => {
  cleanup();
  db = new DatabaseSync(TEST_DB);
  effects = new Effects(db);
  store = new ReceiptsStore(db, effects);
});
afterEach(() => {
  store.close(); // 先关连接再 unlink——Windows 下未关连接致 unlink 静默失败→库复用污染（首轮实锚）
  cleanup();
});

function msg(id: string, to = 'm-coo') {
  return { id, from: 'm-fsd', to, text: `test-${id}` };
}

function transport(overrides: Partial<ReceiptTransport> = {}): ReceiptTransport {
  return {
    enabled: () => true,
    channelAllowed: () => true,
    send: async () => 'sent' as const,
    ...overrides,
  };
}

describe('β-1 receipts 事务回执', () => {
  it('幂等：同 id 双 send→单行单 effect·零重复入队', () => {
    store.send(msg('ntf-1'));
    store.send(msg('ntf-1'));
    const effectRows = store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'reply' AND key = 'ntf-1'").get() as { n: number | bigint };
    assert.equal(Number(effectRows.n), 1);
    assert.equal(store.get('ntf-1')?.status, 'pending');
    assert.deepEqual(store.get('ntf-1')?.status_history.map((s) => s.status), ['accepted']);
  });

  it('验收门①·乱序 behind 防护：前信 pending 未过阈值→后信 Later；前信 attempts 达阈→放行', async () => {
    store.send(msg('ntf-a'));
    store.send(msg('ntf-b')); // 同 target m-coo·前序 ntf-a pending
    await assert.rejects(() => store.deliver('ntf-b', transport()), Later);
    // 前信失败计数达阈（模拟 β-2 重试面写 attempts）→behind 释放
    store.db.prepare("UPDATE effect SET attempts = ? WHERE kind = 'reply' AND key = 'ntf-a'").run(FAILURES_BEFORE_ERROR);
    assert.equal(store.behind('ntf-b', FAILURES_BEFORE_ERROR), false);
    await store.deliver('ntf-b', transport());
    assert.equal(store.get('ntf-b')?.status, 'sent');
    // 前信仍 pending 不受后信投递影响
    assert.equal(store.get('ntf-a')?.status, 'pending');
  });

  it('behind 隔离：不同 target 不互阻', async () => {
    store.send(msg('ntf-x', 'm-ste'));
    store.send(msg('ntf-y', 'm-cto'));
    await store.deliver('ntf-y', transport()); // 不同 target→零 behind
    assert.equal(store.get('ntf-y')?.status, 'sent');
  });

  it('验收门②·撤回案：pending 可撤（deliver no-op）·sent 拒撤', async () => {
    store.send(msg('ntf-c'));
    assert.equal(store.withdraw('ntf-c'), true);
    await store.deliver('ntf-c', transport()); // 零行 no-op 零抛
    assert.equal(store.get('ntf-c'), undefined);
    // 已 sent 拒撤
    store.send(msg('ntf-d'));
    await store.deliver('ntf-d', transport());
    assert.equal(store.withdraw('ntf-d'), false);
    assert.equal(store.get('ntf-d')?.status, 'sent');
  });

  it('验收门②·targetGone / targetIgnored settle 双因案', async () => {
    store.send(msg('ntf-e'));
    await store.deliver('ntf-e', transport({ send: async () => 'gone' as const }));
    const gone = store.get('ntf-e');
    assert.equal(gone?.status, 'dropped');
    assert.equal(gone?.dropped?.reason, 'targetGone');
    store.send(msg('ntf-f'));
    await store.deliver('ntf-f', transport({ channelAllowed: () => false }));
    const ignored = store.get('ntf-f');
    assert.equal(ignored?.status, 'dropped');
    assert.equal(ignored?.dropped?.reason, 'targetIgnored');
  });

  it('Later 免 settle：enabled=false 与 send=waiting 均保 pending（β-2 重排消费面）', async () => {
    store.send(msg('ntf-g'));
    await assert.rejects(() => store.deliver('ntf-g', transport({ enabled: () => false })), Later);
    assert.equal(store.get('ntf-g')?.status, 'pending');
    await assert.rejects(() => store.deliver('ntf-g', transport({ send: async () => 'waiting' as const })), Later);
    assert.equal(store.get('ntf-g')?.status, 'pending');
    assert.deepEqual(store.get('ntf-g')?.status_history.map((s) => s.status), ['accepted']);
  });

  it('验收门③·状态史对拍（形二 98s 链投影）：accepted→sent 全链可追溯', async () => {
    store.send(msg('ntf-h'));
    await store.deliver('ntf-h', transport());
    const h = store.get('ntf-h');
    assert.deepEqual(h?.status_history.map((s) => s.status), ['accepted', 'sent']);
    // dropped 支路状态史投影
    store.send(msg('ntf-h2'));
    await store.deliver('ntf-h2', transport({ send: async () => 'gone' as const }));
    assert.deepEqual(store.get('ntf-h2')?.status_history.map((s) => s.status), ['accepted', 'dropped:targetGone']);
  });

  it('事务原子性：send 内故障→SAVEPOINT 回滚零残留（回执零·effect 零）', () => {
    assert.throws(() => {
      store.atomic(() => {
        store.add(msg('ntf-i'));
        throw new Error('boom-in-transaction');
      });
    }, /boom-in-transaction/);
    assert.equal(store.get('ntf-i'), undefined);
    const effectCount = store.db.prepare('SELECT COUNT(*) AS n FROM effect').get() as { n: number | bigint };
    assert.equal(Number(effectCount.n), 0);
  });

  it('enqueue coalesce：同 kind+key 双 enqueue→单行 generation+1 attempts 归零', () => {
    store.send(msg('ntf-j'));
    store.db.prepare("UPDATE effect SET attempts = 2, generation = 3 WHERE kind = 'reply' AND key = 'ntf-j'").run();
    store.send(msg('ntf-j')); // add false（幂等）→不 enqueue——coalesce 面直测 Effects.enqueue（β-2 迁入）
    effects.enqueue('reply', 'ntf-j', {});
    const row = store.db.prepare("SELECT generation, attempts FROM effect WHERE kind = 'reply' AND key = 'ntf-j'").get() as { generation: number; attempts: number };
    assert.equal(row.generation, 4);
    assert.equal(row.attempts, 0);
  });
});
