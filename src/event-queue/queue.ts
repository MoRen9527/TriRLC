// ── TriRLC Event Queue ──
// Offline event queue manager. Enqueues local agent events when TriMMC is unreachable,
// replays them to TriMMC upon reconnection. CTO-008-M §3.2.

import { createEventStore } from './store.js';
import type { QueuedEvent, ReplayRequest, ReplayResponse } from './types.js';

export interface EventQueueOptions {
  dbPath: string;
  /** Max pending events before rejecting new enqueues (default 10_000) */
  maxQueueSize?: number;
  /** TTL in ms for pending events before expiry (default 3_600_000 = 1h) */
  ttlMs?: number;
}

export function createEventQueue(options: EventQueueOptions) {
  const store = createEventStore(options.dbPath);
  const maxQueueSize = options.maxQueueSize ?? 10_000;
  const ttlMs = options.ttlMs ?? 3_600_000;

  function enqueue(
    connectionId: string,
    type: QueuedEvent['type'],
    payload: unknown,
  ): QueuedEvent {
    const pending = store.countPending(connectionId);
    if (pending >= maxQueueSize) {
      throw new Error(
        `event_queue_full: connection ${connectionId} has ${pending} pending (max ${maxQueueSize})`,
      );
    }

    const seqNo = store.getNextSeqNo(connectionId);
    const event: QueuedEvent = {
      eventId: `${connectionId}-e${String(seqNo).padStart(4, '0')}`,
      connectionId,
      type,
      timestamp: Date.now(),
      sequenceNumber: seqNo,
      payload,
    };
    store.insert(event);
    return event;
  }

  function getPendingForReplay(connectionId: string, limit = 100): ReplayRequest['events'] {
    const rows = store.getPending(connectionId, limit);
    return rows.map((r) => ({
      eventId: r.event_id,
      type: r.type,
      timestamp: r.timestamp,
      seqNo: r.seq_no,
      payload: r.payload,
    }));
  }

  function applyReplayResponse(
    _connectionId: string,
    response: ReplayResponse,
    replayEvents: ReplayRequest['events'],
  ): void {
    const accepted: string[] = [];
    const conflictMap = new Map(
      response.conflicts.map((c) => [c.eventId, c.reason]),
    );

    for (const e of replayEvents) {
      if (conflictMap.has(e.eventId)) {
        store.markStatus([e.eventId], 'replayed', conflictMap.get(e.eventId));
      } else {
        accepted.push(e.eventId);
      }
    }

    if (accepted.length > 0) {
      store.markStatus(accepted, 'replayed');
    }
  }

  function expireOldEvents(): number {
    const cutoff = Date.now() - ttlMs;
    return store.expireOld(cutoff);
  }

  function getQueueSize(connectionId?: string): number {
    return store.countPending(connectionId);
  }

  function close(): void {
    store.close();
  }

  return { enqueue, getPendingForReplay, applyReplayResponse, expireOldEvents, getQueueSize, close };
}
