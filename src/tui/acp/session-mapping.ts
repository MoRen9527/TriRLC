// ── ACP session/update → UI ContentBlock 纯映射 (架构稿 §二映射表) ──
// REGR-005 有序块模型为靶: 全部变换为 (messages, ...) → (messages', extras) 纯函数,
// 不碰 React —— node:test 直测; useAcpSession.ts 是薄 React 壳。
// 映射表:
//   agent_message_chunk  → text block 增量 (流式)
//   agent_thought_chunk  → thinking (ThinkingLine 消费 msg.thinking)
//   tool_call            → tool_use block 新建 (pending)
//   tool_call_update     → toolStatus 更新 + tool_result block
//   plan                 → TodoTask[] (TodoPanel)
//   usage_update         → token 读数 (StatusLine 消费 inputTokens/outputTokens)
//   user_message_chunk   → 忽略 (本地已 echo)
//   其余/未知判别          → 忽略 (前向兼容)
import type { ContentBlock, Message } from '../hooks/useChat.js';
import type { TodoTask } from '../components/TodoPanel.js';

/** SessionNotification.update 的段 1 契约形 (sessionUpdate 判别)。 */
export interface AcpUpdate {
  sessionUpdate: string;
  content?: { type?: string; text?: string };
  toolCallId?: string;
  title?: string;
  rawInput?: unknown;
  status?: string;
  contentText?: string;
  entries?: Array<{ content?: string; priority?: string; status?: string }>;
  inputTokens?: number;
  outputTokens?: number;
  [k: string]: unknown;
}

export interface ApplyUpdateResult {
  messages: Message[];
  todos: TodoTask[];
  /** usage_update 提供时为新读数 (覆盖形); 未提供为 null。 */
  inputTokens: number | null;
  outputTokens: number | null;
  /** 本轮是否命中已知判别 (未知判别忽略时 false, 供测试与 debug 面)。 */
  applied: boolean;
}

/** ACP tool_call_update.status → ContentBlock.toolStatus。 */
function mapToolStatus(status: string | undefined): 'pending' | 'done' | 'error' | null {
  switch (status) {
    case 'completed': return 'done';
    case 'failed': return 'error';
    case 'in_progress':
    case 'pending': return 'pending';
    default: return null;
  }
}

/** ACP plan entry status → TodoTask.status。 */
function mapPlanStatus(status: string | undefined): TodoTask['status'] {
  return status === 'in_progress' || status === 'completed' ? status : 'pending';
}

/** 最后一个 streaming assistant 消息的 blocks 引用壳 (不可变更新助手)。 */
function lastStreamingAssistant(messages: Message[]): { list: Message[]; index: number; msg: Message } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && msg.isStreaming) return { list: messages, index: i, msg };
  }
  return null;
}

/** prompt 载荷: 文本 → [{type:'text',text}] (PromptRequest.prompt:[ContentBlock])。 */
export function buildPromptBlocks(text: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text }];
}

/**
 * 单条 session/update 的不可变映射。
 * messages 保持形参不变, 返回新数组 (React setState 直用)。
 */
export function applySessionUpdate(messages: Message[], update: AcpUpdate): ApplyUpdateResult {
  const none: ApplyUpdateResult = { messages, todos: [], inputTokens: null, outputTokens: null, applied: false };
  if (!update || typeof update.sessionUpdate !== 'string') return none;
  const kind = update.sessionUpdate;

  if (kind === 'user_message_chunk') {
    return { ...none, applied: true }; // 忽略: 本地已 echo。
  }

  if (kind === 'usage_update') {
    return {
      messages, todos: [],
      inputTokens: typeof update.inputTokens === 'number' ? update.inputTokens : null,
      outputTokens: typeof update.outputTokens === 'number' ? update.outputTokens : null,
      applied: true,
    };
  }

  if (kind === 'plan') {
    const todos: TodoTask[] = (update.entries ?? []).map((e, i) => ({
      id: `plan-${i}`,
      subject: e.content ?? '',
      description: '',
      status: mapPlanStatus(e.status),
      ...(e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? { priority: e.priority } : {}),
    }));
    return { messages, todos, inputTokens: null, outputTokens: null, applied: true };
  }

  // 以下判别全部落在最后一个 streaming assistant 消息上 (REGR-005 流式靶)。
  const target = lastStreamingAssistant(messages);
  if (!target) return none;
  const { index, msg } = target;
  const blocks: ContentBlock[] = [...(msg.blocks ?? [])];

  if (kind === 'agent_message_chunk') {
    const text = update.content?.text ?? '';
    if (!text) return { ...none, applied: true };
    const lastBlock = blocks[blocks.length - 1];
    if (lastBlock && lastBlock.type === 'text') {
      blocks[blocks.length - 1] = { ...lastBlock, text: (lastBlock.text ?? '') + text };
    } else {
      blocks.push({ type: 'text', index: blocks.length, text });
    }
    const next: Message = { ...msg, blocks, content: (msg.content ?? '') + text };
    const list = [...messages];
    list[index] = next;
    return { messages: list, todos: [], inputTokens: null, outputTokens: null, applied: true };
  }

  if (kind === 'agent_thought_chunk') {
    const text = update.content?.text ?? '';
    if (!text) return { ...none, applied: true };
    const next: Message = { ...msg, thinking: (msg.thinking ?? '') + text };
    const list = [...messages];
    list[index] = next;
    return { messages: list, todos: [], inputTokens: null, outputTokens: null, applied: true };
  }

  if (kind === 'tool_call') {
    const toolId = update.toolCallId ?? `tool-${blocks.length}`;
    const toolName = update.title ?? toolId;
    const toolInput = update.rawInput === undefined ? '' : typeof update.rawInput === 'string' ? update.rawInput : JSON.stringify(update.rawInput);
    blocks.push({
      type: 'tool_use', index: blocks.length,
      toolId, toolName, toolInput, toolStatus: 'pending',
    });
    // 兼容形 toolCalls 同步维护 (渲染回退路径零破)。
    const toolCalls = [...(msg.toolCalls ?? []).map((tc) => (tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc)), { id: toolId, name: toolName, arguments: toolInput, status: 'pending' as const }];
    const next: Message = { ...msg, blocks, toolCalls };
    const list = [...messages];
    list[index] = next;
    return { messages: list, todos: [], inputTokens: null, outputTokens: null, applied: true };
  }

  if (kind === 'tool_call_update') {
    const toolId = update.toolCallId ?? '';
    const blockIdx = blocks.findIndex((b) => b.type === 'tool_use' && b.toolId === toolId);
    if (blockIdx === -1) return none; // 未知名 update: 不造块。
    const mapped = mapToolStatus(update.status);
    if (mapped) blocks[blockIdx] = { ...blocks[blockIdx]!, toolStatus: mapped };
    const resultText = update.contentText ?? (update.content?.text as string | undefined);
    if (resultText !== undefined && resultText !== '') {
      blocks.push({ type: 'tool_result', index: blocks.length, toolId, toolResultContent: resultText });
    }
    // 兼容形 toolCalls: ToolCall.status 无 'error' 档 (useChat 旧形) —— error
    // 面由 blocks.toolStatus 承载, 兼容形只在 done 时翻。
    const toolCalls = (msg.toolCalls ?? []).map((tc) =>
      tc.id === toolId && mapped === 'done' ? { ...tc, status: 'done' as const } : tc,
    );
    const next: Message = { ...msg, blocks, toolCalls };
    const list = [...messages];
    list[index] = next;
    return { messages: list, todos: [], inputTokens: null, outputTokens: null, applied: true };
  }

  return none; // 未知判别: 前向兼容忽略。
}

/** settlement: prompt response 到达 (或 error) 时翻转流式尾——pending tool_use 落 done。 */
export function settleStreaming(messages: Message[], opts?: { errorText?: string }): Message[] {
  const list = [...messages];
  for (let i = list.length - 1; i >= 0; i--) {
    const msg = list[i]!;
    if (msg.role === 'assistant' && msg.isStreaming) {
      const blocks = msg.blocks?.map((b) =>
        b.type === 'tool_use' && b.toolStatus === 'pending' ? { ...b, toolStatus: 'done' as const } : b,
      );
      list[i] = {
        ...msg,
        isStreaming: false,
        blocks,
        toolCalls: msg.toolCalls?.map((tc) => (tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc)),
        ...(opts?.errorText && !msg.content ? { content: opts.errorText } : {}),
      };
      break;
    }
  }
  return list;
}
