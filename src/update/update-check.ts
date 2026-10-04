// ── TriCade Auto-Update Check (Phase 3 pipe3-1) ──
// Periodically checks GitHub Releases for a newer TriRLC version.
// Compares local version.json vs the latest GitHub Release tag.
// Exposes /internal/v1/update/check as an HTTP GET endpoint.
// TriPilot can optionally consume this endpoint to show update notifications.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Types ──

export interface UpdateInfo {
  /** Current locally installed version. */
  currentVersion: string;
  /** Latest available version from GitHub Releases (null if unknown). */
  latestVersion: string | null;
  /** Whether a newer version is available. */
  updateAvailable: boolean;
  /** The release tag name of the latest version. */
  latestTag: string | null;
  /** URL to the latest release page. */
  releaseUrl: string | null;
  /** ISO timestamp of when this check was performed. */
  checkedAt: string;
  /** Error message if the check failed (null on success). */
  error: string | null;
  /** How the current version was resolved. */
  versionSource: 'version.json' | 'package.json' | 'env';
}

export interface UpdateCheckOptions {
  /** GitHub repository in owner/repo format. */
  repo?: string;
  /** GitHub API base URL. Default: https://api.github.com */
  githubApiUrl?: string;
  /** GitHub personal access token (avoids rate limiting). */
  githubToken?: string;
  /** Path to local version.json. Auto-detected if not provided. */
  versionJsonPath?: string;
  /** Path to local package.json (fallback). Auto-detected if not provided. */
  packageJsonPath?: string;
  /** How often to check for updates in milliseconds. Default: 24h. */
  checkIntervalMs?: number;
}

// ── Constants ──

const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;

// ── Version resolution ──

function detectTriLcRoot(): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  return resolve(scriptDir, '..', '..');
}

function readLocalVersion(opts?: UpdateCheckOptions): { version: string; source: UpdateInfo['versionSource'] } {
  const versionJsonPath = opts?.versionJsonPath ?? resolve(detectTriLcRoot(), 'version.json');
  if (existsSync(versionJsonPath)) {
    try {
      const raw = readFileSync(versionJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string; tricadeVersion?: string };
      const v = parsed.tricadeVersion ?? parsed.version;
      if (v) return { version: v, source: 'version.json' };
    } catch {
      // fall through
    }
  }

  const pkgJsonPath = opts?.packageJsonPath ?? resolve(detectTriLcRoot(), 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const raw = readFileSync(pkgJsonPath, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version) return { version: parsed.version, source: 'package.json' };
    } catch {
      // fall through
    }
  }

  const envVersion = process.env.TRILC_VERSION;
  if (envVersion) return { version: envVersion, source: 'env' };

  return { version: '0.0.0', source: 'env' };
}

// ── GitHub Release fetching ──

interface GitHubRelease {
  tag_name: string;
  name: string;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft: boolean;
}

type FetchLatestResult =
  | { ok: true; release: GitHubRelease }
  | { ok: false; reason: 'api_error' | 'draft' | 'not_found' };

async function fetchLatestRelease(
  repo: string,
  githubApiUrl: string,
  githubToken?: string,
): Promise<FetchLatestResult> {
  const url = `${githubApiUrl}/repos/${repo}/releases/latest`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'TriRLC-Update-Check/1.0',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`;
    }

    const res = await fetch(url, {
      signal: controller.signal,
      headers,
    });

    if (res.status === 404) {
      console.warn(`[trilc:update] No releases found for ${repo}`);
      return { ok: false, reason: 'not_found' };
    }
    if (res.status === 403 || !res.ok) {
      console.warn(`[trilc:update] GitHub API returned ${res.status} for ${repo}`);
      return { ok: false, reason: 'api_error' };
    }

    const data = await res.json() as GitHubRelease;
    if (data.draft) {
      console.warn('[trilc:update] Latest release is a draft, skipping');
      return { ok: false, reason: 'draft' };
    }

    return { ok: true, release: data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== 'The operation was aborted') {
      console.warn(`[trilc:update] Fetch failed: ${msg}`);
    }
    return { ok: false, reason: 'api_error' };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Version comparison ──

/**
 * Parse a version string into numeric segments for comparison.
 * Handles semver-like formats: "1.2.3", "v1.2.3", "1.2.3-beta.1".
 * Returns null if the string cannot be parsed.
 */
function parseVersionSegments(version: string): number[] | null {
  const cleaned = version.replace(/^v/, '').trim();
  // Split on first '-' to separate pre-release, take only the numeric part
  const numericPart = cleaned.split('-')[0];
  const segments = numericPart.split('.');
  const parsed: number[] = [];
  for (const seg of segments) {
    const n = parseInt(seg, 10);
    if (isNaN(n)) return null;
    parsed.push(n);
  }
  return parsed.length > 0 ? parsed : null;
}

/**
 * Compare two version strings using numeric segment comparison.
 * Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 * Returns 0 if either version is unparseable (with console warn).
 */
function compareVersionSegments(a: string, b: string): number {
  const segsA = parseVersionSegments(a);
  const segsB = parseVersionSegments(b);
  if (!segsA || !segsB) {
    if (!segsA) console.warn(`[trilc:update] Unparseable version: "${a}"`);
    if (!segsB) console.warn(`[trilc:update] Unparseable version: "${b}"`);
    return 0;
  }

  const maxLen = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < maxLen; i++) {
    const sa = segsA[i] ?? 0;
    const sb = segsB[i] ?? 0;
    if (sa < sb) return -1;
    if (sa > sb) return 1;
  }
  return 0;
}

/**
 * Returns true if the release tag represents a newer version than localVersion.
 * Strips 'v' prefix from tags before comparing.
 *
 * Follows semver pre-release precedence:
 *   Numeric segments compared first; if equal:
 *   - A version without a pre-release suffix is newer than one with it
 *     (1.2.3 > 1.2.3-beta.1)
 *   - If both have pre-releases, they are compared as equal (simple mode).
 */
function isNewerVersion(localVersion: string, releaseTag: string): boolean {
  const cleanTag = releaseTag.replace(/^v/, '');
  const cleanLocal = localVersion.replace(/^v/, '');
  const cmp = compareVersionSegments(cleanTag, cleanLocal);
  if (cmp !== 0) return cmp > 0;

  // Numeric segments equal — check pre-release status per semver
  const tagHasPre = cleanTag.includes('-');
  const localHasPre = cleanLocal.includes('-');
  if (!tagHasPre && localHasPre) return true;   // release > pre-release
  if (tagHasPre && !localHasPre) return false;  // pre-release < release
  return false; // both or neither have pre-release — treat as equal
}

// ── Cached update status ──

interface CachedUpdateStatus {
  info: UpdateInfo;
  expiresAt: number;
}

let cachedStatus: CachedUpdateStatus | null = null;

export async function getUpdateStatus(
  options?: UpdateCheckOptions,
  force = false,
): Promise<UpdateInfo> {
  const intervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  if (!force && cachedStatus && cachedStatus.expiresAt > Date.now()) {
    return cachedStatus.info;
  }

  const { version: currentVersion, source: versionSource } = readLocalVersion(options);

  const info: UpdateInfo = {
    currentVersion,
    latestVersion: null,
    updateAvailable: false,
    latestTag: null,
    releaseUrl: null,
    checkedAt: new Date().toISOString(),
    error: null,
    versionSource,
  };

  const repo = options?.repo ??
    process.env.TRILC_GITHUB_REPO ??
    null;

  if (!repo) {
    info.error = 'No GitHub repo configured. Set TRILC_GITHUB_REPO env var.';
    cachedStatus = { info, expiresAt: Date.now() + intervalMs };
    return info;
  }

  const githubApiUrl = options?.githubApiUrl ?? DEFAULT_GITHUB_API;
  const githubToken = options?.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.TRILC_GITHUB_TOKEN;

  const result = await fetchLatestRelease(repo, githubApiUrl, githubToken);

  if (!result.ok) {
    info.error =
      result.reason === 'draft'
        ? 'Latest GitHub release is a draft (no stable release available).'
        : result.reason === 'not_found'
          ? 'No releases found for this repository.'
          : 'Failed to fetch latest release from GitHub.';
    cachedStatus = { info, expiresAt: Date.now() + Math.min(intervalMs, 60 * 60 * 1000) };
    return info;
  }

  const release = result.release;
  info.latestVersion = release.tag_name.replace(/^v/, '');
  info.latestTag = release.tag_name;
  info.releaseUrl = release.html_url;
  info.updateAvailable = isNewerVersion(currentVersion, release.tag_name);
  info.error = null;

  cachedStatus = { info, expiresAt: Date.now() + intervalMs };
  return info;
}

export function clearUpdateCache(): void {
  cachedStatus = null;
}

// ── HTTP endpoint handler ──

export function createUpdateCheckHandler(options?: UpdateCheckOptions) {
  return async function handleUpdateCheck(
    _req: IncomingMessage,
    res: ServerResponse,
    searchParams?: URLSearchParams,
  ): Promise<void> {
    const force = searchParams?.get('force') === 'true';
    let info: UpdateInfo;

    try {
      info = await getUpdateStatus(options, force);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      currentVersion: info.currentVersion,
      latestVersion: info.latestVersion,
      updateAvailable: info.updateAvailable,
      latestTag: info.latestTag,
      releaseUrl: info.releaseUrl,
      checkedAt: info.checkedAt,
      versionSource: info.versionSource,
      ...(info.error ? { warning: info.error } : {}),
    }));
  };
}

// ── Periodic background check ──

export function startUpdateCheckLoop(
  options?: UpdateCheckOptions,
  onUpdateAvailable?: (info: UpdateInfo) => void,
): { stop: () => void } {
  const intervalMs = options?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const jitter = () => Math.floor((Math.random() - 0.5) * 2 * 60 * 60 * 1000);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const check = async () => {
    if (stopped) return;
    try {
      const info = await getUpdateStatus(options, true);
      if (info.updateAvailable) {
        console.log(`[trilc:update] Update available: ${info.currentVersion} → ${info.latestVersion}`);
        console.log(`[trilc:update] Download: ${info.releaseUrl}`);
        if (onUpdateAvailable) onUpdateAvailable(info);
      }
    } catch {
      // silently ignore
    }
    if (!stopped) {
      timer = setTimeout(check, intervalMs + jitter());
    }
  };

  timer = setTimeout(check, 5000);

  return {
    stop: () => {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}
