// ── TriCompany Init Confirm 执行体（I4 Phase D：L1-L4 协同确认）──
// init-collab-i4-five-dim-sync i4-1 拆解 §六（契约类型冻结于 sync-bundle.ts）：
//
//   GET /internal/v1/init/confirm/check（按需计算，无后台常驻轮询）：
//   - L1 注册同一性：project-registry activeProjectKey/repoUrl/worktrees[] ↔
//     bundle.project ↔ TriMMC status.project 三面比对；路径用短指纹呈现
//     （SHA-256(worktreePath).slice(0,8)，§7.2 防截断）；不匹配 = ERROR
//     （错误仓/错误分支）。
//   - L2 版本一致：本地 dev HEAD == bundle.project.devHead ==
//     status.fleetHead.commit；三值相等 PASS，不等 = 落后/领先诊断（ff 收敛
//     提示，由渲染层根据三值推导）。
//   - L3 写读闭环：status.applied.bundleId == 本地 bundle 文件 bundleId
//     （sync commit 即探针）；未 applied = 「未就绪」+ 重试提示。
//   - L4 反向闭环：由首个协同工作承载（周平面平移，I5 树）——
//     { status: 'pending', note: '由首个协同工作承载' }。
//   - 降级口径（§7.2.3）：TriMMC HTTP 不可达 → L2 服务器侧事实退化（本地
//     push 成功 + 裸仓 reflog 人工口径），MVP 接受——remote: null +
//     degraded: true；L2 双值比较（本地 == bundle）。
//
//   POST /internal/v1/init/confirm：用户一次确认（两入口同载荷 { entry }）
//   → 服务端重算 check → readyForConfirm 门禁（否则 409 附 check 结果）→
//   phaseDetail.confirm.status='confirmed' + l1/l2/l3 快照 →
//   transitionTo('ready') → init:step-event 发布。
//
// 协同开启成功 = 三元素一致 + 一次确认（§2.8 验收口径）。

import type { InitSyncDeps } from './init-sync.js';
import {
  bundleTargetPath,
  fetchRemoteSyncStatus,
  readExistingBundle,
} from './init-sync.js';
import {
  computePathFingerprint,
  isDimUnavailable,
  type BundleProject,
  type ConfirmCheckL1,
  type ConfirmCheckPayload,
  type ConfirmCheckStatus,
  type ConfirmResult,
} from './sync-bundle.js';
import type { SyncEntry } from './init-sync.js';
import type { GitRunner } from '../project/project-link.js';

// ── 本地三面数据收集 ──

interface LocalConfirmFacts {
  activeProjectKey: string | null;
  repoUrl: string | null;
  worktreePaths: string[];
  mainCheckoutPath: string | null;
  localHead: string | null;
  bundle: ReturnType<typeof readExistingBundle> extends Promise<infer T> ? T : never;
}

async function collectLocalFacts(deps: InitSyncDeps): Promise<LocalConfirmFacts> {
  const frame = await deps.registry.load();
  const activeProjectKey = frame.activeProjectKey;
  const projectEntry = activeProjectKey ? frame.projects[activeProjectKey] : null;
  const mainCheckoutPath = projectEntry?.mainCheckoutPath ?? null;
  const git: GitRunner = deps.git ?? (await import('../project/project-link.js')).createGitRunner();

  let localHead: string | null = null;
  if (mainCheckoutPath) {
    const headRes = await git(['-C', mainCheckoutPath, 'rev-parse', 'HEAD']);
    if (headRes.code === 0 && headRes.stdout.trim()) localHead = headRes.stdout.trim();
  }
  const bundle = mainCheckoutPath ? await readExistingBundle(bundleTargetPath(mainCheckoutPath)) : null;
  return {
    activeProjectKey,
    repoUrl: projectEntry?.repoUrl ?? null,
    worktreePaths: (projectEntry?.worktrees ?? []).map((wt) => wt.path),
    mainCheckoutPath,
    localHead,
    bundle,
  };
}

// ── L1 三面比对 ──

/** 路径集合短指纹（排序拼接，§7.2 防截断呈现）。 */
function fingerprintPaths(paths: string[]): string {
  return [...paths].sort().map((p) => computePathFingerprint(p)).join(',');
}

/**
 * L1 元素级语义（i4-4 修正记录 ②，OBS-6a）：
 * - repoUrl/projectKey：维持非空 + 三方等值要求（完备性 + 一致性）；
 * - worktreePath：三方等值即 ok（含空集）——L1 职责 = 一致性判定，非完备性
 *   判定（注册完备性归 I3 门禁）；空集由确认卡给「worktree 清单为空」提示
 *   注记（非阻塞）。
 */
function compareL1Value(
  element: 'repoUrl' | 'projectKey' | 'worktreePath',
  local: string | null,
  bundle: string | null,
  server: string | null,
): ConfirmCheckL1['items'][number] {
  const localStr = local ?? '';
  const bundleStr = bundle ?? '';
  const serverStr = server ?? '';
  const allEqual = localStr === bundleStr && bundleStr === serverStr;
  const ok = element === 'worktreePath' ? allEqual : !!localStr && allEqual;
  return {
    element,
    status: ok ? 'ok' : 'error',
    local: localStr,
    bundle: bundleStr,
    server: serverStr,
  };
}

function computeL1(
  facts: LocalConfirmFacts,
  bundleProject: BundleProject | null,
  serverProject: BundleProject | null,
): ConfirmCheckL1 {
  const items: ConfirmCheckL1['items'] = [
    compareL1Value('repoUrl', facts.repoUrl, bundleProject?.repoUrl ?? null, serverProject?.repoUrl ?? null),
    compareL1Value('projectKey', facts.activeProjectKey, bundleProject?.projectKey ?? null, serverProject?.projectKey ?? null),
    compareL1Value(
      'worktreePath',
      fingerprintPaths(facts.worktreePaths),
      bundleProject ? fingerprintPaths(bundleProject.worktrees.map((wt) => wt.path)) : null,
      serverProject ? fingerprintPaths(serverProject.worktrees.map((wt) => wt.path)) : null,
    ),
  ];
  return { ok: items.every((i) => i.status === 'ok'), items };
}

// ── L2 同线收敛判定（i4-4 修正记录 ②：废止严格三值相等——bundle.devHead
// 是生成时值〔必为自身 commit 的 parent〕、fleetHead 是实时值〔15min 持续
// pull 前进〕，严格相等数学不可达。改「同 dev 线（ff 收敛可达）」语义）──

/**
 * git merge-base --is-ancestor 判定。
 * 返回 true（a 是 b 祖先）/ false（可解析但非祖先）/ null（不可解析——
 * 对象不在本地仓，如未拉取的 fleetHead）。
 */
async function isAncestor(
  git: GitRunner,
  cwd: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  const res = await git(['-C', cwd, 'merge-base', '--is-ancestor', ancestor, descendant]);
  if (res.code === 0) return true;
  if (res.code === 1) return false;
  return null;
}

async function computeL2(
  deps: InitSyncDeps,
  facts: LocalConfirmFacts,
  bundleProject: BundleProject | null,
  fleetHeadCommit: string | null,
  degraded: boolean,
): Promise<ConfirmCheckPayload['l2']> {
  const localHead = facts.localHead ?? '';
  const bundleHead = bundleProject?.devHead ?? '';
  const fleetHead = fleetHeadCommit ?? '';
  const cwd = facts.mainCheckoutPath ?? '';
  const git: GitRunner = deps.git ?? (await import('../project/project-link.js')).createGitRunner();

  // bundleHead 必须为 localHead 的祖先或相等（本地可判定；空 bundleHead → 红）
  let bundleAncestor: boolean | null = null;
  if (!bundleHead) {
    bundleAncestor = false;
  } else if (bundleHead === localHead) {
    bundleAncestor = true;
  } else if (localHead && cwd) {
    bundleAncestor = await isAncestor(git, cwd, bundleHead, localHead);
  }
  const bundleOk = bundleAncestor === true;

  // 降级口径（remote null）：bundleHead 祖先/相等即绿（废止原 local==bundle 双值比较）
  if (degraded) {
    return { ok: bundleOk, localHead, bundleHead, fleetHead, bundleAncestor: !!bundleAncestor };
  }

  if (!bundleOk) {
    return { ok: false, localHead, bundleHead, fleetHead, bundleAncestor: !!bundleAncestor };
  }

  // fleet 同线判定：等值或互为祖先（一方为另一方祖先 = 同线可 ff 收敛 → 绿，
  // 落后/领先仅提示不阻断；均不可达 = 分叉 → 红勿确认；fleetHead 本地不可
  // 解析 = 未拉取 → 红 + 先 pull 诊断）
  if (!fleetHead) {
    return { ok: false, localHead, bundleHead, fleetHead, bundleAncestor: true };
  }
  if (fleetHead === localHead) {
    return { ok: true, localHead, bundleHead, fleetHead, bundleAncestor: true };
  }
  if (cwd) {
    const localToFleet = await isAncestor(git, cwd, localHead, fleetHead);
    if (localToFleet === true) {
      // local 是 fleet 祖先（fleet 领先，本地落后）→ 同线绿 + 提示
      return { ok: true, localHead, bundleHead, fleetHead, bundleAncestor: true };
    }
    if (localToFleet === false) {
      const fleetToLocal = await isAncestor(git, cwd, fleetHead, localHead);
      if (fleetToLocal === true) {
        // fleet 是 local 祖先（fleet 落后，随 15min pull 收敛）→ 同线绿 + 提示
        return { ok: true, localHead, bundleHead, fleetHead, bundleAncestor: true };
      }
      if (fleetToLocal === false) {
        // 双方可解析但互非祖先 → 分叉 → 红勿确认
        return { ok: false, localHead, bundleHead, fleetHead, bundleAncestor: true };
      }
    }
  }
  // fleetHead 本地不可解析（未拉取）或 localHead 缺失 → 红 + 先 pull
  return { ok: false, localHead, bundleHead, fleetHead, bundleAncestor: true };
}

// ── check 计算（GET confirm/check 数据源；POST confirm 服务端重算同源）──

export async function runConfirmCheck(deps: InitSyncDeps): Promise<ConfirmCheckPayload> {
  const chainFrame = await deps.chain.load();
  const facts = await collectLocalFacts(deps);
  const remote = await fetchRemoteSyncStatus(deps);
  const degraded = remote === null;

  const bundleProject =
    facts.bundle && !isDimUnavailable(facts.bundle.project) ? facts.bundle.project : null;
  const serverProject = remote?.project ?? null;
  const appliedBundleId = remote?.appliedBundleId ?? null;

  const l1 = computeL1(facts, bundleProject, serverProject);
  const l2 = await computeL2(deps, facts, bundleProject, remote?.fleetHead?.commit ?? null, degraded);
  const l3 = {
    ok: !!appliedBundleId && !!facts.bundle && appliedBundleId === facts.bundle.bundleId,
    appliedBundleId,
    localBundleId: facts.bundle?.bundleId ?? null,
  };
  const l4 = { status: 'pending' as const, note: '由首个协同工作承载' as const };

  return {
    chainState: chainFrame.chainState,
    l1,
    l2,
    l3,
    l4,
    readyForConfirm: l1.ok && l2.ok && l3.ok,
    remote: degraded ? null : 'ok',
    degraded,
  };
}

// ── POST confirm 执行体 ──

let _confirming = false;

/** 测试复位。 */
export function resetConfirmForTest(): void {
  _confirming = false;
}

export async function runConfirm(deps: InitSyncDeps, entry: SyncEntry): Promise<ConfirmResult> {
  if (_confirming) return { status: 409, busy: true, runId: 'confirm' };
  _confirming = true;
  try {
    // 链态门：仅 confirm 生效
    const chainFrame = await deps.chain.load();
    if (chainFrame.chainState !== 'confirm') {
      return { status: 409, chainState: chainFrame.chainState };
    }
    // 服务端重算 check（与 GET check 同源）
    const check = await runConfirmCheck(deps);
    if (!check.readyForConfirm) {
      return { status: 409, notReady: true, check };
    }
    // 快照 + ready 转移 + 事件（协同开启成功 = 三元素一致 + 一次确认）
    const confirmedFrame = await deps.chain.updateConfirm({
      status: 'confirmed',
      l1: check.l1.ok ? 'ok' : `error:${check.l1.items.filter((i) => i.status !== 'ok').map((i) => i.element).join(',')}`,
      l2: check.l2.ok ? 'ok' : check.degraded ? 'degraded' : 'mismatch',
      l3: check.l3.ok ? 'applied' : 'pending',
    });
    await deps.chain.transitionTo('ready', entry);
    deps.publish({
      type: 'init:step-event',
      phase: 'confirm',
      step: 'confirmed',
      entry,
      payload: { check, phaseDetail: confirmedFrame.phaseDetail.confirm },
    });
    return { status: 200, chainState: 'ready', confirmed: true, check };
  } finally {
    _confirming = false;
  }
}
