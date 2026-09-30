// ── Bundled Skills Registry (CC-equivalent)
// Registers built-in skills programmatically at startup.
// Skills are compiled into the CLI and available to all users.
//
// P3: Populated with high-value skills absorbed from Claude Code's
// src/skills/bundled/ (simplify, debug, remember). Prompts adapted to
// TriRLC's BundledSkillDefinition (getPromptForCommand returns a string)
// and stripped of CC-internal dependencies (settings paths, debug-log
// plumbing, auto-memory feature flags).

export interface BundledSkillDefinition {
  name: string;
  description: string;
  aliases?: string[];
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  isEnabled?: () => boolean;
  context?: 'inline' | 'fork';
  agent?: string;
  files?: Record<string, string>; // Reference files to extract on first invocation
  getPromptForCommand: (
    args: string,
  ) => Promise<string>;
}

// Internal registry for bundled skills
const bundledSkills: BundledSkillDefinition[] = [];

/**
 * Register a bundled skill that will be available to the model.
 * Call this at module initialization or in an init function.
 */
export function registerBundledSkill(definition: BundledSkillDefinition): void {
  bundledSkills.push(definition);
}

/**
 * Get all registered bundled skills.
 * Returns a copy to prevent external mutation.
 */
export function getBundledSkills(): BundledSkillDefinition[] {
  return [...bundledSkills];
}

/**
 * Clear bundled skills registry (for testing).
 */
export function clearBundledSkills(): void {
  bundledSkills.length = 0;
}

// ════════════════════════════════════════════════════════════════════════════
// Bundled skill prompts (absorbed from Claude Code 2.1.88)
// ════════════════════════════════════════════════════════════════════════════

// ── simplify (CC src/skills/bundled/simplify.ts) ──
// Review changed code for reuse/quality/efficiency, then fix.
// AGENT_TOOL_NAME placeholder resolved to TriRLC's AgentTool name ("Agent").
const SIMPLIFY_PROMPT = `# Simplify: Code Review and Cleanup

Review all changed files for reuse, quality, and efficiency. Fix any issues found.

## Phase 1: Identify Changes

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If there are no git changes, review the most recently modified files that the user mentioned or that you edited earlier in this conversation.

## Phase 2: Launch Three Review Agents in Parallel

Use the Agent tool to launch all three agents concurrently in a single message. Pass each agent the full diff so it has the complete context.

### Agent 1: Code Reuse Review

For each change:

1. **Search for existing utilities and helpers** that could replace newly written code. Look for similar patterns elsewhere in the codebase — common locations are utility directories, shared modules, and files adjacent to the changed ones.
2. **Flag any new function that duplicates existing functionality.** Suggest the existing function to use instead.
3. **Flag any inline logic that could use an existing utility** — hand-rolled string manipulation, manual path handling, custom environment checks, ad-hoc type guards, and similar patterns are common candidates.

### Agent 2: Code Quality Review

Review the same changes for hacky patterns:

1. **Redundant state**: state that duplicates existing state, cached values that could be derived, observers/effects that could be direct calls
2. **Parameter sprawl**: adding new parameters to a function instead of generalizing or restructuring existing ones
3. **Copy-paste with slight variation**: near-duplicate code blocks that should be unified with a shared abstraction
4. **Leaky abstractions**: exposing internal details that should be encapsulated, or breaking existing abstraction boundaries
5. **Stringly-typed code**: using raw strings where constants, enums (string unions), or branded types already exist in the codebase
6. **Unnecessary JSX nesting**: wrapper Boxes/elements that add no layout value — check if inner component props (flexShrink, alignItems, etc.) already provide the needed behavior
7. **Unnecessary comments**: comments explaining WHAT the code does (well-named identifiers already do that), narrating the change, or referencing the task/caller — delete; keep only non-obvious WHY (hidden constraints, subtle invariants, workarounds)

### Agent 3: Efficiency Review

Review the same changes for efficiency:

1. **Unnecessary work**: redundant computations, repeated file reads, duplicate network/API calls, N+1 patterns
2. **Missed concurrency**: independent operations run sequentially when they could run in parallel
3. **Hot-path bloat**: new blocking work added to startup or per-request/per-render hot paths
4. **Recurring no-op updates**: state/store updates inside polling loops, intervals, or event handlers that fire unconditionally — add a change-detection guard so downstream consumers aren't notified when nothing changed. Also: if a wrapper function takes an updater/reducer callback, verify it honors same-reference returns (or whatever the "no change" signal is) — otherwise callers' early-return no-ops are silently defeated
5. **Unnecessary existence checks**: pre-checking file/resource existence before operating (TOCTOU anti-pattern) — operate directly and handle the error
6. **Memory**: unbounded data structures, missing cleanup, event listener leaks
7. **Overly broad operations**: reading entire files when only a portion is needed, loading all items when filtering for one

## Phase 3: Fix Issues

Wait for all three agents to complete. Aggregate their findings and fix each issue directly. If a finding is a false positive or not worth addressing, note it and move on — do not argue with the finding, just skip it.

When done, briefly summarize what was fixed (or confirm the code was already clean).
`;

// ── debug (CC src/skills/bundled/debug.ts, adapted) ──
// CC's version tails its own session debug log and references CC settings
// paths; both are CC-runtime-specific. TriRLC adaptation keeps the diagnostic
// workflow but targets the project's own logs and error output.
const DEBUG_PROMPT = `# Debug Skill

Help the user debug the issue they're encountering.

## Steps

1. **Restate the issue** in one sentence and form an initial hypothesis about which subsystem is involved.
2. **Gather evidence before theorizing further**:
   - Read the relevant source files (Read/Grep/Glob — not guesswork).
   - Look for existing logs, error output, or test failures the user pasted.
   - Reproduce with the smallest possible input if the issue is runnable.
3. **Bisect the failure domain**: instrument or inspect at the boundary where expected and actual behavior first diverge. Don't shotgun changes across the stack.
4. **Explain the root cause** in plain language: what state/assumption was wrong, and why the code path produced the observed symptom.
5. **Propose the minimal fix** — smallest change that addresses the root cause (not the symptom). Flag any nearby code with the same defect pattern.
6. **Verify**: name the exact command or check that proves the fix (test, build, manual run). If verification isn't possible from here, say so explicitly.

## Rules
- Evidence before fixes. Never propose a fix you haven't traced to a root cause.
- Prefer reading code over speculating about what it does.
- If the issue description is vague, ask one targeted clarifying question instead of guessing.
`;

// ── remember (CC src/skills/bundled/remember.ts, adapted) ──
// CC's version reviews auto-memory layers (ant-only feature). TriRLC has no
// auto-memory; adaptation reviews CLAUDE.md / CLAUDE.local.md hygiene.
const REMEMBER_PROMPT = `# Memory Review

## Goal
Review the project's memory files and produce a clear report of proposed changes, grouped by action type. Do NOT apply changes — present proposals for user approval.

## Steps

### 1. Gather all memory layers
Read CLAUDE.md and CLAUDE.local.md from the project root (if they exist).

**Success criteria**: You have the contents of all memory layers and can compare them.

### 2. Classify each entry
For each substantive entry, determine the best destination:

| Destination | What belongs there | Examples |
|---|---|---|
| **CLAUDE.md** | Project conventions and instructions for the AI that all contributors should follow | "use npm not bun", "API routes use kebab-case", "test command is npm test", "prefer functional style" |
| **CLAUDE.local.md** | Personal instructions specific to this user, not applicable to other contributors | "I prefer concise responses", "always explain trade-offs", "don't auto-commit", "run tests before committing" |

**Important distinctions:**
- These files contain instructions for the AI, not user preferences for external tools (editor theme, IDE keybindings, etc. don't belong)
- Workflow practices (PR conventions, merge strategies, branch naming) are ambiguous — ask the user whether they're personal or team-wide
- When unsure, ask rather than guess

**Success criteria**: Each entry has a proposed destination or is flagged as ambiguous.

### 3. Identify cleanup opportunities
Scan across all layers for:
- **Duplicates**: entries captured in both files → propose keeping only the correct layer
- **Outdated**: entries contradicted by current codebase reality (verify against the code) → propose updating
- **Conflicts**: contradictions between layers → propose resolution, noting which is more recent

**Success criteria**: All cross-layer issues identified.

### 4. Present the report
Output a structured report grouped by action type:
1. **Promotions** — entries to move, with destination and rationale
2. **Cleanup** — duplicates, outdated entries, conflicts to resolve
3. **Ambiguous** — entries where you need the user's input on destination
4. **No action needed** — brief note on entries that should stay put

**Success criteria**: User can review and approve/reject each proposal individually.

## Rules
- Present ALL proposals before making any changes
- Do NOT modify files without explicit user approval
- Do NOT create new files unless the target doesn't exist yet
- Ask about ambiguous entries — don't guess
`;

// ── P6: claude-api (prompt-only, CC equivalent) ──
// CC bundles 247KB embedded docs; TriRLC condenses to a focused prompt that
// guides the model to use WebFetch for the latest Anthropic API docs.
const CLAUDE_API_PROMPT = `# Claude API & Agent SDK Skill

You are helping the user build applications with the Anthropic Claude API and/or Agent SDK. Follow these guidelines:

## Core Principles

1. **Use the latest Claude models**: Default to the most capable and recent models. For high-complexity tasks use Claude Opus, for balanced use Claude Sonnet, for fast/lightweight use Claude Haiku.
2. **Use WebFetch for latest docs**: The Anthropic API docs are at https://docs.anthropic.com. Use WebFetch to pull the latest reference for specific features. Key pages:
   - Messages API: https://docs.anthropic.com/en/api/messages
   - Prompt Caching: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
   - Tool Use: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
   - Agent SDK: https://docs.anthropic.com/en/docs/agent-sdk
   - Streaming: https://docs.anthropic.com/en/api/messages-streaming
   - Error Codes: https://docs.anthropic.com/en/api/errors
   - Batch API: https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
   - Files API: https://docs.anthropic.com/en/docs/build-with-claude/files-api
3. **Use the client SDK when possible**: For Typescript, \`@anthropic-ai/sdk\`; for Python, \`anthropic\`. The SDK handles auth, retries, and streaming cleanly.
4. **Prompt caching**: Cache system messages and large tool definitions with \`"cache_control": {"type": "ephemeral"}\` on the last block. Cache breakpoints reduce cost significantly for long-running agents.

## Language-Specific Quickstart

### TypeScript/Node.js
\`\`\`typescript
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const msg = await client.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 4096,
  messages: [{ role: 'user', content: 'Hello' }],
});
\`\`\`

### Python
\`\`\`python
import anthropic
client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
message = client.messages.create(
    model="claude-sonnet-5",
    max_tokens=4096,
    messages=[{"role": "user", "content": "Hello"}],
)
\`\`\`

### Agent SDK (TypeScript)
\`\`\`typescript
import { ClaudeAgentClient } from '@anthropic-ai/claude-agent-sdk';
const agent = new ClaudeAgentClient({ model: 'claude-sonnet-5' });
\`\`\`

## Common Pitfalls
- \`max_tokens\` is REQUIRED for all API calls — without it you get a 400 error
- Tool use responses (\`tool_use\` blocks) require a matching \`tool_result\` user message
- Streaming: the final message event is \`message_stop\`, not \`message_delta\`
- Token counting: use the \`usage\` field in the response, not tokenizer libraries
- For multi-turn conversations, always include the full message history

## When to Use WebFetch
For any of the following, use WebFetch to get the latest docs:
- Specific SDK method signatures or parameters
- Pricing and model availability
- Rate limits and quota information
- New features not yet in these skill docs
- Framework-specific integration guides`;

// ── P6: keybindings (adapted for TriRLC, CC equivalent) ──
const KEYBINDINGS_PROMPT = `# TriCade Keybindings Reference

## Cursor Movement (in Input Box)

| Key | Action |
|-----|--------|
| Left / Right | Move cursor by one grapheme |
| Ctrl+Left / Ctrl+Right | Jump by word (Intl.Segmenter-based) |
| Alt+B / Alt+F | Jump by word (GNU Readline style) |
| Home | Start of current display line |
| End | End of current display line |
| Ctrl+Home | Start of file (first character) |
| Ctrl+End | End of file (last character) |
| Ctrl+A | Start of display line (Readline) |
| Ctrl+E | End of display line (Readline) |
| Ctrl+Up | Move up one display line (wrapped text) |
| Ctrl+Down | Move down one display line (wrapped text) |

## Text Editing

| Key | Action |
|-----|--------|
| Backspace | Delete character before cursor |
| Delete | Delete character after cursor |
| Alt+Backspace | Delete word before cursor |
| Alt+D | Delete word after cursor |
| Ctrl+K | Kill (cut) from cursor to end of line |
| Ctrl+U | Kill (cut) from cursor to start of line |
| Ctrl+W | Kill (cut) word before cursor |
| Ctrl+Y | Yank (paste) last killed text |
| Alt+Y | Yank-pop: cycle through kill ring (after Ctrl+Y) |

## History & Submit

| Key | Action |
|-----|--------|
| Up / Ctrl+P | Previous history entry |
| Down / Ctrl+N | Next history entry |
| Enter | Submit message |
| Shift+Enter | Insert newline (multi-line input) |
| Alt+Enter | Insert newline (multi-line input) |

## Vim Word Navigation

| Key | Action |
|-----|--------|
| w / b / e | Vim-style word movements (lowercase: words) |
| W / B / E | Vim-style WORD movements (uppercase: non-whitespace sequences) |

## Interaction Mode (when prompt is active)

| Key | Action |
|-----|--------|
| Up / Down | Navigate options |
| 1-9 | Select option by number |
| Enter | Confirm selection |
| Escape | Cancel / deny |

## Commands

| Command | Action |
|---------|--------|
| /help | Show all available commands |
| /exit | Exit TriCade |
| /init | Generate CLAUDE.md project guide |
| /clear | Clear message history |
| /model | Show or switch AI model |
| /status | Show session stats |
| /context | Show context usage |
| /cost | Show session cost estimate |
| /compact | Summarize conversation history |
| /sessions | List saved sessions |
| /agents | List available sub-agent types |
| /review | AI-driven PR review |
| /verbose | Toggle verbose mode |

## Shell Execution

Prefix a line with \`!\` to execute a shell command directly:
\`\`\`
! git status
! npm test
\`\`\`

## Notes
- All keybindings work in the input box at the bottom of the screen
- Kill ring stores up to 10 items; Ctrl+Y pastes the most recent
- Multi-line input: use Shift+Enter or Alt+Enter, or end a line with \\ then Enter
- Paste detection: pastes >100 chars with newlines are truncated to 10K characters`;

// ── P6: loremIpsum (CC direct copy, ant-only gate removed) ──
// Verified 1-token words (tested via API token counting)
const LOREM_ONE_TOKEN_WORDS = [
  'the', 'a', 'an', 'I', 'you', 'he', 'she', 'it', 'we', 'they',
  'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his', 'its', 'our',
  'this', 'that', 'what', 'who', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could',
  'may', 'might', 'must', 'shall', 'should', 'make', 'made', 'get', 'got', 'go',
  'went', 'come', 'came', 'see', 'saw', 'know', 'take', 'think', 'look', 'want',
  'use', 'find', 'give', 'tell', 'work', 'call', 'try', 'ask', 'need', 'feel',
  'seem', 'leave', 'put', 'time', 'year', 'day', 'way', 'man', 'thing', 'life',
  'hand', 'part', 'place', 'case', 'point', 'fact', 'good', 'new', 'first', 'last',
  'long', 'great', 'little', 'own', 'other', 'old', 'right', 'big', 'high', 'small',
  'large', 'next', 'early', 'young', 'few', 'public', 'bad', 'same', 'able',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'from', 'by', 'about',
  'like', 'through', 'over', 'before', 'between', 'under', 'since', 'without',
  'and', 'or', 'but', 'if', 'than', 'because', 'as', 'until', 'while', 'so',
  'though', 'both', 'each', 'when', 'where', 'why', 'how', 'not', 'now', 'just',
  'more', 'also', 'here', 'there', 'then', 'only', 'very', 'well', 'back', 'still',
  'even', 'much', 'too', 'such', 'never', 'again', 'most', 'once', 'off', 'away',
  'down', 'out', 'up', 'test', 'code', 'data', 'file', 'line', 'text', 'word',
  'number', 'system', 'program', 'set', 'run', 'value', 'name', 'type', 'state',
  'end', 'start',
];

function generateLoremIpsum(targetTokens: number): string {
  let tokens = 0;
  let result = '';
  while (tokens < targetTokens) {
    const sentenceLength = 10 + Math.floor(Math.random() * 11);
    for (let i = 0; i < sentenceLength && tokens < targetTokens; i++) {
      const word = LOREM_ONE_TOKEN_WORDS[Math.floor(Math.random() * LOREM_ONE_TOKEN_WORDS.length)];
      result += word;
      tokens++;
      if (i === sentenceLength - 1 || tokens >= targetTokens) {
        result += '. ';
      } else {
        result += ' ';
      }
    }
    if (tokens < targetTokens && Math.random() < 0.2) {
      result += '\n\n';
    }
  }
  return result.trim();
}

// ════════════════════════════════════════════════════════════════════════════
// Registration
// ════════════════════════════════════════════════════════════════════════════

let bundledInitialized = false;

/**
 * Register all built-in bundled skills (idempotent).
 * Called once at daemon startup; results flow into SkillTool via
 * src/index.ts wiring.
 */
export function initBundledSkills(): void {
  if (bundledInitialized) return;
  bundledInitialized = true;

  registerBundledSkill({
    name: 'simplify',
    description: 'Review changed code for reuse, quality, and efficiency, then fix any issues found.',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = SIMPLIFY_PROMPT;
      if (args) {
        prompt += `\n\n## Additional Focus\n\n${args}`;
      }
      return prompt;
    },
  });

  registerBundledSkill({
    name: 'debug',
    description: 'Diagnose an issue: gather evidence, find the root cause, propose and verify a minimal fix.',
    allowedTools: ['Read', 'Grep', 'Glob'],
    argumentHint: '[issue description]',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = DEBUG_PROMPT;
      if (args) {
        prompt += `\n\n## Issue Description\n\n${args}`;
      }
      return prompt;
    },
  });

  registerBundledSkill({
    name: 'remember',
    description: 'Review CLAUDE.md / CLAUDE.local.md and propose promotions, cleanup, and conflict resolutions across memory layers.',
    whenToUse: 'Use when the user wants to review, organize, or clean up project memory files (CLAUDE.md).',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = REMEMBER_PROMPT;
      if (args) {
        prompt += `\n\n## Additional context from user\n\n${args}`;
      }
      return prompt;
    },
  });

  // ── P6: claude-api (prompt-only adaptation, CC equivalent) ──
  // CC bundles 247KB of embedded docs via Bun text loader; TriRLC uses a
  // condensed prompt that guides the model to use WebFetch for latest docs.
  registerBundledSkill({
    name: 'claude-api',
    description:
      'Build apps with the Claude API or Anthropic SDK.\n' +
      'TRIGGER when: code imports `anthropic`/`@anthropic-ai/sdk`/`claude_agent_sdk`, or user asks to use Claude API, Anthropic SDKs, or Agent SDK.\n' +
      'DO NOT TRIGGER when: code imports `openai`/other AI SDK, general programming, or ML/data-science tasks.',
    allowedTools: ['Read', 'Grep', 'Glob', 'WebFetch'],
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = CLAUDE_API_PROMPT;
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`;
      }
      return prompt;
    },
  });

  // ── P6: keybindings (adapted for TriRLC, CC equivalent) ──
  registerBundledSkill({
    name: 'keybindings',
    description:
      'Use when the user wants to know keyboard shortcuts, customize keybindings, or learn navigation commands. Examples: "keyboard shortcuts", "how do I move the cursor", "keybindings reference".',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = KEYBINDINGS_PROMPT;
      if (args) {
        prompt += `\n\n## User Request\n\n${args}`;
      }
      return prompt;
    },
  });

  // ── P6: loremIpsum (direct copy from CC, ant-only gate removed) ──
  registerBundledSkill({
    name: 'lorem-ipsum',
    description:
      'Generate filler text for long context testing. Specify token count as argument (e.g., /lorem-ipsum 50000). Outputs approximately the requested number of tokens.',
    argumentHint: '[token_count]',
    userInvocable: true,
    async getPromptForCommand(args) {
      const parsed = parseInt(args);
      if (args && (isNaN(parsed) || parsed <= 0)) {
        return 'Invalid token count. Please provide a positive number (e.g., /lorem-ipsum 10000).';
      }
      const targetTokens = parsed || 10000;
      const cappedTokens = Math.min(targetTokens, 500_000);
      if (cappedTokens < targetTokens) {
        return `Requested ${targetTokens} tokens, but capped at 500,000 for safety.\n\n${generateLoremIpsum(cappedTokens)}`;
      }
      return generateLoremIpsum(cappedTokens);
    },
  });
}
