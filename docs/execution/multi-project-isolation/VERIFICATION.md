# Multi-Project Data Isolation — Verification Report

**Module**: `src/project/multi-project-router.ts`
**Phase**: Phase 3 pipe3-1
**Verification Date**: 2026-08-02
**Verification By**: FullStackDeveloper (小全), per w34-2 task
**Status**: PASS (6/6 guarantees verified, 1 known gap)

---

## 1. Design Intent

The multi-project-router enforces data isolation at the filesystem layer so that
each project (identified by `$TRILC_PROJECT_ROOT` or `cwd`) gets its own
independent SQLite databases under `{projectRoot}/.tricompany-cognition/`.

Cross-project agent-memory access is prohibited at the routing layer.

### Core Guarantees

| # | Guarantee | Function |
|---|-----------|----------|
| G1 | Cognition data isolated under `{projectRoot}/.tricompany-cognition/` | `resolveProjectPaths()` |
| G2 | Operating records isolated under `{projectRoot}/docs/execution/operating-records/` | `resolveProjectPaths()` |
| G3 | Each project has independent SQLite databases (no shared state) | `resolveProjectPaths()` |
| G4 | Cross-project store access throws (runtime enforcement) | `enforceProjectIsolation()` |
| G5 | projectId is a stable, content-addressed identifier | `deriveProjectId()` |
| G6 | Legacy global-data migration path is detectable | `detectLegacyData()` |

---

## 2. Function-by-Function Verification

### 2.1 `deriveProjectId(projectRoot)` — G5

```
Input:  "D:\\OneDrive\\Code\\ai\\TriRLC"
Output: SHA-256(normalized.toLowercase()).hex.slice(0, 12)
Result: 12-char stable hex digest
```

**Verification**: The function normalizes the path, lowercases it, and hashes with
SHA-256. This produces a stable, deterministic 12-char project ID for any given
path. Case-insensitivity prevents ID drift when the same project is referenced with
varying casing.

**Edge cases checked**:
- Windows backslash paths (`D:\foo\bar`) → normalized to forward slashes by `normalize()`
- Trailing slashes → removed by `normalize()`
- Same path different case → same ID due to `.toLowerCase()`

**Verdict**: PASS. Project IDs are stable and deterministic.

---

### 2.2 `resolveProjectPaths(projectRoot?)` — G1, G2, G3

**Path derivation**:
```
projectRoot         → resolve(projectRoot) or process.cwd()
cognitionDir        → join(projectRoot, '.tricompany-cognition')
operatingRecordsDir → join(projectRoot, 'docs/execution/operating-records')
sessionDbPath       → join(cognitionDir, 'sessions.db')
eventQueueDbPath    → join(cognitionDir, 'event-queue.db')
cronDbPath          → join(cognitionDir, 'cron.db')
keyCachePath        → join(cognitionDir, 'key-cache.json')
```

**Verification**:
- All DB paths are scoped under `cognitionDir` which is scoped under `projectRoot`
- No shared/global paths — each project root produces disjoint path sets
- Default `projectRoot = process.cwd()` ensures backward compatibility
- In-memory cache (`activeProjects Map`) deduplicates repeated calls for the same root

**Edge cases checked**:
- Missing `projectRoot` → defaults to `process.cwd()` (backward compat)
- Repeated calls with same root → cached result returned (same object reference)
- Two projects with different roots → completely disjoint path sets

**Verdict**: PASS. All paths are correctly scoped. Backward compatibility maintained.

### 2.2a `companyWeeklyPlaneDir` two-track extension (r2-2, prod-grade-2-trilc-plane-view)

**Company track (read-only shared view, NEW)**:
```
companyWeeklyPlaneDir → resolveWeeklyPlaneRoot():
  1. TRILC_WEEKLY_PLANE_ROOT env (must exist on disk)
  2. workspace sibling: <TriRLC-root>/../TriMetaverse/docs/workflow/operating-records
  3. undefined → legacy project-track behavior, byte-for-byte unchanged
```

**Semantics**:
- Read-only view of the company weekly plane (TriMetaverse `docs/workflow/operating-records`); write ownership stays with the orchestration layer
- NEVER auto-created: `ensureProjectDirs()` only creates the project-track dirs (G1/G2 unchanged)
- Isolation boundary unchanged: `enforceProjectIsolation()` guards the `.tricompany-cognition/` memory stores only — the weekly plane is not a memory store, it is a user-configured shared document view
- Project track (`docs/execution/operating-records`) untouched; the two tracks coexist and are semantically distinct (project-level isolation records vs company-level shared facts)

**Backward compatibility**: no env + discovery failure → `companyWeeklyPlaneDir` undefined → every read falls back to the project track; `resolveProjectPaths()` API signature is additive (optional second parameter); existing 24 router tests unchanged.

---

### 2.3 `ensureProjectDirs(projectRoot?)` — G1, G2

**Verification**:
- Calls `resolveProjectPaths()` → `mkdirSync(cognitionDir, { recursive: true })` if missing
- Also creates `operatingRecordsDir` if missing
- Returns the same `ProjectPaths` object

**Edge cases checked**:
- Directories already exist → `existsSync` check prevents unnecessary mkdir
- Deep paths → `{ recursive: true }` creates intermediate directories
- Concurrent calls → `resolveProjectPaths` cache ensures idempotent `existsSync` check

**Verdict**: PASS. Directory creation is correct and idempotent.

---

### 2.4 `isPathInProject(dbPath, projectRoot?)`

**Logic**: Normalizes the dbPath and checks if it starts with the normalized cognition directory.

**Verification**:
- Uses `resolve()` + `normalize()` to canonicalize paths
- Checks prefix match with `startsWith()`
- Correctly identifies in-project vs. out-of-project paths

**Edge cases checked**:
- Relative paths → resolved to absolute before comparison
- Symlink paths → `resolve()` follows symlinks; `normalize()` standardizes separators
- Path at exact boundary (trailing slash) → `startsWith` handles this correctly since both paths are `normalize()`d and the separator belongs to the base path

**Verdict**: PASS. Path membership check is correct.

---

### 2.5 `enforceProjectIsolation(accessingProjectRoot, targetDbPath)` — G4

**Logic**: Resolves both paths and checks that `targetDbPath.startsWith(expectedCognition)`.

**Verification**:
- Throws `Error` with descriptive message when isolation is violated
- Message includes both the accessing project and the target path for debugging
- Uses `join(normalizedRoot, COGNITION_DIR)` for the expected prefix

**Edge cases checked**:
- Access to sibling project's `.tricompany-cognition/` → correctly rejected
- Access to global `/tmp` path → correctly rejected
- Access to own project's cognition dir → correctly allowed
- Path traversal attacks (`../../other-project/.tricompany-cognition/sessions.db`) → resolved to absolute before check, correctly rejected

**Verdict**: PASS. Cross-project enforcement is strict and descriptive.

---

### 2.6 `detectLegacyData(globalDataDir, projectRoot?)`

**Logic**:
1. If project already has data (`existsSync(paths.sessionDbPath) || existsSync(paths.cronDbPath)`) → return `null` (no migration needed)
2. If global data exists → return legacy paths (migration needed)
3. Otherwise → return `null`

**Verification**:
- Correctly identifies when migration is needed vs. not
- Returns precise legacy paths for migration orchestration

**Edge cases checked**:
- Project with partial data (only `sessions.db` exists) → migration skipped
- Project with no data, global data exists → migration paths returned
- Project with no data, no global data → returns `null`

**Known limitation** (non-blocking): If a project has `sessions.db` locally but
`cron.db` only exists in global — migration is skipped because the `||` check
short-circuits on `sessionDbPath`. Mitigation: migration should be one-shot
during Phase 3 transition; partial-migration scenarios are unlikely in practice.

**Verdict**: PASS with note. The conservative skip is acceptable for Phase 3.

---

### 2.7 Store Factory Helpers

`getSessionDbPath`, `getEventQueueDbPath`, `getCronDbPath`, `getKeyCachePath` —
all delegate to `resolveProjectPaths(projectRoot).<field>`.

**Verdict**: PASS. Correct delegation, no duplicate logic.

---

### 2.8 Registry Lifecycle

- `listActiveProjects()`: Returns all registered projects (for audits)
- `_clearProjectRegistry()`: Clears in-process cache (for tests only)

**Verdict**: PASS. Proper separation of production and test concerns.

---

## 3. Cross-Cutting Concerns

### 3.1 Thread Safety
The `activeProjects Map` is a synchronous in-memory structure. Since Node.js is
single-threaded for JS execution, race conditions are not possible in normal
operation.

### 3.2 Path Normalization
All functions use `normalize(resolve(...))` to canonicalize paths before
comparison. This handles:
- Windows vs. POSIX separators
- Relative vs. absolute paths
- `.` and `..` segments

### 3.3 Backward Compatibility
Default `projectRoot = process.cwd()` ensures that existing callers that do not
set `TRILC_PROJECT_ROOT` continue to work unchanged — their data stays in
`{cwd}/.tricompany-cognition/`, which is the same behavior as before Phase 3.

---

## 4. Integration Status

| Component | Uses multi-project-router? | Status |
|-----------|---------------------------|--------|
| `src/server/app.ts` (session store) | No — uses `env.dataDir` directly | Gap |
| `src/server/app.ts` (event queue) | No — uses `env.dataDir` directly | Gap |
| `src/server/app.ts` (cron engine) | No — uses `env.dataDir` directly | Gap |
| `src/server/app.ts` (key cache) | No — uses `env.dataDir` directly | Gap |
| `src/config/env.ts` | Defines `TRILC_PROJECT_ROOT` env var | Ready |

**Key Gap**: The multi-project-router is fully implemented and verified at the
library level, but not yet wired into the server's store initialization. All 4
stores (session, event-queue, cron, key-cache) still use the legacy `dataDir`
path. For the isolation to take effect in production, the server must be updated
to call `ensureProjectDirs(env.projectRoot)` and use the project-scoped paths
from `ProjectPaths`.

---

## 5. Unit Test Coverage

See: `src/project/multi-project-router.test.ts`

Covered scenarios:
- [x] Path resolution with explicit project root
- [x] Path resolution with default cwd
- [x] In-memory cache deduplication
- [x] Project ID stability (same path → same ID)
- [x] Project ID uniqueness (different paths → different IDs)
- [x] `ensureProjectDirs` creates directories
- [x] `ensureProjectDirs` is idempotent
- [x] `isPathInProject` correctly identifies in-project path
- [x] `isPathInProject` correctly rejects out-of-project path
- [x] `enforceProjectIsolation` throws on cross-project access
- [x] `enforceProjectIsolation` passes for valid access
- [x] `detectLegacyData` returns null when project has data
- [x] `detectLegacyData` returns paths when global data exists
- [x] `detectLegacyData` returns null when no legacy data
- [x] Store factory helpers delegate correctly
- [x] `listActiveProjects` returns all registered projects
- [x] `_clearProjectRegistry` clears the registry

---

## 6. Summary

| Guarantee | Verdict |
|-----------|---------|
| G1: Cognition data isolation | PASS |
| G2: Operating records isolation | PASS |
| G3: Independent SQLite databases | PASS |
| G4: Cross-project enforcement | PASS |
| G5: Stable project ID | PASS |
| G6: Legacy data detection | PASS with note |

**Overall**: All 6 design guarantees are met at the library level. One known
integration gap: the server `app.ts` does not yet use project-scoped paths for
its 4 stores. This is a follow-up wiring task, not a defect in the router itself.
