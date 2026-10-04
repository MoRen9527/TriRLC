// ── M.6 Integration Test: Online→Offline→Recovery Flow ──
// Tests the full pipeline: EventQueue enqueue → degraded → replay → arbitrate → apply response
// Covers M.1 (EventQueue) + M.2 (replay endpoint) + M.5 (arbitration) integration.

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createEventQueue } from '../../src/event-queue/queue.js';
import { arbitrate, resetArbitrationState, trackTaskAssignment, trackToolExecution } from '../../../TriMMC/src/comm/arbitration.js';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function tempDbPath(label: string): string {
  return join(tmpdir(), `trilc-m6-${label}-${Date.now()}.db`);
}

function cleanup(path: string) {
  try { unlinkSync(path); } catch { /* ok */ }
  try { unlinkSync(path + '-wal'); } catch { /* ok */ }
  try { unlinkSync(path + '-shm'); } catch { /* ok */ }
}

describe('Replay integration (M.1 + M.2 + M.5)', () => {
  const nodeId = 'node-alpha';

  it('full flow: enqueue → get pending → arbitrate → apply response', () => {
    const dbPath = tempDbPath('full-flow');
    const queue = createEventQueue({ dbPath, maxQueueSize: 100, ttlMs: 3_600_000 });
    try {
      resetArbitrationState();

      // ── Phase 1: Enqueue events (simulating offline accumulation) ──
      const e1 = queue.enqueue('conn-alpha', 'task_assign', { taskId: 'task-1' });
      const e2 = queue.enqueue('conn-alpha', 'tool_call', { idempotencyKey: 'ik-alpha' });
      const e3 = queue.enqueue('conn-alpha', 'task_complete', { taskId: 'task-1' });
      assert.equal(e1.sequenceNumber, 1);
      assert.equal(e2.sequenceNumber, 2);
      assert.equal(e3.sequenceNumber, 3);

      // ── Phase 2: Track server-side state on TriMMC ──
      trackTaskAssignment('task-1', nodeId);
      trackToolExecution('ik-alpha');

      // ── Phase 3: Get pending events for replay ──
      const pending = queue.getPendingForReplay('conn-alpha', 100);
      assert.equal(pending.length, 3);

      // ── Phase 4: Arbitrate (simulating TriMMC replay endpoint) ──
      const result = arbitrate(nodeId, pending);

      // task_assign(task-1): accepted (assigned to same node)
      // tool_call(ik-alpha): already_executed
      // task_complete(task-1): accepted (assigned to same node)
      assert.equal(result.accepted, 2);
      assert.equal(result.conflicts.length, 1);
      assert.equal(result.conflicts[0].resolution, 'already_executed');

      // ── Phase 5: Apply replay response (wrapping in ReplayResponse shape) ──
      queue.applyReplayResponse('conn-alpha',
        { ok: true, accepted: result.accepted, conflicts: result.conflicts, lastSeqNo: result.lastSeqNo },
        pending,
      );

      // Verify: no more pending events
      assert.equal(queue.getQueueSize('conn-alpha'), 0, 'all events processed');
    } finally {
      queue.close();
      cleanup(dbPath);
    }
  });

  it('replay with task double-assignment conflict', () => {
    const dbPath = tempDbPath('double-assign');
    const queue = createEventQueue({ dbPath, maxQueueSize: 100 });
    try {
      resetArbitrationState();
      trackTaskAssignment('task-1', 'other-node');

      queue.enqueue('conn-alpha', 'task_assign', { taskId: 'task-1' });
      const pending = queue.getPendingForReplay('conn-alpha', 100);
      assert.equal(pending.length, 1);

      const result = arbitrate(nodeId, pending);
      assert.equal(result.accepted, 0);
      assert.equal(result.conflicts[0].resolution, 'rejected_duplicate');

      queue.applyReplayResponse('conn-alpha',
        { ok: true, accepted: result.accepted, conflicts: result.conflicts, lastSeqNo: result.lastSeqNo },
        pending,
      );

      assert.equal(queue.getQueueSize('conn-alpha'), 0);
    } finally {
      queue.close();
      cleanup(dbPath);
    }
  });

  it('replay with mixed nodes: each connection replays independently', () => {
    const dbPath = tempDbPath('mixed-nodes');
    const queue = createEventQueue({ dbPath, maxQueueSize: 100 });
    try {
      resetArbitrationState();
      trackTaskAssignment('task-a', nodeId);
      trackTaskAssignment('task-b', nodeId);

      queue.enqueue('conn-alpha', 'task_assign', { taskId: 'task-a' });
      queue.enqueue('conn-alpha', 'task_complete', { taskId: 'task-a' });
      queue.enqueue('conn-bravo', 'task_assign', { taskId: 'task-b' });
      queue.enqueue('conn-bravo', 'task_complete', { taskId: 'task-b' });

      assert.equal(queue.getQueueSize('conn-alpha'), 2);
      assert.equal(queue.getQueueSize('conn-bravo'), 2);

      // Replay conn-alpha
      const pendingA = queue.getPendingForReplay('conn-alpha', 100);
      const resultA = arbitrate(nodeId, pendingA);
      queue.applyReplayResponse('conn-alpha',
        { ok: true, accepted: resultA.accepted, conflicts: resultA.conflicts, lastSeqNo: resultA.lastSeqNo },
        pendingA,
      );
      assert.equal(queue.getQueueSize('conn-alpha'), 0);
      assert.equal(queue.getQueueSize('conn-bravo'), 2, 'conn-bravo still pending');

      // Replay conn-bravo
      const pendingB = queue.getPendingForReplay('conn-bravo', 100);
      const resultB = arbitrate(nodeId, pendingB);
      queue.applyReplayResponse('conn-bravo',
        { ok: true, accepted: resultB.accepted, conflicts: resultB.conflicts, lastSeqNo: resultB.lastSeqNo },
        pendingB,
      );
      assert.equal(queue.getQueueSize('conn-bravo'), 0);
    } finally {
      queue.close();
      cleanup(dbPath);
    }
  });

  it('empty replay: no pending events', () => {
    const dbPath = tempDbPath('empty');
    const queue = createEventQueue({ dbPath, maxQueueSize: 100 });
    try {
      resetArbitrationState();
      assert.equal(queue.getQueueSize('conn-alpha'), 0);
      const pending = queue.getPendingForReplay('conn-alpha', 100);
      assert.equal(pending.length, 0);

      const result = arbitrate(nodeId, []);
      assert.equal(result.accepted, 0);
      assert.equal(result.lastSeqNo, 0);

      queue.applyReplayResponse('conn-alpha',
        { ok: true, accepted: 0, conflicts: [], lastSeqNo: 0 },
        [],
      );
      assert.equal(queue.getQueueSize('conn-alpha'), 0);
    } finally {
      queue.close();
      cleanup(dbPath);
    }
  });

  it('maxQueueSize: enqueue throws when full', () => {
    const dbPath = tempDbPath('overflow');
    const queue = createEventQueue({ dbPath, maxQueueSize: 5, ttlMs: 3_600_000 });
    try {
      resetArbitrationState();
      for (let i = 0; i < 5; i++) {
        queue.enqueue('conn-alpha', 'agent_run', { index: i });
      }
      assert.equal(queue.getQueueSize('conn-alpha'), 5);

      assert.throws(
        () => queue.enqueue('conn-alpha', 'agent_run', { index: 999 }),
        /event_queue_full/,
      );
    } finally {
      queue.close();
      cleanup(dbPath);
    }
  });

  it('partial replay: batch limit respected', () => {
    const dbPath = tempDbPath('partial');
    const queue = createEventQueue({ dbPath, maxQueueSize: 100 });
    try {
      resetArbitrationState();
      for (let i = 0; i < 10; i++) {
        queue.enqueue('conn-alpha', 'agent_run', { index: i });
      }
      assert.equal(queue.getQueueSize('conn-alpha'), 10);

      // Replay only 5
      const batch = queue.getPendingForReplay('conn-alpha', 5);
      assert.equal(batch.length, 5);

      const result = arbitrate(nodeId, batch);
      queue.applyReplayResponse('conn-alpha',
        { ok: true, accepted: result.accepted, conflicts: result.conflicts, lastSeqNo: result.lastSeqNo },
        batch,
      );

      // 5 remain
      assert.equal(queue.getQueueSize('conn-alpha'), 5);

      // Replay remaining 5
      const remaining = queue.getPendingForReplay('conn-alpha', 100);
      assert.equal(remaining.length, 5);
      assert.equal(remaining[0].seqNo, 6);
      assert.equal(remaining[4].seqNo, 10);
    } finally {
      queue.close();
      cleanup(dbPath);
    }
  });
});

