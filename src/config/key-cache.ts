// ── TriRLC Key Cache → config-cache（LG-058 N3 泛化）──
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
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, copyFileSync, rmSync } from 'node:fs';
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
// LG-058 N4：cache 清除面（config cache clear）需知文件落点——initKeyCache 时登记。
let _cacheFilePath = '';
let _legacyCacheFilePath = '';

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
  _cacheFilePath = filePath; // N4：clear 面登记（storage 接口无路径暴露，模块级直存）
  _legacyCacheFilePath = legacyFilePath;

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

/** N4：刷新路径结果形（周期刷新忽略返回值；config pull 手动面取它渲染）。 */
type RefreshMode = 'full' | 'model-relay' | 'failed';

async function doRefresh(apiUrl: string, apiToken?: string): Promise<RefreshMode> {
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
    return 'model-relay';
  }
  if (!pull.ok) {
    recordFetchFailure(new Error(pull.message), pull.attribution);
    if (pull.attribution === 'pull_denied') {
      void reportCardStatus('failed', 'pull_denied');
    }
    console.warn(`[trilc:keys] refresh failed (attribution: ${pull.attribution ?? 'network'}): ${pull.message}`);
    return 'failed';
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
  return 'full';
}

// ── CLI config 命令族（LG-058 N4，方案 §5.1）──
// 实现路径注：四命令全部在 daemon 进程内执行、CLI 经 /internal/v1/config/*
// 触发——「即时生效」要求刷新与 env apply 落在 daemon 运行态（CLI 独立进程
// 拉取触达不了 daemon 持有的 _keyCache/env），方案 §5.2「同一 API 面两个消
// 费端」=daemon 即 TriModel API 的消费端、CLI 为其触发器。CLI 不开写面
// （方案 §5.2 差异①）：本节四函数零卡写面，status 回写走既有 reportCardStatus。

/** config pull 读数（生效读数+来源归因，方案 §5.1 输出语义）。 */
export interface ManualPullResult {
  ok: boolean;
  mode: RefreshMode;
  defaultModel: string | null;
  source: 'tier1-card' | 'tier2-cache' | 'tier3-env';
  message: string;
  attribution: PullAttributionCode | null;
}

/** 手动拉取+即时生效（daemon 进程内；与周期刷新同路径 doRefresh）。 */
export async function refreshNow(): Promise<ManualPullResult> {
  if (!_apiUrl) {
    return { ok: false, mode: 'failed', defaultModel: null, source: 'tier3-env',
      message: 'key cache not initialized (daemon boot incomplete)', attribution: null };
  }
  const mode = await doRefresh(_apiUrl, _apiToken);
  const cache = getKeyCache();
  const st = getKeyCacheStatus();
  if (mode === 'failed') {
    return {
      ok: false, mode: 'failed',
      defaultModel: cache?.defaultModel ?? null,
      source: cache ? 'tier2-cache' : 'tier3-env',
      message: st.lastFetchError ?? 'pull failed',
      attribution: st.lastAttribution,
    };
  }
  return {
    ok: true, mode,
    defaultModel: cache?.defaultModel ?? null,
    source: 'tier1-card',
    message: mode === 'model-relay'
      ? 'model-dimension relay applied (card absent server-side; keys preserved)'
      : 'full pull applied (keys+default model refreshed)',
    attribution: null,
  };
}

/** config show / cache show 读数投影（零密钥：provider 名单+计数，SEC 纪律）。 */
export interface ConfigShowReading {
  face: string;
  hasCache: boolean;
  /** TTL 内（未过期）。 */
  fresh: boolean;
  /** 过期但 7 天宽限内（getKeyCache tier2.5 stale 语义）。 */
  staleGrace: boolean;
  defaultModel: string | null;
  effectiveModel: string | null;
  effectiveSource: 'tier2-cache-fresh' | 'tier2-cache-stale-grace' | 'tier3-env';
  fetchedAt: number | null;
  expiresAt: number | null;
  refreshIntervalS: number | null;
  providerCount: number;
  providers: string[];
  strategy: PullStrategySummary | null;
  lastFetchAt: number | null;
  lastFetchError: string | null;
  lastAttribution: PullAttributionCode | null;
}

export function describeConfig(): ConfigShowReading {
  const raw = _keyCache;
  const cache = getKeyCache(); // 7 天硬限丢弃语义内嵌
  const now = Date.now();
  const fresh = !!raw && now <= raw.expiresAt;
  return {
    face: FACE_ID,
    hasCache: !!cache,
    fresh,
    staleGrace: !!cache && !fresh,
    defaultModel: cache?.defaultModel ?? null,
    effectiveModel: cache?.defaultModel ?? null,
    effectiveSource: cache ? (fresh ? 'tier2-cache-fresh' : 'tier2-cache-stale-grace') : 'tier3-env',
    fetchedAt: raw?.fetchedAt ?? null,
    expiresAt: raw?.expiresAt ?? null,
    refreshIntervalS: raw?.refreshIntervalS ?? null,
    providerCount: cache ? Object.keys(cache.keys).length : 0,
    providers: cache ? Object.keys(cache.keys) : [],
    strategy: cache?.strategy ?? null,
    lastFetchAt: _lastFetchAt,
    lastFetchError: _lastFetchError,
    lastAttribution: _lastAttribution,
  };
}

/** config verify 三查报告（连通+凭据+解密健康；拉取试跑不落盘不回写，方案 §5.1）。 */
export interface ConfigVerifyReport {
  ok: boolean;
  connectivity: 'ok' | 'fail';
  credentials: 'ok' | 'denied' | 'absent';
  /** 条目解密健康=服务端已解密条目可聚合（消费端 cache 解密走 裁1(乙) 面）；
   * model-relay（卡缺席）=n/a。 */
  decryptHealth: 'ok' | 'n/a' | 'fail';
  cardPresent: boolean;
  defaultModel: string | null;
  providers: number;
  refreshIntervalS: number | null;
  message: string;
}

export async function verifyPull(): Promise<ConfigVerifyReport> {
  if (!_apiUrl) {
    return { ok: false, connectivity: 'fail', credentials: 'absent', decryptHealth: 'n/a',
      cardPresent: false, defaultModel: null, providers: 0, refreshIntervalS: null,
      message: 'key cache not initialized (daemon boot incomplete)' };
  }
  // 试跑：仅 fetch+解析，零状态写入（_keyCache/_storage/lastFetch*/status 全不触）
  const pull = await fetchConfigFromCardApi(_apiUrl, _apiToken);
  if (!pull.ok) {
    const denied = pull.attribution === 'pull_denied';
    return {
      ok: false,
      connectivity: denied ? 'ok' : 'fail',
      credentials: denied ? 'denied' : 'absent',
      decryptHealth: 'n/a',
      cardPresent: !denied,
      defaultModel: null,
      providers: 0,
      refreshIntervalS: null,
      message: pull.message,
    };
  }
  const entryCount = Object.keys(pull.keys).length;
  return {
    ok: true,
    connectivity: 'ok',
    credentials: 'ok',
    decryptHealth: pull.modelRelayOnly ? 'n/a' : (entryCount > 0 ? 'ok' : 'fail'),
    cardPresent: !pull.modelRelayOnly,
    defaultModel: pull.defaultModel,
    providers: entryCount,
    refreshIntervalS: pull.refreshIntervalS,
    message: pull.modelRelayOnly
      ? 'connectivity ok; model-dimension relay healthy (card absent server-side)'
      : entryCount > 0
        ? 'connectivity+credentials+decrypt all healthy'
        : 'connectivity ok but zero decryptable entries',
  };
}

/** config cache clear 读数。 */
export interface CacheClearResult {
  cleared: boolean;
  hadCache: boolean;
  removedFiles: string[];
}

/**
 * last-known-good 清除（方案 §5.1：清=强制回 tier1/tier3 验证梯语义）。
 * canonical+legacy 双清——防 legacy keys.json 在下次 boot 复活已清 cache
 * （read fallback 会读它）。env 现值不回滚（无 unapply 语义），下次成功
 * pull 自然覆盖。
 */
export function clearKeyCache(): CacheClearResult {
  const hadCache = !!_keyCache;
  _keyCache = null;
  const removed: string[] = [];
  for (const p of [_cacheFilePath, _legacyCacheFilePath]) {
    if (p && existsSync(p)) {
      try {
        rmSync(p, { force: true });
        removed.push(p);
      } catch (err) {
        console.warn(`[trilc:keys] cache clear failed for ${p}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { cleared: true, hadCache, removedFiles: removed };
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
  _cacheFilePath = '';
  _legacyCacheFilePath = '';
}
