// ── TriRLC Runtime Profile ──
// Defines production vs development operational parameters.
// Complements env.ts (wire-level config) with behavioural profile tuning.
//
// Usage:
//   import { loadProfile } from '../config/trilc-profile.js';
//   const profile = loadProfile();

export interface TriRLCProfile {
  /** Profile name for logging and diagnostics */
  name: 'production' | 'development';
  /** Minimum log level emitted to stdout */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Whether debug/internal introspection endpoints are exposed */
  enableDebugEndpoints: boolean;
  /** Whether the daemon requires TriMMC connectivity at startup (fails fast if unreachable) */
  trimcRequired: boolean;
  /** Interval between heartbeat checks (ms) */
  heartbeatIntervalMs: number;
  /** Interval between session reaper sweeps (ms) */
  sessionReaperIntervalMs: number;
  /** Interval between mirror push cycles (ms) */
  mirrorPushIntervalMs: number;
  /** Maximum number of concurrent agent loops */
  maxConcurrentLoops: number;
  /** Session inactivity timeout before reaping (ms) */
  sessionInactivityTimeoutMs: number;
}

// ── Profile Definitions ──

const PRODUCTION_PROFILE: TriRLCProfile = {
  name: 'production',
  logLevel: 'info',
  enableDebugEndpoints: false,
  trimcRequired: false,
  heartbeatIntervalMs: 30 * 60 * 1000, // 30 min
  sessionReaperIntervalMs: 60 * 60 * 1000, // 1 hour
  mirrorPushIntervalMs: 30_000, // 30s
  maxConcurrentLoops: 4,
  sessionInactivityTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
};

const DEVELOPMENT_PROFILE: TriRLCProfile = {
  name: 'development',
  logLevel: 'debug',
  enableDebugEndpoints: true,
  trimcRequired: false,
  heartbeatIntervalMs: 5 * 60 * 1000, // 5 min
  sessionReaperIntervalMs: 10 * 60 * 1000, // 10 min
  mirrorPushIntervalMs: 10_000, // 10s
  maxConcurrentLoops: 8,
  sessionInactivityTimeoutMs: 2 * 60 * 60 * 1000, // 2 hours
};

// ── Resolution ──

/**
 * Load the active runtime profile.
 *
 * Resolution order:
 * 1. TRILC_PROFILE env var (e.g. "production" or "development")
 * 2. Defaults to "development"
 */
export function loadProfile(): TriRLCProfile {
  const env = (process.env.TRILC_PROFILE ?? 'development').toLowerCase();
  if (env === 'production') {
    return { ...PRODUCTION_PROFILE };
  }
  if (env === 'development') {
    return { ...DEVELOPMENT_PROFILE };
  }
  // Unknown profile value: warn and fall back to development
  console.warn(`[trilc:profile] unknown TRILC_PROFILE="${env}", falling back to development`);
  return { ...DEVELOPMENT_PROFILE };
}
