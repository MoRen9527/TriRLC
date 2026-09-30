// ── TriRLC Heartbeat Active Hours ──
// Timezone-aware active/quiet hours configuration for heartbeat scheduling.
//
// MVP default: no restriction (all hours active). Users can configure quiet
// windows during which heartbeat agents are suppressed.
//
// Configuration is loaded from TRILC_ACTIVE_HOURS_CONFIG env var (JSON)
// or trilc-profile.json in the data directory.

// ── Types ──

/** Day-of-week indices: 0=Sunday, 1=Monday, ..., 6=Saturday. */
export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A time-of-day range in HH:MM 24-hour format. */
export interface TimeRange {
  /** Start time in HH:MM format (inclusive). */
  start: string;
  /** End time in HH:MM format (inclusive). */
  end: string;
}

/** An active window: days + time range when heartbeats are allowed. */
export interface ActiveHoursWindow {
  /** Days this window applies to (0-6). Empty = all days. */
  days: DayOfWeek[];
  /** Time range when heartbeats are permitted. */
  time: TimeRange;
}

/** A quiet window: a specific period when heartbeats are suppressed. */
export interface QuietWindow {
  /** Days this quiet window applies to (0-6). Empty = all days. */
  days: DayOfWeek[];
  /** Time range of the quiet period. */
  time: TimeRange;
  /** Human-readable label for diagnostics. */
  label?: string;
}

/** Full active hours configuration. */
export interface ActiveHoursConfig {
  /** Master switch. When false (default), all hours are active (MVP behavior). */
  enabled: boolean;
  /** IANA timezone identifier (e.g. "Asia/Shanghai", "America/New_York"). */
  timezone: string;
  /** Active windows. If empty and enabled is true, defaults to 24/7 active. */
  activeWindows: ActiveHoursWindow[];
  /** Quiet windows that suppress heartbeats even within active windows. */
  quietWindows: QuietWindow[];
}

// ── Default Configuration ──

export const DEFAULT_ACTIVE_HOURS_CONFIG: ActiveHoursConfig = {
  enabled: false, // MVP: no restriction
  timezone: "Asia/Shanghai",
  activeWindows: [],
  quietWindows: [],
};

// ── Validation ──

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidTime(time: string): boolean {
  return TIME_REGEX.test(time);
}

function parseTimeToMinutes(time: string): number {
  const match = time.match(TIME_REGEX);
  if (!match) throw new Error(`Invalid time format: ${time} (expected HH:MM)`);
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

function isValidDay(day: number): day is DayOfWeek {
  return Number.isInteger(day) && day >= 0 && day <= 6;
}

// ── Core Logic ──

/**
 * Check whether the given datetime falls within configured active hours.
 *
 * Resolution order:
 *   1. If config.enabled === false → always active (MVP default)
 *   2. Determine the current day-of-week and time-of-day in the configured timezone
 *   3. If quietWindows match → NOT active (suppressed)
 *   4. If activeWindows match → active
 *   5. If activeWindows is empty and enabled → active (24/7 default)
 *   6. Otherwise → NOT active
 *
 * @param config  The active hours configuration.
 * @param now     The datetime to check (defaults to Date.now()).
 * @returns       true if heartbeats are permitted, false if suppressed.
 */
export function isWithinActiveHours(
  config: ActiveHoursConfig,
  now: Date | number = Date.now(),
): boolean {
  // MVP default: no restriction
  if (!config.enabled) return true;

  const date = typeof now === "number" ? new Date(now) : now;

  // Get day-of-week and time-of-day in the configured timezone
  let dayOfWeek: number;
  let hours: number;
  let minutes: number;

  try {
    // Use Intl.DateTimeFormat for timezone-aware extraction
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);

    const partsMap: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        partsMap[part.type] = part.value;
      }
    }

    // Map weekday short name to index
    const weekdayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    dayOfWeek = weekdayMap[partsMap.weekday] ?? date.getDay();
    hours = parseInt(partsMap.hour, 10);
    minutes = parseInt(partsMap.minute, 10);
  } catch {
    // Fallback to system local time if timezone lookup fails
    dayOfWeek = date.getDay();
    hours = date.getHours();
    minutes = date.getMinutes();
  }

  const currentMinutes = hours * 60 + minutes;

  // ── Check quiet windows first (they override active windows) ──
  for (const qw of config.quietWindows) {
    if (!isValidTime(qw.time.start) || !isValidTime(qw.time.end)) continue;

    const dayMatch = qw.days.length === 0 || qw.days.includes(dayOfWeek as DayOfWeek);
    if (!dayMatch) continue;

    const startMin = parseTimeToMinutes(qw.time.start);
    const endMin = parseTimeToMinutes(qw.time.end);

    if (startMin <= endMin) {
      // Normal range (e.g. 01:00-05:00)
      if (currentMinutes >= startMin && currentMinutes <= endMin) {
        return false; // Within quiet window
      }
    } else {
      // Overnight range (e.g. 22:00-06:00)
      if (currentMinutes >= startMin || currentMinutes <= endMin) {
        return false; // Within overnight quiet window
      }
    }
  }

  // ── Check active windows ──
  if (config.activeWindows.length === 0) {
    // No active windows defined + no quiet window match = 24/7 active
    return true;
  }

  if (!isValidDay(dayOfWeek)) return false;

  for (const aw of config.activeWindows) {
    if (!isValidTime(aw.time.start) || !isValidTime(aw.time.end)) continue;

    const dayMatch = aw.days.length === 0 || aw.days.includes(dayOfWeek as DayOfWeek);
    if (!dayMatch) continue;

    const startMin = parseTimeToMinutes(aw.time.start);
    const endMin = parseTimeToMinutes(aw.time.end);

    if (startMin <= endMin) {
      if (currentMinutes >= startMin && currentMinutes <= endMin) {
        return true; // Within active window
      }
    } else {
      // Overnight range
      if (currentMinutes >= startMin || currentMinutes <= endMin) {
        return true; // Within overnight active window
      }
    }
  }

  return false; // Not within any active window
}

/**
 * Get the next time heartbeats will become active (or null if always active).
 *
 * @param config  The active hours configuration.
 * @param now     Reference datetime (defaults to Date.now()).
 * @returns       Timestamp (epoch ms) when heartbeats become active, or null if always active.
 */
export function getNextActiveTime(
  config: ActiveHoursConfig,
  now: Date | number = Date.now(),
): number | null {
  if (!config.enabled) return null; // Always active

  const date = typeof now === "number" ? new Date(now) : now;
  const currentMs = date.getTime();

  // Search up to 7 days ahead
  const MAX_SEARCH_MS = 7 * 24 * 60 * 60 * 1000;
  const STEP_MS = 60 * 1000; // Check every minute

  for (let t = currentMs; t <= currentMs + MAX_SEARCH_MS; t += STEP_MS) {
    if (isWithinActiveHours(config, t)) {
      return t;
    }
  }

  return null; // No active window found within 7 days
}

/**
 * Get the duration (ms) until the next active period begins.
 * Returns 0 if currently active, or null if always active.
 */
export function getMsUntilNextActive(
  config: ActiveHoursConfig,
  now: Date | number = Date.now(),
): number | null {
  if (isWithinActiveHours(config, now)) return 0;
  const next = getNextActiveTime(config, now);
  if (next === null) return null;
  const currentMs = typeof now === "number" ? now : now.getTime();
  return Math.max(0, next - currentMs);
}

// ── Configuration Loading ──

/**
 * Load active hours configuration.
 *
 * Resolution order:
 *   1. TRILC_ACTIVE_HOURS env var (JSON string)
 *   2. Default: disabled (MVP behavior, no restriction)
 *
 * @param dataDir  Optional data directory for file-based config (future).
 */
export function loadActiveHoursConfig(_dataDir?: string): ActiveHoursConfig {
  const envConfig = process.env.TRILC_ACTIVE_HOURS;
  if (envConfig) {
    try {
      const parsed = JSON.parse(envConfig) as Partial<ActiveHoursConfig>;
      return {
        enabled: parsed.enabled ?? DEFAULT_ACTIVE_HOURS_CONFIG.enabled,
        timezone: parsed.timezone ?? DEFAULT_ACTIVE_HOURS_CONFIG.timezone,
        activeWindows: parsed.activeWindows ?? [],
        quietWindows: parsed.quietWindows ?? [],
      };
    } catch (err) {
      console.warn(
        `[trilc:active-hours] Failed to parse TRILC_ACTIVE_HOURS: ` +
        `${err instanceof Error ? err.message : String(err)}. Using defaults.`,
      );
    }
  }

  return { ...DEFAULT_ACTIVE_HOURS_CONFIG };
}

/**
 * Validate an active hours configuration object.
 * Returns an array of error messages (empty = valid).
 */
export function validateActiveHoursConfig(config: ActiveHoursConfig): string[] {
  const errors: string[] = [];

  if (typeof config.enabled !== "boolean") {
    errors.push("enabled must be a boolean");
  }

  if (typeof config.timezone !== "string" || config.timezone.length === 0) {
    errors.push("timezone must be a non-empty string");
  } else {
    // Verify timezone is recognized
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
    } catch {
      errors.push(`timezone "${config.timezone}" is not recognized`);
    }
  }

  if (!Array.isArray(config.activeWindows)) {
    errors.push("activeWindows must be an array");
  } else {
    for (let i = 0; i < config.activeWindows.length; i++) {
      const aw = config.activeWindows[i];
      if (!Array.isArray(aw.days)) {
        errors.push(`activeWindows[${i}].days must be an array`);
      } else {
        for (const day of aw.days) {
          if (!isValidDay(day)) {
            errors.push(`activeWindows[${i}].days contains invalid day: ${day}`);
          }
        }
      }
      if (!aw.time || !isValidTime(aw.time.start) || !isValidTime(aw.time.end)) {
        errors.push(
          `activeWindows[${i}].time must have valid start/end in HH:MM format`,
        );
      }
    }
  }

  if (!Array.isArray(config.quietWindows)) {
    errors.push("quietWindows must be an array");
  } else {
    for (let i = 0; i < config.quietWindows.length; i++) {
      const qw = config.quietWindows[i];
      if (!Array.isArray(qw.days)) {
        errors.push(`quietWindows[${i}].days must be an array`);
      } else {
        for (const day of qw.days) {
          if (!isValidDay(day)) {
            errors.push(`quietWindows[${i}].days contains invalid day: ${day}`);
          }
        }
      }
      if (!qw.time || !isValidTime(qw.time.start) || !isValidTime(qw.time.end)) {
        errors.push(
          `quietWindows[${i}].time must have valid start/end in HH:MM format`,
        );
      }
    }
  }

  return errors;
}
