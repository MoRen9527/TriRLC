// ── TriLC Agent Runner ──
// Default heartbeat agent execution: runOnce → agentLoop → persistence.
// MVP: single model, tier 'subagent' (heartbeat-equivalent), session-store persistence.
//
// Called by HeartbeatRunner for each due agent. Runs a single agentLoop
// cycle and persists the result to session-store for recovery and audit.

import { agentLoop } from "@tricompany/agent-core";
import type { PermissionRule } from "@tricompany/agent-core";
import type { HeartbeatRunResult } from "./heartbeat-wake.js";
import type { SessionRecord } from "../session-store/types.js";
import { injectKnowledgeContext, type KnowledgeInjectionResult } from "@trimetaverse/tricode";
import { isEscalationBlockReason, recordKnowledgeMetric } from "@trimetaverse/tricode";

/**
 * FADE-ASSESS-003 消费路径挂接点③（heartbeat 会话）可测注入缝。
 *
 * runHeartbeatAgent 在会话创建前调用（session_id 只有此处可知，消费记录需要）。
 * projectRoot 缺省回退 process.env.TRILC_PROJECT_ROOT（daemon 注入口径）；
 * 显式传入优先于环境变量。无知识/知识库未同步 → 原 prompt 降级返回，
 * 不阻断 heartbeat（注入失败不致命）。
 */
export function injectHeartbeatKnowledge(opts: {
  agentId: string;
  systemPrompt: string;
  sessionId: string;
  projectRoot?: string;
}): KnowledgeInjectionResult {
  return injectKnowledgeContext({
    projectRoot: opts.projectRoot ?? (process.env.TRILC_PROJECT_ROOT || undefined),
    agentId: opts.agentId,
    systemPrompt: opts.systemPrompt,
    sessionId: opts.sessionId,
    injectionMode: 'boot',
  });
}

export interface RunHeartbeatAgentOpts {
  agentId: string;
  sessionStore: {
    createSession(session: {
      id: string;
      model: string;
      systemPrompt: string;
      cwd: string;
      title?: string;
    }): void;
    saveMessages(
      sessionId: string,
      messages: Array<{
        role: "user" | "assistant" | "system" | "tool";
        content: string | null;
        toolCalls?: unknown;
        toolCallId?: string;
        reasoningContent?: string;
      }>,
    ): void;
    updateSessionStatus(sessionId: string, status: SessionRecord["status"]): void;
  };
  cwd: string;
  model?: string;
  maxTurns?: number;
  systemPrompt?: string;
  userMessage?: string;
  /** Per-agent permission rules → agentLoop PermissionEngine（LG-026 组长执行面放行）。 */
  permissionRules?: PermissionRule[];
}

export async function runHeartbeatAgent(
  opts: RunHeartbeatAgentOpts,
): Promise<HeartbeatRunResult> {
  const {
    agentId,
    sessionStore,
    cwd,
    model = "tmv-deepseek-v4-flash",
    maxTurns = 10,
    systemPrompt,
    userMessage,
    permissionRules,
  } = opts;

  const startTime = Date.now();
  const sessionId = `hb_${agentId}_${startTime.toString(36)}`;

  // FADE-ASSESS-003: 消费路径挂接点③（heartbeat 会话）— 设计锚点 heartbeat-runner.ts:137
  // （prompt 传入点）→ 实际注入在本模块会话创建处，session_id 只有此处可知（消费记录需要）。
  // 无知识/知识库未同步 → 原 prompt 降级返回，不阻断 heartbeat。
  const prompt = injectHeartbeatKnowledge({
    agentId,
    systemPrompt: systemPrompt ??
      `You are heartbeat agent "${agentId}". Execute your periodic task concisely.`,
    sessionId,
  }).prompt;
  const message = userMessage ??
    `Heartbeat check for ${agentId}. Report status.`;

  try {
    // Create session for traceability
    sessionStore.createSession({
      id: sessionId,
      model,
      systemPrompt: prompt,
      cwd,
    });

    let content = "";
    // REQ-20260805-004: collect tool events (tool_call/tool_result) so the
    // agent's tool feedback is visible in the session and downstream consumers.
    const toolMessages: Array<{
      role: "tool";
      content: string;
      toolCallId: string;
      isError?: boolean;
    }> = [];
    let toolBlockedCount = 0;

    for await (const event of agentLoop({
      model,
      systemPrompt: prompt,
      messages: [{ role: "user", content: message }],
      maxTurns,
      // REQ-20260805-006: 'heartbeat' tier = read + write allowed, no shell.
      tier: "heartbeat",
      cwd,
      // LG-026-P2 第五型整改（CTO 裁 a 案 2026-09-02）：per-agent 执行面规则
      // 注入——default 模式 fail-closed，组长 letter_* 须显式 ALLOW 方可执行
      ...(permissionRules && permissionRules.length > 0 ? { permissionRules } : {}),
    })) {
      if (event.type === "content_delta") {
        content += event.delta;
      } else if (event.type === "assistant_message" && event.content) {
        if (!content) content = event.content;
      } else if (event.type === "tool_result") {
        toolMessages.push({
          role: "tool",
          content: event.content,
          toolCallId: event.tool_call_id,
          isError: event.is_error,
        });
      } else if (event.type === "tool_blocked") {
        toolBlockedCount++;
        toolMessages.push({
          role: "tool",
          content: `[blocked] ${event.tool_name}: ${event.reason}`,
          toolCallId: `blocked_${toolBlockedCount}`,
          isError: true,
        });
        // FADE-ASSESS-003 小乔指标：权限/合同边界拒绝 → 越权升级计数（轻量；非越权语义不计）
        if (isEscalationBlockReason(event.reason)) {
          recordKnowledgeMetric({
            projectRoot: process.env.TRILC_PROJECT_ROOT || undefined,
            event: "escalation_blocked",
            agentId,
            sessionId,
            detail: `tool:${event.tool_name}`,
          });
        }
      }
    }

    // Persist the full conversation (user → tool results → assistant)
    const persistMessages: Array<{
      role: "user" | "assistant" | "tool";
      content: string | null;
      toolCallId?: string;
    }> = [{ role: "user", content: message }];
    for (const tm of toolMessages) {
      persistMessages.push({ role: "tool", content: tm.content, toolCallId: tm.toolCallId });
    }
    persistMessages.push({ role: "assistant", content: content || "Heartbeat completed" });
    sessionStore.saveMessages(sessionId, persistMessages);
    sessionStore.updateSessionStatus(sessionId, "completed");

    const durationMs = Date.now() - startTime;
    console.log(
      `[trilc:heartbeat] agent=${agentId} completed in ${durationMs}ms`,
    );
    return { status: "ran", durationMs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trilc:heartbeat] agent ${agentId} failed:`, msg);

    try {
      sessionStore.updateSessionStatus(sessionId, "interrupted");
    } catch {
      // Best-effort status update
    }

    return { status: "failed", reason: msg };
  }
}
