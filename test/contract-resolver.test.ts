import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContractResolver, DEFAULT_SELECTED_ROLES } from '../src/config/contract-resolver.js';

interface V3ContractExtra {
  decision_rights?: string[];
  family?: string;
  identityRole?: string;
  description?: string;
}

/** v3.0 形状合同（strict 必填最小集；decision_rights 顶层必填，四键有默认）。 */
function v3Contract(agentId: string, extra?: V3ContractExtra): string {
  const dr = extra?.decision_rights
    ? ['decision_rights:', ...extra.decision_rights]
    : ['decision_rights: {}'];
  return [
    'contract:',
    '  version: "3.0"',
    '  type: agent-contract',
    `  agent_id: ${agentId}`,
    `  family: ${extra?.family ?? 'Role'}`,
    'identity:',
    '  display_name: Sample',
    `  role: ${extra?.identityRole ?? agentId}`,
    `  description: ${extra?.description ?? 'test agent'}`,
    'paths:',
    `  soul: ${agentId}/soul.agent.md`,
    `  agent_body: ${agentId}/agent-body.agent.md`,
    `  agent_frontmatter: ${agentId}/agent-frontmatter.agent.md`,
    `  memory: ${agentId}/memory.agent.md`,
    `  colleagues: ${agentId}/colleagues.agent.md`,
    `  social: ${agentId}/social.agent.md`,
    'responsibilities:',
    '  - test duty',
    ...dr,
    'collaborators:',
    '  reports_to: ceo',
    // v3 字段族现役形（LG-060 跟新；真源=source-agents v3：tools.runtime_equivalent + runtime_baseline 对象）
    'tools:',
    '  - name: read',
    '    scope: [docs/]',
    '    risk_level: low',
    '    requires_approval: false',
    '    runtime_equivalent: trimc:read_file',
    'runtime_baseline:',
    '  host: copilot-host',
    '  tri_mc_status: planned',
    '  tri_mc_migration_ready: false',
    'io_contract:',
    '  inputs:',
    '    - type: msg',
    '      description: test input',
    '  outputs:',
    '    - type: res',
    '      description: test output',
  ].join('\n');
}

describe('AgentContractResolver', () => {
  let sourceRoot: string | undefined;

  afterEach(async () => {
    if (sourceRoot) {
      await rm(sourceRoot, { recursive: true, force: true });
      sourceRoot = undefined;
    }
  });

  it('resolves contract paths from the source-agents root', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-contract-resolver-'));
    const agentDir = join(sourceRoot, 'sample-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'Sample soul', 'utf-8'),
      writeFile(join(agentDir, 'agent-body.agent.md'), 'Sample body', 'utf-8'),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), 'tools:\n  - read', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), 'Sample memory', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), 'Sample colleagues', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), 'Sample social', 'utf-8'),
      writeFile(
        join(agentDir, 'sample-agent.contract.yaml'),
        v3Contract('sample-agent', { decision_rights: ['  approve:', '    - release'] }),
        'utf-8',
      ),
    ]);

    const resolver = new AgentContractResolver(sourceRoot);
    assert.equal(await resolver.loadAll(), 1);
    assert.deepEqual(resolver.listAgents(), ['sample-agent']);
    assert.equal(resolver.getSystemPrompt('sample-agent'), 'Sample soul\n\nSample body');
    assert.deepEqual(resolver.getDecisionRights('sample-agent'), {
      approve: ['release'],
      freeze: [],
      escalate: [],
      forbidden: [],
    });
    assert.deepEqual(resolver.getToolControl('sample-agent'), { tools: ['read'] });
    // v3 字段族断言（LG-060 跟新）：tools 投影含 runtime_equivalent；runtime_baseline 对象形透传
    const tools = resolver.getTools('sample-agent');
    assert.equal(tools?.length, 1);
    assert.equal(tools?.[0].name, 'read');
    assert.equal(tools?.[0].runtime_equivalent, 'trimc:read_file');
    assert.deepEqual(resolver.getRuntimeBaseline('sample-agent'), {
      host: 'copilot-host',
      tri_mc_status: 'planned',
      tri_mc_migration_ready: false,
    });
  });

  it('uses agent body frontmatter when the dedicated frontmatter file is empty', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-contract-body-frontmatter-'));
    const agentDir = join(sourceRoot, 'body-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'Body soul', 'utf-8'),
      writeFile(
        join(agentDir, 'agent-body.agent.md'),
        '---\nname: BodyAgent\ndescription: Contract metadata\ntools: [read, search]\n---\nBody instructions',
        'utf-8',
      ),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), '---\n\n---\n', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'body-agent.contract.yaml'), v3Contract('body-agent'), 'utf-8'),
    ]);

    const resolver = new AgentContractResolver(sourceRoot);
    assert.equal(await resolver.loadAll(), 1);
    assert.deepEqual(resolver.getToolControl('body-agent'), {
      name: 'BodyAgent',
      description: 'Contract metadata',
      tools: ['read', 'search'],
    });
  });

  it('rejects v2-shaped contracts (negative path: no compat branch)', async () => {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-contract-v2-reject-'));
    const agentDir = join(sourceRoot, 'legacy-agent');
    await mkdir(agentDir);

    await Promise.all([
      writeFile(join(agentDir, 'soul.agent.md'), 'soul', 'utf-8'),
      writeFile(join(agentDir, 'agent-body.agent.md'), 'body', 'utf-8'),
      writeFile(join(agentDir, 'agent-frontmatter.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'memory.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'colleagues.agent.md'), '', 'utf-8'),
      writeFile(join(agentDir, 'social.agent.md'), '', 'utf-8'),
      writeFile(
        join(agentDir, 'legacy-agent.contract.yaml'),
        [
          'contract:',
          '  version: "2.0"',
          '  agent_id: legacy-agent',
          '  family: Role',
          'paths:',
          '  soul: legacy-agent/soul.agent.md',
          '  agent_body: legacy-agent/agent-body.agent.md',
          '  agent_frontmatter: legacy-agent/agent-frontmatter.agent.md',
          '  memory: legacy-agent/memory.agent.md',
          '  colleagues: legacy-agent/colleagues.agent.md',
          '  social: legacy-agent/social.agent.md',
        ].join('\n'),
        'utf-8',
      ),
    ]);

    const resolver = new AgentContractResolver(sourceRoot);
    // v2 形状被 v3 schema 拒绝：loadAll 返回 0，无兼容分支
    assert.equal(await resolver.loadAll(), 0);
    assert.deepEqual(resolver.listAgents(), []);
  });

  // ── getRoleCatalog()（i2-1 拆解 §二：只读展示数据源）──

  async function seedRoleCatalogFixture(): Promise<void> {
    sourceRoot = await mkdtemp(join(tmpdir(), 'trilc-role-catalog-'));
    // 两个 Role 合同 + 一个 Registry 家族合同
    await mkdir(join(sourceRoot, 'ceo-chief-of-staff'));
    await mkdir(join(sourceRoot, 'test-engineer'));
    await mkdir(join(sourceRoot, 'registry-x'));
    const writeAgent = async (id: string) => {
      for (const f of ['soul', 'agent-body', 'agent-frontmatter', 'memory', 'colleagues', 'social']) {
        await writeFile(join(sourceRoot, id, `${f}.agent.md`), '', 'utf-8');
      }
    };
    await writeAgent('ceo-chief-of-staff');
    await writeAgent('test-engineer');
    await writeAgent('registry-x');
    await writeFile(
      join(sourceRoot, 'ceo-chief-of-staff', 'ceo-chief-of-staff.contract.yaml'),
      v3Contract('ceo-chief-of-staff', { identityRole: 'CEOChiefOfStaff', description: '总助，负责公司运作协调。' }),
      'utf-8',
    );
    await writeFile(
      join(sourceRoot, 'test-engineer', 'test-engineer.contract.yaml'),
      v3Contract('test-engineer', { identityRole: 'TestEngineer', description: '测试工程师，负责独立验证。' }),
      'utf-8',
    );
    await writeFile(
      join(sourceRoot, 'registry-x', 'registry-x.contract.yaml'),
      v3Contract('registry-x', { family: 'Registry' }),
      'utf-8',
    );
    // roster：2 条有效（Role）+ 1 条无合同（ghost-role）+ 1 条指 Registry 合同
    await mkdir(join(sourceRoot, 'docs', 'registry'), { recursive: true });
    await writeFile(
      join(sourceRoot, 'docs', 'registry', 'employee-roster.json'),
      JSON.stringify({
        version: '1.0.0',
        company: 'TriCompany',
        rosterDate: '2026-08-01',
        totalEmployees: 4,
        employees: [
          { id: 'ceo-chief-of-staff', displayName: '甲', family: 'Role', role: 'CEOChiefOfStaff', tier: 'C-suite', reportsTo: 'CEO', supervises: [], onboardedAt: '2026-07-01', status: 'live' },
          { id: 'test-engineer', displayName: '乙', family: 'Role', role: 'TestEngineer', tier: 'Execution', reportsTo: 'CEO', supervises: [], onboardedAt: '2026-07-01', status: 'live' },
          { id: 'ghost-role', displayName: '丙', family: 'Role', role: 'GhostRole', tier: 'C-suite', reportsTo: 'CEO', supervises: [], onboardedAt: '2026-07-01', status: 'live' },
          { id: 'registry-x', displayName: '丁', family: 'Registry', role: 'RegistryX', tier: 'C-suite', reportsTo: 'CEO', supervises: [], onboardedAt: '2026-07-01', status: 'live' },
        ],
        tiers: { 'C-suite': 3, Execution: 1 },
        families: { Role: 3, Registry: 1 },
      }),
      'utf-8',
    );
  }

  it('getRoleCatalog: identity 面解析 + roster tier/isGovernance + DEFAULT_SELECTED_ROLES 默认勾选', async () => {
    await seedRoleCatalogFixture();
    const resolver = new AgentContractResolver(sourceRoot);
    await resolver.loadAll();
    assert.equal(resolver.loadEmployeeRoster(), 4);

    const catalog = resolver.getRoleCatalog();
    assert.ok(catalog, 'catalog 非 null');
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.roles.length, 2, '仅 Role 合同 + roster 主键交集；ghost-role 与 registry-x 被过滤');

    const chief = catalog.roles.find((r) => r.roleId === 'ceo-chief-of-staff');
    assert.ok(chief, 'ceo-chief-of-staff 在 catalog');
    assert.equal(chief.roleName, 'CEOChiefOfStaff', 'roleName = 合同 identity.role');
    assert.equal(chief.oneLinePositioning, '总助，负责公司运作协调。', 'oneLinePositioning = identity.description');
    assert.equal(chief.isGovernance, true, 'C-suite → isGovernance');
    assert.equal(chief.defaultSelected, true, 'D1 常量含 ceo-chief-of-staff → defaultSelected');
    assert.equal(
      DEFAULT_SELECTED_ROLES.length, 7,
      'D1 修订（CEO 2026-08-15）：默认最小上岗 7 岗（总助/CPO/CTO/开发/测试/CAO/CHO）',
    );

    const testEng = catalog.roles.find((r) => r.roleId === 'test-engineer');
    assert.ok(testEng);
    assert.equal(testEng.isGovernance, false, 'Execution → 非治理');
    assert.equal(testEng.defaultSelected, true, 'D1 修订：test-engineer 进默认集');
  });

  it('getRoleCatalog: roster 未加载 → null（端点 503 兜底，不开天窗）', async () => {
    await seedRoleCatalogFixture();
    const resolver = new AgentContractResolver(sourceRoot);
    await resolver.loadAll();
    assert.equal(resolver.getRoleCatalog(), null, 'roster 缺失 → null');
  });
});
