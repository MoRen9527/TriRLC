// 补窗 2026-10-11 从闸单测（CTO 稿 a00045f1 §四.6 七形态·纯函数直喂零 stub）：
// following 镜像 / holding 持有 / ×3 unknown / 告警一次每段 / staleness 传染 /
// unknown 放行+hard skip / soft 放行 —— 外加 timer dispatch 插点（power_gate_hard）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialFollowerState,
  transitionFollower,
  followerGateHard,
  followerHealthz,
  isStale,
} from '../src/power-follower.js';
import { createCronTimerState, executeJobCoreWithTimeout, type CronTimerDeps, type CronStoreLike } from '../src/cron/timer.js';
import type { CronJob } from '../src/cron/types.js';

const NOW = Date.parse('2026-10-11T15:00:00Z');
const FRESH = new Date(NOW - 30_000).toISOString(); // 30s 前=新鲜
const STALE = new Date(NOW - 6 * 60_000).toISOString(); // 6min 前=超 5min 窗

function ok(gate: 'none' | 'soft' | 'hard', lastReadAt: string | null = FRESH) {
  return { kind: 'poll-ok' as const, gate, lastReadAt, nowMs: NOW };
}
const fail = { kind: 'poll-fail' as const };

describe('从闸状态机（稿 §2.3 七形态）', () => {
  test('following 镜像：poll-ok 直接镜像主闸 gate（hard/none 双向）', () => {
    const s0 = initialFollowerState();
    const t1 = transitionFollower(s0, ok('hard'));
    assert.equal(t1.state.mode, 'following');
    assert.equal(t1.state.gate, 'hard');
    assert.equal(t1.alert, null);
    const t2 = transitionFollower(t1.state, ok('none'));
    assert.equal(t2.state.mode, 'following');
    assert.equal(t2.state.gate, 'none');
  });

  test('holding 持有：poll 失败不即时 fail-open（持有 lastKnownGate）', () => {
    const t1 = transitionFollower(initialFollowerState(), ok('hard'));
    const t2 = transitionFollower(t1.state, fail);
    assert.equal(t2.state.mode, 'holding');
    assert.equal(t2.state.gate, 'hard'); // 8713 崩≠电量恢复——持有照停
    assert.equal(t2.alert, null);
    // 从未 poll 成功过（gate=null）→ holding/none 语义
    const t3 = transitionFollower(initialFollowerState(), fail);
    assert.equal(t3.state.gate, 'none');
  });

  test('×3 unknown：连续 3 次 poll 失败 → unknown + urgent 告警', () => {
    const t1 = transitionFollower(initialFollowerState(), ok('hard'));
    const t2 = transitionFollower(t1.state, fail);
    const t3 = transitionFollower(t2.state, fail);
    assert.equal(t3.state.mode, 'holding'); // 前 2 次仍 holding
    const t4 = transitionFollower(t3.state, fail);
    assert.equal(t4.state.mode, 'unknown');
    assert.equal(t4.state.gate, null);
    assert.match(t4.alert ?? '', /unreachable/);
  });

  test('告警一次每段：段内不重复；恢复 following 后再退化=新段再告', () => {
    const t1 = transitionFollower(initialFollowerState(), ok('soft'));
    const f1 = transitionFollower(t1.state, fail);
    const f2 = transitionFollower(f1.state, fail);
    const f3 = transitionFollower(f2.state, fail); // 首入 unknown=段首
    assert.match(f3.alert ?? '', /unreachable/);
    const f4 = transitionFollower(f3.state, fail); // 段内第 4 次
    assert.equal(f4.alert, null);
    const rec = transitionFollower(f4.state, ok('soft')); // 恢复 following
    assert.equal(rec.state.mode, 'following');
    const f5 = transitionFollower(rec.state, fail);
    const f6 = transitionFollower(f5.state, fail);
    const f7 = transitionFollower(f6.state, fail); // 新退化段
    assert.match(f7.alert ?? '', /unreachable/);
  });

  test('staleness 传染：陈旧 lastReadAt 或缺位 → unknown + 告警（前置件未落窗形态）', () => {
    const t1 = transitionFollower(initialFollowerState(), ok('hard'));
    // lastReadAt 在位但超 5min 窗
    const t2 = transitionFollower(t1.state, ok('hard', STALE));
    assert.equal(t2.state.mode, 'unknown');
    assert.match(t2.alert ?? '', /stale/);
    // lastReadAt 缺位（8713 投影未落窗期形态）→ 传染 unknown
    const t3 = transitionFollower(t1.state, ok('hard', null));
    assert.equal(t3.state.mode, 'unknown');
    // unknown 中 poll 成功且新鲜 → 直接回 following（无滞回）
    const t4 = transitionFollower(t3.state, ok('soft'));
    assert.equal(t4.state.mode, 'following');
    assert.equal(t4.state.gate, 'soft');
    // staleness 不计入 pollFailures（网络成功）；pollFailures 语义=连续网络失败
    assert.equal(t3.state.consecutivePollFailures, 0);
  });

  test('unknown 放行 + hard skip（dispatch 谓词语义）', () => {
    assert.equal(followerGateHard({ mode: 'unknown', gate: null, consecutivePollFailures: 3, segmentAlerted: true }), false);
    assert.equal(followerGateHard({ mode: 'following', gate: 'hard', consecutivePollFailures: 0, segmentAlerted: false }), true);
    // holding hard 持有照停（稿：holding → 按持有 gate 语义执行）
    assert.equal(followerGateHard({ mode: 'holding', gate: 'hard', consecutivePollFailures: 1, segmentAlerted: true }), true);
  });

  test('soft 放行（soft=COO 人工面语义，非 daemon 硬闸）', () => {
    assert.equal(followerGateHard({ mode: 'following', gate: 'soft', consecutivePollFailures: 0, segmentAlerted: false }), false);
    assert.equal(followerGateHard({ mode: 'following', gate: 'none', consecutivePollFailures: 0, segmentAlerted: false }), false);
    assert.equal(followerGateHard(initialFollowerState()), false); // 初始 unknown 放行
  });
});

describe('从闸投影与辅助面', () => {
  test('healthz 四键投影：state 复合串/lastGateSeen unknown 置 null/pollFailures 透传', () => {
    const h1 = followerHealthz({ mode: 'following', gate: 'hard', consecutivePollFailures: 0, segmentAlerted: false }, '2026-10-11T15:00:00Z');
    assert.deepEqual(h1, { state: 'following/hard', lastPollAt: '2026-10-11T15:00:00Z', lastGateSeen: 'hard', pollFailures: 0 });
    const h2 = followerHealthz({ mode: 'unknown', gate: null, consecutivePollFailures: 3, segmentAlerted: true }, null);
    assert.equal(h2.state, 'unknown');
    assert.equal(h2.lastGateSeen, null);
    assert.equal(h2.pollFailures, 3);
  });

  test('isStale：缺位/不可解析/超窗三态 true；新鲜 false', () => {
    assert.equal(isStale(null, NOW, 300_000), true);
    assert.equal(isStale('not-a-date', NOW, 300_000), true);
    assert.equal(isStale(STALE, NOW, 300_000), true);
    assert.equal(isStale(FRESH, NOW, 300_000), false);
  });
});

// ── timer dispatch 插点（稿 §四.2·shouldRunJob 之后 command 分支之前）──

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'follower-gate-job',
    name: 'follower-gate-test',
    schedule: { kind: 'every', everyMs: 60_000 },
    systemPrompt: 'test',
    roleId: 'r1',
    enabled: true,
    state: 'idle',
    createdAt: '2026-10-11T00:00:00Z',
    updatedAt: '2026-10-11T00:00:00Z',
    runCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

function makeDeps(shouldDispatchNewJobs?: () => boolean): CronTimerDeps {
  return {
    store: {
      listJobs: () => [],
      getJob: () => undefined,
      addJob: () => { throw new Error('unused'); },
      removeJob: () => false,
      updateJob: () => null,
      updateJobRun: () => {},
      addExecutionLog: () => {},
      getExecutionLogs: () => [],
      saveCronStore: () => {},
    } as unknown as CronStoreLike,
    sessionStore: {
      createSession: () => {},
      saveMessages: () => {},
      updateSessionStatus: () => {},
    },
    cwd: process.cwd(),
    isRoleActive: () => Promise.resolve(true),
    shouldDispatchNewJobs,
  };
}

describe('timer dispatch gate（从闸插点）', () => {
  test('hard 闸 → 新派发 skipped power_gate_hard（在跑不中断语义=仅 gate 拒新派发）', async () => {
    const state = createCronTimerState();
    const result = await executeJobCoreWithTimeout(state, makeDeps(() => false), makeJob(), 5_000);
    assert.equal(result.status, 'skipped');
    assert.equal(result.error, 'power_gate_hard');
  });

  test('非 hard（soft/none/unknown/未注入）→ 放行不回归', async () => {
    // command job 截断：gate 放行后走 executeCommand 立即回（零模型调用）。
    const cmdJob = makeJob({ command: 'exit 0', roleId: undefined } as Partial<CronJob>);
    const state = createCronTimerState();
    const r1 = await executeJobCoreWithTimeout(state, makeDeps(() => true), cmdJob, 5_000);
    assert.notEqual(r1.status, 'skipped'); // 放行（command 分支 ok）
    const r2 = await executeJobCoreWithTimeout(state, makeDeps(undefined), cmdJob, 5_000);
    assert.notEqual(r2.status, 'skipped'); // 缺省=零旁路影响
  });
});
