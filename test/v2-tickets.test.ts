// ── N4 票域自测门十三案（形三 α · 设计卷 §五案表+§七A 修正正形）──
// ①全生命周期链 ②addInput 幂等+held 让位 ③end letGo 基础形+幂等
// ④retry 门正形三支（§七A 修正：waitsForPerson 负向面+delivery 面）+
// requeueUntaken 重排队首 ⑤report UserError 谱 ⑥wake 复活门五支
// ⑦policy revalidate 三支谱 ⑧硬门①跨 reload 持久 ⑨硬门②settleTicket
// 票末收敛（delivered→settled 直跳+read→settled+未投零行）⑩硬门③closing
// 拒新全谱 ⑪emit→effects enqueue（kind/key 谱+coalesce generation）
// ⑫reporter spy（判定书三.2）——⑬β 三套零改动复跑=独立命令。
// 形制照 v2-engine.test.ts（node:test + tmp 目录·fresh-per-case 先关库再删）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/v2/engine.js';
import { V2Store } from '../src/v2/store.js';
import { Effects } from '../src/v2/effects.js';
import { ReadTracker } from '../src/v2/read-tracker.js';
import { TicketRepo, Tickets, Assignments, canRetry, waitsForPerson, type ClosingFlag } from '../src/v2/tickets.js';
import { Policy, DEFAULT_SETTINGS, type Settings, type Mandate } from '../src/v2/policy.js';
import { UserError } from '../src/v2/errors.js';

const TEST_DIR = join(tmpdir(), `trirlc-test-v2-tickets-${process.pid}-${Date.now()}`);

/** 微任务/事件环链清空（β-2 教训·精确等待）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 固定递增 ISO 时戳（held/跟进 at>report.at 判据可比面）。 */
const t = (n: number): string => new Date(Date.UTC(2026, 10, 6, 0, 0, n)).toISOString();

/** mandate 最小形 helper（缺省 followup explicit=revalidate 免检支）。 */
const mandate = (over: Partial<Mandate> = {}): Mandate => ({
  via: 'followup',
  strength: 'explicit',
  actor: { source: 'test', id: 'person-1' },
  source: 'test',
  ...over,
});

interface Domain {
  store: V2Store;
  effects: Effects;
  tracker: ReadTracker;
  policy: Policy;
  repo: TicketRepo;
  flag: ClosingFlag;
  tickets: Tickets;
  assignments: Assignments;
}

/** 直组合形（零锁快面·组合序照 Engine 构造序=β 链测试组合即正形·N5 升形=Policy 从 settings 构建）。 */
function buildDomain(onCommittedError?: (error: unknown) => void, settings: Settings = DEFAULT_SETTINGS): Domain {
  const store = new V2Store(TEST_DIR, 'v2.db', onCommittedError);
  const effects = new Effects(store.db);
  const tracker = new ReadTracker(store.db);
  const policy = new Policy(settings);
  const repo = new TicketRepo(store.db);
  const flag: ClosingFlag = { closing: false };
  const tickets = new Tickets({ store, effects, readTracker: tracker, policy, closingFlag: flag }, repo);
  const assignments = new Assignments({ store, effects, readTracker: tracker, policy, closingFlag: flag }, repo, tickets);
  return { store, effects, tracker, policy, repo, flag, tickets, assignments };
}

/** 开票 helper：create+text input 入队（生命周期链起点）。 */
function openTicket(domain: Domain, id = 'tk-1'): string {
  domain.tickets.create({ id, title: 'T', mandate: mandate(), channels: [], decisionId: 'd-1', origin: { triggerId: 'tg-1', triggerIds: ['tg-1'] }, at: t(0) });
  return id;
}

let engine: Engine | undefined;
const stores: V2Store[] = [];

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

beforeEach(() => {
  cleanup();
  stores.length = 0;
});

afterEach(async () => {
  if (engine !== undefined) {
    await engine.stop();
    engine = undefined;
  }
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* 已关零害 */ }
  }
  cleanup();
});

describe('N4 票域生命周期', () => {
  it('案1·全生命周期链：create→pending→started→delivered→read→report ready→end completed（Engine 全组合序）', async () => {
    engine = Engine.open(TEST_DIR); // 组合序七件（…→Policy→TicketRepo→Tickets→Assignments）
    const tid = 'tk-life';
    engine.tickets.create({ id: tid, title: '全链', mandate: mandate(), channels: [{ source: 's', thread: 'th', address: {} }], decisionId: 'd-1', origin: { triggerId: 'tg-1', triggerIds: ['tg-1'] }, at: t(0) });
    const aid = `assignment:${tid}:0`;
    assert.equal(engine.ticketRepo.get(tid)!.assignments[0]!.id, aid);
    engine.assignments.started(tid, aid, t(1));
    engine.tickets.addInput(tid, { id: 'in-1', kind: 'text', at: t(2), text: 'hello' });
    engine.assignments.delivered(tid, aid, ['in-1'], t(3));
    assert.equal(engine.readTracker.stateOf('in-1'), 'delivered');
    engine.assignments.read(['in-1']);
    assert.equal(engine.readTracker.stateOf('in-1'), 'read');
    engine.assignments.turnEnded(tid, aid, t(4));
    engine.assignments.report(tid, aid, { state: 'ready', summary: 'done', at: t(5) });
    // report ready→end 联动终局面断言（outcome 谱·readUntil 组成面在案）
    const ended = engine.ticketRepo.get(tid)!;
    assert.deepEqual(ended.ended, { at: t(5), by: 'executor', outcome: 'completed' });
    assert.deepEqual(ended.assignments[0]!.report, { state: 'ready', summary: 'done', at: t(5) });
    assert.equal(ended.assignments.every((row) => row.state === 'ended'), true);
    assert.equal(engine.readTracker.stateOf('in-1'), 'settled'); // read→settled 票末收敛
    // ended 后再 report→ticketEnded（UserError 谱副作用断言）
    assert.throws(() => engine!.assignments.report(tid, aid, { state: 'progress', summary: 'x', at: t(6) }), UserError);
  });

  it('案2·addInput 幂等（重复 id 零重入）+held（waitsForPerson 时 automatic 让位·human 入队）', () => {
    const d = buildDomain();
    stores.push(d.store);
    const tid = openTicket(d);
    const aid = `assignment:${tid}:0`;
    d.assignments.started(tid, aid, t(1));
    // 幂等：重复 id 零重入
    assert.equal(d.tickets.addInput(tid, { id: 'in-1', kind: 'text', at: t(2), text: 'a' }), true);
    assert.equal(d.tickets.addInput(tid, { id: 'in-1', kind: 'text', at: t(3), text: 'b' }), false);
    assert.deepEqual(d.repo.inputRows(tid).map((row) => row.id), ['in-1']);
    // waitsForPerson 态：report blocked（带 question）→undelivered 剔 automatic
    d.assignments.delivered(tid, aid, ['in-1'], t(4));
    d.assignments.report(tid, aid, { state: 'blocked', summary: 'stuck', question: 'how?', at: t(5) });
    assert.equal(d.repo.get(tid)!.undelivered.length, 0);
    // held：automatic（text）让位不入 undelivered
    assert.equal(d.tickets.addInput(tid, { id: 'in-auto', kind: 'text', at: t(6), text: 'auto' }), true);
    assert.deepEqual(d.repo.get(tid)!.undelivered, [], 'automatic input must be held while waitsForPerson');
    // human trigger 不让位（入 undelivered——lifts waitsForPerson 面）
    assert.equal(d.tickets.addInput(tid, { id: 'in-human', kind: 'trigger', at: t(7), triggerId: 'tg-2', human: true }), true);
    assert.deepEqual(d.repo.get(tid)!.undelivered, ['in-human']);
    assert.equal(waitsForPerson(d.repo.get(tid)!, d.repo.inputRows(tid)), false, 'human follow-up lifts waitsForPerson');
  });

  it('案3·end letGo 基础形：undelivered 清+assignments 标 ended+liveTicket 幂等二调零变', () => {
    const d = buildDomain();
    stores.push(d.store);
    const tid = openTicket(d);
    d.tickets.addInput(tid, { id: 'in-1', kind: 'text', at: t(1), text: 'a' });
    assert.equal(d.tickets.end(tid, { by: 'executor', outcome: 'dropped', at: t(2) }), true);
    const ended = d.repo.get(tid)!;
    assert.deepEqual(ended.ended, { at: t(2), by: 'executor', outcome: 'dropped' });
    assert.deepEqual(ended.undelivered, []);
    assert.equal(ended.assignments.every((a) => a.state === 'ended' && a.endedReason === 'executor:dropped'), true);
    assert.equal(ended.attention, undefined);
    // 幂等二调：false+ended 记录零变
    assert.equal(d.tickets.end(tid, { by: 'human', outcome: 'stopped', at: t(9) }), false);
    assert.deepEqual(d.repo.get(tid)!.ended, { at: t(2), by: 'executor', outcome: 'dropped' });
    assert.equal(canRetry(d.repo.get(tid)!, d.repo.inputRows(tid)), false, 'ended 票不可 retry');
  });
});

describe('N4 retry 门（§七A 修正正形）', () => {
  it('案4·canRetry 三支：blocked 无跟进=retriable/blocked 后 human 跟进=非 retriable/delivery 失败=retriable+requeueUntaken 重排队首', () => {
    const d = buildDomain();
    stores.push(d.store);
    // 支 a：blocked 后无跟进→retriable（waitsForPerson 支）
    const tidA = openTicket(d, 'tk-a');
    const aidA = `assignment:${tidA}:0`;
    d.assignments.started(tidA, aidA, t(1));
    d.assignments.report(tidA, aidA, { state: 'blocked', summary: 'stuck', question: 'q?', at: t(2) });
    const retriedA = d.tickets.retry(tidA, t(3));
    assert.equal(retriedA.id, `assignment:${tidA}:1`);
    assert.equal(retriedA.state, 'pending');
    assert.equal(waitsForPerson(d.repo.get(tidA)!, d.repo.inputRows(tidA)), false, 'retry 起新 assignment lifts waitsForPerson');
    // 支 b：blocked 后 human 跟进→非 retriable（负向面·§七A 修正①）
    const tidB = openTicket(d, 'tk-b');
    const aidB = `assignment:${tidB}:0`;
    d.assignments.started(tidB, aidB, t(1));
    d.assignments.report(tidB, aidB, { state: 'blocked', summary: 'stuck', question: 'q?', at: t(2) });
    d.tickets.addInput(tidB, { id: 'in-fu', kind: 'trigger', at: t(3), triggerId: 'tg-fu', human: true });
    assert.equal(waitsForPerson(d.repo.get(tidB)!, d.repo.inputRows(tidB)), false);
    assert.throws(() => d.tickets.retry(tidB, t(4)), (error: unknown) => error instanceof UserError && /not retriable/.test(error.message));
    // 支 c：delivery 失败→retriable（!!delivery 支·§七A 修正②）
    const tidC = openTicket(d, 'tk-c');
    d.assignments.deliveryFailed(tidC, 'transport down', t(1));
    assert.deepEqual(d.repo.get(tidC)!.delivery, { error: 'transport down', at: t(1) });
    const retriedC = d.tickets.retry(tidC, t(2));
    assert.equal(retriedC.id, `assignment:${tidC}:1`);
    // requeueUntaken：已投未读+deliveredTo=replaced→重排队首归新 assignment
    const tidD = openTicket(d, 'tk-d');
    const aidD0 = `assignment:${tidD}:0`;
    d.assignments.started(tidD, aidD0, t(1));
    d.tickets.addInput(tidD, { id: 'in-rq', kind: 'trigger', at: t(2), triggerId: 'tg-rq' });
    d.assignments.delivered(tidD, aidD0, ['in-rq'], t(3)); // markDelivered→delivered 态+deliveredTo=aidD0
    assert.equal(d.tracker.stateOf('in-rq'), 'delivered');
    d.assignments.report(tidD, aidD0, { state: 'failed', summary: 'crash', question: 'q?', at: t(4) });
    assert.equal(canRetry(d.repo.get(tidD)!, d.repo.inputRows(tidD)), true);
    d.tickets.retry(tidD, t(5));
    const after = d.repo.get(tidD)!;
    assert.deepEqual(after.undelivered, ['in-rq'], 'untaken input 重排队首');
    assert.deepEqual(d.repo.inputRows(tidD).find((row) => row.id === 'in-rq')!.value.deliveredTo, `assignment:${tidD}:1`);
  });
});

describe('N4 report 校验谱+wake 复活门', () => {
  it('案5·report UserError 谱：questionWithResult/askerWithoutQuestion/assignmentEnded/ticketEnded/unknownAssignment', () => {
    const d = buildDomain();
    stores.push(d.store);
    const tid = openTicket(d);
    const aid = `assignment:${tid}:0`;
    // questionWithResult：question 配非 asking 态
    assert.throws(() => d.assignments.report(tid, aid, { state: 'ready', summary: 'x', question: 'q?', at: t(1) }),
      (error: unknown) => error instanceof UserError && /question goes with/.test(error.message));
    // askerWithoutQuestion：asking 态缺 question
    for (const state of ['waiting', 'blocked', 'failed'] as const) {
      assert.throws(() => d.assignments.report(tid, aid, { state, summary: 'x', at: t(1) }),
        (error: unknown) => error instanceof UserError && /needs a question/.test(error.message));
    }
    // unknownAssignment
    assert.throws(() => d.assignments.report(tid, 'assignment:nope', { state: 'progress', summary: 'x', at: t(1) }),
      (error: unknown) => error instanceof UserError && /Unknown assignment/.test(error.message));
    // assignmentEnded：白盒造 ended assignment+open 票
    const ticket = d.repo.get(tid)!;
    ticket.assignments[0]!.state = 'ended';
    d.repo.put(ticket);
    assert.throws(() => d.assignments.report(tid, aid, { state: 'progress', summary: 'x', at: t(1) }),
      (error: unknown) => error instanceof UserError && /assignment has ended/.test(error.message));
    // ticketEnded：end 票后 report
    d.tickets.end(tid, { by: 'executor', outcome: 'completed', at: t(2) });
    assert.throws(() => d.assignments.report(tid, aid, { state: 'progress', summary: 'x', at: t(3) }),
      (error: unknown) => error instanceof UserError && /ticket has ended/.test(error.message));
  });

  it('案6·wake 复活门五支：正复活（resumed 队首）/human stop 拒/非 human 拒/paused 拒/revalidate 拒', () => {
    const d = buildDomain();
    stores.push(d.store);
    // 正复活：executor ended 票+human 积压+human trigger→ended 清+resumed 队首
    const tid = openTicket(d);
    d.tickets.end(tid, { by: 'executor', outcome: 'completed', at: t(1) });
    d.tickets.addInput(tid, { id: 'in-back', kind: 'text', at: t(2), text: 'backlog' });
    d.tickets.wake(tid, { id: 'tg-w', human: true, at: t(3) });
    const woke = d.repo.get(tid)!;
    assert.equal(woke.ended, undefined);
    assert.equal(woke.undelivered[0], `resumed:tg-w:${t(3)}`, 'resumed marker 先于积压投递');
    assert.equal(d.effects.pending('emit', `ticket.resumed.${tid}`), true);
    // open 票拒
    const tidOpen = openTicket(d, 'tk-open');
    assert.throws(() => d.tickets.wake(tidOpen, { id: 'tg', human: true, at: t(1) }),
      (error: unknown) => error instanceof UserError && /is open/.test(error.message));
    // human stop 拒
    const tidStopped = openTicket(d, 'tk-stopped');
    d.tickets.stop(tidStopped, 'no longer needed', t(1));
    assert.throws(() => d.tickets.wake(tidStopped, { id: 'tg', human: true, at: t(2) }),
      (error: unknown) => error instanceof UserError && /human-stopped/.test(error.message));
    // 非 human 拒
    const tidBot = openTicket(d, 'tk-bot');
    d.tickets.end(tidBot, { by: 'executor', outcome: 'dropped', at: t(1) });
    d.tickets.addInput(tidBot, { id: 'in-b', kind: 'text', at: t(2), text: 'x' });
    assert.throws(() => d.tickets.wake(tidBot, { id: 'tg-bot', human: false, at: t(3) }),
      (error: unknown) => error instanceof UserError && /Only a human/.test(error.message));
    // paused 拒（N5 升形：paused=构造 settings 设定——holder rebind 面·独立域）
    const dP = buildDomain(undefined, { ...DEFAULT_SETTINGS, paused: true });
    stores.push(dP.store);
    const tidPaused = openTicket(dP, 'tk-paused');
    dP.tickets.end(tidPaused, { by: 'executor', outcome: 'dropped', at: t(1) });
    dP.tickets.addInput(tidPaused, { id: 'in-p', kind: 'text', at: t(2), text: 'x' });
    assert.throws(() => dP.tickets.wake(tidPaused, { id: 'tg', human: true, at: t(3) }),
      (error: unknown) => error instanceof UserError && /paused/.test(error.message));
    // revalidate 拒：admission mandate 强度降级（listedUnaddressed 缺省 explicit·mandate inferred）
    const tidRev = openTicket(d, 'tk-rev');
    d.repo.put({ ...d.repo.get(tidRev)!, mandate: mandate({ via: 'admission', strength: 'inferred', cell: 'listedUnaddressed' }) });
    d.tickets.end(tidRev, { by: 'executor', outcome: 'dropped', at: t(1) });
    d.tickets.addInput(tidRev, { id: 'in-r', kind: 'text', at: t(2), text: 'x' });
    assert.throws(() => d.tickets.wake(tidRev, { id: 'tg', human: true, at: t(3) }),
      (error: unknown) => error instanceof UserError && /revalidation refused/.test(error.message));
  });
});

describe('N5 Policy 完整门族（N5 升形·门①裁②）', () => {
  it('案7·revalidate 完整谱正形（原型 L213-240）：followup auto+rulesOn/admission cell 迁移与强度判/observation auto 支/bot 名单/listed 在册/scope 失听', () => {
    // mode='auto'+rules=[r-1] 域（rulesOn 判据面）
    const autoPolicy = new Policy({
      paused: false,
      policy: { rules: [{ id: 'r-1', name: 'R1', instruction: 'i', enabled: true }], sources: {} },
      eval: { mode: 'auto' },
    });
    const offPolicy = new Policy(DEFAULT_SETTINGS); // mode='off' 缺省谱（裁①）
    // 支①：followup——explicit 免（mode 无关）；inferred=auto+rulesOn（vacuous true·原型 L221 正形）
    assert.equal(autoPolicy.revalidate(mandate({ via: 'followup', strength: 'explicit' })), true);
    assert.equal(autoPolicy.revalidate(mandate({ via: 'followup', strength: 'inferred' })), true, 'N5 升形翻转：auto+rules vacuous 过（原型 L221/L219）');
    assert.equal(offPolicy.revalidate(mandate({ via: 'followup', strength: 'inferred' })), false, 'mode=off 时 followup inferred 拒');
    assert.equal(autoPolicy.revalidate(mandate({ via: 'followup', strength: 'inferred', rules: ['r-gone'] })), false, 'followup inferred 引失能规则拒');
    // 支②：admission cell（sources 空=全 unlisted 谱·原型 L225-235）
    assert.equal(autoPolicy.revalidate(mandate({ via: 'admission', strength: 'inferred', cell: 'unlistedUnaddressed' })), true); // 表值不降
    assert.equal(autoPolicy.revalidate(mandate({ via: 'admission', strength: 'explicit', cell: 'unlistedUnaddressed' })), false, 'N5 翻转：表值降级拒（原型 L234·requesterAllowed 面存活依赖）');
    assert.equal(autoPolicy.revalidate(mandate({ via: 'admission', strength: 'inferred', cell: 'listedUnaddressed' })), false, 'listedUnaddressed 失格（L232）');
    assert.equal(autoPolicy.revalidate(mandate({ via: 'admission', strength: 'inferred' })), false, '缺 cell 非正规形保守拒（v2 裁·原型宽容差如实注）');
    // 支②迁移升格（L231）：unlistedUnaddressed+现 listed→listedUnaddressed 迁移·explicit 缺省强度不降过
    const listedPolicy = new Policy({
      paused: false,
      policy: { rules: [], sources: { test: { allowed: [{ id: 'person-1' }] } } },
      eval: { mode: 'auto' },
    });
    assert.equal(listedPolicy.revalidate(mandate({ via: 'admission', strength: 'inferred', cell: 'unlistedUnaddressed' })), true, '迁移升格链 L231-234 过');
    // 支③：observation——bot 名单在册+auto+rulesOn（vacuous true·原型 L238/L219 正形）
    const botPolicy = new Policy({
      paused: false,
      policy: { rules: [{ id: 'r-1', name: 'R1', instruction: 'i', enabled: true }], sources: { test: { allowed: [], bots: [{ id: 'ci-bot' }] } } },
      eval: { mode: 'auto' },
    });
    const botActor = { source: 'test', id: 'ci-bot' };
    assert.equal(botPolicy.revalidate(mandate({ via: 'bot', strength: 'inferred', actor: botActor, observation: { mode: 'auto' }, rules: ['r-1'] })), true);
    assert.equal(botPolicy.revalidate(mandate({ via: 'bot', strength: 'inferred', actor: botActor, observation: { mode: 'auto' } })), true, 'N5 翻转：rules 空 vacuous 过（原型 L219）');
    assert.equal(botPolicy.revalidate(mandate({ via: 'bot', strength: 'inferred', actor: botActor, observation: { mode: 'observe' }, rules: ['r-1'] })), true, 'N5 升形勘正：L238 判据=settings eval.mode 非 mandate.observation.mode（observation.mode=票面标记非判据·原型正形）');
    const botOffPolicy = new Policy({
      paused: false,
      policy: { rules: [{ id: 'r-1', name: 'R1', instruction: 'i', enabled: true }], sources: { test: { allowed: [], bots: [{ id: 'ci-bot' }] } } },
      eval: { mode: 'off' },
    });
    assert.equal(botOffPolicy.revalidate(mandate({ via: 'bot', strength: 'inferred', actor: botActor, observation: { mode: 'auto' }, rules: ['r-1'] })), false, 'settings mode=off 拒 observation mandate（L238 mode 判据=settings eval mode）');
    assert.equal(autoPolicy.revalidate(mandate({ via: 'bot', strength: 'inferred', observation: { mode: 'auto' }, rules: ['r-1'] })), false, 'bot 不在名单拒（L223·N4 三支无此支升形补）');
    // 其余 via：listed/addressed 需 sender 在册（L236）
    assert.equal(autoPolicy.revalidate(mandate({ via: 'addressed', strength: 'explicit' })), false);
    assert.equal(autoPolicy.revalidate(mandate({ via: 'listed', strength: 'explicit' })), false);
    assert.equal(listedPolicy.revalidate(mandate({ via: 'addressed', strength: 'explicit' })), true, 'listed sender addressed 票过（L236 反面）');
    // scope 失听拒（L217-218·N5 升形 scope 记录面消费）
    const deafPolicy = new Policy(DEFAULT_SETTINGS, () => ({ listened: false }));
    assert.equal(deafPolicy.revalidate(mandate({ via: 'addressed', strength: 'explicit', scope: { row: 'r1' } })), false, 'scope 失听拒（L217-218）');
  });
});

describe('N4 硬门三案', () => {
  it('案8·硬门①跨 reload 持久：票+input 写→close→同库真重开→票在+input 幂等仍在', () => {
    const d1 = buildDomain();
    const tid = openTicket(d1);
    d1.tickets.addInput(tid, { id: 'in-1', kind: 'text', at: t(1), text: 'persist' });
    d1.store.close();
    // 真重开同库 boot 链（第四型盲区正形：非进程内复刻）
    const d2 = buildDomain();
    stores.push(d2.store);
    assert.equal(d2.repo.get(tid)!.title, 'T');
    assert.deepEqual(d2.repo.inputRows(tid).map((row) => row.id), ['in-1']);
    // 重开后 PK 幂等仍在（INSERT OR IGNORE 二次零重）
    assert.equal(d2.tickets.addInput(tid, { id: 'in-1', kind: 'text', at: t(2), text: 'again' }), false);
    assert.equal(d2.repo.inputRows(tid).length, 1);
  });

  it('案9·硬门②票末收敛：delivered→settled 直跳+read→settled+未投递零 settle 行', () => {
    const d = buildDomain();
    stores.push(d.store);
    const tid = openTicket(d);
    const aid = `assignment:${tid}:0`;
    d.assignments.started(tid, aid, t(1));
    d.tickets.addInput(tid, { id: 'in-del', kind: 'text', at: t(2), text: 'a' });
    d.tickets.addInput(tid, { id: 'in-read', kind: 'text', at: t(3), text: 'b' });
    d.assignments.delivered(tid, aid, ['in-del', 'in-read'], t(4));
    d.assignments.read(['in-read']);
    // 未投递 input（end 前入·running 态 flush 面——直接造：blocked report 后 automatic held）
    d.tickets.addInput(tid, { id: 'in-held', kind: 'text', at: t(5), text: 'c' });
    assert.deepEqual(d.repo.get(tid)!.undelivered, ['in-held'], 'in-held 未投递（deliver 效果行未消费·undelivered 在案）');
    d.assignments.report(tid, aid, { state: 'ready', summary: 'done', at: t(6) }); // →end 联动
    assert.equal(d.tracker.stateOf('in-del'), 'settled', 'delivered→settled 直跳支（票末收敛语义正身）');
    assert.equal(d.tracker.stateOf('in-read'), 'settled', 'read→settled 支');
    assert.equal(d.tracker.stateOf('in-held'), undefined, '未投递零 settle 行（waiting 面）');
  });

  it('案10·硬门③closing 拒新：closingFlag 置位→票域 mutation 全谱 UserError(closing)', () => {
    const d = buildDomain();
    stores.push(d.store);
    const tid = openTicket(d);
    const aid = `assignment:${tid}:0`;
    d.flag.closing = true;
    const closing = (error: unknown): boolean => error instanceof UserError && /closing/.test(error.message);
    assert.throws(() => d.tickets.create({ id: 'tk-x', title: 'x', mandate: mandate(), channels: [], decisionId: 'd', origin: { triggerId: 't', triggerIds: ['t'] } }), closing);
    assert.throws(() => d.tickets.addInput(tid, { id: 'in-x', kind: 'text', at: t(1), text: 'x' }), closing);
    assert.throws(() => d.tickets.end(tid, { by: 'executor', outcome: 'completed' }), closing);
    assert.throws(() => d.tickets.retry(tid), closing);
    assert.throws(() => d.tickets.wake(tid, { id: 'tg', human: true, at: t(1) }), closing);
    assert.throws(() => d.tickets.stop(tid), closing);
    assert.throws(() => d.assignments.started(tid, aid), closing);
    assert.throws(() => d.assignments.delivered(tid, aid, ['in-1']), closing);
    assert.throws(() => d.assignments.read(['in-1']), closing);
    assert.throws(() => d.assignments.turnEnded(tid, aid), closing);
    assert.throws(() => d.assignments.deliveryFailed(tid, 'err'), closing);
    assert.throws(() => d.assignments.report(tid, aid, { state: 'progress', summary: 'x' }), closing);
  });
});

describe('N4 emit 谱+reporter 注入', () => {
  it('案11·emit→effects enqueue：kind=emit·key=event.ticketId·coalesce generation+1', async () => {
    const d = buildDomain();
    stores.push(d.store);
    const tid = openTicket(d, 'tk-emit');
    assert.equal(d.effects.pending('emit', `ticket.created.${tid}`), true);
    // 谱面：不同事件不同 key 零误并
    d.tickets.end(tid, { by: 'executor', outcome: 'completed', at: t(1) });
    assert.equal(d.effects.pending('emit', `ticket.ended.${tid}`), true);
    assert.equal(d.effects.pending('emit', `assignment.ended.${tid}`), true);
    assert.equal(d.effects.pending('emit', `ticket.created.${tid}`), true); // 原 key 不受影响
    // coalesce：同 kind+key 重 enqueue→generation+1（覆盖不新增行）
    d.effects.enqueue('emit', `manual.${tid}`, {});
    d.effects.enqueue('emit', `manual.${tid}`, { v: 2 });
    const row = d.store.db.prepare("SELECT generation, value FROM effect WHERE kind = 'emit' AND key = ?").get(`manual.${tid}`) as
      { generation: number | bigint; value: string };
    assert.equal(Number(row.generation), 1, '同 key coalesce generation 自增');
    assert.deepEqual(JSON.parse(row.value), { v: 2 }, '重 enqueue 覆盖 value');
    await settle(); // 零 handler=行留库候消费（首版如实注）——dispatch 空转零害
  });

  it('案12·reporter spy：committed 回调抛→注入 reporter 收 error·事务不败', () => {
    const seen: unknown[] = [];
    const d = buildDomain((error) => { seen.push(error); });
    stores.push(d.store);
    d.store.db.exec('CREATE TABLE IF NOT EXISTS probe (v INTEGER)');
    const value = d.store.atomic(() => {
      d.store.onCommitted(() => { throw new Error('cb boom'); });
      return 42;
    });
    assert.equal(value, 42, '回调错误不败事务（atomic 正常返回）');
    assert.equal(seen.length, 1);
    assert.match(String(seen[0]), /cb boom/);
    d.store.db.prepare('INSERT INTO probe VALUES (7)').run(); // 库仍可用
  });
});
