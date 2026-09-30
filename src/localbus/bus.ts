// ── TriRLC Localbus ──
// In-process typed EventEmitter bus for local module decoupling.
// Phase 1: EventEmitter memory bus (CTO-008-M §3.4.2).
// Phase 2: upgrade to Unix Domain Socket / Named Pipe.

import { EventEmitter } from 'node:events';

export type LocalBusEvent =
  | { type: 'task:queued'; taskId: string }
  | { type: 'task:running'; taskId: string }
  | { type: 'task:succeeded'; taskId: string; result: unknown }
  | { type: 'task:failed'; taskId: string; error: string }
  | { type: 'task:cancelled'; taskId: string }
  | { type: 'node:connected' }
  | { type: 'node:degraded' }
  | { type: 'node:local' }
  | { type: 'agent:event'; event: Record<string, unknown> }
  // ── Heartbeat events ──
  | { type: 'heartbeat:sent'; nodeId: string }
  | { type: 'heartbeat:received'; nodeId: string }
  | { type: 'heartbeat:failed'; error: string }
  // ── Cron events ──
  | { type: 'cron:sweep'; count: number }
  | { type: 'cron:error'; error: string }
  | { type: 'cron:degraded'; consecutiveFailures: number }
  | { type: 'cron:recovered' }
  // ── Init chain / selfcheck events（I1: init-collab-i1-statemachine）──
  // init:chain-changed 的 eventSeq 与链路状态文件同帧（i1-1 §三）。
  | { type: 'init:chain-changed'; chainState: string; from: string; to: string; eventSeq: number; sourceEntry: string | null }
  | { type: 'init:selfcheck-started'; runId: string; checks: string[] }
  | { type: 'init:selfcheck-progress'; runId: string; checkId: string; status: string; detail: string }
  | { type: 'init:selfcheck-finished'; runId: string; summary: string; report: unknown }
  // ── Init project-link 事件族（I3: init-collab-i3-project-registry）──
  // 事件流 = 状态文件/注册点同帧投影；project-link→sync 转移不发布（归 I4）。
  | { type: 'init:project-link-started'; runId: string; source: string; targetPath: string }
  | { type: 'init:project-link-progress'; runId: string; step: string; status: string; detail: string }
  | { type: 'init:project-link-finished'; runId: string; projectKey: string; worktreePath: string; branch: string; chainState: string; phaseDetail: unknown }
  // ── Init sync 事件族（I4: init-collab-i4-five-dim-sync）──
  // 逐维三态（未同步/同步中/已同步）+ 结果投影；经既有 init/events SSE 通道。
  | { type: 'init:sync-started'; runId: string; entry: unknown; chainState: string }
  | { type: 'init:sync-progress'; runId: string; dim: string; status: string; detail: string }
  | { type: 'init:sync-finished'; runId: string; bundleId: string; generatedAt: string; chainState: string; phaseDetail: unknown; dims: unknown; rePushedOnly: boolean }
  | { type: 'init:sync-failed'; runId: string; error: string; classification: string; message: string; retryable: boolean }
  | { type: 'init:step-event'; phase: string; step: string; entry: unknown; payload: unknown };

// Singleton shared by daemon, planner, and event-queue
export const localBus = new EventEmitter<{ event: [LocalBusEvent] }>();

// Fire-and-forget publish helper
export function publish(event: LocalBusEvent): void {
  localBus.emit('event', event);
}
