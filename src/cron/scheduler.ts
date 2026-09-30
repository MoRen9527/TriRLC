// ── TriRLC Cron Scheduler ──
// Cron expression + interval parsing via croner.
// Wraps the croner library to provide nextRunMs / pattern introspection.
//
// Phase 2: minimal — parse schedules, compute next run timestamps.
// Phase 3: add timezone awareness, missed-job detection, stagger.

import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

const LOG_PREFIX = "[trilc:cron]";

/**
 * Parse a CronSchedule into a runnable schedule descriptor.
 * Returns the cron pattern string and a utility to get the next run timestamp.
 */
export function parseCronSchedule(
  schedule: CronSchedule,
): { nextRunMs(): number | null; pattern: string } {
  let cronInstance: Cron;

  if (schedule.kind === "every") {
    // Convert interval to a cron-like pattern for display purposes
    const ms = schedule.everyMs;
    if (ms < 1000) {
      throw new Error(`${LOG_PREFIX} interval too small: ${ms}ms (minimum 1s)`);
    }
    const seconds = Math.round(ms / 1000);
    // croner 6-field: sec min hour dom mon dow. Steps must not exceed field max
    // (sec≤59, min≤59, hour≤23). Scale large intervals up.
    let pattern: string;
    if (seconds >= 3600) {
      const hours = Math.round(seconds / 3600);
      pattern = `0 0 */${hours} * * *`;
    } else if (seconds >= 60) {
      const minutes = Math.round(seconds / 60);
      pattern = `0 */${minutes} * * * *`;
    } else {
      pattern = `*/${seconds} * * * * *`;
    }
    cronInstance = new Cron(pattern);
    return {
      nextRunMs: () => {
        const next = cronInstance.nextRun();
        return next ? next.getTime() : null;
      },
      pattern: `every ${ms}ms`,
    };
  }

  if (schedule.kind === "cron") {
    const opts: { timezone?: string } = {};
    if (schedule.tz) opts.timezone = schedule.tz;
    cronInstance = new Cron(schedule.expr, opts);
    const pattern = schedule.expr + (schedule.tz ? ` (${schedule.tz})` : "");
    return {
      nextRunMs: () => {
        const next = cronInstance.nextRun();
        return next ? next.getTime() : null;
      },
      pattern,
    };
  }

  throw new Error(`${LOG_PREFIX} unknown schedule kind: ${(schedule as any).kind}`);
}
