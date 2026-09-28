// ── TriLC Key Cache → config-cache（LG-058 N3 泛化）──
// LG-058 P0③ (2026-09-28): 机制从「keys 单维」泛化为「config 多维」
// （keys + default_model + 策略摘要 strategy），tier1 拉取端点从
// /v1/config/keys 换为 /v1/config/cards/{face}?view=pull（CTO 方案 §三
// 拉取→本地重加密时序）。机制本体不变：拉取 + 本机 key-encryptor 域内
// 重加密落盘（tier2 载体）+ 15 分钟 stagger 刷新 + 24h 过期（TK-017
// 7 天 stale 宽限保留——「拉取失败不阻塞本域面运行」R-HY 问7 口径）。
// 存储文件 keys.json → config-cache.json（legacy keys.json 读取兼容，
// 首次成功 pull 后自然落新文件）。
//
// 导出函数面零改名（app.ts / init-selfcheck.ts / init-sync.ts 调用点
// 零波及）：initKeyCache / getKeyCache / applyKeyCacheToEnvironment /
// onKeyCacheUpdated / getKeyCacheStatus / stopKeyCache。
//
// 降级梯（方案 §4.1，四域面同构）：
//   tier1 = TriModel 卡面 pull（face 凭据）
//   tier2 = 消费机 config-cache（S2 域内重加密落盘）
//   tier3 = env 键 / 出厂默认模型
//   判梯序 = tier1 可用→tier1；tier1 败→tier2（含 stale 宽限）→tier3。
//   归因码（方案 §3.3）：pull_denied / decrypt_failed / apply_rejected。
//
// Phase 2: S2 security level (AES-256-GCM + PBKDF2 machine fingerprint).
// Migration: auto-detects S3 plaintext on read → encrypts in-place.
// Rollback: TRIMODEL_KEY_STORAGE_MODE=s3 → plaintext mode.

import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, copyFileSync } from 'node:fs';
import { encrypt, decrypt, isEncryptedFormat, canDeriveKey } from './key-encryptor.js';

// ── Types ──

export interface ProviderKey {
  api_key: string;
  base_url?: string;
}

/** 卡条目 pull 载荷形态（TriModel /v1/config/cards/{face}?view=pull，LG-058 §2.2）。 */
export interface PullEntry {
  provider: string;
  model: string;
  api_key: string;
  enabled: boolean;
  updated_at: string;
  base_url?: string;
}

/** 策略摘要（卡三实体之三；daemon 侧只透传缓存，消费面候后续批）。 */
export interface PullStrategySummary {
  id: string;
  name: string;
  rule_ids: string[];
}

export interface KeyCache {
  keys: Record<string, ProviderKey>;
  defaultModel: string;
  /** LG-058 N3：策略摘要维度（可选=legacy keys.json cache shape 兼容）。 */
  strategy?: PullStrategySummary | null;
  refreshIntervalS: number;
  fetchedAt: number;      // unix ms
  expiresAt: number;      // fetchedAt + 24h
}

// ── Face 与归因码（LG-058）──

// 本仓域面身份（TriRLC=rlc 本地域面；端点 TRIMODEL_API_URL 参数化、face
// 随仓身份固定——寄居过渡未来分部署只换端点不换 face，方案 §4.4）。
export const FACE_ID = process.env.TRIMODEL_FACE_ID ?? 'rlc';

// 归因码三枚举（方案 §3.3；与 TriModel src/card-faces.ts ATTRIBUTION_CODES
// 同名协议——两端各自定义，schema 冻结在 CTO 方案件）。
export const PULL_ATTRIBUTION_CODES = ['pull_denied', 'decrypt_failed', 'apply_rejected'] as const;
export type PullAttributionCode = (typeof PULL_ATTRIBUTION_CODES)[number];

// ── Storage abstraction (Phase 1: S3 file; Phase 2: S2 encrypted file) ──

export interface KeyStorage {
  read(): KeyCache | null;
  write(cache: KeyCache): void;
}

class FileKeyStorage implements KeyStorage {
  constructor(private readonly filePath: string, private readonly legacyFilePath: string | null) {}

  read(): KeyCache | null {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as KeyCache;
        // Validate shape
        if (!parsed.keys || !parsed.fetchedAt || !parsed.expiresAt) return null;
        return parsed;
      }
      // LG-058 N3 legacy fallback：config-cache.json 未落时读旧 keys.json
      // （仅 keys+defaultModel 维度；strategy 缺省 undefined）。
      if (this.legacyFilePath && existsSync(this.legacyFilePath)) {
        const raw = readFileSync(this.legacyFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as KeyCache;
        if (parsed.keys && parsed.fetchedAt && parsed.expiresAt) return parsed;
      }
      return null;
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
  constructor(private readonly filePath: string, private readonly legacyFilePath: string | null) {}

  read(): KeyCache | null {
    try {
      if (existsSync(this.filePath)) {
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
      }

      // LG-058 N3 legacy fallback：新文件未落 → 旧 keys.json（明文 S3 形态）。
      // 不自动写回新文件——等首次成功 pull 自然落 config-cache.json。
      if (this.legacyFilePath && existsSync(this.legacyFilePath)) {
        const raw = readFileSync(this.legacyFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as KeyCache;
        if (parsed.keys && parsed.fetchedAt && parsed.expiresAt) {
          console.log('[trilc:keys] legacy keys.json loaded (config-cache.json pending first pull)');
          return parsed;
        }
      }
      return null;
    } catch (err) {
      // 域不匹配（跨机复制过的 cache）→ 解密失败=cache 无效丢弃（方案 §3.3
      // 「绝不静默用他域密文猜」）→ 调用方直落 tier3。归因 decrypt_failed。
      console.error('[trilc:keys] failed to read/decrypt key cache (attribution: decrypt_failed):',
        err instanceof Error ? err.message : String(err));
      // CTO 裁 1(乙)（de6d49f8）：decrypt_failed daemon 侧 emit 点——cache 域
      // 不匹配（跨机复制）=此卡在本消费机未生效，回写 failed+归因码（§3.3；
      // admin 凭据缺席自动跳过，非阻塞）。
      void reportCardStatus('failed', 'decrypt_failed');
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
let _apiUrl = '';
let _apiToken: string | undefined;

// ── Fetch status (r19-gate A1: 401 诊断面，供 init-selfcheck trimodel 探测) ──

let _lastFetchAt: number | null = null;
let _lastFetchError: string | null = null;
let _lastAttribution: PullAttributionCode | null = null;

function recordFetchFailure(err: unknown, attribution: PullAttributionCode | null): void {
  _lastFetchAt = Date.now();
  _lastFetchError = err instanceof Error ? err.message : String(err);
  _lastAttribution = attribution;
}

function recordFetchSuccess(): void {
  _lastFetchAt = Date.now();
  _lastFetchError = null;
  _lastAttribution = null;
}

/** Key-cache 现状快照（init-selfcheck 探测数据源）。 */
export interface KeyCacheStatus {
  hasCache: boolean;
  fetchedAt: number | null;
  expiresAt: number | null;
  providerCount: number;
  lastFetchAt: number | null;
  lastFetchError: string | null;
  /** LG-058 N3：域面身份与末次拉取归因码（成功=null）。 */
  face: string;
  lastAttribution: PullAttributionCode | null;
}

export function getKeyCacheStatus(): KeyCacheStatus {
  return {
    hasCache: !!_keyCache,
    fetchedAt: _keyCache?.fetchedAt ?? null,
    expiresAt: _keyCache?.expiresAt ?? null,
    providerCount: _keyCache ? Object.keys(_keyCache.keys).length : 0,
    lastFetchAt: _lastFetchAt,
    lastFetchError: _lastFetchError,
    face: FACE_ID,
    lastAttribution: _lastAttribution,
  };
}

// ── Callback for external consumers (TK-011) ──

type KeyCacheUpdatedCallback = (cache: KeyCache) => void;
let _onKeyCacheUpdated: KeyCacheUpdatedCallback | null = null;

/**
 * Register a callback to be invoked when the key cache is refreshed.
 * Used by TriLC consumer layer to re-initialize ModelClient with fresh keys.
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

// ── Pull 载荷 → keys 维度提取（LG-058 N3 纯函数）──

/**
 * 卡条目（enabled 已由 server 侧 pull 载荷过滤）→ provider 聚合 keys。
 * 规则与 TriModel src/key-source.ts deriveProviderKeys 同构：
 * per provider 取 updated_at 最新条目（服务端聚合规则的消费端镜像）。
 */
export function keysFromPullEntries(entries: Record<string, PullEntry>): Record<string, ProviderKey> {
  const latest: Record<string, { api_key: string; base_url?: string; updated_at: string }> = {};
  for (const entry of Object.values(entries ?? {})) {
    if (!entry?.enabled || !entry.api_key) continue;
    const prev = latest[entry.provider];
    if (!prev || entry.updated_at > prev.updated_at) {
      latest[entry.provider] = { api_key: entry.api_key, ...(entry.base_url ? { base_url: entry.base_url } : {}), updated_at: entry.updated_at };
    }
  }
  const out: Record<string, ProviderKey> = {};
  for (const [provider, pick] of Object.entries(latest)) {
    out[provider] = { api_key: pick.api_key, ...(pick.base_url ? { base_url: pick.base_url } : {}) };
  }
  return out;
}

// ── API fetch（tier1：卡面 pull 视图）──

type PullOutcome =
  | { ok: true; keys: Record<string, ProviderKey>; defaultModel: string; strategy: PullStrategySummary | null; refreshIntervalS: number; modelRelayOnly?: boolean }
  | { ok: false; attribution: PullAttributionCode | null; message: string };

async function fetchConfigFromCardApi(apiUrl: string, apiToken?: string): Promise<PullOutcome> {
  const url = `${apiUrl}/v1/config/cards/${FACE_ID}?view=pull`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiToken) {
      headers['authorization'] = `Bearer ${apiToken}`;
    }

    const res = await fetch(url, { signal: controller.signal, headers });

    // 401/403 = 凭据被拒（方案 §3.3 pull_denied）
    if (res.status === 401 || res.status === 403) {
      return { ok: false, attribution: 'pull_denied', message: `TriModel card pull denied (${res.status})` };
    }
    if (!res.ok) {
      return { ok: false, attribution: null, message: `TriModel card pull returned ${res.status}` };
    }

    const json = await res.json() as {
      object?: string;
      face?: string;
      card_present?: boolean;
      default_model?: string;
      entries?: Record<string, PullEntry>;
      strategy?: PullStrategySummary | null;
      refresh_interval_s?: number;
    };

    // 卡未配置（card_present:false）= tier1 凭据无源非故障；但 default_model=
    // 服务端评估序投影（方案 L32 基线：窗口命中→卡 default_model→env，本方案
    // 不改此语义）——有值则模型维中继（keys 保留 tier2 现值），daemon 策略
    // 跟随（STE gate anchor③ 语义）由此维持。
    if (json.card_present === false) {
      if (typeof json.default_model === 'string' && json.default_model) {
        return {
          ok: true, keys: {}, defaultModel: json.default_model,
          strategy: null, refreshIntervalS: json.refresh_interval_s ?? KEY_REFRESH_INTERVAL_S_DEFAULT,
          modelRelayOnly: true,
        };
      }
      return { ok: false, attribution: null, message: `TriModel card '${FACE_ID}' not configured server-side (card_present=false)` };
    }

    return {
      ok: true,
      keys: keysFromPullEntries(json.entries ?? {}),
      defaultModel: json.default_model ?? 'tmv-deepseek-v4-pro',
      strategy: json.strategy ?? null,
      refreshIntervalS: json.refresh_interval_s ?? KEY_REFRESH_INTERVAL_S_DEFAULT,
    };
  } catch (err) {
    return { ok: false, attribution: null, message: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}

// ── status 回写（§三 时序：生效读数回写既有通道；可选增强，admin 凭据缺席=跳过）──

async function reportCardStatus(state: 'applied' | 'failed', error?: string): Promise<void> {
  const adminToken = process.env.TRIMODEL_ADMIN_TOKEN;
  if (!_apiUrl || !adminToken) return; // 凭据缺席=静默跳过（server 台账已记 pull 结果）
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(`${_apiUrl}/v1/config/cards/${FACE_ID}/status`, {
        method: 'PUT',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ state, ...(error ? { error } : {}) }),
      });
      if (!res.ok) {
        console.warn(`[trilc:keys] status report ${state} → ${res.status} (non-blocking)`);
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    console.warn('[trilc:keys] status report failed (non-blocking):', err instanceof Error ? err.message : String(err));
  }
}

// ── Public API ──

export function getKeyCache(): KeyCache | null {
  if (!_keyCache) return null;
  // TK-017-fix: expired cache is still usable as fallback when TriModel is offline.
  // Only return null if cache is excessively stale (>7 days past expiry).
  // The design intent: TriModel provides keys online; trilc works offline with cache.
  // （LG-058 N3 注：方案 §4.1「tier2 过期→tier3」以现役 stale 宽限实现——
  // stale 期 cache 仍供 env apply（tier2.5 语义），7 天硬限后丢弃直落 tier3。
  // R-HY 问7「不阻塞本域面运行」优先；候门审注记。）
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
  // LG-058 N3：tier2 载体泛化名。legacy keys.json 经 read fallback 兼容。
  return join(dataDir, 'config-cache.json');
}

function getLegacyKeyCacheFilePath(dataDir: string): string {
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
 * Initialize the key cache (LG-058 N3 泛化：tier1=卡面 pull).
 * 1. Read local cache from disk (config-cache.json, legacy keys.json fallback)
 * 2. Try pulling from TriModel card API (non-blocking at startup)
 * 3. Start periodic refresh timer with stagger
 */
export async function initKeyCache(apiUrl: string, dataDir: string, apiToken?: string): Promise<void> {
  _apiUrl = apiUrl;
  // face token 优先（P1 绑定收敛预留）；回退 api-token（P0 通配态）
  _apiToken = process.env.TRIMODEL_FACE_TOKEN ?? apiToken;
  const filePath = getKeyCacheFilePath(dataDir);
  const legacyFilePath = getLegacyKeyCacheFilePath(dataDir);

  // Phase 2: Respect TRIMODEL_KEY_STORAGE_MODE for rollback
  const storageMode = process.env.TRIMODEL_KEY_STORAGE_MODE ?? 's2';
  if (storageMode === 's3') {
    _storage = new FileKeyStorage(filePath, legacyFilePath);
    console.log('[trilc:keys] using S3 plaintext storage mode (TRIMODEL_KEY_STORAGE_MODE=s3)');
  } else if (!canDeriveKey()) {
    // S2 requested but key derivation unavailable → fallback to S3
    _storage = new FileKeyStorage(filePath, legacyFilePath);
    console.warn('[trilc:keys] S2 encryption requested but key derivation unavailable — falling back to S3');
  } else {
    _storage = new EncryptedKeyStorage(filePath, legacyFilePath);
  }

  // 1. Load cached config from disk (tier2)
  _keyCache = _storage.read();
  if (_keyCache) {
    console.log(`[trilc:keys] loaded cached config (${Object.keys(_keyCache.keys).length} providers), expires ${new Date(_keyCache.expiresAt).toISOString()}`);
  }

  // 2. Pull from TriModel card API (tier1)
  const pull = await fetchConfigFromCardApi(apiUrl, _apiToken);
  if (pull.ok && pull.modelRelayOnly) {
    // 模型维中继（卡缺席+评估序投影）：keys/strategy 保留 tier2 现值，仅刷
    // default_model——不回写 status（凭据无源=非完整 apply，server 台账已记
    // pull ok；避免 15min 周期噪声）
    _keyCache = {
      keys: _keyCache?.keys ?? {},
      defaultModel: pull.defaultModel,
      strategy: _keyCache?.strategy ?? null,
      refreshIntervalS: _keyCache?.refreshIntervalS ?? pull.refreshIntervalS,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage?.write(_keyCache);
    recordFetchSuccess();
    console.log(`[trilc:keys] model relay (card absent): default=${pull.defaultModel}`);
  } else if (pull.ok) {
    _keyCache = {
      keys: pull.keys,
      defaultModel: pull.defaultModel,
      strategy: pull.strategy,
      refreshIntervalS: pull.refreshIntervalS,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage.write(_keyCache);
    recordFetchSuccess();
    console.log(`[trilc:keys] pulled fresh config (${Object.keys(pull.keys).length} providers):`, sanitizeKeysForLog(_keyCache));
    // §三 时序：生效读数回写（applied）——fire-and-forget，admin 凭据缺席=跳过
    void reportCardStatus('applied');
  } else {
    recordFetchFailure(new Error(pull.message), pull.attribution);
    // 拉取被拒 → 回写 failed+归因码（方案 §3.3「回写 failed 时附归因码」；
    // server 台账已记 denied，本回写=卡状态面同显，凭据缺席自动跳过）
    if (pull.attribution === 'pull_denied') {
      void reportCardStatus('failed', 'pull_denied');
    }
    if (_keyCache) {
      console.warn(`[trilc:keys] pull failed, using cached config (attribution: ${pull.attribution ?? 'network'}): ${pull.message}`);
    } else {
      console.error(`[trilc:keys] no cached config and pull failed (attribution: ${pull.attribution ?? 'network'}) — chat will use env/defaults (tier3): ${pull.message}`);
    }
  }

  // 3. Start refresh timer with stagger
  if (_keyCache) {
    startRefreshTimer(apiUrl, _keyCache.refreshIntervalS, _apiToken);
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
  const pull = await fetchConfigFromCardApi(apiUrl, apiToken);
  if (pull.ok && pull.modelRelayOnly) {
    // 模型维中继（同 initKeyCache 分支；刷新路径须触发 updated 回调——
    // 外部消费者（env apply/聊天面）靠它感知策略翻转，anchor③ 语义）
    _keyCache = {
      keys: _keyCache?.keys ?? {},
      defaultModel: pull.defaultModel,
      strategy: _keyCache?.strategy ?? null,
      refreshIntervalS: _keyCache?.refreshIntervalS ?? pull.refreshIntervalS,
      fetchedAt: Date.now(),
      expiresAt: Date.now() + KEY_CACHE_TTL_MS,
    };
    _storage?.write(_keyCache);
    recordFetchSuccess();
    console.log(`[trilc:keys] model relay refresh (card absent): default=${pull.defaultModel}`);
    if (_onKeyCacheUpdated) {
      try {
        _onKeyCacheUpdated(_keyCache);
      } catch (err) {
        console.warn('[trilc:keys] onKeyCacheUpdated callback failed:', err instanceof Error ? err.message : String(err));
      }
    }
    return;
  }
  if (!pull.ok) {
    recordFetchFailure(new Error(pull.message), pull.attribution);
    if (pull.attribution === 'pull_denied') {
      void reportCardStatus('failed', 'pull_denied');
    }
    console.warn(`[trilc:keys] refresh failed (attribution: ${pull.attribution ?? 'network'}): ${pull.message}`);
    return;
  }
  _keyCache = {
    keys: pull.keys,
    defaultModel: pull.defaultModel,
    strategy: pull.strategy,
    refreshIntervalS: pull.refreshIntervalS,
    fetchedAt: Date.now(),
    expiresAt: Date.now() + KEY_CACHE_TTL_MS,
  };
  _storage?.write(_keyCache);
  recordFetchSuccess();
  console.log(`[trilc:keys] refreshed config:`, sanitizeKeysForLog(_keyCache));
  void reportCardStatus('applied');
  // TK-011: Notify external consumers of updated key cache
  if (_onKeyCacheUpdated) {
    try {
      _onKeyCacheUpdated(_keyCache);
    } catch (err) {
      console.warn('[trilc:keys] onKeyCacheUpdated callback failed:', err instanceof Error ? err.message : String(err));
    }
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
  _apiUrl = '';
  _apiToken = undefined;
}
