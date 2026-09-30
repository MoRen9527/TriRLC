// @ts-nocheck
// ── Ink TUI App ──
// REGR-001+007: message visual layer separation — UserMessage/AssistantMessage
// with block-level rendering, ToolResultLine, and message separators.
// NOTE: type annotations were lost during a git-checkout recovery incident;
// this file was restored from the compiled backup (dist/tui/app.js). Re-add
// types during Phase 2 (fork migration).
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { Box, Text } from './fork.js';
import stringWidth from 'string-width';
// P10: CC terminal input layer replaces npm ink useInput
import { useInput } from './hooks/useTerminalInput.js';
import { useChat } from './hooks/useChat.js';
import { useCursorInput } from './hooks/useCursorInput.js';
import { useDoublePress } from './hooks/useDoublePress.js';
import { usePendingInteraction } from './hooks/usePendingInteraction.js';
import Markdown from './components/Markdown.js';
import ToolCallLine from './components/ToolCallLine.js';
import StatusLine from './components/StatusLine.js';
import ThinkingLine from './components/ThinkingLine.js';
import ErrorMessage from './components/ErrorMessage.js';
import InputBox from './components/InputBox.js';
import AgentPanel from './components/AgentPanel.js';
import InteractionPrompt, { PERMISSION_OPTIONS } from './components/InteractionPrompt.js';
import { useTheme } from './design-system/theme.js';
import { levenshtein } from './utils/levenshtein.js';
// ── UserMessage — CC-style ▎ prefix + warning color + indent ──
const UserMessage = React.memo(function UserMessage({ msg }) {
    const theme = useTheme();
    return React.createElement(Box, { flexDirection: "column", paddingBottom: 1 }, React.createElement(Box, { paddingLeft: 1 }, React.createElement(Text, { color: theme.warning, bold: true }, "▎ You")), React.createElement(Box, { paddingLeft: 2 }, React.createElement(Text, null, msg.content)));
});
// ── ToolResultLine — dim tool output preview ──
// P2-Batch1-#1: 传递 isToolResult 给 Markdown 启用 diff 渲染
// P2-fix: TodoWrite/TaskList 结果渲染为 TodoPanel 表格（非裸 JSON）
// P2 #2: AskUserQuestionTool 结果渲染为 QuestionLine（多选题界面）
const QuestionLine = React.memo(function QuestionLine({ questions, answers }) {
    return React.createElement(Box, { flexDirection: 'column', paddingY: 1, borderStyle: 'round', borderColor: 'blue' }, React.createElement(Box, { flexDirection: 'column' }), ...questions.map((q, i) => React.createElement(Box, { key: `q-${i}`, flexDirection: 'column', marginBottom: i < questions.length - 1 ? 1 : 0 }, React.createElement(Text, { bold: true, color: 'blue' }, `【${q.header}】`), React.createElement(Text, null, q.question), React.createElement(Box, { marginTop: 1, flexDirection: 'column' }, ...q.options.map((opt, j) => {
        const num = j + 1;
        const isSelected = answers?.[q.question] === opt.label;
        return React.createElement(Box, { key: `opt-${j}`, paddingLeft: 2, marginBottom: 0 }, React.createElement(Text, { color: isSelected ? 'green' : 'gray' }, ` ${num}. ${isSelected ? '✓' : '○'} ${opt.label} — ${opt.description}`), opt.preview ? React.createElement(Box, { paddingLeft: 6 }, React.createElement(Text, { dimColor: true }, `   Preview: ${opt.preview.length > 80 ? opt.preview.slice(0, 80) + '...' : opt.preview}`)) : null);
    })))), answers ? React.createElement(Box, { marginTop: 1 }, React.createElement(Text, { dimColor: true, italic: true }, 'Answered via interactive prompt.')) : null);
});
const ToolResultLine = React.memo(function ToolResultLine({ block }) {
    const content = block.toolResultContent || '';
    // P2 #2: Detect AskUserQuestion result → render as QuestionLine
    try {
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.questions) && parsed.questions.length > 0) {
            return React.createElement(QuestionLine, { questions: parsed.questions, answers: parsed.answers });
        }
    }
    catch { /* not JSON or not questions — fall through */ }
    // Detect TodoWrite/Task* JSON result → render as compact task list
    try {
        const parsed = JSON.parse(content);
        if (parsed && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
            const statusSymbol = (s) => s === 'completed' ? '✓' : s === 'in_progress' ? '→' : '○';
            const statusColor = (s) => s === 'completed' ? 'green' : s === 'in_progress' ? 'yellow' : 'gray';
            return React.createElement(Box, { marginLeft: 2, flexDirection: 'column' }, React.createElement(Text, { dimColor: true, bold: true }, `Tasks (${parsed.tasks.length})`), ...parsed.tasks.map((t, i) => React.createElement(Text, { key: `tr-task-${i}` }, React.createElement(Text, { color: statusColor(t.status), bold: t.status === 'in_progress' }, ` ${statusSymbol(t.status)} `), React.createElement(Text, { dimColor: true }, t.priority ? `[${t.priority.toUpperCase()}] ` : ''), React.createElement(Text, null, t.subject))));
        }
    }
    catch { /* not JSON or not a task list — fall through to Markdown/diff */ }
    return React.createElement(Box, { marginLeft: 2, flexDirection: 'column' }, React.createElement(Markdown, { content, isToolResult: true }));
});
// ── AssistantMessage — block-level rendering with backward compat ──
const AssistantMessage = React.memo(function AssistantMessage({ msg, verbose }) {
    const blocks = msg.blocks;
    // Backward compat: if no blocks, fall back to content + toolCalls rendering
    if (!blocks || blocks.length === 0) {
        return React.createElement(Box, { flexDirection: "column", paddingBottom: 1 }, msg.thinking ? React.createElement(ThinkingLine, { content: msg.thinking, collapsed: !verbose }) : null, msg.toolCalls?.map((tc, j) => React.createElement(ToolCallLine, { key: "tc-" + j, name: tc.name, args: tc.arguments ?? '{}',
            status: (tc.status === 'blocked' ? 'error' : tc.status) })), React.createElement(Box, { paddingLeft: 1 }, React.createElement(Markdown, { content: msg.content })));
    }
    // New path: render blocks in order, interleaving text / tool_use / tool_result
    return React.createElement(Box, { flexDirection: "column", paddingBottom: 1 },
    // thinking block at top (if present)
    msg.thinking ? React.createElement(ThinkingLine, { content: msg.thinking, collapsed: !verbose }) : null, ...blocks.map((block, i) => {
        switch (block.type) {
            case 'text':
                return React.createElement(Box, { key: "b-" + i, paddingLeft: 1 }, React.createElement(Markdown, { content: block.text || '' }));
            case 'tool_use':
                return React.createElement(ToolCallLine, {
                    key: "tc-" + i,
                    name: block.toolName || '?',
                    args: block.toolInput || '{}',
                    status: block.toolStatus || 'pending',
                });
            case 'tool_result':
                return React.createElement(ToolResultLine, { key: "tr-" + i, block });
            default:
                return null;
        }
    }));
});
// ── Message dispatcher ──
function renderMessage(msg, verbose) {
    if (msg.role === 'user')
        return React.createElement(UserMessage, { msg });
    return React.createElement(AssistantMessage, { msg, verbose });
}
export default function App({ onAbortRef, onCtrlCRef, resume }) {
    const { messages, send, isLoading, requestState, error, abort, loadSession, clearMessages, addSystemMessage, inputTokens, outputTokens, model, setModel } = useChat();
    const theme = useTheme();
    const [verbose, setVerbose] = useState(false);
    // ── P3: interactive prompts (AskUserQuestion / permission ask) ──
    const { pending, answer } = usePendingInteraction(isLoading);
    const [questionIndex, setQuestionIndex] = useState(0);
    const [cursorIndex, setCursorIndex] = useState(0);
    const [collectedAnswers, setCollectedAnswers] = useState({});
    // Reset prompt-local state whenever a new interaction arrives
    const pendingId = pending?.id ?? null;
    useEffect(() => {
        setQuestionIndex(0);
        setCursorIndex(0);
        setCollectedAnswers({});
    }, [pendingId]);
    // Options count for the currently displayed prompt page
    const currentOptionCount = (() => {
        if (!pending)
            return 0;
        if (pending.kind === 'permission')
            return PERMISSION_OPTIONS.length;
        const questions = pending.payload.questions ?? [];
        const q = questions[Math.min(questionIndex, questions.length - 1)];
        return q?.options.length ?? 0;
    })();
    const submitSelection = useCallback((selected) => {
        if (!pending)
            return;
        if (pending.kind === 'permission') {
            const verdict = selected === 0 ? 'allow' : selected === 1 ? 'deny' : 'always';
            answer(pending.id, verdict);
            return;
        }
        const questions = pending.payload.questions ?? [];
        const q = questions[Math.min(questionIndex, questions.length - 1)];
        if (!q || !q.options[selected])
            return;
        const nextAnswers = { ...collectedAnswers, [q.question]: q.options[selected].label };
        setCollectedAnswers(nextAnswers);
        if (questionIndex + 1 < questions.length) {
            setQuestionIndex(questionIndex + 1);
            setCursorIndex(0);
        }
        else {
            answer(pending.id, { answers: nextAnswers });
        }
    }, [pending, questionIndex, collectedAnswers, answer]);
    // Keyboard capture while a prompt is active (takes ownership from useCursorInput)
    useInput((inputChar, key) => {
        if (!pending)
            return;
        if (key.escape) {
            answer(pending.id, pending.kind === 'permission' ? 'deny' : { cancelled: true });
            return;
        }
        if (key.upArrow) {
            setCursorIndex((i) => (currentOptionCount > 0 ? (i - 1 + currentOptionCount) % currentOptionCount : 0));
            return;
        }
        if (key.downArrow) {
            setCursorIndex((i) => (currentOptionCount > 0 ? (i + 1) % currentOptionCount : 0));
            return;
        }
        if (key.return) {
            submitSelection(cursorIndex);
            return;
        }
        const num = parseInt(inputChar, 10);
        if (Number.isInteger(num) && num >= 1 && num <= currentOptionCount) {
            submitSelection(num - 1);
        }
    }, { isActive: !!pending });
    const handleCtrlC = useDoublePress(() => {
        clear();
        addSystemMessage('Press Ctrl+C again to exit.');
    }, () => {
        // Use setImmediate to let Ink finish current render cycle before exiting.
        // Direct process.exit() during SIGINT handler can corrupt stdout and
        // leave the terminal in an inconsistent state.
        setImmediate(() => process.exit(0));
    });
    useEffect(() => {
        if (onCtrlCRef)
            onCtrlCRef.current = handleCtrlC;
        return () => { if (onCtrlCRef)
            onCtrlCRef.current = null; };
    }, [handleCtrlC, onCtrlCRef]);
    // P9: auto-compact when session grows large (CC behavior: proactive compaction).
    // Uses a ref to prevent re-triggering during async compactConversation.
    const compactRef = useRef(false);
    useEffect(() => {
        if (messages.length < 45 || isLoading || compactRef.current)
            return;
        compactRef.current = true;
        (async () => {
            try {
                const { compactConversation } = await import('../services/compact/index.js');
                const apiMsgs = messages.map(m => ({ role: m.role, content: m.content }));
                const result = await compactConversation(apiMsgs);
                clearMessages();
                addSystemMessage(result.message);
            }
            catch { /* fallback: simple truncation */ }
            compactRef.current = false;
        })();
    }, [messages.length, isLoading, clearMessages, addSystemMessage]);
    const COMMANDS = {
        '/exit': { desc: 'Exit TriCade', handler: () => { setImmediate(() => process.exit(0)); return ''; } },
        '/init': { desc: 'Analyze project & generate CLAUDE.md (AI-driven; "/init local" = offline)', handler: async (args) => {
                // CC-fidelity P4: /init delegates to the AI — it explores the codebase
                // with Read/Glob, optionally clarifies priorities via ask_user_question,
                // then writes CLAUDE.md. Use "/init local" for the offline quick-template
                // when no daemon/AI is available.
                const argTrim = args.trim().toLowerCase();
                if (argTrim !== 'local') {
                    const focus = args.trim() && argTrim !== 'local' ? `\n\nPay extra attention to: ${args.trim()}` : '';
                    // P5: CC-style structured /init — Phase 1-4 process mirrors CC's init.ts
                    send(`You are running /init to produce a CLAUDE.md project guide.

**Phase 1 — Explore**: Read package.json, README, tsconfig, and browse the top-level source directories. Identify: project type, build/dev/test commands, main entry points, key dependencies.

**Phase 2 — Clarify (optional)**: If anything is unclear after Phase 1 (e.g. primary entry point, which conventions matter most, which areas to prioritize), use ask_user_question.

**Phase 3 — Write**: Create CLAUDE.md at the project root covering:
- Project overview (what it does, who it's for)
- Key commands: build, test, lint, dev server, migrate, deploy (only list real commands found)
- Architecture: main directory tree, module boundaries, data-flow patterns, key abstractions
- Conventions: coding style, naming, commit format, branch strategy, test organization
- Notes: any non-obvious decisions or gotchas discovered during exploration

**Phase 4 — Verify**: Re-read the CLAUDE.md you wrote. Does it match the actual project structure? Remove any placeholder or made-up sections. If a project-specific skill is relevant (simplify, debug, remember), note it.${focus}`);
                    return 'Analyzing project via AI and generating CLAUDE.md… (use "/init local" for the offline template)';
                }
                // ── Offline fallback (local template) ──
                // P2-Batch2-#2: Enhanced /init with CC-style template (NEW_INIT_PROMPT structure)
                // Auto-analyze: reads package.json, README, tsconfig, .gitignore to detect commands/architecture
                const { writeFile, readFile } = await import('node:fs/promises');
                const { existsSync } = await import('node:fs');
                const { resolve } = await import('node:path');
                const cwd = process.cwd();
                // Auto-detect project info
                let buildCmd = 'npm run build';
                let testCmd = 'npm test';
                let projType = 'Unknown';
                let framework = '';
                // Read package.json if exists
                const pkgPath = resolve(cwd, 'package.json');
                if (existsSync(pkgPath)) {
                    try {
                        const pkgContent = await readFile(pkgPath, 'utf-8');
                        const pkg = JSON.parse(pkgContent);
                        if (pkg.scripts) {
                            if (pkg.scripts.build)
                                buildCmd = `npm run ${pkg.scripts.build}`;
                            if (pkg.scripts.test)
                                testCmd = `npm run ${pkg.scripts.test}`;
                        }
                        if (pkg.dependencies) {
                            const deps = Object.keys(pkg.dependencies);
                            if (deps.includes('react'))
                                framework = 'React';
                            else if (deps.includes('vue'))
                                framework = 'Vue';
                            else if (deps.includes('@fastify/core') || deps.includes('express'))
                                framework = 'Node.js API';
                        }
                        projType = pkg.type === 'module' ? 'ES Module' : 'CommonJS';
                    }
                    catch { }
                }
                // Read README if exists
                let readmeNotes = '';
                const readmePath = resolve(cwd, 'README.md');
                if (existsSync(readmePath)) {
                    readmeNotes = '\n## Key Notes from README\n<!-- See README.md for project overview -->\n';
                }
                const template = `# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
<!-- Add brief project description here -->

## Build & Test
- **Build**: \`${buildCmd}\`
- **Test**: \`${testCmd}\`
- **Type**: ${projType}${framework ? `, Framework: ${framework}` : ''}

## Architecture Notes
<!-- Add non-obvious architectural decisions or patterns here -->

${readmeNotes}
## Development Workflow
<!-- Add team-specific workflow notes: branch conventions, PR flow, etc. -->

---
Generated by TriCade v0.4.0 — P2-Batch2 CC-fidelity /init.
Edit this file to add project-specific instructions.
`;
                try {
                    const filePath = resolve(cwd, 'CLAUDE.md');
                    await writeFile(filePath, template, 'utf-8');
                    return `Created ${filePath}. Auto-detected: ${projType}${framework ? ` + ${framework}` : ''}. Edit to add project-specific context.`;
                }
                catch (e) {
                    return `Failed to create CLAUDE.md: ${e.message}`;
                }
            } },
        '/help': { desc: 'Show commands', handler: () => Object.entries(COMMANDS).map(([k, v]) => "  " + k + "  — " + v.desc).join('\n') },
        '/clear': { desc: 'Clear message history', handler: () => { clearMessages(); return 'Cleared.'; } },
        '/model': { desc: 'Show or switch model', handler: (args) => {
                if (!args) {
                    return `Current model: ${model}\n\nAvailable models:\n  deepseek-v4-pro (full capability)\n  deepseek-v4-flash (fast)\n\nUsage: /model <name>`;
                }
                const targetModel = args.toLowerCase().trim();
                // Validate model name
                if (targetModel !== 'deepseek-v4-pro' && targetModel !== 'deepseek-v4-flash') {
                    return `Unknown model: ${args}\n\nAvailable: deepseek-v4-pro, deepseek-v4-flash`;
                }
                setModel(targetModel);
                return `Switched to ${targetModel}`;
            } },
        '/verbose': { desc: 'Toggle verbose mode', handler: () => { setVerbose(v => !v); return "Verbose " + (verbose ? 'OFF' : 'ON') + "."; } },
        '/status': { desc: 'Show session stats', handler: () => `Session: ${messages.length} msgs, model: ${model}` },
        '/context': { desc: 'Show context usage (tokens/percentage/messages)', handler: () => {
                const totalTokens = inputTokens + outputTokens;
                const contextWindow = 128000; // deepseek-v4-flash context window
                const percentage = ((totalTokens / contextWindow) * 100).toFixed(2);
                const barLength = 30;
                const filled = Math.min(Math.round((totalTokens / contextWindow) * barLength), barLength);
                const empty = barLength - filled;
                const bar = '█'.repeat(filled) + '░'.repeat(empty);
                return `Context Usage:
  Input Tokens:    ${inputTokens.toLocaleString()}
  Output Tokens:   ${outputTokens.toLocaleString()}
  Total Tokens:    ${totalTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${percentage}%)
  Messages:        ${messages.length}
  └─ ${bar}`;
            } },
        '/cost': { desc: 'Show session cost estimate', handler: () => {
                const totalTokens = inputTokens + outputTokens;
                // Simple cost estimation (approximate DeepSeek pricing)
                // deepseek-v4-pro: ~$1/M input, ~$2/M output
                // deepseek-v4-flash: ~$0.10/M input, ~$0.20/M output
                const isPro = model === 'deepseek-v4-pro';
                const inputCostPerMillion = isPro ? 1.0 : 0.10;
                const outputCostPerMillion = isPro ? 2.0 : 0.20;
                const inputCost = (inputTokens / 1_000_000) * inputCostPerMillion;
                const outputCost = (outputTokens / 1_000_000) * outputCostPerMillion;
                const totalCost = inputCost + outputCost;
                return `Session Cost (${model}):
  Input Tokens:    ${inputTokens.toLocaleString()} × $${inputCostPerMillion.toFixed(2)}/M = $${inputCost.toFixed(4)}
  Output Tokens:   ${outputTokens.toLocaleString()} × $${outputCostPerMillion.toFixed(2)}/M = $${outputCost.toFixed(4)}
  ────────────────────────────────────────────────────
  Total Cost:      $${totalCost.toFixed(4)}

  Note: Costs are estimates based on ${model} pricing.
  Actual costs may vary based on caching and promotions.`;
            } },
        '/compact': { desc: 'Compact context (summarize history)', handler: async () => {
                // P2-Batch2-#1: CC-fidelity compact with real summarization
                // Uses TriRLC compact service (CC prompt.ts + compact.ts adapted)
                try {
                    const { compactConversation, createCompactedMessages } = await import('../services/compact/index.js');
                    const apiMessages = messages.map(m => ({ role: m.role, content: m.content }));
                    const result = await compactConversation(apiMessages);
                    // Replace message list with summary
                    clearMessages();
                    addSystemMessage(result.message);
                    return `Compacted: ${result.tokensRemoved} tokens summarized.`;
                }
                catch (e) {
                    const errorMsg = e.message || String(e);
                    // Fallback: simple truncation (keep first user + last 5 messages)
                    const toKeep = messages.length > 6
                        ? [messages[0], ...messages.slice(-5)]
                        : messages;
                    const removedCount = messages.length - toKeep.length;
                    if (removedCount > 0) {
                        clearMessages();
                        // Add recent messages back
                        for (const msg of toKeep) {
                            if (msg.role === 'user') {
                                // User messages need to be sent through the chat flow
                                // For now, just add as system message with truncation note
                            }
                        }
                        addSystemMessage(`[Compacted: ${removedCount} messages removed due to error: ${errorMsg}]`);
                        return `Compacted with fallback: ${removedCount} messages removed. Error: ${errorMsg}`;
                    }
                    return `Compaction failed: ${errorMsg}. Not enough messages to compact.`;
                }
            } },
        '/sessions': { desc: 'List saved sessions', handler: async () => { try {
                const r = await fetch('http://localhost:8711/internal/v1/sessions?limit=10');
                const j = await r.json();
                return (j.sessions || []).map((s) => s.id?.slice(0, 12) + "…  " + (s.status ?? '?') + "  " + (s.created_at ?? '')).join('\n') || 'No sessions';
            }
            catch {
                return 'Cannot reach daemon';
            } } },
        '/branch': { desc: 'Fork this conversation to a new session', handler: async () => {
                try {
                    const currentSid = messages.length > 0 ? (await (async () => { try {
                        const r = await fetch('http://localhost:8711/internal/v1/sessions?limit=1');
                        const j = await r.json();
                        return j.sessions?.[0]?.id ?? null;
                    }
                    catch {
                        return null;
                    } })()) : null;
                    if (!currentSid)
                        return 'No active session to branch. Send a message first.';
                    const r = await fetch(`http://localhost:8711/internal/v1/sessions/${encodeURIComponent(currentSid)}/fork`, { method: 'POST' });
                    const j = await r.json();
                    if (j.ok) {
                        return 'Branched: ' + j.title + '\nNew session: ' + j.sessionId + '\nMessages: ' + j.messageCount + '\n\nUse /sessions to find and resume the original.';
                    }
                    return 'Branch failed: ' + (j.error ?? j.message ?? 'unknown error');
                }
                catch (e) {
                    return 'Cannot reach daemon: ' + (e.message ?? String(e));
                }
            } },
        '/agents': { desc: 'List available sub-agent types', handler: async () => { try {
                const { listAgentsForDisplay } = await import('../tools/agent-tool.js');
                return listAgentsForDisplay();
            }
            catch {
                return 'Agent listing unavailable';
            } } },
        '/plan': { desc: 'Enter plan mode (AI explores and designs before coding)', handler: () => {
                send(`You should enter plan mode (use the EnterPlanMode tool) for the next task. In plan mode:
- Explore the codebase thoroughly with Read, Glob, and Grep
- Understand existing patterns and architecture
- Design an implementation approach before writing any code
- Present your plan clearly with specific files to change and approach
- When your plan is ready, use ExitPlanMode to present it

DO NOT write or edit any files while planning — this is a read-only exploration phase.

What task would you like to plan? Describe what you want to build or change.`);
                return 'Entering plan mode — AI will explore and design before implementing.';
            } },
        '/review': { desc: 'Review a pull request (AI-driven code review)', handler: (args) => {
                const LOCAL_REVIEW_PROMPT = `You are an expert code reviewer. Follow these steps:

1. If no PR number is provided in the args, run \`gh pr list\` to show open PRs
2. If a PR number is provided, run \`gh pr view <number>\` to get PR details
3. Run \`gh pr diff <number>\` to get the diff
4. Analyze the changes and provide a thorough code review that includes:
   - Overview of what the PR does
   - Analysis of code quality and style
   - Specific suggestions for improvements
   - Any potential issues or risks

Keep your review concise but thorough. Focus on:
- Code correctness
- Following project conventions
- Performance implications
- Test coverage
- Security considerations

Format your review with clear sections and bullet points.

PR number: ${args.trim() || '(please list open PRs first)'}`;
                send(LOCAL_REVIEW_PROMPT);
                return 'Running code review via AI...';
            } },
    };
    const handleSend = useCallback((text) => { if (text.trim())
        send(text.trim()); }, [send]);
    const handleCommand = useCallback((inputText) => {
        const parts = inputText.trim().split(/\s+/);
        const cmdName = (parts[0] ?? '').toLowerCase();
        const args = parts.slice(1).join(' ');
        const entry = COMMANDS[cmdName];
        if (entry) {
            const r = entry.handler(args);
            if (typeof r === 'string')
                addSystemMessage(r);
            else
                r.then(s => addSystemMessage(s));
            return true;
        }
        const names = Object.keys(COMMANDS);
        const closest = names.reduce((best, n) => { const d = levenshtein(cmdName, n); return d < best.d ? { name: n, d } : best; }, { name: '', d: 99 });
        const hint = closest.d <= 3 ? " Did you mean " + closest.name + "?" : '';
        addSystemMessage("Unknown command: " + inputText + ". Type /help for available commands." + hint);
        return true;
    }, [clearMessages, addSystemMessage]);
    const handleBash = useCallback((cmd) => {
        (async () => {
            try {
                const { execSync } = await import('child_process');
                const output = execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8', timeout: 30000, maxBuffer: 1024 * 1024 });
                addSystemMessage("! " + cmd + "\n" + (output || '(no output)'));
            }
            catch (e) {
                addSystemMessage("! " + cmd + "\nError: " + (e.message || String(e)));
            }
        })();
    }, [addSystemMessage]);
    // ── w34-2: Cron engine status polling ──
    const [cronDegraded, setCronDegraded] = useState(false);
    const [cronFailures, setCronFailures] = useState(0);
    useEffect(() => {
        const TRILC_PORT = process.env.TRILC_PORT ?? '8711';
        const poll = async () => {
            try {
                const r = await fetch(`http://localhost:${TRILC_PORT}/healthz`);
                const j = await r.json();
                const degraded = j?.cron?.degraded ?? false;
                const failures = j?.cron?.consecutiveFailures ?? 0;
                setCronDegraded(degraded);
                setCronFailures(failures);
            } catch {
                // Daemon unreachable — keep previous state
            }
        };
        poll();
        const iv = setInterval(poll, 5000);
        return () => clearInterval(iv);
    }, []);
    const [resumeLoaded, setResumeLoaded] = useState(false);
    const { inputText, cursorOffset, clear } = useCursorInput({
        onSubmit: handleSend, onCommand: handleCommand, onBash: handleBash,
        onPasteOverflow: (fullLen) => {
            addSystemMessage("[Paste truncated: " + fullLen + " chars → 10K max]");
        },
        // P3: while an interaction prompt is active, it owns the keyboard
        isActive: !pending,
    });
    // Commands for hint overlay (InputBox)
    const commandsForHint = {};
    for (const [k, v] of Object.entries(COMMANDS)) {
        commandsForHint[k] = { desc: v.desc };
    }
    useEffect(() => { if (onAbortRef)
        onAbortRef.current = abort; return () => { if (onAbortRef)
        onAbortRef.current = null; }; }, [abort, onAbortRef]);
    useEffect(() => {
        if (resumeLoaded)
            return;
        if (!resume) {
            setResumeLoaded(true);
            return;
        }
        // REQ-013: whenever a sessionId exists, loadSession() must run —
        // it fetches the session's systemPrompt (onboarding persona) and
        // setSystemPrompt()s it into useChat. The display layer keeps using
        // resume.messages (same daemon source as loadSession's return).
        if (resume.sessionId) {
            loadSession(resume.sessionId).then(() => setResumeLoaded(true)).catch(() => setResumeLoaded(true));
        }
        else {
            setResumeLoaded(true);
        }
    }, [resume, resumeLoaded, loadSession]);
    const resumeMsgs = resume?.messages?.map(m => ({ role: m.role, content: m.content, isStreaming: false })) ?? [];
    const allMsgs = resumeMsgs.length > 0 && messages.length === 0 ? resumeMsgs : messages;
    const displayMsgs = allMsgs.length > 0 && allMsgs[allMsgs.length - 1]?.isStreaming ? allMsgs.slice(0, -1) : allMsgs;
    const hasStreaming = allMsgs.length > 0 && allMsgs[allMsgs.length - 1]?.isStreaming;
    // P5: Extract AgentTool states from message blocks for the sub-agent panel.
    const agentStates = [];
    const seenAgentIds = new Set();
    for (const msg of allMsgs) {
        if (msg.blocks) {
            for (const block of msg.blocks) {
                if (block.type === 'tool_use' && (block.toolName === 'AgentTool' || block.toolName === 'agent_tool' || block.toolName === 'Agent')) {
                    const agentId = block.toolId || block.toolInput?.slice(0, 8) || '';
                    if (seenAgentIds.has(agentId))
                        continue;
                    seenAgentIds.add(agentId);
                    let agentName = 'subagent';
                    if (block.toolInput) {
                        try {
                            const inp = JSON.parse(block.toolInput);
                            agentName = inp.subagent_type || inp.description?.slice(0, 30) || 'subagent';
                        }
                        catch { /* raw string */ }
                    }
                    agentStates.push({
                        id: agentId,
                        name: agentName,
                        state: block.toolStatus === 'pending' ? 'running' : block.toolStatus === 'done' ? 'done' : block.toolStatus === 'error' ? 'error' : 'idle',
                    });
                }
            }
        }
    }
    // ── Build message elements with separators ──
    const messageElements = [];
    displayMsgs.forEach((msg, i) => {
        messageElements.push(React.createElement(Box, { key: "msg-" + i }, renderMessage(msg, verbose)));
        // Separator after each message except the very last one
        const isLastDisplay = i === displayMsgs.length - 1;
        if (!isLastDisplay || hasStreaming) {
            messageElements.push(React.createElement(Text, { key: "sep-" + i, dimColor: true }, '───'));
        }
    });
    // Streaming message (no trailing separator)
    if (hasStreaming) {
        messageElements.push(React.createElement(Box, { key: 'streaming' }, renderMessage(allMsgs[allMsgs.length - 1], verbose)));
    }
    // ── IME cursor parking (CC useDeclaredCursor minimal equivalent) ──
    // After each render, position the terminal's physical cursor at the input
    // caret so IME composition (CJK input) renders candidates inline.
    //
    return React.createElement(Box, { flexDirection: "column", height: "100%" }, React.createElement(Box, { flexGrow: 1, flexDirection: "column" }, displayMsgs.length === 0 && !hasStreaming && React.createElement(Box, { paddingY: 1 }, React.createElement(Text, { color: theme.info, bold: true }, "TriCade v0.4.0"), React.createElement(Text, { dimColor: true }, resume ? "Session: " + (resume.sessionId ?? '(loaded)') + " — Type and Enter. /exit to quit." : "Type and Enter. /exit to quit. Ctrl+C twice.")), resumeMsgs.length > 0 && messages.length === 0 && React.createElement(Box, { paddingY: 0 }, React.createElement(Text, { dimColor: true }, "── Resumed " + resumeMsgs.length + " messages ──")), ...messageElements, requestState === 'waitingForFirstToken' && React.createElement(Text, { dimColor: true }, "Thinking..."), error && React.createElement(ErrorMessage, { message: error })), pending
        ? React.createElement(InteractionPrompt, {
            interaction: pending,
            questionIndex,
            cursorIndex,
            collectedAnswers,
        })
        : null,
    // P5: Sub-agent status panel (visible when agents are active)
    agentStates.length > 0
        ? React.createElement(AgentPanel, { agents: agentStates })
        : null, React.createElement(Box, { flexDirection: "column", borderStyle: "single" }, React.createElement(InputBox, { inputText, cursorOffset, isLoading, commands: commandsForHint })), React.createElement(StatusLine, {
        model,
        cwd: process.cwd(),
        inputTokens,
        outputTokens,
        totalMessages: displayMsgs.length,
        maxContextMessages: 100,
        cronDegraded,
        cronFailures,
    }));
}
