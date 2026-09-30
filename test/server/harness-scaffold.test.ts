// ── TC-001 harness scaffold tests (tc001-harness-scaffold HS-3) ──
// Covers the three execution-persistence mechanisms implemented in
// src/server/app.ts:
//   FR-1  task_plan progress anchor injection (per-round, change-detected)
//   FR-2  end_turn judgment discipline (continue_on_incomplete + DONE verdict)
//   FR-3  progress reminder every N turns
//   + backward compatibility: no harness fields → parseHarnessOptions returns
//     null so endpoints keep the native agentLoop (zero behavior change)
//   + stream contract: exactly ONE loop_end reaches downstream consumers
//     (SSE converters terminate on the first loop_end), usage merged.
//
// The wrapper is tested through dependency injection: a scripted loopFactory
// stands in for agent-core's agentLoop and records what messages each inner
// invocation received.

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parseHarnessOptions, runHarnessAgentLoop } from '../../src/server/app.js';
import type { AgentEvent, AgentLoopOptions } from '@tricompany/agent-core';
import type { Message } from 'trimodel';

// ── Event builders (inner invocation always starts its own turn at 1) ──

const LOOP_START = { type: 'loop_start', model: 'stub-model', turn: 1 } as unknown as AgentEvent;

function reqStart(): AgentEvent {
  return { type: 'request_start', turn: 1, model: 'stub-model' } as unknown as AgentEvent;
}

function asstToolCall(id: string, args: string): AgentEvent {
  return {
    type: 'assistant_message',
    turn: 1,
    content: 'working on it',
    tool_calls: [{ id, type: 'function', function: { name: 'shell_exec', arguments: args } }],
  } as unknown as AgentEvent;
}

function toolResult(id: string, content: string): AgentEvent {
  return { type: 'tool_result', turn: 1, tool_call_id: id, content } as unknown as AgentEvent;
}

function asstText(text: string): AgentEvent {
  return { type: 'assistant_message', turn: 1, content: text } as unknown as AgentEvent;
}

const STUB_USAGE = {
  calls: 1,
  tokens: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  byModel: {},
  partial: false,
};

/** Inner loop hit maxTurns(=1) after executing tools → results await feedback. */
function endMaxTurns(): AgentEvent {
  return { type: 'loop_end', reason: 'max_turns', usageSummary: STUB_USAGE } as unknown as AgentEvent;
}

/** Model returned end_turn with no tool calls. */
function endDone(finishReason = 'stop'): AgentEvent {
  return {
    type: 'loop_end',
    reason: 'done',
    finish_reason: finishReason,
    usageSummary: STUB_USAGE,
  } as unknown as AgentEvent;
}

// ── Scripted loop factory ──

interface RecordedInvocation {
  messages: Message[];
  options: AgentLoopOptions;
}

/**
 * Each entry of `rounds` is one inner agentLoop invocation; it receives the
 * reconstructed message history the wrapper is about to send and returns the
 * events that invocation emits. Extra invocations fail loudly.
 */
function makeScriptedLoop(rounds: Array<(msgs: Message[]) => AgentEvent[]>) {
  const invocations: RecordedInvocation[] = [];
  let call = 0;
  const factory = (opts: AgentLoopOptions): AsyncGenerator<AgentEvent> =>
    (async function* () {
      const idx = call++;
      invocations.push({ messages: opts.messages ?? [], options: opts });
      if (idx >= rounds.length) {
        throw new Error(`unexpected extra invocation #${idx + 1}`);
      }
      for (const e of rounds[idx](opts.messages ?? [])) yield e;
    })();
  return { factory, invocations };
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** The user-role messages visible to a given invocation (i.e. injections). */
function userTexts(msgs: Message[]): string[] {
  return msgs.filter((m) => m.role === 'user').map((m) => String(m.content ?? ''));
}

function countIn(texts: string[], needle: string): number {
  return texts.filter((t) => t.includes(needle)).length;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('parseHarnessOptions (backward compatibility gate)', () => {
  it('returns null when body has none of the harness fields', () => {
    assert.strictEqual(parseHarnessOptions(null), null);
    assert.strictEqual(parseHarnessOptions(undefined), null);
    assert.strictEqual(parseHarnessOptions({}), null);
    // A realistic plain request must NOT activate the harness path.
    assert.strictEqual(
      parseHarnessOptions({ model: 'tmv-deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], stream: true }),
      null,
    );
  });

  it('parses task_plan.items / currentFocus', () => {
    const h = parseHarnessOptions({
      task_plan: {
        items: [
          { id: '1', description: 'audit cron module', status: 'done' },
          { id: '2', description: 'write report', status: 'in_progress' },
        ],
        currentFocus: '2',
      },
    });
    assert.ok(h && h.task_plan, 'task_plan should activate harness');
    assert.strictEqual(h.task_plan!.items!.length, 2);
    assert.strictEqual(h.task_plan!.items![0].status, 'done');
    assert.strictEqual(h.task_plan!.currentFocus, '2');
  });

  it('ignores malformed entries; empty items do not activate task_plan', () => {
    assert.strictEqual(parseHarnessOptions({ task_plan: { items: [] } }), null);
    const h = parseHarnessOptions({ task_plan: { items: [{ description: 'no id here' }, 'junk', null] } });
    assert.strictEqual(h, null, 'items without ids are dropped; nothing left to activate');
  });

  it('parses FR-2/FR-3 numeric & boolean fields with type guards', () => {
    const h = parseHarnessOptions({
      continue_on_incomplete: true,
      incomplete_check_prompt: 'custom check',
      continue_max_rounds: 7.9,
      continue_prompt: 'legacy alias',
      progress_reminder_interval: 5,
      progress_reminder_template: 'T{turn}',
    });
    assert.ok(h);
    assert.strictEqual(h.continue_on_incomplete, true);
    assert.strictEqual(h.incomplete_check_prompt, 'custom check');
    assert.strictEqual(h.continue_max_rounds, 7); // floored
    assert.strictEqual(h.continue_prompt, 'legacy alias');
    assert.strictEqual(h.progress_reminder_interval, 5);
    assert.strictEqual(h.progress_reminder_template, 'T{turn}');

    // Invalid values are ignored, not coerced into activation.
    assert.strictEqual(parseHarnessOptions({ continue_on_incomplete: 'yes' }), null);
    assert.strictEqual(parseHarnessOptions({ continue_max_rounds: -3 }), null);
    assert.strictEqual(parseHarnessOptions({ progress_reminder_interval: 0 }), null);
  });
});

describe('FR-1 task_plan progress anchor injection', () => {
  it('injects the checklist before feeding round-2 context, exactly once', async () => {
    const plan = {
      items: [
        { id: '1', description: 'audit TriMMC cron module', status: 'done' },
        { id: '2', description: 'write audit report', status: 'pending' },
      ],
      currentFocus: '2',
    };
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstToolCall('c1', '{"cmd":"ls"}'), toolResult('c1', 'files...'), endMaxTurns()],
      () => [LOOP_START, reqStart(), asstToolCall('c2', '{"cmd":"cat report.md"}'), toolResult('c2', 'ok'), endMaxTurns()],
      () => [LOOP_START, reqStart(), asstText('report written') , endDone()],
    ]);

    const events = await collect(
      runHarnessAgentLoop({ model: 'stub-model', maxTurns: 25 }, { task_plan: plan }, factory),
    );

    assert.strictEqual(invocations.length, 3);

    // Invocation 2 must already see the anchor (injected at boundary 1→2).
    const anchorNeedle = '[SYSTEM: Task progress — completed: #1 audit TriMMC cron module';
    assert.strictEqual(countIn(userTexts(invocations[1].messages), anchorNeedle), 1, 'anchor present in round 2');
    // currentFocus renders as the "in progress" item; nothing remains pending.
    assert.ok(userTexts(invocations[1].messages).some((t) => t.includes('in progress: #2 write audit report')));
    assert.ok(userTexts(invocations[1].messages).some((t) => t.includes('remaining: none.')));
    assert.ok(userTexts(invocations[1].messages).every((t) => t.includes('Continue with the next incomplete item.')));

    // Plan snapshot unchanged → no duplicate injection at later boundaries.
    assert.strictEqual(
      countIn(userTexts(invocations[2].messages), '[SYSTEM: Task progress'),
      1,
      'anchor injected once, not repeated',
    );

    // Stream contract: intermediate max_turns loop_end swallowed; single final done.
    const loopEnds = events.filter((e) => e.type === 'loop_end');
    assert.strictEqual(loopEnds.length, 1);
    assert.strictEqual((loopEnds[0] as { reason: string }).reason, 'done');
  });

  it('does not inject when all items are done (model may end naturally)', async () => {
    const plan = {
      items: [
        { id: '1', description: 'step one', status: 'done' },
        { id: '2', description: 'step two', status: 'done' },
      ],
    };
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstText('everything complete'), endDone()],
    ]);
    const events = await collect(
      runHarnessAgentLoop({ model: 'stub-model', maxTurns: 25 }, { task_plan: plan }, factory),
    );
    assert.strictEqual(invocations.length, 1, 'single invocation — no revival');
    assert.strictEqual(countIn(userTexts(invocations[0].messages), 'Task progress'), 0);
    const loopEnds = events.filter((e) => e.type === 'loop_end');
    assert.strictEqual(loopEnds.length, 1);
    assert.strictEqual((loopEnds[0] as { reason: string }).reason, 'done');
  });
});

describe('FR-2 end_turn judgment discipline', () => {
  it('intercepts a bare end_turn, injects the default self-check, honors DONE', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstText('I think I am finished.'), endDone()],
      (msgs) => {
        // The check prompt must be the last thing appended after round 1.
        const lastUser = userTexts(msgs).at(-1) ?? '';
        assert.ok(lastUser.includes('你结束了回合但任务可能尚未完成'), 'default Chinese self-check injected');
        assert.ok(lastUser.includes('回复 DONE'), 'self-check asks for DONE verdict');
        return [LOOP_START, reqStart(), asstText('DONE'), endDone()];
      },
    ]);

    const events = await collect(
      runHarnessAgentLoop(
        { model: 'stub-model', maxTurns: 25 },
        { continue_on_incomplete: true },
        factory,
      ),
    );

    assert.strictEqual(invocations.length, 2, 'DONE short-circuits — no third invocation');
    const continues = events.filter((e) => e.type === 'continue_round');
    assert.strictEqual(continues.length, 1);
    const loopEnds = events.filter((e) => e.type === 'loop_end');
    assert.strictEqual(loopEnds.length, 1);
    assert.strictEqual((loopEnds[0] as { reason: string }).reason, 'done');
  });

  it('custom incomplete_check_prompt takes precedence over legacy alias and default', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstText('stopping early'), endDone()],
      (msgs) => {
        const lastUser = userTexts(msgs).at(-1) ?? '';
        assert.strictEqual(lastUser, 'CUSTOM-CHECK');
        return [LOOP_START, reqStart(), asstText('DONE'), endDone()];
      },
    ]);
    await collect(
      runHarnessAgentLoop(
        { model: 'stub-model', maxTurns: 25 },
        { continue_on_incomplete: true, incomplete_check_prompt: 'CUSTOM-CHECK', continue_prompt: 'LEGACY' },
        factory,
      ),
    );
    assert.strictEqual(invocations.length, 2);
  });

  it('respects continue_max_rounds budget then returns naturally', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstText('not done yet 1'), endDone()],
      () => [LOOP_START, reqStart(), asstText('not done yet 2'), endDone()],
      () => {
        throw new Error('judgment budget exhausted — should not re-enter');
      },
    ]);
    const events = await collect(
      runHarnessAgentLoop(
        { model: 'stub-model', maxTurns: 25 },
        { continue_on_incomplete: true, continue_max_rounds: 1 },
        factory,
      ),
    );
    assert.strictEqual(invocations.length, 2);
    assert.strictEqual(events.filter((e) => e.type === 'continue_round').length, 1);
    const loopEnds = events.filter((e) => e.type === 'loop_end');
    assert.strictEqual(loopEnds.length, 1);
    assert.strictEqual((loopEnds[0] as { reason: string }).reason, 'done');
  });

  it('never revives an ended conversation when continue_on_incomplete is off', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstText('finished for real'), endDone()],
    ]);
    const events = await collect(runHarnessAgentLoop({ model: 'stub-model', maxTurns: 25 }, {}, factory));
    assert.strictEqual(invocations.length, 1);
    assert.strictEqual(events.filter((e) => e.type === 'continue_round').length, 0);
  });
});

describe('FR-3 progress reminder injection', () => {
  it('injects the default reminder at interval boundaries only while continuing', async () => {
    const { factory, invocations } = makeScriptedLoop([
      // Turn 1 (tool round). Boundary: globalTurn=1 → 1%2≠0 → no reminder.
      () => [LOOP_START, reqStart(), asstToolCall('c1', '{}'), toolResult('c1', 'r1'), endMaxTurns()],
      // Turn 2 (tool round). Boundary: globalTurn=2 → due, continuation happens.
      () => [LOOP_START, reqStart(), asstToolCall('c2', '{}'), toolResult('c2', 'r2'), endMaxTurns()],
      // Turn 3: natural end.
      () => [LOOP_START, reqStart(), asstText('done with the survey'), endDone()],
    ]);

    const events = await collect(
      runHarnessAgentLoop(
        { model: 'stub-model', maxTurns: 25 },
        { progress_reminder_interval: 2 },
        factory,
      ),
    );

    assert.strictEqual(invocations.length, 3);
    assert.strictEqual(countIn(userTexts(invocations[1].messages), '[PROGRESS REMINDER]'), 0, 'turn 1 boundary: not due');

    const reminderTexts = userTexts(invocations[2].messages).filter((t) => t.includes('[PROGRESS REMINDER]'));
    assert.strictEqual(reminderTexts.length, 1, 'turn 2 boundary: reminder attached to the ongoing continuation');
    assert.ok(reminderTexts[0].includes('[PROGRESS REMINDER] Turn 2/25'));
    assert.ok(reminderTexts[0].includes('Completed steps this session: 2.'));
    assert.strictEqual(events.filter((e) => e.type === 'loop_end').length, 1);
  });

  it('supports custom templates with {turn}/{maxTurns}/{completedSteps}', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstToolCall('c1', '{}'), toolResult('c1', 'r1'), endMaxTurns()],
      () => [LOOP_START, reqStart(), asstToolCall('c2', '{}'), toolResult('c2', 'r2'), endMaxTurns()],
      () => [LOOP_START, reqStart(), asstText('wrap up'), endDone()],
    ]);
    await collect(
      runHarnessAgentLoop(
        { model: 'stub-model', maxTurns: 10 },
        { progress_reminder_interval: 2, progress_reminder_template: 'REMAIN {turn}-{maxTurns}-{completedSteps}' },
        factory,
      ),
    );
    assert.ok(userTexts(invocations[2].messages).includes('REMAIN 2-10-2'));
  });

  it('zero injection below the interval (short tasks unaffected)', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstText('quick answer'), endDone()],
    ]);
    await collect(
      runHarnessAgentLoop({ model: 'stub-model', maxTurns: 25 }, { progress_reminder_interval: 10 }, factory),
    );
    assert.strictEqual(invocations.length, 1);
    assert.strictEqual(countIn(userTexts(invocations[0].messages), 'PROGRESS REMINDER'), 0);
  });
});

describe('wrapper mechanics (stream contract & history reconstruction)', () => {
  it('reconstructs tool_blocked results so the rebuilt history stays provider-valid', async () => {
    const blocked = { type: 'tool_blocked', turn: 1, tool_name: 'Bash', reason: 'denied by policy' } as unknown as AgentEvent;
    const { factory, invocations } = makeScriptedLoop([
      // NOTE: agent-core emits tool_blocked with the SAME tool name as the
      // originating tool_call — the stub keeps them consistent ('Bash').
      () => [LOOP_START, reqStart(), { ...asstToolCall('cb1', '{"cmd":"rm -rf /"}'), tool_calls: [{ id: 'cb1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"rm -rf /"}' } }] } as unknown as AgentEvent, blocked, endMaxTurns()],
      (msgs) => {
        const toolMsgs = msgs.filter((m) => m.role === 'tool');
        assert.strictEqual(toolMsgs.length, 1, 'blocked call must still produce a tool receipt');
        assert.strictEqual(toolMsgs[0].tool_call_id, 'cb1', 'receipt id matches the assistant tool_use id');
        assert.ok(String(toolMsgs[0].content).includes('blocked'));
        return [LOOP_START, reqStart(), asstText('acknowledged the denial'), endDone()];
      },
    ]);
    await collect(
      runHarnessAgentLoop({ model: 'stub-model', maxTurns: 25 }, { continue_on_incomplete: false }, factory),
    );
    assert.strictEqual(invocations.length, 2);
  });

  it('merges usage across inner restarts into the single final loop_end', async () => {
    const { factory } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstToolCall('u1', '{}'), toolResult('u1', 'r'), endMaxTurns()],
      () => [LOOP_START, reqStart(), asstText('final'), endDone()],
    ]);
    const events = await collect(runHarnessAgentLoop({ model: 'stub-model', maxTurns: 25 }, {}, factory));
    const last = events.at(-1) as { type: string; usageSummary?: { calls: number; tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } };
    assert.strictEqual(last.type, 'loop_end');
    assert.strictEqual(last.usageSummary!.calls, 2);
    assert.deepStrictEqual(
      last.usageSummary!.tokens,
      { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    );
  });

  it('stops issuing new turns once the global turn budget is exhausted', async () => {
    const { factory, invocations } = makeScriptedLoop([
      () => [LOOP_START, reqStart(), asstToolCall('b1', '{}'), toolResult('b1', 'r'), endMaxTurns()],
      () => {
        throw new Error('budget spent — no further invocation allowed');
      },
    ]);
    const events = await collect(
      runHarnessAgentLoop({ model: 'stub-model', maxTurns: 1 }, {}, factory),
    );
    assert.strictEqual(invocations.length, 1);
    const loopEnds = events.filter((e) => e.type === 'loop_end');
    assert.strictEqual(loopEnds.length, 1);
    assert.strictEqual((loopEnds[0] as { reason: string }).reason, 'max_turns');
  });

  it('combines plan anchor + check prompt + reminder in one user message when all fire', async () => {
    const plan = {
      items: [{ id: '1', description: 'only step', status: 'in_progress' }],
      currentFocus: '1',
    };
    const { factory, invocations } = makeScriptedLoop([
      // Turn 1 executes tools AND ends with tool round; turn 2 boundary has both fr2? No—
      // fr2 fires only on end_turn. Here: tool round continues, anchor + reminder ride along.
      () => [LOOP_START, reqStart(), asstToolCall('m1', '{}'), toolResult('m1', 'r'), endMaxTurns()],
      (msgs) => {
        const injected = userTexts(msgs).filter(
          (t) => t.includes('[SYSTEM: Task progress') || t.includes('[PROGRESS REMINDER]'),
        );
        assert.strictEqual(injected.length, 1, 'anchor+reminder merged into ONE message');
        assert.ok(injected[0].includes('[SYSTEM: Task progress'));
        assert.ok(injected[0].includes('[PROGRESS REMINDER] Turn 1/25'));
        return [LOOP_START, reqStart(), asstText('finishing'), endDone()];
      },
    ]);
    await collect(
      runHarnessAgentLoop(
        { model: 'stub-model', maxTurns: 25 },
        { task_plan: plan, progress_reminder_interval: 1 },
        factory,
      ),
    );
    assert.strictEqual(invocations.length, 2);
  });
});
