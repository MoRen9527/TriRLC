// ── Local Planner (agent-core powered) ──
// Uses sub-agent spawn from @tricompany/agent-core for task decomposition.
// Replaces the hardcoded string-array stub with real agent-driven planning.

import {
  spawnAgentComplete,
  type AgentDefinition,
  type SpawnConfig,
  type SubAgentEvent,
} from '@tricompany/agent-core';
import type { TriRLCEnv } from '../config/env.js';

export interface TaskPlan {
  taskId: string;
  steps: TaskStep[];
}

export interface TaskStep {
  id: string;
  description: string;
  agentType: string;
  tools: string[];
  dependsOn?: string[];
}

const PLANNER_AGENT: AgentDefinition = {
  name: 'task-planner',
  description: 'Decompose complex tasks into ordered subtask plans',
  systemPrompt: `You are a task planner. Given a task description and available tools, decompose it into ordered subtask steps.

Respond with a JSON object:
{
  "steps": [
    { "id": "step-1", "description": "...", "agentType": "general-purpose", "tools": ["read_file", "glob_search"] },
    ...
  ]
}`,
  tools: ['*'],
  tier: 'main',
};

export class LocalPlanner {
  constructor(private readonly env: TriRLCEnv) {}

  /** Decompose a task using sub-agent. Falls back to simple plan on error. */
  async decomposeTask(
    taskDescription: string,
    availableTools: string[],
  ): Promise<TaskPlan> {
    const task = `Decompose this task into ordered steps:\n\nTask: ${taskDescription}\nAvailable tools: ${availableTools.join(', ')}`;

    const config: SpawnConfig = {
      agent: PLANNER_AGENT,
      task,
      maxTurns: 5,
    };

    try {
      const events: SubAgentEvent[] = await spawnAgentComplete(config);
      return this.parsePlanOutput(events, taskDescription);
    } catch (err) {
      console.warn('[trilc/planner] sub-agent planning failed, using fallback', err);
      return this.fallbackPlan(taskDescription);
    }
  }

  /** Simple plan for sync use (backward compat with existing callers). */
  createPlan(taskType: string): string[] {
    return [`analyze:${taskType}`, 'execute', 'collect-artifacts'];
  }

  // ── Private ──

  private parsePlanOutput(
    events: SubAgentEvent[],
    taskDescription: string,
  ): TaskPlan {
    // Collect all message-type events and join their content
    const messages = events
      .filter((e) => e.type === 'message' && e.data)
      .map((e) => (e.data as { content?: string }).content ?? '')
      .join('\n');

    if (!messages) return this.fallbackPlan(taskDescription);

    try {
      // Try to extract JSON from the response
      const jsonMatch = messages.match(/\{[\s\S]*"steps"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          return {
            taskId: `plan_${Date.now()}`,
            steps: parsed.steps.map((s: Record<string, unknown>, i: number) => ({
              id: String(s.id ?? `step-${i + 1}`),
              description: String(s.description ?? ''),
              agentType: String(s.agentType ?? 'general-purpose'),
              tools: Array.isArray(s.tools) ? s.tools : ['*'],
              dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : undefined,
            })),
          };
        }
      }
    } catch {
      // JSON parse failed — use fallback
    }

    return this.fallbackPlan(taskDescription);
  }

  private fallbackPlan(taskDescription: string): TaskPlan {
    return {
      taskId: `plan_${Date.now()}`,
      steps: [
        {
          id: 'analyze',
          description: `Analyze: ${taskDescription}`,
          agentType: 'general-purpose',
          tools: ['read_file', 'glob_search'],
        },
        {
          id: 'execute',
          description: 'Execute implementation',
          agentType: 'general-purpose',
          tools: ['*'],
        },
        {
          id: 'verify',
          description: 'Verify results',
          agentType: 'general-purpose',
          tools: ['read_file', 'shell_exec'],
        },
      ],
    };
  }
}