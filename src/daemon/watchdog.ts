// ── TriRLC Watchdog ──
// Independent watchdog process that monitors the TriRLC daemon child process.
// On crash: exponential backoff restart (1s→2s→4s→8s→16s→32s cap).
// Rate limit: max 5 restarts per 10-minute sliding window.
// On limit exceeded: stop, write error log, emit TUI notification file.
//
// Usage:
//   trilc watchdog [--port 8711] [--data-dir <path>]
//
// The watchdog spawns the main TriRLC process as a child and monitors its
// lifecycle. It is designed to be used as a standalone supervisory process,
// separate from the OS-level daemon registration (schtasks/launchd/systemd).

import { fork, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, appendFileSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { hostname } from "node:os";

const LOG_PREFIX = "[trilc:watchdog]";

// ── Constants ──

/** Exponential backoff delays in ms: 1s, 2s, 4s, 8s, 16s, 32s (cap). */
const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000];

/** Maximum restart attempts within the sliding window. */
const MAX_RESTARTS_PER_WINDOW = 5;

/** Sliding window duration for rate limiting (10 minutes). */
const WINDOW_DURATION_MS = 10 * 60 * 1_000;

/** Minimum uptime before resetting backoff index (process stayed alive this long). */
const STABLE_UPTIME_RESET_MS = 60 * 1_000;

/** Poll interval for child health silent check (ms). */
const SILENT_CHECK_INTERVAL_MS = 5_000;

/** File written to dataDir when the watchdog rate limit is exceeded. */
const ALERT_FILENAME = "watchdog-alert.json";

// ── Types ──

export interface WatchdogConfig {
  /** Path to the node binary (typically process.execPath). */
  nodeBin: string;
  /** Path to the entry script (dist/index.js). */
  entryScript: string;
  /** CLI program arguments forwarded to the child. */
  programArgs: string[];
  /** Working directory for the child process. */
  cwd: string;
  /** Environment variables to pass to the child. */
  env?: Record<string, string>;
  /** Data directory for watchdog state and alert files. */
  dataDir: string;
  /** Port the daemon listens on (used for health check). */
  port: number;
}

export interface WatchdogState {
  /** Current restart attempt index into BACKOFF_SEQUENCE_MS (0-based). */
  backoffIndex: number;
  /** Timestamps of recent restarts for sliding window tracking. */
  restartTimestamps: number[];
  /** Whether the watchdog is currently active. */
  running: boolean;
  /** PID of the current child process. */
  childPid: number | null;
  /** When the current child was started (epoch ms). */
  childStartedAt: number | null;
  /** Total number of restarts since watchdog started. */
  totalRestarts: number;
  /** Whether the rate limit has been exceeded. */
  rateLimitExceeded: boolean;
}

export interface WatchdogAlert {
  type: "watchdog:rate_limit_exceeded";
  message: string;
  totalRestarts: number;
  windowDurationMinutes: number;
  maxRestartsPerWindow: number;
  lastRestartTimestamps: string[];
  pid: number;
  hostname: string;
  timestamp: string;
}

// ── Default config resolution ──

export function resolveWatchdogConfig(
  port: number,
  dataDir: string,
): WatchdogConfig {
  const scriptDir = dirname(fileURLToPath(import.meta.url));

  // Resolve entry script: dist/index.js (MSI deployment) or dev path
  const distIndex = resolve(scriptDir, "..", "index.js");
  const entryScript = existsSync(distIndex)
    ? distIndex
    : resolve(scriptDir, "..", "..", "dist", "index.js");

  return {
    nodeBin: process.execPath,
    entryScript,
    programArgs: [],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TRILC_PORT: String(port),
      TRILC_DATA_DIR: dataDir,
    },
    dataDir,
    port,
  };
}

// ── Watchdog Implementation ──

export function createWatchdog(config: WatchdogConfig) {
  const state: WatchdogState = {
    backoffIndex: 0,
    restartTimestamps: [],
    running: false,
    childPid: null,
    childStartedAt: null,
    totalRestarts: 0,
    rateLimitExceeded: false,
  };

  let child: ChildProcess | null = null;
  let silentCheckTimer: NodeJS.Timeout | null = null;
  let stableTimer: NodeJS.Timeout | null = null;

  // Ensure data directory exists
  if (!existsSync(config.dataDir)) {
    mkdirSync(config.dataDir, { recursive: true });
  }

  // Clear stale alert file from previous runs
  const alertPath = resolve(config.dataDir, ALERT_FILENAME);
  try { unlinkSync(alertPath); } catch { /* ignore */ }

  // ── Logging ──

  function log(message: string): void {
    const line = `${new Date().toISOString()} ${LOG_PREFIX} [pid:${process.pid}] ${message}`;
    console.log(line);
    try {
      const logPath = resolve(config.dataDir, "watchdog.log");
      appendFileSync(logPath, line + "\n", "utf-8");
    } catch {
      // Best-effort log write
    }
  }

  function logError(message: string): void {
    const line = `${new Date().toISOString()} ${LOG_PREFIX} ERROR [pid:${process.pid}] ${message}`;
    console.error(line);
    try {
      const logPath = resolve(config.dataDir, "watchdog.log");
      appendFileSync(logPath, line + "\n", "utf-8");
    } catch {
      // Best-effort log write
    }
  }

  // ── Rate limit check ──

  function checkRateLimit(): boolean {
    const now = Date.now();
    // Purge timestamps outside the sliding window
    state.restartTimestamps = state.restartTimestamps.filter(
      (ts) => now - ts <= WINDOW_DURATION_MS,
    );

    if (state.restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW) {
      state.rateLimitExceeded = true;

      const alert: WatchdogAlert = {
        type: "watchdog:rate_limit_exceeded",
        message: `Watchdog rate limit exceeded: ${state.restartTimestamps.length} restarts in ${WINDOW_DURATION_MS / 60_000} minutes (max ${MAX_RESTARTS_PER_WINDOW}). Watchdog stopping.`,
        totalRestarts: state.totalRestarts,
        windowDurationMinutes: WINDOW_DURATION_MS / 60_000,
        maxRestartsPerWindow: MAX_RESTARTS_PER_WINDOW,
        lastRestartTimestamps: state.restartTimestamps.map((ts) =>
          new Date(ts).toISOString(),
        ),
        pid: process.pid,
        hostname: hostname(),
        timestamp: new Date().toISOString(),
      };

      logError(alert.message);

      // Write alert file for the TUI/daemon to discover on next successful start
      try {
        writeFileSync(alertPath, JSON.stringify(alert, null, 2), "utf-8");
        log(`Alert written to ${alertPath}`);
      } catch (err) {
        logError(`Failed to write alert file: ${err instanceof Error ? err.message : String(err)}`);
      }

      return false;
    }

    return true;
  }

  // ── Backoff calculation ──

  function getBackoffDelay(): number {
    const idx = Math.min(state.backoffIndex, BACKOFF_SEQUENCE_MS.length - 1);
    return BACKOFF_SEQUENCE_MS[idx];
  }

  // ── Spawn child process ──

  function spawn(): boolean {
    if (state.rateLimitExceeded) return false;

    // Rate limit check before spawning
    if (!checkRateLimit()) return false;

    const now = Date.now();
    state.restartTimestamps.push(now);
    state.childStartedAt = now;

    log(
      `Spawning child: ${config.nodeBin} ${config.entryScript} ` +
      `(backoffIndex=${state.backoffIndex}, totalRestarts=${state.totalRestarts})`,
    );

    try {
      child = fork(config.entryScript, config.programArgs, {
        execPath: config.nodeBin,
        cwd: config.cwd,
        env: config.env ?? process.env,
        stdio: "inherit", // Forward child stdio so logs are visible
        silent: false,
      });

      state.childPid = child.pid ?? null;
      state.running = true;
      state.totalRestarts++;

      child.on("exit", (code, signal) => {
        const reason = signal
          ? `signal ${signal}`
          : `exit code ${code ?? "unknown"}`;
        log(`Child process exited (${reason}), pid=${state.childPid}`);

        child = null;
        state.childPid = null;
        state.running = false;

        if (silentCheckTimer) {
          clearInterval(silentCheckTimer);
          silentCheckTimer = null;
        }
        if (stableTimer) {
          clearTimeout(stableTimer);
          stableTimer = null;
        }

        // If we are shutting down intentionally, do not restart
        if (!state.running && state.rateLimitExceeded) {
          log("Rate limit exceeded; watchdog will not restart.");
          return;
        }

        // Schedule restart with backoff
        const delay = getBackoffDelay();
        log(`Scheduling restart in ${delay}ms (backoff index ${state.backoffIndex})`);

        setTimeout(() => {
          if (state.rateLimitExceeded) return;
          // Advance backoff only if the child didn't achieve stable uptime
          state.backoffIndex = Math.min(
            state.backoffIndex + 1,
            BACKOFF_SEQUENCE_MS.length - 1,
          );
          spawn();
        }, delay);
      });

      child.on("error", (err) => {
        logError(`Child process error: ${err.message}`);
        // The 'exit' event will fire after 'error'; let it handle restart
      });

      // ── Silent health check ──
      // Periodically verify the child is still alive via pid check.
      // This catches cases where the child process was killed externally
      // but the 'exit' event hasn't fired yet.
      silentCheckTimer = setInterval(() => {
        if (!child || !child.pid) return;
        try {
          // process.kill with signal 0 tests existence without sending a signal
          process.kill(child.pid, 0);
        } catch {
          log(`Silent check: child pid ${child.pid} not found, waiting for exit event`);
          // The 'exit' event should fire; we just log the discrepancy
        }
      }, SILENT_CHECK_INTERVAL_MS);
      silentCheckTimer.unref?.();

      // ── Stable uptime reset ──
      // If the child stays alive for STABLE_UPTIME_RESET_MS, reset backoff index
      stableTimer = setTimeout(() => {
        if (state.backoffIndex > 0) {
          log(
            `Child stable for ${STABLE_UPTIME_RESET_MS}ms, resetting backoff ` +
            `(was index ${state.backoffIndex})`,
          );
          state.backoffIndex = 0;
        }
      }, STABLE_UPTIME_RESET_MS);
      stableTimer.unref?.();

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to spawn child: ${msg}`);
      state.running = false;
      return false;
    }
  }

  // ── Public API ──

  return {
    /** Start the watchdog. Spawns the child and enters the monitoring loop. */
    start(): boolean {
      if (state.running) {
        log("Watchdog already running, ignoring start()");
        return true;
      }

      state.rateLimitExceeded = false;
      state.backoffIndex = 0;
      state.restartTimestamps = [];
      state.totalRestarts = 0;

      log("Watchdog starting");
      return spawn();
    },

    /** Gracefully stop the watchdog and its child process. */
    stop(): void {
      log("Watchdog stopping");
      state.running = false;

      if (silentCheckTimer) {
        clearInterval(silentCheckTimer);
        silentCheckTimer = null;
      }
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }

      if (child && child.pid) {
        log(`Sending SIGTERM to child pid ${child.pid}`);
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // Child may already be dead
        }

        // Force kill after 5s if still alive
        setTimeout(() => {
          if (child && child.pid) {
            try {
              log(`Force killing child pid ${child.pid}`);
              process.kill(child.pid, "SIGKILL");
            } catch {
              // Child already dead
            }
          }
        }, 5_000).unref();
      }
    },

    /** Get current watchdog state (for diagnostics). */
    getState(): Readonly<WatchdogState> {
      return { ...state };
    },

    /** Check if there is a pending alert from a previous rate-limit event. */
    getPendingAlert(): WatchdogAlert | null {
      try {
        if (!existsSync(alertPath)) return null;
        const raw = readFileSync(alertPath, "utf-8");
        return JSON.parse(raw) as WatchdogAlert;
      } catch {
        return null;
      }
    },

    /** Clear the pending alert file. */
    clearAlert(): void {
      try { unlinkSync(alertPath); } catch { /* ignore */ }
    },
  };
}

export type Watchdog = ReturnType<typeof createWatchdog>;
