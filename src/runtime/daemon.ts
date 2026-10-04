// ── Local Runtime Daemon (agent-core powered) ──
// Long-running daemon that:
// 1. Manages local node lifecycle (heartbeat, registration)
// 2. Watches for incoming tasks and orchestrates planner → agentLoop execution
// 3. Tracks task state transitions via TaskRuntime

import type { TriRLCEnv } from '../config/env.js';
import { LocalNode } from '../local-node/node.js';
import { LocalPlanner, type TaskPlan } from '../planner/planner.js';
import { TaskRuntime } from '../task-runtime/runtime.js';

export interface DaemonTask {
  taskId: string;
  description: string;
  systemPrompt?: string;
}

export class LocalRuntimeDaemon {
  private node: LocalNode;
  private planner: LocalPlanner;
  private running = false;
  private tasks = new Map<string, TaskRuntime>();

  constructor(private readonly env: TriRLCEnv) {
    this.node = new LocalNode(env);
    this.planner = new LocalPlanner(env);
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    this.running = true;
    await this.node.heartbeat();
    console.log(`[trilc] daemon started for ${this.env.nodeId}`);
  }

  async stop(): Promise<void> {
    this.running = false;
    console.log(`[trilc] daemon stopped (${this.tasks.size} task(s) tracked)`);
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ── Task execution ──

  /** Submit a task for agent-driven execution. Returns a TaskRuntime tracker. */
  submitTask(task: DaemonTask): TaskRuntime {
    const runtime = new TaskRuntime();
    this.tasks.set(task.taskId, runtime);

    // Fire-and-forget execution (caller uses TaskRuntime for status)
    this.executeTask(task, runtime).catch((err) => {
      console.error(`[trilc] task ${task.taskId} failed`, err);
      runtime.markFailed();
    });

    return runtime;
  }

  /** Execute a single task step through the local node's agentLoop. */
  async executeStep(
    description: string,
    systemPrompt?: string,
  ): Promise<{ success: boolean; events: number }> {
    let eventCount = 0;
    const messages = [{ role: 'user' as const, content: description }];

    try {
      for await (const _event of this.node.runAgent({
        systemPrompt: systemPrompt ?? 'You are a local task executor. Complete the given task using available tools.',
        messages,
      })) {
        eventCount++;
      }
      return { success: true, events: eventCount };
    } catch {
      return { success: false, events: eventCount };
    }
  }

  // ── Accessors ──

  getNode(): LocalNode {
    return this.node;
  }

  getPlanner(): LocalPlanner {
    return this.planner;
  }

  getTask(taskId: string): TaskRuntime | undefined {
    return this.tasks.get(taskId);
  }

  /** Decompose a task description into a plan using the local planner. */
  async planTask(description: string): Promise<TaskPlan> {
    const tools = this.node.getAvailableTools();
    return this.planner.decomposeTask(description, tools);
  }

  // ── Private ──

  private async executeTask(
    task: DaemonTask,
    runtime: TaskRuntime,
  ): Promise<void> {
    runtime.markRunning();

    try {
      const plan = this.planner.createPlan(task.description);

      for (const step of plan) {
        if (!this.running) break;
        const result = await this.executeStep(step, task.systemPrompt);
        if (!result.success) {
          runtime.markFailed();
          return;
        }
      }

      runtime.markSucceeded();
    } catch (err) {
      console.error(`[trilc] task ${task.taskId} execution error`, err);
      runtime.markFailed();
    }
  }
}