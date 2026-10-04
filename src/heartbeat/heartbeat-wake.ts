// ── TriRLC Heartbeat Wake ──
// Independent wake coalescing / scheduling module.
// Extracted from ConnectionManager (CTO-008-M); absorbed from openclaw heartbeat-wake pattern.
//
// Responsibilities:
//   - Coalesce rapid heartbeat requests within a configurable window (default 250ms)
//   - Priority-based preemption: retry < interval < default < action
//   - Retry cooldown guard (1s minimum between retries) prevents collapse
//   - Handler disposer with generation guard (prevents stale cleanup from old registrations)
//   - Enable/disable toggle for graceful shutdown
//   - timer.unref() so heartbeat timers do not keep the process alive

export type HeartbeatRunResult =
  | { status: "ran"; durationMs: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export type HeartbeatWakeHandler = (opts: {
  reason?: string;
  agentId?: string;
  sessionKey?: string;
}) => Promise<HeartbeatRunResult>;

export interface TriRLCHeartbeatWake {
  /**
   * Register (or clear) the wake handler.
   * Returns a disposer function that clears this specific registration.
   * Stale disposers (from previous registrations) are no-ops via generation guard.
   */
  setWakeHandler(handler: HeartbeatWakeHandler | null): () => void;
  /**
   * Request an immediate heartbeat with coalescing.
   * Multiple rapid calls within coalesceMs (default 250ms) are merged.
   * Higher-priority reasons preempt lower-priority pending wakes.
   */
  requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void;
  /** Enable or disable all heartbeat wake activity. */
  setEnabled(enabled: boolean): void;
  /** Whether wakes are currently enabled. */
  isEnabled(): boolean;
  /** Whether a wake is pending (queued, timer scheduled, or deferred). */
  hasPendingWake(): boolean;
}

// ── Wake Priority ──

const WAKE_PRIORITY = {
  RETRY: 0,
  INTERVAL: 1,
  DEFAULT: 2,
  ACTION: 3,
} as const;

type WakeReasonKind = "retry" | "interval" | "default" | "action";

interface PendingWake {
  reason: WakeReasonKind;
  priority: number;
  requestedAt: number;
}

function resolvePriority(reason?: string): number {
  if (reason === "retry") return WAKE_PRIORITY.RETRY;
  if (reason === "interval") return WAKE_PRIORITY.INTERVAL;
  if (reason === "action") return WAKE_PRIORITY.ACTION;
  return WAKE_PRIORITY.DEFAULT;
}

// ── Factory ──

export function createHeartbeatWake(): TriRLCHeartbeatWake {
  // ── Module-scoped state (per instance) ──
  let enabled = true;
  let handler: HeartbeatWakeHandler | null = null;
  let handlerGeneration = 0;
  let pendingWake: PendingWake | null = null;
  let wakeTimer: NodeJS.Timeout | null = null;
  let wakeTimerDueAt: number | null = null;
  let wakeTimerKind: "normal" | "retry" | null = null;
  let wakeRunning = false;
  let wakeScheduled = false;

  const COALESCE_MS = 250;
  const RETRY_COOLDOWN_MS = 1_000;

  // ── Internal: schedule ──

  function schedule(coalesceMs: number, kind: "normal" | "retry"): void {
    const delay = Number.isFinite(coalesceMs) ? Math.max(0, coalesceMs) : COALESCE_MS;
    const dueAt = Date.now() + delay;

    if (wakeTimer) {
      // Retry cooldown is a hard minimum — prevents collapse
      if (wakeTimerKind === "retry") return;
      // Keep existing timer if it fires sooner or at the same time
      if (typeof wakeTimerDueAt === "number" && wakeTimerDueAt <= dueAt) return;
      // New request fires sooner — preempt the existing timer
      clearTimeout(wakeTimer);
      wakeTimer = null;
      wakeTimerDueAt = null;
      wakeTimerKind = null;
    }

    wakeTimerDueAt = dueAt;
    wakeTimerKind = kind;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      wakeTimerDueAt = null;
      wakeTimerKind = null;
      wakeScheduled = false;
      executeWake().catch(() => {});
    }, delay);
    wakeTimer.unref?.();
  }

  // ── Internal: executeWake ──

  async function executeWake(): Promise<void> {
    const wake = pendingWake;
    pendingWake = null;
    const currentGen = handlerGeneration;

    if (wakeRunning) {
      // Already running — defer
      if (wake) {
        pendingWake = wake;
        schedule(COALESCE_MS, "normal");
      }
      wakeScheduled = true;
      return;
    }

    const active = handler;
    if (!active) return;

    wakeRunning = true;
    try {
      // Generation guard: if handler was replaced mid-execution, abandon
      if (handlerGeneration !== currentGen) return;

      await active({
        reason: wake?.reason,
      });
    } catch {
      // Handler errors are logged by the consumer; no additional logging here
    } finally {
      wakeRunning = false;
      // If more wakes arrived during execution, schedule another round
      if (pendingWake || wakeScheduled) {
        wakeScheduled = false;
        schedule(RETRY_COOLDOWN_MS, "retry");
      }
    }
  }

  // ── Public API ──

  return {
    setWakeHandler(next: HeartbeatWakeHandler | null): () => void {
      handlerGeneration += 1;
      const generation = handlerGeneration;
      handler = next;

      if (next) {
        // New lifecycle starting (e.g. after in-process restart).
        // Clear stale timer state from previous lifecycle so retry cooldowns
        // do not delay a fresh handler.
        if (wakeTimer) {
          clearTimeout(wakeTimer);
        }
        wakeTimer = null;
        wakeTimerDueAt = null;
        wakeTimerKind = null;
        // Reset execution state that may be stale from interrupted runs
        // in the previous lifecycle. Without this, wakeRunning === true from
        // an interrupted heartbeat blocks all future schedule() attempts.
        wakeRunning = false;
        wakeScheduled = false;
      }

      if (handler && pendingWake) {
        schedule(COALESCE_MS, "normal");
      }

      return () => {
        // Generation guard: stale disposers are no-ops
        if (handlerGeneration !== generation) return;
        if (handler !== next) return;
        handlerGeneration += 1;
        handler = null;
      };
    },

    requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void {
      if (!enabled) return;

      const reason = opts?.reason ?? "action";
      const priority = resolvePriority(reason);
      const wake: PendingWake = {
        reason: reason as WakeReasonKind,
        priority,
        requestedAt: Date.now(),
      };

      // Merge: keep higher priority, or newer at same priority
      if (
        !pendingWake ||
        priority > pendingWake.priority ||
        (priority === pendingWake.priority && wake.requestedAt >= pendingWake.requestedAt)
      ) {
        pendingWake = wake;
      }

      schedule(opts?.coalesceMs ?? COALESCE_MS, "normal");
    },

    setEnabled(e: boolean): void {
      enabled = e;
      if (!e) {
        // Clear pending wake state on disable
        if (wakeTimer) {
          clearTimeout(wakeTimer);
          wakeTimer = null;
          wakeTimerDueAt = null;
          wakeTimerKind = null;
        }
        pendingWake = null;
        wakeScheduled = false;
      }
    },

    isEnabled(): boolean {
      return enabled;
    },

    hasPendingWake(): boolean {
      return pendingWake !== null || wakeTimer !== null || wakeScheduled;
    },
  };
}
