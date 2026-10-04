// ── Weekly Plane Root Resolver (r2-2, prod-grade-2-trilc-plane-view) ──
// Resolves the company weekly plane root (TriMetaverse/docs/workflow/operating-records)
// as a READ-ONLY shared view for TriRLC. Never created, never written by TriRLC —
// write ownership of weekly plane files stays with the orchestration layer.
//
// Resolution order (design r2-1 §2.1):
//   1. TRILC_WEEKLY_PLANE_ROOT env (explicit, both source and installed states)
//   2. Workspace sibling discovery: <TriRLC-root>/../TriMetaverse/docs/workflow/
//      operating-records (source state only, existsSync-confirmed)
//   3. undefined → project-track legacy behavior, byte-for-byte unchanged
//
// Pattern precedent: env.ts resolveFromWorkspace() (TRICOMPANY_SOURCE_PATH).

import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Weekly plane directory segments relative to a TriMetaverse checkout root. */
const WEEKLY_PLANE_SEGMENTS = ['TriMetaverse', 'docs', 'workflow', 'operating-records'];

/**
 * Resolve the company weekly plane root, or undefined when not configured
 * and not discoverable. Pure function of the environment and filesystem;
 * no side effects (never creates directories).
 */
export function resolveWeeklyPlaneRoot(): string | undefined {
  // 1. env explicit — resolved to an absolute path; must exist to be honored
  //    (a stale/mistyped path falls back instead of misreading a phantom root).
  const envRoot = process.env.TRILC_WEEKLY_PLANE_ROOT;
  if (envRoot) {
    const abs = resolve(envRoot);
    return existsSync(abs) ? abs : undefined;
  }

  // 2. workspace sibling discovery (source state).
  //    This module lives at src/project/ (compiled: dist/project/) — three
  //    levels below the workspace root D:/Code/ai, so three '..' hops land on
  //    the sibling TriMetaverse checkout. (Two hops would land INSIDE the
  //    TriRLC repo — r2-3 regression: fixed from '..', '..'.)
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sibling = resolve(scriptDir, '..', '..', '..', ...WEEKLY_PLANE_SEGMENTS);
  if (existsSync(sibling)) return sibling;

  // 3. not configured / discovery failed → undefined (legacy behavior).
  return undefined;
}
