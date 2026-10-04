// ── M.1 Event Queue Unit Tests ──
// Tests for TriRLC/src/event-queue/* — SQLite persistence, enqueue, replay cycle.
// Uses Node 22 native test runner + node:sqlite (in-memory).

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createEventQueue } from '../src/event-queue/queue.js';
import type { QueuedEvent } from '../src/event-queue/types.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `trilc-test-queue-${Date.now()}.db`);

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
}

describe('EventQueue', () => {
  let queue: ReturnType<typeof createEventQueue>;
  const connId = 'test-node-42';

  beforeEach(() => {
    cleanup();
    queue = createEventQueue({ dbPath: TEST_DB, maxQueueSize: 10, ttlMs: 60_000 });
  });

  afterEach(() => {
    queue.close();
    cleanup();
  });

  it('enqueues a single event and returns it with correct fields', () => {
    const event = queue.enqueue(connId, 'agent_run', { model: 'deepseek-v4-pro' });

    assert.ok(event.eventId.startsWith(connId));
    assert.equal(event.connectionId, connId);
    assert.equal(event.type, 'agent_run');
    assert.equal(event.sequenceNumber, 1);
    assert.ok(event.timestamp > 0);
    assert.deepStrictEqual(event.payload, { model: 'deepseek-v4-pro' });
  });

  it('assigns monotonically increasing sequence numbers', () => {
    const e1 = queue.enqueue(connId, 'task_complete', { id: 1 });
    const e2 = queue.enqueue(connId, 'tool_call', { tool: 'read' });
    const e3 = queue.enqueue(connId, 'state_change', { from: 'A', to: 'B' });

    assert.equal(e1.sequenceNumber, 1);
    assert.equal(e2.sequenceNumber, 2);
    assert.equal(e3.sequenceNumber, 3);
  });

  it('sequence numbers are per-connection', () => {
    const c1 = queue.enqueue('conn-a', 'agent_run', {});
    const c2a = queue.enqueue('conn-b', 'agent_run', {});
    const c2b = queue.enqueue('conn-b', 'tool_call', {});

    assert.equal(c1.sequenceNumber, 1);
    assert.equal(c2a.sequenceNumber, 1);
    assert.equal(c2b.sequenceNumber, 2);
  });

  it('getQueueSize returns correct count', () => {
    assert.equal(queue.getQueueSize(connId), 0);
    queue.enqueue(connId, 'agent_run', {});
    assert.equal(queue.getQueueSize(connId), 1);
    queue.enqueue(connId, 'task_complete', {});
    queue.enqueue(connId, 'tool_call', {});
    assert.equal(queue.getQueueSize(connId), 3);
    assert.equal(queue.getQueueSize('other'), 0);
  });

  it('getPendingForReplay returns events sorted by seqNo', () => {
    queue.enqueue(connId, 'agent_run', { a: 1 });
    queue.enqueue(connId, 'task_complete', { b: 2 });
    queue.enqueue(connId, 'tool_call', { c: 3 });

    const pending = queue.getPendingForReplay(connId);
    assert.equal(pending.length, 3);
    assert.equal(pending[0].seqNo, 1);
    assert.equal(pending[1].seqNo, 2);
    assert.equal(pending[2].seqNo, 3);
  });

  it('getPendingForReplay respects limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      queue.enqueue(connId, 'agent_run', { i });
    }
    const pending = queue.getPendingForReplay(connId, 2);
    assert.equal(pending.length, 2);
  });

  it('applyReplayResponse marks accepted events as replayed', () => {
    const e1 = queue.enqueue(connId, 'agent_run', {});
    const e2 = queue.enqueue(connId, 'task_complete', {});
    const events = queue.getPendingForReplay(connId);

    queue.applyReplayResponse(connId, {
      ok: true,
      accepted: 2,
      conflicts: [],
      lastSeqNo: 2,
    }, events);

    // After replay, queue should be empty
    const remaining = queue.getPendingForReplay(connId);
    assert.equal(remaining.length, 0);
  });

  it('applyReplayResponse handles conflicts', () => {
    queue.enqueue(connId, 'agent_run', {});
    queue.enqueue(connId, 'task_complete', {});
    const events = queue.getPendingForReplay(connId);

    queue.applyReplayResponse(connId, {
      ok: true,
      accepted: 1,
      conflicts: [{
        eventId: events[1].eventId,
        type: 'task_complete',
        resolution: 'rejected_duplicate',
        reason: 'task already assigned to node-B',
      }],
      lastSeqNo: 2,
    }, events);

    // Only the first event should remain as not-yet-replayed
    // (it was accepted), second is marked replayed with conflict reason
    const remaining = queue.getPendingForReplay(connId);
    assert.equal(remaining.length, 0);
    assert.equal(queue.getQueueSize(connId), 0);
  });

  it('throws when queue exceeds maxQueueSize', () => {
    const small = createEventQueue({ dbPath: TEST_DB + '.small', maxQueueSize: 3, ttlMs: 60_000 });
    small.enqueue(connId, 'agent_run', {});
    small.enqueue(connId, 'agent_run', {});
    small.enqueue(connId, 'agent_run', {});

    assert.throws(
      () => small.enqueue(connId, 'task_complete', {}),
      /event_queue_full/,
    );
    small.close();
    try { unlinkSync(TEST_DB + '.small'); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + '.small-wal'); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + '.small-shm'); } catch { /* ok */ }
  });

  it('expires old events', (ctx) => {
    const shortTtl = createEventQueue({ dbPath: TEST_DB + '.ttl', maxQueueSize: 100, ttlMs: 1 });
    shortTtl.enqueue(connId, 'agent_run', {});
    assert.equal(shortTtl.getQueueSize(connId), 1);

    // Wait 2ms then expire — TTL is 1ms
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const expired = shortTtl.expireOldEvents();
        assert.equal(expired, 1);
        assert.equal(shortTtl.getQueueSize(connId), 0);
        shortTtl.close();
        try { unlinkSync(TEST_DB + '.ttl'); } catch { /* ok */ }
        try { unlinkSync(TEST_DB + '.ttl-wal'); } catch { /* ok */ }
        try { unlinkSync(TEST_DB + '.ttl-shm'); } catch { /* ok */ }
        resolve();
      }, 5);
    });
  });

  it('persists events across queue instances (SQLite durability)', () => {
    const q1 = createEventQueue({ dbPath: TEST_DB });
    q1.enqueue(connId, 'agent_run', { durable: true });
    q1.close();

    const q2 = createEventQueue({ dbPath: TEST_DB });
    assert.equal(q2.getQueueSize(connId), 1);
    const pending = q2.getPendingForReplay(connId);
    assert.equal(pending.length, 1);
    assert.deepStrictEqual(pending[0].payload, { durable: true });
    q2.close();
  });
});
