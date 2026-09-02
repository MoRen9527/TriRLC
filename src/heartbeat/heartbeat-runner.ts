// ── TriLC Heartbeat Runner ──
// Per-agent heartbeat scheduling loop built on TriLCHeartbeatWake.
// MVP: single agent with configurable interval.
//
// Scheduling loop:
//   1. Arm setTimeout for the next due agent
//   2. Timer fires -> wake.requestHeartbeatNow()
//   3. Wake handler iterates all due agents, skipping ones with requests-in-flight
//   4. After execution, re-arm for the next cycle
//
// updateAgents() supports hot-reload: new configs merge with existing state,
// preserving nextRunAt for agents that were already scheduled.

import {
  createHeartbeatWake,
  type TriLCHeartbeatWake,
  type HeartbeatRunResult,
} from "./heartbeat-wake.js";
import { runHeartbeatAgent } from "./agent-runner.js";
import type { SessionRecord } from "../session-store/types.js";

export interface HeartbeatAgentConfig {
  /** Unique agent identifier. */
  agentId: string;
  /** Interval between heartbeat executions in milliseconds. */
  intervalMs: number;
  /** Model to use (default: tmv-deepseek-v4-flash). */
  model?: string;
  /** Maximum agent loop turns (default: 10). */
  maxTurns?: number;
  /** System prompt override. */
  systemPrompt?: string;
  /** User message override. */
  userMessage?: string;
  /** Working directory for tool execution (REQ-014b: per-agent cwd). */
  cwd?: string;
  /**
   * Event-driven agent (LG-026 组长): no interval timer is armed; the agent
   * runs only when runner.requestHeartbeatNow() fires (e.g. 信箱入件即醒).
   * intervalMs is still required by the config shape but is unused for
   * scheduling (nextRunAt bookkeeping only).
   */
  eventDriven?: boolean;
}

interface AgentRuntimeState extends HeartbeatAgentConfig {
  nextRunAt: number;
  running: boolean;
}

export interface TriLCHeartbeatRunner {
  /** Whether the scheduling loop is active. */
  readonly isRunning: boolean;
  /** Start the scheduling loop. No-op if already started. */
  start(): void;
  /** Stop the scheduling loop and clear all timers. */
  stop(): void;
  /**
   * On-demand wake (LG-026 唤醒链)：fires the wake handler in-process
   * (250ms coalescing by default). Event-driven agents (组长) run on this
   * path regardless of their nextRunAt bookkeeping.
   */
  requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void;
  /**
   * Hot-reload agent configs. Preserves nextRunAt for agents that remain
   * in the new config set; new agents get scheduled immediately.
   */
  updateAgents(configs: HeartbeatAgentConfig[]): void;
}

export function createHeartbeatRunner(opts: {
  sessionStore: {
    createSession(session: {
      id: string;
      model: string;
      systemPrompt: string;
      cwd: string;
      title?: string;
    }): void;
    saveMessages(
      sessionId: string,
      messages: Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string | null;
        toolCalls?: unknown;
        toolCallId?: string;
        reasoningContent?: string;
      }>,
    ): void;
    updateSessionStatus(sessionId: string, status: SessionRecord["status"]): void;
  };
  cwd: string;
}): TriLCHeartbeatRunner {
  const wake: TriLCHeartbeatWake = createHeartbeatWake();
  const { sessionStore, cwd } = opts;

  let agents = new Map<string, AgentRuntimeState>();
  let armTimer: NodeJS.Timeout | null = null;
  let started = false;

  // ── Internal: arm the next wake timer ──

  function arm(): void {
    if (!started) return;
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }

    let earliest: number | null = null;
    for (const [, agent] of agents) {
      if (agent.running) continue;
      // LG-026: event-driven agents (组长) have no interval timer — wake-only
      if (agent.eventDriven) continue;
      if (earliest === null || agent.nextRunAt < earliest) {
        earliest = agent.nextRunAt;
      }
    }

    if (earliest === null) return;

    const delay = Math.max(0, earliest - Date.now());
    armTimer = setTimeout(() => {
      armTimer = null;
      wake.requestHeartbeatNow({ reason: "interval" });
    }, delay);
    armTimer.unref?.();
  }

  // ── Wake handler: execute all due agents ──

  wake.setWakeHandler(async (_wakeOpts) => {
    const now = Date.now();
    const results: HeartbeatRunResult[] = [];

    for (const [id, agent] of agents) {
      // requests-in-flight skip: if the agent is already running, skip
      if (agent.running) continue;
      // Event-driven agents (组长) run on every wake regardless of nextRunAt
      // (LG-026 来件即醒); interval agents still respect their schedule.
      if (!agent.eventDriven && agent.nextRunAt > now) continue;

      agent.running = true;

      try {
        const result = await runHeartbeatAgent({
          agentId: id,
          sessionStore,
          // REQ-014b: per-agent cwd (onboarding workspace) overrides global cwd
          cwd: agent.cwd ?? cwd,
          model: agent.model,
          maxTurns: agent.maxTurns,
          systemPrompt: agent.systemPrompt,
          userMessage: agent.userMessage,
        });
        results.push(result);
      } catch {
        results.push({ status: "failed", reason: `agent ${id} threw` });
      } finally {
        agent.running = false;
        // Schedule next run
        agent.nextRunAt = Date.now() + agent.intervalMs;
      }
    }

    // Re-arm for the next cycle
    arm();

    // Return the last result (or a skip if nothing was due)
    const last = results[results.length - 1];
    if (last) return last;
    return { status: "skipped", reason: "no agents due" };
  });

  // ── Public API ──

  return {
    get isRunning(): boolean {
      return started;
    },

    requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void {
      wake.requestHeartbeatNow(opts);
    },

    start(): void {
      if (started) return;
      started = true;
      const now = Date.now();
      for (const [, agent] of agents) {
        // Spread initial execution to avoid thundering herd
        agent.nextRunAt = now + agent.intervalMs;
      }
      arm();
    },

    stop(): void {
      started = false;
      wake.setWakeHandler(null);
      if (armTimer) {
        clearTimeout(armTimer);
        armTimer = null;
      }
    },

    updateAgents(configs: HeartbeatAgentConfig[]): void {
      const now = Date.now();
      const newAgents = new Map<string, AgentRuntimeState>();

      for (const cfg of configs) {
        const existing = agents.get(cfg.agentId);
        newAgents.set(cfg.agentId, {
          ...cfg,
          // Preserve nextRunAt for agents that were already scheduled;
          // new agents get scheduled after their first interval.
          nextRunAt: existing?.nextRunAt ?? (now + cfg.intervalMs),
          running: existing?.running ?? false,
        });
      }

      agents = newAgents;

      // Re-arm if currently running and there are agents to schedule
      if (started) arm();
    },
  };
}
