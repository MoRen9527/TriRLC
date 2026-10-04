// ── TriRLC Session Store Index ──
// Exports session persistence and recovery primitives.
// This module is designed as a shared-core candidate:
//   - TriMMC should adopt the same session-store for conversation persistence
//   - The SQLite schema and recovery protocol should converge across runtimes

export { createSessionStore } from './store.js';
export type {
  SessionRecord,
  SessionMessageRecord,
  SessionStatus,
  SessionSummary,
  RecoveryResult,
  WorkTreeSafetyReport,
} from './types.js';
