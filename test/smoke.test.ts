// ── TriRLC Phase C3 Smoke Tests ──
// Uses Node.js built-in test runner (node --test).
// Run: npx tsx --test test/smoke.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { readEnv } from '../src/config/env.js';
import { LocalNode } from '../src/local-node/node.js';
import { LocalPlanner } from '../src/planner/planner.js';
import { LocalRuntimeDaemon } from '../src/runtime/daemon.js';
import { TaskRuntime } from '../src/task-runtime/runtime.js';

const env = readEnv();

describe('TaskRuntime', () => {
  it('transitions queued → running → succeeded', () => {
    const rt = new TaskRuntime();
    assert.strictEqual(rt.getState(), 'queued');
    assert.strictEqual(rt.durationMs, null);

    rt.markRunning();
    assert.strictEqual(rt.getState(), 'running');

    rt.markSucceeded();
    assert.strictEqual(rt.getState(), 'succeeded');
    assert.ok(typeof rt.durationMs === 'number');
  });

  it('transitions queued → running → failed', () => {
    const rt = new TaskRuntime();
    rt.markRunning();
    rt.markFailed();
    assert.strictEqual(rt.getState(), 'failed');
    assert.ok(typeof rt.durationMs === 'number');
  });
});

describe('LocalNode', () => {
  it('initializes with idle state', () => {
    const node = new LocalNode(env);
    assert.strictEqual(node.isRunning, false);
    assert.ok(node.nodeId.length > 0);
  });

  it('getAvailableTools returns string array', () => {
    const node = new LocalNode(env);
    const tools = node.getAvailableTools();
    assert.ok(Array.isArray(tools));
  });

  it('describeNode returns expected shape', () => {
    const node = new LocalNode(env);
    const desc = node.describeNode();
    assert.strictEqual(desc.nodeId, env.nodeId);
    assert.strictEqual(desc.state, 'idle');
    assert.ok(Array.isArray(desc.tools));
  });

  it('heartbeat resolves', async () => {
    const node = new LocalNode(env);
    await node.heartbeat();
  });
});

describe('LocalPlanner', () => {
  it('createPlan returns string array', () => {
    const planner = new LocalPlanner(env);
    const plan = planner.createPlan('test');
    assert.ok(Array.isArray(plan));
    assert.ok(plan.length > 0);
  });
});

describe('LocalRuntimeDaemon', () => {
  it('start and stop transitions', async () => {
    const daemon = new LocalRuntimeDaemon(env);
    assert.strictEqual(daemon.isRunning, false);

    await daemon.start();
    assert.strictEqual(daemon.isRunning, true);

    await daemon.stop();
    assert.strictEqual(daemon.isRunning, false);
  });

  it('getNode and getPlanner return instances', () => {
    const daemon = new LocalRuntimeDaemon(env);
    assert.ok(daemon.getNode() instanceof LocalNode);
    assert.ok(daemon.getPlanner() instanceof LocalPlanner);
  });

  it('submitTask returns TaskRuntime tracker', () => {
    const daemon = new LocalRuntimeDaemon(env);
    const rt = daemon.submitTask({ taskId: 'test-1', description: 'test' });
    assert.ok(rt instanceof TaskRuntime);
  });
});
