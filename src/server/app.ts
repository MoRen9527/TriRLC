// ── TriLC Local HTTP Server ──
// Exposes the same API surface as TriMC:
//   GET  /healthz              → { ok: true, service: 'trilc' }
//   GET  /v1/models            → Anthropic-compatible model list
//   GET  /models               → OpenAI-compatible model list
//   POST /v1/messages          → Anthropic Messages API (SSE + JSON)
//   POST /chat/completions     → OpenAI Chat Completions API (SSE + JSON)
//   POST /internal/v1/agent    → SSE + JSON modes (agentLoop from @tricompany/agent-core)
//
// TriLC does NOT load pipeline (Soul Loader / Memory Injector / Context Builder / Tool Gater).
// Those are TriMC-only services. Local mode uses legacy raw mode directly.

import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { TriLCEnv } from '../config/env.js';
import { resolveWeeklyPlaneRoot } from '../project/weekly-plane-root.js';
import { agentLoop, register as registerTool, canUseTool } from '@tricompany/agent-core';
import type { AgentEvent, AgentLoopOptions, AgentLoopDeps } from '@tricompany/agent-core';
import type { AgentTier, PermissionMode, PermissionRule } from '@tricompany/agent-core';
import { isPlanModeActive, PLAN_MODE_WHITELIST } from '../tools/plan-mode.js';
import { validateMessage, type GuardResult } from '@tricompany/agent-core';
import type { Message, ToolDefinition, UsageSummary } from 'trimodel';
import { createModelClient } from 'trimodel';
import { createEventQueue } from '../event-queue/index.js';
import type { ReplayRequest, ReplayResponse } from '../event-queue/types.js';
import { publish, localBus, type LocalBusEvent } from '../localbus/bus.js';
import { agentEventsToAnthropicSSE, formatSSELine } from './anthropic-stream.js';
import { agentEventsToOpenAISSE, formatOpenAISSE, OPENAI_SSE_DONE } from './openai-stream.js';
import { registerShellExecTool, getDefaultSupervisor, cancelAllShellProcesses } from '../tools/shell-exec.js';
import { createSessionStore } from '../session-store/index.js';
import { createLetterStore, LEAD_AGENT_ID, ESCALATE_ACTOR_ALLOWLIST } from '../letter-store/store.js';
import type { LetterAction, LetterPriority } from '../letter-store/types.js';
import { registerLeadTools } from '../letter-store/lead-tools.js';
import { runSafetyCheck } from '../session-store/safety-check.js';
import type { SessionRecord, SessionMessageRecord, SessionStatus } from '../session-store/types.js';
import {
  applyKeyCacheToEnvironment,
  getKeyCache,
  initKeyCache,
  onKeyCacheUpdated,
  stopKeyCache,
} from '../config/key-cache.js';
import { TaskMirrorPusher } from '../mirror/pusher.js';
import type { MirrorTaskSnapshot } from '../mirror/types.js';
import {
  beginInteractiveSession,
  endInteractiveSession,
  getPendingInteraction,
  answerInteraction,
  isAlwaysAllowed,
  rememberAlwaysAllow,
  requestInteraction,
} from './interactions.js';
import { createHeartbeatWake } from '../heartbeat/heartbeat-wake.js';
import { createHeartbeatRunner, type TriLCHeartbeatRunner, type HeartbeatAgentConfig } from '../heartbeat/heartbeat-runner.js';
import { CompanyInitState } from '../company/init-state.js';
import { getContractResolver } from '../config/contract-resolver.js';
import { InitChain } from '../company/init-chain.js';
import { injectKnowledgeContext } from '../knowledge-injector/inject.js';
import {
  recordKnowledgeMetric,
  getKnowledgeMetricSnapshot,
} from '../knowledge-injector/metrics.js';
import {
  beginSelfcheck,
  isSelfcheckRunning,
  getActiveRunId,
  recordTaskSubmission,
  type SelfcheckDeps,
} from '../company/init-selfcheck.js';
import {
  runAssemble,
  validateAssemblePayload,
  getOnboardingStateProjection,
  validateProgressUpsert,
  upsertOnboardingProgress,
  buildInitModeSystemPrompt,
  type AssembleDeps,
} from '../company/init-assemble.js';
import { ProjectRegistry } from '../project/project-registry.js';
import {
  runLink,
  runClaim,
  inspectPath,
  validateLinkPayload,
  validateClaimPayload,
  createGitRunner,
  type ProjectLinkDeps,
} from '../project/project-link.js';
import {
  runInitSync,
  getSyncStatus,
  runStartupResyncCheck,
  type InitSyncDeps,
  type SyncEntry,
} from '../company/init-sync.js';
import { runConfirmCheck, runConfirm } from '../company/init-confirm.js';
import { runFirstCollabUpdate } from '../company/init-first-collab.js';
import {
  getStaffingRoster,
  getRoleRosterStatus,
  requestOnboarding,
  decideOnboarding,
  enforceRoleActive,
  isRoleActive,
  type StaffingDeps,
} from '../company/staffing.js';
import { createSessionReaper } from '../cron/session-reaper.js';
import { createMinimalCronEngine, type MinimalCronEngine } from '../cron/service.js';
import { createUpdateCheckHandler, startUpdateCheckLoop } from '../update/update-check.js';
// FADE-ASSESS-005 分身门禁：AgentTool 合同员工 spawn 前置校验 roster.active。
import { setRosterGate, setOnSpawnGateDenied } from '../tools/agent-tool.js';

// Cached roster of available sub-agents (built at daemon startup, injected
// into system prompts so the model knows by name which agents it can invoke
// with AgentTool — e.g. "let Xiao Jia check this" → AgentTool(agentType=ceo-chief-of-staff)).
let cachedAgentRoster = '';

// ── P0 加固：HTTP 面安全 helpers（p0fix3-trilc-http PD-1）──
// 最小侵入约束下不新建模块，以下纯函数物理落在本文件并按需导出，
// 供对抗测试单元级覆盖。

/** 从请求头提取调用方提供的内部令牌：x-internal-token（数组取首元素）
 *  优先，缺失时回退 Authorization: Bearer。 */
export function extractInternalToken(headers: IncomingHttpHeaders): string | undefined {
  const direct = headers['x-internal-token'];
  if (Array.isArray(direct)) {
    return typeof direct[0] === 'string' ? direct[0] : undefined;
  }
  if (typeof direct === 'string') return direct;
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

/** 常数时间字符串比较。长度不等时不能直接短路（耗时差会泄漏长度信息），
 *  先做一次同长哑比较抹平时间特征，再返回 false。 */
export function timingSafeStringEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

interface HostAllowEntry {
  /** full = host[:port] 整串比对；hostname = 只比主机名部分 */
  mode: 'full' | 'hostname';
  value: string;
}

/** authority 归一：trim + 小写 + IPv6 方括号剥离（两端同规则防形态绕过）。 */
function canonicalAuthority(value: string): string {
  const t = value.trim().toLowerCase();
  const m = /^\[(.+)\](:\d+)?$/.exec(t);
  return m ? `${m[1]}${m[2] ?? ''}` : t;
}

/** 把 host[:port] 拆成归一化整串 + 主机名两部分；空串返回 null。
 *  仅「唯一冒号且后随纯数字」视作 host:port 切分；多冒号（裸 IPv6 形态）
 *  不切分、整体当 hostname 参与 hostname 模式比对。 */
function splitCanonicalHost(value: string): { authority: string; hostname: string } | null {
  const c = canonicalAuthority(value);
  if (!c) return null;
  const lastColon = c.lastIndexOf(':');
  const firstColon = c.indexOf(':');
  if (firstColon === lastColon && lastColon > 0 && /^\d+$/.test(c.slice(lastColon + 1))) {
    return { authority: c, hostname: c.slice(0, lastColon) };
  }
  return { authority: c, hostname: c };
}

/** 构建 Host 允许集：回环三形（port 取当时的 env.port）+ TRILC_HOST_ALLOWLIST
 *  逗号分隔追加项。条目含端口 ⇒ 整串匹配；不含端口 ⇒ 只比 hostname。
 *  '[' 开头视作 IPv6（可带端口）；"host:纯数字" 视作含端口；其余形态保守按
 *  hostname 整体比对。每次判定重建而非启动期缓存快照，便于运行中注入测试。 */
export function collectHostAllowEntries(port: number): HostAllowEntry[] {
  const entries: HostAllowEntry[] = [
    { mode: 'full', value: `localhost:${port}` },
    { mode: 'full', value: `127.0.0.1:${port}` },
    { mode: 'full', value: `[::1]:${port}` },
  ];
  for (const piece of (process.env.TRILC_HOST_ALLOWLIST ?? '').split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    if (/^\[/.test(entry) || /^[\w.\-]+:\d+$/.test(entry)) {
      entries.push({ mode: 'full', value: entry });
    } else {
      entries.push({ mode: 'hostname', value: entry });
    }
  }
  return entries;
}

/** 单个 host/origin 候选值是否命中允许集。 */
function hostCandidateAllowed(candidate: string, entries: HostAllowEntry[]): boolean {
  const parts = splitCanonicalHost(candidate);
  if (!parts) return false;
  for (const entry of entries) {
    const entryValue = canonicalAuthority(entry.value);
    if (entry.mode === 'full' ? parts.authority === entryValue : parts.hostname === entryValue) {
      return true;
    }
  }
  return false;
}

/** Host 头判定（DNS rebinding 防护）：缺失/空白 ⇒ 拒。 */
export function hostHeaderAllowed(hostHeader: string | undefined, port: number): boolean {
  if (typeof hostHeader !== 'string' || !hostHeader.trim()) return false;
  return hostCandidateAllowed(hostHeader, collectHostAllowEntries(port));
}

/** Origin 补充判定：同一允许规则。仅当请求带 Origin 且非 'null' 时调用方
 *  才需强制要求命中（'null' origin 在此放行）；解析失败 ⇒ 不可信，保守拒。 */
export function originHeaderAllowed(origin: string, port: number): boolean {
  const trimmed = origin.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return true;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (!parsed.host) return false;
  return hostCandidateAllowed(parsed.host, collectHostAllowEntries(port));
}

/** HTTP 提交 cron job 的命令白名单（fail-closed 最保守口径）：
 *  TRILC_CRON_COMMAND_ALLOWLIST 逗号分隔精确等值（trim 后比对，不做前缀/
 *  通配）。未配置/空串 = 空集 = 一切携带非空 command 的 HTTP 载荷被拒；
 *  不携带 command 的 heartbeat/systemPrompt 型 job 不受影响。本地原生创建、
 *  不经 HTTP 的 job 走执行层原行为（本门不涉及执行层）。 */
export function cronCommandHttpAllowed(command: unknown): boolean {
  if (typeof command !== 'string' || !command.trim()) return true;
  const entries = (process.env.TRILC_CRON_COMMAND_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.includes(command.trim());
}

// ── Builtin Agents ──
// Hardcoded sub-agents that are not loaded from TriCompany contracts.
// Exposed via GET /internal/v1/agents?scope=builtin (or scope=all).

interface BuiltinAgent {
  id: string;
  displayName: string;
  description: string;
  hasSystemPrompt: boolean;
  decisionRights: { approve: string[]; freeze: string[]; escalate: string[] };
  tools: Record<string, unknown>;
}

const BUILTIN_AGENTS: BuiltinAgent[] = [
  {
    id: 'code_explorer',
    displayName: 'Code Explorer',
    description: 'Search and explore codebases — find symbols, trace dependencies, navigate project structure',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['write', 'delete'], escalate: [] },
    tools: { name: 'Code Explorer', description: 'Structural codebase search and navigation agent' },
  },
  {
    id: 'test_runner',
    displayName: 'Test Runner',
    description: 'Run tests and report results — execute test suites and surface failures',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['write', 'delete'], escalate: [] },
    tools: { name: 'Test Runner', description: 'Test execution and result reporting agent' },
  },
  {
    id: 'file_processor',
    displayName: 'File Processor',
    description: 'Transform and process files — batch file operations, format conversions, data extraction',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['delete'], escalate: ['write'] },
    tools: { name: 'File Processor', description: 'File transformation and batch processing agent' },
  },
  {
    id: 'code_reviewer',
    displayName: 'Code Reviewer',
    description: 'Review code for quality and issues — lint, security scan, style check, best-practice audit',
    hasSystemPrompt: true,
    decisionRights: { approve: [], freeze: ['write', 'delete'], escalate: [] },
    tools: { name: 'Code Reviewer', description: 'Code quality review and audit agent' },
  },
];

// ── P3: Interactive permission rules ──
// Dangerous tools that trigger an interactive allow/deny/always prompt when
// the request opts in via `interactive: true`. Mode stays bypassPermissions
// so everything else passes at pipeline step 4; these hit step 2 (ask).
const INTERACTIVE_ASK_RULES: PermissionRule[] = [
  { toolName: 'shell_exec', behavior: 'ask', source: 'session' },
  { toolName: 'Bash', behavior: 'ask', source: 'session' },
  { toolName: 'Edit', behavior: 'ask', source: 'session' },
  { toolName: 'Write', behavior: 'ask', source: 'session' },
];

/** Compact human-readable summary of tool args for the permission prompt. */
function summarizeToolArgs(toolName: string, args: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  if (toolName === 'shell_exec' || toolName === 'Bash') {
    return str(args.command ?? args.cmd ?? '').slice(0, 200);
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return str(args.file_path ?? args.filePath ?? args.path ?? '').slice(0, 200);
  }
  return JSON.stringify(args).slice(0, 200);
}

// ── P7: Plan mode tool gating ──
// Injects deps.checkToolPermission into every AgentLoopOptions so that
// EnterPlanMode→ExitPlanMode brackets are enforced at tool-execution time.
// The callback runs AFTER permissionEngine (P3) and BEFORE actual execution.
function buildPlanModeDeps(): AgentLoopDeps {
  return {
    checkToolPermission: (toolName, tier) => {
      // First tier check (agent-core native tier gating)
      const tierResult = canUseTool(toolName, tier);
      if (!tierResult.allowed) return tierResult;

      // Plan mode whitelist check (P7)
      if (isPlanModeActive() && !PLAN_MODE_WHITELIST.has(toolName)) {
        return {
          allowed: false,
          reason:
            `Plan mode active: tool "${toolName}" is blocked. ` +
            'Only read/plan tools are allowed during plan mode. ' +
            'Use ExitPlanMode to resume full capabilities.',
        };
      }

      return { allowed: true };
    },
  };
}

// ── TC-001 harness scaffold (tc001-harness-scaffold HS-1/HS-2) ──
// agent-core 执行持续性三机制的宿主侧实现（对齐 CC 宿主的三层外部信号）：
//   FR-1 task_plan 进度锚点注入 / FR-2 end_turn 判定纪律 / FR-3 进度 reminder。
// 全部请求字段可选：一个都不带时 parseHarnessOptions 返回 null，端点直接走原生
// agentLoop，零行为变化。
//
// 实现约束：agent-core 的 agentLoop 内部自持多轮循环与消息状态，宿主无法在单次
// 调用中途注入消息；且 anthropic/openai 两个 SSE 转换器都在首个 loop_end 即终止
// 消费。因此包装器以 maxTurns=1 驱动内部循环、从事件流重建消息历史、按需重启，
// 并吞掉中间 loop_end（usage 聚合后合成唯一终态 loop_end）——与下方 C15
// compacting 包装器的重启模式同构。

/** task_plan 单条目（由 rmc_tick 等发送端构建）。 */
export interface TaskPlanItem {
  id: string;
  description: string;
  /** 'pending'（默认）| 'in_progress' | 'done' */
  status?: string;
}

export interface TaskPlan {
  items?: TaskPlanItem[];
  /** 当前聚焦项 id */
  currentFocus?: string;
}

/** TC-001 新增的可选请求字段（/v1/messages 与 /chat/completions 共用）。 */
export interface HarnessOptions {
  task_plan?: TaskPlan;
  /** FR-2：模型 end_turn 时注入自查判定消息而非直接返回 */
  continue_on_incomplete?: boolean;
  /** FR-2：自定义判定提示（缺省用内置自查提示） */
  incomplete_check_prompt?: string;
  /** 判定注入次数上限（默认 4） */
  continue_max_rounds?: number;
  /** 兼容别名：等价 incomplete_check_prompt（优先级低于后者） */
  continue_prompt?: string;
  /** FR-3：每 N 轮注入进度 reminder（默认 10） */
  progress_reminder_interval?: number;
  /** FR-3：自定义 reminder 模板，支持 {turn}/{maxTurns}/{completedSteps} 占位 */
  progress_reminder_template?: string;
}

const INCOMPLETE_CHECK_PROMPT =
  '你结束了回合但任务可能尚未完成。请自查：你的所有交付物是否已创建？所有 commit 是否已推送？'
  + '如果未完成，继续执行。如果确实完成，回复 DONE。';
/** TC-s1 契约（task_plan 扁平数组形式）的内置英文自查判定提示（规格原文）。 */
const TCS1_SELF_CHECK_PROMPT =
  'Your turn ended but the task may not be complete. If not done, continue executing. If truly complete, reply exactly: DONE.';
const PROGRESS_REMINDER_TEMPLATE =
  '[PROGRESS REMINDER] Turn {turn}/{maxTurns}. Your original task is still active.\n'
  + 'Completed steps this session: {completedSteps}.\n'
  + 'If you have gathered enough information, transition to writing your output now.\n'
  + 'If not, focus on the most critical remaining information gaps.';
const DEFAULT_CONTINUE_MAX_ROUNDS = 4;
const DEFAULT_PROGRESS_REMINDER_INTERVAL = 10;

/**
 * 从请求体提取 harness 字段；一个都没有（或都无效）时返回 null —— 端点保持
 * 原生 agentLoop 行为，满足「全字段缺省零行为变化」。
 */
export function parseHarnessOptions(body: unknown): HarnessOptions | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const out: HarnessOptions = {};

  // TC-s1 兼容：task_plan 同时接受扁平结构化数组形式 [ { id, description, status } ]
  // 与 TC-001 对象包装形式 { items: [...] }，二者归一到同一 TaskPlan。
  const tcs1FlatForm = Array.isArray(b.task_plan);
  if (b.task_plan && typeof b.task_plan === 'object') {
    const raw = b.task_plan as Record<string, unknown>;
    const plan: TaskPlan = {};
    const rawItems: unknown[] = tcs1FlatForm
      ? b.task_plan as unknown[]
      : Array.isArray(raw.items) ? raw.items : [];
    if (rawItems.length > 0) {
      plan.items = rawItems
        .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
        .map((it) => ({
          id: typeof it.id === 'string' ? it.id : String(it.id ?? ''),
          description: typeof it.description === 'string' ? it.description : '',
          ...(typeof it.status === 'string' ? { status: it.status } : {}),
        }))
        .filter((it) => it.id !== '');
    }
    if (!tcs1FlatForm && typeof raw.currentFocus === 'string') plan.currentFocus = raw.currentFocus;
    if ((plan.items?.length ?? 0) > 0) out.task_plan = plan;
  }
  if (b.continue_on_incomplete === true) out.continue_on_incomplete = true;
  if (typeof b.incomplete_check_prompt === 'string' && b.incomplete_check_prompt.trim() !== '') {
    out.incomplete_check_prompt = b.incomplete_check_prompt;
  }
  if (typeof b.continue_max_rounds === 'number' && Number.isFinite(b.continue_max_rounds) && b.continue_max_rounds >= 0) {
    out.continue_max_rounds = Math.floor(b.continue_max_rounds);
  }
  if (typeof b.continue_prompt === 'string' && b.continue_prompt.trim() !== '') {
    out.continue_prompt = b.continue_prompt;
  }
  if (typeof b.progress_reminder_interval === 'number' && Number.isFinite(b.progress_reminder_interval) && b.progress_reminder_interval > 0) {
    out.progress_reminder_interval = Math.floor(b.progress_reminder_interval);
  }
  if (typeof b.progress_reminder_template === 'string' && b.progress_reminder_template.trim() !== '') {
    out.progress_reminder_template = b.progress_reminder_template;
  }

  // TC-s1：扁平数组契约（continue_on_incomplete=true）默认使用规格原文英文自查
  // 判定提示；显式 incomplete_check_prompt / continue_prompt 恒优先，
  // TC-001 对象形式请求不受影响（保持内置中文提示，见 harness-scaffold.test）。
  if (
    tcs1FlatForm &&
    out.continue_on_incomplete === true &&
    out.incomplete_check_prompt === undefined &&
    out.continue_prompt === undefined
  ) {
    out.incomplete_check_prompt = TCS1_SELF_CHECK_PROMPT;
  }

  const found =
    out.task_plan !== undefined ||
    out.continue_on_incomplete === true ||
    out.incomplete_check_prompt !== undefined ||
    out.continue_max_rounds !== undefined ||
    out.continue_prompt !== undefined ||
    out.progress_reminder_interval !== undefined ||
    out.progress_reminder_template !== undefined;
  return found ? out : null;
}

/** 稳定序列化（变更检测用）。task_plan 在单个请求内是静态的，快照不变则不重复注入。 */
function serializeTaskPlan(plan: TaskPlan): string {
  return JSON.stringify({ items: plan.items ?? [], currentFocus: plan.currentFocus ?? null });
}

/** FR-1 锚点消息（规格书模板）：让模型每轮都能看到清单全景与下一步。 */
function formatTaskPlanProgress(plan: TaskPlan): string {
  const items = plan.items ?? [];
  const label = (it: TaskPlanItem) => `#${it.id} ${it.description}`;
  const done = items.filter((it) => it.status === 'done');
  const focus = plan.currentFocus ? items.find((it) => it.id === plan.currentFocus) : undefined;
  const inProgress = focus ? [focus] : items.filter((it) => it.status === 'in_progress');
  const claimedIds = new Set([...done, ...inProgress].map((it) => it.id));
  const remaining = items.filter((it) => !claimedIds.has(it.id));
  const fmt = (list: TaskPlanItem[]) => (list.length > 0 ? list.map(label).join('; ') : 'none');
  return (
    `[SYSTEM: Task progress — completed: ${fmt(done)} | in progress: ${fmt(inProgress)}`
    + ` | remaining: ${fmt(remaining)}. Continue with the next incomplete item.]`
  );
}

/**
 * TC-s1：将 task_plan 渲染为 markdown 进度清单，注入 systemPrompt 尾部
 * （静态全景 —— 模型从第一轮就看到全部步骤；FR-1 的逐轮 [SYSTEM: Task
 * progress] 锚点提供动态进展，两者互补）。无有效条目时返回空串，
 * 不污染 system prompt。
 */
export function formatTaskPlanChecklist(plan: TaskPlan | undefined): string {
  const items = (plan?.items ?? []).filter(
    (it) => !!it && typeof it.id === 'string' && it.id !== '' && it.description.trim() !== '',
  );
  if (items.length === 0) return '';
  const lines = items.map((it) => {
    const status = (it.status ?? '').trim().toLowerCase() || 'pending';
    return `- [#${it.id}] [${status}] ${it.description}`;
  });
  return (
    '\n\n## Task Plan\n\n' +
    'Work through the following steps in order. Continue executing incomplete items before ending your turn.\n\n' +
    lines.join('\n') +
    (plan?.currentFocus ? `\n\nCurrent focus: #${plan.currentFocus}` : '')
  );
}

/** FR-2 完成确认：「包含 DONE（精确匹配）」= 大小写敏感整词命中。 */
function isDoneReply(content: string | null | undefined): boolean {
  return typeof content === 'string' && /\bDONE\b/.test(content);
}

/** FR-3 reminder 渲染（占位符用 split/join，避免依赖 ES2021 replaceAll）。 */
function renderProgressReminder(template: string, turn: number, maxTurns: number, completedSteps: number): string {
  return template
    .split('{turn}').join(String(turn))
    .split('{maxTurns}').join(String(maxTurns))
    .split('{completedSteps}').join(String(completedSteps));
}

/** 跨内部重启聚合 usage（每个内部 agentLoop 只报自己那段的累计）。 */
function mergeUsageSummary(base: UsageSummary | null, inc: UsageSummary | undefined): UsageSummary | null {
  if (!inc) return base;
  if (!base) {
    return {
      ...inc,
      tokens: { ...inc.tokens },
      byModel: Object.fromEntries(Object.entries(inc.byModel ?? {}).map(([k, v]) => [k, { ...v }])),
    };
  }
  const tokens: UsageSummary['tokens'] = {
    prompt_tokens: (base.tokens.prompt_tokens ?? 0) + (inc.tokens.prompt_tokens ?? 0),
    completion_tokens: (base.tokens.completion_tokens ?? 0) + (inc.tokens.completion_tokens ?? 0),
    total_tokens: (base.tokens.total_tokens ?? 0) + (inc.tokens.total_tokens ?? 0),
  };
  if (base.tokens.reasoning_tokens !== undefined || inc.tokens.reasoning_tokens !== undefined) {
    tokens.reasoning_tokens = (base.tokens.reasoning_tokens ?? 0) + (inc.tokens.reasoning_tokens ?? 0);
  }
  const byModel: UsageSummary['byModel'] = { ...base.byModel };
  for (const [m, v] of Object.entries(inc.byModel ?? {})) {
    const cur = byModel[m];
    byModel[m] = cur
      ? {
          prompt_tokens: (cur.prompt_tokens ?? 0) + (v.prompt_tokens ?? 0),
          completion_tokens: (cur.completion_tokens ?? 0) + (v.completion_tokens ?? 0),
          total_tokens: (cur.total_tokens ?? 0) + (v.total_tokens ?? 0),
        }
      : { ...v };
  }
  return {
    calls: (base.calls ?? 0) + (inc.calls ?? 0),
    tokens,
    byModel,
    partial: !!base.partial || !!inc.partial,
  };
}

/**
 * TC-001 harness 包装器：在宿主侧实现每轮消息注入。
 *
 * - 每次内部 agentLoop 以 maxTurns=1 运行：要么模型 end_turn（loop_end 'done'），
 *   要么执行完工具待回喂（loop_end 'max_turns'）。
 * - 中间 loop_end 一律吞掉（下游 SSE 转换器遇首个 loop_end 即终止流），usage
 *   聚合后在真正终态时合成唯一 loop_end 向下转发。
 * - 注入顺序：FR-1 计划锚点（有变化时）→ FR-2 判定提示 → FR-3 reminder，
 *   合并为一条 user 消息追加到重建的历史末尾。
 * - end_turn 边界只有 FR-2 显式开启才续跑（避免复活自然结束的会话）；
 *   reminder 只在本来就要继续的边界附带（短任务零影响）。
 *
 * loopFactory 参数仅供测试注入桩循环；生产路径用默认 agentLoop。
 */
export async function* runHarnessAgentLoop(
  options: AgentLoopOptions,
  harness: HarnessOptions,
  loopFactory: (opts: AgentLoopOptions) => AsyncGenerator<AgentEvent> = agentLoop,
): AsyncGenerator<AgentEvent> {
  const maxTurnsGlobal = Math.max(1, options.maxTurns ?? 25);
  const interval = Math.max(1, harness.progress_reminder_interval ?? DEFAULT_PROGRESS_REMINDER_INTERVAL);
  const maxJudgeRounds = Math.max(0, harness.continue_max_rounds ?? DEFAULT_CONTINUE_MAX_ROUNDS);
  const fr2Active = harness.continue_on_incomplete === true;
  const checkPrompt = harness.incomplete_check_prompt ?? harness.continue_prompt ?? INCOMPLETE_CHECK_PROMPT;
  const reminderTemplate = harness.progress_reminder_template ?? PROGRESS_REMINDER_TEMPLATE;
  const planItems = (harness.task_plan?.items ?? []).filter((it) => !!it && typeof it.id === 'string' && it.id !== '');
  const hasPlan = planItems.length > 0;

  // 重建的对话历史（system prompt 由每次重启的内部循环自行注入，这里不含 system 消息；
  // 原始数组不被修改，session 自动保存路径不受影响 —— task_plan 内容不落盘）。
  let messages: Message[] = [...(options.messages ?? [])];
  let globalTurn = 0;
  let toolExecCount = 0;
  let judgeRoundsUsed = 0;
  let continueRounds = 0;
  let lastPlanSnapshot: string | null = null;
  let usage: UsageSummary | null = null;
  // 已发出但尚未回喂结果的 tool_call（tool_blocked 事件不带 id，按名关联回填）
  let openCalls: Array<{ id: string; name: string }> = [];

  while (true) {
    let endReason = 'done';
    let finishReason: string | undefined;
    let lastAssistantContent: string | null = null;

    for await (const ev of loopFactory({ ...options, messages, maxTurns: 1 })) {
      switch (ev.type) {
        case 'request_start':
          globalTurn++;
          break;
        case 'assistant_message':
          lastAssistantContent = ev.content;
          messages = [
            ...messages,
            ev.tool_calls && ev.tool_calls.length > 0
              ? { role: 'assistant' as const, content: ev.content, tool_calls: ev.tool_calls }
              : { role: 'assistant' as const, content: ev.content },
          ];
          openCalls = (ev.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name }));
          break;
        case 'tool_call':
          // 兜底登记（正常情况下 assistant_message 已带齐 tool_calls）
          if (!openCalls.some((c) => c.id === ev.id)) openCalls.push({ id: ev.id, name: ev.name });
          break;
        case 'tool_result':
          toolExecCount++;
          messages = [...messages, { role: 'tool' as const, tool_call_id: ev.tool_call_id, content: ev.content }];
          openCalls = openCalls.filter((c) => c.id !== ev.tool_call_id);
          break;
        case 'tool_blocked': {
          // 权限拦截的工具不会产生 tool_result 事件，但内部循环会把错误结果写进
          // 消息历史 —— 这里必须同步补上，否则重建历史缺少 tool 回执会导致下一轮
          // 请求违反 provider 协议（tool_use 必须有配对的 tool result）。
          let matchIdx = -1;
          for (let i = openCalls.length - 1; i >= 0; i--) {
            if (openCalls[i].name === ev.tool_name) { matchIdx = i; break; }
          }
          if (matchIdx >= 0) {
            const call = openCalls[matchIdx];
            messages = [
              ...messages,
              {
                role: 'tool' as const,
                tool_call_id: call.id,
                content: JSON.stringify({ error: `Tool "${ev.tool_name}" blocked: ${ev.reason}` }),
              },
            ];
            openCalls.splice(matchIdx, 1);
          }
          break;
        }
        case 'loop_end':
          // 吞掉内部 loop_end；记录终态信号并聚合 usage
          endReason = ev.reason;
          finishReason = ev.finish_reason;
          usage = mergeUsageSummary(usage, ev.usageSummary);
          continue; // 不向下游转发
        default:
          break;
      }
      yield ev;
    }

    const endedWithToolRound = endReason === 'max_turns'; // maxTurns=1 下 = 本轮执行了工具、结果待回喂
    const endedWithEndTurn = endReason === 'done';

    if (!endedWithToolRound && !endedWithEndTurn) {
      // error / aborted：终态透传（合成唯一 loop_end）
      yield {
        type: 'loop_end',
        reason: endReason,
        finish_reason: finishReason,
        usageSummary: usage ?? undefined,
      } as AgentEvent;
      return;
    }

    // FR-2 DONE 短路：模型明确回复 DONE → 正常返回结果给调用方
    if (fr2Active && endedWithEndTurn && isDoneReply(lastAssistantContent)) {
      yield {
        type: 'loop_end',
        reason: 'done',
        finish_reason: finishReason,
        usageSummary: usage ?? undefined,
      } as AgentEvent;
      return;
    }

    // 本轮边界的注入内容（合并为一条 user 消息）
    const sections: string[] = [];

    // FR-1：计划锚点（未全部完成且有变化时注入；全部 done 后不再注入）
    if (hasPlan) {
      const allDone = planItems.every((it) => it.status === 'done');
      const snapshot = serializeTaskPlan(harness.task_plan!);
      if (!allDone && snapshot !== lastPlanSnapshot) {
        sections.push(formatTaskPlanProgress(harness.task_plan!));
        lastPlanSnapshot = snapshot;
      }
    }

    // 续跑判定：工具轮自然续跑；end_turn 只有 FR-2 开启且判定预算未尽才续跑
    let willContinue = false;
    if (endedWithToolRound) {
      willContinue = globalTurn < maxTurnsGlobal;
    } else if (fr2Active && judgeRoundsUsed < maxJudgeRounds && globalTurn < maxTurnsGlobal) {
      judgeRoundsUsed++;
      willContinue = true;
      sections.push(checkPrompt);
    }

    // FR-3：reminder 只在本来就要继续的边界附带（< interval 或自然结束 → 零注入）
    const reminderDue = globalTurn > 0 && globalTurn % interval === 0;
    if (willContinue && reminderDue) {
      sections.push(renderProgressReminder(reminderTemplate, globalTurn, maxTurnsGlobal, toolExecCount));
    }

    if (!willContinue) {
      yield {
        type: 'loop_end',
        reason: endedWithEndTurn ? 'done' : 'max_turns',
        finish_reason: finishReason,
        usageSummary: usage ?? undefined,
      } as AgentEvent;
      return;
    }

    if (sections.length > 0) {
      messages = [...messages, { role: 'user' as const, content: sections.join('\n\n') }];
    }
    continueRounds++;
    yield { type: 'continue_round', round: continueRounds, turn: globalTurn + 1 } as AgentEvent;
  }
}

// ── C15 v2: Compacting agent loop wrapper ──
// Wraps agentLoop with auto-compaction: monitors cumulative prompt tokens
// via loop_end.usageSummary, triggers compactViaModelClient (direct ModelClient,
// no HTTP → no circular dependency), injects summary as system context, restarts.
// Stops after maxRestarts to prevent infinite loop.

const COMPACT_TOKEN_THRESHOLD = 90_000; // ~70% of 128K context
const MAX_COMPACT_RESTARTS = 3;

async function* runCompactingAgentLoop(
  options: AgentLoopOptions,
  logger = (msg: string) => console.log(msg),
): AsyncGenerator<AgentEvent> {
  let currentOptions = { ...options };
  let accumulatedPromptTokens = 0;
  let restartCount = 0;

  while (restartCount <= MAX_COMPACT_RESTARTS) {
    let loopHadContent = false;
    let loopPromptTokens = 0;

    for await (const event of agentLoop(currentOptions)) {
      // Track token usage from loop_end
      if (event.type === 'loop_end' && event.usageSummary) {
        loopPromptTokens = event.usageSummary.tokens.prompt_tokens;
      }
      if (event.type === 'content_delta' || event.type === 'assistant_message') {
        loopHadContent = true;
      }
      yield event;
    }

    if (!loopHadContent) break; // empty loop, no point compacting

    accumulatedPromptTokens += loopPromptTokens;

    // Check compaction threshold
    if (accumulatedPromptTokens > COMPACT_TOKEN_THRESHOLD) {
      logger(`[trilc:compact] auto-trigger: ${accumulatedPromptTokens} tokens > ${COMPACT_TOKEN_THRESHOLD} threshold`);

      const compactable = (currentOptions.messages ?? [])
        .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

      if (compactable.length < 3) {
        logger('[trilc:compact] not enough messages to compact, continuing');
        break;
      }

      try {
        const { compactViaModelClient } = await import('../services/compact/compact.js');
        const result = await compactViaModelClient(compactable);

        // Inject summary + keep last 2 messages for context
        currentOptions = {
          ...currentOptions,
          systemPrompt: `[Compact summary]\n${result.summary}\n\n---\n\n${currentOptions.systemPrompt ?? ''}`,
          messages: [
            ...(currentOptions.messages ?? []).slice(-2),
          ],
        };
        accumulatedPromptTokens = 0;
        restartCount++;
        yield { type: 'compaction', message: `Compacted: removed ~${result.tokensRemoved} tokens, ${compactable.length} messages → summary ${result.summary.length} chars` } as unknown as AgentEvent;
        logger(`[trilc:compact] done: removed ~${result.tokensRemoved} tokens, restart #${restartCount}`);
        continue; // restart loop with compacted context
      } catch (err) {
        logger(`[trilc:compact] failed: ${(err as Error).message}, continuing uncompacted`);
        yield { type: 'compaction_failed', message: (err as Error).message } as unknown as AgentEvent;
        break; // give up, continue with full context
      }
    }

    break; // normal completion, no compaction needed
  }

  if (restartCount > MAX_COMPACT_RESTARTS) {
    logger(`[trilc:compact] max restarts (${MAX_COMPACT_RESTARTS}) reached, giving up`);
  }
}

/** P3: onPermissionAsk bridge — routes 'ask' decisions to the TUI. */
async function askPermissionViaTui(
  toolName: string,
  args: Record<string, unknown>,
  reason?: string,
): Promise<'allow' | 'deny' | 'always'> {
  if (isAlwaysAllowed(toolName)) return 'allow';
  const verdict = await requestInteraction(
    'permission',
    { toolName, argsSummary: summarizeToolArgs(toolName, args), reason },
    120_000, // 2min timeout → fail closed (deny)
    'deny',
  );
  if (verdict === 'always') {
    rememberAlwaysAllow(toolName);
    return 'allow';
  }
  return verdict === 'allow' ? 'allow' : 'deny';
}

// ── ConnectionManager ──
// Tracks TriMC reachability for fast fallback decisions.
// CTO-008-M spec: 3 consecutive failures → DEGRADED → 2 consecutive successes → CONNECTED
// Uses POST /internal/v1/heartbeat with node metadata instead of bare GET /healthz.
// On recovery (DEGRADED→CONNECTED), triggers event replay via POST /internal/v1/events/replay.
//
// Heartbeat Wake (absorbed from openclaw heartbeat-wake pattern):
// - requestHeartbeatNow(): on-demand trigger with coalescing (250ms window)
// - Priority coalescing: retry < interval < default < action
// - Retry backoff: 1s cooldown on failure prevents collapse
// - enable/disable toggle for graceful shutdown

type ConnectionState = 'connected' | 'degraded' | 'local';

// Replay event item type alias from shared types
type ReplayEventItem = ReplayRequest['events'][number];

interface ConnectionManagerOptions {
  nodeId: string;
  version: string;
  intervalMs?: number;
  /** 2.5: Initial connection state (default: 'degraded').
   *  Use 'local' when trimcBaseUrl is empty — daemon runs standalone. */
  initialState?: ConnectionState;
  queueSize?: () => number;
  getPendingForReplay?: (connectionId: string, limit?: number) => ReplayEventItem[];
  applyReplayResponse?: (connectionId: string, res: ReplayResponse, events: ReplayEventItem[]) => void;
}

// ── ConnectionManager (2.5: local state + persistence + backoff) ──

class ConnectionManager {
  private state: ConnectionState;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private readonly failThreshold = 3;
  private readonly recoverThreshold = 2;
  private readonly DEGRADED_BACKOFF_MS = 5 * 60 * 1000; // 2.5: slow heartbeat after 5 min degraded
  private readonly DEGRADED_SLOW_INTERVAL_MS = 60_000; // 2.5: 60s interval when degraded > 5 min
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private readonly trimcBaseUrl: string;
  private healthCheckIntervalMs: number;
  private readonly nodeId: string;
  private readonly version: string;
  private startTime: number;
  private degradedAt: number | null = null; // 2.5: timestamp when degraded started
  private _queueSize: () => number;
  private _getPendingForReplay: (connectionId: string, limit?: number) => ReplayEventItem[];
  private _applyReplayResponse: (connectionId: string, res: ReplayResponse, events: ReplayEventItem[]) => void;
  private recoveryCallback: (() => void) | null = null;
  private stateFile: string | null = null; // 2.5: persistence file path

  // ── Heartbeat Wake (CTO-008-M Phase 1: extracted to heartbeat-wake module) ──
  private wake = createHeartbeatWake();

  constructor(trimcBaseUrl: string, opts: ConnectionManagerOptions) {
    this.trimcBaseUrl = trimcBaseUrl;
    this.state = opts.initialState ?? 'degraded';
    this.nodeId = opts.nodeId;
    this.version = opts.version;
    this.healthCheckIntervalMs = opts.intervalMs ?? 10_000;
    this._queueSize = opts.queueSize ?? (() => 0);
    this._getPendingForReplay = opts.getPendingForReplay ?? (() => []);
    this._applyReplayResponse = opts.applyReplayResponse ?? (() => {});
    this.startTime = Date.now();
    if (this.state === 'local') {
      console.log('[trilc:conn] running in local mode — TriMC not configured');
    }
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  recordSuccess(): void {
    const wasDegraded = this.state === 'degraded';
    this.consecutiveFailures = 0;
    if (this.state === 'degraded') {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.recoverThreshold) {
        this.state = 'connected';
        this.consecutiveSuccesses = 0;
        this.degradedAt = null; // 2.5: clear degraded timer
        this.healthCheckIntervalMs = 10_000; // 2.5: restore normal interval
        console.log('[trilc:conn] recovered → connected');
        this.persistState();
        publish({ type: 'node:connected' });
        this._performReplay().catch((err) => {
          console.error('[trilc:conn] replay failed:', err instanceof Error ? err.message : String(err));
        });
        if (this.recoveryCallback) this.recoveryCallback();
      }
    }
  }

  recordFailure(): void {
    this.consecutiveSuccesses = 0;
    if (this.state === 'connected') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.failThreshold) {
        this.state = 'degraded';
        this.consecutiveFailures = 0;
        this.degradedAt = Date.now(); // 2.5: track when degraded started
        console.log('[trilc:conn] degraded → will use local fallback');
        this.persistState();
        publish({ type: 'node:degraded' });
      }
    } else if (this.state === 'degraded') {
      // 2.5: degraded backoff — after 5 min, slow heartbeat to 60s
      if (this.degradedAt && (Date.now() - this.degradedAt > this.DEGRADED_BACKOFF_MS)) {
        this.healthCheckIntervalMs = this.DEGRADED_SLOW_INTERVAL_MS;
      }
    }
  }

  // Send enhanced heartbeat to TriMC POST /internal/v1/heartbeat
  async checkHealth(): Promise<boolean> {
    try {
      const ok = await postHeartbeat(this.trimcBaseUrl, {
        nodeId: this.nodeId,
        state: this.state,
        queueSize: this._queueSize(),
        uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        agentCoreVersion: this.version,
      });
      if (ok) {
        this.recordSuccess();
        return true;
      } else {
        this.recordFailure();
        return false;
      }
    } catch {
      this.recordFailure();
      return false;
    }
  }

  startHealthCheckLoop(): void {
    if (this.healthCheckTimer) return;

    // Register wake handler that delegates to checkHealth
    this.wake.setWakeHandler(async () => {
      const ok = await this.checkHealth();
      return ok
        ? { status: "ran" as const, durationMs: 0 }
        : { status: "failed" as const, reason: "health check failed" };
    });

    this.healthCheckTimer = setInterval(() => {
      if (this.wake.isEnabled()) {
        this.wake.requestHeartbeatNow({ reason: 'interval' });
      }
    }, this.healthCheckIntervalMs);

    // Immediate first check
    if (this.wake.isEnabled()) {
      this.wake.requestHeartbeatNow({ reason: 'interval', coalesceMs: 0 });
    }
  }

  stopHealthCheckLoop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    // Clear wake handler — handles all internal timer/pending/state cleanup
    this.wake.setWakeHandler(null);
  }

  // ── Heartbeat Wake (delegated to heartbeat-wake module) ──

  /** Enable or disable heartbeat checks (periodic + on-demand). */
  setHeartbeatsEnabled(enabled: boolean): void {
    this.wake.setEnabled(enabled);
  }

  /** Check if heartbeats are enabled. */
  areHeartbeatsEnabled(): boolean {
    return this.wake.isEnabled();
  }

  /**
   * Request an immediate heartbeat check with coalescing (delegated to wake module).
   * Multiple rapid calls within coalesce window (250ms) are merged.
   * Higher priority reasons preempt lower ones.
   */
  requestHeartbeatNow(opts?: { reason?: string; coalesceMs?: number }): void {
    this.wake.requestHeartbeatNow(opts);
  }

  /** Check if a wake is pending (timer scheduled or queued). */
  hasPendingWake(): boolean {
    return this.wake.hasPendingWake();
  }

  // Register callback for post-recovery actions (e.g., reset connectionId)
  onRecovered(cb: () => void): void {
    this.recoveryCallback = cb;
  }

  // Replay pending events to TriMC after recovery from degraded state
  private async _performReplay(): Promise<void> {
    // Use internal connectionId tracker set in createTriLCApp
    const cid = (this as unknown as { __connectionId: string }).__connectionId ?? '';
    const events = this._getPendingForReplay(cid);
    if (events.length === 0) {
      console.log('[trilc:conn] replay: no pending events');
      return;
    }
    console.log(`[trilc:conn] replay: replaying ${events.length} events`);
    try {
      const response = await postReplay(this.trimcBaseUrl, {
        nodeId: this.nodeId,
        connectionId: cid,
        events,
      });
      this._applyReplayResponse(cid, response, events);
      console.log(`[trilc:conn] replay: accepted=${response.accepted} conflicts=${response.conflicts.length}`);
    } catch (err) {
      console.error('[trilc:conn] replay request failed:', err instanceof Error ? err.message : String(err));
    }
  }

  // ── 2.5: State persistence ──

  /** Enable state persistence to {dataDir}/connection-state.json */
  enablePersistence(dataDir: string): void {
    this.stateFile = dataDir.replace(/\\/g, '/') + '/connection-state.json';
    this.restoreState();
    this.persistState();
  }

  private persistState(): void {
    if (!this.stateFile) return;
    try {
      const { mkdirSync, writeFileSync } = require('node:fs');
      const { dirname } = require('node:path');
      const dir = dirname(this.stateFile);
      if (!require('node:fs').existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.stateFile, JSON.stringify({
        state: this.state,
        lastStateChange: new Date().toISOString(),
        consecutiveFailures: this.consecutiveFailures,
        degradedAt: this.degradedAt ? new Date(this.degradedAt).toISOString() : null,
      }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    } catch { /* best-effort */ }
  }

  private restoreState(): void {
    if (!this.stateFile) return;
    try {
      const { existsSync, readFileSync } = require('node:fs');
      if (!existsSync(this.stateFile)) return;
      const raw = readFileSync(this.stateFile, 'utf-8');
      const saved = JSON.parse(raw) as { state?: string; consecutiveFailures?: number; degradedAt?: string };
      if (saved.state && (saved.state === 'connected' || saved.state === 'degraded' || saved.state === 'local')) {
        this.state = saved.state;
        this.consecutiveFailures = saved.consecutiveFailures ?? 0;
        console.log(`[trilc:conn] restored state: ${this.state} (from ${this.stateFile})`);
      }
    } catch { /* ignore corrupt file */ }
  }

  /** 2.5: Get state info for task/submit response notification. */
  getStateInfo(): { connectionState: ConnectionState; warning?: string } {
    if (this.state === 'degraded') {
      return { connectionState: 'degraded', warning: 'TriMC unreachable, using local fallback' };
    }
    if (this.state === 'local') {
      return { connectionState: 'local', warning: 'TriMC not configured, running standalone' };
    }
    return { connectionState: 'connected' };
  }

  // Allow setting connectionId externally (used by createTriLCApp)
  _setConnectionId(id: string): void {
    (this as unknown as { __connectionId: string }).__connectionId = id;
  }
}

function postHeartbeat(baseUrl: string, hb: {
  nodeId: string;
  state: string;
  queueSize: number;
  uptimeSeconds: number;
  agentCoreVersion: string;
}, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const urlObj = new URL('/internal/v1/heartbeat', baseUrl);
    const reqFn = urlObj.protocol === 'https:' ? httpsRequest : httpRequest;
    const body = JSON.stringify(hb);
    const req = reqFn(
      {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          // P0 加固配套：TriMMC /internal token 门（原生 http.request 不经全局
          // fetch 包装，需在此显式附头；未配置时零行为变化）
          ...(process.env.TRIMC_INTERNAL_TOKEN
            ? { 'X-Internal-Token': process.env.TRIMC_INTERNAL_TOKEN }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            resolve(data.ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ── Post replay events to TriMC ──
// CTO-008-M §3.3.2. Sends queued offline events to TriMC for merge/arbitration.
async function postReplay(
  baseUrl: string,
  payload: { nodeId: string; connectionId: string; events: ReplayEventItem[] },
  timeoutMs = 10_000,
): Promise<ReplayResponse> {
  const urlObj = new URL('/internal/v1/events/replay', baseUrl);
  const reqFn = urlObj.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = reqFn(
      {
        method: 'POST',
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body).toString(),
          // P0 加固配套：TriMMC /internal token 门（原生 http.request 不经全局
          // fetch 包装，需在此显式附头；未配置时零行为变化）
          ...(process.env.TRIMC_INTERNAL_TOKEN
            ? { 'X-Internal-Token': process.env.TRIMC_INTERNAL_TOKEN }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            reject(new Error('invalid replay response'));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('replay timeout'));
    });
    req.write(body);
    req.end();
  });
}

// ── Proxy agent request to TriMC ──
// Used as inline logic in the request handler; kept here for potential standalone usage.

// ── Task stream state ──
// In-memory registry of submitted tasks awaiting SSE stream consumption.
// Tasks are created on POST /tasks/submit and executed when SSE client connects.
interface TaskStreamEntry {
  sessionId: string;
  message: string;
  conversationId: string;
  model: string;
  systemPrompt: string;
  context: { files: string[]; workspaceRoot: string };
  createdAt: number;
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled';
  progress?: { step: number; totalSteps: number; description: string };
}

// ── S7: Mirror helpers ──
// Map TaskStreamEntry status to mirror task status.
function mapStreamStatus(s: TaskStreamEntry['status']): MirrorTaskSnapshot['status'] {
  switch (s) {
    case 'pending':   return 'pending';
    case 'running':   return 'running';
    case 'done':      return 'success';
    case 'error':     return 'failed';
    case 'cancelled': return 'cancelled';
  }
}

function buildSummary(entry: TaskStreamEntry): string {
  if (entry.progress) {
    return `${entry.progress.description} (${entry.progress.step}/${entry.progress.totalSteps})`;
  }
  if (entry.status === 'done') return 'Task completed';
  if (entry.status === 'error') return 'Task failed';
  if (entry.status === 'cancelled') return 'Cancelled by user';
  return entry.message.slice(0, 200);
}

export function createTriLCApp(env: TriLCEnv) {
  let server: Server | null = null;
  let daemonStartTime = 0;
  const eventQueue = createEventQueue({
    dbPath: `${env.dataDir}/event-queue.db`,
  });
  const sessionStore = createSessionStore(`${env.dataDir}/sessions.db`);
  // ── LG-026 信件 DB（P2-B1：端点挂通用面双实例可用，P4 互备基座）──
  // leaderId 与组长 agentId 同源 LEAD_AGENT_ID（单一来源常量，防两处漂移）。
  const letterStore = createLetterStore(`${env.dataDir}/letters.db`, { leaderId: LEAD_AGENT_ID });

  // ── Init Chain（链路进度状态机；与公司态 CompanyInitState 分离独立持久）──
  // 事件经 publish 同通道发布（init:chain-changed / init:selfcheck-* / init:step-event 族）。
  const initChain = new InitChain(env.dataDir, { onEvent: publish });
  // SELFCHECK 依赖（第五探测构造 TriPilot 形态会话：客户端 systemPrompt 走
  // tasks/submit 追加周平面提示的路径 — r4-1 B 族注入面）。
  const selfcheckDeps: SelfcheckDeps = {
    port: env.port,
    projectRoot: env.projectRoot,
    dataDir: env.dataDir,
    chain: initChain,
    publish,
    probeSystemPrompt: '你是 TriCade 的安装初始化自检会话（selfcheck 第五探测构造面）。规则：只允许使用 LS/Read 工具查看当前工作区文件（最多 3 次）；禁止使用 shell_exec/Bash/Grep 等其他工具；然后务必以一段简短中文文字总结你观察到的内容作为最终回答——绝不要以工具调用结束（无最终文本=伪失败）。',
  };

  // ── 公司态 + 装配执行体（i2-1 §一：daemon 端点单执行体；两入口只发指令）──
  const companyInitState = new CompanyInitState(env.dataDir, env.projectRoot ?? env.cwd);
  const assembleDeps: AssembleDeps = {
    dataDir: env.dataDir,
    workspaceRoot: env.projectRoot ?? env.cwd,
    chain: initChain,
    companyState: companyInitState,
    publish,
    getRoleCatalog: () => {
      try {
        return getContractResolver().getRoleCatalog();
      } catch {
        return null; // resolver 未初始化 → 端点层映射 503，不开天窗
      }
    },
  };

  // ── 项目面执行体（I3：注册点 + link/claim/inspect；daemon 单执行体，
  // git 单身份）── 注册点固定路径 %LOCALAPPDATA%\trilc\project-registry.json
  // （不随 TRILC_DATA_DIR 覆盖；TRILC_PROJECT_REGISTRY 仅测试隔离）。
  const projectRegistry = new ProjectRegistry();
  const projectLinkDeps: ProjectLinkDeps = {
    registry: projectRegistry,
    chain: initChain,
    publish,
    git: createGitRunner(),
  };

  // ── 候选岗位发布执行体（FADE-004：员工上岗 = JD 进在岗名册；分身另走 clone 协议）──
  const staffingDeps: StaffingDeps = {
    dataDir: env.dataDir,
    companyState: {
      load: () => companyInitState.load(),
      save: (next) => companyInitState.save(next),
    },
    chain: {
      getState: () => initChain.getState(),
    },
    getRoleCatalog: () => {
      try {
        return getContractResolver().getRoleCatalog();
      } catch {
        return null;
      }
    },
    publish,
  };

  // ── 五维同步执行体（I4：sync/run 生成/commit/push 链；daemon 单执行体，
  // git 固定身份 D2）── 两入口只发指令，零本地执行。
  const initSyncDeps: InitSyncDeps = {
    dataDir: env.dataDir,
    chain: initChain,
    companyState: companyInitState,
    registry: projectRegistry,
    publish,
    trimcBaseUrl: env.trimcBaseUrl,
    trilcVersion: env.version,
    nodeId: env.nodeId,
    tricompanySourcePath: env.tricompanySourcePath,
    git: createGitRunner(),
    getKeyCache: () => getKeyCache(),
    fetchModels: () => getAvailableModels(),
    getRoleCatalog: () => {
      try {
        return getContractResolver().getRoleCatalog();
      } catch {
        return null; // resolver 未初始化 → employees 维 roleId 校验跳过
      }
    },
  };

  // ── Notifications (REQ-021) ──
  // In-memory + persisted to {dataDir}/notifications.json for client pulls.
  const noticeFile = join(env.dataDir, 'notifications.json');
  const notices: Array<{ id: string; title: string; body: string; context: string; createdAt: string; read: boolean }> = [];
  (async () => {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(noticeFile, 'utf-8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) notices.push(...arr);
    } catch { /* no file yet */ }
  })();

  // ── Heartbeat Runner ──
  const heartbeatRunner: TriLCHeartbeatRunner = createHeartbeatRunner({
    sessionStore: {
      createSession(s) { sessionStore.createSession(s); },
      saveMessages(id, msgs) { sessionStore.saveMessages(id, msgs as any); },
      updateSessionStatus(id, status) { sessionStore.updateSessionStatus(id, status); },
    },
    cwd: env.cwd,
  });

  // ── Session Reaper ──
  const sessionReaper = createSessionReaper({
    storePath: `${env.dataDir}/sessions.db`,
  });

  // ── Minimal Cron Engine ──
  const cronEngine: MinimalCronEngine = createMinimalCronEngine({
    dataDir: env.dataDir,
    sessionStore: {
      createSession(s) { sessionStore.createSession(s); },
      saveMessages(id, msgs) { sessionStore.saveMessages(id, msgs as any); },
      updateSessionStatus(id, status) { sessionStore.updateSessionStatus(id, status); },
    },
    cwd: env.cwd,
    onJobTrigger(job) {
      publish({ type: 'cron:sweep', count: 1 });
      console.log(`[trilc:cron] job triggered: ${job.name}`);
    },
    // FADE-ASSESS-005 调度门禁：绑定 roleId 的 job 拉起 agent 前校验 roster.active。
    isRoleActive: async (roleId) => isRoleActive(staffingDeps, roleId),
    // FADE-ASSESS-003 小乔指标：调度路由到未在岗岗 → routing_error 埋点（轻量）
    onRoleGateDenied: (roleId) => {
      recordKnowledgeMetric({
        projectRoot: env.projectRoot,
        event: 'routing_error',
        agentId: roleId,
        detail: 'cron_owner_not_active',
      });
    },
  });
  const taskStreams = new Map<string, TaskStreamEntry>();
  let connectionId = '';
  const resetConnectionId = () => {
    connectionId = `${env.nodeId}-${Date.now().toString(36)}`;
  };
  resetConnectionId();

  // 2.5: 'local' state when TriMC is not configured
  const isLocal = !env.trimcBaseUrl || env.trimcBaseUrl === 'http://localhost:8710' && !env.trimcBaseUrl;
  const connMgr = new ConnectionManager(env.trimcBaseUrl || 'http://localhost:8710', {
    nodeId: env.nodeId,
    version: env.version,
    initialState: isLocal ? 'local' : undefined,
    queueSize: () => eventQueue.getQueueSize(),
    getPendingForReplay: (cid, limit) => eventQueue.getPendingForReplay(cid, limit),
    applyReplayResponse: (cid, res, events) => eventQueue.applyReplayResponse(cid, res, events),
  });
  connMgr.enablePersistence(env.dataDir);

  // Wire connectionId into ConnectionManager for replay
  connMgr._setConnectionId(connectionId);
  connMgr.onRecovered(() => {
    // On recovery, reset connectionId so replay events are scoped to new session
    resetConnectionId();
    connMgr._setConnectionId(connectionId);
    // S7: Full push on recovery
    mirrorPusher.onReconnected();
  });

  // ── S7: TaskMirrorPusher ──
  // Event-driven task state push to TriMC mirror endpoint.
  // Builds snapshots from taskStreams (in-memory) + sessionStore (persisted).
  const getActiveSnapshots = (): MirrorTaskSnapshot[] => {
    const snapshots: MirrorTaskSnapshot[] = [];

    // ① 从 taskStreams（内存中的活跃/近期任务）
    for (const [id, entry] of taskStreams) {
      snapshots.push({
        taskId: id,
        title: entry.message.slice(0, 80),
        status: mapStreamStatus(entry.status),
        summary: buildSummary(entry),
        updatedAt: new Date(entry.createdAt).toISOString(),
      });
    }

    // ② 从 sessionStore（持久化的 active/interrupted 会话，不在 taskStreams 中）
    const activeSessions = sessionStore.listSessions({ status: 'active', limit: 50 })
      .concat(sessionStore.listSessions({ status: 'interrupted', limit: 50 }));

    for (const s of activeSessions) {
      if (taskStreams.has(s.id)) continue; // 避免重复
      snapshots.push({
        taskId: s.id,
        title: s.title ?? 'Untitled',
        status: s.status === 'interrupted' ? 'failed' : 'running',
        summary: `${s.messageCount} messages`,
        updatedAt: s.updatedAt,
      });
    }

    return snapshots;
  };

  const mirrorPusher = new TaskMirrorPusher(
    env.trimcBaseUrl,
    env.nodeId,
    getActiveSnapshots,
  );

  // S7: Wire degraded → pause mirror push
  localBus.on('event', (event) => {
    if (event.type === 'node:degraded') mirrorPusher.onDegraded();
  });

  // ── ACT2: Update check handler ──
  const updateCheckHandler = createUpdateCheckHandler({
    repo: process.env.TRILC_GITHUB_REPO ?? 'MoRen9527/TriLC',
  });
  let updateCheckLoop: { stop: () => void } | null = null;

  return {
    async start(): Promise<void> {
      daemonStartTime = Date.now();
      connMgr.startHealthCheckLoop();

      // FADE-ASSESS-005 分身门禁注入：AgentTool spawn 合同岗时读运行态名册
      // （CompanyInitState.employees 为在岗真源，roster.status 语义见 staffing.ts）。
      setRosterGate(async (roleId) => {
        const status = await getRoleRosterStatus(staffingDeps, roleId);
        return { status };
      });
      // FADE-ASSESS-003 小乔指标：spawn 路由到未在岗岗 → routing_error 埋点（轻量）
      setOnSpawnGateDenied((roleId, status) => {
        recordKnowledgeMetric({
          projectRoot: env.projectRoot,
          event: 'routing_error',
          agentId: roleId,
          detail: `spawn_gate_denied:${status}`,
        });
      });

      // P4.2: Register shell_exec tool backed by ProcessSupervisor
      registerShellExecTool({ supervisor: getDefaultSupervisor() });

      // 2.1/2.2: Post task result back to TriMC when connected or callback URL configured
      const postTaskResultToTriMC = async (
        sessionId: string, status: 'success' | 'failed', result?: string, error?: string,
      ): Promise<void> => {
        const callbackUrl = process.env.TRILC_TRIMC_CALLBACK_URL
          ?? (connMgr.currentState === 'connected' ? `${env.trimcBaseUrl}/internal/v1/tasks/result` : null);
        if (!callbackUrl) return;
        try {
          await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, status, result, error }),
          });
          console.log(`[trilc:task] result posted to TriMC: ${sessionId} status=${status}`);
        } catch (err) {
          console.warn(`[trilc:task] failed to post result to TriMC: ${(err as Error).message}`);
        }
      };

      // Step 2: Set TriModel API URL for HTTP-priority model fetching
      setTrimodelApiUrl(env.trimodelApiUrl);

      // C8: Read default permission mode from CLI/env (backward-compat: bypassPermissions)
      if (process.env.TRILC_PERMISSION_MODE) {
        _defaultPermissionMode = resolvePermissionMode(process.env.TRILC_PERMISSION_MODE);
        console.log(`[trilc] permission mode: ${_defaultPermissionMode} (from TRILC_PERMISSION_MODE)`);
      }

      // C9: Read CLI allow/deny rules, additional dirs, and print mode from env
      _cliAllowRulePatterns = parseRuleListEnv(process.env.TRILC_ALLOW_RULES);
      _cliDenyRulePatterns = parseRuleListEnv(process.env.TRILC_DENY_RULES);
      _cliAdditionalDirs = parseStringListEnv(process.env.TRILC_ADD_DIRS);
      _printMode = process.env.TRILC_PRINT_MODE === '1';

      if (_cliAllowRulePatterns.length > 0 || _cliDenyRulePatterns.length > 0) {
        console.log(`[trilc] CLI rules: ${_cliAllowRulePatterns.length} allow, ${_cliDenyRulePatterns.length} deny`);
      }
      if (_cliAdditionalDirs.length > 0) {
        console.log(`[trilc] additional dirs: ${_cliAdditionalDirs.join(', ')}`);
      }
      if (_printMode) {
        console.log('[trilc] print mode: non-interactive (-p), ask→deny enforced');
        // C9: -p forces non-interactive — if mode is bypass, must switch to default.
        // This is a safety enforcement: bypass mode requires user interaction for
        // safety-flagged tools, which is impossible in print mode.
        if (_defaultPermissionMode === 'bypassPermissions') {
          console.warn('[trilc] print mode: overriding bypassPermissions → default (bypass incompatible with -p)');
          _defaultPermissionMode = 'default';
        }
      }

      // C9: Load persisted permission rules from disk (both allow and deny)
      // and merge with CLI rules. CLI rules take precedence (checked first).
      try {
        const { loadPersistedRules } = await import('../services/permissions/PermissionStore.js');
        _persistedPermissionRules = loadPersistedRules();
        if (_persistedPermissionRules.length > 0) {
          console.log(`[trilc] loaded ${_persistedPermissionRules.length} persisted permission rules from disk`);
        }
      } catch (err) {
        console.warn('[trilc] failed to load persisted permission rules:', (err as Error).message);
      }

      // Step 2b: Initialize provider credentials before accepting model traffic.
      onKeyCacheUpdated(applyKeyCacheToEnvironment);
      await initKeyCache(env.trimodelApiUrl, env.dataDir, process.env.TRIMODEL_API_TOKEN);
      const initialKeyCache = getKeyCache();
      if (initialKeyCache) applyKeyCacheToEnvironment(initialKeyCache);

      // C12: Validate model registry at startup (after key cache → env applied).
      // Checks that fallback-target models are in the registry; WARNING on gaps,
      // never blocks startup. W30: "Unknown model" was a registry gap in prod.
      validateModelRegistry();

      // Phase 2: Initialize contract resolver (load agents from TriCompany)
      const agentCount = await getContractResolver(env.tricompanySourcePath).loadAll();
      console.log(`[trilc] contract resolver: ${agentCount} agents loaded`);

      // Phase 2.1: Load employee roster for display metadata
      const rosterCount = getContractResolver().loadEmployeeRoster();
      console.log(`[trilc] employee roster: ${rosterCount} employees loaded`);

      // Phase 2.2 (FADE-ASSESS-003): 知识注入 — daemon 启动全量同步
      // （loadAll() 之后；源只读；幂等：content_hash 相同跳过）。同步失败不阻断启动。
      try {
        const { syncKnowledgeFromSource } = await import('../knowledge-injector/sync.js');
        const knowledgeReport = syncKnowledgeFromSource({
          sourceRoot: env.tricompanySourcePath,
          projectRoot: env.projectRoot,
        });
        console.log(
          `[trilc] knowledge sync: ${knowledgeReport.inserted} inserted, ` +
          `${knowledgeReport.skipped} skipped, ${knowledgeReport.scanned} files` +
          (knowledgeReport.errors.length > 0 ? ` (${knowledgeReport.errors.length} errors)` : ''),
        );
        // watch 增量（设计挂接点②）：扩展后的 watchAndReload 监听三层知识文件。
        // 注：watchAndReload 此前无生产调用方（死代码），本次一并接线使增量路径生效。
        getContractResolver().watchAndReload(env.projectRoot);
      } catch (err) {
        console.warn('[trilc] knowledge sync failed (daemon continues):', (err as Error).message);
      }

      // Build assistant-facing agent roster (injected into system prompt).
      try {
        const resolver = getContractResolver();
        const lines: string[] = [];
        for (const id of resolver.listAgents()) {
          const rights = resolver.getDecisionRights(id);
          const hasPrompt = !!resolver.getSystemPrompt(id);
          // Use decision_rights to give the model context on what each agent can do
          const can = rights ? Object.entries(rights).filter(([,v]) => Array.isArray(v) && v.length > 0).map(([k]) => k).join('/') : '';
          lines.push(`- **${id}**${can ? ` (${can})` : ''}${hasPrompt ? '' : ''}`);
        }
        cachedAgentRoster = `\n\n## Available Sub-Agents (use AgentTool)\n\n` +
          `These agents are loaded from TriCompany. Use AgentTool with subagent_type set to an agent ID when the user asks to delegate work.\n\n` +
          lines.join('\n') +
          `\n- **code_explorer** — search codebases` +
          `\n- **test_runner** — run tests` +
          `\n- **file_processor** — transform files` +
          `\n- **code_reviewer** — review code` +
          `\n\nWhen the user says "let X handle this" or "have Y check it", find the matching agent above and call AgentTool.`;
      } catch { /* fall through */ }

      // ── LG-020 通道 Profile（TriMLC 本地通道 daemon，立法 2026-08-31）──
      // TRILC_CHANNEL_MODE=1：通道态——保留 healthz/心跳/收件箱/cron/session-reaper，
      // 关 agent 宿主能力（agentLoop 路由）；CC 交互会话与中枢会话=客户端连接（trilc chat 同款）。
      // 宿主能力不预建，需用时另批（CEO 立法令：通道态可执行普通程序，无 agent 宿主能力）。
      const channelMode = process.env.TRILC_CHANNEL_MODE === '1';

      server = createServer(async (req, res) => {
        // ── /healthz ──
        if (req.url === '/healthz') {
          const triMcOnline = connMgr.currentState === 'connected';
          const uptime = daemonStartTime > 0
            ? Math.floor((Date.now() - daemonStartTime) / 1000)
            : 0;
          let activeTasks = 0;
          for (const entry of taskStreams.values()) {
            if (entry.status === 'pending' || entry.status === 'running') activeTasks++;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            service: 'trilc',
            serverTime: new Date().toISOString(),
            trimc: triMcOnline ? 'connected' : 'degraded',
            uptime,
            activeTasks,
            queueSize: eventQueue.getQueueSize(),
            version: env.version,
            daemon: {
              mode: process.platform === 'win32' ? 'schtasks' : process.platform === 'darwin' ? 'launchd' : 'systemd',
            },
            heartbeat: {
              enabled: heartbeatRunner.isRunning,
              agentCount: 1, // default heartbeat agent
            },
            cron: {
              enabled: cronEngine.isRunning,
              jobCount: cronEngine.jobCount,
              degraded: cronEngine.isDegraded(),
              consecutiveFailures: cronEngine.consecutiveFailures,
            },
            sessionReaper: {
              enabled: sessionReaper.isRunning(),
            },
          }));
          return;
        }

        // ── P0 加固（p0fix3-trilc-http PD-1）：全局安全门，置于一切业务路由之前 ──
        // 顺序契约（文档化）：/healthz 精确豁免 → Host/Origin 白名单（403 先行，
        // 边界处先挡伪造来源）→ X-Internal-Token（401）→ 其余路由。
        //
        // Host 校验拒 DNS rebinding：listener 虽仅绑 127.0.0.1，但恶意网页可把
        // 自有域名解析到 127.0.0.1 从浏览器远端触达本面，故必须核对 Host 头。
        const gateRawHost = req.headers.host;
        if (typeof gateRawHost !== 'string' || !gateRawHost.trim()
            || !hostHeaderAllowed(gateRawHost, env.port)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden_host' }));
          return;
        }
        const gateRawOrigin = req.headers.origin;
        if (typeof gateRawOrigin === 'string' && gateRawOrigin.trim()
            && gateRawOrigin.trim().toLowerCase() !== 'null'
            && !originHeaderAllowed(gateRawOrigin, env.port)) {
          res.writeHead(403, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'forbidden_origin' }));
          return;
        }

        // X-Internal-Token 认证门（fail-closed）：参照 TriMC 的实现是「未配置
        // 即放行」的兼容变体；本面有三条任意命令执行通道，缺省必须全拒。
        // token 于请求期读取（不缓存启动快照），支持运行中注入测试。
        const gateInternalToken = process.env.TRILC_INTERNAL_TOKEN ?? '';
        const gateSuppliedToken = extractInternalToken(req.headers);
        if (!gateInternalToken) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_auth_disabled' }));
          return;
        }
        if (typeof gateSuppliedToken !== 'string'
            || !timingSafeStringEquals(gateSuppliedToken, gateInternalToken)) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized: missing or invalid X-Internal-Token' }));
          return;
        }

        // ── GET /internal/v1/init/chain/status ──
        // I1（init-collab-i1-statemachine）：链路进度状态机只读投影（两入口 +
        // 诊断卡数据源）。载荷 = 状态文件当前帧（i1-1 §四契约字段）。
        if (req.url === '/internal/v1/init/chain/status' && req.method === 'GET') {
          try {
            await initChain.load();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(initChain.toStatusPayload(env.debugMode)));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'init_chain_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/init/selfcheck/run ──
        // I1：触发五探测自检。202 { runId } 立即返回，检查过程经
        // init:selfcheck-* 事件流发布；并发防重入：运行中再触发 409 { runId }。
        if (req.url === '/internal/v1/init/selfcheck/run' && req.method === 'POST') {
          try {
            await initChain.load();
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'init_chain_unavailable', message: (err as Error).message }));
            return;
          }
          if (isSelfcheckRunning()) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ runId: getActiveRunId() }));
            return;
          }
          const started = beginSelfcheck(selfcheckDeps);
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ runId: started.runId }));
          return;
        }

        // ── GET /internal/v1/init/role-catalog ──
        // i2-1 §二：结构化员工选择载荷（只读展示数据源）。resolver 未初始化
        // 或 roster 缺失 → 503，不开天窗造数据。
        if (req.url === '/internal/v1/init/role-catalog' && req.method === 'GET') {
          try {
            const catalog = getContractResolver().getRoleCatalog();
            if (!catalog) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'role_catalog_unavailable', message: 'employee roster or agent contracts not loaded' }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(catalog));
          } catch (err) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'role_catalog_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/init/assemble ──
        // i2-1 §一：公司面装配端点（daemon 单执行体；两入口只发指令）。
        // 校验先行（400/422/409 矩阵见 init-assemble.ts）→ 预写段 → 提交段 → 事件。
        if (req.url === '/internal/v1/init/assemble' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = null;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }
          const catalog = assembleDeps.getRoleCatalog();
          if (!catalog) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'role_catalog_unavailable', message: 'employee roster or agent contracts not loaded' }));
            return;
          }
          const v = validateAssemblePayload(body, catalog);
          if (!v.ok) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: v.error, message: v.message }));
            return;
          }
          const result = await runAssemble(assembleDeps, {
            ceoName: v.ceoName,
            selections: v.selections,
            entry: (body as Record<string, unknown>).entry as 'tripilot' | 'trilc-chat',
          });
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── GET /internal/v1/init/events ──
        // i2-1 §四：daemon 级 init 事件 SSE 通道（订阅 localbus 转发 init:* 族）。
        // 无重放缓冲：断连重连 = 重拉 chain/status（事件流 = 状态文件投影）。
        if (req.url === '/internal/v1/init/events' && req.method === 'GET') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          });
          const onInitEvent = (event: LocalBusEvent) => {
            if (!event.type.startsWith('init:')) return;
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          };
          localBus.on('event', onInitEvent);
          const keepAlive = setInterval(() => res.write(': ping\n\n'), 25_000);
          const cleanup = () => {
            clearInterval(keepAlive);
            localBus.off('event', onInitEvent);
          };
          req.on('close', cleanup);
          res.write(': connected\n\n');
          return;
        }

        // ── GET /internal/v1/init/onboarding/state ──
        // i2-1 §四：断点续跑真源只读投影（A3：已答不重复问、可回看）。
        if (req.url === '/internal/v1/init/onboarding/state' && req.method === 'GET') {
          try {
            const projection = await getOnboardingStateProjection(companyInitState);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(projection));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'onboarding_state_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/init/onboarding/progress ──
        // i2-1 §四：upsert 部分字段 → CompanyInitState.save({ progress }) 持久
        // （REQ-016 断点续接机制沿用，init-state.ts 零改动）。
        if (req.url === '/internal/v1/init/onboarding/progress' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = null;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }
          const v = validateProgressUpsert(body);
          if (!v.ok) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: v.error, message: v.message }));
            return;
          }
          try {
            await upsertOnboardingProgress(companyInitState, v.patch);
            const projection = await getOnboardingStateProjection(companyInitState);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, progress: projection }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'progress_save_failed', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/projects/link ──
        // I3（init-collab-i3-project-registry）：项目链路建立端点（六步原子序
        // 同一请求完成：检测→白名单关联→门禁→认领/建立→登记去重→链态快照+
        // 内存态热更新；失败分类 + 回滚）。链态门：仅 chainState=project-link
        // 生效，其他 409 { chainState }。进度经 init:project-link-* SSE 事件族
        // （/internal/v1/init/events 同通道）。
        if (req.url === '/internal/v1/projects/link' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = null;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }
          const v = validateLinkPayload(body);
          if (!v.ok) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: v.error, message: v.message }));
            return;
          }
          const result = await runLink(projectLinkDeps, v.request);
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── POST /internal/v1/projects/claim ──
        // I3：打开文件夹认领路径（§4a 同构 + 认领登记；零 git/项目磁盘写）。
        // 链态门同 link：仅 project-link 生效。
        if (req.url === '/internal/v1/projects/claim' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = null;
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }
          const v = validateClaimPayload(body);
          if (!v.ok) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: v.error, message: v.message }));
            return;
          }
          const result = await runClaim(projectLinkDeps, v.path);
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── GET /internal/v1/projects/inspect?path= ──
        // I3：识别分流判定接口（design-v2 §2.5，两入口渲染共用；只读，不受
        // 链态门限制）。判定：受管 worktree / 项目仓普通克隆 / 未关联。
        if (req.url?.startsWith('/internal/v1/projects/inspect') && req.method === 'GET') {
          try {
            const url = new URL(req.url, 'http://127.0.0.1');
            const pathParam = url.searchParams.get('path');
            if (!pathParam) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'bad_request', message: 'path query param is required' }));
              return;
            }
            const result = await inspectPath(projectLinkDeps, pathParam);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'inspect_failed', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/init/sync/run ──
        // I4（init-collab-i4-five-dim-sync）：五维同步执行（daemon 单执行体；
        // 两入口只发指令）。链态门 project-link/sync + 防重入 409 + 五维
        // 收集单维降级 + 幂等重跑 + 固定身份 commit + 双远端 push。
        // 进度经 init:sync-* 事件族（/internal/v1/init/events 同通道）。
        if (req.url === '/internal/v1/init/sync/run' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
              return;
            }
          }
          const entryRaw = body.entry;
          const entry: SyncEntry =
            entryRaw === 'tripilot' || entryRaw === 'trilc-chat' ? entryRaw : 'daemon';
          const result = await runInitSync(initSyncDeps, entry);
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── GET /internal/v1/init/sync/status ──
        // I4：五维同步状态投影（两入口渲染 + 诊断卡数据源）。remote = 拉取
        // TriMC config/sync/status（超时 3s 降级 null，§6.8 降级口径）。
        if (req.url === '/internal/v1/init/sync/status' && req.method === 'GET') {
          try {
            const payload = await getSyncStatus(initSyncDeps);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'sync_status_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── GET /internal/v1/init/confirm/check ──
        // I4 Phase D（§六.1）：L1-L4 协同确认按需计算（无后台常驻轮询）。
        // 数据源 = 注册点 ↔ 本地 bundle ↔ TriMC status.project/fleetHead
        // 三面；远程不可达 → degraded 口径（remote: null）。
        if (req.url === '/internal/v1/init/confirm/check' && req.method === 'GET') {
          try {
            const payload = await runConfirmCheck(initSyncDeps);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'confirm_check_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/init/confirm ──
        // I4 Phase D（§六.2）：用户一次确认（两入口同载荷 { entry }）→
        // 服务端重算 check → readyForConfirm 门禁（409 附 check）→
        // 快照 confirmed → transitionTo('ready') → init:step-event。
        if (req.url === '/internal/v1/init/confirm' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
              return;
            }
          }
          const entryRaw = body.entry;
          const entry: SyncEntry =
            entryRaw === 'tripilot' || entryRaw === 'trilc-chat' ? entryRaw : 'daemon';
          const result = await runConfirm(initSyncDeps, entry);
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── POST /internal/v1/init/ready/first-collab ──
        // I5（i5-1 §五）：firstCollab 推进写入面——pending→triggered→passed
        // 合法转移 + 重放幂等 + 链态门 ready。internal localhost-only 面
        // （daemon 只绑定 127.0.0.1）；两入口零执行增量（只读呈现）。
        if (req.url === '/internal/v1/init/ready/first-collab' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          if (raw.trim()) {
            try {
              body = JSON.parse(raw) as Record<string, unknown>;
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
              return;
            }
          }
          const result = await runFirstCollabUpdate(
            { chain: initSyncDeps.chain },
            body.status,
            body.note,
          );
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── POST /internal/v1/init/reset ──
        // Debug reset: 任意链态 → uninitialized（绕过转移表）。
        // 清理面 = 运行态 + 装配产物白名单反查 + 可选项目关联。
        // debug 门禁：TRILC_DEBUG 未设置时返回 403。
        if (req.url === '/internal/v1/init/reset' && req.method === 'POST') {
          // Debug 门禁检查
          if (!env.debugMode) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: 'debug_mode_required',
              message: 'debug mode is not enabled (set TRILC_DEBUG=1 and restart daemon)',
            }));
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { includeProject?: boolean; purgeWorktree?: boolean } = {};
          if (raw.trim()) {
            try {
              body = JSON.parse(raw) as { includeProject?: boolean };
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
              return;
            }
          }

          try {
            const result = await initChain.reset({
              includeProject: body.includeProject,
              purgeWorktree: body.purgeWorktree,
              workspaceRoot: env.projectRoot ?? env.cwd,
            });
            // DEFECT-RESET-CACHE: reset deleted state.json — invalidate daemon's in-memory
            // CompanyInitState cache, otherwise assemble's idempotency check reads stale employees.
            companyInitState.invalidateCache();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              chainState: result.chainState,
              cleared: result.cleared,
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'reset_failed', message: msg }));
          }
          return;
        }

        // ── GET /internal/v1/staffing/roster ──
        // FADE-004 候选岗位发布：13 岗 JD 全集 + 在岗（开业选定/后补上岗）+ 待审。
        if (req.url === '/internal/v1/staffing/roster' && req.method === 'GET') {
          try {
            await initChain.load();
            const payload = await getStaffingRoster(staffingDeps);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'roster_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/staffing/onboard ──
        // 勾选候选 → 登记 pending-cho 请求（CHO 审批门）。链态门：开业完成后才可增员。
        if (req.url === '/internal/v1/staffing/onboard' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }
          await initChain.load();
          const result = await requestOnboarding(
            staffingDeps, String(body.roleId ?? ''), String(body.requester ?? 'ceo-panel'),
            typeof body.employeeName === 'string' ? body.employeeName : undefined,
          );
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── POST /internal/v1/staffing/decide ──
        // CHO 审批：approved → CompanyInitState.employees 写入 + 审计 json；rejected → 终态记录。
        if (req.url === '/internal/v1/staffing/decide' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }
          const decision = body.decision === 'rejected' ? 'rejected' : 'approved';
          const result = await decideOnboarding(
            staffingDeps,
            String(body.requestId ?? ''),
            decision,
            String(body.approver ?? ''),
            typeof body.note === 'string' ? body.note : undefined,
          );
          res.writeHead(result.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── GET /v1/models ──
        // Anthropic-compatible model list. Returns models available through TriModel.
        if (req.url === '/v1/models' && req.method === 'GET') {
          const models = await getAvailableModels();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            data: models.map((m) => ({
              id: m.id,
              type: 'model',
              display_name: m.displayName,
              created_at: m.createdAt,
            })),
          }));
          return;
        }

        // ── GET /internal/v1/agents ──
        // Returns agents loaded from TriCompany .contract.yaml and/or builtin agents.
        // Supports ?scope=company|builtin|all (default: all).
        //   company  — contract-resolver agents only (13 employee contracts + 1 registry)
        //   builtin  — hardcoded builtin agents only (code_explorer, test_runner, file_processor, code_reviewer)
        //   all      — both company and builtin agents merged
        const agentsUrlMatch = req.url?.match(/^\/internal\/v1\/agents(\?.*)?$/);
        if (agentsUrlMatch && req.method === 'GET') {
          const urlObj = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const scope = urlObj.searchParams.get('scope') ?? 'all';

          const agents: Array<{
            id: string;
            displayName: string;
            role?: string;
            supervisor?: string;
            description?: string;
            hasSystemPrompt: boolean;
            decisionRights?: { approve: string[]; freeze: string[]; escalate: string[] };
            tools?: Record<string, unknown>;
          }> = [];

          // Company agents (from contract resolver)
          let tricompanyEnabled = false;
          if (scope === 'company' || scope === 'all') {
            try {
              const resolver = getContractResolver();
              const agentIds = resolver.listAgents();
              tricompanyEnabled = agentIds.length > 0;
              for (const id of agentIds) {
                const rights = resolver.getDecisionRights(id);
                const tools = resolver.getToolControl(id);
                const rosterInfo = resolver.getEmployeeInfo(id);
                // 岗位-实例分离（CEO 2026-08-18）：displayName=岗位名（JD 层）；
                // 个人名是实例属性——仅当该岗位在本部署已上岗（公司态 employees）
                // 才以「岗位名 · 人名」呈现，未在岗不带个人名。
                let displayWithInstance = rosterInfo?.displayName ??
                  (typeof tools?.name === 'string' ? tools.name : id);
                try {
                  const companyFile = await companyInitState.load();
                  const emp = (companyFile.employees ?? []).find((e: any) => e.role === id);
                  if (emp?.name) displayWithInstance = `${displayWithInstance} · ${emp.name}`;
                } catch { /* 公司态不可达 → 仅岗位名 */ }
                agents.push({
                  id,
                  displayName: displayWithInstance,
                  role: rosterInfo?.role,
                  supervisor: rosterInfo?.reportsTo,
                  description: typeof tools?.description === 'string' ? tools.description : undefined,
                  hasSystemPrompt: !!resolver.getSystemPrompt(id),
                  decisionRights: rights,
                  tools,
                });
              }
            } catch {
              // Contract resolver not initialized: skip company agents
            }
          }

          // Builtin agents
          if (scope === 'builtin' || scope === 'all') {
            for (const ba of BUILTIN_AGENTS) {
              agents.push({ ...ba });
            }
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ agents, count: agents.length, scope, tricompanyEnabled }));
          return;
        }

        // ── GET /internal/v1/agents/{id}/system-prompt ──
        const agentPromptMatch = req.url?.match(/^\/internal\/v1\/agents\/([^/]+)\/system-prompt$/);
        if (agentPromptMatch && req.method === 'GET') {
          try {
            const agentId = decodeURIComponent(agentPromptMatch[1]);
            const systemPrompt = getContractResolver().getSystemPrompt(agentId);
            if (!systemPrompt) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: `agent not found: ${agentId}` }));
              return;
            }
            // FADE-ASSESS-003: 消费路径挂接点② — 响应追加知识注入块
            // （boot injection 非检索；注入层不污染身份真源，getSystemPrompt 保持不变）
            const injectedPrompt = injectKnowledgeContext({
              projectRoot: env.projectRoot,
              agentId,
              systemPrompt,
              injectionMode: 'boot',
            }).prompt;
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, agentId, systemPrompt: injectedPrompt }));
          } catch (error) {
            const message = error instanceof URIError ? 'invalid agent id' : 'contract resolver not initialized';
            res.writeHead(error instanceof URIError ? 400 : 500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: message }));
          }
          return;
        }

        // ── GET /internal/v1/knowledge/metrics ──
        // FADE-ASSESS-003 小乔验证指标快照（只读）：分子=行为计数（越权升级/路由
        // 错误），分母=knowledge_consumption 聚合（注入成功/会话覆盖素材）。
        if (req.url === '/internal/v1/knowledge/metrics' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            projectRoot: env.projectRoot,
            metrics: getKnowledgeMetricSnapshot(env.projectRoot),
          }));
          return;
        }

        // ── GET /internal/v1/interactions/pending ──
        // P3: TUI polls this while a request is in flight to discover
        // AskUserQuestion / permission prompts awaiting user input.
        if (req.url === '/internal/v1/interactions/pending' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, pending: getPendingInteraction() }));
          return;
        }

        // ── POST /internal/v1/interactions/answer ──
        // P3: TUI posts the user's response. Body: { id, response }.
        // question → response: { answers: Record<string,string>, cancelled?: boolean }
        // permission → response: 'allow' | 'deny' | 'always'
        if (req.url === '/internal/v1/interactions/answer' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { id?: string; response?: unknown } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          if (!body.id) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'id is required' }));
            return;
          }
          const answered = answerInteraction(body.id, body.response);
          if (!answered) {
            res.writeHead(409, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'stale_or_missing_interaction' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        // ── POST /v1/messages ──
        // Anthropic Messages API compatible endpoint.
        // Accepts: model, messages, system, max_tokens, stream, tools
        // Returns: SSE stream (stream: true) or JSON response
        // ── 通道 Profile 宿主能力闸（LG-020）：channel 模式下三类 agent 宿主路由 501 ──
        if (channelMode && (req.url === '/v1/messages'
            || req.url?.startsWith('/internal/v1/agent')
            || req.url === '/chat/completions') && req.method === 'POST') {
          res.writeHead(501, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'channel_mode_no_agent_host', hint: 'TRILC_CHANNEL_MODE=1: agent host capability not provisioned (LG-020)' }));
          return;
        }

        if (req.url === '/v1/messages' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          let parsed: AnthropicRequest;
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
            return;
          }

          const model = parsed.model ?? 'tmv-deepseek-v4-pro';
          // Step 4: End-to-end verification — log received model parameter
          console.log(`[trilc] /v1/messages model=${model}`);
          const maxTurns = parsed.max_tokens ? Math.min(Math.ceil(parsed.max_tokens / 100), 25) : 25;

          // TC-001: 执行持续性三机制字段解析；null = 无新字段 → 原生 agentLoop 零行为变化
          const harness = parseHarnessOptions(parsed);

          // P3: interactive opt-in — the TUI sets interactive:true, enabling
          // AskUserQuestion waiting and permission prompts for this request.
          // res 'close' fires on every completion path (stream end, JSON end,
          // error, client disconnect), guaranteeing the session is ended.
          const isInteractive = parsed.interactive === true;
          if (isInteractive) {
            beginInteractiveSession();
            res.on('close', () => endInteractiveSession());
          }

          // Convert Anthropic messages to internal Message format
          const internalMessages: Message[] = convertAnthropicMessages(parsed.messages ?? []);

          // Register tools from request (if any)
          const toolDefs = convertAnthropicTools(parsed.tools ?? []);
          const toolNames: string[] = [];
          for (const tool of toolDefs) {
            registerTool(tool, async (_args: Record<string, unknown>) => {
              // Tool execution is done by TriPilot client; here we return a placeholder
              // indicating that the tool should be executed client-side.
              return JSON.stringify({ _trilc_note: 'tool execution delegated to TriPilot client' });
            });
            toolNames.push(tool.function.name);
          }

          const effectivePermissionMode = resolvePermissionMode(parsed.permission_mode) as PermissionMode;
          // C9: Build combined permission rules (CLI + persisted + interactive)
          const sessionRules = buildSessionPermissionRules();
          const mergedPermissionRules: PermissionRule[] = [
            ...sessionRules,
            // P3: interactive requests inject ask rules for dangerous tools
            ...(isInteractive && !_printMode ? INTERACTIVE_ASK_RULES : []),
          ];

          // TC-s1: task_plan 进度清单注入 systemPrompt 尾部（静态全景，与
          // TC-001 FR-1 的逐轮动态锚点互补；无 task_plan 时为空串零变化）
          const systemPromptTail = harness ? formatTaskPlanChecklist(harness.task_plan) : '';

          const loopOptions: AgentLoopOptions = {
            model,
            systemPrompt: (parsed.system || defaultSystemPrompt()) + systemPromptTail,
            messages: internalMessages,
            maxTurns,
            // TC-1：headless 编排方续跑参数透传（默认 undefined=关闭）
            continueMaxRounds: Number(parsed.continue_max_rounds ?? 0) || undefined,
            continuePrompt: (parsed.continue_prompt as string) || undefined,
            fallbackModel: (parsed.fallback_model as string) || undefined,
            tier: 'main',
            cwd: env.cwd,
            // C8: Use resolved permission mode (from request body or env default)
            permissionMode: effectivePermissionMode,
            permissionRules: mergedPermissionRules.length > 0 ? mergedPermissionRules : undefined,
            // C9: Additional directories from CLI --add-dir
            additionalDirectories: _cliAdditionalDirs.length > 0 ? _cliAdditionalDirs : undefined,
            // P3: interactive requests get the TUI permission bridge;
            // C9: print mode (-p) disables onPermissionAsk (non-interactive — ask→deny).
            ...(isInteractive && !_printMode
              ? { onPermissionAsk: askPermissionViaTui }
              : {}),
            // P7: Plan mode tool gating via deps.checkToolPermission
            deps: buildPlanModeDeps(),
          };
          const wantsStream = parsed.stream !== false;

          if (wantsStream) {
            // ── Anthropic SSE streaming ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

          let streamedContent = false;
          let streamedToolCalls = false;

          try {
            // TC-001: harness 字段存在时走包装器（每轮注入），否则原生 agentLoop
            await agentEventsToAnthropicSSE(
              harness ? runHarnessAgentLoop(loopOptions, harness) : agentLoop(loopOptions),
              {
              model,
              onSSE: (eventType, data) => {
                if (eventType === 'content_block_delta' || eventType === 'message_delta') {
                  streamedContent = true;
                } else if (eventType === 'content_block_start') {
                  streamedToolCalls = true;
                }
                res.write(formatSSELine(eventType, data));
              },
              },
            );

            // ── Post-stream guard: warn if nothing meaningful was emitted ──
            if (!streamedContent && !streamedToolCalls) {
              res.write(formatSSELine('message_stop', {
                type: 'message_stop',
                warning: 'No content or tool calls were emitted (possible reasoning-only response)',
              }));
            }
          } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.write(formatSSELine('error', {
                type: 'error',
                error: { type: 'api_error', message: msg },
              }));
            }
            res.end();
            return;
          }

          // ── JSON mode (non-streaming) ──
          const allEvents: AgentEvent[] = [];
          let finalContent = '';
          const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
          let usageSummary: UsageSummary | null = null;

          try {
            // TC-001: harness 字段存在时走包装器（每轮注入），否则原生 agentLoop
            for await (const event of harness ? runHarnessAgentLoop(loopOptions, harness) : agentLoop(loopOptions)) {
              allEvents.push(event);
              if (event.type === 'content_delta') {
                finalContent += event.delta;
              } else if (event.type === 'assistant_message') {
                if (!finalContent && event.content) finalContent = event.content;
                if (event.tool_calls) {
                  for (const tc of event.tool_calls) {
                    toolCalls.push({
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.function.name, arguments: tc.function.arguments },
                    });
                  }
                }
              } else if (event.type === 'loop_end' && event.usageSummary) {
                usageSummary = event.usageSummary;
              }
            }

            // ── Message guard: reject empty assistant responses ──
            // Prevents "空头" — DeepSeek reasoning_content-only messages
            // that have neither content nor tool_calls.
            const guardResult: GuardResult = validateMessage({
              role: 'assistant',
              content: finalContent || null,
              tool_calls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                : undefined,
            });
            if (!guardResult.allowed) {
              res.writeHead(422, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                type: 'error',
                error: { type: 'empty_response', message: `Message rejected: ${guardResult.reason}` },
              }));
              return;
            }

            const content = toolCalls.length > 0
              ? [{ type: 'text' as const, text: finalContent }, ...toolCalls.map((tc) => ({
                  type: 'tool_use' as const,
                  id: tc.id,
                  name: tc.function.name,
                  input: safeJsonParse(tc.function.arguments),
                }))]
              : [{ type: 'text' as const, text: finalContent }];

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              id: `msg_${Date.now().toString(36)}`,
              type: 'message',
              role: 'assistant',
              content,
              model,
              stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
              stop_sequence: null,
              usage: {
                input_tokens: usageSummary?.tokens?.prompt_tokens ?? 0,
                output_tokens: usageSummary?.tokens?.completion_tokens ?? 0,
              },
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: msg },
            }));
          }
          // ── Session auto-save (Anthropic JSON mode) ──
          // Persist the full conversation for recovery after abnormal interruption.
          try {
            const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
            sessionStore.createSession({
              id: sessionId,
              model,
              systemPrompt: parsed.system || undefined,
              cwd: env.cwd,
            });
            const allMsgs: Array<{
              role: 'user' | 'assistant' | 'system' | 'tool';
              content: string | null;
              toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
              reasoningContent?: string | null;
            }> = [];
            for (const msg of internalMessages) {
              allMsgs.push({
                role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
                content: typeof msg.content === 'string' ? msg.content : null,
                toolCalls: msg.tool_calls?.map((tc) => ({
                  id: tc.id,
                  type: 'function' as const,
                  function: { name: tc.function.name, arguments: tc.function.arguments },
                })),
                reasoningContent: (msg as unknown as Record<string, unknown>).reasoning_content as string | undefined,
              });
            }
            // Add final assistant message
            allMsgs.push({
              role: 'assistant',
              content: finalContent || null,
              toolCalls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                : undefined,
            });
            sessionStore.saveMessages(sessionId, allMsgs);
            sessionStore.updateSessionStatus(sessionId, 'completed');
          } catch (saveErr) {
            console.warn('[trilc:session] failed to save session:', (saveErr as Error).message);
          }

          return;
        }

        // ── POST /internal/v1/agent ──
        if (req.url?.startsWith('/internal/v1/agent') && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          // Validate body is parseable JSON before proxying
          let parsed: {
            model?: string;
            systemPrompt?: string;
            messages?: Message[];
            maxTurns?: number;
            tier?: AgentTier;
            cwd?: string;
            permissionMode?: PermissionMode;
            permissionRules?: PermissionRule[];
          };
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }

          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const queryString = urlObj.search; // e.g. ?stream=true

          // ── Proxy to TriMC if connected ──
          if (connMgr.currentState === 'connected') {
            try {
              // Use a flag tracked via a simple wrapper to detect proxy failure
              await new Promise<void>((resolve, reject) => {
                const trimcUrl = new URL(`/internal/v1/agent${queryString}`, env.trimcBaseUrl);
                const reqFn = trimcUrl.protocol === 'https:' ? httpsRequest : httpRequest;

                const proxyReq = reqFn(
                  {
                    method: 'POST',
                    hostname: trimcUrl.hostname,
                    port: trimcUrl.port,
                    path: trimcUrl.pathname + trimcUrl.search,
                    headers: {
                      'content-type': 'application/json',
                      'content-length': Buffer.byteLength(raw).toString(),
                      'accept': req.headers.accept ?? 'application/json',
                      'x-trilc-node-id': env.nodeId,
                      'x-trilc-version': env.version,
                      'x-trilc-connection-id': connectionId,
                    },
                    timeout: 30_000,
                  },
                  (proxyRes) => {
                    connMgr.recordSuccess();
                    res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
                    proxyRes.pipe(res);
                    resolve();
                  },
                );

                proxyReq.on('error', (err) => {
                  connMgr.recordFailure();
                  reject(err);
                });
                proxyReq.on('timeout', () => {
                  proxyReq.destroy();
                  connMgr.recordFailure();
                  reject(new Error('timeout'));
                });
                proxyReq.write(raw);
                proxyReq.end();
              });
              return; // Successfully proxied
            } catch {
              // TriMC unreachable — fall through to local agentLoop
              console.log('[trilc] trimc unreachable, using local agentLoop');
            }
          }

          // ── Local agentLoop fallback ──
          const loopOptions: AgentLoopOptions = {
            model: parsed.model ?? 'tmv-deepseek-v4-pro',
            systemPrompt: parsed.systemPrompt ?? '',
            messages: parsed.messages ?? [],
            maxTurns: parsed.maxTurns ?? 25,
            tier: parsed.tier ?? 'main',
            cwd: parsed.cwd ?? env.cwd,
            permissionMode: parsed.permissionMode,
            permissionRules: parsed.permissionRules,
            // P7: Plan mode tool gating via deps.checkToolPermission
            deps: buildPlanModeDeps(),
          };

          const wantsSSE =
            queryString.includes('stream=true') ||
            req.headers.accept?.includes('text/event-stream');

          if (wantsSSE) {
            // ── SSE streaming mode ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

            const writeSSE = (eventType: string, data: object) => {
              res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            try {
              for await (const event of agentLoop(loopOptions)) {
                writeSSE(event.type, event);
              }
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              writeSSE('error', { type: 'error', message: msg });
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }

          // ── JSON mode ──
          const events: AgentEvent[] = [];
          try {
            for await (const event of agentLoop(loopOptions)) {
              events.push(event);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                turns:
                  events.filter((e) => e.type === 'loop_end').length > 0
                    ? 'completed'
                    : 'no_turns',
                events,
              }),
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'agent_error', message: msg, events }));
          }
          return;
        }

        // ── GET /models (OpenAI-compatible) ──
        // Returns model list in OpenAI format for opencode / Vercel AI SDK.
        if (req.url === '/models' && req.method === 'GET') {
          const models = await getAvailableModels();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            object: 'list',
            data: models.map((m) => ({
              id: m.id,
              object: 'model',
              created: Math.floor(new Date(m.createdAt).getTime() / 1000),
              owned_by: 'trilc',
            })),
          }));
          return;
        }

        // ── POST /chat/completions (OpenAI-compatible) ──
        // OpenAI Chat Completions API compatible endpoint.
        // Converts OpenAI format → internal → agentLoop → OpenAI SSE/JSON output.
        // Used by opencode custom provider (Vercel AI SDK @ai-sdk/openai-compatible).
        if (req.url === '/chat/completions' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          let parsed: OpenAIRequest;
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }));
            return;
          }

          const model = parsed.model ?? 'tmv-deepseek-v4-pro';
          const maxTurns = parsed.max_tokens ? Math.min(Math.ceil(parsed.max_tokens / 100), 25) : 25;

          // TC-001: 执行持续性三机制字段解析（与 /v1/messages 对齐）；
          // null = 无新字段 → 原生 agentLoop 零行为变化
          const oaiHarness = parseHarnessOptions(parsed);

          // Convert OpenAI messages to internal format
          const { systemPrompt: oaiSystem, internalMessages } = convertOpenAIMessages(parsed.messages ?? []);

          // Register tools from request (if any)
          const toolDefs = convertOpenAITools(parsed.tools ?? []);
          const toolNames: string[] = [];
          for (const tool of toolDefs) {
            registerTool(tool, async (_args: Record<string, unknown>) => {
              return JSON.stringify({ _trilc_note: 'tool execution delegated to client' });
            });
            toolNames.push(tool.function.name);
          }

          const oaiPermissionMode = resolvePermissionMode(parsed.permission_mode) as PermissionMode;
          const oaiSessionRules = buildSessionPermissionRules();

          // TC-s1: task_plan 进度清单注入 systemPrompt 尾部（与 /v1/messages 对齐）
          const oaiSystemPromptTail = oaiHarness ? formatTaskPlanChecklist(oaiHarness.task_plan) : '';

          const loopOptions: AgentLoopOptions = {
            model,
            systemPrompt: (oaiSystem || defaultSystemPrompt()) + oaiSystemPromptTail,
            messages: internalMessages,
            maxTurns,
            // TC-1：headless 编排方续跑参数透传（默认 undefined=关闭）
            continueMaxRounds: Number(parsed.continue_max_rounds ?? 0) || undefined,
            continuePrompt: (parsed.continue_prompt as string) || undefined,
            fallbackModel: (parsed.fallback_model as string) || undefined,
            tier: 'main',
            cwd: env.cwd,
            // C8: Use resolved permission mode
            permissionMode: oaiPermissionMode,
            permissionRules: oaiSessionRules.length > 0 ? oaiSessionRules : undefined,
            // C9: Additional directories from CLI --add-dir
            additionalDirectories: _cliAdditionalDirs.length > 0 ? _cliAdditionalDirs : undefined,
            // P7: Plan mode tool gating via deps.checkToolPermission
            deps: buildPlanModeDeps(),
          };

          const wantsStream = parsed.stream !== false;

          if (wantsStream) {
            // ── OpenAI SSE streaming ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

            try {
              // TC-001: harness 字段存在时走包装器（每轮注入），否则原生 agentLoop
              await agentEventsToOpenAISSE(
                oaiHarness ? runHarnessAgentLoop(loopOptions, oaiHarness) : agentLoop(loopOptions),
                {
                model,
                onSSE: (data) => {
                  res.write(formatOpenAISSE(data));
                },
                },
              );
              res.write(OPENAI_SSE_DONE);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.write(formatOpenAISSE({
                error: { type: 'api_error', message: msg },
              }));
              res.write(OPENAI_SSE_DONE);
            }
            res.end();
            return;
          }

          // ── JSON mode (non-streaming) ──
          let finalContent = '';
          const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
          let usageSummary: UsageSummary | null = null;

          try {
            // TC-001: harness 字段存在时走包装器（每轮注入），否则原生 agentLoop
            for await (const event of oaiHarness ? runHarnessAgentLoop(loopOptions, oaiHarness) : agentLoop(loopOptions)) {
              if (event.type === 'content_delta') {
                finalContent += event.delta;
              } else if (event.type === 'assistant_message') {
                if (!finalContent && event.content) finalContent = event.content;
                if (event.tool_calls) {
                  for (const tc of event.tool_calls) {
                    toolCalls.push({
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.function.name, arguments: tc.function.arguments },
                    });
                  }
                }
              } else if (event.type === 'loop_end' && event.usageSummary) {
                usageSummary = event.usageSummary;
              }
            }

            // Message guard: reject empty responses
            const guardResult: GuardResult = validateMessage({
              role: 'assistant',
              content: finalContent || null,
              tool_calls: toolCalls.length > 0
                ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                : undefined,
            });
            if (!guardResult.allowed) {
              res.writeHead(422, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: { type: 'empty_response', message: `Message rejected: ${guardResult.reason}` },
              }));
              return;
            }

            const choice: Record<string, unknown> = {
              index: 0,
              message: {
                role: 'assistant',
                content: finalContent || null,
              },
              finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
            };

            if (toolCalls.length > 0) {
              (choice.message as Record<string, unknown>).tool_calls = toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments,
                },
              }));
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              id: `chatcmpl-${Date.now().toString(36)}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [choice],
              usage: {
                prompt_tokens: usageSummary?.tokens?.prompt_tokens ?? 0,
                completion_tokens: usageSummary?.tokens?.completion_tokens ?? 0,
                total_tokens: (usageSummary?.tokens?.prompt_tokens ?? 0) + (usageSummary?.tokens?.completion_tokens ?? 0),
              },
            }));

            // ── Session auto-save (OpenAI JSON mode) ──
            try {
              const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              sessionStore.createSession({
                id: sessionId,
                model,
                systemPrompt: oaiSystem || defaultSystemPrompt(),
                cwd: env.cwd,
              });
              const allMsgs: Array<{
                role: 'user' | 'assistant' | 'system' | 'tool';
                content: string | null;
                toolCalls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
                reasoningContent?: string | null;
              }> = [];
              for (const msg of internalMessages) {
                allMsgs.push({
                  role: msg.role as 'user' | 'assistant' | 'system' | 'tool',
                  content: typeof msg.content === 'string' ? msg.content : null,
                  toolCalls: msg.tool_calls?.map((tc) => ({
                    id: tc.id,
                    type: 'function' as const,
                    function: { name: tc.function.name, arguments: tc.function.arguments },
                  })),
                  reasoningContent: (msg as unknown as Record<string, unknown>).reasoning_content as string | undefined,
                });
              }
              allMsgs.push({
                role: 'assistant',
                content: finalContent || null,
                toolCalls: toolCalls.length > 0
                  ? toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: tc.function }))
                  : undefined,
              });
              sessionStore.saveMessages(sessionId, allMsgs);
              sessionStore.updateSessionStatus(sessionId, 'completed');
            } catch (saveErr) {
              console.warn('[trilc:session] failed to save session:', (saveErr as Error).message);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: { type: 'api_error', message: msg },
            }));
          }
          return;
        }

        // ── POST /internal/v1/sessions ──
        // Saves a TUI chat session: creates or appends messages to an existing session.
        // Body: { sessionId?: string, model?: string, messages: [{ role, content }] }
        // If sessionId is omitted, a new one is created.
        if (req.url === '/internal/v1/sessions' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: {
            sessionId?: string;
            model?: string;
            title?: string;
            messages?: Array<{ role: 'user' | 'assistant' | 'system' | 'tool'; content: string | null }>;
          } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }

          try {
            let sessionId = body.sessionId;
            if (!sessionId || !sessionStore.getSession(sessionId)) {
              sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
              sessionStore.createSession({
                id: sessionId,
                model: body.model ?? 'tmv-deepseek-v4-flash',
                systemPrompt: defaultSystemPrompt(),
                cwd: env.cwd,
                title: body.title,
              });
            }

            if (body.messages && body.messages.length > 0) {
              sessionStore.saveMessages(sessionId!, body.messages);
              sessionStore.updateSessionStatus(sessionId!, 'active');
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sessionId }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/sessions/{id} ──
        // Returns a single session with its messages.
        if (req.url?.startsWith('/internal/v1/sessions/') && !req.url.endsWith('/stream') && !req.url.endsWith('/cancel') && !req.url.endsWith('/fork') && req.method === 'GET') {
          const sessionIdMatch = req.url.match(/^\/internal\/v1\/sessions\/([^/]+)$/);
          if (sessionIdMatch) {
            const sessionId = sessionIdMatch[1];
            const session = sessionStore.getSession(sessionId);
            if (!session) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
              return;
            }
            const messages = sessionStore.getMessages(sessionId);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, session, messages }));
            return;
          }
        }

        // ── POST /internal/v1/sessions/{id}/fork (P6) ──
        // Forks a conversation session: copies all messages to a new session ID.
        // CC equivalent: /branch command (session transcript fork, not git worktree).
        if (req.url?.startsWith('/internal/v1/sessions/') && req.url.endsWith('/fork') && req.method === 'POST') {
          const forkMatch = req.url.match(/^\/internal\/v1\/sessions\/(.+)\/fork$/);
          if (forkMatch) {
            const originalId = forkMatch[1];
            const original = sessionStore.getSession(originalId);
            if (!original) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${originalId} not found` }));
              return;
            }
            const messages = sessionStore.getMessages(originalId);
            if (messages.length === 0) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'empty', message: 'No messages to fork' }));
              return;
            }
            const { randomUUID } = await import('node:crypto');
            const forkId = randomUUID();
            const forkedTitle = (original.title ?? 'Branched conversation') + ' (Branch)';
            sessionStore.createSession({
              id: forkId,
              model: original.model,
              systemPrompt: original.systemPrompt,
              cwd: original.cwd,
              title: forkedTitle,
            });
            sessionStore.saveMessages(forkId, messages.map(m => ({
              role: m.role,
              content: m.content,
              toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : null,
              toolCallId: m.toolCallId,
              reasoningContent: m.reasoningContent,
            })));
            console.log(`[trilc] forked session ${originalId.slice(0,12)} → ${forkId.slice(0,12)} (${messages.length} messages)`);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              originalId,
              sessionId: forkId,
              title: forkedTitle,
              messageCount: messages.length,
            }));
            return;
          }
        }

        // ── POST /internal/v1/sessions/recover ──
        // Recovers an interrupted session with optional work-tree safety check.
        // Body: { sessionId?: string } — if omitted, recovers the most recent interrupted session.
        // Response: RecoveryResult with session, messages, and safety report.
        if (req.url === '/internal/v1/sessions/recover' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { sessionId?: string; includeSafetyCheck?: boolean } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            // empty body is OK — recover most recent
          }

          const targetId = body.sessionId;
          let session: SessionRecord | null = null;
          let messages: SessionMessageRecord[] | null = null;
          const warnings: string[] = [];

          if (targetId) {
            session = sessionStore.getSession(targetId);
            if (session) {
              messages = sessionStore.getMessages(targetId);
            }
          } else {
            // Find most recent interrupted/active session
            const interrupted = sessionStore.findInterruptedSessions();
            if (interrupted.length > 0) {
              session = interrupted[0];
              messages = sessionStore.getMessages(session.id);
            }
          }

          if (!session) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: false,
              session: null,
              messages: null,
              safetyReport: null,
              warnings: ['No recoverable session found'],
            }));
            return;
          }

          // Check for empty assistant messages in the session
          if (messages) {
            const emptyAssistants = messages.filter(
              (m) => m.role === 'assistant' && !m.content && !m.toolCalls,
            );
            if (emptyAssistants.length > 0) {
              warnings.push(
                `Found ${emptyAssistants.length} empty assistant message(s) (no content, no tool_calls). ` +
                'These may cause 400 errors on DeepSeek reasoning models. Consider filtering before retry.',
              );
            }
          }

          // Run work-tree safety check
          const safetyReport = body.includeSafetyCheck !== false
            ? runSafetyCheck(session.cwd || env.cwd)
            : { cwd: env.cwd, hasUncommittedChanges: false, changedFiles: [], typeCheckPassed: null, riskLevel: 'low' as const };

          if (safetyReport.riskLevel === 'high') {
            warnings.push('Work-tree has type errors — resolve before continuing agent work');
          } else if (safetyReport.riskLevel === 'medium') {
            warnings.push(`Work-tree has ${safetyReport.changedFiles.length} uncommitted changes — review before continuing`);
          }

          // Mark session as interrupted so it can be recovered again
          sessionStore.updateSessionStatus(session.id, 'interrupted');

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            session,
            messages,
            safetyReport,
            warnings,
          }));
          return;
        }


        // ── POST /internal/v1/tasks/submit ──
        // W30 S2: Submit user intent → returns sessionId + SSE stream endpoint.
        // Body: { message, conversationId, systemPrompt?, context? }
        // Response 201: { sessionId, streamEndpoint, status }
        if (req.url === '/internal/v1/tasks/submit' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          let body: {
            message?: string;
            conversationId?: string;
            systemPrompt?: string;
            context?: { files?: string[]; workspaceRoot?: string };
            // FADE-ASSESS-005 派工门禁：可选的派工 owner 岗位。携带时校验
            // owner ∈ roster.active；非在岗 → 409 owner_not_active（不静默）。
            // 不携带 = 普通用户会话，不校验（向后兼容）。
            ownerRoleId?: string;
          } = {};
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }

          if (!body.message || !body.message.trim()) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'bad_request', message: 'message is required' }));
            return;
          }

          // FADE-ASSESS-005 派工门禁：周平面任务派发（owner 岗位）校验在岗。
          if (body.ownerRoleId) {
            const gate = await enforceRoleActive(staffingDeps, body.ownerRoleId);
            if (!gate.allowed) {
              // FADE-ASSESS-003 小乔指标：派工路由到未在岗岗 → routing_error 埋点
              recordKnowledgeMetric({
                projectRoot: env.projectRoot,
                event: 'routing_error',
                agentId: body.ownerRoleId,
                detail: `tasks_submit_gate:${gate.status}`,
              });
              res.writeHead(409, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: gate.error,
                roleId: body.ownerRoleId,
                rosterStatus: gate.status,
                message: `派工拒绝：岗位 ${body.ownerRoleId} 未在岗（roster status: ${gate.status}）— 未上岗岗位不可派工`,
              }));
              return;
            }
          }

          const sessionId = `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
          const model = getKeyCache()?.defaultModel ?? process.env.TRIMODEL_DEFAULT_MODEL ?? 'tmv-deepseek-v4-pro';
          // i2-1 §三 init 模式路由：链态 ∈ 初始化阶段且无 client systemPrompt
          // （非员工 agent 显式会话）→ init 模式 bootstrap 替代 defaultSystemPrompt；
          // 员工合同装配路径（6.4）与自检第五探测（显式 systemPrompt）不动。
          // 周平面提示保持「no-prompt 路径恒有一次」r4-1 C 口径（init 模式同注入）。
          const initModePrompt = body.systemPrompt ? null : buildInitModeSystemPrompt(initChain.getState());
          const entry: TaskStreamEntry = {
            sessionId,
            message: body.message.trim(),
            conversationId: body.conversationId ?? `conv_${Date.now().toString(36)}`,
            model,
            // REQ-014b / r4-1 C: when the client supplies an agent systemPrompt,
            // defaultSystemPrompt (and its weekly-plane hint) is skipped entirely.
            // Append the hint explicitly so the model still knows the company
            // weekly plane root. defaultSystemPrompt already embeds it internally
            // for the no-prompt path — never both (see buildWeeklyPlaneHint).
            systemPrompt: body.systemPrompt
              ? body.systemPrompt + buildWeeklyPlaneHint()
              : (initModePrompt ? initModePrompt + buildWeeklyPlaneHint() : defaultSystemPrompt()),
            context: {
              files: body.context?.files ?? [],
              workspaceRoot: body.context?.workspaceRoot ?? env.cwd,
            },
            createdAt: Date.now(),
            status: 'pending',
          };
          taskStreams.set(sessionId, entry);

          // I1 selfcheck tripilot 探测：TriPilot 形态任务提交存活计数（被动观察面）
          recordTaskSubmission();

          // S7: Publish task:queued for mirror pusher
          publish({ type: 'task:queued', taskId: sessionId });

          // Persist session for recovery
          try {
            sessionStore.createSession({
              id: sessionId,
              model: entry.model,
              systemPrompt: entry.systemPrompt,
              cwd: entry.context.workspaceRoot,
            });
          } catch (saveErr) {
            console.warn('[trilc:task] failed to persist session:', (saveErr as Error).message);
          }

          // 2.5: Include connection state in task submission response
          const connInfo = connMgr.getStateInfo();
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            sessionId,
            streamEndpoint: `/internal/v1/sessions/${sessionId}/stream`,
            status: 'running',
            connectionState: connInfo.connectionState,
            ...(connInfo.warning ? { warning: connInfo.warning } : {}),
          }));
          return;
        }

        // ── SSE GET /internal/v1/sessions/{id}/stream ──
        // W30 S2: Real-time SSE stream of LLM output + tool call status.
        // Event types: delta, tool_use, tool_result, task_progress, task_done, task_error
        if (req.url?.startsWith('/internal/v1/sessions/') && req.url.endsWith('/stream') && req.method === 'GET') {
          const sessionId = req.url.split('/')[4]; // /internal/v1/sessions/{id}/stream
          const entry = taskStreams.get(sessionId);

          if (!entry) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'not_found', message: `No task found for session ${sessionId}` }));
            return;
          }

          // SSE headers
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
            'x-accel-buffering': 'no',
          });

          const writeSSE = (eventType: string, data: object) => {
            res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          // Mark running
          entry.status = 'running';
          // S7: Publish task:running for mirror pusher
          publish({ type: 'task:running', taskId: sessionId });

          // Build agentLoop options from task entry
          const cwd = entry.context.workspaceRoot || env.cwd;
          const messages: Message[] = [{ role: 'user', content: entry.message }];
          const systemPrompt = entry.systemPrompt || defaultSystemPrompt();

          // C12: Pre-validate model against registry before starting agent loop.
          // W30 lesson: fallback chain end must be in listModels() — if the model
          // isn't registered, fail immediately with a clear task_error instead of
          // letting agentLoop hit "Unknown model" downstream.
          const modelCheck = validateModelAgainstRegistry(entry.model);
          if (!modelCheck.valid) {
            const errDetail = modelCheck.error ?? `Model "${entry.model}" not available`;
            console.error(`[trilc:model] CRITICAL: model not in registry for task=${sessionId}: ${errDetail}`);
            entry.status = 'error';
            publish({ type: 'task:failed', taskId: sessionId, error: errDetail });
            writeSSE('task_error', { status: 'failed', error: errDetail });
            try { sessionStore.updateSessionStatus(sessionId, 'error'); } catch { /* ignore */ }
            res.end();
            return;
          }

          try {
            // Track tool states for progress reporting
            let toolCount = 0;
            let deltaContent = '';
            // DEFECT-PSEUDO-CHAT fix (CEO US-002 2026-08-18): track text produced AFTER the
            // last tool call. Model narrating "让我先看看..." before tools is NOT a conclusion —
            // user needs text AFTER tools finish. Old gate (deltaContent.length) counted pre-tool
            // narration as output, so "narrate → tools → silence" passed as success.
            let contentAfterLastTool = '';
            // DEFECT-PSEUDO-CHAT v2a (2026-08-18 复测·翻倍): agent-core 每轮同时发
            // content_delta（流式增量）和 assistant_message（完整内容）。旧代码无条件把
            // assistant_message 再发射一遍 → 面板每句话收到两次。标志位按轮去重。
            let hadDeltaSinceLastTool = false;
            // DEFECT-PSEUDO-CHAT v2b (2026-08-18 复测·无结论): 模型多次真工具调用后，
            // 最后一轮把工具调用写成文本 "[tool_use name=X]"（非真函数调用）→ loop 视为
            // 最终回答结束。用观测事件重建 transcript，检测到伪文本/静默时以无工具模式
            // 补一轮强制收尾调用，逼出真实结论。
            const rebuilt: Message[] = [{ role: 'user', content: entry.message }];
            let terminalError: string | undefined;
            // v2d（CEO 三轮复测·闭合标签洪水）：模型会以「闭合标签无限重复」 floods
            // （"</｜｜DSML｜｜parameter>" ×N）。RE 前移到流中，检测到伪工具语法即 break
            // 当前流（不等回合自然结束），直接进强制收尾。等待自然结束 = 用户看着死循环。
            // v2e/v2f（CEO 七/八轮）：变体清单——"[tool_use name=X]"、"[工具输入]"、
            // "<invoke name=...>"（XML 族）、"[调用 shell_exec] {json}"（学舌 UI 文案）。
            // 方括号族也收敛为结构化匹配：[短标签] + 紧跟 { 的 JSON 载荷（标签限
            // 字母/下划线/中文/空格，排除 ["key"]/[0] 等代码下标形态）。
            const PSEUDO_TOOL_TOKEN_RE =
              /\[[^\]\n]*tool_use[^\]]*\]|\[(工具输入|工具输出|调用)[^\]]*\]|\[tool_result[^\]]*\]|<(tool_call|invoke|parameter|function_call)[\s>]|\[[A-Za-z_一-鿿][A-Za-z0-9_ 一-鿿]{0,31}\]\s*\{|｜｜DSML｜｜/;
            let pseudoDetectedMidStream = false;
            let turnDeltaBuf = '';
            let leakedThisTurn = 0; // v2g：掐断前已转发的字符数（结论需分隔前缀）
            // durationMs 真值（CEO 十一轮）：agent-core 的 tool_result 事件不带耗时字段，
            // 旧代码发 `?? 0` → 所有卡显示 0ms。daemon 侧按 tool_call→tool_result 时间差计时。
            const toolStartTimes = new Map<string, number>();

            const taskSessionRules = buildSessionPermissionRules();
            eventLoop: for await (const event of runCompactingAgentLoop({
              model: entry.model,
              systemPrompt,
              messages,
              maxTurns: 25,
              tier: 'main',
              cwd,
              permissionMode: _defaultPermissionMode as PermissionMode,
              permissionRules: taskSessionRules.length > 0 ? taskSessionRules : undefined,
              additionalDirectories: _cliAdditionalDirs.length > 0 ? _cliAdditionalDirs : undefined,
              // C9: -p print mode: no onPermissionAsk (non-interactive — ask→deny)
              ...(_printMode ? {} : {}),
            })) {
              // C13: Stop processing if we already sent a terminal error.
              // W30 lesson: never send task_done after task_error.
              if (terminalError) break;

              // Map agent events to W30 SSE event types
              switch (event.type as string) {
                case 'content_delta': {
                  const d = (event as any).delta ?? '';
                  deltaContent += d;
                  contentAfterLastTool += d;
                  turnDeltaBuf += d;
                  hadDeltaSinceLastTool = true;
                  // v2d/v2g mid-stream abort: 当前回合已在以文本形式模拟工具调用——
                  // 模式一成形立即掐断（旧 >20 字符阈值让前缀多泄漏十几字符，CEO 九轮）。
                  if (!pseudoDetectedMidStream && PSEUDO_TOOL_TOKEN_RE.test(turnDeltaBuf)) {
                    pseudoDetectedMidStream = true;
                    console.warn(`[trilc:chat] pseudo tool-text detected mid-stream (task=${sessionId}, turn buf ${turnDeltaBuf.length} chars) — aborting turn, forcing conclusion`);
                    writeSSE('task_progress', {
                      step: toolCount,
                      totalSteps: toolCount + 1,
                      description: '检测到模型以文本模拟工具调用，已提前收口并强制生成结论',
                    });
                    break eventLoop;
                  }
                  if (!pseudoDetectedMidStream) {
                    writeSSE('delta', { content: d });
                    leakedThisTurn += d.length;
                  }
                  break;
                }
                case 'tool_call': {
                  toolCount++;
                  contentAfterLastTool = ''; // reset — text after this tool is what counts
                  hadDeltaSinceLastTool = false;
                  turnDeltaBuf = ''; // v2d per-turn reset
                  const tc = event as any;
                  // agent-core 的 arguments 是 JSON 字符串——daemon 侧解析成对象再发，
                  // 否则客户端二次 stringify 后 parse 回字符串，参数展示退化为逐字符索引
                  // （"LS: 0: {, 1: \""，CEO 五轮复测 2026-08-18）。
                  const tcId = String(tc.id ?? tc.tool_call_id ?? `#${toolCount}`);
                  toolStartTimes.set(tcId, Date.now());
                  const rawInput = tc.input ?? tc.arguments ?? {};
                  let toolInput: Record<string, unknown> = {};
                  if (typeof rawInput === 'string') {
                    try { toolInput = JSON.parse(rawInput); } catch { toolInput = { raw: rawInput }; }
                  } else if (rawInput && typeof rawInput === 'object') {
                    toolInput = rawInput;
                  }
                  writeSSE('tool_use', {
                    id: tc.id ?? tc.tool_call_id, // agent-core tool_call.id — clients match result→card
                    toolName: tc.name ?? tc.tool_name ?? 'unknown',
                    input: toolInput,
                  });
                  // Update progress
                  entry.progress = {
                    step: toolCount,
                    totalSteps: toolCount + 1, // estimate
                    description: `Calling tool: ${tc.name ?? 'unknown'}`,
                  };
                  writeSSE('task_progress', entry.progress);
                  break;
                }
                case 'tool_result': {
                  // r19-gate A2：agent-core 事件形为 { tool_call_id, content,
                  // is_error }——旧映射读 name/tool_name/result 恒为空（装后态
                  // 实测每条工具结果 unknown+空输出，TriPilot 渲染面全空）。
                  const tr = event as any;
                  const content = tr.content ?? tr.result ?? '';
                  rebuilt.push({
                    role: 'tool',
                    content: typeof content === 'string' ? content : JSON.stringify(content),
                    tool_call_id: tr.tool_call_id ?? '',
                  });
                  const trId = String(tr.tool_call_id ?? '');
                  const toolStart = toolStartTimes.get(trId);
                  const realDuration = toolStart != null ? Math.max(1, Date.now() - toolStart) : (tr.durationMs ?? 0);
                  toolStartTimes.delete(trId);
                  writeSSE('tool_result', {
                    id: trId, // pairs with tool_use.id for card matching
                    toolName: tr.name ?? tr.tool_name ?? 'unknown',
                    output: typeof content === 'string' ? content : JSON.stringify(content),
                    durationMs: realDuration,
                    isError: tr.is_error === true,
                  });
                  break;
                }
                case 'assistant_message': {
                  const am = event as any;
                  // v2b transcript rebuild: assistant turn with content and/or tool_calls
                  const tcs = Array.isArray(am.tool_calls) && am.tool_calls.length > 0
                    ? am.tool_calls.map((tc: any) => ({
                        id: tc.id,
                        type: 'function' as const,
                        function: { name: tc.function.name, arguments: tc.function.arguments },
                      }))
                    : undefined;
                  if ((am.content && String(am.content).trim()) || tcs) {
                    rebuilt.push({ role: 'assistant', content: am.content ?? '', ...(tcs ? { tool_calls: tcs } : {}) });
                  }
                  if (am.content) {
                    // v2a per-turn dedupe: only emit when this turn had NO streamed
                    // deltas (batch mode). Streamed turns already reached the client
                    // via content_delta — re-emitting here doubled every sentence.
                    if (!hadDeltaSinceLastTool) {
                      deltaContent += am.content;
                      contentAfterLastTool += am.content;
                      writeSSE('delta', { content: am.content });
                    }
                  }
                  hadDeltaSinceLastTool = false; // per-turn boundary reset
                  turnDeltaBuf = ''; // v2d per-turn reset
                  break;
                }
                case 'loop_start': {
                  // Forward loop_start metadata to SSE clients
                  break;
                }
                case 'recovery': {
                  const rec = event as any;
                  if (rec.tier === 2) {
                    console.log(`[trilc:model] degraded to fallback model: ${rec.message}`);
                  }
                  break;
                }
                case 'compaction': {
                  const comp = event as any;
                  console.log(`[trilc:compact] ${comp.message}`);
                  writeSSE('task_progress', {
                    step: toolCount,
                    totalSteps: toolCount + 1,
                    description: comp.message ?? 'Compacting conversation...',
                  });
                  break;
                }
                case 'compaction_failed': {
                  console.warn(`[trilc:compact] failed: ${(event as any).message}`);
                  break;
                }
                case 'compaction_done': {
                  // handled by compaction case above (combined progress reporting)
                  break;
                }
                case 'loop_end': {
                  // Will be handled after the loop
                  break;
                }
                case 'error': {
                  const err = event as any;
                  const errorMessage = err.message ?? String(err);
                  terminalError = errorMessage;
                  // C13/R3: all providers exhausted — agent-core has already
                  // attempted Tier 1 (retry) and Tier 2 (fallback model) recovery.
                  console.error(`[trilc:model] CRITICAL: all providers exhausted for task=${sessionId}: ${errorMessage}`);
                  writeSSE('task_error', {
                    status: 'failed',
                    error: errorMessage,
                  });
                  entry.status = 'error';
                  // S7: Publish task:failed for mirror pusher
                  publish({ type: 'task:failed', taskId: sessionId, error: errorMessage });
                  break;
                }
                default: {
                  // Forward unknown events as generic
                  break;
                }
              }
            }

            if (terminalError) {
              try {
                sessionStore.updateSessionStatus(sessionId, 'error');
              } catch {
                // ignore
              }
              res.end();
              return;
            }

            // C13 + r19-gate A3 + DEFECT-PSEUDO-CHAT v2c/v2d: Post-loop guard — 用户可见产出 =
            // 最后一次工具调用之后的文本结论；模型以文本形式模拟工具调用不算产出。
            // v2 只认 "[tool_use name=X]" 整段纯匹配；v2c 放宽为「包含任意工具语法
            // token 即触发」（枚举整段格式必被变体绕过）；v2d 前移到流中——闭合标签洪水
            // 必须当场掐断（break eventLoop），等回合自然结束 = 用户看着死循环。
            // PSEUDO_TOOL_TOKEN_RE 已在事件循环前声明（v2d）。
            if (pseudoDetectedMidStream) {
              // 剥除当前回合已累计的伪文本（面板可能已泄漏前几十字符，无法撤回，
              // 但 transcript 与 session 落盘保持干净）。
              deltaContent = deltaContent.slice(0, Math.max(0, deltaContent.length - turnDeltaBuf.length));
              contentAfterLastTool = contentAfterLastTool.slice(0, Math.max(0, contentAfterLastTool.length - turnDeltaBuf.length));
            }
            let userVisibleText = (toolCount === 0 ? deltaContent : contentAfterLastTool).trim();
            let isPseudoToolText = pseudoDetectedMidStream || PSEUDO_TOOL_TOKEN_RE.test(userVisibleText);
            // v2h（CEO 十轮）：最终回合只有「承诺式叙述」（"最后确认一下 git 工作区"），
            // 无伪工具语法也能骗过门禁——短文本 + 尾缀行动意图 + 无结论标记 → 视为无结论。
            const TRAILING_INTENT_RE = /(让我|我来|我先|我要|我会|接下来|继续|最后|再去|再看|再查|还需|下一步)[^。；;]{0,30}[。…]?\s*$/;
            const CONCLUSION_MARKERS_RE = /(结论|总结|综上|以上[就是]|已完成|完成验收|一切正常|就绪|通过)/;
            const isTrailingIntent = !isPseudoToolText && userVisibleText.length > 0
              && userVisibleText.length < 150
              && TRAILING_INTENT_RE.test(userVisibleText)
              && !CONCLUSION_MARKERS_RE.test(userVisibleText);
            if (isTrailingIntent) {
              console.warn(`[trilc:chat] model ended with a trailing intent instead of a conclusion (task=${sessionId}) — forcing conclusion turn`);
            }
            if (userVisibleText && isPseudoToolText) {
              console.warn(`[trilc:chat] model emitted pseudo tool-call text instead of a conclusion (task=${sessionId}) — forcing conclusion turn`);
            }
            if (!userVisibleText || isPseudoToolText || isTrailingIntent) {
              let forced = '';
              try {
                if (!_modelClient) _modelClient = createModelClient();
                const nudge = isPseudoToolText
                  ? '（系统纠偏：你最后一条消息把工具调用写成了文本（如 "[tool_use ...]"、"[工具输入] {...}" 等），这不是有效的工具调用，系统无法执行。请不要再调用任何工具，也不要再描述你接下来打算做什么，直接基于已获取的信息，用一段完整的中文给出最终结论。）'
                  : isTrailingIntent
                    ? '（系统纠偏：你最后一条消息只描述了接下来还要确认什么，没有给出结论。请立即基于以上已获取的信息，用一段完整的中文给出最终结论。不要再调用任何工具，不要再描述接下来的计划。）'
                    : '（系统要求：请基于以上已完成的工具调用结果，用一段完整的中文直接给出最终结论。不要再调用任何工具，也不要描述接下来的计划。）';
                const resp = await Promise.race([
                  _modelClient.chat(entry.model, [...rebuilt, { role: 'user', content: nudge }]),
                  new Promise<never>((_, rej) => setTimeout(() => rej(new Error('forced-conclusion timeout (60s)')), 60_000)),
                ]);
                if (resp?.content && resp.content.trim() && !PSEUDO_TOOL_TOKEN_RE.test(resp.content)) {
                  forced = resp.content.trim();
                }
              } catch (fErr) {
                console.warn('[trilc:chat] forced conclusion call failed:', (fErr as Error).message);
              }
              if (forced) {
                // v2g：面板上可能有已泄漏的伪文本碎片——只要本回合或累计产出非空，
                // 结论一律带 \n\n 分隔，避免「{"path":"d从当前工作树结构看…」粘接。
                const prefix = (userVisibleText || leakedThisTurn > 0) ? '\n\n' : '';
                deltaContent += prefix + forced;
                contentAfterLastTool += prefix + forced;
                writeSSE('delta', { content: prefix + forced });
                userVisibleText = forced;
                isPseudoToolText = false;
              }
            }
            const producedAnyOutput = userVisibleText.length > 0 && !isPseudoToolText;
            if (!producedAnyOutput) {
              const emptyError = isPseudoToolText
                ? 'Model ended with tool-call-as-text (e.g. "[tool_use ...]", "[工具输入] ...") instead of a conclusion, and the forced conclusion turn also failed'
                : toolCount > 0
                  ? 'Model called tools but produced no final answer text after tools completed (pseudo-success: narrate → tools → silence)'
                  : 'Model loop completed without any content or tool calls — possible provider failure or empty reasoning-only response';
              console.error(`[trilc:model] CRITICAL: all providers exhausted for task=${sessionId}: ${emptyError}`);
              entry.status = 'error';
              publish({ type: 'task:failed', taskId: sessionId, error: emptyError });
              writeSSE('task_error', { status: 'failed', error: emptyError });
              try { sessionStore.updateSessionStatus(sessionId, 'error'); } catch { /* ignore */ }
              res.end();
              return;
            }

            // Task completed successfully
            entry.status = 'done';
            // S7: Publish task:succeeded for mirror pusher
            publish({ type: 'task:succeeded', taskId: sessionId, result: { summary: deltaContent.slice(0, 200) } });
            writeSSE('task_done', {
              status: 'success',
              summary: deltaContent
                ? deltaContent.slice(0, 200) + (deltaContent.length > 200 ? '...' : '')
                : 'Task completed',
            });

            // 2.1/2.2: Post result back to TriMC
            postTaskResultToTriMC(sessionId, 'success', deltaContent || undefined).catch(() => {});

            // Persist session as completed
            try {
              sessionStore.saveMessages(sessionId, [
                { role: 'user', content: entry.message },
                { role: 'assistant', content: deltaContent || 'Task completed' },
              ]);
              sessionStore.updateSessionStatus(sessionId, 'completed');
            } catch (saveErr) {
              console.warn('[trilc:sse] failed to save session:', (saveErr as Error).message);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[trilc:model] CRITICAL: all providers exhausted for task=${sessionId}: ${msg}`);
            entry.status = 'error';
            publish({ type: 'task:failed', taskId: sessionId, error: msg });
            writeSSE('task_error', { status: 'failed', error: msg });
            // 2.1/2.2: Post failure result back to TriMC
            postTaskResultToTriMC(sessionId, 'failed', undefined, msg).catch(() => {});

            try {
              sessionStore.updateSessionStatus(sessionId, 'error');
            } catch {
              // ignore
            }
          }

          // Cleanup
          res.end();
          return;
        }

        // ── POST /internal/v1/sessions/{id}/cancel ──
        // W30 S4: Cancel a running task. Marks session as cancelled and aborts SSE stream.
        if (req.url?.startsWith('/internal/v1/sessions/') && req.url.endsWith('/cancel') && req.method === 'POST') {
          const sessionId = req.url.split('/')[4]; // /internal/v1/sessions/{id}/cancel

          // Check in-memory task streams
          const entry = taskStreams.get(sessionId);
          if (entry && (entry.status === 'pending' || entry.status === 'running')) {
            entry.status = 'cancelled';
            // S7: Publish task:cancelled for mirror pusher
            publish({ type: 'task:cancelled', taskId: sessionId });
          }

          // Update persistent session store
          try {
            const session = sessionStore.getSession(sessionId);
            if (session) {
              sessionStore.updateSessionStatus(sessionId, 'interrupted');
            } else {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
              return;
            }
          } catch {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
            return;
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionId, status: 'cancelled' }));
          return;
        }

        // ── GET /internal/v1/sessions ──
        // Lists sessions with optional status filter.
        // Query: ?status=running|completed|failed|cancelled&limit=20
        // W30 S4: Merges in-memory taskStreams (for running tasks) with persistent sessionStore.
        if (req.url?.startsWith('/internal/v1/sessions') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const statusFilter = urlObj.searchParams.get('status');
          const limit = parseInt(urlObj.searchParams.get('limit') ?? '20', 10);

          const result: Array<{
            id: string;
            title?: string;
            status: string;
            progress?: { step: number; totalSteps: number; description: string };
            createdAt: string;
            updatedAt: string;
            completedAt: string | null;
          }> = [];

          // Include in-memory task streams (current/active tasks)
          if (!statusFilter || statusFilter === 'running') {
            for (const [id, entry] of taskStreams) {
              if (statusFilter && entry.status !== statusFilter) continue;
              result.push({
                id: entry.sessionId,
                title: entry.message.slice(0, 80),
                status: entry.status,
                progress: entry.progress,
                createdAt: new Date(entry.createdAt).toISOString(),
                updatedAt: new Date(entry.createdAt).toISOString(),
                completedAt: null,
              });
            }
          }

          // Include persistent sessions from sessionStore
          const storeFilter: SessionStatus | undefined =
            statusFilter === 'running' ? 'active' :
            statusFilter === 'failed' ? 'interrupted' :
            statusFilter === 'cancelled' ? undefined :
            statusFilter as SessionStatus | undefined;

          if (storeFilter || !statusFilter) {
            const sessions = sessionStore.listSessions({ status: storeFilter, limit });
            for (const s of sessions) {
              // Skip sessions already in taskStreams (avoid duplicates)
              if (taskStreams.has(s.id)) continue;
              const summary = sessionStore.getSessionSummary(s.id);
              let displayStatus: string = s.status;
              if (s.status === 'active' || s.status === 'interrupted') displayStatus = 'running';
              result.push({
                id: s.id,
                title: summary?.lastUserMessage?.slice(0, 80) ?? undefined,
                status: displayStatus,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                completedAt: s.closedAt,
              });
            }
          }

          // Sort by updatedAt descending, limit
          result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          const limited = result.slice(0, limit);

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: limited.length, sessions: limited }));
          return;
        }

        // ── C15: POST /internal/v1/sessions/{id}/compact ──
        // Manual compaction: reads session messages, calls compactConversation(),
        // returns summary + tokensRemoved. Optionally persists compacted messages.
        const compactMatch = req.url?.match(/^\/internal\/v1\/sessions\/([^/]+)\/compact$/);
        if (compactMatch && req.method === 'POST') {
          try {
            const sessionId = compactMatch[1];
            const session = sessionStore.getSession(sessionId);
            if (!session) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found', message: `Session ${sessionId} not found` }));
              return;
            }

            const messages = sessionStore.getMessages(sessionId);
            if (messages.length < 3) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_enough_messages', message: 'Need at least 3 messages to compact' }));
              return;
            }

            // Parse optional body for custom instructions
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            let body: { instructions?: string; persist?: boolean } = {};
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* empty body OK */ }

            const { compactConversation } = await import('../services/compact/compact.js');
            const triLcMessages = messages
              .filter((m) =>
                (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length > 0)
              .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));

            const result = await compactConversation(triLcMessages, body.instructions);

            // Optionally persist the compacted summary
            if (body.persist !== false) {
              sessionStore.saveMessages(sessionId, [
                { role: 'assistant', content: `[Compacted conversation summary]\n${result.summary}` },
              ]);
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              sessionId,
              summaryLength: result.summary.length,
              summary: result.summary,
              tokensRemoved: result.tokensRemoved,
              originalMessageCount: messages.length,
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'compact_failed', message: msg }));
          }
          return;
        }

        // ── POST /internal/v1/cron/jobs ──
        // Add a new cron job. Body: CronJobCreate JSON.
        if (req.url === '/internal/v1/cron/jobs' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(raw); } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          // P0-3 命令白名单（创建与 PATCH 更新两入口共拦，PATCH 可改 command 字段）：
          // 携带非空 command 且不在精确等值白名单 ⇒ 403；缺省空集 = 全拒（fail-closed）。
          if (!cronCommandHttpAllowed(body.command)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'command_not_allowed' }));
            return;
          }
          try {
            const job = await cronEngine.addJob({
              ...(body as Record<string, unknown>),
              systemPrompt: (body.systemPrompt as string) ?? '',
            } as never);
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, job }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/cron/jobs ──
        // List all cron jobs.
        if (req.url === '/internal/v1/cron/jobs' && req.method === 'GET') {
          try {
            const jobs = await cronEngine.listJobs();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, jobs, count: jobs.length }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── PATCH /internal/v1/cron/jobs/{id} ──
        // Update a cron job. Body: CronJobPatch JSON.
        if (req.url?.startsWith('/internal/v1/cron/jobs/') && req.method === 'PATCH') {
          const jobIdMatch = req.url.match(/^\/internal\/v1\/cron\/jobs\/(.+)$/);
          if (!jobIdMatch) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_path' }));
            return;
          }
          const jobId = decodeURIComponent(jobIdMatch[1]);
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(raw); } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          // P0-3 命令白名单（更新入口）：PATCH 载荷可改 command，必须同口径拦截。
          if (!cronCommandHttpAllowed(body.command)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'command_not_allowed' }));
            return;
          }
          try {
            const job = await cronEngine.updateJob(jobId, body as any);
            if (!job) {
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, error: 'not_found' }));
              return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, job }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── DELETE /internal/v1/cron/jobs/{id} ──
        // Remove a cron job.
        if (req.url?.startsWith('/internal/v1/cron/jobs/') && req.method === 'DELETE') {
          const jobIdMatch = req.url.match(/^\/internal\/v1\/cron\/jobs\/(.+)$/);
          if (!jobIdMatch) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_path' }));
            return;
          }
          const jobId = decodeURIComponent(jobIdMatch[1]);
          try {
            await cronEngine.removeJob(jobId);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── POST /internal/v1/cron/jobs/{id}/run ──
        // Immediately run a cron job. Body: { force?: boolean }
        if (req.url?.startsWith('/internal/v1/cron/jobs/') && req.url.endsWith('/run') && req.method === 'POST') {
          const jobIdMatch = req.url.match(/^\/internal\/v1\/cron\/jobs\/(.+)\/run$/);
          if (!jobIdMatch) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_path' }));
            return;
          }
          const jobId = decodeURIComponent(jobIdMatch[1]);
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { force?: boolean } = {};
          try { body = JSON.parse(raw); } catch { /* empty body OK */ }
          try {
            const result = await cronEngine.runJob(jobId, body.force);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/cron/log ──
        // Query: ?jobId=<id>&limit=<n>. Without jobId returns recent from all jobs.
        if (req.url?.startsWith('/internal/v1/cron/log') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const jobId = urlObj.searchParams.get('jobId');
          const limit = parseInt(urlObj.searchParams.get('limit') ?? '20', 10);
          try {
            const logs = jobId
              ? await cronEngine.getExecutionLogs(jobId, limit)
              : await cronEngine.getRecentExecutionLogs(limit);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, logs, count: logs.length }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/cron/status ──
        if (req.url === '/internal/v1/cron/status' && req.method === 'GET') {
          try {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ok: true,
              status: {
                running: cronEngine.isRunning,
                degraded: cronEngine.isDegraded(),
                consecutiveFailures: cronEngine.consecutiveFailures,
                jobCount: cronEngine.jobCount,
              },
            }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: msg }));
          }
          return;
        }

        // ── GET /internal/v1/update/check ──
        // ACT2: Returns update information comparing local version.json
        // against the latest GitHub Release. TriPilot consumes this to show
        // update notifications. Query: ?force=true to bypass cache.
        if (req.url?.startsWith('/internal/v1/update/check') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          await updateCheckHandler(req, res, urlObj.searchParams);
          return;
        }

        // ── GET/POST /internal/v1/notifications ──
        // REQ-021: system notifications for clients (TriPilot / trilc chat).
        // POST: external scripts (e.g. weekly_plane_shift) push completion notices.
        // GET: clients pull unread notifications; ?ack=1 marks read.
        if (req.url === '/internal/v1/notifications' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) { chunks.push(chunk); }
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { /* ignore */ }
          const notice = {
            id: `ntf_${Date.now().toString(36)}`,
            title: String(body.title ?? '通知'),
            body: String(body.body ?? ''),
            context: String(body.context ?? 'system'),
            createdAt: new Date().toISOString(),
            read: false,
          };
          notices.push(notice);
          if (notices.length > 100) notices.shift(); // cap
          try { await writeFile(noticeFile, JSON.stringify(notices, null, 2), 'utf-8'); } catch { /* best-effort */ }
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, notification: notice }));
          return;
        }
        if (req.url?.startsWith('/internal/v1/notifications') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const ack = urlObj.searchParams.get('ack') === '1';
          if (ack) { for (const n of notices) n.read = true; try { await writeFile(noticeFile, JSON.stringify(notices, null, 2), 'utf-8'); } catch {} }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, notifications: notices.filter((n) => !n.read || ack), count: notices.filter((n) => !n.read).length }));
          return;
        }

        // ── LG-026 信件端点五件（P2-B1/B2；全在全局门后：Host/Origin + X-Internal-Token 已校验）──
        // 通用面双实例可用（P4 互备基座）；wake/组长注册仅通道 profile 生效（B3）。

        // POST /internal/v1/letters — 寄信 → { letter_id, seq_no }
        // payload 写入半校验（O2 双保险）：必须为可 JSON 序列化的非空结构。
        if (req.url === '/internal/v1/letters' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          let body: Record<string, unknown>;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }
          const from = body.from;
          const to = body.to;
          const priority = body.priority ?? '常规';
          if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_envelope', message: 'from/to must be non-empty strings' }));
            return;
          }
          const pri = priority as LetterPriority;
          if (!['常规', '重要', '急件'].includes(pri)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_priority', message: 'priority must be 常规|重要|急件' }));
            return;
          }
          let payloadForStore: unknown = body.payload ?? null;
          try {
            payloadForStore = JSON.parse(JSON.stringify(payloadForStore ?? null));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_payload', message: 'payload must be JSON-serializable' }));
            return;
          }
          try {
            const rec = letterStore.insertLetter({
              from,
              to,
              priority: pri,
              payload: payloadForStore,
              ttlSeconds: typeof body.ttl === 'number' ? body.ttl : null,
              letterId: typeof body.letter_id === 'string' && body.letter_id ? body.letter_id : undefined,
            });
            // B4 唤醒链：入件即醒（同进程 wake；通道态组长 eventDriven 即办，无组长时空转无害）
            heartbeatRunner.requestHeartbeatNow({ reason: 'action' });
            res.writeHead(201, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, letter_id: rec.letterId, seq_no: rec.seqNo }));
          } catch (err) {
            const msg = (err as Error).message;
            const status = msg.startsWith('duplicate_id') ? 409 : 400;
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'letter_rejected', message: msg }));
          }
          return;
        }

        // GET /internal/v1/letters?box=&to=&status=&since_seq=&limit= — 收信/积压重放
        if (req.url?.startsWith('/internal/v1/letters') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const box = urlObj.searchParams.get('box');
          const to = urlObj.searchParams.get('to') ?? undefined;
          const from = urlObj.searchParams.get('from') ?? undefined;
          const status = urlObj.searchParams.get('status') ?? undefined;
          const sinceSeqRaw = urlObj.searchParams.get('since_seq');
          const limitRaw = urlObj.searchParams.get('limit');
          if (box === 'in' && !to) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'box_in_requires_to' }));
            return;
          }
          if (box === 'out' && !from) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'box_out_requires_from' }));
            return;
          }
          const letters = letterStore.listLetters({
            to,
            from,
            status: status as never,
            sinceSeq: sinceSeqRaw !== null ? Number(sinceSeqRaw) : undefined,
            limit: limitRaw !== null ? Number(limitRaw) : undefined,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, letters, count: letters.length }));
          return;
        }

        // POST /internal/v1/letters/wake — 组长唤醒触发（127.0.0.1 本地语义，
        // listener 只绑 127.0.0.1 + 全局门已过；内部转 requestHeartbeatNow action）
        if (req.url === '/internal/v1/letters/wake' && req.method === 'POST') {
          heartbeatRunner.requestHeartbeatNow({ reason: 'action' });
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, woken: true, reason: 'action' }));
          return;
        }

        // POST /internal/v1/letters/{id}/state — 状态流转 { action, actor }
        // B2：escalate 走端点层 ACL（组长注册名 + COS 白名单）；拒绝亦写台账留痕。
        // 其余 action 照 store 门禁（store 层不做 actor 白名单只留痕，分层不破）。
        {
          const stateMatch = req.url?.match(/^\/internal\/v1\/letters\/([^/]+)\/state$/);
          if (stateMatch && req.method === 'POST') {
            const letterId = decodeURIComponent(stateMatch[1]!);
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            let body: Record<string, unknown>;
            try {
              body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            } catch {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_json' }));
              return;
            }
            const action = body.action;
            const actor = body.actor;
            if (typeof action !== 'string' || !['deliver', 'read', 'escalate', 'done'].includes(action)) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_action', message: 'action must be deliver|read|escalate|done' }));
              return;
            }
            if (typeof actor !== 'string' || !actor.trim()) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'invalid_actor', message: 'actor must be a non-empty string' }));
              return;
            }
            if (action === 'escalate' && !ESCALATE_ACTOR_ALLOWLIST.includes(actor)) {
              letterStore.appendLedger({ letterId, actor, action: 'escalate_denied' });
              res.writeHead(403, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'escalate_actor_forbidden', message: `escalate actor must be one of: ${ESCALATE_ACTOR_ALLOWLIST.join(', ')}` }));
              return;
            }
            try {
              const rec = letterStore.transition(letterId, action as LetterAction, actor);
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: true, letter: rec }));
            } catch (err) {
              const msg = (err as Error).message;
              const status = msg.startsWith('not_found') ? 404
                : msg.startsWith('actor_forbidden') ? 403
                : msg.startsWith('illegal_transition') ? 409
                : 400;
              res.writeHead(status, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'transition_rejected', message: msg }));
            }
            return;
          }
        }

        // GET /internal/v1/ledger?letter_id=&since=&limit= — 台账读（组长工具白名单同源面）
        if (req.url?.startsWith('/internal/v1/ledger') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const letterId = urlObj.searchParams.get('letter_id') ?? undefined;
          const sinceRaw = urlObj.searchParams.get('since');
          const limitRaw = urlObj.searchParams.get('limit');
          const entries = letterStore.listLedger({
            letterId,
            sinceId: sinceRaw !== null ? Number(sinceRaw) : undefined,
            limit: limitRaw !== null ? Number(limitRaw) : undefined,
          });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, entries, count: entries.length }));
          return;
        }

        // ── POST /shutdown ──
        // Graceful shutdown endpoint for Windows-compatible daemon stop.
        // On Windows, SIGTERM is a hard kill; this provides a clean alternative.
        if (req.url === '/shutdown' && req.method === 'POST') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: 'shutting down' }));
          // Defer shutdown to let response flush
          setImmediate(() => {
            console.log('[trilc] graceful shutdown via /shutdown');
            process.exit(0);
          });
          return;
        }

        // ── C10: MCP Server Management Endpoints ──

        // GET /internal/v1/mcp/servers — list all configured + connected servers
        if (req.url === '/internal/v1/mcp/servers' && req.method === 'GET') {
          try {
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const { listProjectMCPServers } = await import('../mcp/mcp-config.js');
            const mcp = getMcpClientManager();
            const connected = mcp?.listServers() ?? [];
            const connectedNames = new Set(connected.map(s => s.name));
            const configured = listProjectMCPServers(env.cwd);

            const servers = configured.map(c => {
              const live = connected.find(s => s.name === c.name);
              return {
                name: c.name,
                type: c.type,
                status: c.disabled ? 'disabled' : live ? 'connected' : 'disconnected',
                toolCount: live?.toolCount ?? 0,
                resourceCount: live?.resourceCount ?? 0,
                promptCount: live?.promptCount ?? 0,
                source: c.source.replace(env.cwd, '.').replace(/\\/g, '/'),
              };
            });

            // Add connected-but-not-in-config servers
            for (const live of connected) {
              if (!configured.some(c => c.name === live.name)) {
                servers.push({
                  name: live.name,
                  type: live.type,
                  status: 'connected',
                  toolCount: live.toolCount,
                  resourceCount: live.resourceCount,
                  promptCount: live.promptCount,
                  source: '(runtime)',
                } as typeof servers[number]);
              }
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ servers, count: servers.length }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_error', message: (err as Error).message }));
          }
          return;
        }

        // GET /internal/v1/mcp/servers/{name} — single server status
        const mcpServerMatch = req.url?.match(/^\/internal\/v1\/mcp\/servers\/([^/]+)$/);
        if (mcpServerMatch && req.method === 'GET') {
          try {
            const serverName = decodeURIComponent(mcpServerMatch[1]);
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const mcp = getMcpClientManager();
            const connected = mcp?.listServers().find(s => s.name === serverName);

            if (!connected) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ name: serverName, status: 'disconnected', connected: false }));
              return;
            }

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              ...connected,
              connected: true,
            }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_error', message: (err as Error).message }));
          }
          return;
        }

        // POST /internal/v1/mcp/servers/add — runtime connect a server
        if (req.url === '/internal/v1/mcp/servers/add' && req.method === 'POST') {
          // P0-4 MCP 运行时接入显式开关（fail-closed 缺省禁用）：即使过了全局门，
          // 未显式置位 TRILC_MCP_RUNTIME_ADD（'1'/'true'）时运行时添加一律拒。
          const mcpAddFlag = process.env.TRILC_MCP_RUNTIME_ADD ?? '';
          if (mcpAddFlag !== '1' && mcpAddFlag !== 'true') {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_runtime_add_disabled' }));
            return;
          }
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const mcp = getMcpClientManager();
            if (!mcp) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'mcp_not_initialized' }));
              return;
            }
            const registered = await mcp.connectServer({
              name: body.name,
              type: body.type ?? 'stdio',
              command: body.command,
              args: body.args,
              env: body.env,
              url: body.url,
            });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name: body.name, toolsRegistered: registered.length, toolNames: registered }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_add_failed', message: (err as Error).message }));
          }
          return;
        }

        // POST /internal/v1/mcp/servers/{name}/remove — runtime disconnect
        const mcpRemoveMatch = req.url?.match(/^\/internal\/v1\/mcp\/servers\/([^/]+)\/remove$/);
        if (mcpRemoveMatch && req.method === 'POST') {
          try {
            const serverName = decodeURIComponent(mcpRemoveMatch[1]);
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const mcp = getMcpClientManager();
            if (!mcp) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'mcp_not_initialized' }));
              return;
            }
            await mcp.disconnectServer(serverName);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, name: serverName }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_remove_failed', message: (err as Error).message }));
          }
          return;
        }

        // POST /internal/v1/mcp/servers/refresh — reload config + reconnect
        if (req.url === '/internal/v1/mcp/servers/refresh' && req.method === 'POST') {
          try {
            const { getMcpClientManager } = await import('../tools/mcp-tool.js');
            const { loadMCPServerConfigs } = await import('../mcp/mcp-config.js');
            const mcp = getMcpClientManager();
            if (!mcp) {
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'mcp_not_initialized' }));
              return;
            }
            const configs = loadMCPServerConfigs(env.cwd);
            await mcp.disconnectAll();
            const results: Array<{ name: string; tools: number }> = [];
            for (const config of configs) {
              try {
                const registered = await mcp.connectServer(config);
                results.push({ name: config.name, tools: registered.length });
              } catch (err) {
                results.push({ name: config.name, tools: 0 });
                console.warn(`[mcp] refresh: failed to reconnect "${config.name}": ${(err as Error).message}`);
              }
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, refreshed: results.length, servers: results }));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'mcp_refresh_failed', message: (err as Error).message }));
          }
          return;
        }

        // ── 404 ──
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      // ── Init Chain：启动 load（断点续跑）+ uninitialized 自动转 selfcheck ──
      // 转移记录 + 发布 init:chain-changed；不自动执行探测（探测由
      // POST /internal/v1/init/selfcheck/run 端点触发）。
      try {
        await initChain.load();
        if (initChain.getState() === 'uninitialized') {
          await initChain.transitionTo('selfcheck', 'daemon');
          console.log('[trilc:init] chain uninitialized → selfcheck（daemon 启动转移；探测待端点触发）');
        } else {
          console.log(`[trilc:init] chain resumed: ${initChain.getState()}（断点续跑）`);
        }
      } catch (err) {
        console.warn('[trilc:init] init chain load failed:', (err as Error).message);
      }

      // ── I4：daemon 重启 re-sync 检查（§6.6 尾部，只读 no-op）──
      // 链态 sync/confirm → 读本地 bundle + 调一次 sync/status（远程不可达
      // 静默）；不自动 push、不自动生成（启动期零写面）。
      void runStartupResyncCheck(initSyncDeps);

      await new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(env.port, '127.0.0.1', () => resolve());
      });

      // Read actual port (in case port 0 for OS-assigned)
      const addr = server!.address();
      if (addr && typeof addr === 'object') {
        env.port = addr.port;
      }

      console.log(`[trilc] listening on :${env.port}`);

      // S7: Start mirror pusher (event-driven + 30s heartbeat)
      mirrorPusher.start();

      // ── Heartbeat Runner: default heartbeat agent + onboarding (REQ-001) ──
      const DEFAULT_HEARTBEAT_AGENT: HeartbeatAgentConfig = {
        agentId: "default-heartbeat",
        intervalMs: 30 * 60 * 1000,
        model: "tmv-deepseek-v4-flash",
        maxTurns: 10,
        systemPrompt: "You are a system heartbeat agent. Report current status concisely.",
        userMessage: "Periodic heartbeat check. Confirm all systems nominal.",
      };

      // i2-2 §五 叙事态下线：REQ-20260805-001 叙事 onboarding heartbeat agent
      // 不再注册（ONBOARDING 阶段驱动 = 装配端点 + init:* 事件流，无叙事并存
      // 路径）。结构化流程 = role-catalog / assemble / onboarding endpoints。
      const agents: HeartbeatAgentConfig[] = [DEFAULT_HEARTBEAT_AGENT];

      // ── LG-026-P2-B3：组长注册（仅通道 profile 生效）──
      // spec §8.6：注册制组长 in-process agent 资格（白名单式单 agent）。
      // 事件驱动唤醒（eventDriven：无 interval 定时，信箱入件 requestHeartbeatNow
      // 即醒）；定时检查推送/提醒职责归 cron 面承载（既有立法），不入 runner interval。
      // 工具白名单 = letter_* 五件（minTier:'heartbeat' 清单级不可见于 main 以下 tier，
      // 无 shell 无仓写）；cwd 钉通道实例 DATA_DIR；agentId 与 LetterStore leaderId
      // 同源 LEAD_AGENT_ID 单一来源常量。
      if (process.env.TRILC_CHANNEL_MODE === '1') {
        registerLeadTools(letterStore);
        agents.push({
          agentId: LEAD_AGENT_ID,
          intervalMs: 24 * 60 * 60 * 1000, // eventDriven 不参与调度，仅占位
          eventDriven: true,
          maxTurns: 6,
          systemPrompt: [
            `你是 TriLC 业务组长「${LEAD_AGENT_ID}」（LG-026 注册制组长，事件驱动唤醒，单次唤醒办完即眠）。`,
            '职责：①查收待投信件（letter_list_pending）并逐封投递（letter_deliver）；',
            '②重要件/急件超时未读时按公开标准形式复核，复核通过则升级（letter_escalate，升级链固定 组长→COS→BOD，终裁升级权在 COS）；',
            '③需要回信或通报时以组长名义寄信（send_letter）；④办理过程的关键动作查台账（ledger_read）核对留痕。',
            '业务规则锚：LG-026 设计方案书 §二③④ + trimlc-channel-daemon-spec §8.6。',
            '状态机：待投→已投（你唯一执行）→已读（收件人唯一定读权，你不得代标）；升级=旁路冻结原信+新信封引用原信。',
            '优先级三档：常规（工作窗）/重要（上线即报+定时重推）/急件（即时升级链）。',
            '约束：只办理信箱事务，不触代码仓，不做信件内容质量判断（内容责任在发件人）。',
          ].join('\n'),
          userMessage: '唤醒：查收待投信件并办理（投递/按需升级/回信），完成后简报办理结果。',
          cwd: env.dataDir, // 通道实例 DATA_DIR（%LOCALAPPDATA%/trilc-channel/）
        });
        console.log(`[trilc] lead agent registered (channel mode): ${LEAD_AGENT_ID}`);
      }

      heartbeatRunner.updateAgents(agents);
      heartbeatRunner.start();
      publish({ type: "heartbeat:sent", nodeId: env.nodeId });
      console.log(`[trilc] heartbeat runner started (${agents.length} agent${agents.length > 1 ? "s" : ""})`);

      // ── Session Reaper: hourly sweep ──
      sessionReaper.start();
      publish({ type: "cron:sweep", count: 0 });

      // ── Cron Engine: load persisted jobs ──
      cronEngine.start().catch((err) => {
        console.warn("[trilc] cron engine start failed:", (err as Error).message);
      });

      // ── ACT2: Update check loop ──
      updateCheckLoop = startUpdateCheckLoop({
        repo: process.env.TRILC_GITHUB_REPO ?? 'MoRen9527/TriLC',
      });
      console.log("[trilc] update check loop started");

      // ── Signal handling (Linux detached runtime) ──
      // On Linux, the CLI sends SIGTERM as fallback after graceful /shutdown.
      // Handle both SIGTERM and SIGINT for clean daemon shutdown.
      const gracefulStop = async (signal: string) => {
        console.log(`[trilc] received ${signal}, shutting down...`);
        console.log('[trilc] cancelling all managed shell processes...');
        cancelAllShellProcesses();
        cronEngine.stop();
        sessionReaper.stop();
        heartbeatRunner.stop();
        mirrorPusher.stop();
        updateCheckLoop?.stop();
        if (server) {
          await new Promise<void>((res) => server!.close(() => res()));
          server = null;
        }
        connMgr.stopHealthCheckLoop();
        process.exit(0);
      };
      process.on('SIGTERM', () => gracefulStop('SIGTERM'));
      process.on('SIGINT', () => gracefulStop('SIGINT'));
    },

    get port(): number {
      return env.port;
    },

    get connectionState(): ConnectionState {
      return connMgr.currentState;
    },

    async stop(): Promise<void> {
      cronEngine.stop();
      sessionReaper.stop();
      heartbeatRunner.stop();
      mirrorPusher.stop();
      updateCheckLoop?.stop();
      connMgr.stopHealthCheckLoop();
      stopKeyCache();
      cancelAllShellProcesses();
      try { letterStore.close(); } catch { /* best-effort */ }
      // FADE-ASSESS-003: 关闭 contract-resolver 文件监听（knowledge watch 增量），
      // 否则 fs.watch 句柄会拖住事件循环（测试/退出流程挂起）
      try {
        getContractResolver().closeWatcher();
      } catch { /* resolver 未初始化 */ }
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
    },
  };
}

// ── Anthropic API helpers ──

interface AnthropicRequest {
  model?: string;
  fallback_model?: string;
  messages?: AnthropicMessage[];
  system?: string;
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  /** P3: opt-in interactive mode — enables TUI question/permission prompts. */
  interactive?: boolean;
  /** C8: Permission mode override (default/acceptEdits/auto/dontAsk/bypass/plan). */
  permission_mode?: string;
  /** TC-001: 执行持续性三机制可选字段（全部缺省时零行为变化）；
   * 含 TC-1 续跑参数——合并去重自本地透传提交 */
  task_plan?: TaskPlan;
  continue_on_incomplete?: boolean;
  incomplete_check_prompt?: string;
  continue_max_rounds?: number;
  continue_prompt?: string;
  progress_reminder_interval?: number;
  progress_reminder_template?: string;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  is_error?: boolean;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

// ── OpenAI Chat Completions types ──
// Used by the /chat/completions endpoint for opencode / Vercel AI SDK compatibility.

interface OpenAIRequest {
  model?: string;
  fallback_model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  /** C8: Permission mode override (default/acceptEdits/auto/dontAsk/bypass/plan). */
  permission_mode?: string;
  /** TC-001: 执行持续性三机制可选字段（与 /v1/messages 对齐，全部缺省时零行为变化）；
   * 含 TC-1 续跑参数（continue_max_rounds/continue_prompt）——合并去重自本地透传提交 */
  task_plan?: TaskPlan;
  continue_on_incomplete?: boolean;
  incomplete_check_prompt?: string;
  continue_max_rounds?: number;
  continue_prompt?: string;
  progress_reminder_interval?: number;
  progress_reminder_template?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

interface ModelInfo {
  id: string;
  displayName: string;
  createdAt: string;
}

/**
 * C12: Validate that a model name exists in the TriModel registry.
 * Returns detailed error for fallback-chain diagnostics.
 * W30 lesson: fallback chain must end at a registered model — never assume defaults.
 */
function validateModelAgainstRegistry(model: string): { valid: boolean; error?: string } {
  try {
    if (!_modelClient) {
      _modelClient = createModelClient();
    }
    const registeredModels = _modelClient.listModels();
    if (registeredModels.length === 0) {
      return {
        valid: false,
        error: `Model registry is empty — no providers configured. Check API keys (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.).`,
      };
    }
    if (registeredModels.includes(model)) {
      return { valid: true };
    }
    return {
      valid: false,
      error: `Model "${model}" not in registry. Available: ${registeredModels.join(', ')}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trilc:model] cannot validate model "${model}": ${msg}`);
    return {
      valid: false,
      error: `Model registry unavailable — cannot validate "${model}": ${msg}`,
    };
  }
}

/**
 * C12/R2: Startup-time model registry integrity check.
 * Runs after key cache init + env propagation. Validates that the configured
 * default model and well-known fallback targets exist in TriModel's registry.
 * Gaps emit WARNING; never blocks startup.
 * W30 lesson: a registry gap ("Unknown model") in prod is a silent user-facing failure.
 */
function validateModelRegistry(): void {
  try {
    const client = createModelClient();
    const models = client.listModels();
    if (models.length === 0) {
      console.warn('[trilc:model] WARNING: model registry is empty — no providers configured, chat will fail');
      console.warn('[trilc:model]         check API keys (DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, etc.)');
      return;
    }

    const defaultModel = getKeyCache()?.defaultModel
      ?? process.env.TRIMODEL_DEFAULT_MODEL
      ?? 'tmv-deepseek-v4-pro';

    // Known ultimate fallback targets — these MUST be in the registry for
    // agent-core's Tier 2 recovery to work. If missing, tmv-* models will
    // have no viable fallback path when TriStaciss is offline.
    const criticalFallbacks = ['tmv-deepseek-v4-flash', 'tmv-deepseek-v4-pro'];
    const missing: string[] = [];
    if (!models.includes(defaultModel)) {
      missing.push(defaultModel);
    }
    for (const fb of criticalFallbacks) {
      if (!models.includes(fb)) missing.push(fb);
    }

    if (missing.length > 0) {
      console.warn(`[trilc:model] WARNING: model(s) not in registry: ${missing.join(', ')} — check provider API keys`);
    }
    console.log(
      `[trilc:model] registry check: ${models.length} models (${models.join(', ')})` +
      (missing.length === 0 ? ', fallback chain ok' : ', fallback chain incomplete — see WARNING above'),
    );
  } catch (err) {
    console.warn(`[trilc:model] registry check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let _modelClient: ReturnType<typeof createModelClient> | null = null;
let _modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 60_000; // 1 minute

// C8: Default permission mode — set from env TRILC_PERMISSION_MODE at startup,
// overridable per-request via permission_mode body field. Backward-compat: bypassPermissions.
let _defaultPermissionMode: string = 'bypassPermissions';

// C9: CLI rule patterns, additional dirs, and print mode (loaded from env at startup)
let _cliAllowRulePatterns: string[] = [];
let _cliDenyRulePatterns: string[] = [];
let _cliAdditionalDirs: string[] = [];
let _printMode = false;
let _persistedPermissionRules: Array<{ toolName: string; behavior: 'allow' | 'deny'; source: 'userSettings' }> = [];

/** C9: Parse a JSON string array from env (e.g. '["Read","Glob(git)"]'). */
function parseRuleListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

/** C9: Parse a JSON string array of paths from env. */
function parseStringListEnv(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch { return []; }
}

/** C9: Parse a CLI rule pattern "ToolName" or "ToolName(content)" into PermissionRule. */
function parseCliRulePattern(pattern: string, behavior: 'allow' | 'deny'): { toolName: string; content?: string } | null {
  const match = pattern.match(/^([^(]+)(?:\((.+)\))?$/);
  if (!match) return null;
  const toolName = match[1].trim();
  const content = match[2]?.trim();
  if (!toolName) return null;
  return { toolName, content: content || undefined };
}

/**
 * C9: Build the complete permission rules array for the current session.
 * Merges CLI rules (highest priority) + persisted rules from disk.
 * CLI rules are source='cliArg', persisted rules are source='userSettings'.
 * Deny rules come before allow rules (pipeline step 1 vs step 6).
 */
function buildSessionPermissionRules(): PermissionRule[] {
  const rules: PermissionRule[] = [];

  // 1. CLI deny rules (highest priority)
  for (const pattern of _cliDenyRulePatterns) {
    const parsed = parseCliRulePattern(pattern, 'deny');
    if (parsed) {
      rules.push({
        toolName: parsed.toolName,
        ...(parsed.content ? { content: parsed.content } : {}),
        behavior: 'deny',
        source: 'cliArg',
      });
    }
  }

  // 2. Persisted deny rules from disk
  for (const pr of _persistedPermissionRules) {
    if (pr.behavior === 'deny') {
      rules.push({ toolName: pr.toolName, behavior: 'deny', source: 'userSettings' });
    }
  }

  // 3. CLI allow rules
  for (const pattern of _cliAllowRulePatterns) {
    const parsed = parseCliRulePattern(pattern, 'allow');
    if (parsed) {
      rules.push({
        toolName: parsed.toolName,
        ...(parsed.content ? { content: parsed.content } : {}),
        behavior: 'allow',
        source: 'cliArg',
      });
    }
  }

  // 4. Persisted allow rules from disk
  for (const pr of _persistedPermissionRules) {
    if (pr.behavior === 'allow') {
      rules.push({ toolName: pr.toolName, behavior: 'allow', source: 'userSettings' });
    }
  }

  return rules;
}

/** C8: Resolve the effective permission mode for a request. */
function resolvePermissionMode(requestOverride?: string): string {
  if (requestOverride) {
    // Accept shorthand 'bypass' → 'bypassPermissions'
    if (requestOverride === 'bypass') return 'bypassPermissions';
    return requestOverride;
  }
  return _defaultPermissionMode;
}

// TriModel configuration-plane API URL for HTTP-priority model fetching
let _trimodelApiUrl = 'http://127.0.0.1:3333';

export function setTrimodelApiUrl(url: string): void {
  _trimodelApiUrl = url;
}

async function fetchModelsFromApi(): Promise<ModelInfo[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${_trimodelApiUrl}/v1/models`, { signal: controller.signal });
    if (!res.ok) throw new Error(`TriModel API ${res.status}`);
    const json = await res.json() as { data: Array<{ id: string; display_name?: string; created?: number }> };
    return (json.data ?? []).map((m) => ({
      id: m.id,
      displayName: m.display_name ?? m.id,
      createdAt: String(m.created ? new Date(m.created * 1000).toISOString().slice(0, 10) : '2025-01-01'),
    }));
  } finally {
    clearTimeout(timeout);
  }
}

async function getAvailableModels(): Promise<ModelInfo[]> {
  // Return cached models if still valid
  if (_modelCache && _modelCache.expiresAt > Date.now()) {
    return _modelCache.models;
  }

  // Phase 1: Try HTTP from TriModel API first
  try {
    const models = await fetchModelsFromApi();
    _modelCache = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return models;
  } catch (apiErr) {
    console.warn(`[trilc] TriModel API unreachable (${apiErr instanceof Error ? apiErr.message : String(apiErr)}), falling back to library`);
  }

  // Fallback: direct library import (TriModel npm package)
  try {
    if (!_modelClient) {
      _modelClient = createModelClient();
    }
    const modelIds = _modelClient.listModels();
    const models: ModelInfo[] = modelIds.map((id) => ({
      id,
      displayName: id,
      createdAt: '2025-01-01',
    }));
    _modelCache = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return models;
  } catch (err) {
    // C12: W30 lesson — never return hardcoded defaults when registry is unavailable.
    // A hardcoded default masks the root cause and causes "Unknown model" downstream.
    console.error(`[trilc:model] model registry unavailable (API + library both failed): ${err instanceof Error ? err.message : String(err)}`);
    if (_modelCache) {
      console.warn('[trilc:model] serving stale cached model list as last resort');
      return _modelCache.models;
    }
    return [];
  }
}

/**
 * Convert Anthropic Messages API format to internal Message[] format.
 * Handles:
 * - Simple text content: { role: "user", content: "hello" }
 * - Content blocks: [{ type: "text", text: "hello" }]
 * - Tool results: [{ type: "tool_result", tool_use_id: "...", content: "..." }]
 */
function convertAnthropicMessages(anthropicMessages: AnthropicMessage[]): Message[] {
  const result: Message[] = [];

  for (const msg of anthropicMessages) {
    if (typeof msg.content === 'string') {
      // Simple text message
      result.push({
        role: msg.role,
        content: msg.content,
      });
    } else if (Array.isArray(msg.content)) {
      // Content blocks — may contain text AND tool results
      const textBlocks: string[] = [];
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];
      const toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          textBlocks.push(block.text);
        } else if (block.type === 'tool_use') {
          toolUses.push({
            id: block.id ?? '',
            name: block.name ?? '',
            input: block.input ?? {},
          });
        } else if (block.type === 'tool_result') {
          const resultContent = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content)
              ? block.content.map((c) => c.text ?? '').join('\n')
              : '');
          toolResults.push({
            tool_call_id: block.tool_use_id ?? '',
            content: resultContent,
          });
        }
      }

      // Emit assistant text + tool_use as ONE assistant message carrying tool_calls,
      // so following role:'tool' messages (from tool_result) pair by tool_call_id.
      if (msg.role === 'assistant' && toolUses.length > 0) {
        result.push({
          role: 'assistant',
          content: textBlocks.join('\n'),
          tool_calls: toolUses.map((tu) => ({
            id: tu.id,
            type: 'function' as const,
            function: { name: tu.name, arguments: JSON.stringify(tu.input) },
          })),
        });
      } else if (textBlocks.length > 0) {
        result.push({
          role: msg.role,
          content: textBlocks.join('\n'),
        });
      }

      // Emit tool results as tool messages
      for (const tr of toolResults) {
        result.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.tool_call_id,
        });
      }
    }
  }

  return result;
}

/**
 * Convert Anthropic tool definitions to internal ToolDefinition format.
 */
function convertAnthropicTools(tools: AnthropicTool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: t.input_schema ?? { type: 'object', properties: {} },
    },
  }));
}

/**
 * Build a platform-aware default system prompt.
 *
 * Critical: without this, the model generates Unix-style commands (ls, find,
 * pwd, cat) which either fail or — worse — hang on Windows. Windows `find.exe`
 * with Unix args reads from stdin and blocks until timeout. Telling the model
 * the OS + shell up front prevents the "agent hangs on file search" failure.
 *
 * P2-Batch1-#5: Automatically loads CLAUDE.md from current directory if present.
 * Uses cache-first approach: first call async-loads, subsequent calls use cache.
 */

// Cached CLAUDE.md content per directory
let cachedClaudeMd: { cwd: string; content: string | null; loaded: boolean } | null = null;

// Start async load in background (non-blocking)
function startCLAUDE_mdLoad(cwd: string): void {
  if (cachedClaudeMd && cachedClaudeMd.cwd === cwd && cachedClaudeMd.loaded) return;

  import('node:fs/promises').then(async ({ readFile }) => {
    import('node:path').then(async ({ resolve }) => {
      try {
        const claudeMdPath = resolve(cwd, 'CLAUDE.md');
        const content = await readFile(claudeMdPath, 'utf-8');
        cachedClaudeMd = { cwd, content, loaded: true };
      } catch {
        cachedClaudeMd = { cwd, content: null, loaded: true };
      }
    });
  });
}

export function defaultSystemPrompt(cwd?: string): string {
  const isWin = process.platform === 'win32';
  const shell = isWin
    ? 'Windows. Commands run via cmd.exe. Use Windows-compatible commands: dir (not ls), where (not which), type (not cat), findstr (not grep). Avoid Unix-only flags like -name. Prefer PowerShell-style or native Windows commands.'
    : process.platform === 'darwin'
      ? 'macOS. Commands run via sh.'
      : 'Linux. Commands run via sh.';

  const basePrompt = `You are TriCade, a capable coding and task assistant running on ${shell} When you need to run shell commands or search files, generate commands compatible with this platform. Prefer the Read/Glob/Grep tools for file operations instead of raw shell commands when available.`;

  // r17 ②：公司周平面根注入（读取端，r2 树契约的最后一环）——
  // 模型上下文需知道公司周平面根，否则按旧约定找项目内
  // docs/execution/operating-records（安装态为空/旧数据）→ current-week
  // 判定错误（W33 vs 实际 active W34）。仅读取提示，不改变任何写语义。
  const weeklyPlaneHint = buildWeeklyPlaneHint();

  // P2-Batch1-#5: Trigger async load if needed
  const targetCwd = cwd || process.cwd();
  if (!cachedClaudeMd || cachedClaudeMd.cwd !== targetCwd) {
    // Reset cache and start loading
    cachedClaudeMd = { cwd: targetCwd, content: null, loaded: false };
    startCLAUDE_mdLoad(targetCwd);
  }

  // Append cached content if available; always include agent roster (KI-PH2-001 fix)
  if (cachedClaudeMd && cachedClaudeMd.content) {
    return `${basePrompt}\n\n## Project Instructions (from CLAUDE.md)\n\n${cachedClaudeMd.content}${cachedAgentRoster}${weeklyPlaneHint}`;
  }

  return basePrompt + cachedAgentRoster + weeklyPlaneHint;
}

/**
 * r17 ②：公司周平面读取提示（读取端注入）。
 * 周平面根解析走 src/project/weekly-plane-root.ts（env 显式 → workspace
 * sibling → undefined 回退不注入）。
 *
 * 注入点（r4-1 C 标记，防双注入）：本 hint 有两处消费——
 *   1. defaultSystemPrompt() 内部（no-prompt 路径，见 defaultSystemPrompt）；
 *   2. POST /internal/v1/tasks/submit 外部 append（client systemPrompt 路径，
 *      app.ts 1973 行附近）。
 * 两处互斥：defaultSystemPrompt 返回时已含 hint，外部 append 只发生在
 * client 显式传入 systemPrompt 的分支。新增调用点时必须二选一叠加，
 * 不得同时套用两处。
 */
export function buildWeeklyPlaneHint(): string {
  const planeRoot = resolveWeeklyPlaneRoot();
  if (!planeRoot) return '';
  return `\n\n## Company Weekly Plane (read-only)\n\nThe company weekly operating plane lives at \`${planeRoot}\`. When asked about the current week, weekly indexes (OP-*.json), operating records, or unresolved items, read from this directory instead of any project-local operating-records path. The active week is the \`2026-Wnn\` directory whose OP index has \`status: "active"\` (its index also carries \`latestActiveWeek: true\`).`;
}

/**
 * Convert OpenAI Chat Completions messages to internal Message[] format.
 * Extracts system messages into a separate systemPrompt string.
 */
function convertOpenAIMessages(openaiMessages: OpenAIMessage[]): { systemPrompt: string; internalMessages: Message[] } {
  let systemPrompt = '';
  const internalMessages: Message[] = [];

  for (const msg of openaiMessages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + (msg.content ?? '');
    } else if (msg.role === 'user') {
      internalMessages.push({ role: 'user', content: msg.content ?? '' });
    } else if (msg.role === 'assistant') {
      const toolCalls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.function.name, arguments: tc.function.arguments },
      }));
      internalMessages.push({
        role: 'assistant',
        content: msg.content ?? '',
        tool_calls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      });
    } else if (msg.role === 'tool') {
      internalMessages.push({
        role: 'tool',
        content: msg.content ?? '',
        tool_call_id: msg.tool_call_id ?? '',
      });
    }
  }

  return { systemPrompt, internalMessages };
}

/**
 * Convert OpenAI tool definitions to internal ToolDefinition format.
 */
function convertOpenAITools(tools: OpenAIToolDef[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    },
  }));
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}
