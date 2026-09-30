# TriRLC TUI — T1 MVP 技术设计

版本：V0.1
日期：2026-07-24
状态：初版 · CTO 技术线产出
作者：CTO 小狄

> **2026-07-31 更新（v0.9.0）**：本设计 §1-§7 规划的"吸收 CC fork ink 引擎"已于 v0.9.0 完成。
> - stock npm ink 已删除；CC fork 引擎落地为 `src/tui/ink/`
> - 全部组件 import 切换至 fork（`Box`/`Text`/`render`/`useDeclaredCursor`）
> - InputBox 接 fork 原生 `useDeclaredCursor`，IME 候选词在 VS Code/Windows Terminal 中完整支持
> - 设计正确性已被验证：删除 stock ink 后 fork 使用顶层 React 19.2.8 + react-reconciler 0.31.0，版本冲突消失
> - 实施偏离（首个提交走 stock ink 捷径）已纠正；本设计从"初版"升级为"已实现设计"

---

## 0. 前置声明

- **吸收方案**：任务描述称 absorption-plan.md 联审已通过，但经全仓搜索，`TriRLC/` 及 `TriCompany/` 下均未找到该文件。本设计基于 vendor 基线实际代码状态进行独立技术评估。若吸收方案后续到位且存在分歧，以本设计为准并标注差异。
- **vendor 基线**：`TriRLC/vendor/claude-code-tui/` 已就位，共 156 文件（ink/ 98 + components/ 57 + ink.ts 1）。
- **工作路径**：所有 TUI 代码写入 `TriRLC/src/tui/`，不进入 `TriMetaverse/` 项目根目录。

---

## 1. Vendor Ink Engine 最小可用子集评估

### 1.1 评估结论：可独立裁剪（VIABLE），需做适配桥接

vendor/ink/ 是一个自研终端渲染引擎，基于 react + react-reconciler + yoga-layout，核心架构为：

```
React Tree → reconciler.ts (react-reconciler) → dom.ts (虚拟 DOM)
  → yoga.ts (flexbox 布局) → renderer.ts (帧渲染)
  → output.ts (屏幕缓冲) → log-update.ts (增量 diff) → terminal.ts (ANSI 写入)
```

**关键发现**：

1. **ink.tsx（主类，246KB）** 是唯一渲染入口，createRoot/render 均通过它驱动。它不是可选组件——是整个引擎的运行时。
2. **CC 专属依赖已识别 5 类，均可 Shim 替换**（详见 §1.3）。
3. **Yoga 布局层**通过 `yoga.ts` 适配器抽象，可桥接到 `yoga-layout-prebuilt` npm 包。
4. **ThemeProvider 完全可剥离**：顶层 `vendor/ink.ts` 包裹 ThemeProvider，我们改用 `vendor/ink/root.ts` 的 `createRoot`/`render` 直接入口。

### 1.2 最小保留文件清单（45 文件）

#### 核心引擎（16 文件）— 必须保留

```
ink/root.ts              # createRoot / render API 入口
ink/ink.tsx              # Ink 主类（渲染循环、帧管理、终端 IO）
ink/reconciler.ts        # React reconciler 桥接（react-reconciler）
ink/renderer.ts          # 帧渲染器（yoga 布局 → screen 缓冲）
ink/render-to-screen.ts  # 侧渲染（用于搜索，MVP 可暂不裁剪）
ink/render-node-to-output.ts  # DOM 树 → Output 像素写入
ink/dom.ts               # 虚拟 DOM（createNode/appendChild/markDirty）
ink/screen.ts            # 屏幕缓冲（Cell/StylePool/CharPool/HyperlinkPool）
ink/output.ts            # 输出管理（写队列 → Screen）
ink/frame.ts             # Frame 结构 + shouldClearScreen
ink/log-update.ts        # 增量 diff 引擎（帧间差异 → ANSI Patch[]）
ink/terminal.ts          # 终端写入（writeDiffToTerminal）
ink/focus.ts             # Focus 管理（autoFocus 支持）
ink/node-cache.ts        # 节点布局缓存（blit 优化）
ink/instances.ts         # Ink 实例注册表（stdout → Ink 映射）
ink/constants.ts         # 帧间隔常量（FRAME_INTERVAL_MS = 16）
```

#### 布局引擎（4 文件）— 必须保留，yoga.ts 需适配

```
ink/layout/engine.ts     # createLayoutNode 工厂
ink/layout/node.ts       # LayoutNode 接口 + 枚举
ink/layout/geometry.ts   # Point/Size/Rectangle 类型
ink/layout/yoga.ts       # ★ Yoga 适配器（需桥接到 yoga-layout-prebuilt）
```

#### 终端 IO（9 文件）— 必须保留

```
ink/termio/ansi.ts
ink/termio/csi.ts        # CSI 序列（光标移动、滚屏、擦除）
ink/termio/dec.ts        # DEC 序列（alt-screen、光标显隐、鼠标）
ink/termio/esc.ts
ink/termio/osc.ts        # OSC 序列（超链接、剪贴板）
ink/termio/parser.ts     # 终端输入解析
ink/termio/tokenize.ts
ink/termio/types.ts
ink/termio/sgr.ts        # SGR 样式序列
```

#### 事件系统（5 文件）

```
ink/events/event.ts
ink/events/emitter.ts
ink/events/dispatcher.ts
ink/events/event-handlers.ts
ink/events/input-event.ts
ink/events/keyboard-event.ts
```

#### 内置组件（6 文件）— 仅保留 MVP 所需

```
ink/components/App.tsx           # App 包装器（StdinContext + TerminalSizeContext）
ink/components/AppContext.ts
ink/components/Box.tsx           # 基础 flexbox 容器
ink/components/Text.tsx          # 基础文本组件
ink/components/Newline.tsx       # 换行
ink/components/Spacer.tsx        # 弹性空白
ink/components/StdinContext.ts   # stdin 上下文（raw mode + 输入事件）
ink/components/TerminalSizeContext.tsx  # 终端尺寸上下文
```

#### Hooks（4 文件）

```
ink/hooks/use-input.ts         # 键盘输入 hook
ink/hooks/use-stdin.ts         # stdin 管理 hook
ink/hooks/use-app.ts           # 退出 hook
ink/hooks/use-interval.ts      # 定时器 hook（useInterval + useAnimationTimer）
ink/hooks/use-animation-frame.ts  # 动画帧 hook（Spinner 需要）
ink/hooks/use-terminal-viewport.ts
```

#### 文本/样式（5 文件）

```
ink/styles.ts             # Styles + TextStyles 类型定义
ink/measure-text.ts       # 文本尺寸测量
ink/measure-element.ts    # 元素尺寸测量
ink/wrap-text.ts          # 文本换行
ink/squash-text-nodes.ts  # 文本节点展平
ink/stringWidth.ts        # ★ 字符串显示宽度（需 shim getGraphemeSegmenter）
ink/widest-line.ts
ink/line-width-cache.ts
ink/get-max-width.ts
ink/parse-keypress.ts     # 按键解析
ink/warn.ts
ink/tabstops.ts
```

### 1.3 CC 专属依赖 Shim 方案

| CC 导入路径 | 用途 | Shim 策略 |
|---|---|---|
| `src/utils/debug.js` → `logForDebugging` | 调试日志 | 替换为 `() => {}`（noop） |
| `src/utils/log.js` → `logError` | 错误日志 | 替换为 `console.error` |
| `src/bootstrap/state.js` → `flushInteractionTime` | 交互时间刷新 | 替换为 noop |
| `src/native-ts/yoga-layout/index.js` → `Yoga`, `getYogaCounters` | Yoga 布局引擎 | ★ 桥接到 `yoga-layout-prebuilt` npm（详见 §1.4） |
| `../utils/envUtils.js` → `isEnvTruthy` | 环境变量布尔判断 | 内联实现：`v => v === '1' \|\| v === 'true'` |
| `../utils/intl.js` → `getGraphemeSegmenter` | 字形分割（emoji/连字） | 替代为 `new Intl.Segmenter('en', { granularity: 'grapheme' })`（Node 20+ 原生支持） |
| `../utils/sliceAnsi.js` → `sliceAnsi` | ANSI 感知字符串截断 | 内联轻量实现或替换为 `slice-ansi` npm 包 |
| `auto-bind` | 方法自动绑定 | 可用 npm 保留，或手动绑定 |
| `signal-exit` → `onExit` | 进程退出清理 | 替换为 `process.on('exit', ...)` + `process.on('SIGINT', ...)` |
| `semver` / `../utils/semver.js`（terminal.ts） | 终端版本检测 | 删除 progress reporting 相关代码，MVP 不需要 |

### 1.4 Yoga 布局桥接方案（关键适配点）

CC 自研的 `src/native-ts/yoga-layout/index.js` 是 TypeScript 移植版 Yoga，我们改为使用 `yoga-layout-prebuilt` npm 包。

**适配策略**：修改 `ink/layout/yoga.ts` 的 import 路径：

```typescript
// 原（CC 私有移植）：
import Yoga, { Align, Direction, Display, Edge, FlexDirection,
  Gutter, Justify, MeasureMode, Overflow, PositionType, Wrap,
  type Node as YogaNode } from 'src/native-ts/yoga-layout/index.js'

// 改为（npm 包）：
import Yoga, { Align, Direction, Display, Edge, FlexDirection,
  Gutter, Justify, MeasureMode, Overflow, PositionType, Wrap,
  type Node as YogaNode } from 'yoga-layout-prebuilt'
```

同时将 `getYogaCounters()` 替换为 stub：
```typescript
export function getYogaCounters() {
  return { ms: 0, visited: 0, measured: 0, cacheHits: 0, live: 0 }
}
```

**备选方案**：若 `yoga-layout-prebuilt` 存在 API 差异，从 CC 源码提取 `src/native-ts/yoga-layout/` 子目录作为 fallback。

### 1.5 明确可裁剪的文件（≥ 60 文件）

以下文件在 T1 MVP 中不需要，不吸收：

| 类别 | 文件 | 原因 |
|---|---|---|
| CC 顶层 | `ink.ts` | ThemeProvider 包裹器，我们直接用 root.ts |
| 主题系统 | `ThemeProvider.tsx`, `ThemedBox.tsx`, `ThemedText.tsx`, `color.ts`, `Byline.tsx`, `Divider.tsx`, `StatusIcon.tsx` | MVP 用简单 ANSI 颜色 |
| 复杂 UI | `Dialog.tsx`, `FuzzyPicker.tsx`, `KeyboardShortcutHint.tsx`, `ListItem.tsx`, `LoadingState.tsx`, `Pane.tsx`, `ProgressBar.tsx`, `Ratchet.tsx`, `Tabs.tsx` | CC 专属设计系统 |
| PromptInput 全套 | `PromptInput/*`（20 文件） | MVP 重写极简单行输入 |
| CC 消息系统 | `Message.tsx`, `MessageRow.tsx`, `VirtualMessageList.tsx`, `Messages.tsx` | MVP 重写轻量版 |
| CC 特有组件 | `ScrollBox.tsx`, `AlternateScreen.tsx`, `Link.tsx`, `Button.tsx`, `RawAnsi.tsx`, `Ansi.tsx`, `NoSelect.tsx`, `ErrorOverview.tsx`, `ClockContext.tsx`, `CursorDeclarationContext.ts` | 非 MVP 必需 |
| CC 渲染装饰 | `render-border.ts`, `searchHighlight.ts`, `selection.ts`, `bidi.ts`, `colorize.ts`, `clearTerminal.ts`, `supports-hyperlinks.ts`, `devtools.ts` | 非 MVP 必需 |
| CC Spinner 子组件 | `TeammateSpinnerLine.tsx`, `TeammateSpinnerTree.tsx`, `GlimmerMessage.tsx`, `teammateSelectHint.ts`, `useStalledAnimation.ts` | 团队协作 UI，非 MVP |
| CC 专属 hooks | `use-selection.ts`, `use-search-highlight.ts`, `use-declared-cursor.ts`, `use-tab-status.ts`, `use-terminal-title.ts`, `use-terminal-focus.ts` | 非 MVP |
| CC 专属 events | `click-event.ts`, `focus-event.ts`, `terminal-event.ts`, `terminal-focus-event.ts` | 无鼠标点击需求 |
| CC Markdown | `Markdown.tsx`, `MarkdownTable.tsx` | MVP 用 marked + ink Text 自建 |
| CC 工具依赖 | `hit-test.ts`, `optimizer.ts` | 无鼠标点击，patch optimizer 非必需 |

---

## 2. SSE 客户端设计

### 2.1 协议

- **端点**：`POST http://localhost:8711/chat/completions`
- **请求头**：`Content-Type: application/json`，`Accept: text/event-stream`
- **SSE 帧格式**：
  ```
  data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"..."}}]}
  data: [DONE]
  ```

### 2.2 客户端架构

```
useChat hook
  ├── fetch() → ReadableStream
  ├── 逐行解析 SSE（data: 前缀 → JSON.parse → delta.content 提取）
  ├── 累积 message.content 到 React state
  └── 暴露 { messages, send, isLoading, error }
```

**设计要点**：
- 使用 `fetch()` + `ReadableStream` reader（Node 20 原生支持）
- SSE 解析轻量：`line.startsWith('data: ')` → 跳过 `[DONE]` → `JSON.parse`
- 不依赖 EventSource API（Node 原生不支持，且需自定义 POST body）
- 错误处理：网络断开 → error state → 用户可重试

### 2.3 与 Ink 事件系统对接

useChat 使用 React `useState`/`useReducer` 管理状态，Ink 通过 React 渲染循环自动响应对应 state 变化。不需要与 ink events 系统直接对接——SSE 流式更新通过 `setState` 触发 React reconciler，Ink 的 reconciler 桥接自动将状态变化渲染到终端。

---

## 3. Ink Root 设计

### 3.1 入口选择

使用 `vendor/ink/root.ts` 的 `createRoot` API（绕过 `vendor/ink.ts` 的 ThemeProvider 包裹）：

```typescript
// src/tui/render.ts
import { createRoot } from '../vendor/ink/root.js'
import App from './app.js'

export async function startTUI() {
  const root = await createRoot({
    stdout: process.stdout,
    stdin: process.stdin,
    exitOnCtrlC: true,
    patchConsole: true,
  })
  root.render(<App />)
  return root
}
```

### 3.2 App 组件结构

```tsx
// src/tui/app.tsx
import { Box } from '../vendor/ink/components/Box.js'
import Messages from './components/Messages.js'
import PromptInput from './components/PromptInput.js'
import { useChat } from './hooks/useChat.js'

export default function App() {
  const { messages, send, isLoading } = useChat()

  return (
    <Box flexDirection="column" height="100%">
      <Messages messages={messages} isLoading={isLoading} />
      <PromptInput onSubmit={send} disabled={isLoading} />
    </Box>
  )
}
```

### 3.3 ThemeProvider 剥离验证

`vendor/ink.ts` 唯一做的事：将 `<ThemeProvider>` 包裹在用户组件外，使得 ThemedBox/ThemedText 可用。我们的组件直接使用 ink 原生的 `<Box>` + `<Text>`（通过 style props 指定颜色），完全不依赖 ThemeContext。

**验证方法**：在 ink/root.ts 的 `createRoot` 中直接渲染 `<Box><Text>hello</Text></Box>`，若终端正确输出 "hello"，则确认 ThemeProvider 已成功剥离。

---

## 4. MVP 五组件裁剪方案

### 4.1 PromptInput — 重写极简版

**来源**：不使用 vendor 的 `PromptInput.tsx`（20 文件、支持多行/粘贴/语音/历史搜索等），全新编写。

```tsx
// src/tui/components/PromptInput.tsx
import { Box, Text } from '../ink/components/Box.js'
import { useInput } from '../ink/hooks/use-input.js'
import { useState } from 'react'

export default function PromptInput({ onSubmit, disabled }) {
  const [value, setValue] = useState('')

  useInput((input, key) => {
    if (disabled) return
    if (key.return) {
      onSubmit(value)
      setValue('')
    } else if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1))
    } else if (!key.ctrl && !key.meta && input.length === 1) {
      setValue(v => v + input)
    }
  })

  return (
    <Box>
      <Text color="cyan">▸ </Text>
      <Text>{value}{!disabled && <Text color="gray">█</Text>}</Text>
    </Box>
  )
}
```

**MVP 范围**：单行输入、Enter 发送、Backspace 删除、光标闪烁（`<Text>█</Text>` 用 useInterval 切换显隐）。

### 4.2 Messages — 轻量版

**来源**：不使用 vendor 的 `Messages.tsx`（ScrollBox + VirtualMessageList + 复杂 diff/layout），全新编写。

```tsx
// src/tui/components/Messages.tsx
import { Box } from '../ink/components/Box.js'
import MessageResponse from './MessageResponse.js'
import Spinner from './Spinner.js'

export default function Messages({ messages, isLoading }) {
  return (
    <Box flexDirection="column" flexGrow={1}>
      {messages.map((msg, i) => (
        <MessageResponse key={i} content={msg.content} role={msg.role} />
      ))}
      {isLoading && <Spinner />}
    </Box>
  )
}
```

**砍掉**：tool call rendering、editing UI、teammate view、搜索高亮、文本选择。只保留纯文本消息流。

### 4.3 MessageResponse — 精简吸收

**来源**：参考 vendor 的 `MessageResponse.tsx` 中 `⎿ ` 前缀 + flex row 布局的设计思路。

```tsx
// src/tui/components/MessageResponse.tsx
import { Box, Text } from '../ink/components/Box.js'
import Markdown from './Markdown.js'

export default function MessageResponse({ content, role }) {
  const prefix = role === 'assistant' ? '⎿ ' : '❯ '

  return (
    <Box flexDirection="row" marginBottom={1}>
      <Text dimColor>{prefix}</Text>
      <Box flexGrow={1}>
        <Markdown content={content} />
      </Box>
    </Box>
  )
}
```

**砍掉**：所有工具调用折叠面板、差异渲染、代码块高亮交互。保留核心 prefix + flex row 结构。

### 4.4 Markdown — marked 解析 + ink Text 渲染

**来源**：全新编写。vendor 的 `Markdown.tsx` 依赖 CC 的 Markdown parser + 自定义 AST walker + 代码高亮。

```tsx
// src/tui/components/Markdown.tsx
import { Text } from '../ink/components/Box.js'
import { marked } from 'marked'
import { useMemo } from 'react'

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '')
}

export default function Markdown({ content }) {
  const parsed = useMemo(() => {
    const html = marked.parse(content, { async: false }) as string
    return stripHtml(html)
  }, [content])

  return <Text>{parsed}</Text>
}
```

**T1 范围**：
- P0：marked → 纯文本输出（strip HTML tags）
- P1：内联格式（bold/italic/code 用 ink Text props）
- 不做：代码块高亮、表格、图片、链接

### 4.5 Spinner — 复用 ink 框架能力

```tsx
// src/tui/components/Spinner.tsx
import { Text } from '../ink/components/Box.js'
import { useState, useEffect } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export default function Spinner() {
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI(x => (x + 1) % FRAMES.length), 80)
    return () => clearInterval(id)
  }, [])

  return <Text>{FRAMES[i]} Thinking...</Text>
}
```

也可直接用 vendor 的 `useInterval` hook 替代 `setInterval`。

---

## 5. npm 依赖清单

### 5.1 新增依赖（TUI 专属）

```json
{
  "dependencies": {
    "react": "^19.0.0",
    "react-reconciler": "^0.31.0",
    "yoga-layout-prebuilt": "^1.10.0",
    "marked": "^15.0.0",
    "emoji-regex": "^10.0.0",
    "get-east-asian-width": "^1.0.0",
    "strip-ansi": "^7.0.0",
    "@alcalzone/ansi-tokenize": "^0.2.0"
  }
}
```

### 5.2 版本兼容性

| 包 | 版本 | Node 20 | Windows | 备注 |
|---|---|---|---|---|
| `react` | 19.x | ✅ | ✅ | reconciler.ts 已适配 React 19 |
| `react-reconciler` | 0.31.x | ✅ | ✅ | 需与 react 版本匹配 |
| `yoga-layout-prebuilt` | 1.10.0 | ✅ | ✅ | 预编译 WASM，跨平台 |
| `marked` | 15.x | ✅ | ✅ | 纯 JS |
| `emoji-regex` | 10.x | ✅ | ✅ | 纯 JS |
| `get-east-asian-width` | 1.x | ✅ | ✅ | 纯 JS |
| `strip-ansi` | 7.x | ✅ | ✅ | ESM only |
| `@alcalzone/ansi-tokenize` | 0.2.x | ✅ | ✅ | TypeScript，ESM |

### 5.3 Windows 兼容性

- **yoga-layout-prebuilt**：提供预编译的 Windows x64 WASM binary
- **raw mode 终端输入**：Node.js `process.stdin.setRawMode(true)` 在 Windows 10+ 原生支持
- **ANSI 转义序列**：Windows Terminal 完全支持；建议最低要求 Windows Terminal

### 5.4 tsconfig 变更

当前 `tsconfig.json` 未配置 JSX，需添加：
```json
{
  "compilerOptions": {
    "jsx": "react-jsx"
  }
}
```

---

## 6. 启动联动设计

### 6.1 `trilc chat` 命令扩展

在 `src/cli.ts` 新增 `chat` case。

### 6.2 启动流程

```
trilc chat
  │
  ├─ 1. healthz 检查: GET http://127.0.0.1:8711/healthz
  │     ├─ 200 OK → daemon 已运行 → 跳转步骤 5
  │     └─ 失败 → 继续步骤 2
  │
  ├─ 2. auto-spawn: 调用 cmdStart(8711)
  │     └─ spawn detached child process: node dist/index.js
  │
  ├─ 3. 等待就绪（5s 轮询，最长 30s 超时）
  │     while (elapsed < 30000) {
  │       GET /healthz → if 200 break
  │       sleep(5000)
  │     }
  │
  ├─ 4. 超时处理
  │     └─ 若 30s 仍未就绪 → 输出错误 → exit(1)
  │
  └─ 5. 启动 TUI: import('./tui/render.js').then(m => m.startTUI())
```

### 6.3 关键决策

- **不修改 daemon**：TUI 通过 HTTP SSE 消费现有 `/chat/completions` 端点
- **auto-spawn 复用 `cmdStart()`**：保持 PID 文件、端口管理不变
- **5s 轮询间隔**：平衡启动速度与 CPU。daemon 冷启动约 2-5s
- **TUI 退出时**：不停止 daemon，仅 `root.unmount()` 清理终端

---

## 7. 目录结构

```
TriRLC/
├── src/
│   ├── tui/
│   │   ├── tech-design.md          # ★ 本文件
│   │   ├── app.tsx                  # TUI App 根组件
│   │   ├── render.ts               # createRoot + 启动逻辑
│   │   ├── components/
│   │   │   ├── PromptInput.tsx      # 极简单行输入
│   │   │   ├── Messages.tsx         # 消息列表（轻量）
│   │   │   ├── MessageResponse.tsx  # 单条消息（prefix + 内容）
│   │   │   ├── Markdown.tsx         # marked → ink Text
│   │   │   └── Spinner.tsx          # 加载动画
│   │   ├── hooks/
│   │   │   ├── useChat.ts           # SSE 客户端（fetch + ReadableStream）
│   │   │   └── useSSE.ts            # 底层 SSE 帧解析器
│   │   └── ink/                     # ★ 从 vendor/ink/ 吸收的最小子集
│   │       ├── root.ts              # createRoot / render（入口，不变）
│   │       ├── ink.tsx              # Ink 主类（CC import 已 shim）
│   │       ├── reconciler.ts        # React reconciler（CC import 已 shim）
│   │       ├── renderer.ts
│   │       ├── render-to-screen.ts
│   │       ├── render-node-to-output.ts
│   │       ├── dom.ts
│   │       ├── screen.ts
│   │       ├── output.ts            # CC import 已 shim
│   │       ├── frame.ts
│   │       ├── log-update.ts
│   │       ├── terminal.ts          # CC import 已 shim
│   │       ├── focus.ts
│   │       ├── node-cache.ts
│   │       ├── instances.ts
│   │       ├── constants.ts
│   │       ├── styles.ts
│   │       ├── measure-text.ts
│   │       ├── measure-element.ts
│   │       ├── wrap-text.ts
│   │       ├── squash-text-nodes.ts
│   │       ├── stringWidth.ts       # CC import 已 shim
│   │       ├── widest-line.ts
│   │       ├── line-width-cache.ts
│   │       ├── get-max-width.ts
│   │       ├── parse-keypress.ts
│   │       ├── warn.ts
│   │       ├── tabstops.ts
│   │       ├── shims.ts             # ★ 集中管理所有 CC→本地 shim
│   │       ├── components/
│   │       │   ├── App.tsx
│   │       │   ├── AppContext.ts
│   │       │   ├── Box.tsx
│   │       │   ├── Text.tsx
│   │       │   ├── Newline.tsx
│   │       │   ├── Spacer.tsx
│   │       │   ├── StdinContext.ts
│   │       │   └── TerminalSizeContext.tsx
│   │       ├── hooks/
│   │       │   ├── use-input.ts
│   │       │   ├── use-stdin.ts
│   │       │   ├── use-app.ts
│   │       │   ├── use-interval.ts
│   │       │   ├── use-animation-frame.ts
│   │       │   └── use-terminal-viewport.ts
│   │       ├── events/
│   │       │   ├── event.ts
│   │       │   ├── emitter.ts
│   │       │   ├── dispatcher.ts
│   │       │   ├── event-handlers.ts
│   │       │   ├── input-event.ts
│   │       │   └── keyboard-event.ts
│   │       ├── layout/
│   │       │   ├── engine.ts
│   │       │   ├── node.ts
│   │       │   ├── geometry.ts
│   │       │   └── yoga.ts          # ★ 已适配 yoga-layout-prebuilt
│   │       └── termio/
│   │           ├── ansi.ts
│   │           ├── csi.ts
│   │           ├── dec.ts
│   │           ├── esc.ts
│   │           ├── osc.ts
│   │           ├── parser.ts
│   │           ├── tokenize.ts
│   │           ├── types.ts
│   │           └── sgr.ts
│   ├── cli.ts                       # ★ 新增 'chat' 命令
│   └── server/                      # 现有 daemon 代码（不变）
│       ├── app.ts
│       ├── openai-stream.ts         # SSE 格式化（已实现，复用）
│       └── anthropic-stream.ts
├── vendor/
│   └── claude-code-tui/             # 保留作为参考基线（不变）
├── package.json                     # ★ 新增 react/marked/yoga-layout-prebuilt 依赖
└── tsconfig.json                    # ★ 新增 jsx: "react-jsx"
```

---

## 8. 实现顺序与门禁

### Phase 1：Ink Engine 吸收（阻塞项，必须先完成）

```
P1.1  创建 src/tui/ink/ 目录结构
P1.2  复制 45 个核心文件到 src/tui/ink/
P1.3  创建 src/tui/ink/shims.ts（集中 shim）
P1.4  修改所有 CC import 路径为本地 shim
P1.5  安装 npm 依赖（react, react-reconciler, yoga-layout-prebuilt 等）
P1.6  修改 tsconfig.json（jsx: "react-jsx"）
P1.7  ★ 冒烟验证：渲染 <Box><Text>Hello TriRLC</Text></Box>
P1.8  修复 yoga-layout-prebuilt 适配问题（如有）
```

**门禁**：`npm run check` 无类型错误 + 终端输出 "Hello TriRLC"

### Phase 2：核心组件

```
P2.1  useSSE.ts + useChat.ts（SSE 客户端）
P2.2  Spinner.tsx（加载动画）
P2.3  PromptInput.tsx（单行输入）
P2.4  MessageResponse.tsx（prefix + 内容）
P2.5  Markdown.tsx（marked 解析）
P2.6  Messages.tsx（消息列表）
P2.7  app.tsx（App 根组件）
P2.8  render.ts（createRoot 启动）
```

**门禁**：组件可独立在 Ink 环境渲染，无运行时错误

### Phase 3：集成

```
P3.1  cli.ts 新增 'chat' 命令
P3.2  auto-spawn 逻辑
P3.3  端到端测试：trilc chat → daemon auto-start → 输入消息 → SSE 流式响应 → TUI 渲染
```

**门禁**：完整 `trilc chat` 流程可用

---

## 9. 风险评估

### 🔴 HIGH：Yoga 布局桥接不兼容

- **描述**：CC 的 TS 移植版 `src/native-ts/yoga-layout/index.js` 可能与 `yoga-layout-prebuilt` API 存在差异
- **缓解**：
  1. `YogaLayoutNode` 适配器已包裹所有 Yoga API 调用，映射面可控
  2. 若 npm 包不兼容，备选方案：从 CC 源码提取其 `src/native-ts/yoga-layout/` 子目录
- **探测方法**：P1.7 冒烟测试即可暴露

### 🟡 MEDIUM：stringWidth.ts 的 GraphemeSegmenter shim

- **描述**：CC 的 `getGraphemeSegmenter()` 可能有自定义行为；`Intl.Segmenter` 是标准 API 但行为可能细微不同
- **缓解**：对 MVP 使用的 ASCII + 基本中文覆盖进行手动验证
- **实际影响**：仅影响含 emoji/连字的文本宽度计算，MVP 初期大概率不触发

### 🟡 MEDIUM：react / react-reconciler 版本对齐

- **描述**：vendor reconciler.ts 使用 React 19 的 createReconciler API
- **缓解**：`react@19` + `react-reconciler@0.31` 是已知兼容组合
- **约束**：不得使用 React 18 或 react-reconciler 0.29 以下

### 🟢 LOW：Windows Terminal ANSI 兼容性

- **描述**：ink 引擎大量使用 ANSI 转义序列
- **缓解**：Windows Terminal 完全支持；ConEmu 实测兼容
- **建议**：README 中注明最低要求 Windows Terminal

### 🟢 LOW：吸收过程的 TypeScript 类型错误

- **描述**：import 路径、shim 类型签名不匹配可能产生 TS 编译错误
- **缓解**：集中在 `shims.ts` 中显式类型标注；`skipLibCheck: true`（已配置）

---

## 10. 交付标准

### T1 MVP 验收条件

- [ ] `trilc chat` 命令可启动 TUI
- [ ] 未运行 daemon 时自动 spawn 并等待就绪
- [ ] 单行文本输入 + Enter 发送
- [ ] SSE 流式响应实时渲染（逐 token 显示）
- [ ] `⎿ ` 前缀区分 assistant 消息
- [ ] 加载中显示 Spinner 动画
- [ ] Ctrl+C 退出 TUI（不停止 daemon）
- [ ] `npm run build` 通过（`tsc -p tsconfig.json` 无错误）

### 明确不做的（T1 out-of-scope）

- 多行输入、光标移动、编辑
- 对话历史持久化
- 代码块高亮、表格渲染
- Tool call 可视化
- 消息滚动（由终端 scrollback 处理）
- 主题切换
- 鼠标交互

### 回滚姿态

- TUI 作为新增子目录 `src/tui/`，不影响现有 daemon 代码
- 若 TUI 不可用，用户仍可通过 HTTP API 消费 daemon
- `trilc chat` 命令失败时退化为提示用户使用 API 模式

---

## 11. 使用依据

| 依据 | 路径 |
|---|---|
| Ink 引擎核心 | `TriRLC/vendor/claude-code-tui/ink/root.ts`, `ink.tsx`, `reconciler.ts`, `renderer.ts`, `dom.ts`, `screen.ts`, `output.ts`, `frame.ts` |
| Yoga 布局适配器 | `TriRLC/vendor/claude-code-tui/ink/layout/yoga.ts`, `engine.ts`, `node.ts` |
| ThemeProvider 剥离证明 | `TriRLC/vendor/claude-code-tui/ink.ts`（仅做 ThemeProvider 包裹） |
| Daemon API | `TriRLC/src/server/openai-stream.ts`（SSE 格式化），`TriRLC/src/server/app.ts`（路由） |
| CLI 入口 | `TriRLC/src/cli.ts`（现有 start/stop/status/run 命令） |
| Code Registry | `TriRLC/docs/registry/code-state.md` |
| Package 基线 | `TriRLC/package.json`, `TriRLC/tsconfig.json` |
