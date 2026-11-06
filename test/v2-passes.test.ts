// ── N7 Passes 调度环+status 联动自测门九案（形三 α · 设计卷 ec79feb7d §二·门①裁 c8544a1e7）──
// 1 泵消费链（kick→dispatch→handler）2 coalesce 并发合并双槽 3 health error→ready
// 恢复（pump 链 rejection 面·evaluateDue 抛触发——handler 失败走 Effects 内部
// 退避两分注）4 closing 面+stop/start 收口 5 status busy 6 status idle
// 7 零联动（人名 actor 席名未命中）8 status 跨 reload 持久（硬门①同族）
// 9 兼容面（deps.seats 缺省 undefined 零害·N4 组合零改）。
// 裁量注③两分注：本件 t() 固定时戳=数据字段·非 D-47 落款语义。
// 形制照 v2-tickets.test.ts（node:test + tmp 目录·fresh-per-case）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { V2Store } from '../src/v2/store.js';
import { Effects } from '../src/v2/effects.js';
import { ReadTracker } from '../src/v2/read-tracker.js';
import { Policy, DEFAULT_SETTINGS } from '../src/v2/policy.js';
import { TicketRepo, Tickets, Assignments, type TicketDomainDeps, type ClosingFlag } from '../src/v2/tickets.js';
import { SeatRepo, seedSeats } from '../src/v2/seats.js';
import { Passes, type PassesHealthEntry } from '../src/v2/passes.js';

const TEST_DIR = join(tmpdir(), `trirlc-test-v2-passes-${process.pid}-${Date.now()}`);
const t = (n: number): string => new Date(Date.UTC(2026, 10, 6, 0, 0, n)).toISOString();

const stores: V2Store[] = [];

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

beforeEach(cleanup);

afterEach(() => {
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* 已关零害 */ }
  }
  cleanup();
});

/** 事件环沉降（照 v2-tickets settle 形）。 */
async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Domain {
  store: V2Store;
  effects: Effects;
  repo: TicketRepo;
  tickets: Tickets;
  assignments: Assignments;
  seatRepo: SeatRepo;
}

function buildDomain(withSeats: boolean): Domain {
  const store = new V2Store(TEST_DIR, 'v2.db');
  stores.push(store);
  const effects = new Effects(store.db);
  const readTracker = new ReadTracker(store.db);
  const repo = new TicketRepo(store.db);
  const seatRepo = new SeatRepo(store.db);
  if (withSeats) seedSeats(store.db);
  const closingFlag: ClosingFlag = { closing: false };
  const deps: TicketDomainDeps = {
    store, effects, readTracker, policy: new Policy(DEFAULT_SETTINGS), closingFlag,
    ...(withSeats ? { seats: seatRepo } : {}),
  };
  const tickets = new Tickets(deps, repo);
  const assignments = new Assignments(deps, repo, tickets);
  return { store, effects, repo, tickets, assignments, seatRepo };
}

/** health holder 注入形（Engine 组合同构·测试直组合）。 */
function healthFace(holder: { entry?: PassesHealthEntry }): PassesHealthEntry extends never ? never : { get(): PassesHealthEntry | undefined; set(entry: PassesHealthEntry): void } {
  return {
    get: () => holder.entry,
    set: (entry) => { holder.entry = entry; },
  };
}

describe('N7 Passes 泵环', () => {
  it('案1·泵消费链：pump→kick→dispatch→handler 消费+enqueue 即泵', async () => {
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    const effects = new Effects(store.db);
    const handled: string[] = [];
    effects.handle('probe', async (_payload, key) => { handled.push(key); });
    effects.start(); // dispatch started 旗（直组合显式起·Engine.open 同构位）
    const holder: { entry?: PassesHealthEntry } = {};
    const passes = new Passes({ effects, health: healthFace(holder), closing: () => false }, 10);
    effects.enqueue('probe', 'k1', {});
    await passes.pump();
    await effects.idle();
    assert.deepEqual(handled, ['k1'], 'kick→dispatch→handler 消费链');
    assert.equal(effects.pending('probe', 'k2'), false);
    // enqueue→pump 即跑（kick 生效·第二行）
    effects.enqueue('probe', 'k2', {});
    await passes.pump();
    await effects.idle();
    assert.deepEqual(handled, ['k1', 'k2']);
  });

  it('案2·coalesce 并发合并：三 pump 并发→pumpOnce 执行数≤2（pumping/pumpAgain 双槽）', async () => {
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    const effects = new Effects(store.db);
    let evalCount = 0;
    const holder: { entry?: PassesHealthEntry } = {};
    const passes = new Passes({
      effects, health: healthFace(holder), closing: () => false,
      evaluateDue: () => { evalCount += 1; },
    }, 10);
    await Promise.all([passes.pump(), passes.pump(), passes.pump()]);
    await passes.idle();
    assert.ok(evalCount >= 1, '至少一泵');
    assert.ok(evalCount <= 2, `并发合并双槽：evalCount=${evalCount} ≤2（原型 pumping/pumpAgain 语义）`);
  });

  it('案3·health error→ready 恢复：pump 链 rejection→error·成功泵→ready（request 恢复面）', async () => {
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    const effects = new Effects(store.db);
    effects.start(); // flaky handler 消费面 dispatch 旗
    let evalFail = true;
    const holder: { entry?: PassesHealthEntry } = {};
    const passes = new Passes({
      effects, health: healthFace(holder), closing: () => false,
      evaluateDue: () => { if (evalFail) throw new Error('eval boom'); },
    }, 10);
    passes.request();
    await settle();
    assert.equal(holder.entry?.state, 'error', 'pump 链 rejection→health error');
    assert.match(holder.entry?.detail ?? '', /eval boom/);
    evalFail = false;
    passes.request();
    await settle();
    assert.equal(holder.entry?.state, 'ready', '成功泵→ready 恢复（原型 request 恢复面）');
    // handler 失败不走泵 health（两分注：handler 失败=Effects 内部退避/health 面）
    effects.handle('flaky', async () => { throw new Error('handler boom'); });
    effects.enqueue('flaky', 'f1', {});
    await passes.pump();
    await settle();
    assert.equal(holder.entry?.state, 'ready', 'handler 失败零染泵 health（Effects 内部消化）');
  });

  it('案4·closing 面：closing→pump 零 pumpOnce·stop/start 收口·idle 收敛', async () => {
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    const effects = new Effects(store.db);
    let closing = false;
    let evalCount = 0;
    const holder: { entry?: PassesHealthEntry } = {};
    const passes = new Passes({
      effects, health: healthFace(holder), closing: () => closing,
      evaluateDue: () => { evalCount += 1; },
    }, 10);
    await passes.pump();
    assert.equal(evalCount, 1);
    closing = true;
    await passes.pump();
    assert.equal(evalCount, 1, 'closing 时 pump 零 pumpOnce（原型判位）');
    await passes.stop();
    await passes.idle();
    passes.start(); // stopped 旗：stop 后 start 零起 timer
    await settle();
    assert.equal(evalCount, 1, 'stop 后 start 零复活（stopped 单向）');
  });
});

describe('N7 status 联动（裁⑧收口）', () => {
  it('案5·started→busy：席名 actor 票起跑→seat status busy（事务内同写）', () => {
    const d = buildDomain(true);
    d.tickets.create({ id: 'tk-seat', title: 'T', mandate: { via: 'admission', strength: 'inferred', actor: { source: 'company', id: 'full-stack-developer' }, source: 'company' }, channels: [], decisionId: 'd', origin: { triggerId: 't', triggerIds: ['t'] }, at: t(0) });
    d.assignments.started('tk-seat', 'assignment:tk-seat:0', t(1));
    assert.equal(d.seatRepo.get('full-stack-developer')!.status, 'busy', 'started→busy');
  });

  it('案6·end→idle：票终局→seat status idle 回翻', () => {
    const d = buildDomain(true);
    d.tickets.create({ id: 'tk-seat', title: 'T', mandate: { via: 'admission', strength: 'inferred', actor: { source: 'company', id: 'full-stack-developer' }, source: 'company' }, channels: [], decisionId: 'd', origin: { triggerId: 't', triggerIds: ['t'] }, at: t(0) });
    d.assignments.started('tk-seat', 'assignment:tk-seat:0', t(1));
    d.tickets.end('tk-seat', { by: 'executor', outcome: 'done', at: t(2) });
    assert.equal(d.seatRepo.get('full-stack-developer')!.status, 'idle', 'end→idle');
  });

  it('案7·零联动：人名 actor（席名未命中）→started/end 零写席谱', () => {
    const d = buildDomain(true);
    const before = d.seatRepo.list();
    d.tickets.create({ id: 'tk-human', title: 'T', mandate: { via: 'followup', strength: 'explicit', actor: { source: 'company', id: 'person-1' }, source: 'company' }, channels: [], decisionId: 'd', origin: { triggerId: 't', triggerIds: ['t'] }, at: t(0) });
    d.assignments.started('tk-human', 'assignment:tk-human:0', t(1));
    d.tickets.end('tk-human', { by: 'executor', outcome: 'done', at: t(2) });
    assert.deepEqual(d.seatRepo.list(), before, '席谱零变（人名不命中 seat 表）');
    assert.equal(d.seatRepo.get('person-1'), undefined, '零新行');
  });

  it('案8·status 跨 reload 持久（硬门①同族）：busy 写→真重开→busy 仍在', async () => {
    const d1 = buildDomain(true);
    d1.tickets.create({ id: 'tk-p', title: 'T', mandate: { via: 'admission', strength: 'inferred', actor: { source: 'company', id: 'senior-test-engineer' }, source: 'company' }, channels: [], decisionId: 'd', origin: { triggerId: 't', triggerIds: ['t'] }, at: t(0) });
    d1.assignments.started('tk-p', 'assignment:tk-p:0', t(1));
    d1.store.close();
    // 真重开同库 boot 链（第四型盲区正形）
    const d2 = buildDomain(true);
    assert.equal(d2.seatRepo.get('senior-test-engineer')!.status, 'busy', '跨 reload busy 持久');
    // 种子幂等零冲（INSERT OR IGNORE——已改记录不被种子覆写）
    d2.tickets.end('tk-p', { by: 'executor', outcome: 'done', at: t(2) });
    assert.equal(d2.seatRepo.get('senior-test-engineer')!.status, 'idle', '重开后联动照常');
  });

  it('案9·兼容面：deps.seats 缺省 undefined→started/end 零害（N4 组合零改）', () => {
    const d = buildDomain(false);
    d.tickets.create({ id: 'tk-ns', title: 'T', mandate: { via: 'followup', strength: 'explicit', actor: { source: 'company', id: 'full-stack-developer' }, source: 'company' }, channels: [], decisionId: 'd', origin: { triggerId: 't', triggerIds: ['t'] }, at: t(0) });
    assert.doesNotThrow(() => d.assignments.started('tk-ns', 'assignment:tk-ns:0', t(1)));
    assert.doesNotThrow(() => d.tickets.end('tk-ns', { by: 'executor', outcome: 'done', at: t(2) }));
    // 无 seats 注入时 seatRepo 零种子零写（独立实例读面）
    assert.equal(d.seatRepo.list().length, 0, '零种子零联动写');
  });
});
