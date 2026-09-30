// ── TriRLC TodoWrite tool (P2-Batch1-#2 + P2-Batch2 CC-fidelity) ──
// CC-equivalent todo task manager. Supports TaskCreate/TaskList/TaskUpdate operations.
// Allows AI assistants to create, list, and update todo tasks.
// P2-Batch2: Added verification nudge from CC TodoWriteTool.ts (当3+任务全完成且无验证步骤时提示)
// P1: Added CC TaskCreateTool full compatibility (activeForm, metadata, blocks, blockedBy)

import { resolve, isAbsolute } from 'node:path';
import { register as registerTool } from '@tricompany/agent-core';

// In-memory task store (simple MVP implementation)
const taskStore = new Map<string, Task>();

interface Task {
  id: string;
  subject: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'low' | 'medium' | 'high';
  // P1: CC TaskCreateTool compatibility fields
  activeForm?: string;
  owner?: string;
  blocks: string[];
  blockedBy: string[];
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

// Generate unique task ID
function generateTaskId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

// Format task for display
function formatTask(task: Task): string {
  const statusSymbol = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '→' : '○';
  const priority = task.priority ? ` [${task.priority.toUpperCase()}]` : '';
  const blocked = task.blockedBy.length > 0 ? ` (blocked by: ${task.blockedBy.join(', ')})` : '';
  return `  ${statusSymbol} ${task.id}${priority} — ${task.subject}${blocked}`;
}

/** Normalize a blocks/blockedBy arg into a clean string array. */
function toIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim());
}

// ── TodoWrite tool ──
// Main tool that handles all todo operations via action parameter
export function registerTodoWriteTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'TodoWrite',
        description:
          'Create, list, and update todo tasks. Use this to track progress on multi-step tasks.\n' +
          'Actions:\n' +
          '- create: Create a new task with subject and description\n' +
          '- list: List all tasks with their status\n' +
          '- update: Update task status or mark as complete\n\n' +
          'Usage:\n' +
          '- Create: { action: "create", subject: "Fix auth bug", description: "...", priority: "high" }\n' +
          '- List: { action: "list" }\n' +
          '- Update: { action: "update", taskId: "task_abc", status: "completed" }',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'list', 'update'],
              description: 'The action to perform',
            },
            taskId: {
              type: 'string',
              description: 'Task ID (for update action)',
            },
            subject: {
              type: 'string',
              description: 'Brief task title (for create action)',
            },
            description: {
              type: 'string',
              description: 'Detailed task description (for create action)',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Task priority (for create action)',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
              description: 'New task status (for update action)',
            },
            blocks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that cannot start until this task completes (for create action)',
            },
            blockedBy: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that must complete before this task can start (for create action)',
            },
          },
          required: ['action'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const action = args.action as string;

      try {
        switch (action) {
          case 'create': {
            const subject = args.subject as string;
            const description = args.description as string;
            const priority = args.priority as 'low' | 'medium' | 'high' | undefined;

            if (!subject || !subject.trim()) {
              return JSON.stringify({ error: 'subject is required for create action' });
            }

            const task: Task = {
              id: generateTaskId(),
              subject: subject.trim(),
              description: description?.trim() || '',
              status: 'pending',
              priority,
              activeForm: undefined,
              owner: undefined,
              blocks: toIdList(args.blocks),
              blockedBy: toIdList(args.blockedBy),
              metadata: undefined,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            };

            taskStore.set(task.id, task);

            return JSON.stringify({
              ok: true,
              task,
              message: `Task created: ${task.id}`,
            });
          }

          case 'list': {
            const tasks = Array.from(taskStore.values()).sort((a, b) => b.updatedAt - a.updatedAt);
            const formatted = tasks.map(formatTask).join('\n');

            return JSON.stringify({
              ok: true,
              count: tasks.length,
              tasks: tasks.map(t => ({
                id: t.id,
                subject: t.subject,
                status: t.status,
                priority: t.priority,
                blocks: t.blocks,
                blockedBy: t.blockedBy,
              })),
              formatted: formatted || 'No tasks yet.',
            });
          }

          case 'update': {
            const taskId = args.taskId as string;
            const newStatus = args.status as 'pending' | 'in_progress' | 'completed' | undefined;

            if (!taskId || !taskId.trim()) {
              return JSON.stringify({ error: 'taskId is required for update action' });
            }

            const task = taskStore.get(taskId);
            if (!task) {
              return JSON.stringify({ error: `Task not found: ${taskId}` });
            }

            if (newStatus) {
              task.status = newStatus;
              task.updatedAt = Date.now();
              taskStore.set(taskId, task);
            }

            // ── CC verification nudge: 检查是否3+任务全完成且无验证步骤 ──
            const allTasks = Array.from(taskStore.values());
            const allDone = allTasks.length >= 3 && allTasks.every(t => t.status === 'completed');
            const hasVerification = allTasks.some(t => /verif/i.test(t.subject) || /verif/i.test(t.description));
            let verificationNudge = '';
            if (allDone && !hasVerification) {
              verificationNudge = '\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step. Before writing your final summary, run verification to ensure correctness.';
            }

            return JSON.stringify({
              ok: true,
              task,
              message: `Task updated: ${taskId}${verificationNudge}`,
              verificationNudgeNeeded: allDone && !hasVerification,
            });
          }

          default:
            return JSON.stringify({ error: `Unknown action: ${action}` });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: msg });
      }
    },
  );
}

// ── Legacy TaskCreate/TaskList/TaskUpdate compatibility ──
// These are separate tools that map to TodoWrite actions for CC compatibility
// P1: TaskCreate updated to match CC TaskCreateTool full spec
export function registerTaskTools(): void {
  // TaskCreate - create a new task (CC-compatible with activeForm, metadata, blocks, blockedBy)
  registerTool(
    {
      type: 'function',
      function: {
        name: 'TaskCreate',
        description: 'Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.\n\n## When to Use This Tool\n\nUse this tool proactively in these scenarios:\n\n- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions\n- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations\n- Plan mode - When using plan mode, create a task list to track the work\n- User explicitly requests todo list - When the user directly asks you to use the todo list\n- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)\n- After receiving new instructions - Immediately capture user requirements as tasks\n- When you start working on a task - Mark it as in_progress BEFORE beginning work\n- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation\n\n## When NOT to Use This Tool\n\nSkip using this tool when:\n- There is only a single, straightforward task\n- The task is trivial and tracking it provides no organizational benefit\n- The task can be completed in less than 3 trivial steps\n- The task is purely conversational or informational\n\n## Task Fields\n\n- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")\n- **description**: What needs to be done\n- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.',
        parameters: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              description: 'A brief title for the task',
            },
            description: {
              type: 'string',
              description: 'What needs to be done',
            },
            activeForm: {
              type: 'string',
              description: 'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
            },
            metadata: {
              type: 'object',
              description: 'Arbitrary metadata to attach to the task',
            },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high'],
              description: 'Task priority (TriRLC extension, not in CC)',
            },
            blocks: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that cannot start until this task completes',
            },
            blockedBy: {
              type: 'array',
              items: { type: 'string' },
              description: 'Task IDs that must complete before this task can start',
            },
          },
          required: ['subject', 'description'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const subject = args.subject as string;
      const description = args.description as string;
      const activeForm = args.activeForm as string | undefined;
      const metadata = args.metadata as Record<string, unknown> | undefined;
      const priority = args.priority as 'low' | 'medium' | 'high' | undefined;
      const blocks = toIdList(args.blocks);
      const blockedBy = toIdList(args.blockedBy);

      if (!subject || !subject.trim()) {
        return JSON.stringify({ error: 'subject is required' });
      }
      if (!description || !description.trim()) {
        return JSON.stringify({ error: 'description is required' });
      }

      const task: Task = {
        id: generateTaskId(),
        subject: subject.trim(),
        description: description.trim(),
        activeForm,
        status: 'pending',
        priority,
        owner: undefined,
        blocks,
        blockedBy,
        metadata,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      taskStore.set(task.id, task);

      // P3-fix: reverse-fill blocks — if this task is blockedBy [t1], add this
      // task's id to each blocker's blocks[] so the dependency is bidirectional.
      for (const blockerId of blockedBy) {
        const blocker = taskStore.get(blockerId);
        if (blocker && !blocker.blocks.includes(task.id)) {
          blocker.blocks = [...blocker.blocks, task.id];
          blocker.updatedAt = Date.now();
          taskStore.set(blockerId, blocker);
        }
      }

      return JSON.stringify({
        ok: true,
        task,
      });
    },
  );

  // TaskList - list all tasks
  registerTool(
    {
      type: 'function',
      function: {
        name: 'TaskList',
        description: 'List all tasks with their current status.',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    },
    async () => {
      const tasks = Array.from(taskStore.values()).sort((a, b) => b.updatedAt - a.updatedAt);
      return JSON.stringify({
        ok: true,
        tasks,
        formatted: tasks.map(formatTask).join('\n') || 'No tasks yet.',
      });
    },
  );

  // TaskUpdate - update task status
  registerTool(
    {
      type: 'function',
      function: {
        name: 'TaskUpdate',
        description: 'Update the status or details of an existing task.',
        parameters: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: 'ID of the task to update',
            },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'deleted'],
              description: 'New status for the task',
            },
            subject: {
              type: 'string',
              description: 'Updated subject/title',
            },
            description: {
              type: 'string',
              description: 'Updated description',
            },
          },
          required: ['taskId'],
        },
      },
    },
    async (args: Record<string, unknown>) => {
      const taskId = args.taskId as string;
      const status = args.status as 'pending' | 'in_progress' | 'completed' | 'deleted' | undefined;
      const subject = args.subject as string | undefined;
      const description = args.description as string | undefined;

      if (!taskId || !taskId.trim()) {
        return JSON.stringify({ error: 'taskId is required' });
      }

      const task = taskStore.get(taskId);
      if (!task) {
        return JSON.stringify({ error: `Task not found: ${taskId}` });
      }

      if (status === 'deleted') {
        taskStore.delete(taskId);
        return JSON.stringify({ ok: true, message: `Task deleted: ${taskId}` });
      }

      if (status) task.status = status;
      if (subject) task.subject = subject.trim();
      if (description) task.description = description.trim();
      task.updatedAt = Date.now();
      taskStore.set(taskId, task);

      return JSON.stringify({ ok: true, task });
    },
  );
}
