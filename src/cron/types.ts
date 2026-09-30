// ── TriRLC Cron Types ──
// Shared type definitions for the cron engine.
// Phase 3: CronJobPatch, ExecutionLogEntry added.

/**
 * Cron schedule definition.
 * - every: simple interval in milliseconds (e.g. every 5 minutes)
 * - cron: POSIX cron expression with optional timezone
 */
export type CronSchedule =
  | { kind: "every"; everyMs: number }
  | { kind: "cron"; expr: string; tz?: string };

/** Runtime state of a cron job. */
export type CronJobState = "idle" | "running" | "failed";

/** Result of the last run. */
export type CronLastRunStatus = "ok" | "error" | "skipped";

/** Execution log entry status (including timeout). */
export type ExecutionLogStatus = "ok" | "error" | "skipped" | "timeout";

/**
 * A cron job persisted in SQLite.
 * Stores the schedule, prompt, execution counters, and timestamps.
 */
export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  systemPrompt: string;
  /** REQ-20260806-019: deterministic command execution (no LLM). Mutually exclusive with systemPrompt usage. */
  command?: string;
  /** FADE-ASSESS-005: 绑定的员工岗 roleId。设置后调度拉起前校验 roster.active，
   *  非在岗 → skipped（owner_not_active），不拉起 agent 会话。缺省不校验。 */
  roleId?: string;
  enabled: boolean;
  state: CronJobState;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: CronLastRunStatus;
  nextRunAt?: string;
  runCount: number;
  errorCount: number;
}

/** Input to create a new cron job (auto-generated fields omitted). */
export type CronJobCreate = Omit<
  CronJob,
  "id" | "state" | "createdAt" | "updatedAt" | "runCount" | "errorCount"
>;

/** Patch for updating an existing cron job. All fields optional. */
export interface CronJobPatch {
  name?: string;
  schedule?: CronSchedule;
  systemPrompt?: string;
  command?: string;
  roleId?: string;
  enabled?: boolean;
}

/** A single execution log entry for a cron job run. */
export interface ExecutionLogEntry {
  id: number;
  jobId: string;
  status: ExecutionLogStatus;
  startedAt: string;
  durationMs: number | null;
  errorMessage: string | null;
}

/** Result of a manual/forced job run. */
export interface CronRunResult {
  ok: boolean;
  ran: boolean;
  reason?: string;
  jobId?: string;
}
