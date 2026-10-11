// ── F-3+ addJob next_run_at fix（S3 通道维护波，2026-10-10）──
// 根因链：addJob INSERT 无 next_run_at 列 → armTimer 过滤集
// (j.enabled && j.nextRunAt) 把新 job 永远滤掉 →「POST 201 但永不触发」。
// 修法（法 B）：INSERT 后立即走与 updateJob 同路 recompute 补值。
// 防漏写回归锚（判据卷 cto-s3-criteria-20261008.md §缺口1）：
//   新建 job 后 sqlite 只读查 next_run_at 值面非空。
//
// Run: npx tsx --test test/cron-addjob-nextrun.test.ts
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCronStore } from '../src/cron/store.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'trilc-cron-nextrun-'));
const stores: Array<ReturnType<typeof createCronStore>> = [];
after(() => {
  for (const s of stores) {
    try { s.db.close(); } catch { /* already closed */ }
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeStore() {
  const s = createCronStore(join(tmpDir, `cron-${Math.random().toString(36).slice(2)}.db`));
  stores.push(s);
  return s;
}

/** sqlite 值面直读 next_run_at（防「内存对象有、落库无」伪绿） */
function rawNextRunAt(store: ReturnType<typeof createCronStore>, id: string): string | null {
  const row = store.db.prepare('SELECT next_run_at FROM cron_jobs WHERE id = ?').get(id) as
    { next_run_at: string | null } | undefined;
  return row?.next_run_at ?? null;
}

describe('F-3+ addJob recompute next_run_at (法 B)', () => {
  it('every 档：addJob 后 sqlite next_run_at 非空（防漏写回归锚）', () => {
    const store = makeStore();
    const job = store.addJob({
      name: 'every-job', schedule: { kind: 'every', everyMs: 120_000 },
      systemPrompt: 't', enabled: true,
    });
    const raw = rawNextRunAt(store, job.id);
    assert.ok(raw, 'sqlite next_run_at 不得为 NULL（F-3+ 回归锚）');
    const ts = Date.parse(raw!);
    assert.ok(!Number.isNaN(ts), 'next_run_at 为合法 ISO 时刻');
    assert.ok(ts > Date.now() - 5_000, 'next_run_at 指向未来');
  });

  it('cron expr 档：addJob 后 sqlite next_run_at 非空', () => {
    const store = makeStore();
    const job = store.addJob({
      name: 'expr-job', schedule: { kind: 'cron', expr: '30 9 * * *', tz: 'Asia/Shanghai' },
      systemPrompt: 't', enabled: true,
    });
    assert.ok(rawNextRunAt(store, job.id), 'cron expr 档 next_run_at 不得为 NULL');
  });

  it('disabled job 同样补值（与 update 路径 recompute 语义一致）', () => {
    const store = makeStore();
    const job = store.addJob({
      name: 'disabled-job', schedule: { kind: 'every', everyMs: 60_000 },
      systemPrompt: 't', enabled: false,
    });
    assert.ok(rawNextRunAt(store, job.id), 'disabled job 的 next_run_at 同样落值');
  });

  it('内存读回面 nextRunAt 带出（timer 加载集可见）', () => {
    const store = makeStore();
    const job = store.addJob({
      name: 'mem-job', schedule: { kind: 'every', everyMs: 60_000 },
      systemPrompt: 't', enabled: true,
    });
    const got = store.getJob(job.id);
    assert.ok(got?.nextRunAt, 'getJob().nextRunAt 非空（armTimer 过滤集含新 job 前提）');
    const listed = store.listJobs().find((j) => j.id === job.id);
    assert.ok(listed?.nextRunAt, 'listJobs() 同样带出');
  });

  it('冷载（新 store 同 db 重开）后 next_run_at 仍在（持久化面）', () => {
    const dbPath = join(tmpDir, `cron-reopen-${Math.random().toString(36).slice(2)}.db`);
    const s1 = createCronStore(dbPath);
    stores.push(s1);
    const job = s1.addJob({
      name: 'persist-job', schedule: { kind: 'every', everyMs: 60_000 },
      systemPrompt: 't', enabled: true,
    });
    const expect = rawNextRunAt(s1, job.id);
    assert.ok(expect);
    s1.db.close();
    const s2 = createCronStore(dbPath);
    stores.push(s2);
    assert.equal(rawNextRunAt(s2, job.id), expect, '重开后 sqlite 值面一致');
    assert.ok(s2.getJob(job.id)?.nextRunAt, '重开内存读回面一致');
    s2.db.close();
  });

  it('坏 schedule（everyMs < 1s）不炸 addJob，next_run_at 保持 NULL（catch 分支）', () => {
    const store = makeStore();
    const job = store.addJob({
      name: 'bad-sched', schedule: { kind: 'every', everyMs: 500 },
      systemPrompt: 't', enabled: true,
    });
    assert.ok(job.id, 'addJob 不因 parse 失败抛出');
    assert.equal(rawNextRunAt(store, job.id), null, 'parse 失败保持 NULL（旧行为语义）');
  });

  it('PATCH {schedule} 同值幂等：next_run_at 保持非空且重排（验收锚 A4）', () => {
    const store = makeStore();
    const job = store.addJob({
      name: 'idem-job', schedule: { kind: 'every', everyMs: 60_000 },
      systemPrompt: 't', enabled: true,
    });
    const before = rawNextRunAt(store, job.id);
    assert.ok(before);
    const patched = store.updateJob(job.id, { schedule: { kind: 'every', everyMs: 60_000 } });
    assert.ok(patched, 'updateJob 命中');
    const after = rawNextRunAt(store, job.id);
    assert.ok(after, 'PATCH 后 next_run_at 保持非空');
    assert.ok(after! >= before!, '重排不早于原值（同值 croner 语义）');
    assert.ok(store.getJob(job.id)?.nextRunAt, '内存面同步');
  });
});
