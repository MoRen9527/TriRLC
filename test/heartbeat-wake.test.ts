// ── TriRLC Heartbeat Wake Tests ──
// Covers: coalescing, priority preemption, retry cooldown,
// timer preemption, handler disposer generation guard, enable/disable toggle.
//
// NOTE: mock.timers.tick() fires setTimeout callbacks synchronously.
// Since test handlers are synchronous (push + return), all side effects
// are observable immediately after tick() without microtask flushing.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  createHeartbeatWake,
  type HeartbeatRunResult,
  type TriRLCHeartbeatWake,
} from "../src/heartbeat/heartbeat-wake.js";

describe("TriRLCHeartbeatWake", () => {
  let wake: TriRLCHeartbeatWake;

  beforeEach(() => {
    wake = createHeartbeatWake();
    mock.timers.enable({ apis: ["setTimeout"] });
  });

  afterEach(() => {
    mock.timers.reset();
  });

  // ── coalescing ──

  it("coalesces multiple rapid requests into a single handler invocation", () => {
    const calls: HeartbeatRunResult[] = [];
    wake.setWakeHandler(async () => {
      calls.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    // Rapid-fire 5 requests — all should coalesce into one
    wake.requestHeartbeatNow({ reason: "action" });
    wake.requestHeartbeatNow({ reason: "action" });
    wake.requestHeartbeatNow({ reason: "action" });
    wake.requestHeartbeatNow({ reason: "action" });
    wake.requestHeartbeatNow({ reason: "action" });

    // Advance past the coalesce window (250ms default)
    mock.timers.tick(300);

    assert.equal(calls.length, 1, "handler should be called exactly once after coalescing");
  });

  // ── priority preemption ──

  it("higher-priority wake preempts lower-priority pending wake", () => {
    const reasons: (string | undefined)[] = [];
    wake.setWakeHandler(async (opts) => {
      reasons.push(opts.reason);
      return { status: "ran", durationMs: 1 };
    });

    // Queue a low-priority wake
    wake.requestHeartbeatNow({ reason: "interval" });
    // Queue a high-priority wake — should preempt
    wake.requestHeartbeatNow({ reason: "action" });

    mock.timers.tick(300);

    assert.equal(reasons.length, 1, "handler should be called once");
    assert.equal(reasons[0], "action", "highest priority reason should win");
  });

  it("lower-priority wake does not preempt higher-priority pending wake", () => {
    const reasons: (string | undefined)[] = [];
    wake.setWakeHandler(async (opts) => {
      reasons.push(opts.reason);
      return { status: "ran", durationMs: 1 };
    });

    // Queue a high-priority wake first
    wake.requestHeartbeatNow({ reason: "action" });
    // Queue a low-priority wake — should NOT preempt
    wake.requestHeartbeatNow({ reason: "retry" });

    mock.timers.tick(300);

    assert.equal(reasons.length, 1, "handler should be called once");
    assert.equal(reasons[0], "action", "higher priority should not be preempted by lower");
  });

  // ── retry cooldown ──

  it("retry cooldown prevents premature re-fire", () => {
    const calls: number[] = [];
    wake.setWakeHandler(async () => {
      calls.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    // First request fires immediately
    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });
    mock.timers.tick(10);
    assert.equal(calls.length, 1);

    // Queue another wake — this triggers a retry schedule with 1000ms cooldown
    wake.requestHeartbeatNow({ reason: "retry", coalesceMs: 0 });
    // Advance only 100ms — retry cooldown (1000ms) should block, so still 1 call
    mock.timers.tick(100);

    assert.equal(calls.length, 1, "retry cooldown should delay wake, not fire immediately");
  });

  // ── timer preemption ──

  it("new sooner-firing timer preempts later existing timer", () => {
    const calls: number[] = [];
    wake.setWakeHandler(async () => {
      calls.push(Date.now());
      return { status: "ran", durationMs: 1 };
    });

    // Schedule far in the future
    wake.requestHeartbeatNow({ reason: "interval", coalesceMs: 500 });
    // Schedule much sooner — should preempt the first timer
    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 10 });

    // Advance just past the sooner timer (10ms) but before the later one (500ms)
    mock.timers.tick(20);

    assert.equal(calls.length, 1, "only one handler invocation should fire at the sooner time");
  });

  // ── handler disposer generation guard ──

  it("stale disposer does not clear a newer handler registration", () => {
    const calls1: HeartbeatRunResult[] = [];
    const calls2: HeartbeatRunResult[] = [];

    const disposer1 = wake.setWakeHandler(async () => {
      calls1.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    // Replace with a new handler
    wake.setWakeHandler(async () => {
      calls2.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    // Stale disposer should be a no-op
    disposer1();

    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });
    mock.timers.tick(10);

    assert.equal(calls1.length, 0, "stale handler should not receive calls");
    assert.equal(calls2.length, 1, "current handler should receive calls");
  });

  it("current disposer correctly clears the handler", () => {
    const calls: HeartbeatRunResult[] = [];
    const disposer = wake.setWakeHandler(async () => {
      calls.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    // Clear via current disposer
    disposer();

    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });
    mock.timers.tick(10);

    assert.equal(calls.length, 0, "cleared handler should not receive calls");
  });

  // ── enable/disable toggle ──

  it("disabled wake ignores requestHeartbeatNow", () => {
    const calls: HeartbeatRunResult[] = [];
    wake.setWakeHandler(async () => {
      calls.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    wake.setEnabled(false);
    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });

    mock.timers.tick(10);

    assert.equal(calls.length, 0, "disabled wake should not call handler");
  });

  it("re-enabling allows wake again", () => {
    const calls: HeartbeatRunResult[] = [];
    wake.setWakeHandler(async () => {
      calls.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    wake.setEnabled(false);
    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });
    mock.timers.tick(10);
    assert.equal(calls.length, 0);

    wake.setEnabled(true);
    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });
    mock.timers.tick(10);

    assert.equal(calls.length, 1, "re-enabled wake should call handler");
  });

  it("isEnabled reflects current state", () => {
    assert.equal(wake.isEnabled(), true, "default should be enabled");
    wake.setEnabled(false);
    assert.equal(wake.isEnabled(), false);
    wake.setEnabled(true);
    assert.equal(wake.isEnabled(), true);
  });

  // ── hasPendingWake ──

  it("hasPendingWake returns true when a wake is queued", () => {
    assert.equal(wake.hasPendingWake(), false, "no pending wake initially");
    wake.requestHeartbeatNow({ reason: "action" });
    assert.equal(wake.hasPendingWake(), true, "pending after request");
  });

  it("hasPendingWake returns false after execution completes", () => {
    wake.setWakeHandler(async () => {
      return { status: "ran", durationMs: 1 };
    });

    wake.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });
    assert.equal(wake.hasPendingWake(), true);

    mock.timers.tick(10);

    // After tick, the timer fired, handler was called (sync),
    // pendingWake was cleared, so no pending wake remains
    assert.equal(wake.hasPendingWake(), false, "no pending after execution");
  });

  // ── multiple independent instances ──

  it("each createHeartbeatWake() instance is independent", () => {
    const callsA: HeartbeatRunResult[] = [];
    const callsB: HeartbeatRunResult[] = [];

    const wakeA = createHeartbeatWake();
    const wakeB = createHeartbeatWake();

    wakeA.setWakeHandler(async () => {
      callsA.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });
    wakeB.setWakeHandler(async () => {
      callsB.push({ status: "ran", durationMs: 1 });
      return { status: "ran", durationMs: 1 };
    });

    wakeA.requestHeartbeatNow({ reason: "action", coalesceMs: 0 });

    mock.timers.tick(10);

    assert.equal(callsA.length, 1, "instance A handler should be called");
    assert.equal(callsB.length, 0, "instance B handler should NOT be called");
  });
});
