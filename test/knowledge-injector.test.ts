// ── Knowledge Injector Tests ──
// FADE-ASSESS-003 知识注入消费链路：
//   1. 幂等重入（hash 相同跳过）
//   2. hash 变更重写（按 source_path 替换）
//   3. 项目隔离（multi-project-router + enforceProjectIsolation）
//   4. 注入块正确性（<knowledge-context> 层顺序 + 来源语义标签）
//   5. 消费记录（knowledge_consumption 行）
//   6. dry-run（不写库）
//   7. 增量同步（agentFilter）+ 主路径挂接（session-initializer）
//   8. 内容层接入（批次 3-2）：wiki/inbox 注入、inbox 过滤与字段裁剪、
//      来源标签、schema v2→v3 迁移
//
// Run: npx tsx --test test/knowledge-injector.test.ts

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getKnowledgeDbPath, enforceProjectIsolation } from '@trimetaverse/tricode';
import { createKnowledgeStore, layerDomain } from '@trimetaverse/tricode';
import {
  syncKnowledgeFromSource,
  resolveContentRoot,
  parseInboxRecord,
  shouldInjectInboxRecord,
  serializeInboxContent,
  INBOX_CLOSED_WINDOW_DAYS,
} from '@trimetaverse/tricode';
import {
  buildKnowledgeContextBlock,
  injectKnowledgeContext,
} from '@trimetaverse/tricode';
import { injectHeartbeatKnowledge } from '../src/heartbeat/agent-runner.js';
import {
  recordKnowledgeMetric,
  getKnowledgeMetricSnapshot,
  isEscalationBlockReason,
} from '@trimetaverse/tricode';
import { shouldRunJob } from '../src/cron/timer.js';
import { setRosterGate, setOnSpawnGateDenied, enforceRosterGate } from '../src/tools/agent-tool.js';
import { getContractResolver } from '../src/config/contract-resolver.js';
import { initializeSession } from '../src/company/session-initializer.js';

// ── Helpers ──

async function makeSourceRoot(agents: Array<{ id: string; layers?: Partial<Record<'memory' | 'colleagues' | 'social', string>> }>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'trilc-knowledge-src-'));
  for (const agent of agents) {
    const dir = join(root, agent.id);
    await mkdir(dir, { recursive: true });
    const layers = agent.layers ?? {};
    const defaults: Record<string, string> = {
      memory: `# ${agent.id} memory\n阶段记忆内容`,
      colleagues: `# ${agent.id} colleagues\n协作关系内容`,
      social: `# ${agent.id} social\n社交内容`,
    };
    for (const layer of ['memory', 'colleagues', 'social'] as const) {
      await writeFile(join(dir, `${agent.id}.${layer}.md`), layers[layer] ?? defaults[layer], 'utf-8');
    }
  }
  return root;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// 0. Router：knowledge.db 路径归属隔离目录
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — router path', () => {
  let projectRoot: string;
  before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-proj0-'));
  });
  after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('knowledgeDbPath 落在 {projectRoot}/.tricompany-cognition/ 下', () => {
    const dbPath = getKnowledgeDbPath(projectRoot);
    assert.ok(dbPath.startsWith(join(projectRoot, '.tricompany-cognition')));
    assert.ok(dbPath.endsWith('knowledge.db'));
  });

  it('getKnowledgeDbPath 与 resolveProjectPaths 同源', () => {
    const dbPath = getKnowledgeDbPath(projectRoot);
    // enforceProjectIsolation 对自己的项目路径不抛错（隔离天然覆盖）
    assert.doesNotThrow(() => enforceProjectIsolation(projectRoot, dbPath));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 1-3. 同步：幂等重入 / hash 变更重写 / dry-run / 增量
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — sync', () => {
  let sourceRoot: string;
  let projectRoot: string;
  let dbPath: string;

  before(async () => {
    sourceRoot = await makeSourceRoot([
      { id: 'alpha', layers: { memory: '# alpha memory\nv1 内容' } },
      { id: 'beta' },
    ]);
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-proj1-'));
    dbPath = getKnowledgeDbPath(projectRoot);
  });
  after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('全量同步：三层落库 + 命名空间映射 + SHA-256 幂等键', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });

    assert.equal(report.scanned, 6); // 2 agents × 3 layers
    assert.equal(report.inserted, 6);
    assert.equal(report.skipped, 0);
    assert.equal(report.errors.length, 0);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 6);

      const docs = store.listLatestDocuments('employee/alpha', 'alpha');
      assert.equal(docs.length, 3);
      assert.deepEqual(docs.map((d) => d.layer), ['memory', 'colleagues', 'social']);
      for (const doc of docs) {
        assert.equal(doc.namespace, 'employee/alpha');
        assert.equal(doc.agentId, 'alpha');
        assert.equal(doc.contentHash, sha256(doc.content));
        assert.equal(doc.sourcePath, join(sourceRoot, 'alpha', `alpha.${doc.layer}.md`));
      }
      const memoryDoc = docs[0];
      assert.ok(memoryDoc.content.includes('v1 内容'));
    } finally {
      store.close();
    }
  });

  it('幂等重入：hash 相同全部跳过，不产生重复行', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });

    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 6);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 6); // 无重复
    } finally {
      store.close();
    }
  });

  it('hash 变更重写：同 source_path 旧版本被替换，数量不变', async () => {
    const memoryPath = join(sourceRoot, 'alpha', 'alpha.memory.md');
    await writeFile(memoryPath, '# alpha memory\nv2 内容（变更）', 'utf-8');

    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    assert.equal(report.inserted, 1);
    assert.equal(report.skipped, 5);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 6); // 替换而非追加
      const docs = store.listLatestDocuments('employee/alpha', 'alpha');
      const memoryDoc = docs.find((d) => d.layer === 'memory')!;
      assert.ok(memoryDoc.content.includes('v2 内容'));
      assert.equal(memoryDoc.contentHash, sha256(memoryDoc.content));
      // 旧 hash 已无对应行
      const oldHash = sha256('# alpha memory\nv1 内容');
      assert.notEqual(memoryDoc.contentHash, oldHash);
    } finally {
      store.close();
    }
  });

  it('增量同步（agentFilter）：只同步指定 agent', () => {
    const report = syncKnowledgeFromSource({
      sourceRoot,
      projectRoot,
      agentFilter: ['beta'],
    });
    // beta 三层已落库 → 全部跳过；alpha 不扫描
    assert.equal(report.scanned, 3);
    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 3);
  });

  it('dry-run：不创建/不写 knowledge.db', () => {
    const isolatedRoot = join(tmpdir(), `trilc-kn-dryrun-${Date.now()}`);
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot: isolatedRoot, dryRun: true });

    assert.equal(report.dryRun, true);
    assert.equal(report.inserted, 0);
    assert.equal(report.wouldInsert, 6); // 6 个源文件
    assert.ok(!existsSync(getKnowledgeDbPath(isolatedRoot)), 'dry-run 不得创建 DB 文件');
  });

  it('空文件：不落库且移除既有行（防陈旧知识注入）', async () => {
    const emptyPath = join(sourceRoot, 'beta', 'beta.social.md');
    const original = await readFileSync(emptyPath, 'utf-8');
    await writeFile(emptyPath, '   \n', 'utf-8');

    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    // beta.social 为空 → 既有行移除（removed=1）；其余 5 个 hash 未变 → skipped
    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 5);
    assert.equal(report.removed, 1);

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 5);
      const docs = store.listLatestDocuments('employee/beta', 'beta');
      assert.deepEqual(docs.map((d) => d.layer), ['memory', 'colleagues']); // social 未落库
    } finally {
      store.close();
    }

    await writeFile(emptyPath, original, 'utf-8'); // 还原，避免影响后续用例
  });
});

// ═══════════════════════════════════════════════════════════════════
// 4. 项目隔离
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — project isolation', () => {
  let sourceRoot: string;
  let projectA: string;
  let projectB: string;

  before(async () => {
    sourceRoot = await makeSourceRoot([{ id: 'alpha' }]);
    projectA = await mkdtemp(join(tmpdir(), 'trilc-kn-projA-'));
    projectB = await mkdtemp(join(tmpdir(), 'trilc-kn-projB-'));
    syncKnowledgeFromSource({ sourceRoot, projectRoot: projectA });
  });
  after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectA, { recursive: true, force: true });
    await rm(projectB, { recursive: true, force: true });
  });

  it('跨项目访问被 enforceProjectIsolation 拒绝', () => {
    const bDbPath = getKnowledgeDbPath(projectB);
    assert.throws(
      () => createKnowledgeStore(bDbPath, { projectRoot: projectA }),
      /Cross-project access denied/,
    );
  });

  it('两个项目各自独立知识库，互不可见', () => {
    // A 已同步（3 文档）；B 未同步
    const storeA = createKnowledgeStore(getKnowledgeDbPath(projectA), { projectRoot: projectA });
    try {
      assert.equal(storeA.countDocuments(), 3);
    } finally {
      storeA.close();
    }

    const storeB = createKnowledgeStore(getKnowledgeDbPath(projectB), { projectRoot: projectB });
    try {
      assert.equal(storeB.countDocuments(), 0);
    } finally {
      storeB.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 5-6. 注入：注入块正确性 / 消费记录 / 降级
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — injection', () => {
  let sourceRoot: string;
  let projectRoot: string;

  before(async () => {
    sourceRoot = await makeSourceRoot([
      { id: 'alpha', layers: { memory: 'M1 内容', colleagues: 'C1 内容', social: 'S1 内容' } },
    ]);
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-proj2-'));
    syncKnowledgeFromSource({ sourceRoot, projectRoot });
  });
  after(async () => {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('注入块组装：<knowledge-context> 内 Memory → Colleagues → Social 顺序 + sources 标签', () => {
    const block = buildKnowledgeContextBlock('employee/alpha', [
      { layer: 'memory', content: 'M1 内容' },
      { layer: 'colleagues', content: 'C1 内容' },
      { layer: 'social', content: 'S1 内容' },
    ]);

    // 批次 3-2：块头带 sources 来源语义标签（实际注入层列表）
    assert.ok(
      block.startsWith('<knowledge-context namespace="employee/alpha" sources="memory,colleagues,social">'),
    );
    assert.ok(block.endsWith('</knowledge-context>'));
    const memIdx = block.indexOf('## Memory');
    const colIdx = block.indexOf('## Colleagues');
    const socIdx = block.indexOf('## Social');
    assert.ok(memIdx > -1 && colIdx > memIdx && socIdx > colIdx, '三层顺序固定');
    assert.ok(block.includes('M1 内容') && block.includes('C1 内容') && block.includes('S1 内容'));
    // 域后缀：契约层标 (contract)，防与内容层 curated 混淆
    assert.ok(block.includes('## Memory (contract)'));
    assert.ok(block.includes('## Colleagues (contract)'));
    assert.ok(block.includes('## Social (contract)'));
  });

  it('注入：追加知识块到 prompt 并按层写消费记录', () => {
    const result = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'SOUL+BODY',
      sessionId: 'sess_knowledge_test',
    });

    assert.equal(result.injected, true);
    assert.ok(result.prompt.startsWith('SOUL+BODY'));
    // 批次 3-2：块头带 sources 来源语义标签（实际注入层）
    assert.ok(result.prompt.includes('<knowledge-context namespace="employee/alpha" sources="memory,colleagues,social">'));
    assert.deepEqual(result.layers, ['memory', 'colleagues', 'social']);
    assert.equal(result.consumed, 3);

    const store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
    try {
      assert.equal(store.countConsumptions(), 3);
    } finally {
      store.close();
    }
  });

  it('注入：重复注入同 hash 也留痕（审计面逐次记录）', () => {
    const first = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'P',
      sessionId: 's1',
    });
    const second = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'P',
      sessionId: 's2',
    });
    assert.equal(first.consumed, 3);
    assert.equal(second.consumed, 3);
    const store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
    try {
      assert.equal(store.countConsumptions(), 9);
    } finally {
      store.close();
    }
  });

  it('注入：无知识库/无该员工知识 → 原 prompt 降级返回', () => {
    const freshRoot = join(tmpdir(), `trilc-kn-noknow-${Date.now()}`);
    const result = injectKnowledgeContext({
      projectRoot: freshRoot,
      agentId: 'ghost',
      systemPrompt: 'SOUL',
    });
    assert.equal(result.injected, false);
    assert.equal(result.prompt, 'SOUL');
    assert.equal(result.consumed, 0);

    // 有知识库但该员工无知识 → 同样降级
    const result2 = injectKnowledgeContext({
      projectRoot,
      agentId: 'ghost',
      systemPrompt: 'SOUL',
    });
    assert.equal(result2.injected, false);
    assert.equal(result2.prompt, 'SOUL');
  });

  it('注入：systemPrompt 为空时注入块独立成文', () => {
    const result = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: '',
    });
    assert.equal(result.injected, true);
    assert.ok(result.prompt.startsWith('<knowledge-context'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7.5 小乔验证指标：v2 迁移 / 计数聚合 / 快照 / reason 分类 / 回调触发
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — behavior metrics (小乔验证指标)', () => {
  let projectRoot: string;
  let dbPath: string;

  before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-metrics-'));
    dbPath = getKnowledgeDbPath(projectRoot);
  });
  after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('v1 旧库打开自动迁移 v3：knowledge_metrics 表可用 + layer CHECK 放宽', () => {
    // 手工建 v1 库（user_version=1，无 metrics 表、三层 CHECK）→ 打开 → 迁移到
    // v3（v2 建 metrics 表 + v3 重建 knowledge_documents 放宽 layer CHECK）
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL, layer TEXT NOT NULL, agent_id TEXT NOT NULL,
        source_path TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
        source_mtime TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        UNIQUE(namespace, layer, agent_id, content_hash)
      );
      PRAGMA user_version=1;
    `);
    raw.close();

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      // 批次 3-2 显式断言：user_version 已升到 3（v1→v2→v3 全链迁移）
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const v = probe.prepare('PRAGMA user_version').get() as { user_version: number };
        assert.equal(v.user_version, 3, '迁移后 user_version 应为 3');
      } finally {
        probe.close();
      }
      // v3 后 layer CHECK 放宽：wiki 层可写入（内容层注入面就绪）
      const wiki = store.upsertDocument({
        namespace: 'employee/alpha',
        layer: 'wiki',
        agentId: 'alpha',
        sourcePath: 'wiki/alpha.md',
        content: '# wiki',
        contentHash: 'hash-wiki-v1mig',
        sourceMtime: '2026-08-20T00:00:00Z',
        syncedAt: new Date().toISOString(),
      });
      assert.equal(wiki.status, 'inserted');
      store.recordMetric({
        event: 'routing_error',
        agentId: 'chief-financial-officer',
        detail: 'migration_test',
        createdAt: new Date().toISOString(),
      });
      assert.equal(store.getMetricCounts()[0]?.count, 1);
      assert.equal(store.getMetricCounts()[0]?.event, 'routing_error');
    } finally {
      store.close();
    }
  });

  it('指标计数聚合 + 会话统计（分母素材）', () => {
    recordKnowledgeMetric({ projectRoot, event: 'escalation_blocked', agentId: 'alpha', sessionId: 's1', detail: 'tool:bash' });
    recordKnowledgeMetric({ projectRoot, event: 'escalation_blocked', agentId: 'alpha', sessionId: 's2', detail: 'tool:write' });
    recordKnowledgeMetric({ projectRoot, event: 'routing_error', agentId: 'chief-financial-officer', detail: 'tasks_submit_gate:candidate' });

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      const counts = store.getMetricCounts();
      assert.deepEqual(
        counts.sort((a, b) => a.event.localeCompare(b.event)),
        [
          { event: 'escalation_blocked', count: 2 },
          { event: 'routing_error', count: 2 },
        ],
      );
      const stats = store.getConsumptionSessionStats();
      assert.equal(stats.total, 0); // 本 describe 未注入消费
      assert.equal(stats.withSession, 0);
    } finally {
      store.close();
    }
  });

  it('快照：库不存在 → 全零；库存在 → 分子分母齐备', () => {
    const freshRoot = join(tmpdir(), `trilc-kn-nodb-${Date.now()}`);
    const empty = getKnowledgeMetricSnapshot(freshRoot);
    assert.equal(empty.consumptionTotal, 0);
    assert.deepEqual(empty.counts, []);
    assert.equal(empty.documentsTotal, 0);

    const snap = getKnowledgeMetricSnapshot(projectRoot);
    assert.equal(snap.consumptionTotal, 0);
    assert.equal(snap.counts.length, 2);
  });

  it('isEscalationBlockReason：越权语义计入，用户拒绝/执行异常不计', () => {
    assert.equal(isEscalationBlockReason('Blocked by permission engine (default)'), true);
    assert.equal(isEscalationBlockReason('Tool "rm" is not allowed for tier subagent'), true);
    assert.equal(isEscalationBlockReason('Tool is forbidden by contract decision rights'), true);
    assert.equal(isEscalationBlockReason('User denied permission for tool "bash"'), false);
    assert.equal(isEscalationBlockReason('exec failed: ENOENT'), false);
    assert.equal(isEscalationBlockReason('Repeated identical failure for tool "read" — possible loop'), false);
  });

  it('cron shouldRunJob：非在岗 → onRoleGateDenied 回调触发', async () => {
    let denied: string[] = [];
    const run = await shouldRunJob(
      {
        isRoleActive: async () => false,
        onRoleGateDenied: (roleId) => { denied.push(roleId); },
      },
      { id: 'j1', roleId: 'chief-financial-officer', enabled: true } as any,
    );
    assert.equal(run.run, false);
    assert.deepEqual(denied, ['chief-financial-officer']);

    // 在岗 → 回调不触发
    const run2 = await shouldRunJob(
      {
        isRoleActive: async () => true,
        onRoleGateDenied: (roleId) => { denied.push(roleId); },
      },
      { id: 'j2', roleId: 'full-stack-developer', enabled: true } as any,
    );
    assert.equal(run2.run, true);
    assert.deepEqual(denied, ['chief-financial-officer']);
  });

  it('agent-tool spawn 门禁：非在岗 → onSpawnGateDenied 回调触发', async () => {
    setRosterGate(async () => ({ status: 'candidate' }));
    const denied: string[] = [];
    setOnSpawnGateDenied((roleId, status) => { denied.push(`${roleId}:${status}`); });

    const gate = await enforceRosterGate('chief-financial-officer');
    assert.equal(gate.ok, false);
    assert.equal(gate.error, 'role_not_active');
    assert.deepEqual(denied, ['chief-financial-officer:candidate']);

    // 在岗 → 回调不触发
    setRosterGate(async () => ({ status: 'active' }));
    const gate2 = await enforceRosterGate('full-stack-developer');
    assert.equal(gate2.ok, true);
    assert.deepEqual(denied, ['chief-financial-officer:candidate']);

    // 清理注入（防污染其他测试）
    setRosterGate(null);
    setOnSpawnGateDenied(null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7. 主路径挂接：session-initializer SessionConfig 组装后追加
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — session-initializer main path', () => {
  let sourceRoot: string;
  let projectRoot: string;
  const prevEnv = process.env.TRILC_PROJECT_ROOT;

  before(async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-main-'));
    const agentDir = join(sourceRoot, 'sample-agent');
    await mkdir(agentDir, { recursive: true });

    await Promise.all([
      writeFile(join(agentDir, 'sample-agent.soul.md'), 'Sample soul', 'utf-8'),
      writeFile(join(agentDir, 'sample-agent.memory.md'), '知识记忆层', 'utf-8'),
      writeFile(join(agentDir, 'sample-agent.colleagues.md'), '知识协作层', 'utf-8'),
      writeFile(join(agentDir, 'sample-agent.social.md'), '知识社交层', 'utf-8'),
      writeFile(
        join(agentDir, 'sample-agent.contract.yaml'),
        [
          'contract:',
          '  version: "3.0"',
          '  type: agent-contract',
          '  agent_id: sample-agent',
          '  family: Role',
          'identity:',
          '  display_name: sample',
          '  role: SampleAgent',
          '  description: test agent',
          'paths:',
          '  soul: sample-agent/sample-agent.soul.md',
          '  agent_body: sample-agent/sample-agent.soul.md',
          '  agent_frontmatter: sample-agent/sample-agent.soul.md',
          '  memory: sample-agent/sample-agent.memory.md',
          '  colleagues: sample-agent/sample-agent.colleagues.md',
          '  social: sample-agent/sample-agent.social.md',
          'responsibilities:',
          '  - test duty',
          'decision_rights:',
          '  approve:',
          '    - release',
          '  forbidden:',
          '    - skip tests',
          'collaborators:',
          '  reports_to: ceo',
          'io_contract:',
          '  inputs:',
          '    - type: msg',
          '      description: test input',
          '  outputs:',
          '    - type: res',
          '      description: test output',
        ].join('\n'),
        'utf-8',
      ),
    ]);

    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-mainproj-'));
    process.env.TRILC_PROJECT_ROOT = projectRoot;

    // 装配 resolver 单例 + 全量知识同步（daemon 启动同序：loadAll → sync）
    getContractResolver(sourceRoot);
    await getContractResolver().loadAll();
    syncKnowledgeFromSource({ sourceRoot, projectRoot });
  });
  after(async () => {
    if (prevEnv === undefined) delete process.env.TRILC_PROJECT_ROOT;
    else process.env.TRILC_PROJECT_ROOT = prevEnv;
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('initializeSession 返回的 systemPrompt 含知识注入块（三层顺序）', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-ws-'));
    const config = await initializeSession('sample-agent', workspaceRoot);

    assert.ok(config.systemPrompt.startsWith('Sample soul\n\nSample soul'));
    // 批次 3-2：块头 sources 标签（三层契约）
    assert.ok(config.systemPrompt.includes('<knowledge-context namespace="employee/sample-agent" sources="memory,colleagues,social">'));
    const memIdx = config.systemPrompt.indexOf('## Memory');
    const colIdx = config.systemPrompt.indexOf('## Colleagues');
    const socIdx = config.systemPrompt.indexOf('## Social');
    assert.ok(memIdx > -1 && colIdx > memIdx && socIdx > colIdx);
    assert.ok(config.systemPrompt.includes('知识记忆层'));

    // 主路径注入：会话尚未创建 → 消费记录 session_id 为 null
    const store = createKnowledgeStore(getKnowledgeDbPath(projectRoot), { projectRoot });
    try {
      assert.equal(store.countConsumptions(), 3);
    } finally {
      store.close();
    }
    await rm(workspaceRoot, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
// 7.6 heartbeat 会话注入挂接点（agent-runner.ts 可测注入缝）
// ═══════════════════════════════════════════════════════════════════
// FADE-ASSESS-003 消费路径挂接点③：runHeartbeatAgent 在会话创建前经
// injectHeartbeatKnowledge 注入，session_id 只有此处可知（消费记录需要）。
// 覆盖缺口固化：env 注入口径 / 显式 projectRoot 优先 / 无知识降级不阻断。

describe('knowledge-injector — heartbeat 会话注入挂接点 (agent-runner seam)', () => {
  let sourceRoot: string;
  let projectRootA: string;      // 已同步知识（env 指向）
  let projectRootEmpty: string;  // 无知识库
  const prevEnv = process.env.TRILC_PROJECT_ROOT;

  before(async () => {
    sourceRoot = await makeSourceRoot([{ id: 'alpha' }]);
    projectRootA = await mkdtemp(join(tmpdir(), 'trilc-kn-hb-a-'));
    projectRootEmpty = await mkdtemp(join(tmpdir(), 'trilc-kn-hb-e-'));
    syncKnowledgeFromSource({ sourceRoot, projectRoot: projectRootA });
    process.env.TRILC_PROJECT_ROOT = projectRootA;
  });
  after(async () => {
    if (prevEnv === undefined) delete process.env.TRILC_PROJECT_ROOT;
    else process.env.TRILC_PROJECT_ROOT = prevEnv;
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(projectRootA, { recursive: true, force: true });
    await rm(projectRootEmpty, { recursive: true, force: true });
  });

  it('env 注入口径：heartbeat 默认 prompt 追加知识块 + 消费记录携带 session_id', () => {
    const sessionId = 'hb_alpha_test_001';
    const defaultPrompt = 'You are heartbeat agent "alpha". Execute your periodic task concisely.';
    const result = injectHeartbeatKnowledge({
      agentId: 'alpha',
      systemPrompt: defaultPrompt,
      sessionId,
    });

    assert.equal(result.injected, true);
    assert.ok(result.prompt.startsWith(defaultPrompt), '注入只追加不替换原 prompt');
    // 批次 3-2：块头 sources 标签（三层契约）
    assert.ok(result.prompt.includes('<knowledge-context namespace="employee/alpha" sources="memory,colleagues,social">'));
    assert.deepEqual(result.layers, ['memory', 'colleagues', 'social']);
    assert.equal(result.consumed, 3);

    // 挂接点语义：session_id 只有 heartbeat 会话创建处可知 → 消费记录必须携带
    const store = createKnowledgeStore(getKnowledgeDbPath(projectRootA), { projectRoot: projectRootA });
    try {
      const stats = store.getConsumptionSessionStats();
      assert.equal(stats.total, 3);
      assert.equal(stats.withSession, 3, 'heartbeat 注入的消费记录必须带 session_id');
      assert.equal(stats.distinctSessions, 1);
    } finally {
      store.close();
    }
  });

  it('显式 projectRoot 优先于 env：传无知识根 → 降级（env 有知识也不注入）', () => {
    const result = injectHeartbeatKnowledge({
      projectRoot: projectRootEmpty, // 显式指向无知识库
      agentId: 'alpha',
      systemPrompt: 'SOUL',
      sessionId: 'hb_explicit_empty',
    });

    assert.equal(result.injected, false, '显式 projectRoot 必须优先于 env（不得注入 env 知识）');
    assert.equal(result.prompt, 'SOUL');
    assert.equal(result.consumed, 0);
  });

  it('env 指向无知识库 → 降级返回原 prompt，不阻断 heartbeat', () => {
    const prev = process.env.TRILC_PROJECT_ROOT;
    process.env.TRILC_PROJECT_ROOT = projectRootEmpty;
    try {
      const result = injectHeartbeatKnowledge({
        agentId: 'alpha',
        systemPrompt: 'HB-SOUL',
        sessionId: 'hb_env_empty',
      });
      assert.equal(result.injected, false);
      assert.equal(result.prompt, 'HB-SOUL');
      assert.equal(result.consumed, 0);
    } finally {
      if (prev === undefined) delete process.env.TRILC_PROJECT_ROOT;
      else process.env.TRILC_PROJECT_ROOT = prev;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 8. 内容层接入（批次 3-2）：wiki 消费记录（主）+ inbox（辅）
// ═══════════════════════════════════════════════════════════════════
// 产品输入（CPO 小乔定案 2026-08-20）：
//   - 首批 = wiki 消费记录 + inbox，namespace 均落 employee/<id>
//   - wiki 页 md 形态复用 hash/upsert/幂等链路；layer='wiki'
//   - inbox JSON 单据：仅注入 open 或近 N 天（7 天）closed；
//     字段裁剪 summary/objectType/sender/priority/createdAt/
//     routingPackagePath/linkedNextAction（剥离 unread/resolution）
//   - audit 写回显式排除；org/shared 只预留不接入

/** 建内容资产树：<ws>/TriMetaverse/TriCompany-copilot-host-assets/knowledge/employees/<id>/{wiki,inbox,audit}。 */
async function makeContentRoot(ws: string, agents: Array<{
  id: string;
  wiki?: string[];
  inbox?: string[];
  audit?: boolean;
}>): Promise<string> {
  const contentRoot = join(ws, 'TriMetaverse', 'TriCompany-copilot-host-assets');
  for (const agent of agents) {
    const base = join(contentRoot, 'knowledge', 'employees', agent.id);
    if (agent.wiki) {
      const wikiDir = join(base, 'wiki');
      await mkdir(wikiDir, { recursive: true });
      for (const [name, content] of agent.wiki) {
        await writeFile(join(wikiDir, name), content, 'utf-8');
      }
    }
    if (agent.inbox) {
      const inboxDir = join(base, 'inbox');
      await mkdir(inboxDir, { recursive: true });
      for (const [name, content] of agent.inbox) {
        await writeFile(join(inboxDir, name), content, 'utf-8');
      }
    }
    if (agent.audit) {
      await mkdir(join(base, 'audit'), { recursive: true });
      await writeFile(join(base, 'audit', 'record-template.json'), '{"audit":true}', 'utf-8');
    }
  }
  return contentRoot;
}

describe('knowledge-injector — content layer sync (批次 3-2)', () => {
  let ws: string;
  let sourceRoot: string; // <ws>/TriCompany/source-agents（生产形态）
  let projectRoot: string;
  let dbPath: string;
  const recentClosedIso = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 近 1 天
  const staleClosedIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 天前

  before(async () => {
    ws = await mkdtemp(join(tmpdir(), 'trilc-kn-content-ws-'));
    sourceRoot = join(ws, 'TriCompany', 'source-agents');
    const alphaDir = join(sourceRoot, 'alpha');
    await mkdir(alphaDir, { recursive: true });
    await writeFile(join(alphaDir, 'alpha.memory.md'), '# alpha memory\n契约层内容', 'utf-8');

    await makeContentRoot(ws, [
      {
        id: 'alpha',
        wiki: [
          ['README.md', '# Wiki 说明\n不注入'],
          ['page-template.md', '---\npageId: template\n---\n模板不注入'],
          ['employee-consumption-records.md', '# Alpha Consumption Records\n\n阶段记忆：2026-08-01 上岗。'],
          ['chief-of-staff-current-state.md', '---\npageId: alpha-state\ntitle: 当前状态\npageStatus: working\n---\n\n## 当前整理事实\n\n消费记录已迁移。'],
        ],
        inbox: [
          // open 单据（缺省 status）
          ['2026-08-10-facts.json', JSON.stringify({
            sourceId: 'note-001',
            title: '事实清单（旧形态）',
            sourceType: 'json-record',
            topicHints: ['alpha'],
            trustLevel: 'curated',
            capturedAt: '2026-08-10T10:00:00+08:00',
            facts: ['事实 A', '事实 B'],
          }, null, 2)],
          // 近 N 天 closed
          ['2026-08-15-routing.json', JSON.stringify({
            summary: '路由包归档',
            objectType: 'routing-package',
            sender: 'chief-of-staff',
            priority: 'high',
            createdAt: '2026-08-15T09:00:00+08:00',
            status: 'closed',
            closedAt: recentClosedIso,
            routingPackagePath: 'docs/execution/routing/pack-001.json',
            linkedNextAction: 'review by CTO',
            unread: true,
            resolution: 'accepted',
            payload: { route: 'cto' },
          }, null, 2)],
          // 陈旧 closed（30 天前）→ 过滤
          ['2026-07-01-stale.json', JSON.stringify({
            summary: '陈旧单据',
            objectType: 'note',
            sender: 'ceo',
            priority: 'low',
            createdAt: '2026-07-01T09:00:00+08:00',
            status: 'closed',
            closedAt: staleClosedIso,
            unread: false,
            resolution: 'closed-out',
          }, null, 2)],
          // 模板不注入
          ['source-template.json', '{"summary":"模板"}'],
          // md 笔记：产品语义首批只注入 JSON 单据 → 跳过
          ['2026-08-11-meeting-note.md', '# 会议笔记\n内容不注入'],
        ],
        audit: true,
      },
    ]);

    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-content-proj-'));
    dbPath = getKnowledgeDbPath(projectRoot);
  });
  after(async () => {
    await rm(ws, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('resolveContentRoot：从 TriCompany/source-agents 推导到 <ws>/TriMetaverse/TriCompany-copilot-host-assets', () => {
    const resolved = resolveContentRoot(sourceRoot);
    assert.ok(resolved, '内容资产根应被推导到');
    assert.equal(resolved, join(ws, 'TriMetaverse', 'TriCompany-copilot-host-assets'));
  });

  it('内容层同步：wiki 页注入（layer=wiki，模板排除）+ inbox 过滤与裁剪 + audit 不注入', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });

    // 契约层：alpha.memory 1 文件
    // 内容层：wiki 2 页（README/page-template 排除）+ inbox 3 单（模板/md 排除，
    //        stale closed 过滤掉但计入 scanned）→ 实际插入 5
    assert.equal(report.scanned, 6);
    assert.equal(report.inserted, 5); // memory + wiki×2 + inbox open + inbox 近 closed
    assert.equal(report.filtered, 1); // 仅陈旧 closed 过滤
    assert.equal(report.errors.length, 0);
    assert.equal(report.contentRoot, join(ws, 'TriMetaverse', 'TriCompany-copilot-host-assets'));

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 5);
      const docs = store.listLatestDocuments('employee/alpha', 'alpha');
      assert.deepEqual(docs.map((d) => d.layer), ['memory', 'wiki', 'wiki', 'inbox', 'inbox']);

      // wiki 层：md 全文注入（幂等 hash 键，多页全量），README/模板排除
      const wikiDocs = docs.filter((d) => d.layer === 'wiki');
      assert.equal(wikiDocs.length, 2);
      assert.ok(wikiDocs.some((d) => d.content.includes('Alpha Consumption Records')));
      assert.ok(wikiDocs.some((d) => d.content.includes('pageStatus: working')));
      assert.ok(!wikiDocs.some((d) => d.content.includes('模板不注入')));

      // inbox 层：3 单据 → open + 近 1 天 closed 注入，陈旧 closed 过滤
      const inboxDocs = docs.filter((d) => d.layer === 'inbox');
      assert.equal(inboxDocs.length, 2);
      const content = inboxDocs.map((d) => d.content).join('\n');
      assert.ok(content.includes('事实 A'), 'open 单据知识正文（facts）保留');
      assert.ok(content.includes('路由包归档'), '近 N 天 closed 单据注入');
      assert.ok(content.includes('docs/execution/routing/pack-001.json'), 'routingPackagePath 保留');
      assert.ok(content.includes('review by CTO'), 'linkedNextAction 保留');
      // 字段裁剪：运行态字段一律不注入
      assert.ok(!content.includes('unread'), 'unread 运行态剥离');
      assert.ok(!content.includes('resolution'), 'resolution 运行态剥离');
      assert.ok(!content.includes('"status"'), 'status 运行态剥离');
      assert.ok(!content.includes('陈旧单据'), '陈旧 closed 不注入');

      // audit 写回显式排除：不注入
      assert.ok(!docs.some((d) => d.content.includes('audit')));
    } finally {
      store.close();
    }
  });

  it('内容层幂等重入：hash 相同全部跳过', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    assert.equal(report.inserted, 0);
    assert.equal(report.skipped, 5); // 6 scanned - 1 filtered
    assert.equal(report.filtered, 1);
  });

  it('陈旧 closed 单据注入过后再过期：既有行移除（防陈旧知识注入）', async () => {
    // 先把 stale 单据改成 open 注入 → 再改回陈旧 closed → 重同步 → 行被移除
    const stalePath = join(ws, 'TriMetaverse', 'TriCompany-copilot-host-assets', 'knowledge', 'employees', 'alpha', 'inbox', '2026-07-01-stale.json');
    await writeFile(stalePath, JSON.stringify({
      summary: '陈旧单据（临时 open）',
      objectType: 'note',
      sender: 'ceo',
      priority: 'low',
      createdAt: '2026-07-01T09:00:00+08:00',
    }, null, 2), 'utf-8');
    let report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    assert.equal(report.inserted, 1, '临时 open 单据注入');

    const store0 = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store0.countDocuments(), 6); // 5 + 临时 open 1
    } finally {
      store0.close();
    }

    // 还原为陈旧 closed → 既有行移除
    await writeFile(stalePath, JSON.stringify({
      summary: '陈旧单据',
      objectType: 'note',
      sender: 'ceo',
      priority: 'low',
      createdAt: '2026-07-01T09:00:00+08:00',
      status: 'closed',
      closedAt: staleClosedIso,
    }, null, 2), 'utf-8');
    report = syncKnowledgeFromSource({ sourceRoot, projectRoot });
    assert.equal(report.filtered, 1);
    assert.equal(report.removed, 1, '陈旧 closed 单据既有行移除');

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      assert.equal(store.countDocuments(), 5);
      const inboxDocs = store.listLatestDocuments('employee/alpha', 'alpha').filter((d) => d.layer === 'inbox');
      assert.ok(!inboxDocs.some((d) => d.content.includes('陈旧单据')));
    } finally {
      store.close();
    }
  });

  it('agentFilter 增量：内容层同过滤（只同步指定 agent）', () => {
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot, agentFilter: ['alpha'] });
    // 全部已落库 → 跳过；stale 单据过滤仍计
    assert.equal(report.inserted, 0);
    assert.equal(report.scanned, 6);
  });

  it('inbox 窗口天数可配置：nowMs 注入 + 窗口边界判定（独立库，不污染主库）', async () => {
    // 独立 projectRoot：窗口=0 会 remove 近 1 天 closed 行，避免影响注入块用例
    const windowRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-window-'));
    try {
      // nowMs 取 recent closedAt + 1 天整（边界相等 → <= 成立 → 注入）
      const boundaryNow = Date.parse(recentClosedIso) + 1 * 24 * 60 * 60 * 1000;
      const report = syncKnowledgeFromSource({
        sourceRoot,
        projectRoot: windowRoot,
        inboxClosedWindowDays: 1,
        nowMs: boundaryNow,
      });
      assert.equal(report.filtered, 1, '近 1 天 closed 边界内注入，仅 stale 过滤');
      // 窗口=0：近 1 天 closed 超出窗口 → filtered=2
      const report0 = syncKnowledgeFromSource({
        sourceRoot,
        projectRoot: windowRoot,
        inboxClosedWindowDays: 0,
        nowMs: boundaryNow,
      });
      assert.equal(report0.filtered, 2);
    } finally {
      await rm(windowRoot, { recursive: true, force: true });
    }
  });

  it('dry-run：内容层不写库（不创建 DB 文件）', () => {
    const isolatedRoot = join(tmpdir(), `trilc-kn-content-dry-${Date.now()}`);
    const report = syncKnowledgeFromSource({ sourceRoot, projectRoot: isolatedRoot, dryRun: true });
    assert.equal(report.dryRun, true);
    assert.equal(report.inserted, 0);
    assert.equal(report.wouldInsert, 5); // 6 scanned - 1 filtered
    assert.equal(report.filtered, 1);
    assert.ok(!existsSync(getKnowledgeDbPath(isolatedRoot)), 'dry-run 不得创建 DB 文件');
  });

  it('contentRoot 未部署：契约层照常同步，内容层跳过不报错', async () => {
    const isolatedWs = await mkdtemp(join(tmpdir(), 'trilc-kn-nocontent-'));
    const isolatedSource = join(isolatedWs, 'TriCompany', 'source-agents');
    await mkdir(join(isolatedSource, 'beta'), { recursive: true });
    await writeFile(join(isolatedSource, 'beta', 'beta.memory.md'), '# beta memory\n内容', 'utf-8');
    const report = syncKnowledgeFromSource({ sourceRoot: isolatedSource, projectRoot });
    assert.equal(report.contentRoot, null);
    assert.equal(report.scanned, 1);
    assert.equal(report.inserted, 1);
    assert.equal(report.errors.length, 0);
    await rm(isolatedWs, { recursive: true, force: true });
  });

  it('parseInboxRecord / shouldInjectInboxRecord / serializeInboxContent 纯函数语义', () => {
    // 旧形态 facts 单据 → 字段归一化（status 缺省 open；facts 进 body）
    const legacy = parseInboxRecord(JSON.stringify({
      title: '旧标题',
      sourceType: 'meeting-note',
      capturedAt: '2026-08-01T08:00:00Z',
      facts: ['事实 1'],
    }), '2026-08-01T00:00:00Z');
    assert.ok(legacy);
    assert.equal(legacy.summary, '旧标题');
    assert.equal(legacy.objectType, 'meeting-note');
    assert.equal(legacy.status, 'open');
    assert.equal(legacy.priority, 'normal');
    assert.deepEqual(legacy.body, { facts: ['事实 1'] });
    assert.equal(shouldInjectInboxRecord(legacy, Date.now()), true, 'open 恒注入');

    // closed 近 N 天注入 / 陈旧过滤
    const recent = parseInboxRecord(JSON.stringify({
      summary: '近关', objectType: 'routing-package',
      createdAt: '2026-08-15T00:00:00Z',
      status: 'closed', closedAt: recentClosedIso,
    }), '');
    assert.ok(recent && shouldInjectInboxRecord(recent, Date.now(), 7), '近 7 天 closed 注入');
    assert.ok(recent && !shouldInjectInboxRecord(recent, Date.now(), 0), '窗口 0 天 closed 过滤');

    const stale = parseInboxRecord(JSON.stringify({
      summary: '陈关', objectType: 'note',
      createdAt: '2026-07-01T00:00:00Z',
      status: 'closed', closedAt: staleClosedIso,
    }), '');
    assert.ok(stale && !shouldInjectInboxRecord(stale, Date.now(), 7), '陈旧 closed 过滤');

    // closed 无关闭时间 → 过滤（保守）
    const noClosedAt = parseInboxRecord(JSON.stringify({
      summary: '无时间', objectType: 'note', status: 'closed',
    }), '');
    assert.ok(noClosedAt && !shouldInjectInboxRecord(noClosedAt, Date.now()), 'closed 无时间戳不注入');

    // 不可解析 → null
    assert.equal(parseInboxRecord('not json', ''), null);

    // 序列化：稳定字段序 + 无运行态
    const serialized = serializeInboxContent(legacy!);
    const parsed = JSON.parse(serialized);
    assert.deepEqual(Object.keys(parsed), [
      'summary', 'objectType', 'sender', 'priority', 'createdAt',
      'routingPackagePath', 'linkedNextAction', 'body',
    ]);
    assert.ok(!serialized.includes('unread'));
    assert.ok(!serialized.includes('resolution'));
    assert.equal(INBOX_CLOSED_WINDOW_DAYS, 7);
  });

  it('inbox 注入块消费链路：wiki/inbox 层进注入块（sources 标签 + 域后缀 + 多页全量）', () => {
    const result = injectKnowledgeContext({
      projectRoot,
      agentId: 'alpha',
      systemPrompt: 'SOUL',
      sessionId: 's_content',
    });
    assert.equal(result.injected, true);
    // 契约层 1 + wiki 2 页 + inbox 2 单 = 5 文档全量注入
    assert.deepEqual(result.layers, ['memory', 'wiki', 'wiki', 'inbox', 'inbox']);
    assert.equal(result.consumed, 5);

    const block = result.prompt.slice(result.prompt.indexOf('<knowledge-context'));
    assert.ok(
      block.startsWith('<knowledge-context namespace="employee/alpha" sources="memory,wiki,inbox">'),
      '块头 sources 列出实际注入层（来源语义标签，去重）',
    );
    assert.ok(block.includes('## Wiki (content)'), 'wiki 节标内容层域');
    assert.ok(block.includes('## Inbox (content)'), 'inbox 节标内容层域');
    assert.ok(block.includes('## Memory (contract)'), 'memory 节标契约层域');
    assert.ok(block.includes('Alpha Consumption Records'), 'wiki 多页全量注入');
    assert.ok(block.includes('pageStatus: working'), 'wiki 页 frontmatter 保留');
    const memIdx = block.indexOf('## Memory');
    const wikiIdx = block.indexOf('## Wiki');
    const inboxIdx = block.indexOf('## Inbox');
    assert.ok(memIdx > -1 && wikiIdx > memIdx && inboxIdx > wikiIdx, '注入顺序：契约层在前，内容层在后');
  });

  it('layerDomain：契约层三件套 = contract，内容层 = content', () => {
    assert.equal(layerDomain('memory'), 'contract');
    assert.equal(layerDomain('colleagues'), 'contract');
    assert.equal(layerDomain('social'), 'contract');
    assert.equal(layerDomain('wiki'), 'content');
    assert.equal(layerDomain('inbox'), 'content');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 9. Schema 迁移 v2→v3：layer CHECK 放宽（批次 3-2）
// ═══════════════════════════════════════════════════════════════════

describe('knowledge-injector — schema v2→v3 migration', () => {
  let projectRoot: string;
  let dbPath: string;

  before(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'trilc-kn-v3-'));
    dbPath = getKnowledgeDbPath(projectRoot);
  });
  after(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('v2 旧库自动迁移 v3：user_version=3 + 既有行保留 + 新层可插入', () => {
    // 手工建 v2 库（user_version=2，三层 CHECK，含数据行 + 消费记录）
    mkdirSync(dirname(dbPath), { recursive: true });
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE knowledge_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        layer TEXT NOT NULL CHECK (layer IN ('memory', 'colleagues', 'social')),
        agent_id TEXT NOT NULL,
        source_path TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_mtime TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        synced_at TEXT NOT NULL,
        UNIQUE(namespace, layer, agent_id, content_hash)
      );
      CREATE TABLE knowledge_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_kd_agent ON knowledge_documents(namespace, agent_id, layer);
      INSERT INTO knowledge_documents
        (namespace, layer, agent_id, source_path, content, content_hash, source_mtime, schema_version, synced_at)
      VALUES
        ('employee/alpha', 'memory', 'alpha', 'alpha.memory.md', '旧行内容', 'hash-old', '2026-08-01T00:00:00Z', 1, '2026-08-01T00:00:00Z');
      PRAGMA user_version=2;
    `);
    raw.close();

    const store = createKnowledgeStore(dbPath, { projectRoot });
    try {
      // v3 显式断言：user_version 升到 3 + 既有行原样保留
      const probe = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const v = probe.prepare('PRAGMA user_version').get() as { user_version: number };
        assert.equal(v.user_version, 3, '迁移后 user_version 应为 3');
      } finally {
        probe.close();
      }
      assert.equal(store.countDocuments(), 1, '既有行不丢');

      // 新层（wiki/inbox）可插入 → CHECK 已放宽
      const wiki = store.upsertDocument({
        namespace: 'employee/alpha',
        layer: 'wiki',
        agentId: 'alpha',
        sourcePath: 'wiki/alpha-page.md',
        content: '# wiki 页',
        contentHash: 'hash-wiki',
        sourceMtime: '2026-08-20T00:00:00Z',
        syncedAt: new Date().toISOString(),
      });
      assert.equal(wiki.status, 'inserted');
      const inbox = store.upsertDocument({
        namespace: 'employee/alpha',
        layer: 'inbox',
        agentId: 'alpha',
        sourcePath: 'inbox/note.json',
        content: '{}',
        contentHash: 'hash-inbox',
        sourceMtime: '2026-08-20T00:00:00Z',
        syncedAt: new Date().toISOString(),
      });
      assert.equal(inbox.status, 'inserted');

      // 既有行仍可读（迁移未破坏数据面）
      const docs = store.listLatestDocuments('employee/alpha', 'alpha');
      assert.equal(docs.length, 3);
      assert.deepEqual(docs.map((d) => d.layer), ['memory', 'wiki', 'inbox']);
      assert.equal(docs[0].content, '旧行内容');

      // 指标面（v2 已建表）不丢
      assert.deepEqual(store.getMetricCounts(), []);
    } finally {
      store.close();
    }
  });

  it('新库直接建 v3 schema：wiki/inbox CHECK 生效，非法层被拒', () => {
    const freshRoot = join(tmpdir(), `trilc-kn-v3-fresh-${Date.now()}`);
    const store = createKnowledgeStore(getKnowledgeDbPath(freshRoot), { projectRoot: freshRoot });
    try {
      const probe = new DatabaseSync(getKnowledgeDbPath(freshRoot), { readOnly: true });
      try {
        const v = probe.prepare('PRAGMA user_version').get() as { user_version: number };
        assert.equal(v.user_version, 3);
      } finally {
        probe.close();
      }
      // 非法层（如 'audit'）被 CHECK 拒绝——audit 不注入的库面兜底
      assert.throws(
        () => store.upsertDocument({
          namespace: 'employee/alpha',
          layer: 'audit' as never,
          agentId: 'alpha',
          sourcePath: 'audit/x.json',
          content: '{}',
          contentHash: 'hash-audit',
          sourceMtime: '',
          syncedAt: new Date().toISOString(),
        }),
        /CHECK/i,
      );
    } finally {
      store.close();
    }
    return rm(freshRoot, { recursive: true, force: true });
  });
});
