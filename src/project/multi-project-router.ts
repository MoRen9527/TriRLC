// ── Multi-Project Data Isolation Router (Phase 3 pipe3-1) ──
// Isolates session-store, cron-store, and key-cache by project root.
// Each project gets its own SQLite databases under {projectRoot}/.tricompany-cognition/.
// Cross-project agent memory access is prohibited at the routing layer.
//
// Default projectRoot = cwd ensures full backward compatibility.
//
// ── Two-track semantics (r2-2, prod-grade-2-trilc-plane-view) ──
// Project track:  {projectRoot}/docs/execution/operating-records — isolated,
//                 auto-created by ensureProjectDirs() (unchanged).
// Company track:  companyWeeklyPlaneDir (TriMetaverse/docs/workflow/
//                 operating-records) — READ-ONLY shared view. Set only when
//                 TRILC_WEEKLY_PLANE_ROOT is configured or workspace sibling
//                 discovery succeeds; never auto-created, never written by
//                 TriRLC (write ownership stays with the orchestration layer).
// Isolation note: pipe3-1's prohibition surface is cross-project access to
//                 the `.tricompany-cognition/` memory stores. The weekly plane
//                 is NOT a memory store — it is a user-configured read-only
//                 shared document view (equivalent to reading any external
//                 path). enforceProjectIsolation() is intentionally unchanged.

import { resolve, join, normalize } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveWeeklyPlaneRoot } from './weekly-plane-root.js';

// ── Path constants ──

/** Directory name for project-level cognition data. */
const COGNITION_DIR = '.tricompany-cognition';

/** Directory name for operating records under project docs. */
const OPERATING_RECORDS_DIR = 'docs/execution/operating-records';

// ── Types ──

export interface ProjectPaths {
  /** Canonical project root (normalized absolute path). */
  projectRoot: string;
  /** {projectRoot}/.tricompany-cognition/ — isolated data directory. */
  cognitionDir: string;
  /** {projectRoot}/docs/execution/operating-records/ — isolated operating records. */
  operatingRecordsDir: string;
  /** Stable project ID derived from SHA-256 of normalized projectRoot. */
  projectId: string;
  /** SQLite database path for sessions. */
  sessionDbPath: string;
  /** SQLite database path for event queue. */
  eventQueueDbPath: string;
  /** SQLite database path for cron state. */
  cronDbPath: string;
  /** SQLite database path for knowledge injection (FADE-ASSESS-003). */
  knowledgeDbPath: string;
  /** JSON file path for key cache. */
  keyCachePath: string;
  /**
   * Company weekly plane root (TriMetaverse/docs/workflow/operating-records) —
   * read-only shared view. Only present when TRILC_WEEKLY_PLANE_ROOT is
   * configured or workspace sibling discovery succeeds; undefined otherwise
   * (legacy project-track behavior, byte-for-byte unchanged).
   */
  companyWeeklyPlaneDir?: string;
}

// ── Project registry (in-process guard) ──

/**
 * In-memory registry of active project roots.
 * Used to enforce isolation: no cross-project access to stores.
 */
const activeProjects = new Map<string, ProjectPaths>();

// ── Path resolution ──

/**
 * Derive a stable project ID from the normalized project root path.
 * Uses first 12 hex chars of SHA-256 for a compact, unique identifier.
 */
function deriveProjectId(projectRoot: string): string {
  const normalized = normalize(projectRoot).toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

/**
 * Resolve all project-scoped paths for a given project root.
 *
 * Guarantees:
 *  - Cognition data is isolated under {projectRoot}/.tricompany-cognition/
 *  - Operating records are isolated under {projectRoot}/docs/execution/operating-records/
 *  - Each project has independent SQLite databases (no shared state)
 *  - projectId is a stable, content-addressed identifier
 *
 * @param projectRoot - Absolute or relative path. Defaults to process.cwd().
 * @param weeklyPlaneRoot - Optional company weekly plane root override.
 *   Defaults to resolveWeeklyPlaneRoot() (env → sibling discovery → undefined);
 *   undefined keeps the legacy project-track-only behavior byte-for-byte.
 */
export function resolveProjectPaths(
  projectRoot?: string,
  weeklyPlaneRoot?: string,
): ProjectPaths {
  const root = projectRoot ? resolve(projectRoot) : process.cwd();
  const existing = activeProjects.get(root);
  if (existing) return existing;

  const companyWeeklyPlaneDir = weeklyPlaneRoot ?? resolveWeeklyPlaneRoot();

  const cognitionDir = join(root, COGNITION_DIR);
  const operatingRecordsDir = join(root, OPERATING_RECORDS_DIR);
  const projectId = deriveProjectId(root);

  const paths: ProjectPaths = {
    projectRoot: root,
    cognitionDir,
    operatingRecordsDir,
    projectId,
    sessionDbPath: join(cognitionDir, 'sessions.db'),
    eventQueueDbPath: join(cognitionDir, 'event-queue.db'),
    cronDbPath: join(cognitionDir, 'cron.db'),
    knowledgeDbPath: join(cognitionDir, 'knowledge.db'),
    keyCachePath: join(cognitionDir, 'key-cache.json'),
    ...(companyWeeklyPlaneDir ? { companyWeeklyPlaneDir } : {}),
  };

  activeProjects.set(root, paths);
  return paths;
}

/**
 * Ensure project directories exist on disk.
 * Creates {projectRoot}/.tricompany-cognition/ if missing.
 * Creates {projectRoot}/docs/execution/operating-records/ if missing.
 *
 * The company weekly plane dir is NEVER created here — read-only view only.
 *
 * @param weeklyPlaneRoot - Optional override, passed through to resolveProjectPaths.
 */
export function ensureProjectDirs(
  projectRoot?: string,
  weeklyPlaneRoot?: string,
): ProjectPaths {
  const paths = resolveProjectPaths(projectRoot, weeklyPlaneRoot);

  if (!existsSync(paths.cognitionDir)) {
    mkdirSync(paths.cognitionDir, { recursive: true });
  }

  if (!existsSync(paths.operatingRecordsDir)) {
    mkdirSync(paths.operatingRecordsDir, { recursive: true });
  }

  return paths;
}

// ── Isolation guards ──

/**
 * Check whether a given db path belongs to the specified project root.
 * Returns true if the path is within the project's cognition directory.
 */
export function isPathInProject(dbPath: string, projectRoot?: string): boolean {
  const paths = resolveProjectPaths(projectRoot);
  const normalized = normalize(resolve(dbPath));
  const normalizedCognition = normalize(paths.cognitionDir);
  return normalized.startsWith(normalizedCognition);
}

/**
 * Validate that a store access does not cross project boundaries.
 * Throws if the access would violate isolation.
 *
 * @param accessingProjectRoot - The project making the access.
 * @param targetDbPath - The database or file path being accessed.
 */
export function enforceProjectIsolation(
  accessingProjectRoot: string,
  targetDbPath: string,
): void {
  const normalizedRoot = normalize(resolve(accessingProjectRoot));
  const normalizedTarget = normalize(resolve(targetDbPath));
  const expectedCognition = join(normalizedRoot, COGNITION_DIR);

  if (!normalizedTarget.startsWith(expectedCognition)) {
    throw new Error(
      `Cross-project access denied: project "${normalizedRoot}" attempted to access ` +
      `"${normalizedTarget}" which is outside its cognition directory ` +
      `"${expectedCognition}". Each project must use its own isolated store.`,
    );
  }
}

// ── Store factory helpers ──

/**
 * Get the session store database path for a project.
 * Convenience wrapper around resolveProjectPaths().
 */
export function getSessionDbPath(projectRoot?: string): string {
  return resolveProjectPaths(projectRoot).sessionDbPath;
}

/**
 * Get the event queue database path for a project.
 */
export function getEventQueueDbPath(projectRoot?: string): string {
  return resolveProjectPaths(projectRoot).eventQueueDbPath;
}

/**
 * Get the cron database path for a project.
 */
export function getCronDbPath(projectRoot?: string): string {
  return resolveProjectPaths(projectRoot).cronDbPath;
}

/**
 * Get the knowledge database path for a project (FADE-ASSESS-003).
 */
export function getKnowledgeDbPath(projectRoot?: string): string {
  return resolveProjectPaths(projectRoot).knowledgeDbPath;
}

/**
 * Get the key cache path for a project.
 */
export function getKeyCachePath(projectRoot?: string): string {
  return resolveProjectPaths(projectRoot).keyCachePath;
}

// ── Project data migration ──

/**
 * Detect if a project has legacy data in the global data directory.
 * Returns paths that need migration, or null if migration is not needed.
 *
 * Used for Phase 3 transition: existing projects that previously used
 * the global dataDir will have their data automatically migrated to
 * {projectRoot}/.tricompany-cognition/ on first access.
 */
export function detectLegacyData(
  globalDataDir: string,
  projectRoot?: string,
): { legacySessionDb: string; legacyEventDb: string; legacyCronDir: string } | null {
  const paths = resolveProjectPaths(projectRoot);

  const legacyState = {
    legacySessionDb: join(globalDataDir, 'sessions.db'),
    legacyEventDb: join(globalDataDir, 'event-queue.db'),
    legacyCronDir: join(globalDataDir, 'cron'),
  };

  // If project already has data, no migration needed
  if (existsSync(paths.sessionDbPath) || existsSync(paths.cronDbPath)) {
    return null;
  }

  // If legacy data exists at the global path, report it
  const hasLegacy =
    existsSync(legacyState.legacySessionDb) ||
    existsSync(legacyState.legacyEventDb) ||
    existsSync(legacyState.legacyCronDir);

  return hasLegacy ? legacyState : null;
}

// ── Active project listing (for audits) ──

/**
 * List all active project roots registered in this process.
 * Useful for debugging and audit trail.
 */
export function listActiveProjects(): ProjectPaths[] {
  return Array.from(activeProjects.values());
}

/**
 * Clear the in-process project registry.
 * Only needed for tests; production should never call this.
 */
export function _clearProjectRegistry(): void {
  activeProjects.clear();
}
