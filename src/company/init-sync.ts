// ── TriCompany Init Sync 执行体（I4：五维同步生成/commit/push 链）──
// init-collab-i4-five-dim-sync i4-1 拆解 §二（daemon 端点单执行体；两入口
// 只发指令）：
//
//   POST /internal/v1/init/sync/run：
//   1. 链态门：chainState ∈ {project-link, sync} 否则 409 { chainState }；
//      project-link 且 phaseDetail['project-link'].status === 'linked' →
//      先 transitionTo('sync') 再执行；sync 态 = 幂等重跑。防重入 409。
//   2. 五维收集（单维失败降级，逐维 init:sync-progress 事件三态可见）：
//      company（硬错误——无公司态 400 提示先开张）/ model（TriModel
//      /v1/models + key-cache，不可达降级）/ keys（key-cache S2 解密 →
//      内存指纹 → 即刻丢弃材料，逐 provider ready:false 降级）/ employees
//      （state.json roster + roleId 校验 + TriCompany HEAD，读失败降级）/
//      project（注册点 mainCheckoutPath + devHead，硬错误——写目标缺失）
//   3. 生成 + 校验：bundle 组装 → §一 schema 校验（递归拒绝密钥字段）
//      → 序列化无 sk- 明文断言 → 单调性（generatedAt 递增）→ 幂等判定：
//      本地文件已存在且五维语义 hash 未变 → 不重新生成、不换 bundleId
//      （重跑 = 纯重推）。
//   4. 写 + commit + push（git 单执行体 + 固定身份 D2）：
//      原子写 {mainCheckoutPath}/docs/registry/init-sync/sync-config.json
//      （tmp→rename）→ git add → diff --cached --quiet（无变化跳过 commit）
//      → commit（-c user.name="TriLC Init Sync" -c user.email=
//      "trilc@tri.company"，绝不使用环境 git 身份）→ push origin dev &&
//      push sg-server dev（双远端；任一失败 = 失败分类 + sync-pending
//      挂起，sync/run 可重跑）。
//   5. 成功路径：phaseDetail.sync.status='pushed' + bundleId 快照回写 →
//      transitionTo('confirm')（D1：转移门槛 = pushed，applied 由 confirm
//      阶段轮询收敛）→ init:step-event { phase:'sync', step:'pushed' }。
//   6. 事件族：init:sync-started / init:sync-progress（逐维三态）/
//      init:sync-finished / init:sync-failed——经既有 /internal/v1/init/events
//      SSE 通道发布（零新通道）。
//
// 辅助端点 GET /internal/v1/init/sync/status + daemon 重启 re-sync 检查
// （§6.6 尾部：只读 no-op，不自动 push/生成）。
//
// 密钥纪律（SEC-20260813-001）：零密钥进 bundle（指纹 + ready + baseUrl）、
// 零密钥进 git（commit 前 diff 扫描 + 序列化断言）、fingerprint 计算后
// 材料即刻丢弃。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { LocalBusEvent } from '../localbus/bus.js';
import type { ChainState, InitChain, SyncPhase } from './init-chain.js';
import type { CompanyInitState } from './init-state.js';
import type { ProjectRegistry } from '../project/project-registry.js';
import type { GitRunner } from '../project/project-link.js';
import type { KeyCache } from '../config/key-cache.js';
import {
  assertNoSecretMaterial,
  buildGeneratedBy,
  computeDimsContentHash,
  computeKeyFingerprint,
  isDimUnavailable,
  nextGeneratedAt,
  validateSyncBundle,
  type BundleCompany,
  type BundleDim,
  type BundleEmployees,
  type BundleKeys,
  type BundleKeysProvider,
  type BundleModel,
  type BundleProject,
  type DimKey,
  type SyncBundle,
} from './sync-bundle.js';

// ── 类型 ──

export type SyncEntry = 'tripilot' | 'trilc-chat' | 'daemon';

export type SyncDimStatus = 'collecting' | 'synced' | 'unavailable';

/** TriModel /v1/models 响应面（id 即正典模型名）。 */
export interface ModelInfoLite {
  id: string;
}

export interface InitSyncDeps {
  dataDir: string;
  chain: InitChain;
  companyState: CompanyInitState;
  registry: ProjectRegistry;
  publish: (event: LocalBusEvent) => void;
  /** TriMMC 状态端点基址（env.trimcBaseUrl）。 */
  trimcBaseUrl: string;
  trilcVersion: string;
  nodeId: string;
  /** TriCompany 仓本地路径（employees 维 sourceCommit 数据源）。 */
  tricompanySourcePath: string;
  git?: GitRunner;
  /** key-cache 读取（S2 解密发生在 key-cache 层；本模块只算指纹）。 */
  getKeyCache?: () => KeyCache | null;
  /** TriModel /v1/models 抓取（app 层注入 getAvailableModels）。 */
  fetchModels?: () => Promise<ModelInfoLite[]>;
  /** contract-resolver role catalog（employees 维 roleId 校验）。 */
  getRoleCatalog?: () => { roles: Array<{ roleId: string }> } | null;
  /** 远程状态拉取超时（测试注入；默认 3000ms）。 */
  timeoutMs?: number;
  /** 测试注入：当前时间源。 */
  nowMs?: () => number;
}

export type SyncFailureClassification =
  | 'company-not-initialized'
  | 'project-not-linked'
  | 'project-link-not-linked'
  | 'project-dev-head-failed'
  | 'bundle-validation-failed'
  | 'secret-leak-guard'
  | 'bundle-write-failed'
  | 'git-commit-failed'
  | 'push-failed';

export type SyncRunResult =
  | {
      status: 200;
      runId: string;
      bundleId: string;
      generatedAt: string;
      chainState: 'confirm';
      dims: Record<DimKey, 'synced' | 'unavailable'>;
      /** 幂等重跑：同内容不重新生成，本轮为纯重推。 */
      rePushedOnly: boolean;
    }
  | { status: 409; busy: true; runId: string }
  | { status: 409; chainState: ChainState }
  | {
      status: 400 | 422 | 500;
      error: string;
      classification: SyncFailureClassification;
      message: string;
      runId: string;
      retryable: boolean;
    };

export interface SyncStatusRemote {
  reachable: boolean;
  appliedBundleId: string | null;
  appliedGeneratedAt: string | null;
  fleetHead: { branch: string; commit: string } | null;
  dims: Record<string, string> | null;
  /** 服务器已应用 project 维（Phase D L1 三面比对事实源）。 */
  project: BundleProject | null;
}

export interface SyncStatusPayload {
  chainState: ChainState;
  phaseDetail: SyncPhase;
  localBundleId: string | null;
  localBundleGeneratedAt: string | null;
  remote: SyncStatusRemote | null;
}

// ── 防重入互斥（单执行体）──

let _syncing = false;
let _activeSyncRunId: string | null = null;

/** 测试复位。 */
export function resetSyncForTest(): void {
  _syncing = false;
  _activeSyncRunId = null;
}

function newRunId(): string {
  return `sy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function nowIso(nowMs?: () => number): string {
  return new Date(nowMs ? nowMs() : Date.now()).toISOString();
}

// ── 维度收集 ──

interface CollectedDims {
  company: BundleDim<BundleCompany>;
  model: BundleDim<BundleModel>;
  keys: BundleDim<BundleKeys>;
  employees: BundleDim<BundleEmployees>;
  project: BundleDim<BundleProject>;
}

class DimError extends Error {
  classification: SyncFailureClassification;
  status: 400 | 422 | 500;
  retryable: boolean;
  constructor(classification: SyncFailureClassification, message: string, status: 400 | 422 | 500, retryable: boolean) {
    super(message);
    this.classification = classification;
    this.status = status;
    this.retryable = retryable;
  }
}

async function collectCompany(deps: InitSyncDeps): Promise<BundleCompany> {
  const state = await deps.companyState.load();
  if (state.state !== 'initialized') {
    throw new DimError(
      'company-not-initialized',
      '公司态未开张（state != initialized）— 请先完成 ONBOARDING 开张流程再同步',
      400,
      false,
    );
  }
  return {
    state: state.state,
    ceoName: state.ceoName ?? '',
    onboardedAt: state.onboardedAt ?? nowIso(deps.nowMs),
  };
}

function providerOfModelId(id: string): string {
  if (/deepseek/i.test(id)) return 'deepseek';
  if (/anthropic|claude/i.test(id)) return 'anthropic';
  if (/openai|gpt/i.test(id)) return 'openai';
  return 'unknown';
}

async function collectModel(deps: InitSyncDeps, keyCache: KeyCache | null): Promise<BundleDim<BundleModel>> {
  let catalog: BundleModel['catalog'] = [];
  try {
    const models = await deps.fetchModels?.();
    if (models && models.length > 0) {
      catalog = models.map((m) => ({
        id: m.id,
        provider: providerOfModelId(m.id),
        capabilities: ['chat'],
      }));
    }
  } catch (err) {
    console.warn(`[trilc:init-sync] model fetch failed: ${(err as Error).message}`);
  }
  if (catalog.length === 0 && !keyCache) {
    return {
      status: 'unavailable',
      reason: 'TriModel /v1/models unreachable and no key cache — model 维降级',
    };
  }
  const defaultModel = keyCache?.defaultModel ?? catalog[0]?.id ?? 'tmv-deepseek-v4-pro';
  const providers: BundleModel['providers'] = keyCache
    ? Object.entries(keyCache.keys).map(([provider, info]) => ({
        provider,
        ...(info.base_url ? { baseUrl: info.base_url } : {}),
        port: 3333,
      }))
    : [];
  return { defaultModel, catalog, providers };
}

/** keys 维：指纹在内存内计算后材料即刻丢弃（零中间文件、零序列化）。 */
function collectKeys(deps: InitSyncDeps, keyCache: KeyCache | null): BundleDim<BundleKeys> {
  if (!keyCache) {
    return { status: 'unavailable', reason: 'key cache absent — keys 维降级' };
  }
  const providers: BundleKeysProvider[] = [];
  for (const [provider, info] of Object.entries(keyCache.keys)) {
    const entry: BundleKeysProvider = {
      provider,
      ready: !!info.api_key,
    };
    if (info.api_key) {
      // SEC-20260813-001：指纹 = SHA-256(材料).slice(0,8)，算完即弃
      entry.fingerprint = computeKeyFingerprint(info.api_key);
    }
    if (info.base_url) entry.baseUrl = info.base_url;
    providers.push(entry);
  }
  return {
    providers,
    refreshIntervalS: keyCache.refreshIntervalS,
    fetchedAt: new Date(keyCache.fetchedAt).toISOString(),
  };
}

async function collectEmployees(deps: InitSyncDeps): Promise<BundleDim<BundleEmployees>> {
  const state = await deps.companyState.load();
  let roster = (state.employees ?? []).map((e) => ({ roleId: e.role, name: e.name }));
  // roleId 校验（contract-resolver；resolver 不可用 = 跳过校验，不造假数据）
  const catalog = deps.getRoleCatalog?.() ?? null;
  if (catalog) {
    const known = new Set(catalog.roles.map((r) => r.roleId));
    const unknown = roster.filter((e) => !known.has(e.roleId));
    if (unknown.length > 0) {
      console.warn(
        `[trilc:init-sync] employees roster has unknown roleIds (dropped from bundle): ${unknown.map((e) => e.roleId).join(', ')}`,
      );
    }
    roster = roster.filter((e) => known.has(e.roleId));
  }
  const git = deps.git ?? (await import('../project/project-link.js')).createGitRunner();
  const headRes = await git(['-C', deps.tricompanySourcePath, 'rev-parse', 'HEAD']);
  if (headRes.code !== 0 || !headRes.stdout.trim()) {
    return {
      status: 'unavailable',
      reason: `TriCompany HEAD 读取失败（${headRes.stderr || 'git 失败'}）— 该维降级，§九 服务器侧校验兜底`,
    };
  }
  return { roster, sourceCommit: headRes.stdout.trim() };
}

async function collectProject(deps: InitSyncDeps): Promise<BundleProject> {
  const frame = await deps.registry.load();
  const projectKey = frame.activeProjectKey;
  if (!projectKey || !frame.projects[projectKey]) {
    throw new DimError('project-not-linked', '注册点无焦点项目 — 请先走 PROJECT-LINK 流程（I3 link/claim）', 400, false);
  }
  const project = frame.projects[projectKey];
  if (!project.mainCheckoutPath) {
    throw new DimError('project-not-linked', '注册点主检出未登记 — 请先走 PROJECT-LINK 流程（I3 link/claim）', 400, false);
  }
  const git = deps.git ?? (await import('../project/project-link.js')).createGitRunner();
  const headRes = await git(['-C', project.mainCheckoutPath, 'rev-parse', 'HEAD']);
  if (headRes.code !== 0 || !headRes.stdout.trim()) {
    throw new DimError(
      'project-dev-head-failed',
      `主检出 dev HEAD 读取失败（${headRes.stderr || 'git 失败'}）— bundle 写目标不可用`,
      422,
      true,
    );
  }
  return {
    projectKey,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    worktrees: project.worktrees.map((wt) => ({ path: wt.path, branch: wt.branch })),
    devHead: headRes.stdout.trim(),
  };
}

// ── 幂等判定 + 生成 ──

export function bundleTargetPath(mainCheckoutPath: string): string {
  return resolve(mainCheckoutPath, 'docs', 'registry', 'init-sync', 'sync-config.json');
}

export async function readExistingBundle(targetPath: string): Promise<SyncBundle | null> {
  try {
    const raw = await readFile(targetPath, 'utf-8');
    const validation = validateSyncBundle(JSON.parse(raw));
    return validation.ok ? validation.bundle : null;
  } catch {
    return null;
  }
}

/**
 * 幂等判定：同五维语义内容（devHead 排除，R1 自引用口径）→ 复用现存
 * bundle 原样（不写新 devHead）→ 字节不变 → 无 commit → 纯重推。
 * 内容变更 → 新 bundleId + generatedAt 严格递增。
 */
function assembleBundle(
  dims: CollectedDims,
  existing: SyncBundle | null,
  deps: InitSyncDeps,
): { bundle: SyncBundle; reused: boolean } {
  const dimsHash = computeDimsContentHash(dims);
  // 只比现存 bundle 的五维段（元字段 bundleId/generatedAt 不纳入；project.devHead
  // 自引用字段同口径排除——i4-4 终审修正记录 ②）
  const existingDimsHash = existing
    ? computeDimsContentHash({
        company: existing.company,
        model: existing.model,
        keys: existing.keys,
        employees: existing.employees,
        project: existing.project,
      })
    : null;
  if (existing && dimsHash === existingDimsHash) {
    // 内容未变：返回 existing 原样（不重新生成、不换 bundleId、不覆盖 devHead——
    // 字节不变 → 无 commit → 纯重推，§一.4 幂等单调 + R1）
    return { bundle: existing, reused: true };
  }
  return {
    bundle: {
      schemaVersion: 1,
      bundleId: randomUUID(),
      generatedAt: nextGeneratedAt(existing?.generatedAt ?? null, deps.nowMs ? deps.nowMs() : undefined),
      generatedBy: buildGeneratedBy(deps.trilcVersion, hostname()),
      company: dims.company,
      model: dims.model,
      keys: dims.keys,
      employees: dims.employees,
      project: dims.project,
    },
    reused: false,
  };
}

// ── 写 + commit + push（git 单执行体 + 固定身份 D2）──

async function writeBundleAtomic(targetPath: string, bundle: SyncBundle): Promise<void> {
  const serialized = JSON.stringify(bundle, null, 2);
  // 测试门禁②：序列化全文无密钥字段名、无 sk- 明文（生成端硬门禁）
  assertNoSecretMaterial(serialized);
  await mkdir(join(targetPath, '..'), { recursive: true });
  const tmp = `${targetPath}.tmp`;
  await writeFile(tmp, serialized, 'utf-8');
  await rename(tmp, targetPath);
}

async function commitAndPush(
  deps: InitSyncDeps,
  mainCheckoutPath: string,
  bundle: SyncBundle,
): Promise<{ rePushedOnly: boolean }> {
  const git = deps.git ?? (await import('../project/project-link.js')).createGitRunner();
  const relPath = 'docs/registry/init-sync/sync-config.json';
  const addRes = await git(['-C', mainCheckoutPath, 'add', relPath]);
  if (addRes.code !== 0) {
    throw new DimError('git-commit-failed', `git add 失败（${addRes.stderr}）`, 500, true);
  }
  // 幂等重推：内容未变 → staged diff 为空 → 跳过 commit，仅重推（D2 固定身份
  // 仅用于真实 commit；绝不使用环境 git 身份）
  const diffRes = await git(['-C', mainCheckoutPath, 'diff', '--cached', '--quiet']);
  let rePushedOnly = false;
  if (diffRes.code === 1) {
    const commitRes = await git([
      '-C', mainCheckoutPath,
      '-c', 'user.name=TriLC Init Sync',
      '-c', 'user.email=trilc@tri.company',
      'commit', '-m', `chore(init-sync): five-dim sync bundle ${bundle.bundleId.slice(0, 8)}`,
    ]);
    if (commitRes.code !== 0) {
      throw new DimError('git-commit-failed', `git commit 失败（${commitRes.stderr}）`, 500, true);
    }
  } else if (diffRes.code === 0) {
    rePushedOnly = true;
  } else {
    throw new DimError('git-commit-failed', `git diff --cached 失败（${diffRes.stderr}）`, 500, true);
  }
  // 双远端 push：任一失败 = 失败分类 + sync-pending 挂起，sync/run 可重跑
  const pushOrigin = await git(['-C', mainCheckoutPath, 'push', 'origin', 'dev'], { timeoutMs: 300_000 });
  const pushSg = pushOrigin.code === 0
    ? await git(['-C', mainCheckoutPath, 'push', 'sg-server', 'dev'], { timeoutMs: 300_000 })
    : null;
  if (pushOrigin.code !== 0 || (pushSg && pushSg.code !== 0)) {
    const detail = pushOrigin.code !== 0
      ? `push origin 失败（${pushOrigin.stderr}）`
      : `push sg-server 失败（${pushSg!.stderr}）`;
    throw new DimError('push-failed', `${detail} — 已 commit 未推送，sync/run 重跑即重推`, 500, true);
  }
  return { rePushedOnly };
}

// ── sync/run 执行体 ──

export async function runInitSync(deps: InitSyncDeps, entry: SyncEntry): Promise<SyncRunResult> {
  if (_syncing) return { status: 409, busy: true, runId: _activeSyncRunId ?? '' };
  _syncing = true;
  _activeSyncRunId = newRunId();
  const runId = _activeSyncRunId;
  try {
    return await doInitSync(deps, entry, runId);
  } finally {
    _syncing = false;
    _activeSyncRunId = null;
  }
}

async function doInitSync(deps: InitSyncDeps, entry: SyncEntry, runId: string): Promise<SyncRunResult> {
  // 1. 链态门
  const chainFrame = await deps.chain.load();
  const state = chainFrame.chainState;
  if (state !== 'project-link' && state !== 'sync') {
    return { status: 409, chainState: state };
  }
  if (state === 'project-link') {
    if (chainFrame.phaseDetail['project-link'].status !== 'linked') {
      return {
        status: 422,
        error: 'project-link-not-linked',
        classification: 'project-link-not-linked',
        message: 'PROJECT-LINK 未 linked — 请先完成项目链路（I3 link/claim）再同步',
        runId,
        retryable: false,
      };
    }
    await deps.chain.transitionTo('sync', entry);
  }

  deps.publish({ type: 'init:sync-started', runId, entry, chainState: 'sync' });
  const progress = (dim: DimKey, status: SyncDimStatus, detail: string) =>
    deps.publish({ type: 'init:sync-progress', runId, dim, status, detail });

  const fail = (
    classification: SyncFailureClassification,
    message: string,
    status: 400 | 422 | 500,
    retryable: boolean,
  ): Extract<SyncRunResult, { status: 400 | 422 | 500 }> => {
    deps.publish({ type: 'init:sync-failed', runId, error: classification, classification, message, retryable });
    return { status, error: classification, classification, message, runId, retryable };
  };

  // 2. 五维收集（单维失败降级；company/project 为硬错误）
  const keyCache = deps.getKeyCache?.() ?? null;
  const dims: CollectedDims = {
    company: {} as BundleCompany,
    model: {} as BundleModel,
    keys: {} as BundleKeys,
    employees: {} as BundleEmployees,
    project: {} as BundleProject,
  };
  try {
    progress('company', 'collecting', 'company/state.json');
    dims.company = await collectCompany(deps);
    progress('company', 'synced', `ceo=${dims.company.ceoName}`);
  } catch (err) {
    if (err instanceof DimError) return fail(err.classification, err.message, err.status, err.retryable);
    throw err;
  }
  try {
    progress('model', 'collecting', 'TriModel /v1/models + key-cache');
    dims.model = await collectModel(deps, keyCache);
    progress('model', isDimUnavailable(dims.model) ? 'unavailable' : 'synced',
      isDimUnavailable(dims.model) ? dims.model.reason : `default=${dims.model.defaultModel}`);
  } catch (err) {
    dims.model = { status: 'unavailable', reason: `model 维收集异常：${(err as Error).message}` };
    progress('model', 'unavailable', dims.model.reason);
  }
  try {
    progress('keys', 'collecting', 'key-cache S2 解密 → 内存指纹');
    dims.keys = collectKeys(deps, keyCache);
    progress('keys', isDimUnavailable(dims.keys) ? 'unavailable' : 'synced',
      isDimUnavailable(dims.keys) ? dims.keys.reason : `${dims.keys.providers.length} providers（仅指纹）`);
  } catch (err) {
    dims.keys = { status: 'unavailable', reason: `keys 维收集异常：${(err as Error).message}` };
    progress('keys', 'unavailable', dims.keys.reason);
  }
  try {
    progress('employees', 'collecting', 'roster + TriCompany HEAD');
    dims.employees = await collectEmployees(deps);
    progress('employees', isDimUnavailable(dims.employees) ? 'unavailable' : 'synced',
      isDimUnavailable(dims.employees) ? dims.employees.reason : `${dims.employees.roster.length} employees`);
  } catch (err) {
    dims.employees = { status: 'unavailable', reason: `employees 维收集异常：${(err as Error).message}` };
    progress('employees', 'unavailable', dims.employees.reason);
  }
  try {
    progress('project', 'collecting', '注册点 + 主检出 dev HEAD');
    dims.project = await collectProject(deps);
    progress('project', 'synced', `${dims.project.projectKey}@${dims.project.devHead.slice(0, 8)}`);
  } catch (err) {
    if (err instanceof DimError) return fail(err.classification, err.message, err.status, err.retryable);
    throw err;
  }

  // 3. 生成 + 校验（幂等判定：同内容不重新生成）
  // 写目标 = 注册点 mainCheckoutPath（collectProject 已保证存在；此处复读防并发）
  const frame = await deps.registry.load();
  const projectEntry = frame.activeProjectKey ? frame.projects[frame.activeProjectKey] : null;
  if (!projectEntry?.mainCheckoutPath) {
    return fail('project-not-linked', '注册点主检出缺失 — 请先走 PROJECT-LINK 流程', 400, false);
  }
  const targetPath = bundleTargetPath(projectEntry.mainCheckoutPath);
  const existing = await readExistingBundle(targetPath);
  const { bundle, reused } = assembleBundle(dims, existing, deps);
  const validation = validateSyncBundle(bundle);
  if (!validation.ok) {
    return fail('bundle-validation-failed', `bundle 校验失败：${validation.error} ${validation.message}`, 500, false);
  }
  try {
    assertNoSecretMaterial(JSON.stringify(bundle));
  } catch (err) {
    return fail('secret-leak-guard', (err as Error).message, 500, false);
  }

  // 4. 写 + commit + push（R1：幂等路径跳过写——existing 原样字节不变 → 无 commit → 纯重推）
  try {
    if (!reused) {
      await writeBundleAtomic(targetPath, bundle);
    }
  } catch (err) {
    return fail('bundle-write-failed', `bundle 原子写失败：${(err as Error).message}`, 500, true);
  }
  let rePushedOnly = false;
  try {
    ({ rePushedOnly } = await commitAndPush(deps, projectEntry.mainCheckoutPath, bundle));
  } catch (err) {
    if (err instanceof DimError) {
      // push/commit 失败 → sync-pending 挂起（链态留 sync，sync/run 可重跑）
      try {
        await deps.chain.updateSync({ status: 'failed', bundleId: bundle.bundleId });
      } catch (chainErr) {
        console.warn(`[trilc:init-sync] chain snapshot failed: ${(chainErr as Error).message}`);
      }
      return fail(err.classification, err.message, err.status, err.retryable);
    }
    throw err;
  }

  // 5. 成功路径：快照 pushed + transitionTo('confirm')（D1）+ 事件族
  const dimsOut = {} as Record<DimKey, 'synced' | 'unavailable'>;
  for (const dim of Object.keys(dims) as DimKey[]) {
    dimsOut[dim] = isDimUnavailable(dims[dim]) ? 'unavailable' : 'synced';
  }
  const syncedFrame = await deps.chain.updateSync({ status: 'pushed', bundleId: bundle.bundleId });
  await deps.chain.transitionTo('confirm', entry);
  deps.publish({
    type: 'init:sync-finished',
    runId,
    bundleId: bundle.bundleId,
    generatedAt: bundle.generatedAt,
    chainState: 'confirm',
    phaseDetail: syncedFrame.phaseDetail.sync,
    dims: dimsOut,
    rePushedOnly,
  });
  deps.publish({
    type: 'init:step-event',
    phase: 'sync',
    step: 'pushed',
    entry,
    payload: { runId, bundleId: bundle.bundleId, rePushedOnly },
  });
  return {
    status: 200,
    runId,
    bundleId: bundle.bundleId,
    generatedAt: bundle.generatedAt,
    chainState: 'confirm',
    dims: dimsOut,
    rePushedOnly,
  };
}

// ── sync/status 辅助端点（§二.4：remote 拉取超时 3s 降级 null）──

export async function getSyncStatus(deps: InitSyncDeps): Promise<SyncStatusPayload> {
  const chainFrame = await deps.chain.load();
  let localBundleId: string | null = null;
  let localBundleGeneratedAt: string | null = null;
  try {
    const frame = await deps.registry.load();
    const projectKey = frame.activeProjectKey;
    const mainPath = projectKey ? frame.projects[projectKey]?.mainCheckoutPath : null;
    if (mainPath) {
      const existing = await readExistingBundle(bundleTargetPath(mainPath));
      if (existing) {
        localBundleId = existing.bundleId;
        localBundleGeneratedAt = existing.generatedAt;
      }
    }
  } catch {
    // 本地 bundle 读取失败不阻塞 status（remote 事实仍可呈现）
  }
  const remote = await fetchRemoteSyncStatus(deps);
  return {
    chainState: chainFrame.chainState,
    phaseDetail: chainFrame.phaseDetail.sync,
    localBundleId,
    localBundleGeneratedAt,
    remote,
  };
}

/**
 * 拉取 TriMMC config/sync/status（超时 3s 降级 null，§6.8）。
 * 导出供 init-confirm.ts（Phase D check 的服务器侧事实源）复用。
 */
export async function fetchRemoteSyncStatus(deps: InitSyncDeps): Promise<SyncStatusRemote | null> {
  const timeoutMs = deps.timeoutMs ?? 3000;
  try {
    const res = await fetch(`${deps.trimcBaseUrl}/internal/v1/config/sync/status`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      ok?: boolean;
      applied?: { bundleId?: string; generatedAt?: string } | null;
      fleetHead?: { branch: string; commit: string } | null;
      dims?: Record<string, string> | null;
      project?: BundleProject | null;
    };
    if (!body.ok) return null;
    return {
      reachable: true,
      appliedBundleId: body.applied?.bundleId ?? null,
      appliedGeneratedAt: body.applied?.generatedAt ?? null,
      fleetHead: body.fleetHead ?? null,
      dims: body.dims ?? null,
      project: body.project ?? null,
    };
  } catch {
    return null; // 不可达降级（§6.8）
  }
}

// ── daemon 重启 re-sync 检查（§6.6 尾部：只读 no-op）──

/**
 * 启动时 chainState ∈ {sync, confirm} → 读本地 bundle + 调一次 sync/status
 * （远程不可达静默）。本地文件存在且 status 已 applied 同 bundleId = no-op；
 * 无本地文件且链态=sync = 面板「待补」提示（正常断点态）。
 * 不自动 push、不自动生成（启动期零写面）。
 */
export async function runStartupResyncCheck(deps: InitSyncDeps): Promise<void> {
  try {
    const chainFrame = await deps.chain.load();
    const state = chainFrame.chainState;
    if (state !== 'sync' && state !== 'confirm') return;
    let localBundleId: string | null = null;
    try {
      const frame = await deps.registry.load();
      const projectKey = frame.activeProjectKey;
      const mainPath = projectKey ? frame.projects[projectKey]?.mainCheckoutPath : null;
      if (mainPath) {
        const existing = await readExistingBundle(bundleTargetPath(mainPath));
        localBundleId = existing?.bundleId ?? null;
      }
    } catch {
      /* 注册点/本地文件缺失 → 按无本地文件处理 */
    }
    if (!localBundleId) {
      if (state === 'sync') {
        console.log('[trilc:init-sync] daemon restart: chainState=sync but no local bundle — 面板「待补」提示（正常断点态，可 sync/run 重跑）');
      } else {
        console.log('[trilc:init-sync] daemon restart: chainState=confirm but no local bundle — 待 sync/status 轮询确认');
      }
      return;
    }
    const remote = await fetchRemoteSyncStatus(deps);
    if (!remote) return; // 远程不可达静默
    if (remote.appliedBundleId === localBundleId) {
      console.log(`[trilc:init-sync] daemon restart: local bundle ${localBundleId} already applied on server — no-op`);
    } else {
      console.log(
        `[trilc:init-sync] daemon restart: local bundle ${localBundleId} pushed, server applied=${remote.appliedBundleId ?? 'null'}（fleet apply 每 15min 收敛）`,
      );
    }
  } catch (err) {
    console.warn('[trilc:init-sync] startup resync check failed (read-only):', (err as Error).message);
  }
}
