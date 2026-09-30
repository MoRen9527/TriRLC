// ── TriRLC Key Cache ──
// Fetches provider keys from TriModel configuration-plane API,
// persists them to disk (S3: 600 permissions in Phase 1; S2: AES-256-GCM in Phase 2),
// and refreshes every 15 minutes with stagger to avoid thundering herd.
//
// Phase 2: S2 security level (AES-256-GCM + PBKDF2 machine fingerprint).
// Migration: auto-detects S3 plaintext on read → encrypts in-place.
// Rollback: TRIMODEL_KEY_STORAGE_MODE=s3 → plaintext mode.

import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { encrypt, decrypt, isEncryptedFormat, canDeriveKey } from './key-encryptor.js';

// ── Types ──

export interface ProviderKey {
  api_key: string;
  base_url?: string;
}

export interface KeyCache {
  keys: Record<string, ProviderKey>;
  defaultModel: string;
  refreshIntervalS: number;
  fetchedAt: number;      // unix ms
  expiresAt: number;      // fetchedAt + 24h
}

// ── Storage abstraction (Phase 1: S3 file; Phase 2: S2 encrypted file) ──

export interface KeyStorage {
  read(): KeyCache | null;
  write(cache: KeyCache): void;
}

class FileKeyStorage implements KeyStorage {
  constructor(private readonly filePath: string) {}

  read(): KeyCache | null {
    try {
      if (!existsSync(this.filePath)) return null;
      const raw = readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as KeyCache;
      // Validate shape
      if (!parsed.keys || !parsed.fetchedAt || !parsed.expiresAt) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  write(cache: KeyCache): void {
    try {
      // Ensure parent directory exists with 700
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('\\'));
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o700);
      }
      writeFileSync(this.filePath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      // chmod on Windows is a no-op for S_IRUSR|S_IWUSR, but it's a best-effort call
    } catch (err) {
      console.error('[trilc:keys] failed to write key cache:', err instanceof Error ? err.message : String(err));
    }
  }
}

// ── S2 Encrypted Storage (Phase 2) ──

class EncryptedKeyStorage implements KeyStorage {
  constructor(private readonly filePath: string) {}

  read(): KeyCache | null {
    try {
      if (!existsSync(this.filePath)) return null;
      const raw = readFileSync(this.filePath);

      if (!isEncryptedFormat(raw)) {
        // Legacy S3 plaintext — trigger auto-migration
        const plaintext = raw.toString('utf-8');
        const parsed = JSON.parse(plaintext) as KeyCache;
        if (parsed.keys && parsed.fetchedAt && parsed.expiresAt) {
          // Auto-migrate: encrypt in-place on read
          this.write(parsed);
          console.log('[trilc:keys] migrated key cache from S3 (plaintext) to S2 (AES-256-GCM)');
        }
        return parsed;
      }

      // S2 encrypted format — decrypt
      const plaintext = decrypt(raw);
      const parsed = JSON.parse(plaintext) as KeyCache;
      if (!parsed.keys || !parsed.fetchedAt || !parsed.expiresAt) return null;
      return parsed;
    } catch (err) {
      console.error('[trilc:keys] failed to read/decrypt key cache:',
        err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  write(cache: KeyCache): void {
    try {
      // Before encrypting, backup the legacy plaintext file if it exists
      if (existsSync(this.filePath)) {
        const existing = readFileSync(this.filePath);
        if (!isEncryptedFormat(existing)) {
          // Legacy S3 file — create backup before overwriting
          const backupPath = this.filePath + '.s3-backup-' + Date.now();
          try {
            copyFileSync(this.filePath, backupPath);
            console.log(`[trilc:keys] legacy S3 key cache backed up to ${backupPath}`);
          } catch {
            console.warn('[trilc:keys] failed to backup legacy key cache');
          }
        }
      }

      // Ensure parent directory exists with 700
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('\\'));
      if (dir && !existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        chmodSync(dir, 0o700);
      }
      const plaintext = JSON.stringify(cache, null, 2);
      const encrypted = encrypt(plaintext);
      writeFileSync(this.filePath, encrypted, { mode: 0o600 });
    } catch (err) {
      console.error('[trilc:keys] failed to write encrypted key cache:',
        err instanceof Error ? err.message : String(err));
    }
  }
}

// ── Constants ──

const KEY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;    // 24 hours
const KEY_REFRESH_INTERVAL_S_DEFAULT = 15 * 60;    // 15 minutes (overridden by server's refresh_interval_s)
const API_TIMEOUT_MS = 5000;                       // 5 seconds
const STAGGER_MAX_MS = 60_000;                     // 0-60s random stagger at startup

// ── State ──

let _keyCache: KeyCache | null = null;
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
let _storage: KeyStorage | null = null;

// ── Fetch status (r19-gate A1: 401 诊断面，供 init-selfcheck trimodel 探测) ──

let _lastFetchAt: number | null = null;
let _lastFetchError: string | null = null;

function recordFetchFailure(err: unknown): void {
  _lastFetchAt = Date.now();
  _lastFetchError = err instanceof Error ? err.message : String(err);
}

function recordFetchSuccess(): void {
  _lastFetchAt = Date.now();
  _lastFetchError = null;
}

/** Key-cache 现状快照（init-selfcheck 探测数据源）。 */
export interface KeyCacheStatus {
  hasCache: boolean;
  fetchedAt: number | null;
  expiresAt: number | null;
  providerCount: number;
  lastFetchAt: number | null;
  lastFetchError: string | null;
}

export function getKeyCacheStatus(): KeyCacheStatus {
  return {
    hasCache: !!_keyCache,
    fetchedAt: _keyCache?.fetchedAt ?? null,
    expiresAt: _keyCache?.expiresAt ?? null,
    providerCount: _keyCache ? Object.keys(_keyCache.keys).length : 0,
    lastFetchAt: _lastFetchAt,
    lastFetchError: _lastFetchError,
  };
}

// ── Callback for external consumers (TK-011) ──

type KeyCacheUpdatedCallback = (cache: KeyCache) => void;
let _onKeyCacheUpdated: KeyCacheUpdatedCallback | null = null;

/**
 * Register a callback to be invoked when the key cache is refreshed.
 * Used by TriRLC consumer layer to re-initialize ModelClient with fresh keys.
 */
export function onKeyCacheUpdated(callback: KeyCacheUpdatedCallback): void {
  _onKeyCacheUpdated = callback;
}

// ── Key sanitisation for logs ──

function sanitizeKey(key: string): string {
  if (!key || key.length < 5) return '****';
  return key.substring(0, 5) + '****';
}

function sanitizeKeysForLog(cache: KeyCache): Record<string, { api_key: string; base_url?: string }> {
  const sanitized: Record<string, { api_key: string; base_url?: string }> = {};
  for (const [provider, info] of Object.entries(cache.keys)) {
    sanitized[provider] = { ...info, api_key: sanitizeKey(info.api_key) };
  }
  return sanitized;
}

// ── API fetch ──

async function fetchKeysFromApi(apiUrl: string, apiToken?: string): Promise<{ keys: Record<string, ProviderKey>; defaultModel: string; refreshIntervalS: number }> {
  const url = `${apiUrl}/v1/config/keys`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiToken) {
      headers['authorization'] = `Bearer ${apiToken}`;
    }

    const res = await fetch(url, { signal: controller.signal, headers });

    if (!res.ok) {
      throw new Error(`TriModel API returned ${res.status}`);
    }

    const json = await res.json() as {
      keys: Record<string, ProviderKey>;
      default_model: string;
      refresh_interval_s: number;
    };

    return {
      keys: json.keys ?? {},
      defaultModel: json.default_model ?? 'tmv-deepseek-v4-pro',
      refreshIntervalS: json.refresh_interval_s ?? KEY_REFRESH_INTERVAL_S_DEFAULT,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ── Public API ──

export function getKeyCache(): KeyCache | null {
  if (!_keyCache) return null;
  // TK-017-fix: expired cache is still usable as fallback when TriModel is offline.
  // Only return null if cache is excessively stale (>7 days past expiry).
  // The design intent: TriModel provides keys online; trilc works offline with cache.
  const expired = Date.now() > _keyCache.expiresAt;
  const maxStaleMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  if (expired && Date.now() - _keyCache.expiresAt > maxStaleMs) {
    console.warn('[trilc:keys] key cache excessively stale (>7d), discarding');
    return null;
  }
  if (expired) {
    console.warn(`[trilc:keys] key cache expired ${Math.round((Date.now() - _keyCache.expiresAt) / 3600_000)}h ago — using stale cache until refresh succeeds`);
  }
  return _keyCache;
}

export function getKeyCacheFilePath(dataDir: string): string {
  return join(dataDir, 'keys.json');
}

export function applyKeyCacheToEnvironment(cache: KeyCache, env: NodeJS.ProcessEnv = process.env): void {
  const deepseek = cache.keys.deepseek;
  if (deepseek?.api_key) env.DEEPSEEK_API_KEY = deepseek.api_key;
  if (deepseek?.base_url) env.DEEPSEEK_BASE_URL = deepseek.base_url;

  const anthropic = cache.keys.anthropic;
  if (anthropic?.api_key) env.ANTHROPIC_API_KEY = anthropic.api_key;
  if (anthropic?.base_url) env.ANTHROPIC_BASE_URL = anthropic.base_url;

  const openai = cache.keys.openai;
  if (openai?.api_key) env.OPENAI_API_KEY = openai.api_key;
  if (openai?.base_url) env.OPENAI_BASE_URL = openai.base_url;

  const trimetaverse = cache.keys.trimetaverse;
  if (trimetaverse?.api_key) env.TRIMODEL_TRIMETAVERSE_API_KEY = trimetaverse.api_key;
  if (trimetaverse?.base_url) env.TRIMODEL_TRISTACISS_BASE_URL = trimetaverse.base_url;

  if (cache.defaultModel) env.TRIMODEL_DEFAULT_MODEL = cache.defaultModel;
}

/**
 * Initialize the key cache.
 * 1. Read local cache from disk
 * 2. Try fetching from TriModel API (non-blocking at startup)
 * 3. Start periodic refresh timer with stagger
 */
export async function initKeyCache(apiUrl: string, dataDir: string, apiToken?: string): Promise<void> {
  const filePath = getKeyCacheFilePath(dataDir);

  // Phase 2: Respect TRIMODEL_KEY_STORAGE_MODE for rollback
  const storageMode = process.env.TRIMODEL_KEY_STORAGE_MODE ?? 's2';
  if (storageMode === 's3') {
    _storage = new FileKeyStorage(filePath);
    console.log('[trilc:keys] using S3 plaintext storage mode (TRIMODEL_KEY_STORAGE_MODE=s3)');
  } else if (!canDeriveKey()) {
    // S2 requested but key derivation unavailable → fallback to S3
    _storage = new FileKeyStorage(filePath);
    console.warn('[trilc:keys] S2 encryption requested but key derivation unavailable — falling back to S3');
  } else {
    _storage = new EncryptedKeyStorage(filePath);
  }

  // 1. Load cached keys from disk
  _keyCache = _storage.read();
  if (_keyCache) {
    console.log(`[trilc:keys] loaded cached keys (${Object.keys(_keyCache.keys).length} providers), expires ${new Date(_keyCache.expiresAt).toISOString()}`);
  }

  // 2. Async fetch from TriModel API
  try {
    const fresh = await fetchKeysFromApi(apiUrl, apiToken);
    _keyCache = {
      ...fresh,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage.write(_keyCache);
    recordFetchSuccess();
    console.log(`[trilc:keys] fetched fresh keys (${Object.keys(fresh.keys).length} providers):`, sanitizeKeysForLog(_keyCache));
  } catch (err) {
    recordFetchFailure(err);
    if (_keyCache) {
      console.warn(`[trilc:keys] fetch failed, using cached keys: ${err instanceof Error ? err.message : String(err)}`);
    } else {
      console.error(`[trilc:keys] no cached keys and fetch failed — chat disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 3. Start refresh timer with stagger
  if (_keyCache) {
    startRefreshTimer(apiUrl, _keyCache.refreshIntervalS, apiToken);
  }
}

function startRefreshTimer(apiUrl: string, intervalS: number, apiToken?: string): void {
  if (_refreshTimer) return;

  const intervalMs = intervalS * 1000;
  const staggerMs = Math.floor(Math.random() * STAGGER_MAX_MS);

  console.log(`[trilc:keys] refresh timer: every ${intervalS}s (first in ${Math.round(staggerMs / 1000)}s stagger)`);

  _refreshTimer = setTimeout(() => {
    // First refresh after stagger
    doRefresh(apiUrl, apiToken).catch(() => {});

    // Then set up regular interval
    _refreshTimer = setInterval(() => {
      doRefresh(apiUrl, apiToken).catch(() => {});
    }, intervalMs);
  }, staggerMs);
}

async function doRefresh(apiUrl: string, apiToken?: string): Promise<void> {
  try {
    const fresh = await fetchKeysFromApi(apiUrl, apiToken);
    _keyCache = {
      ...fresh,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage?.write(_keyCache);
    recordFetchSuccess();
    console.log(`[trilc:keys] refreshed keys:`, sanitizeKeysForLog(_keyCache));
    // TK-011: Notify external consumers of updated key cache
    if (_onKeyCacheUpdated) {
      try {
        _onKeyCacheUpdated(_keyCache);
      } catch (err) {
        console.warn('[trilc:keys] onKeyCacheUpdated callback failed:', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    recordFetchFailure(err);
    console.warn(`[trilc:keys] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function stopKeyCache(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    clearTimeout(_refreshTimer);
    _refreshTimer = null;
  }
  _keyCache = null;
  _storage = null;
}
