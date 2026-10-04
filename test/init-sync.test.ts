// ── Init Sync 执行体单测（i4-2 Phase C #12 后半）──
// 五维收集矩阵（逐维缺失降级）、链态门 409、防重入 409、公司态硬错误、
// 项目未链硬错误、幂等重跑（同内容不重新生成）/ 内容变化新 bundleId、
// push 失败分类 + sync-pending 挂起、事件序、指纹不出材料、
// 序列化无 sk- 断言、sync/status remote 拉取降级、启动 re-sync 只读。
// 注入：临时目录 + scripted git runner + 假 key-cache/models（无真实网络）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { InitChain } from '../src/company/init-chain.js';
import { CompanyInitState } from '../src/company/init-state.js';
import { ProjectRegistry } from '../src/project/project-registry.js';
import type { GitExecResult, GitRunner } from '../src/project/project-link.js';
import type { KeyCache } from '../src/config/key-cache.js';
import type { LocalBusEvent } from '../src/localbus/bus.js';
import {
  bundleTargetPath,
  getSyncStatus,
  resetSyncForTest,
  runInitSync,
  runStartupResyncCheck,
  type InitSyncDeps,
} from '../src/company/init-sync.js';
import { computeKeyFingerprint, type SyncBundle } from '../src/company/sync-bundle.js';

// ── scripted git（按调用序出队；队空 = 成功空输出）──

interface ScriptedGit {
  git: GitRunner;
  calls: string[][];
}

function scriptedGit(...responses: GitExecResult[]): ScriptedGit {
  const queue = [...responses];
  const calls: string[][] = [];
  const git: GitRunner = async (args) => {
    calls.push(args);
    return queue.shift() ?? { code: 0, stdout: '', stderr: '' };
  };
  return { git, calls };
}

// ── fixture 面 ──

const KEY_MATERIAL = 'sk-live-key-material-1234567890';

function fakeKeyCache(): KeyCache {
  // fetchedAt/expiresAt 冻结固定值：幂等重跑判定依赖五维语义不变（Date.now 会漂移）
  return {
    keys: {
      deepseek: { api_key: KEY_MATERIAL, base_url: 'http://127.0.0.1:3333/v1' },
      openai: { api_key: '' },
    },
    defaultModel: 'tmv-deepseek-v4-pro',
    refreshIntervalS: 900,
    fetchedAt: 1_755_166_340_000,
    expiresAt: 1_755_252_740_000,
  };
}

let tmpRoot: string;
let dataDir: string;
let registryPath: string;
let mainPath: string;
let triCompanyPath: string;
let events: LocalBusEvent[] = [];
let chain: InitChain;
let companyState: CompanyInitState;
let registry: ProjectRegistry;

const EMPTY_GIT = (): GitExecResult => ({ code: 0, stdout: '', stderr: '' });

/** 全成功路径 git 序列：employees HEAD + project HEAD + add + diff(1) + commit + push×2。 */
function successGitSequence(devHead = 'd3adbeefd3adbeefd3adbeefd3adbeefd3adbeef'): GitExecResult[] {
  return [
    { code: 0, stdout: 'c0ffee01c0ffee01c0ffee01c0ffee01c0ffee01\n', stderr: '' }, // employees rev-parse
    { code: 0, stdout: `${devHead}\n`, stderr: '' }, // project rev-parse
    EMPTY_GIT(), // add
    { code: 1, stdout: '', stderr: '' }, // diff --cached --quiet → 有变更
    EMPTY_GIT(), // commit
    EMPTY_GIT(), // push origin
    EMPTY_GIT(), // push sg-server
  ];
}

async function writeCompanyInitialized(): Promise<void> {
  await companyState.save({
    state: 'initialized',
    companyName: 'TriCompany',
    ceoName: 'MoRen',
    employees: [{ role: 'chief-technology-officer', name: '小狄' }],
    onboardedAt: '2026-08-14T09:00:00.000Z',
  });
}

async function writeRegistryFrame(activeProjectKey: string | null, mainCheckoutPath: string | null): Promise<void> {
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      activeProjectKey,
      projects: {
        trimetaverse: {
          repoUrl: 'https://github.com/MoRen9527/TriMetaverse.git',
          hasNpmFileDeps: false,
          defaultBranch: 'dev',
          mainCheckoutPath,
          worktrees: [],
        },
      },
    }, null, 2),
    'utf-8',
  );
}

async function chainTo(state: 'uninitialized' | 'selfcheck' | 'onboarding' | 'project-link' | 'sync' | 'confirm' | 'ready'): Promise<void> {
  const order = ['uninitialized', 'selfcheck', 'onboarding', 'project-link', 'sync', 'confirm', 'ready'] as const;
  await chain.load();
  for (const s of order) {
    if (chain.getState() === state) return;
    if (s === 'uninitialized') continue;
    await chain.transitionTo(s, 'daemon');
  }
}

function buildDeps(git: GitRunner, overrides?: Partial<InitSyncDeps>): InitSyncDeps {
  return {
    dataDir,
    chain,
    companyState,
    registry,
    publish: (e) => events.push(e),
    trimcBaseUrl: 'http://127.0.0.1:9', // 不可达（remote 降级 null）
    trilcVersion: '0.9.0',
    nodeId: 'test-node',
    tricompanySourcePath: triCompanyPath,
    git,
    getKeyCache: () => fakeKeyCache(),
    fetchModels: async () => [{ id: 'tmv-deepseek-v4-pro' }, { id: 'tmv-deepseek-v4-flash' }],
    getRoleCatalog: () => ({ roles: [{ roleId: 'chief-technology-officer' }] }),
    timeoutMs: 300,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trilc-init-sync-'));
  dataDir = path.join(tmpRoot, 'data');
  registryPath = path.join(tmpRoot, 'project-registry.json');
  mainPath = path.join(tmpRoot, 'main-checkout');
  triCompanyPath = path.join(tmpRoot, 'TriCompany');
  await fs.mkdir(path.join(mainPath, 'docs', 'registry', 'init-sync'), { recursive: true });
  await fs.mkdir(triCompanyPath, { recursive: true });
  process.env.TRILC_PROJECT_REGISTRY = registryPath;
  events = [];
  chain = new InitChain(dataDir, { onEvent: (e) => events.push(e) });
  companyState = new CompanyInitState(dataDir);
  registry = new ProjectRegistry({ registryPath });
  resetSyncForTest();
});

afterEach(() => {
  delete process.env.TRILC_PROJECT_REGISTRY;
  resetSyncForTest();
});

describe('init-sync 链态门与硬错误', () => {
  it('非 project-link/sync 链态 → 409 { chainState }', async () => {
    const deps = buildDeps(scriptedGit().git);
    const result = await runInitSync(deps, 'daemon');
    assert.deepEqual(result, { status: 409, chainState: 'uninitialized' });
  });

  it('project-link 未 linked → 422 project-link-not-linked', async () => {
    await chainTo('project-link');
    const deps = buildDeps(scriptedGit().git);
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 422);
    if (result.status === 422) assert.equal(result.classification, 'project-link-not-linked');
  });

  it('公司态未开张 → 400 company-not-initialized（硬错误）', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeRegistryFrame('trimetaverse', mainPath);
    const deps = buildDeps(scriptedGit().git);
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 400);
    if (result.status === 400) assert.equal(result.classification, 'company-not-initialized');
    // 链态留 sync（gate 内先转移）——公司态硬错误不写快照
    assert.equal(chain.getState(), 'sync');
  });

  it('注册点无焦点项目 → 400 project-not-linked', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame(null, null);
    const deps = buildDeps(scriptedGit().git);
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 400);
    if (result.status === 400) assert.equal(result.classification, 'project-not-linked');
  });

  it('防重入：运行中再触发 → 409 busy', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    // 完整成功序列，但第一个 git 调用被 gate 挂起（模拟在途执行）
    const inner = scriptedGit(...successGitSequence());
    let releaseFirst: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCall = true;
    const gatedGit: GitRunner = async (args) => {
      if (firstCall) {
        firstCall = false;
        await gate;
      }
      return inner.git(args);
    };
    const deps = buildDeps(gatedGit);
    const first = runInitSync(deps, 'daemon');
    await new Promise((r) => setTimeout(r, 30)); // 让第一次跑到挂起点（在途）
    const second = await runInitSync(deps, 'daemon');
    assert.equal(second.status, 409);
    if (second.status === 409 && 'busy' in second) assert.equal(second.busy, true);
    releaseFirst?.();
    const firstResult = await first;
    assert.equal(firstResult.status, 200);
  });
});

describe('init-sync 五维收集与单维降级', () => {
  it('全维收集成功：生成/写/commit/push → 快照 pushed + 转 confirm + 事件序', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const scripted = scriptedGit(...successGitSequence());
    const deps = buildDeps(scripted.git);
    const result = await runInitSync(deps, 'tripilot');
    assert.equal(result.status, 200);
    if (result.status === 200) {
      assert.equal(result.chainState, 'confirm');
      assert.deepEqual(result.dims, { company: 'synced', model: 'synced', keys: 'synced', employees: 'synced', project: 'synced' });
      assert.equal(result.rePushedOnly, false);
    }
    // 链态 + 快照
    assert.equal(chain.getState(), 'confirm');
    const snap = chain.getSnapshot().phaseDetail.sync;
    assert.equal(snap.status, 'pushed');
    assert.ok(snap.bundleId);
    // 事件序：started → progress（5 维 collecting+终态）→ finished → step-event
    const types = events.map((e) => e.type);
    assert.ok(types.includes('init:sync-started'));
    assert.equal(events.filter((e) => e.type === 'init:sync-progress').length, 10);
    assert.ok(types.includes('init:sync-finished'));
    assert.ok(types.includes('init:chain-changed'));
    const step = events.find((e) => e.type === 'init:step-event') as { step: string } | undefined;
    assert.equal(step?.step, 'pushed');
    // git 固定身份 D2
    const commitCall = scripted.calls.find((c) => c.includes('commit'));
    assert.ok(commitCall);
    assert.ok(commitCall.includes('user.name=TriLC Init Sync'));
    assert.ok(commitCall.includes('user.email=trilc@tri.company'));
    // 双远端 push
    const pushes = scripted.calls.filter((c) => c.includes('push'));
    assert.equal(pushes.length, 2);
    assert.deepEqual(pushes.map((p) => p.slice(-2)), [['origin', 'dev'], ['sg-server', 'dev']]);
    // 域隔离：只 add init-sync 路径
    const addCall = scripted.calls.find((c) => c.includes('add'));
    assert.deepEqual(addCall, ['-C', mainPath, 'add', 'docs/registry/init-sync/sync-config.json']);
  });

  it('密钥纪律：序列化无 sk- 明文、无 api_key 字段，指纹=sha256(材料).slice(0,8)', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const scripted = scriptedGit(...successGitSequence());
    const deps = buildDeps(scripted.git);
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 200);
    const raw = await fs.readFile(bundleTargetPath(mainPath), 'utf-8');
    assert.ok(!raw.includes('sk-live-key-material'));
    assert.ok(!raw.includes('"api_key"'));
    assert.ok(!raw.includes('"apiKey"'));
    assert.ok(raw.includes(computeKeyFingerprint(KEY_MATERIAL)));
    const bundle = JSON.parse(raw) as SyncBundle;
    assert.equal(bundle.keys.providers[0].fingerprint, computeKeyFingerprint(KEY_MATERIAL));
    assert.equal(bundle.keys.providers[1].ready, false); // 逐 provider 降级（空 api_key）
    assert.equal(bundle.employees.sourceCommit, 'c0ffee01c0ffee01c0ffee01c0ffee01c0ffee01');
    assert.equal(bundle.project.devHead, 'd3adbeefd3adbeefd3adbeefd3adbeefd3adbeef');
    assert.equal(bundle.generatedBy.startsWith('trilc-init-0.9.0@'), true);
  });

  it('model 不可达 + key-cache 空 → model/keys 维降级不阻塞全链', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const scripted = scriptedGit(...successGitSequence());
    const deps = buildDeps(scripted.git, {
      getKeyCache: () => null,
      fetchModels: async () => {
        throw new Error('TriModel down');
      },
    });
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 200);
    if (result.status === 200) {
      assert.equal(result.dims.model, 'unavailable');
      assert.equal(result.dims.keys, 'unavailable');
      assert.equal(result.dims.company, 'synced');
    }
  });

  it('employees TriCompany HEAD 读取失败 → employees 维降级', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const scripted = scriptedGit(
      { code: 1, stdout: '', stderr: 'not a git repo' }, // employees rev-parse 失败
      ...successGitSequence().slice(1),
    );
    const deps = buildDeps(scripted.git);
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 200);
    if (result.status === 200) assert.equal(result.dims.employees, 'unavailable');
  });

  it('project dev HEAD 读取失败 → 422 project-dev-head-failed', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const scripted = scriptedGit(
      { code: 0, stdout: 'c0ffee01c0ffee01c0ffee01c0ffee01c0ffee01\n', stderr: '' },
      { code: 1, stdout: '', stderr: 'no git' },
    );
    const deps = buildDeps(scripted.git);
    const result = await runInitSync(deps, 'daemon');
    assert.equal(result.status, 422);
    if (result.status === 422) assert.equal(result.classification, 'project-dev-head-failed');
  });
});

describe('init-sync 幂等重跑与 push 失败分类', () => {
  it('push 失败 → 500 push-failed + sync-pending 挂起（链态留 sync）；重跑同内容 = 纯重推不重新生成', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    // 第一次：push origin 失败
    const first = scriptedGit(
      ...successGitSequence().slice(0, 5),
      { code: 128, stdout: '', stderr: 'network unreachable' },
    );
    const deps = buildDeps(first.git);
    const r1 = await runInitSync(deps, 'daemon');
    assert.equal(r1.status, 500);
    if (r1.status === 500) {
      assert.equal(r1.classification, 'push-failed');
      assert.equal(r1.retryable, true);
    }
    assert.equal(chain.getState(), 'sync'); // 挂起留 sync
    assert.equal(chain.getSnapshot().phaseDetail.sync.status, 'failed');
    const bundleAfterFail = JSON.parse(await fs.readFile(bundleTargetPath(mainPath), 'utf-8')) as SyncBundle;
    const failedEvents = events.filter((e) => e.type === 'init:sync-failed');
    assert.equal(failedEvents.length, 1);

    // 重跑：同内容 → 同 bundleId（不重新生成）+ 纯重推
    const second = scriptedGit(
      { code: 0, stdout: 'c0ffee01c0ffee01c0ffee01c0ffee01c0ffee01\n', stderr: '' },
      { code: 0, stdout: 'd3adbeefd3adbeefd3adbeefd3adbeefd3adbeef\n', stderr: '' },
      EMPTY_GIT(), // add
      { code: 0, stdout: '', stderr: '' }, // diff --quiet → 无变更（内容同）
      EMPTY_GIT(), // push origin
      EMPTY_GIT(), // push sg-server
    );
    const deps2 = buildDeps(second.git);
    const r2 = await runInitSync(deps2, 'daemon');
    assert.equal(r2.status, 200);
    if (r2.status === 200) {
      assert.equal(r2.rePushedOnly, true);
      assert.equal(r2.bundleId, bundleAfterFail.bundleId); // 幂等：不换 bundleId
    }
    assert.equal(chain.getState(), 'confirm');
  });

  it('内容变化重跑 → 新 bundleId + generatedAt 严格递增（模型目录变化）', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const first = scriptedGit(
      ...successGitSequence().slice(0, 5),
      { code: 128, stdout: '', stderr: 'network down' },
    );
    const deps = buildDeps(first.git);
    await runInitSync(deps, 'daemon');
    const b1 = JSON.parse(await fs.readFile(bundleTargetPath(mainPath), 'utf-8')) as SyncBundle;

    // 真实内容变化：模型目录新增条目（非 devHead——R1 口径 devHead 自引用排除）
    const second = scriptedGit(...successGitSequence());
    const deps2 = buildDeps(second.git, {
      fetchModels: async () => [{ id: 'tmv-deepseek-v4-pro' }, { id: 'tmv-deepseek-reasoner' }],
    });
    const r2 = await runInitSync(deps2, 'daemon');
    assert.equal(r2.status, 200);
    const b2 = JSON.parse(await fs.readFile(bundleTargetPath(mainPath), 'utf-8')) as SyncBundle;
    if (r2.status === 200) assert.notEqual(r2.bundleId, b1.bundleId);
    assert.ok(Date.parse(b2.generatedAt) > Date.parse(b1.generatedAt));
  });

  it('R1 幂等矩阵：仅 devHead 变化的重跑 → 不换 bundleId + 不 commit + 纯重推', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const first = scriptedGit(
      ...successGitSequence().slice(0, 5),
      { code: 128, stdout: '', stderr: 'network down' },
    );
    const deps = buildDeps(first.git);
    const r1 = await runInitSync(deps, 'daemon');
    assert.equal(r1.status, 500);
    const b1 = JSON.parse(await fs.readFile(bundleTargetPath(mainPath), 'utf-8')) as SyncBundle;
    const bytesAfterFail = await fs.readFile(bundleTargetPath(mainPath), 'utf-8');

    // 重跑：devHead 变化（自引用推进）但五维真实内容未变 → 幂等复用 existing
    // 原样（跳过写 → 字节不变 → diff --quiet=0 → 无 commit → 纯重推）
    const second = scriptedGit(
      { code: 0, stdout: 'c0ffee01c0ffee01c0ffee01c0ffee01c0ffee01\n', stderr: '' }, // employees HEAD
      { code: 0, stdout: 'ffffffffffffffffffffffffffffffffffffffff\n', stderr: '' }, // devHead 变化
      EMPTY_GIT(), // add
      { code: 0, stdout: '', stderr: '' }, // diff --cached --quiet → 无变更（未写新 devHead）
      EMPTY_GIT(), // push origin
      EMPTY_GIT(), // push sg-server
    );
    const deps2 = buildDeps(second.git);
    const r2 = await runInitSync(deps2, 'daemon');
    assert.equal(r2.status, 200);
    if (r2.status === 200) {
      assert.equal(r2.rePushedOnly, true);
      assert.equal(r2.bundleId, b1.bundleId); // 幂等：不换 bundleId
    }
    // 字节不变（existing 原样返回，不覆盖 devHead）
    const bytesAfterRerun = await fs.readFile(bundleTargetPath(mainPath), 'utf-8');
    assert.equal(bytesAfterRerun, bytesAfterFail);
    const b2 = JSON.parse(bytesAfterRerun) as SyncBundle;
    assert.equal(b2.project.devHead, 'd3adbeefd3adbeefd3adbeefd3adbeefd3adbeef'); // 保留生成时值
    // 无 commit 调用（git 序列只有 add/diff/push，无 commit）
    assert.ok(!second.calls.some((c) => c.includes('commit')));
    assert.equal(chain.getState(), 'confirm');
  });

  it('成功后再触发 → 409 { chainState: confirm }', async () => {
    await chainTo('project-link');
    await chain.updateProjectLink({ status: 'linked', source: 'local', projectKey: 'trimetaverse', worktreePath: mainPath });
    await writeCompanyInitialized();
    await writeRegistryFrame('trimetaverse', mainPath);
    const deps = buildDeps(scriptedGit(...successGitSequence()).git);
    const r1 = await runInitSync(deps, 'daemon');
    assert.equal(r1.status, 200);
    const r2 = await runInitSync(deps, 'daemon');
    assert.deepEqual(r2, { status: 409, chainState: 'confirm' });
  });
});

describe('init-sync status + 启动 re-sync 检查', () => {
  it('remote 可达 → 映射 applied/fleetHead/dims；不可达 → null（降级）', async () => {
    // 本地 HTTP 桩：模拟 TriMMC config/sync/status
    let server: Server | null = null;
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        applied: { bundleId: 'srv-bundle-1', generatedAt: '2026-08-14T10:00:00.000Z', lastAppliedAt: 'x', sourceInstanceId: 'y' },
        fleetHead: { branch: 'dev', commit: 'abababababababababababababababababababab' },
        dims: { company: 'applied', model: 'applied', keys: 'applied', employees: 'applied', project: 'applied' },
        pending: null,
        warnings: [],
      }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const deps = buildDeps(scriptedGit().git, { trimcBaseUrl: `http://127.0.0.1:${port}` });
      const status = await getSyncStatus(deps);
      assert.equal(status.remote?.reachable, true);
      assert.equal(status.remote?.appliedBundleId, 'srv-bundle-1');
      assert.equal(status.remote?.fleetHead?.commit.slice(0, 4), 'abab');
    } finally {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }

    // 不可达 → null
    const depsUnreachable = buildDeps(scriptedGit().git);
    const status2 = await getSyncStatus(depsUnreachable);
    assert.equal(status2.remote, null);
    assert.equal(status2.chainState, 'uninitialized');
  });

  it('本地 bundle 存在 → localBundleId/localBundleGeneratedAt 呈现', async () => {
    await writeRegistryFrame('trimetaverse', mainPath);
    await fs.writeFile(
      bundleTargetPath(mainPath),
      JSON.stringify({
        schemaVersion: 1,
        bundleId: 'local-bundle-1',
        generatedAt: '2026-08-14T10:00:00.000Z',
        generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
        company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: 'x' },
        model: { defaultModel: 'tmv-deepseek-v4-pro', catalog: [], providers: [] },
        keys: { providers: [], refreshIntervalS: 900, fetchedAt: 'x' },
        employees: { roster: [], sourceCommit: 'a'.repeat(40) },
        project: { projectKey: 'trimetaverse', repoUrl: 'https://x', defaultBranch: 'dev', worktrees: [], devHead: 'b'.repeat(40) },
      }),
      'utf-8',
    );
    const deps = buildDeps(scriptedGit().git);
    const status = await getSyncStatus(deps);
    assert.equal(status.localBundleId, 'local-bundle-1');
    assert.equal(status.localBundleGeneratedAt, '2026-08-14T10:00:00.000Z');
  });

  it('启动 re-sync 检查：只读 no-op（链态 sync、无本地文件 → 提示；不写不推不生成）', async () => {
    await chainTo('sync');
    await writeRegistryFrame('trimetaverse', mainPath);
    const scripted = scriptedGit();
    const deps = buildDeps(scripted.git);
    await runStartupResyncCheck(deps);
    assert.equal(scripted.calls.length, 0); // 零 git 调用
    assert.equal(chain.getState(), 'sync'); // 零链态写
    await assert.rejects(fs.readFile(bundleTargetPath(mainPath), 'utf-8')); // 零生成
  });

  it('启动 re-sync 检查：本地 bundle 与远端 applied 同 bundleId → no-op（remote 桩）', async () => {
    await chainTo('sync');
    await writeRegistryFrame('trimetaverse', mainPath);
    await fs.writeFile(
      bundleTargetPath(mainPath),
      JSON.stringify({
        schemaVersion: 1,
        bundleId: 'local-bundle-1',
        generatedAt: '2026-08-14T10:00:00.000Z',
        generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
        company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: 'x' },
        model: { defaultModel: 'tmv-deepseek-v4-pro', catalog: [], providers: [] },
        keys: { providers: [], refreshIntervalS: 900, fetchedAt: 'x' },
        employees: { roster: [], sourceCommit: 'a'.repeat(40) },
        project: { projectKey: 'trimetaverse', repoUrl: 'https://x', defaultBranch: 'dev', worktrees: [], devHead: 'b'.repeat(40) },
      }),
      'utf-8',
    );
    let server: Server | null = null;
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, applied: { bundleId: 'local-bundle-1', generatedAt: 'x', lastAppliedAt: 'x', sourceInstanceId: 'y' }, fleetHead: null, dims: null, pending: null, warnings: [] }));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const deps = buildDeps(scriptedGit().git, { trimcBaseUrl: `http://127.0.0.1:${port}` });
      await runStartupResyncCheck(deps); // 不应抛错（no-op 路径）
    } finally {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });
});
