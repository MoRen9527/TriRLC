// ── TriRLC Heartbeat Barrel ──
// Re-exports heartbeat module primitives for consumers (daemon, CLI, tests).

export { createHeartbeatWake, type TriRLCHeartbeatWake, type HeartbeatRunResult, type HeartbeatWakeHandler } from "./heartbeat-wake.js";
export { createHeartbeatRunner, type TriRLCHeartbeatRunner, type HeartbeatAgentConfig } from "./heartbeat-runner.js";
export { runHeartbeatAgent, type RunHeartbeatAgentOpts } from "./agent-runner.js";
export {
  isWithinActiveHours,
  getNextActiveTime,
  getMsUntilNextActive,
  loadActiveHoursConfig,
  validateActiveHoursConfig,
  DEFAULT_ACTIVE_HOURS_CONFIG,
  type ActiveHoursConfig,
  type ActiveHoursWindow,
  type QuietWindow,
  type TimeRange,
  type DayOfWeek,
} from "./heartbeat-active-hours.js";
