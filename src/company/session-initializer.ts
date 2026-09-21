// ── Employee Session Initializer ──
// 6.4 会话初始化器（本地 TriLC 端）：员工会话启动统一入口
// 合同加载（contract-resolver 装配）→ 五件套装配校验 → 工作目录就绪
//
// 与 onboarding.ts（公司开张一次性引导）区分：本模块是员工级会话初始化，
// 每次员工会话启动时调用，产出运行时配置。服务器 TriMC 侧同构实现见
// TriMC/src/onboarding/session-initializer.ts（同源 v2 合同，互为 fallback）。

import { mkdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import {
  getContractResolver,
  type AgentContract,
  type EmployeeRosterEntry,
} from '../config/contract-resolver.js';
import { injectKnowledgeContext } from '@trimetaverse/tricode';

/** 员工会话运行时配置（合同 YAML → 运行时）。 */
export interface SessionConfig {
  agentId: string;
  systemPrompt: string;
  decisionRights: AgentContract['decisionRights'];
  toolControl: Record<string, unknown>;
  employeeInfo?: EmployeeRosterEntry;
  workspaceRoot: string;
  readyAt: string;
}

/** 会话初始化失败（agent 未加载 / 工作目录不可用）。 */
export class SessionInitError extends Error {
  constructor(
    message: string,
    public agentId: string,
  ) {
    super(`[session-initializer] ${agentId}: ${message}`);
    this.name = 'SessionInitError';
  }
}

/** 工作目录就绪：创建（幂等）+ 可写校验。 */
export async function ensureWorkspaceDir(workspaceRoot: string): Promise<string> {
  const dir = resolve(workspaceRoot);
  await mkdir(dir, { recursive: true });
  await access(dir, constants.W_OK);
  return dir;
}

/**
 * 员工会话初始化：
 * 1. 合同加载 — 从 contract-resolver 取已装配合同（daemon 启动时 loadAll 完成）
 * 2. 五件套装配 — systemPrompt（soul + agent_body）、decisionRights、toolControl
 * 3. 工作目录就绪 — workspaceRoot 创建 + 可写校验
 *
 * 返回 SessionConfig；agent 未加载或工作目录不可用抛 SessionInitError。
 */
export async function initializeSession(
  agentId: string,
  workspaceRoot: string,
): Promise<SessionConfig> {
  const resolver = getContractResolver();

  const systemPrompt = resolver.getSystemPrompt(agentId);
  const decisionRights = resolver.getDecisionRights(agentId);
  if (!systemPrompt || !decisionRights) {
    throw new SessionInitError('agent contract not loaded', agentId);
  }

  // FADE-ASSESS-003: 消费路径挂接点①（主路径）— SessionConfig 组装后追加知识注入块。
  // boot injection 非检索；注入层不污染身份真源（getSystemPrompt 保持 soul+agent_body 不变）。
  // 无知识/知识库未同步 → 原 prompt 降级返回，不阻断会话。
  const injected = injectKnowledgeContext({
    projectRoot: process.env.TRILC_PROJECT_ROOT || undefined,
    agentId,
    systemPrompt,
    injectionMode: 'boot',
  });

  const toolControl = resolver.getToolControl(agentId) ?? {};
  const employeeInfo = resolver.getEmployeeInfo(agentId);
  const dir = await ensureWorkspaceDir(workspaceRoot);

  return {
    agentId,
    systemPrompt: injected.prompt,
    decisionRights,
    toolControl,
    employeeInfo,
    workspaceRoot: dir,
    readyAt: new Date().toISOString(),
  };
}
