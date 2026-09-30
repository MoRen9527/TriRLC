// ── TriRLC Cron Timer ──
// Phase 3: timer management, missed-job catchup, and timeout execution.
// Pattern adapted from vendor/openclaw/src/cron/service/timer.ts.
//
// Constants reused from openclaw design:
//   MAX_TIMER_DELAY_MS=60000 — max setTimeout delay to avoid drift
//   MIN_REFIRE_GAP_MS=2000  — safety net to prevent spin-loops

import type { CronJob } from "./types.js";
import { parseCronSchedule } from "./scheduler.js";
import { runHeartbeatAgent } from "../heartbeat/agent-runner.js";
import type { SessionRecord } from "../session-store/types.js";
import { publish } from "../localbus/bus.js";

const LOG_PREFIX = "[trilc:cron]";

export const MAX_TIMER_DELAY_MS = 60_000;
export const MIN_REFIRE_GAP_MS = 2_000;
const DEFAULT_MISSED_JOB_STAGGER_MS = 5_000;
const DEFAULT_MAX_MISSED_JOBS_PER_RESTART = 5;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60_000;
const CONSECUTIVE_FAILURE_DEGRADED_THRESHOLD = 3;

// ── Internal types ──

export interface CronStoreLike {
  addJob(input: { name: string; schedule: { kind: string; everyMs?: number; expr?: string; tz?: string }; systemPrompt: string; enabled: boolean }): CronJob;
  removeJob(id: string): boolean;
  getJob(id: string): CronJob | undefined;
  listJobs(): CronJob[];
  updateJob(id: string, patch: Record<string, unknown>): CronJob | null;
  updateJobRun(id: string, updates: Record<string, unknown>): void;
  addExecutionLog(jobId: string, status: string, startedAt: string, durationMs: number, errorMessage?: string): unknown;
  getExecutionLogs(jobId: string, limit?: number): unknown[];
  saveCronStore(): void;
  db: unknown;
}

export interface CronTimerDeps {
  store: CronStoreLike;
  sessionStore: {
    createSession(session: { id: string; model: string; systemPrompt: string; cwd: string; title?: string }): void;
    saveMessages(sessionId: string, messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string | null; toolCalls?: unknown; toolCallId?: string; reasoningContent?: string }>): void;
    updateSessionStatus(sessionId: string, status: SessionRecord["status"]): void;
  };
  cwd: string;
  onJobTrigger?: (job: CronJob) => void;
  /** FADE-ASSESS-005: 员工岗在岗校验（读 CompanyInitState.employees）。
   *  job.roleId 设置后拉起 agent 前校验；非在岗 → skipped，不拉起。缺省不校验。 */
  isRoleActive?: (roleId: string) => Promise<boolean>;
  /** FADE-ASSESS-003 小乔指标：roleId 门禁拒绝回调（daemon 注入埋点；缺省静默）。 */
  onRoleGateDenied?: (roleId: string) => void;
}

export interface CronTimerState {
  armTimerId: ReturnType<typeof setTimeout> | null;
  started: boolean;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  locked: boolean;
  lockQueue: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  consecutiveFailures: number;
  degraded: boolean;
}

export function createCronTimerState(): CronTimerState {
  return { armTimerId: null, started: false, timers: new Map(), locked: false, lockQueue: [], consecutiveFailures: 0, degraded: false };
}

// ── Locked mutex (in-process promise chain) ──

function acquireLock(state: CronTimerState): Promise<void> {
  if (!state.locked) { state.locked = true; return Promise.resolve(); }
  return new Promise<void>((resolve, reject) => { state.lockQueue.push({ resolve, reject }); });
}

function releaseLock(state: CronTimerState): void {
  const next = state.lockQueue.shift();
  if (next) { next.resolve(); } else { state.locked = false; }
}

async function withLock<T>(state: CronTimerState, fn: () => Promise<T>): Promise<T> {
  await acquireLock(state);
  try { return await fn(); } finally { releaseLock(state); }
}

// ── Timer management ──

export function armTimer(state: CronTimerState, deps: CronTimerDeps): void {
  if (state.armTimerId) { clearTimeout(state.armTimerId); state.armTimerId = null; }
  if (!state.started) return;

  const jobs = deps.store.listJobs();
  const enabledJobs = jobs.filter((j) => j.enabled && j.nextRunAt);
  if (enabledJobs.length === 0) return;

  const now = Date.now();
  let earliest = Infinity;
  for (const job of enabledJobs) {
    const next = new Date(job.nextRunAt!).getTime();
    if (next < earliest) earliest = next;
  }
  if (!isFinite(earliest)) return;

  const delay = Math.max(0, earliest - now);
  const flooredDelay = delay === 0 ? MIN_REFIRE_GAP_MS : delay;
  const clampedDelay = Math.min(flooredDelay, MAX_TIMER_DELAY_MS);

  state.armTimerId = setTimeout(() => {
    state.armTimerId = null;
    void onTimerTick(state, deps).catch((err) => {
      console.error(`${LOG_PREFIX} timer tick failed:`, err instanceof Error ? err.message : String(err));
    });
  }, clampedDelay);
  state.armTimerId.unref?.();
}

export function stopTimer(state: CronTimerState): void {
  if (state.armTimerId) { clearTimeout(state.armTimerId); state.armTimerId = null; }
}

// ── Timer tick ──

async function onTimerTick(state: CronTimerState, deps: CronTimerDeps): Promise<void> {
  if (state.locked) { armTimer(state, deps); return; }

  await withLock(state, async () => {
    const jobs = deps.store.listJobs();
    const now = Date.now();
    const dueJobs = jobs.filter((j) => {
      if (!j.enabled) return false;
      if (j.state === "running") return false;
      if (!j.nextRunAt) return false;
      return new Date(j.nextRunAt).getTime() <= now;
    });

    for (const job of dueJobs) {
      await executeJobScheduled(state, deps, job);
    }
  });

  armTimer(state, deps);
}

// ── Execute scheduled job ──

async function executeJobScheduled(state: CronTimerState, deps: CronTimerDeps, job: CronJob): Promise<void> {
  if (!job.enabled) return;
  deps.store.updateJobRun(job.id, { state: "running" });
  deps.onJobTrigger?.(job);

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();

  try {
    const result = await executeJobCoreWithTimeout(state, deps, job);
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;

    deps.store.addExecutionLog(job.id, result.status, startedAtIso, durationMs, result.error);

    // FADE-ASSESS-005: skipped（门禁拒绝）记 skipped 且不 incrementError——
    // job 本身未失败，仅本次因非在岗未拉起。
    const lastRunStatus =
      result.status === "ok" ? "ok" : result.status === "skipped" ? "skipped" : "error";
    const newState = result.status === "ok" || result.status === "skipped" ? "idle" : "failed";
    deps.store.updateJobRun(job.id, {
      lastRunAt: startedAtIso, lastRunStatus, state: newState,
      incrementRun: true,
      ...(result.status !== "ok" && result.status !== "skipped" ? { incrementError: true } : {}),
    });

    // ── Consecutive failure tracking ──
    // FADE-ASSESS-005（终审收口 ⑤）：skipped（门禁拒绝）不解除 degraded——
    // 只有真实 ok 触发恢复/清零；skipped 计入非 ok 路径。
    if (result.status === "ok") {
      if (state.degraded) {
        state.consecutiveFailures = 0;
        state.degraded = false;
        publish({ type: "cron:recovered" });
        console.log(`${LOG_PREFIX} cron recovered after degraded period`);
      } else {
        state.consecutiveFailures = 0;
      }
    } else {
      state.consecutiveFailures++;
      if (state.consecutiveFailures >= CONSECUTIVE_FAILURE_DEGRADED_THRESHOLD && !state.degraded) {
        state.degraded = true;
        publish({ type: "cron:degraded", consecutiveFailures: state.consecutiveFailures });
        console.warn(`${LOG_PREFIX} cron degraded: ${state.consecutiveFailures} consecutive failures`);
      }
    }

    const refreshed = deps.store.getJob(job.id);
    if (refreshed && refreshed.enabled) {
      const { nextRunMs } = parseCronSchedule(refreshed.schedule);
      const next = nextRunMs();
      if (next !== null) {
        deps.store.updateJobRun(refreshed.id, {
          nextRunAt: new Date(Math.max(next, endedAt + MIN_REFIRE_GAP_MS)).toISOString(),
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const endedAt = Date.now();
    console.error(`${LOG_PREFIX} job ${job.name} (${job.id}) threw: ${msg}`);
    deps.store.addExecutionLog(job.id, "error", startedAtIso, endedAt - startedAt, msg);
    deps.store.updateJobRun(job.id, {
      lastRunAt: startedAtIso, lastRunStatus: "error", state: "failed",
      incrementRun: true, incrementError: true,
    });

    // ── Consecutive failure tracking (throw path) ──
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= CONSECUTIVE_FAILURE_DEGRADED_THRESHOLD && !state.degraded) {
      state.degraded = true;
      publish({ type: "cron:degraded", consecutiveFailures: state.consecutiveFailures });
      console.warn(`${LOG_PREFIX} cron degraded: ${state.consecutiveFailures} consecutive failures`);
    }
  }
}

// ── Job execution core with timeout ──

interface JobExecutionResult { status: "ok" | "error" | "timeout" | "skipped"; error?: string; }

/**
 * FADE-ASSESS-005 调度门禁判定（可测纯函数）：
 * job 绑定员工岗 roleId 且注入 isRoleActive → 校验 roster.active；
 * 非在岗 → { run: false, reason: owner_not_active }（只拉起在岗岗，不静默）。
 * 未绑定 roleId / 未注入校验函数 → 放行（向后兼容）。
 */
export async function shouldRunJob(
  deps: Pick<CronTimerDeps, "isRoleActive" | "onRoleGateDenied">,
  job: CronJob,
): Promise<{ run: boolean; reason?: string }> {
  if (job.roleId && deps.isRoleActive) {
    const active = await deps.isRoleActive(job.roleId);
    if (!active) {
      // FADE-ASSESS-003 小乔指标：调度路由到未在岗岗 → routing_error 埋点（轻量回调）
      deps.onRoleGateDenied?.(job.roleId);
      return { run: false, reason: `owner_not_active: role ${job.roleId} not in active roster` };
    }
  }
  return { run: true };
}

async function executeJobCore(deps: CronTimerDeps, job: CronJob): Promise<JobExecutionResult> {
  // FADE-ASSESS-005（终审收口 ④）：门禁先于 command 分支——绑 roleId 的
  // command job 同样走 roster.active 校验（现役 command job 均未绑 roleId，
  // 行为不变；绑定后非在岗 → skipped，不执行命令、不拉起 agent）。
  const gate = await shouldRunJob(deps, job);
  if (!gate.run) {
    return { status: "skipped", error: gate.reason };
  }

  // REQ-20260806-019: deterministic command execution (no LLM).
  // Weekly-plane shift etc. run as shell commands via child_process, bypassing
  // the agent loop entirely (heartbeat tier has no shell anyway).
  if (job.command) {
    return executeCommand(job.command, deps.cwd);
  }

  const result = await runHeartbeatAgent({
    agentId: `cron-${job.id}`, sessionStore: deps.sessionStore, cwd: deps.cwd,
    model: "tmv-deepseek-v4-flash", maxTurns: 10, systemPrompt: job.systemPrompt,
    userMessage: `Cron job "${job.name}" triggered. Execute your task.`,
  });
  return result.status === "ran" ? { status: "ok" } : { status: "error", error: result.reason };
}

/** Spawn a deterministic shell command, capturing output. */
async function executeCommand(command: string, cwd: string): Promise<JobExecutionResult> {
  const { spawn } = await import("node:child_process");
  const { platform: osPlatform } = await import("node:os");
  const isWin = osPlatform() === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const shellArgs = isWin ? ["/d", "/s", "/c", command] : ["-c", command];

  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const child = spawn(shell, shellArgs, { cwd, windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ status: "timeout", error: `command timed out (${DEFAULT_JOB_TIMEOUT_MS}ms): ${err || out}` });
    }, DEFAULT_JOB_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { err += d.toString(); });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "error", error: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ status: "ok", error: undefined });
      } else {
        resolve({ status: "error", error: `exit=${code} stderr=${err.slice(0, 500)} stdout=${out.slice(0, 500)}` });
      }
    });
  });
}

export async function executeJobCoreWithTimeout(
  _state: CronTimerState, deps: CronTimerDeps, job: CronJob,
  timeoutMs = DEFAULT_JOB_TIMEOUT_MS,
): Promise<JobExecutionResult> {
  const jobPromise = executeJobCore(deps, job);
  // 资源清理：race 结束后必须 clearTimeout 挂起的超时定时器——否则每次 job
  // run 泄漏一个 DEFAULT_JOB_TIMEOUT_MS(10min) 定时器，长驻 daemon 会堆积，
  // 测试进程也会因事件循环不空而无法退出（node:test 挂起被杀）。
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<JobExecutionResult>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timeout", error: `Job timed out after ${timeoutMs}ms` }), timeoutMs);
  });
  const result = await Promise.race([jobPromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  return result;
}

// ── Missed job catchup (on startup) ──

export async function runMissedJobs(state: CronTimerState, deps: CronTimerDeps): Promise<void> {
  const now = Date.now();
  const jobs = deps.store.listJobs();
  const missed = jobs
    .filter((j) => { if (!j.enabled || j.state === "running" || !j.nextRunAt) return false; return new Date(j.nextRunAt).getTime() <= now; })
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime());

  if (missed.length === 0) return;

  const candidates = missed.slice(0, DEFAULT_MAX_MISSED_JOBS_PER_RESTART);
  const deferred = missed.slice(DEFAULT_MAX_MISSED_JOBS_PER_RESTART);
  console.log(`${LOG_PREFIX} startup catchup: ${candidates.length} immediate, ${deferred.length} deferred`);

  for (const job of candidates) { await executeJobScheduled(state, deps, job); }

  if (deferred.length > 0) {
    const baseNow = Date.now();
    let offset = DEFAULT_MISSED_JOB_STAGGER_MS;
    for (const job of deferred) {
      if (!job.enabled) continue;
      deps.store.updateJobRun(job.id, { nextRunAt: new Date(baseNow + offset).toISOString() });
      offset += DEFAULT_MISSED_JOB_STAGGER_MS;
    }
  }
}

// ── Manual / forced run ──

export async function runJobNow(
  state: CronTimerState, deps: CronTimerDeps, id: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; ran: boolean; reason?: string }> {
  const job = deps.store.getJob(id);
  if (!job) return { ok: false, ran: false, reason: "not-found" };
  if (!opts?.force && !job.enabled) return { ok: true, ran: false, reason: "disabled" };
  if (job.state === "running") return { ok: true, ran: false, reason: "already-running" };

  deps.store.updateJobRun(id, { state: "running" });
  deps.onJobTrigger?.(job);

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  try {
    const result = await executeJobCoreWithTimeout(state, deps, job);
    const endedAt = Date.now();
    const durationMs = endedAt - startedAt;
    deps.store.addExecutionLog(job.id, result.status, startedAtIso, durationMs, result.error);

    // FADE-ASSESS-005: skipped（门禁拒绝）记 skipped 且不 incrementError。
    const statusStr =
      result.status === "ok" ? "ok" : result.status === "skipped" ? "skipped" : "error";
    deps.store.updateJobRun(id, { lastRunAt: startedAtIso, lastRunStatus: statusStr, state: "idle", incrementRun: true, ...(result.status !== "ok" && result.status !== "skipped" ? { incrementError: true } : {}) });

    const refreshed = deps.store.getJob(id);
    if (refreshed && refreshed.enabled) {
      const { nextRunMs } = parseCronSchedule(refreshed.schedule);
      const next = nextRunMs();
      if (next !== null) {
        deps.store.updateJobRun(id, { nextRunAt: new Date(Math.max(next, endedAt + MIN_REFIRE_GAP_MS)).toISOString() });
      }
    }
    return { ok: true, ran: true, reason: `status=${result.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const endedAt = Date.now();
    deps.store.addExecutionLog(id, "error", startedAtIso, endedAt - startedAt, msg);
    deps.store.updateJobRun(id, { lastRunAt: startedAtIso, lastRunStatus: "error", state: "failed", incrementRun: true, incrementError: true });
    return { ok: true, ran: true, reason: `error: ${msg}` };
  }
}

export async function enqueueRun(
  state: CronTimerState, deps: CronTimerDeps, id: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; ran: boolean; reason?: string }> {
  return withLock(state, async () => runJobNow(state, deps, id, opts));
}
