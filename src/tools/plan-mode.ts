// ── Plan Mode Tools (P6) ──
// Simplified plan mode: EnterPlanMode / ExitPlanMode tools that toggle
// a shared flag. While in plan mode, the AI receives a system prompt
// instructing it not to write or edit files.
//
// CC equivalent: EnterPlanModeTool.ts + ExitPlanModeV2Tool.ts — but
// stripped of team leader approval, plan file persistence, auto-mode
// classifier, and transcript classifier hooks.
//
// Architecture:
//   planModeActive (module-level flag) → checked by permission rules
//   EnterPlanMode sets it, ExitPlanMode clears it
//   Tool restriction: enforced via system prompt + permission gating
//
// C8: DUAL PROTECTION with `plan` permission mode
// ─────────────────────────────────────────────
// TriRLC now has TWO plan-mode enforcement layers:
//   1. `plan` permission mode (agent-core decision pipeline Step 7):
//      Blocks all write/mutate tools at the permission engine level.
//      Deterministic, non-interactive, applies to the entire session.
//   2. This EnterPlanMode/ExitPlanMode tool pair (module-level flag):
//      Blocks tools at the `deps.checkToolPermission` callback level
//      (see buildPlanModeDeps() in app.ts). Model-driven — the AI
//      decides when to enter/exit.
//
// Retention decision: KEEP both layers as defense-in-depth.
// - The `plan` permission mode is a CLI-level session guard (user says
//   "--permission-mode plan" → no writes possible regardless of AI behavior).
// - The EnterPlanMode/ExitPlanMode tools are an AI-driven planning workflow
//   (AI can self-impose read-only mode during planning, exit when approved).
// - Together they provide double-lock: even if the AI exits plan mode early,
//   the CLI-level `plan` permission mode STILL blocks writes.
//
// Risk: if `plan` permission mode AND EnterPlanMode are BOTH active,
// redundant tool_blocked events are possible (permission engine blocks
// first, then buildPlanModeDeps blocks second). This is intentional
// defense-in-depth, not a bug.

import { register as registerTool } from '@tricompany/agent-core';

// ── Shared plan mode state ──

let planModeActive = false;
let planModeTimer: ReturnType<typeof setTimeout> | null = null;

export function isPlanModeActive(): boolean {
  return planModeActive;
}

export function resetPlanMode(): void {
  if (planModeTimer) {
    clearTimeout(planModeTimer);
    planModeTimer = null;
  }
  planModeActive = false;
}

// ── Plan mode tool whitelist (P7) ──
// When plan mode is active, only tools in this allowlist may execute.
// Any tool NOT in this set is intercepted by deps.checkToolPermission
// and yields a tool_blocked event, preventing write/shell during planning.
// Design: deny-by-default — new dangerous tools are blocked until explicitly added.
export const PLAN_MODE_WHITELIST: ReadonlySet<string> = new Set([
  // File read family
  'Read',
  'Glob',
  'Grep',
  'LS',
  // Plan mode lifecycle
  'EnterPlanMode',
  'ExitPlanMode',
  // Task planning
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TodoWrite',
  // User interaction
  'ask_user_question',
  // Skill invocation
  'skill',
  // Teammate communication
  'SendMessage',
  // Sub-agent exploration
  'AgentTool',
  // MCP read operations
  'MCPTool',
]);

// ── Plan mode tool constants (A级 from CC) ──

const ENTER_PLAN_MODE_TOOL_NAME = 'EnterPlanMode';
const EXIT_PLAN_MODE_TOOL_NAME = 'ExitPlanMode';

// ── EnterPlanMode prompt (A级 from CC EnterPlanModeTool/prompt.ts) ──

const ENTER_PLAN_MODE_PROMPT = `Use this tool proactively when you're about to start a non-trivial implementation task. Getting user sign-off on your approach before writing code prevents wasted effort and ensures alignment. This tool transitions you into plan mode where you can explore the codebase and design an implementation approach for user approval.

## When to Use This Tool

**Prefer using EnterPlanMode** for implementation tasks unless they're simple. Use it when ANY of these conditions apply:

1. **New Feature Implementation**: Adding meaningful new functionality
2. **Multiple Valid Approaches**: The task can be solved in several different ways
3. **Code Modifications**: Changes that affect existing behavior or structure
4. **Architectural Decisions**: The task requires choosing between patterns or technologies
5. **Multi-File Changes**: The task will likely touch more than 2-3 files
6. **Unclear Requirements**: You need to explore before understanding the full scope
7. **User Preferences Matter**: The implementation could reasonably go multiple ways

## When NOT to Use This Tool

Only skip EnterPlanMode for simple tasks:
- Single-line or few-line fixes (typos, obvious bugs, small tweaks)
- Adding a single function with clear requirements
- Tasks where the user has given very specific, detailed instructions
- Pure research/exploration tasks (use the Agent tool with explore agent instead)

## What Happens in Plan Mode

In plan mode, you'll:
1. Thoroughly explore the codebase using Glob, Grep, and Read tools
2. Understand existing patterns and architecture
3. Design an implementation approach
4. Present your plan to the user for approval
5. Exit plan mode with ExitPlanMode when ready to implement

## Important Notes

- This tool REQUIRES user approval — they must consent to entering plan mode
- If unsure whether to use it, err on the side of planning
- Users appreciate being consulted before significant changes are made`;

// ── ExitPlanMode prompt (A级 from CC ExitPlanModeTool/prompt.ts) ──

const EXIT_PLAN_MODE_PROMPT = `Use this tool when you are in plan mode and have finished writing your plan and are ready for user approval.

## How This Tool Works
- You should present your plan in your response
- This tool signals that you're done planning and ready for the user to review and approve
- The user will see your plan and decide whether to approve it

## When to Use This Tool
IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you're gathering information, searching files, reading files or in general trying to understand the codebase — do NOT use this tool.

## Before Using This Tool
Ensure your plan is complete and unambiguous. Once your plan is finalized, use THIS tool to request approval.

## Examples

1. Initial task: "Search for and understand the implementation of vim mode in the codebase" — Do NOT use this tool because you are not planning the implementation steps of a task.
2. Initial task: "Help me implement yank mode for vim" — Use this tool after you have finished planning the implementation steps.
3. Initial task: "Add a new feature to handle user authentication" — If unsure about auth method, use AskUserQuestion first, then use this tool after clarifying the approach.`;

// ── Registration ──

const PLAN_MODE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function registerPlanModeTools(): void {
  // ── EnterPlanMode ──
  registerTool(
    {
      type: 'function',
      function: {
        name: ENTER_PLAN_MODE_TOOL_NAME,
        description:
          'Requests permission to enter plan mode for complex tasks requiring exploration and design. ' +
          'In plan mode, you should explore the codebase and design an approach before writing code.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    async (_args: Record<string, unknown>) => {
      if (planModeActive) {
        return JSON.stringify({
          message: 'Already in plan mode. Continue exploring and designing your approach.',
        });
      }
      planModeActive = true;
      // Clear any existing timer and set a 30-minute TTL
      if (planModeTimer) {
        clearTimeout(planModeTimer);
      }
      planModeTimer = setTimeout(() => {
        planModeActive = false;
        planModeTimer = null;
        console.warn('[plan-mode] Plan mode auto-exited after 30-minute TTL timeout');
      }, PLAN_MODE_TTL_MS);
      return JSON.stringify({
        message:
          'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
        planModeInstructions:
          'In plan mode, you should:\n' +
          '1. Thoroughly explore the codebase to understand existing patterns\n' +
          '2. Identify similar features and architectural approaches\n' +
          '3. Consider multiple approaches and their trade-offs\n' +
          '4. Use AskUserQuestion if you need to clarify the approach\n' +
          '5. Design a concrete implementation strategy\n' +
          '6. When ready, use ExitPlanMode to present your plan for approval\n\n' +
          'Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.',
      });
    },
  );

  // ── ExitPlanMode ──
  registerTool(
    {
      type: 'function',
      function: {
        name: EXIT_PLAN_MODE_TOOL_NAME,
        description:
          'Prompts the user to exit plan mode and start coding. Use this when you have finished your plan and need approval to implement.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    async (_args: Record<string, unknown>) => {
      if (!planModeActive) {
        return JSON.stringify({
          message:
            'You are not in plan mode. This tool is only for exiting plan mode after writing a plan. Continue with implementation.',
        });
      }
      if (planModeTimer) {
        clearTimeout(planModeTimer);
        planModeTimer = null;
      }
      planModeActive = false;
      return JSON.stringify({
        message:
          'User has approved your plan. You can now start coding. Start with updating your todo list if applicable.',
      });
    },
  );
}
