// ── Sync Bundle 契约与纯函数（生成端，TriRLC 侧独立实现）──
// init-collab-i4-five-dim-sync i4-1 拆解 §一 schema 契约（TriRLC 侧）：
//   校验（递归密钥字段拒绝 + keys 白名单）/ 指纹 / 单调性——纯函数可单测，
//   不做任何 I/O。收集/生成/写/commit/push 链在 init-sync.ts。
//
// 密钥纪律（SEC-20260813-001）：
//   - 生成端 schema 校验递归拒绝 api_key / apiKey / secret / token 字段
//     （任意深度、非空字符串值）；keys 维只允许白名单字段。
//   - fingerprint = SHA-256(api_key 材料).slice(0,8)：daemon 内存内计算
//     （key-cache S2 解密后），材料不落任何中间文件，即刻丢弃。
//   - contentHash = 五维语义哈希（不含 bundleId/generatedAt/generatedBy
//     元字段）——元字段每次生成必然不同，纳入会使「同内容幂等重跑不重新
//     生成」判定恒失效（§一.4 矩阵语义 = 内容重放检测）。
//   - generatedAt 单调：max(now, 现存 bundle.generatedAt + 1ms)。
//
// TriMMC 接收侧 src/config-sync/types.ts 独立实现同一契约（跨仓共享包升级挂后续）。

import { createHash } from 'node:crypto';

// ── 五维键 ──

export const DIM_KEYS = ['company', 'model', 'keys', 'employees', 'project'] as const;
export type DimKey = (typeof DIM_KEYS)[number];

/** 单维降级段（§2.7 三态可见：该维收集失败 → unavailable 不阻塞全链）。 */
export interface DimUnavailable {
  status: 'unavailable';
  reason: string;
}

// ── 各维字段契约（§一，两端同构）──

export interface BundleCompany {
  state: string;
  ceoName: string;
  onboardedAt: string;
}

export interface BundleModelCatalogEntry {
  id: string;
  provider: string;
  capabilities: string[];
}

export interface BundleModelProvider {
  provider: string;
  baseUrl?: string;
  port?: number;
}

export interface BundleModel {
  defaultModel: string;
  catalog: BundleModelCatalogEntry[];
  providers: BundleModelProvider[];
}

/** keys 维白名单字段（§一.1 纪律：额外字段拒绝，防未来滑变）。 */
export interface BundleKeysProvider {
  provider: string;
  ready: boolean;
  fingerprint?: string;
  baseUrl?: string;
}

export interface BundleKeys {
  providers: BundleKeysProvider[];
  refreshIntervalS: number;
  fetchedAt: string;
}

export interface BundleEmployee {
  roleId: string;
  name: string;
}

export interface BundleEmployees {
  roster: BundleEmployee[];
  /** TriCompany 仓 HEAD sha40（§九 服务器侧校验兜底）。 */
  sourceCommit: string;
}

export interface BundleWorktree {
  path: string;
  branch: string;
}

export interface BundleProject {
  projectKey: string;
  repoUrl: string;
  defaultBranch: string;
  worktrees: BundleWorktree[];
  devHead: string;
}

export type BundleDim<T> = T | DimUnavailable;

export interface SyncBundle {
  schemaVersion: 1;
  bundleId: string;
  generatedAt: string;
  generatedBy: string;
  company: BundleDim<BundleCompany>;
  model: BundleDim<BundleModel>;
  keys: BundleDim<BundleKeys>;
  employees: BundleDim<BundleEmployees>;
  project: BundleDim<BundleProject>;
}

// ── 密钥材料字段拒绝（SEC-20260813-001）──

export const SECRET_FIELD_NAMES = ['api_key', 'apiKey', 'secret', 'token'] as const;

export const KEYS_PROVIDER_FIELDS = ['provider', 'ready', 'fingerprint', 'baseUrl'] as const;

/** 递归扫描：任意深度出现密钥材料字段名且值为非空字符串 → 拒绝。 */
export function findSecretField(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findSecretField(node[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((SECRET_FIELD_NAMES as readonly string[]).includes(key)) {
        if (typeof value === 'string' && value.length > 0) {
          return `${path}.${key}`;
        }
      }
      const hit = findSecretField(value, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

// ── 结构校验（生成端与接收端同规则）──

export type BundleValidation =
  | { ok: true; bundle: SyncBundle }
  | { ok: false; error: string; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function isDimUnavailable(v: unknown): v is DimUnavailable {
  return isRecord(v) && v.status === 'unavailable' && typeof v.reason === 'string';
}

function checkCompany(v: unknown): string | null {
  if (!isRecord(v)) return 'company must be an object';
  if (!isStr(v.state) || !isStr(v.ceoName) || !isStr(v.onboardedAt)) {
    return 'company.state/ceoName/onboardedAt must be non-empty strings';
  }
  return null;
}

function checkModel(v: unknown): string | null {
  if (!isRecord(v)) return 'model must be an object';
  if (!isStr(v.defaultModel)) return 'model.defaultModel must be a non-empty string';
  if (!Array.isArray(v.catalog) || !Array.isArray(v.providers)) {
    return 'model.catalog/providers must be arrays';
  }
  for (const entry of v.catalog) {
    if (!isRecord(entry) || !isStr(entry.id) || !isStr(entry.provider)) {
      return 'model.catalog[] needs id + provider strings';
    }
    if (!Array.isArray(entry.capabilities)) return 'model.catalog[].capabilities must be an array';
  }
  for (const p of v.providers) {
    if (!isRecord(p) || !isStr(p.provider)) return 'model.providers[].provider must be a string';
  }
  return null;
}

function checkKeys(v: unknown): string | null {
  if (!isRecord(v)) return 'keys must be an object';
  if (!Array.isArray(v.providers) || typeof v.refreshIntervalS !== 'number' || !isStr(v.fetchedAt)) {
    return 'keys.providers[]/refreshIntervalS/fetchedAt shape invalid';
  }
  for (const p of v.providers) {
    if (!isRecord(p)) return 'keys.providers[] must be an object';
    for (const field of Object.keys(p)) {
      if (!(KEYS_PROVIDER_FIELDS as readonly string[]).includes(field)) {
        return `keys.providers[] field not whitelisted: ${field}`;
      }
    }
    if (!isStr(p.provider) || typeof p.ready !== 'boolean') {
      return 'keys.providers[] needs provider string + ready boolean';
    }
    if (p.fingerprint !== undefined && typeof p.fingerprint !== 'string') {
      return 'keys.providers[].fingerprint must be a string';
    }
    if (p.baseUrl !== undefined && typeof p.baseUrl !== 'string') {
      return 'keys.providers[].baseUrl must be a string';
    }
  }
  return null;
}

function checkEmployees(v: unknown): string | null {
  if (!isRecord(v)) return 'employees must be an object';
  if (!Array.isArray(v.roster) || !isStr(v.sourceCommit)) {
    return 'employees.roster[]/sourceCommit shape invalid';
  }
  for (const e of v.roster) {
    if (!isRecord(e) || !isStr(e.roleId) || !isStr(e.name)) {
      return 'employees.roster[] needs roleId + name strings';
    }
  }
  return null;
}

function checkProject(v: unknown): string | null {
  if (!isRecord(v)) return 'project must be an object';
  if (!isStr(v.projectKey) || !isStr(v.repoUrl) || !isStr(v.defaultBranch) || !isStr(v.devHead)) {
    return 'project.projectKey/repoUrl/defaultBranch/devHead must be non-empty strings';
  }
  if (!Array.isArray(v.worktrees)) return 'project.worktrees must be an array';
  for (const wt of v.worktrees) {
    if (!isRecord(wt) || !isStr(wt.path) || !isStr(wt.branch)) {
      return 'project.worktrees[] needs path + branch strings';
    }
  }
  return null;
}

const DIM_CHECKERS: Record<DimKey, (v: unknown) => string | null> = {
  company: checkCompany,
  model: checkModel,
  keys: checkKeys,
  employees: checkEmployees,
  project: checkProject,
};

/**
 * bundle schema 校验（§一契约 + 测试门禁①）：
 * 递归密钥材料字段拒绝 → 结构逐维校验（unavailable 降级段合法）→ 元字段。
 */
export function validateSyncBundle(raw: unknown): BundleValidation {
  const secretHit = findSecretField(raw, '$');
  if (secretHit) {
    return {
      ok: false,
      error: 'secret_field_rejected',
      message: `bundle contains key-material field at ${secretHit}（SEC-20260813-001：密钥材料零传输，仅允许配置面 + 指纹）`,
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: 'bad_shape', message: 'bundle must be a JSON object' };
  }
  if (raw.schemaVersion !== 1) {
    return { ok: false, error: 'bad_schema_version', message: 'schemaVersion must be 1' };
  }
  if (!isStr(raw.bundleId)) {
    return { ok: false, error: 'bad_bundle_id', message: 'bundleId must be a non-empty string' };
  }
  if (!isStr(raw.generatedAt) || Number.isNaN(Date.parse(raw.generatedAt))) {
    return { ok: false, error: 'bad_generated_at', message: 'generatedAt must be a parseable ISO-8601 string' };
  }
  if (!isStr(raw.generatedBy)) {
    return { ok: false, error: 'bad_generated_by', message: 'generatedBy must be a non-empty string' };
  }
  for (const dim of DIM_KEYS) {
    const value = raw[dim];
    if (isDimUnavailable(value)) continue;
    const err = DIM_CHECKERS[dim](value);
    if (err) return { ok: false, error: 'bad_dim_shape', message: `${dim}: ${err}` };
  }
  return { ok: true, bundle: raw as unknown as SyncBundle };
}

// ── 稳定键序序列化（两端同算法，保证 contentHash 一致）──

export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 五维语义哈希：SHA-256(稳定键序 JSON of 五维) 全量 hex。
 * 不含 bundleId/generatedAt/generatedBy 元字段（幂等重跑判定语义：
 * 同内容 → 不重新生成、不换 bundleId，§一.4）。生成前比较与
 * contentHash 共用本函数（init-sync.ts 组装前幂等判定）。
 * 修正记录 ②（i4-4 终审裁决，OBS-1）：project.devHead 同口径排除——
 * devHead 是自引用事实：每次成功 run 必 commit bundle 文件推进 HEAD，
 * 下一轮收集的 devHead 必变 → 纳入会使内容 hash 恒变 → 幂等重跑
 * 「同内容不重新生成/纯重推」语义失效（§一.4 门禁 5）。devHead 保留为
 * bundle 内诊断事实（生成时值），不参与幂等判定。
 */
export function computeDimsContentHash(dims: {
  company: unknown;
  model: unknown;
  keys: unknown;
  employees: unknown;
  project: unknown;
}): string {
  const { project, ...rest } = dims;
  const projectForHash = projectDimForHash(project);
  return createHash('sha256')
    .update(canonicalize({ ...rest, project: projectForHash }), 'utf-8')
    .digest('hex');
}

/** 幂等哈希口径：project 维剔除 devHead（自引用字段，两端同口径）。 */
function projectDimForHash(project: unknown): unknown {
  if (typeof project === 'object' && project !== null && !Array.isArray(project)) {
    const { devHead: _omitted, ...rest } = project as Record<string, unknown>;
    return rest;
  }
  return project;
}

/** contentHash = 五维语义哈希（本 bundle 的五维段，devHead 排除）。 */
export function computeContentHash(bundle: SyncBundle): string {
  const { company, model, keys, employees, project } = bundle;
  return computeDimsContentHash({ company, model, keys, employees, project });
}

/** keys 维指纹 = SHA-256(材料).slice(0,8)（§一.2；材料仅内存内计算，即刻丢弃）。 */
export function computeKeyFingerprint(material: string): string {
  return createHash('sha256').update(material, 'utf-8').digest('hex').slice(0, 8);
}

/** 路径短指纹 = SHA-256(path).slice(0,8)（§7.2 防截断；L1 worktree 路径呈现）。 */
export function computePathFingerprint(path: string): string {
  return createHash('sha256').update(path, 'utf-8').digest('hex').slice(0, 8);
}

// ── 单调性（§一.4：bundleId 唯一 + generatedAt 严格递增）──

/**
 * generatedAt 严格递增：max(now, 现存 generatedAt + 1ms)。
 * 现存无/不可解析 → now。
 */
export function nextGeneratedAt(existingIso?: string | null, nowMs?: number): string {
  const now = new Date(nowMs ?? Date.now());
  if (existingIso) {
    const existingMs = Date.parse(existingIso);
    if (Number.isFinite(existingMs)) {
      const floor = new Date(existingMs + 1);
      return floor > now ? floor.toISOString() : now.toISOString();
    }
  }
  return now.toISOString();
}

/** 生成端身份：trilc-init-<version>@<host-hash-8>（§一 generatedBy 字段）。 */
export function buildGeneratedBy(version: string, host: string): string {
  const hostHash = createHash('sha256').update(host, 'utf-8').digest('hex').slice(0, 8);
  return `trilc-init-${version}@${hostHash}`;
}

// ── 序列化密钥泄漏扫描（测试门禁②：序列化输出无 sk- 明文、无 api_key 字段名）──

export interface SecretScanResult {
  hasSecretFieldName: boolean;
  hasSkPlaintext: boolean;
}

/** 全文扫描：api_key/apiKey/secret/token 字段名 + sk- 前缀明文（如 sk-abc123）。 */
export function scanSecretMaterial(serialized: string): SecretScanResult {
  const fieldPattern = /"(api_key|apiKey|secret|token)"\s*:/;
  const skPattern = /sk-[A-Za-z0-9_-]{4,}/;
  return {
    hasSecretFieldName: fieldPattern.test(serialized),
    hasSkPlaintext: skPattern.test(serialized),
  };
}

/** 测试门禁②断言：序列化全文无密钥字段名、无 sk- 明文，否则抛错。 */
export function assertNoSecretMaterial(serialized: string): void {
  const scan = scanSecretMaterial(serialized);
  if (scan.hasSecretFieldName || scan.hasSkPlaintext) {
    throw new Error(
      `SEC-20260813-001 violation: bundle serialization contains key material (field=${scan.hasSecretFieldName}, skPlaintext=${scan.hasSkPlaintext})`,
    );
  }
}

// ── Phase D 契约冻结（§六：L1-L4 协同确认；实现待 I3 收官解锁信号）──
// 本段仅类型契约——端点实现归 Phase D（i4-2 内序：TriMMC 侧先行、确认卡后接）。

export type ConfirmCheckStatus = 'ok' | 'error' | 'pending';

export interface L1Item {
  element: 'repoUrl' | 'projectKey' | 'worktreePath';
  /** 路径用短指纹呈现（SHA-256(worktreePath).slice(0,8)，§7.2 防截断）。 */
  local: string;
  bundle: string;
  server: string;
  status: ConfirmCheckStatus;
}

export interface ConfirmCheckL1 {
  ok: boolean;
  items: L1Item[];
}

export interface ConfirmCheckL2 {
  ok: boolean;
  localHead: string;
  bundleHead: string;
  fleetHead: string;
  /** bundleHead 为 localHead 祖先或相等（i4-4 修正记录 ② additive；诊断呈现用）。 */
  bundleAncestor?: boolean;
}

export interface ConfirmCheckL3 {
  ok: boolean;
  appliedBundleId: string | null;
  localBundleId: string | null;
}

export interface ConfirmCheckL4 {
  status: 'pending';
  note: '由首个协同工作承载';
}

/** GET /internal/v1/init/confirm/check 响应契约（§六.1）。 */
export interface ConfirmCheckPayload {
  chainState: string;
  l1: ConfirmCheckL1;
  l2: ConfirmCheckL2;
  l3: ConfirmCheckL3;
  l4: ConfirmCheckL4;
  readyForConfirm: boolean;
  remote: 'ok' | null;
  degraded: boolean;
}

/** POST /internal/v1/init/confirm 请求载荷（两入口同载荷 { entry }）。 */
export interface ConfirmPostPayload {
  entry: 'tripilot' | 'trilc-chat' | 'daemon';
}

/** POST /internal/v1/init/confirm 响应契约（§六.2：409 附 check 结果）。 */
export type ConfirmResult =
  | { status: 200; chainState: 'ready'; confirmed: true; check: ConfirmCheckPayload }
  | { status: 409; busy: true; runId: string }
  | { status: 409; chainState: string; check?: ConfirmCheckPayload }
  | { status: 409; notReady: true; check: ConfirmCheckPayload }
  | { status: 422 | 500; error: string; message: string };
