// 补窗 2026-10-11 件B 单测（TriMLC cc52c89 同构回流）：executeJobCoreWithTimeout
// race 缺口根治验证。缺口（预研实锚）：jobPromise 在 timeout 先 settle 后滞后
// reject → 裸 promise 的 rejection 无人接 = unhandledRejection（修复前=crash 源）。
// 修复=guardedJob .catch 吸收转 error 结果。本文件三例：滞后 reject 被吸收（核心）
// +滞后 resolve 状态面零变+gate 拒绝路径不回归。独立文件（避免与其他 cron 测试的
// 全局 mock 互相干扰）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createCronTimerState, executeJobCoreWithTimeout, type CronTimerDeps, type CronStoreLike } from '../src/cron/timer.js';
import type { CronJob } from '../src/cron/types.js';

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'race-guard-job',
    name: 'race-guard-test',
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

function makeDeps(isRoleActive: (roleId: string) => Promise<boolean>): CronTimerDeps {
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
    isRoleActive,
  };
}

describe('补窗件B：race 缺口（滞后 rejection 吸收）', () => {
  test('滞后 reject 被 guardedJob 吸收：race 返回 timeout·零 rejection 传播', async () => {
    // process 层 rejection 计数：修复生效=guardedJob.catch 先吸收，rejection
    // 永不到 process 层=计数 0；修复失效=裸 rejection 传播=计数 1。
    let propagated = 0;
    const onRejection = () => { propagated += 1; };
    process.on('unhandledRejection', onRejection);
    try {
      const deps = makeDeps(() => new Promise<boolean>((_, rej) =>
        setTimeout(() => rej(new Error('late rejection from gate')), 50),
      ));
      const state = createCronTimerState();
      const result = await executeJobCoreWithTimeout(state, deps, makeJob(), 10);
      assert.equal(result.status, 'timeout');
      // 等滞后 rejection 发生窗（50ms reject + 余量）
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(propagated, 0, 'rejection must be absorbed by guardedJob, not propagate');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('滞后 resolve（非 reject）状态面零变：timeout 先到仍返回 timeout', async () => {
    const deps = makeDeps(() => new Promise<boolean>((res) =>
      setTimeout(() => res(true), 50),
    ));
    const state = createCronTimerState();
    const result = await executeJobCoreWithTimeout(state, deps, makeJob(), 10);
    assert.equal(result.status, 'timeout');
  });

  test('gate 拒绝路径不回归：isRoleActive=false → skipped', async () => {
    const deps = makeDeps(() => Promise.resolve(false));
    const state = createCronTimerState();
    const result = await executeJobCoreWithTimeout(state, deps, makeJob(), 5_000);
    assert.equal(result.status, 'skipped');
    assert.match(result.error ?? '', /owner_not_active/);
  });
});
