// ── Agent Contract Resolver ──
// 读取 .contract.yaml（路径索引）→ 加载五件套 → 组装 system prompt
// 
// 用途: TriLC 启动时加载所有 agent 定义，运行时根据 agent_id 注入对应身份

import { readFileSync, existsSync, watch } from 'fs';
import { resolve } from 'path';
import { parse as parseYaml } from 'yaml';
import { loadContractV3, type AgentContractV3 } from '@tricompany/agent-core';
import { syncKnowledgeFromSource } from '@trimetaverse/tricode';

// ── Types ──

export interface AgentContract {
  agentId: string;
  family: 'Role' | 'Registry';
  /** 合同 identity 面（role-catalog 只读展示数据源：roleName/oneLinePositioning）。 */
  identity: {
    displayName: string;
    role: string;
    description: string;
  };
  paths: {
    soul: string;
    agent_body: string;
    agent_frontmatter: string;
    memory: string;
    colleagues: string;
    social: string;
  };
  decisionRights: {
    approve: string[];
    freeze: string[];
    escalate: string[];
    forbidden: string[];
  };
  systemPrompt: string;   // 拼接后的完整 system prompt
  toolControl: Record<string, unknown>;  // frontmatter 解析后的工具配置
}

/** Employee roster entry from TriCompany/docs/registry/employee-roster.json. */
export interface EmployeeRosterEntry {
  id: string;
  displayName: string;
  /** 个人名（实例属性参考；运行态真源 = 各部署 CompanyInitState.employees）。 */
  instanceName?: string;

  family: 'Role' | 'Registry';
  role: string;
  tier: string;
  reportsTo: string;
  supervises: string[];
  onboardedAt: string;
  status: string;
}

/** Full employee roster document shape. */
export interface EmployeeRoster {
  version: string;
  company: string;
  rosterDate: string;
  totalEmployees: number;
  employees: EmployeeRosterEntry[];
  tiers: Record<string, number>;
  families: Record<string, number>;
}

// ── Role Catalog（i2-1 拆解 §二：结构化员工选择载荷数据源）──

/**
 * D1 决策（2026-08-14，CPO 小乔确认）：默认勾选 5 岗 = playbook 1.2 四员工岗
 * （ceo-chief-of-staff / full-stack-developer / chief-administrative-officer /
 * chief-human-resources-officer）+ chief-technology-officer 为第 5 岗（技术
 * 交付链必要、C-suite 治理岗、与「含治理角色」原则一致）。默认值仅影响初始
 * 勾选（CEO 裁决：≥1 岗可开张，<5 岗提示不拦截）。
 *
 * D1 修订（2026-08-15，CEO 裁决）：默认最小上岗 7 岗 = 总助 / CPO / CTO /
 * 开发 / 测试 / CAO / CHO（在 5 岗基础上 + chief-product-officer + test-engineer
 * ——产品与测试职能进默认骨架）。硬下限不变（≥1 岗可开张），提示阈值随默认集
 * 同步为 <7 岗 warning（recommendedMin=7）。
 */
export const DEFAULT_SELECTED_ROLES: readonly string[] = [
  'ceo-chief-of-staff',
  'chief-product-officer',
  'chief-technology-officer',
  'full-stack-developer',
  'test-engineer',
  'chief-administrative-officer',
  'chief-human-resources-officer',
];

export interface RoleCatalogEntry {
  roleId: string;
  roleName: string;
  /** 岗位显示名（JD 层，如 "CEO 总助"）——个人名是实例属性，不经 catalog 传递。 */
  displayName?: string;
  /** 个人名建议（roster instanceName，开业/上岗起名时的默认值）。 */
  instanceName?: string;
  /** 一句话定位 = 合同 identity.description（employee-standard-capabilities.md:50 映射）。 */
  oneLinePositioning: string;
  /** roster tier === 'C-suite'（8 C-suite 岗 true / 5 Execution 岗 false）。 */
  isGovernance: boolean;
  defaultSelected: boolean;
}

export interface RoleCatalog {
  schemaVersion: 1;
  roles: RoleCatalogEntry[];
}

// ── Resolver ──

class AgentContractResolver {
  private contracts = new Map<string, AgentContract>();
  private sourceRoot: string;
  private watcher: ReturnType<typeof watch> | null = null;
  private employeeRoster: EmployeeRoster | null = null;

  constructor(sourceRoot: string) {
    this.sourceRoot = resolve(sourceRoot);
  }

  /** 从 source-agents 目录加载所有 .contract.yaml */
  async loadAll(): Promise<number> {
    const contractsDir = resolve(this.sourceRoot);
    if (!existsSync(contractsDir)) {
      console.warn(`[contract-resolver] source root not found: ${contractsDir}`);
      return 0;
    }

    // 遍历子目录查找 .contract.yaml
    const fs = await import('fs/promises');
    const entries = await fs.readdir(contractsDir, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const contractPath = resolve(contractsDir, entry.name, `${entry.name}.contract.yaml`);
      if (!existsSync(contractPath)) continue;

      try {
        const contract = this.loadOne(contractPath);
        if (contract) {
          this.contracts.set(contract.agentId, contract);
          count++;
        }
      } catch (err) {
        console.warn(`[contract-resolver] failed to load ${contractPath}:`, (err as Error).message);
      }
    }

    console.log(`[contract-resolver] loaded ${count} agent contracts`);
    return count;
  }

  /** 加载单个 contract（v3.0 解析走 agent-core 权威 schema） */
  private loadOne(contractPath: string): AgentContract | null {
    // thin adapter 边界（v3-spec §四）：解析+校验统一 loadContractV3，
    // 本域保留五件套路径组装与 system prompt 组装
    let parsed: AgentContractV3;
    try {
      parsed = loadContractV3(contractPath);
    } catch (err) {
      console.warn(`[contract-resolver] failed to load ${contractPath}:`, (err as Error).message);
      return null;
    }

    const agentId = parsed.contract.agent_id;
    const family = parsed.contract.family;

    // v3 schema 保证六文件路径必填非空
    const paths: Required<AgentContract['paths']> = {
      soul: parsed.paths.soul,
      agent_body: parsed.paths.agent_body,
      agent_frontmatter: parsed.paths.agent_frontmatter,
      memory: parsed.paths.memory,
      colleagues: parsed.paths.colleagues,
      social: parsed.paths.social,
    };

    // 读取五件套
    const soul = this.readFileSafe(resolve(this.sourceRoot, paths.soul));
    const agentBody = this.readFileSafe(resolve(this.sourceRoot, paths.agent_body));
    const agentFrontmatter = this.readFileSafe(resolve(this.sourceRoot, paths.agent_frontmatter));
    const memory = this.readFileSafe(resolve(this.sourceRoot, paths.memory));
    const colleagues = this.readFileSafe(resolve(this.sourceRoot, paths.colleagues));
    const social = this.readFileSafe(resolve(this.sourceRoot, paths.social));

    // 组装 system prompt: soul + agent body
    const systemPrompt = [soul, agentBody]
      .filter(Boolean)
      .join('\n\n');

    // 解析 frontmatter 的工具配置
    const explicitToolControl = this.parseFrontmatter(agentFrontmatter);
    const bodyToolControl = this.parseFrontmatter(agentBody);
    const toolControl = Object.keys(explicitToolControl).length > 0
      ? explicitToolControl
      : bodyToolControl;

    // decision_rights（v3 四键全量）
    const decisionRights = {
      approve: parsed.decision_rights.approve,
      freeze: parsed.decision_rights.freeze,
      escalate: parsed.decision_rights.escalate,
      forbidden: parsed.decision_rights.forbidden,
    };

    return {
      agentId,
      family,
      identity: {
        displayName: parsed.identity.display_name ?? '',
        role: parsed.identity.role ?? '',
        description: parsed.identity.description ?? '',
      },
      paths,
      decisionRights,
      systemPrompt,
      toolControl,
    };
  }

  private readFileSafe(filePath: string): string {
    try {
      if (existsSync(filePath)) {
        return readFileSync(filePath, 'utf-8');
      }
    } catch { /* ignore */ }
    return '';
  }

  private parseFrontmatter(text: string): Record<string, unknown> {
    if (!text) return {};
    const trimmed = text.trim();
    if (!trimmed) return {};
    let yamlText = trimmed;
    if (trimmed.startsWith('---')) {
      const lines = trimmed.split(/\r?\n/);
      const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
      if (closingIndex < 0) return {};
      yamlText = lines.slice(1, closingIndex).join('\n').trim();
      if (!yamlText) return {};
    }
    try {
      const parsed = parseYaml(yamlText) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  /** 获取 agent 的 system prompt */
  getSystemPrompt(agentId?: string): string | undefined {
    if (!agentId) return undefined;
    return this.contracts.get(agentId)?.systemPrompt;
  }

  /** 获取 agent 的决策权限 */
  getDecisionRights(agentId: string): AgentContract['decisionRights'] | undefined {
    return this.contracts.get(agentId)?.decisionRights;
  }

  /** 获取 agent 的工具控制 */
  getToolControl(agentId: string): Record<string, unknown> | undefined {
    return this.contracts.get(agentId)?.toolControl;
  }

  /** 列出所有已加载的 agent */
  listAgents(): string[] {
    return [...this.contracts.keys()];
  }

  /** 从 TriCompany 路径加载 employee-roster.json。
   *
   * 真源路径：``<TriCompany 根>/docs/registry/employee-roster.json``（i2-1 §二）。
   * sourceRoot 为 TriCompany/source-agents，故候选 =
   *   1. ``<sourceRoot>/docs/registry/employee-roster.json``（历史候选）
   *   2. ``<sourceRoot>/../docs/registry/employee-roster.json``（TriCompany 根真源）
   * 如果 roster 文件不存在或解析失败，roster 保持为 null。
   * 返回已解析的 roster 条目数量，或 0（失败时）。
   */
  loadEmployeeRoster(): number {
    const candidates = [
      resolve(this.sourceRoot, 'docs', 'registry', 'employee-roster.json'),
      resolve(this.sourceRoot, '..', 'docs', 'registry', 'employee-roster.json'),
    ];
    const rosterPath = candidates.find((p) => existsSync(p));
    if (!rosterPath) {
      console.warn(`[contract-resolver] employee roster not found (tried: ${candidates.join(', ')})`);
      return 0;
    }
    try {
      const raw = readFileSync(rosterPath, 'utf-8');
      const parsed = JSON.parse(raw) as EmployeeRoster;
      if (!parsed.employees || !Array.isArray(parsed.employees)) {
        console.warn('[contract-resolver] employee roster has no employees array');
        return 0;
      }
      this.employeeRoster = parsed;
      console.log(`[contract-resolver] loaded ${parsed.employees.length} employee roster entries (${rosterPath})`);
      return parsed.employees.length;
    } catch (err) {
      console.warn(`[contract-resolver] failed to load employee roster:`, (err as Error).message);
      return 0;
    }
  }

  /** 获取员工在 roster 中的信息。
   *
   * 以 agentId 为键查找 employee roster。
   * 返回 EmployeeRosterEntry，或 undefined（若 roster 未加载或该 agentId 不在 roster 中）。
   */
  getEmployeeInfo(agentId: string): EmployeeRosterEntry | undefined {
    if (!this.employeeRoster) return undefined;
    return this.employeeRoster.employees.find((e) => e.id === agentId);
  }

  /** 返回已加载的 employee roster 的所有条目。
   *
   * 若 roster 尚未加载，返回空数组。
   */
  listEmployees(): EmployeeRosterEntry[] {
    return this.employeeRoster?.employees ?? [];
  }

  /**
   * 岗位目录只读访问器（GET /internal/v1/init/role-catalog 数据源，i2-1 §二）。
   *
   * 以 roster 为主键（标准岗位 13 条目），从合同 identity 面取展示字段；
   * roster 缺失或合同未加载时返回 null——端点映射 503，不开天窗造数据。
   * Registry family 合同（business-strategy 等）天然被 roster 主键过滤。
   */
  getRoleCatalog(): RoleCatalog | null {
    if (!this.employeeRoster) return null;
    const roles: RoleCatalogEntry[] = [];
    for (const entry of this.employeeRoster.employees) {
      const contract = this.contracts.get(entry.id);
      if (!contract || contract.family !== 'Role') continue;
      roles.push({
        roleId: entry.id,
        roleName: contract.identity.role || entry.role,
        displayName: entry.displayName,
        instanceName: entry.instanceName,
        oneLinePositioning: contract.identity.description,
        isGovernance: entry.tier === 'C-suite',
        defaultSelected: DEFAULT_SELECTED_ROLES.includes(entry.id),
      });
    }
    return { schemaVersion: 1, roles };
  }

  /** 监听文件变更并热重载（FADE-ASSESS-003 扩展：五件套三层知识文件 → knowledge.db 增量同步）。
   *
   * @param projectRoot 知识库归属项目根（增量同步落点）；缺省回退 TRILC_PROJECT_ROOT/cwd。
   */
  watchAndReload(projectRoot?: string): void {
    const knowledgeProjectRoot = projectRoot ?? process.env.TRILC_PROJECT_ROOT ?? process.cwd();
    this.watcher = watch(this.sourceRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.endsWith('.contract.yaml') || filename.endsWith('.agent.md')) {
        console.log(`[contract-resolver] change detected: ${filename}, reloading...`);
        this.loadAll().then(count => {
          console.log(`[contract-resolver] reloaded ${count} contracts`);
        });
      } else if (
        filename.endsWith('.memory.md') ||
        filename.endsWith('.colleagues.md') ||
        filename.endsWith('.social.md')
      ) {
        // FADE-ASSESS-003: 五件套三层知识文件变更 → 增量同步（幂等，hash 相同跳过）
        const segments = filename.split(/[\\/]/);
        const agentId = segments.length > 1 ? segments[0] : undefined;
        if (!agentId) return;
        console.log(`[contract-resolver] knowledge change detected: ${filename}, incremental sync...`);
        try {
          const report = syncKnowledgeFromSource({
            sourceRoot: this.sourceRoot,
            projectRoot: knowledgeProjectRoot,
            agentFilter: [agentId],
          });
          console.log(
            `[knowledge-injector] incremental sync (${agentId}): ${report.inserted} inserted, ` +
            `${report.skipped} skipped, ${report.errors.length} errors`,
          );
        } catch (err) {
          console.warn('[knowledge-injector] incremental sync failed:', (err as Error).message);
        }
      }
    });
  }

  /** 仅关闭文件监听（保留 contracts 缓存；app.stop() 用，防 watcher 拖住事件循环） */
  closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /** 停止监听并清空合同缓存 */
  dispose(): void {
    this.watcher?.close();
    this.contracts.clear();
  }
}

// ── Singleton ──

let _instance: AgentContractResolver | null = null;

export function getContractResolver(sourceRoot?: string): AgentContractResolver {
  if (!_instance && sourceRoot) {
    _instance = new AgentContractResolver(sourceRoot);
  }
  if (!_instance) {
    throw new Error('Contract resolver not initialized. Call getContractResolver(sourceRoot) first.');
  }
  return _instance;
}

export { AgentContractResolver };
