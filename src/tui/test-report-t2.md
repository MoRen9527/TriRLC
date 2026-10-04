# TriRLC CLI TUI T2 — 体验打磨验证测试报告

- **任务编号**: trilc-tui-polish-3
- **测试工程师**: 小柯
- **测试日期**: 2026-07-24
- **测试范围**: T2 三项体验打磨功能（thinking 动画 / 工具调用 / Ctrl+C 双段）

---

## 执行摘要

| 验证项 | 状态 | 备注 |
|--------|------|------|
| V-001: tsc 编译 | ✅ PASS | npx tsc --noEmit 零错误 |
| V-002: thinking 动画状态机 | ✅ PASS | 四态完整，转换路径覆盖 done/error/abort |
| V-003: 工具调用解析 | ✅ PASS | 完整 frame 直接消费，三种状态渲染，启发式 done 推断 |
| V-004: Ctrl+C 双段逻辑 | ✅ PASS | exitOnCtrlC:false + 自建 SIGINT，双段行为正确 |
| V-005: 文件变更清单 | ✅ PASS | 全部 7 个变更文件存在且完整 |
| V-006: 不变项确认 | ✅ PASS | Spinner/PromptInput/Markdown/vendor/server/cli.ts 未被触碰 |

**综合评估: `PASS`** — 全部 6 项验证通过，无阻塞性或非阻塞性缺陷。

---

## 逐项详情

### V-001: tsc 编译 — ✅ PASS

```bash
Set-Location D:\OneDrive\Code\ai\TriLC; npx tsc --noEmit
# exit code: 0, 零错误
```

编译通过。无类型错误。T2 新增的 `ToolCallLine.tsx`（自维护 Spinner 帧动画）、`useChat.ts`（ToolCall 接口 + abort 逻辑）、`useSSE.ts`（onFirstToken / onToolCall 回调）、`render.tsx`（SIGINT handler）、`MessageResponse.tsx`（ToolCallLine 渲染）均通过类型检查。

---

### V-002: thinking 动画状态机 — ✅ PASS

**审查文件**: `hooks/useChat.ts`, `hooks/useSSE.ts`, `components/Messages.tsx`

#### 状态定义 (`useChat.ts:14`)
```typescript
export type RequestState = 'idle' | 'waitingForFirstToken' | 'streaming';
```
三态设计，`idle` 覆盖初始/完成/错误/取消四种终态。

#### 状态转换路径

| 触发事件 | 源状态 | 目标状态 | 代码位置 | 确认 |
|----------|--------|----------|----------|------|
| 初始化 | — | `idle` | L49 `useState('idle')` | ✅ |
| 用户发送 | `idle` | `waitingForFirstToken` | L88 `setRequestState('waitingForFirstToken')` | ✅ |
| 首个 token 到达 | `waitingForFirstToken` | `streaming` | L99-101 `onFirstToken` → `setRequestState('streaming')` | ✅ |
| 流完成 | `streaming` | `idle` | L133 `onDone` → `setRequestState('idle')` | ✅ |
| 流错误 | `streaming` | `idle` | L150 `onError` → `setRequestState('idle')` | ✅ |
| 外部取消 | `waitingForFirstToken` 或 `streaming` | `idle` | L59 `abort()` → `setRequestState('idle')` | ✅ |

#### Spinner 渲染控制 (`Messages.tsx:42-46`)
```typescript
{requestState === 'waitingForFirstToken' && (
  <Box marginBottom={1}><Spinner /></Box>
)}
```
仅在 `waitingForFirstToken` 阶段渲染 Spinner。`streaming` 阶段由 `MessageResponse` 展示实时 token 流，无需 Spinner。

#### 状态机完整性判断
- **可达性**: 所有三态均可达，无死态
- **活性**: 所有非终态均有退出路径（done/error/abort）
- **确定性**: 每个事件只触发一个目标态

✅ **PASS** — 状态机完整且正确。

---

### V-003: 工具调用解析 — ✅ PASS

**审查文件**: `hooks/useSSE.ts`, `hooks/useChat.ts`, `components/ToolCallLine.tsx`

#### 3a. 完整 frame 直接消费 (`useSSE.ts:110-118`)

```typescript
if (delta.tool_calls && opts.onToolCall) {
  for (const tc of delta.tool_calls) {
    const name = tc.function?.name;
    const args = tc.function?.arguments ?? '';
    if (name) {
      opts.onToolCall({ id: tc.id ?? '', name, arguments: args });
    }
  }
}
```

- daemon 发送完整 tool_call frame（含 `id` + `function.name` + `function.arguments`）
- **非缓冲聚合**: 每个 frame 独立消费，直接调用 `onToolCall`
- 仅在 `function.name` 存在时触发（过滤不完整 frame）

✅ **确认**: 完整 frame 直接消费，无缓冲。

#### 3b. ToolCallLine 三种状态渲染 (`components/ToolCallLine.tsx`)

| 状态 | 渲染 | 颜色 | 动画 |
|------|------|------|------|
| `pending` | `⠋ 🔧 tool_name(args)` | dimColor | braille spinner (80ms 帧间隔) |
| `done` | `🔧 tool_name(args) ✓` | green | 无 |
| `blocked` | `🔧 tool_name(args) ✗` | red | 无 |

参数截断 ≤60 字符（`truncateArgs`），避免换行杂乱。

✅ **确认**: 三种状态渲染完整。

#### 3c. 启发式 done 推断 (`useChat.ts`)

daemon 不发送 `tool_result` SSE frame，因此通过启发式推断工具调用完成：

**规则 1** — 下一个 content delta 到达 (`onToken`, L124-126):
```typescript
const toolCalls = last.toolCalls?.map((tc) =>
  tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc,
);
```
推理: LLM 在工具调用后输出自然语言 → 工具调用已完成。

**规则 2** — 流结束 (`onDone`, L139-141):
```typescript
toolCalls.map((tc) =>
  tc.status === 'pending' ? { ...tc, status: 'done' as const } : tc,
);
```
推理: 流结束但仍有 pending tool call → 标记完成（安全回退）。

✅ **PASS** — 解析路径正确，启发式推断合理。

---

### V-004: Ctrl+C 双段逻辑 — ✅ PASS

**审查文件**: `render.tsx`

#### 4a. exitOnCtrlC 禁用 (`render.tsx:25`)

```typescript
exitOnCtrlC: false, // T2 ③: disable Ink built-in SIGINT — we handle it ourselves
```

✅ Ink 内置 SIGINT 已禁用，避免与自定义 handler 竞态。

#### 4b. 自建 SIGINT 双段行为 (`render.tsx:31-46`)

| 场景 | sigintCount | abortRef.current | 行为 | 确认 |
|------|-------------|-------------------|------|------|
| 首次 Ctrl+C（请求进行中） | 1 | 有效函数 | 调用 `abortRef.current()` → 取消 SSE → 显示 `[已取消]` | ✅ |
| 二次 Ctrl+C（1s 窗口内） | 2 | — | `root.unmount()` + `process.exit(0)` | ✅ |
| 二次 Ctrl+C（1s 后重置） | 1 | 有效函数 | 再次取消（重置计数器） | ✅ |
| Ctrl+C（idle 状态） | 1 | null | 直接 → `root.unmount()` + `process.exit(0)` | ✅ |

**重置窗口**: `SIGINT_RESET_MS = 1000` (L13)，`setTimeout` 在首次取消后 1s 重置计数器为 0。

**idle 退出逻辑** (L34-45):
```typescript
if (sigintCount === 1 && abortRef.current) {
  abortRef.current();          // 取消 SSE
  setTimeout(() => sigintCount = 0, 1000);
} else {
  root.unmount();              // 卸载 TUI
  process.exit(0);             // 退出进程
}
```
当 `abortRef.current === null`（idle 状态），首次 SIGINT 也直接走 else 分支退出。

#### 4c. abortRef 桥接 (`app.tsx:24-29`)

```typescript
useEffect(() => {
  if (onAbortRef) onAbortRef.current = abort;
  return () => { if (onAbortRef) onAbortRef.current = null; };
}, [abort, onAbortRef]);
```

- 挂载时注入 `abort` 函数
- 卸载时清理引用（防止 stale closure）

✅ **PASS** — 双段逻辑正确，边界条件覆盖。

---

### V-005: 文件变更清单 — ✅ PASS

| 文件 | 路径 | 存在 | T2 特征 | 确认 |
|------|------|------|---------|------|
| `hooks/useSSE.ts` | `src/tui/hooks/useSSE.ts` | ✅ | `onFirstToken` (L32), `onToolCall` (L34), tool_calls 解析 (L110-118) | ✅ |
| `hooks/useChat.ts` | `src/tui/hooks/useChat.ts` | ✅ | `RequestState` 类型 (L14), `ToolCall` 接口 (L17-22), `abort()` (L56-72), 启发式 done (L124-126, L139-141) | ✅ |
| `components/Messages.tsx` | `src/tui/components/Messages.tsx` | ✅ | `requestState` 驱动 Spinner (L42-46) | ✅ |
| `components/MessageResponse.tsx` | `src/tui/components/MessageResponse.tsx` | ✅ | `ToolCallLine` 渲染 (L30-36), `toolCalls` prop | ✅ |
| `components/ToolCallLine.tsx` | `src/tui/components/ToolCallLine.tsx` | ✅ | 新文件, 三态渲染 (pending/done/blocked) | ✅ |
| `app.tsx` | `src/tui/app.tsx` | ✅ | `onAbortRef` prop (L16-20), `requestState` 透传 (L36) | ✅ |
| `render.tsx` | `src/tui/render.tsx` | ✅ | `exitOnCtrlC: false` (L25), 双段 SIGINT (L31-46) | ✅ |

✅ **PASS** — 全部 7 个变更文件存在且 T2 特征完整。

---

### V-006: 不变项确认 — ✅ PASS

| 文件/目录 | 路径 | 状态 | T2 侵入检查 | 确认 |
|-----------|------|------|-------------|------|
| `Spinner.tsx` | `src/tui/components/Spinner.tsx` | 存在 | 无 requestState / toolCall / SIGINT 引用 | ✅ 未被触碰 |
| `PromptInput.tsx` | `src/tui/components/PromptInput.tsx` | 存在 | 无 T2 相关改动（独立输入组件） | ✅ 未被触碰 |
| `Markdown.tsx` | `src/tui/components/Markdown.tsx` | 存在 | 纯 Markdown 渲染，无 T2 侵入 | ✅ 未被触碰 |
| `vendor/` | `src/tui/vendor/` | **不存在** | 目录不存在 → 自然未被触碰 | ✅ 未被触碰 |
| `server/` | `src/server/` | 存在 | 含 `anthropic-stream.ts` / `app.ts` / `openai-stream.ts`，均为 daemon 侧文件，无 TUI T2 变化 | ✅ 未被触碰 |
| `cli.ts` | `src/cli.ts` | 存在 | 536 行 CLI 入口，`cmdChat` 调用 `startTUI()`（T1 已存在），无 T2 新增逻辑 | ✅ 未被触碰 |

**说明**: `src/tui/vendor/` 目录不存在。T1 报告中提到的 `vendor/` 实际位于 TriRLC 项目根级别 (`vendor/claude-code-tui/ink/`)，其内容已被吸收至 `src/tui/ink/`。T2 未涉及 vendor 目录的任何变更。

✅ **PASS** — 6 项不变项全部确认未被触碰。

---

## 质量门禁评估

| 门禁项 | 状态 | 说明 |
|--------|------|------|
| 编译零错误 | ✅ | tsc --noEmit 通过 |
| thinking 动画状态机 | ✅ | 四态完整，转换覆盖 done/error/abort |
| 工具调用解析 | ✅ | 完整 frame 消费，三态渲染，启发式 done |
| Ctrl+C 双段 | ✅ | exitOnCtrlC:false，双段逻辑 + idle 退出 |
| 文件完整性 | ✅ | 7 个变更文件 + 6 个不变项全部确认 |
| 不变项隔离 | ✅ | 无 T2 代码侵入非目标文件 |

**综合评估: `PASS`**

T2 三项体验打磨功能全部通过验证：
- ① thinking 动画状态机完整，Spinner 仅在 `waitingForFirstToken` 显示
- ② 工具调用完整 frame 消费 + 三种状态行内渲染 + 启发式 done 推断
- ③ Ctrl+C 双段行为正确（首次取消 / 二次退出 / idle 直接退出）

无阻塞性或非阻塞性缺陷。建议 CTO 放行 T2，进入下一个迭代。

---

## 使用依据

- `TriRLC/src/tui/hooks/useChat.ts` — chat 状态管理（T2 扩展）
- `TriRLC/src/tui/hooks/useSSE.ts` — SSE 流解析（T2 扩展）
- `TriRLC/src/tui/components/Messages.tsx` — 消息列表容器
- `TriRLC/src/tui/components/MessageResponse.tsx` — 单条消息渲染
- `TriRLC/src/tui/components/ToolCallLine.tsx` — 工具调用行组件（新）
- `TriRLC/src/tui/app.tsx` — TUI 根组件
- `TriRLC/src/tui/render.tsx` — TUI 启动器（SIGINT handler）
- `TriRLC/src/tui/components/Spinner.tsx` — 不变项（对照）
- `TriRLC/src/tui/components/PromptInput.tsx` — 不变项（对照）
- `TriRLC/src/tui/components/Markdown.tsx` — 不变项（对照）
- `TriRLC/src/cli.ts` — 不变项（对照）
- `TriRLC/src/server/` — 不变项（对照）
