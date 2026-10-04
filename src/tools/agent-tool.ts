// ── TriRLC AgentTool (P1 A级复制 - 子代理能力跃升) ──
// A级直接复制 from CC: src/tools/AgentTool/AgentTool.tsx
// 适配说明：
// - CC 使用复杂的 teammate/bridge 系统 → TriRLC 使用 agent-core spawnAgent 进程内递归
// - CC 支持 worktree/remote isolation → TriRLC 简化为基础进程内隔离
// - CC 有复杂的 agent 加载系统 → TriRLC 使用 agent-core built-in agents

import { register as registerTool } from '@tricompany/agent-core';
import { spawnAgent, getBuiltInAgent, listBuiltInAgents } from '@tricompany/agent-core';
import type { AgentDefinition, SpawnConfig } from '@tricompany/agent-core';

// ── Helper: List agents for /agents command ──
// Fetches built-in agents from agent-core + company agents from the TriMMC
// company endpoint (装后验收③：chat /agents 需接 company 视图——TriMMC
// /internal/v1/agents 返回员工注册表，count 14 已实证）。
export async function listAgentsForDisplay(): Promise<string> {
  const builtIn = listBuiltInAgents().map(a => ({ name: a.name, description: a.description }));
  let contractAgents: Array<{ name: string; description: string }> = [];

  try {
    const trimcBase = process.env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710';
    const res = await fetch(`${trimcBase}/internal/v1/agents`);
    const json = await res.json() as {
      ok?: boolean;
      agents?: Array<{ agentId?: string; name?: string; sessionId?: string }>;
    };
    // 兼容实际响应形状：daemon /internal/v1/agents 返回 {agents,count,scope}
    // （无 ok 字段，曾致合同员工列表永远为空）——以 agents 数组为准，ok 仅可选兼容。
    const agentList = parseAgentsResponse(json) as Array<{
      agentId?: string; name?: string; sessionId?: string;
    }>;
    if (agentList.length > 0) {
      contractAgents = agentList.map(a => ({
        name: a.agentId ?? a.name ?? 'unknown',
        description: a.name || a.agentId || 'company agent',
      }));
    }
  } catch { /* company endpoint unreachable — built-in only */ }

  const all = [...builtIn, ...contractAgents];
  if (all.length === 0) return 'No agents available.';

  const header = 'Available Sub-Agents:\n';
  const lines = all.map(a => `  • ${a.name} — ${a.description}`);
  return header + lines.join('\n');
}

/**
 * 解析 /internal/v1/agents 响应（可测纯函数）。
 *
 * 实际形状兼容（2026-08-20 spawn 端到端实跑抓到的生产 bug）：daemon 端点
 * 返回 {agents, count, scope, tricompanyEnabled}（无 ok 字段），TriMMC 面
 * 可能带 ok —— 以 agents 数组为准，ok 仅可选兼容。非数组/缺失 → []（调用方
 * 保持 built-in 优先 / fallback 逻辑不变）。
 */
export function parseAgentsResponse(json: unknown): Array<Record<string, unknown>> {
  if (!json || typeof json !== 'object') return [];
  const agents = (json as { agents?: unknown }).agents;
  return Array.isArray(agents) ? agents : [];
}

// ── FADE-ASSESS-005：分身门禁（上岗 gating）──
// 名册 = 分身的组织前提：未上岗 JD（pending-cho/candidate）不应 spawn 分身。
// daemon 在 createTriRLCApp.start() 注入 roster gate（读 CompanyInitState.employees）；
// 未注入（独立使用/单测）→ 放行 + console.warn，保持向后兼容。
type RosterGateFn = (roleId: string) => Promise<{ status: string } | undefined>;

let rosterGate: RosterGateFn | null = null;
/** FADE-ASSESS-003 小乔指标：spawn 门禁拒绝回调（daemon 注入真实埋点；未注入不埋）。 */
let onSpawnGateDenied: ((roleId: string, status: string) => void) | null = null;

/** daemon 注入点：设置岗位在岗校验函数（undefined 返回值 = 门禁不可用，放行）。 */
export function setRosterGate(fn: RosterGateFn | null): void {
  rosterGate = fn;
}

/** daemon 注入点：spawn 门禁拒绝回调（轻量埋点；独立使用/单测不注入即静默）。 */
export function setOnSpawnGateDenied(fn: ((roleId: string, status: string) => void) | null): void {
  onSpawnGateDenied = fn;
}

/**
 * 分身 spawn 前置校验：合同岗必须 ∈ roster.active。
 * 返回 { ok, status?, error? }；非在岗 → { ok: false, error: 'role_not_active' }。
 */
export async function enforceRosterGate(roleId: string): Promise<{ ok: boolean; status?: string; error?: string }> {
  if (!rosterGate) {
    console.warn(`[agent-tool] roster gate not injected — role ${roleId} spawn allowed without gating`);
    return { ok: true };
  }
  const res = await rosterGate(roleId);
  if (!res) return { ok: true };
  if (res.status === 'active') return { ok: true, status: res.status };
  // FADE-ASSESS-003 小乔指标：spawn 路由到未在岗岗 → routing_error 埋点（轻量回调）
  onSpawnGateDenied?.(roleId, res.status);
  return { ok: false, status: res.status, error: 'role_not_active' };
}

// ── AgentTool ──
// CC-equivalent sub-agent spawning tool - enables AI to delegate tasks to specialized sub-agents
// This is the core capability leap: "派一个子代理去完成子任务"
export function registerAgentTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'AgentTool',
        description: 'Spawn a sub-agent to complete a task. The sub-agent runs with its own context window and tool access, then returns the result to the main conversation.\n\n## When to Use\n\n- Delegate complex sub-tasks to specialized agents (e.g., "search codebase", "implement function")\n- Parallelize independent work streams\n- Isolate context for focused problem-solving\n\n## Parameters\n\n- `description`: Brief task description (3-5 words)\n- `prompt`: The detailed task for the agent\n- `subagent_type`: Type of specialized agent (optional, defaults to "code_explorer")\n- `model`: Model override (optional: "sonnet", "opus", "haiku")\n\n## Available Sub-agent Types\n\n' + listBuiltInAgents().map(a => `- \`${a.name}\`: ${a.description}`).join('\n'),
        parameters: {
          type: 'object',
          properties: {
            description: {
              type: 'string',
              description: 'A short (3-5 word) description of the task',
            },
            prompt: {
              type: 'string',
              description: 'The task for the agent to perform',
            },
            subagent_type: {
              type: 'string',
              description: 'The type of specialized agent to use (optional, defaults to "code_explorer")',
            },
            model: {
              type: 'string',
              enum: ['sonnet', 'opus', 'haiku'],
              description: 'Optional model override',
            },
          },
          required: ['description', 'prompt'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const description = args.description as string;
      const prompt = args.prompt as string;
      const subagentType = args.subagent_type as string | undefined;
      const model = args.model as string | undefined;

      if (!description || !description.trim()) {
        return JSON.stringify({ error: 'description is required' });
      }
      if (!prompt || !prompt.trim()) {
        return JSON.stringify({ error: 'prompt is required' });
      }

      // Get agent definition by type or default to code_explorer.
      // First try built-in agents, then fall back to daemon contract agents.
      const agentType = subagentType || 'code_explorer';
      let agentDef = getBuiltInAgent(agentType);

      if (!agentDef) {
        // Try contract-resolver agents loaded by the daemon (12 TriCompany employees)
        try {
          const res = await fetch('http://localhost:8711/internal/v1/agents');
          const json = await res.json() as {
            ok?: boolean;
            agents?: Array<{
              id?: string; name?: string; displayName?: string;
              description?: string; systemPrompt?: string;
            }>;
          };
          // 兼容实际响应形状：daemon 返回 {agents,count,scope,tricompanyEnabled}
          // （无 ok 字段，agent 项含 displayName/description 而非 name/systemPrompt）——
          // 旧判 `json.ok && json.agents` 恒 false，合同员工岗 spawn 永远
          // "Unknown agent type"（FADE-005 门禁在生产链路从未实际生效）。
          const agentList = parseAgentsResponse(json) as Array<{
            id?: string; name?: string; displayName?: string;
            description?: string; systemPrompt?: string;
          }>;
          if (agentList.length > 0) {
            const match = agentList.find(a => a.id === agentType);
            if (match) {
              // Synthesize a basic AgentDefinition for the contract agent
              agentDef = {
                name: match.id ?? agentType,
                description: match.description ?? match.displayName ?? match.name ?? match.id ?? agentType,
                systemPrompt: match.systemPrompt,
              } as AgentDefinition;
            }
          }
        } catch { /* daemon unreachable — will fall through to error */ }

        if (!agentDef) {
          const builtIn = listBuiltInAgents().map(a => a.name).join(', ');
          return JSON.stringify({
            error: `Unknown agent type: ${agentType}. Available built-in: ${builtIn}. Daemon agents available via /agents.`,
          });
        }

        // FADE-ASSESS-005 分身门禁：合同员工岗 spawn 前置校验 ∈ roster.active。
        // 名册是分身的组织前提——未上岗 JD（pending-cho/candidate）不应 spawn 分身。
        // 非在岗 → 显式错误返回（模型可见，不静默）。
        if (!getBuiltInAgent(agentType)) {
          const gate = await enforceRosterGate(agentType);
          if (!gate.ok) {
            return JSON.stringify({
              status: 'error',
              error: gate.error,
              roleId: agentType,
              rosterStatus: gate.status,
              message: `岗位 ${agentType} 未在岗（roster status: ${gate.status}）——未上岗 JD 不可 spawn 分身，请先走 staffing/onboard 上岗流程。`,
            });
          }
        }
      }

      // Build spawn config
      const config: SpawnConfig = {
        agent: {
          ...agentDef,
          model: model || agentDef.model,
        },
        task: prompt,
        maxTurns: agentDef.maxTurns || 10,
      };

      // Run sub-agent and collect results
      let finalResult = '';
      let toolCalls: string[] = [];
      let status: 'running' | 'completed' | 'error' = 'running';

      try {
        for await (const event of spawnAgent(config)) {
          switch (event.type) {
            case 'start':
              status = 'running';
              break;
            case 'message':
              if (event.data && typeof event.data === 'object' && 'content' in event.data) {
                finalResult = String((event.data as { content: string }).content);
              }
              break;
            case 'tool_call':
              if (event.data && typeof event.data === 'object' && 'tool' in event.data) {
                toolCalls.push(String((event.data as { tool: string }).tool));
              }
              break;
            case 'done':
              status = 'completed';
              break;
            case 'error':
              status = 'error';
              finalResult = event.data && typeof event.data === 'object' && 'message' in event.data
                ? String((event.data as { message: string }).message)
                : 'Unknown error';
              break;
          }
        }
      } catch (err) {
        status = 'error';
        finalResult = err instanceof Error ? err.message : String(err);
      }

      return JSON.stringify({
        status,
        description,
        prompt,
        result: finalResult,
        toolCalls,
        agentUsed: agentType,
      });
    },
  );
}

// Export for testing and /agents command
export { spawnAgent, getBuiltInAgent, listBuiltInAgents };
