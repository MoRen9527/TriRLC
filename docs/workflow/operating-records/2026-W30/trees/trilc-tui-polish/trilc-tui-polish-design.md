# TriRLC CLI TUI T2 — 体验打磨技术设计

版本：V0.1
日期：2026-07-24
状态：初版 · CTO 技术线产出
作者：CTO 小狄
关联：TriRLC T1 MVP（5 组件 + SSE + tsc 零错误，已完成）

---

## 0. 前置核查结论

### 0.1 工作路径核查

- **PASS** — 目标写入路径 `TriRLC/docs/workflow/operating-records/2026-W30/trees/trilc-tui-polish/` 位于正确模块 `TriRLC/` 内，无路径污染。

### 0.2 技术真源核查

| 检查项 | 路径 | 结论 |
|--------|------|------|
| 中央 BusinessStrategy | TriCompany 内 | 本设计为 TriRLC 模块内 TUI 体验层变更，不触及模块边界或交付优先级仲裁，无需升级 |
| Code Registry | TriCompany/docs/registry/code-state.md | TriRLC 当前未列入 code-state.md 显式条目，作为本地域执行节点模块，当前设计增量不改变模块面边界 |
| 模块级 Code Registry | TriRLC/docs/registry/ | 尚未创建。T1 MVP 属于快速验证阶段，T2 完成后应补齐模块级 code-state.md |
| 工程真源 | TriCompany/docs/engineering/DESIGN.md | 不冲突。TriRLC 作为 OpenTride 本地节点实现，符合当前阶段架构定位 |

### 0.3 Daemon SSE tool_calls 现状

**结论：daemon 已发送 `tool_calls`，不需要补 daemon 侧。**

核查路径：`TriRLC/src/server/openai-stream.ts`

`agentEventsToOpenAISSE()` 在以下事件中发出 `tool_calls` delta：

| AgentEvent 类型 | 行号 | SSE 格式 |
|-----------------|------|---------|
| `assistant_message` (含 tool_calls) | L189–211 | **完整** `tool_calls` delta：`{id, type:"function", function:{name, arguments}}` |
| `tool_call` | L215–235 | **完整** `tool_calls` delta（同上格式） |
| `tool_result` | L238–243 | **不发出** — 仅 agentLoop 内部消费 |
| `tool_blocked` | L245–253 | 以 `content` 文本发出 `\n\n[Tool "xxx" blocked: reason]\n\n` |

**关键差异**：任务描述中假设了增量帧模型（先 `function.name`，后 `tool_call.done`），但实际 daemon 使用**一次性完整帧**。TUI 端直接消费完整帧即可，不需要累积/拼接增量。

**fallback 说明**：若未来 daemon 切换为增量发送，TUI 端需增加 buffer 逻辑（按 `index` 聚合 `function.name` + `function.arguments` 片段，以空 name 或 `tool_call.done` 为结束信号）。当前不需要。

---

## 1. 功能 ①：thinking 动画（两阶段状态模型）

### 1.1 状态模型

```
idle → send() → waitingForFirstToken → onFirstToken → streaming → done
                   ↑                                              │
                   └──────────── abort (Ctrl+C) ←─────────────────┘
```

| 状态 | 含义 | TUI 表现 |
|------|------|---------|
| `idle` | 无活跃请求 | PromptInput 可用，无 loading 指示 |
| `waitingForFirstToken` | SSE 已连接，等待首个 content delta | "Thinking..." + 动态 spinner |
| `streaming` | 内容正在流入 | 流式文本逐字追加，spinner 消失 |
| `done` | 流结束或出错 | 回 idle |

### 1.2 与现有状态的兼容

现有 `isLoading` 覆盖 `waitingForFirstToken` 和 `streaming` 两个阶段。T2 拆细为 `requestState` 枚举，但保留 `isLoading` 作为便捷导出（`= requestState !== 'idle'`），确保外部调用方不破坏。

### 1.3 变更清单

#### 1.3.1 `useSSE.ts` — 新增 `onFirstToken` 回调

```typescript
// SSEMessage 扩展（新增 tool_calls 解析，功能②共用）
export interface SSEMessage {
  id: string;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
      role?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

export interface SSEOptions {
  // ... 现有字段
  onFirstToken?: () => void;  // ★ 新增
}
```

**行为**：收到第一个 `content` delta 时，先调用 `onFirstToken()`，再调用 `onToken(content)`。后续 content delta 只调 `onToken`。`role` delta 不触发 `onFirstToken`。

#### 1.3.2 `useChat.ts` — 拆分状态

```typescript
export type RequestState = 'idle' | 'waitingForFirstToken' | 'streaming';

export interface UseChatReturn {
  messages: Message[];
  send: (text: string) => void;
  isLoading: boolean;          // 兼容导出：requestState !== 'idle'
  requestState: RequestState;  // ★ 新增
  error: string | null;
  dismissError: () => void;
  abort: () => void;           // ★ 新增（功能③共用）
}
```

**状态转换**：
- `send()`: `idle → waitingForFirstToken`
- `onFirstToken()`: `waitingForFirstToken → streaming`
- `onDone()`: `streaming → idle`
- `onError()`: 任何活跃状态 → `idle`
- `abort()`: 任何活跃状态 → `idle`

#### 1.3.3 `Messages.tsx` — 分阶段 UI

```tsx
// 当前：isLoading → 统一 Spinner
// T2：requestState 驱动差异化展示
{requestState === 'waitingForFirstToken' && <ThinkingSpinner />}
{requestState === 'streaming' && (
  // 隐式：流式内容已在 messages 中实时追加，无需额外 UI
)}
```

`ThinkingSpinner`：在现有 `Braille spinner` 基础上增加 "Thinking..." 前缀文本，使用 2Hz 刷新频率（保持与 Ink 帧率兼容）。

#### 1.3.4 `App.tsx` — 传递新状态

```tsx
const { messages, send, isLoading, requestState, error, abort } = useChat();

<Messages 
  messages={messages} 
  isLoading={isLoading}
  requestState={requestState}  // ★ 新增
  error={error} 
/>
<PromptInput onSubmit={send} disabled={isLoading} />
```

### 1.4 风险与缓解

| 风险 | 缓解 |
|------|------|
| Ink reconciler 对高频状态变更敏感 | `requestState` 只在关键边界切换（T1→T3 共 2 次），非 per-token 变更 |
| `onFirstToken` 时序竞争 | 在 `useSSE` 中用 `let firstToken = true` 闭包标记，防重入 |

### 1.5 门禁

- [ ] tsc 零错误
- [ ] 手动测试：发送消息 → 看到 "Thinking..." → 首 token 出现后消失
- [ ] 快速连续发送两条消息：第一条的 requestState 正确重置
- [ ] 网络断连：requestState 回 idle，不卡在 waitingForFirstToken

---

## 2. 功能 ②：工具调用一行展示

### 2.1 Daemon 侧格式确认

当前 daemon 发出完整 `tool_calls` 帧：

```json
{
  "choices": [{
    "index": 0,
    "delta": {
      "tool_calls": [{
        "index": 0,
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "read_file",
          "arguments": "\"src/cli.ts\""
        }
      }]
    },
    "finish_reason": null
  }]
}
```

**不需要**解析增量帧或等待 `tool_call.done`。

### 2.2 渲染方案

#### 2.2.1 数据模型扩展

`Message` 新增可选字段：

```typescript
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
  status: 'pending' | 'done' | 'blocked';
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];       // ★ 新增：工具调用列表
}
```

#### 2.2.2 SSE 解析扩展

`useSSE.ts` 新增回调：

```typescript
export interface SSEOptions {
  // ... 现有字段
  onFirstToken?: () => void;
  onToolCall?: (tc: { id: string; name: string; arguments: string }) => void;  // ★ 新增
}
```

解析逻辑：在 `JSON.parse(data)` 后检查 `parsed.choices?.[0]?.delta?.tool_calls`，若存在且 `function.name` 非空，调用 `onToolCall`。

注意：daemon 可能在同一帧内发送多个 `tool_calls`，需要遍历数组。

#### 2.2.3 状态推断（tool_result 不可见）

由于 daemon 不发送 `tool_result` SSE 帧，`✓` 状态需要由 TUI 推断：

1. **`pending`**：`onToolCall` 触发时，状态初始为 `pending`
2. **`done`**：当下一个非 tool_call delta 到达时（content_delta 或新的 tool_call 或 stream 结束），将上一个 pending tool_call 标记为 `done`
3. **`blocked`**：当收到 content `[Tool "xxx" blocked: ...]` 时，匹配对应 tool_call → 标记 `blocked`

**Fallback**：若 daemon 未来发送 `tool_result` 或明确完成标记，切换到显式状态驱动。

#### 2.2.4 渲染组件

新建 `ToolCallLine.tsx`：

```
┌──────────────────────────────────────────────┐
│  🔧 read_file("src/cli.ts")                  │  ← pending (灰色，带 spinner)
│  🔧 read_file("src/cli.ts") ✓                │  ← done (绿色)
│  🔧 read_file("src/cli.ts") ✗                │  ← blocked (红色)
└──────────────────────────────────────────────┘
```

不渲染 `arguments` 全量（可能很长），截断到 60 字符，超出显示 `...`。format：
```
🔧 tool_name(arg_preview) [status_icon]
```

嵌入 `MessageResponse`：在 assistant 消息中，`toolCalls` 行嵌入在 content 上方或与 content 交替（按时间顺序）。

**简单策略**：toolCalls 按接收顺序插入到 message 的 toolCalls 数组中；渲染时放在 content 之前作为一个独立 section。

#### 2.2.5 `useChat.ts` 变更

```typescript
const send = useCallback((text: string) => {
  // ... 现有逻辑
  
  const abort = connectSSE({
    // ... 现有参数
    onFirstToken: () => {
      setRequestState('streaming');
    },
    onToolCall: (tc) => {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          const toolCalls = [...(last.toolCalls ?? []), { ...tc, status: 'pending' as const }];
          copy[copy.length - 1] = { ...last, toolCalls };
        }
        return copy;
      });
    },
    onToken: (token) => {
      setMessages((prev) => {
        const copy = [...prev];
        const last = copy[copy.length - 1];
        if (last && last.role === 'assistant') {
          // 将 pending toolCalls 标记为 done
          const toolCalls = last.toolCalls?.map(tc => 
            tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc
          );
          copy[copy.length - 1] = { ...last, content: last.content + token, toolCalls };
        }
        return copy;
      });
    },
    // ...
  });
}, [...]);
```

### 2.3 风险与缓解

| 风险 | 缓解 |
|------|------|
| tool_calls 的 `arguments` 可能是部分 JSON（daemon 未来改为增量帧） | 当前忽略，只做全量展示。未来增补 buffer 聚合逻辑 |
| `done` 标记推断不准确（无明确完成信号） | 接受 T2 阶段为启发式（heuristic），在注释中标注 `// HEURISTIC: tool_result not in SSE` |
| 大量 tool_calls 导致渲染性能问题 | T2 场景下每轮通常 ≤5 个 tool_calls，不构成瓶颈 |

### 2.4 门禁

- [ ] tsc 零错误
- [ ] Tool call 帧解析正确（含 arguments 转义字符处理）
- [ ] pending → done 状态转换正确
- [ ] tool_blocked 正确匹配并显示 ✗
- [ ] 多条 tool_calls 按顺序渲染

---

## 3. 功能 ③：Ctrl+C 双段行为

### 3.1 行为规格

| 阶段 | 触发 | 行为 | 用户可见 |
|------|------|------|---------|
| ① 首次 Ctrl+C | 有活跃 SSE 请求 | abort 当前 SSE，保留消息历史 | 助理消息追加 "`[已取消]`" |
| ② 再次 Ctrl+C | 无活跃请求，或 ① 已触发 | 退出 TUI 进程 | 终端恢复 |

### 3.2 实现方案

#### 3.2.1 绕过 Ink 的 `exitOnCtrlC`

Ink 的 `render()` 默认设置 `exitOnCtrlC: true`。T2 需要：

```typescript
// render.tsx
import { render } from './ink/root.js';

const { unmount, waitUntilExit } = render(<App />, {
  exitOnCtrlC: false,  // ★ 禁用 Ink 内置 SIGINT
});
```

#### 3.2.2 自定义 SIGINT handler

在 `render.tsx` 中注册：

```typescript
let sigintCount = 0;

process.on('SIGINT', () => {
  sigintCount++;
  
  if (sigintCount === 1 && abortRef.current) {
    // 首次：取消当前请求
    abortRef.current();
    // 1 秒内无第二次 Ctrl+C → 重置计数
    setTimeout(() => { sigintCount = 0; }, 1000);
  } else {
    // 再次 Ctrl+C 或在 idle 状态：退出
    unmount();
    process.exit(0);
  }
});
```

#### 3.2.3 `useChat` 暴露 abort

```typescript
// useChat.ts
const abort = useCallback(() => {
  abortRef.current?.();
  abortRef.current = null;
  setRequestState('idle');
  setIsLoading(false);
}, []);

return { ..., abort };  // ★ 暴露
```

#### 3.2.4 取消标记

当 abort 被调用时，在 assistant 消息末尾追加：

```typescript
// useChat.ts — 在 abort() 中
setMessages((prev) => {
  const copy = [...prev];
  const last = copy[copy.length - 1];
  if (last && last.role === 'assistant') {
    copy[copy.length - 1] = { 
      ...last, 
      content: last.content + '\n[已取消]' 
    };
  }
  return copy;
});
```

#### 3.2.5 架构：abortRef 的跨边界传递

由于 `useChat` hook 内部持有 `abortRef`，而 SIGINT handler 在 `render.tsx` 的模块顶层，需要一个桥接：

**方案 A（推荐）**：通过 `App` 组件暴露 ref。

```tsx
// App.tsx
import { useEffect, useRef } from 'react';

export default function App({ onAbortRef }: { onAbortRef?: React.MutableRefObject<(() => void) | null> }) {
  const { messages, send, isLoading, requestState, error, abort } = useChat();
  
  useEffect(() => {
    if (onAbortRef) onAbortRef.current = abort;
    return () => { if (onAbortRef) onAbortRef.current = null; };
  }, [abort]);
  
  // ...
}
```

**方案 B（备选）**：全局 event emitter。更耦合，不推荐。

### 3.3 与 Ink 帧循环的交互

- `abort()` 调用 `AbortController.abort()`，触发 `fetch()` 抛出 `AbortError`
- `useSSE` catch 块识别 `AbortError` 后静默返回（不调 `onError`）
- `useChat` 中 `abort()` 手动设置 `requestState → idle`
- Ink 帧循环正常继续，无需特殊处理

### 3.4 风险与缓解

| 风险 | 缓解 |
|------|------|
| SIGINT handler 与 Ink 内部 input handler 竞争 | `exitOnCtrlC: false` 确保 Ink 不注册自己的 handler；我们的 `process.on('SIGINT')` 优先级确定 |
| Windows（当前环境）`SIGINT` 行为差异 | Node.js 在 Windows 上 `process.on('SIGINT')` 通过 `ReadStream` 模拟，行为一致。若 TUI 在 git-bash/cmd/PowerShell 下表现不同，记录到已知问题 |
| Ink 进程不退出（事件循环未清空） | `unmount()` + `process.exit(0)` 强制退出；确认 abortRef 和所有 timer 已清理 |
| 1 秒重置窗口过短/过长 | 设为可配置常量 `SIGINT_RESET_MS = 1000`，后续可调 |

### 3.5 门禁

- [ ] tsc 零错误
- [ ] 有活跃请求时：首次 Ctrl+C → 显示 `[已取消]`，TUI 不退出
- [ ] 首次 Ctrl+C 后 1 秒内再次 Ctrl+C → TUI 退出
- [ ] 首次 Ctrl+C 后超过 1 秒再次 Ctrl+C → 重新算首次（若此时又有新请求，则取消新请求）
- [ ] idle 状态下 Ctrl+C → 直接退出（无二次确认）
- [ ] Windows PowerShell / CMD / git-bash 三种终端下行为一致

---

## 4. 交付计划

### 4.1 实现顺序

```
Phase 2a (① thinking 动画) → Phase 2b (② 工具调用展示) → Phase 2c (③ Ctrl+C)
```

理由：
1. **① 先做**：thinking 动画直接改善最大痛点（用户不知道请求是否在跑），且改动集中在 `useSSE` / `useChat` / `Messages` 三文件，风险最低。
2. **② 再做**：工具调用展示依赖 `useSSE` 扩展（`SSEMessage` interface 延展），但逻辑自包含，不影响 ①。
3. **③ 最后**：Ctrl+C 涉及 Ink 生命周期 + SIGINT handler 全局行为，需前三者稳定后再集成，避免调试干扰。

### 4.2 依赖关系

```
① thinking     ← 无依赖（基线 T1）
② tool_calls   ← 依赖 useSSE.ts 的 SSEMessage 扩展（与 ① 共享接口变化）
③ ctrl+c       ← 依赖 useChat 暴露 abort()（① 中已做）
```

### 4.3 影响面矩阵

| 文件 | ① | ② | ③ |
|------|---|---|---|
| `src/tui/hooks/useSSE.ts` | ✏️ `onFirstToken` / `SSEMessage` 扩展 | ✏️ `onToolCall` | — |
| `src/tui/hooks/useChat.ts` | ✏️ `requestState` / `abort` | ✏️ `toolCalls` 数组 | ✏️ `abort` 暴露 |
| `src/tui/components/Messages.tsx` | ✏️ `requestState` prop | ✏️ 传递 `toolCalls` | — |
| `src/tui/components/MessageResponse.tsx` | — | ✏️ 渲染 toolCalls | ✏️ `[已取消]` 标记 |
| `src/tui/components/Spinner.tsx` | ✏️ 增加 text label | — | — |
| `src/tui/components/ToolCallLine.tsx` | — | 🆕 新建 | — |
| `src/tui/app.tsx` | ✏️ 传递新 props | — | ✏️ `onAbortRef` prop |
| `src/tui/render.tsx` | — | — | ✏️ SIGINT handler |

### 4.4 预估工时

| Phase | 内容 | 预估 |
|-------|------|------|
| 2a | thinking 动画 | 2 pomodoro (50min) |
| 2b | 工具调用展示 | 3 pomodoro (75min) |
| 2c | Ctrl+C 双段 | 2 pomodoro (50min) |
| 总计 | | 7 pomodoro (~3h) |

---

## 5. 发布姿态

### 5.1 T2 完成定义

- [ ] 三项功能全部实现并通过各自门禁
- [ ] `tsc --noEmit` 零错误
- [ ] 在 PowerShell 下完成手动冒烟：发送消息 → 看到 thinking → 首 token → 流式文本 → 工具调用 → Ctrl+C 取消
- [ ] T2 代码合入 `TriRLC/src/tui/` 主分支
- [ ] 更新 `TriRLC/src/tui/tech-design.md` 追加 T2 变更摘要
- [ ] 创建模块级 `TriRLC/docs/registry/code-state.md`（T1+T2 基线）

### 5.2 不在此范围

- ❌ 工具调用参数美化（syntax highlight JSON args）
- ❌ 工具调用结果内联展示
- ❌ 多行 thinking 动画（如逐行显示推理过程）
- ❌ Ctrl+C 后的"重新发送"快捷操作
- ❌ 与 TriPilot TUI 的组件复用

### 5.3 决策：APPROVE

**理由**：
1. 技术可行性已确认：daemon SSE 已发送 tool_calls（完整帧），无需补 daemon 侧
2. 改动影响面封闭在 `src/tui/` 内，不触碰 server 端或 agent-core
3. 三项功能按顺序递进，互不阻塞，可分批验证
4. 所有风险有明确缓解措施，无升级项

---

## 6. 使用依据

| 依据 | 路径 |
|------|------|
| Daemon SSE 格式 | `TriRLC/src/server/openai-stream.ts` |
| T1 基线 useSSE | `TriRLC/src/tui/hooks/useSSE.ts` |
| T1 基线 useChat | `TriRLC/src/tui/hooks/useChat.ts` |
| T1 基线组件 | `TriRLC/src/tui/components/*.tsx` |
| T1 基线 App | `TriRLC/src/tui/app.tsx` |
| Ink render 入口 | `TriRLC/src/tui/render.tsx` |
| T1 技术设计 | `TriRLC/src/tui/tech-design.md` |
| 公司 Code Registry | `TriCompany/docs/registry/code-state.md` |
| 公司工程真源 | `TriCompany/docs/engineering/DESIGN.md` |

---

## A. 附录：daemon side 补丁预留（当前不需要）

若未来 daemon 需要发送 `tool_result` 完成标记以支持显式 `✓` 状态（替代当前启发式推断），应在 `openai-stream.ts` 的 `tool_result` case（L238–243）中追加：

```typescript
case 'tool_result': {
  emitDelta(s, {
    tool_calls: [{
      index: 0,
      function: { name: event.tool_name },
    }],
  }, null, emit);
  break;
}
```

此变更不影响当前设计（TUI 端 `onToolCall` 接口已预留处理能力），作为 T3 候选。
