// ── N5 Policy 门族自测门六案（形三 α · 设计卷 72edda33b §二.3·门①裁 2cfe40575）──
// A 未授权 sender 拒收（任务书①·gate 直测+集成链）B policy 变更增量通知
// （任务书②·四支 diff+held+pending start 效果行+同对反复 id 含 at）
// C policyVersion 哈希（裁⑤·授权面变→变/paused 变→不变）D gate 全谱
// （explicit 直过/admission/followup/machine bot/senderless/reason 谱/scope 拒听）
// E validateSettings 校验谱+SettingsRepo 单行 F settings 跨 reload 持久（硬门①同族）。
// （revalidate 完整谱=案 7 升形落 v2-tickets.test.ts——同把令对应形如实注。）
// 形制照 v2-tickets.test.ts（node:test + tmp 目录·fresh-per-case）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/v2/engine.js';
import { V2Store } from '../src/v2/store.js';
import {
  Policy, SettingsRepo, policyVersion, validateSettings,
  DEFAULT_SETTINGS,
  type Settings, type GateTrigger, type GateResult, type PolicyEffect,
} from '../src/v2/policy.js';
import { UserError } from '../src/v2/errors.js';

const TEST_DIR = join(tmpdir(), `trirlc-test-v2-policy-${process.pid}-${Date.now()}`);
const t = (n: number): string => new Date(Date.UTC(2026, 10, 6, 0, 0, n)).toISOString();

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

/** settings helper：单 source 形（test.allowed=[person-1] 缺省·over 覆盖）。 */
const settingsWith = (over: {
  paused?: boolean;
  mode?: 'off' | 'observe' | 'auto';
  rules?: Settings['policy']['rules'];
  sources?: Settings['policy']['sources'];
} = {}): Settings => ({
  paused: over.paused ?? false,
  policy: { rules: over.rules ?? [], sources: over.sources ?? { test: { allowed: [{ id: 'person-1' }] } } },
  eval: { mode: over.mode ?? 'off' },
});

const humanTrigger = (over: Partial<GateTrigger> = {}): GateTrigger => ({
  human: true,
  actor: { source: 'test', id: 'person-1' },
  source: 'test',
  ...over,
});

/** gate 结果投影（断言面收敛·undefined 字段不落对象——loose deepEqual 键存在性判异）。 */
const gateFace = (result: GateResult): Record<string, unknown> => {
  const face: Record<string, unknown> = { admissible: result.admissible };
  if (result.strength !== undefined) face.strength = result.strength;
  if (result.basis?.via !== undefined) face.via = result.basis.via;
  if (result.reason !== undefined) face.reason = result.reason;
  return face;
};

const R1 = { id: 'r-1', name: 'R1', instruction: 'do', enabled: true };

describe('N5 gate 面', () => {
  it('案A·未授权 sender 拒收（任务书①）：名单内 addressed→explicit·名单外→not_a_member·集成链 gate 过→create 落票', () => {
    const s = settingsWith(); // test.allowed=[person-1]
    const policy = new Policy(s);
    // 名单内 addressed→explicit via='addressed'（原型 L197）
    assert.deepEqual(gateFace(policy.gate(humanTrigger({ addressed: 'direct' }))),
      { admissible: true, strength: 'explicit', via: 'addressed' });
    // 名单外 human unaddressed（mode off 缺省）→拒 not_a_member（原型 L210·inferred 需 mode≠off）
    assert.deepEqual(gateFace(policy.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' } }))),
      { admissible: false, reason: 'not_a_member' });
    // 名单外 human addressed→admission 缺省 explicit 直过（原型 L203 正形·无 allowedSender 前置——
    // admission 表 explicit 值本身=授权决定·名单收紧面=admission 表配置·N5 谱系勘定如实注）
    assert.deepEqual(gateFace(policy.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' }, addressed: 'direct' }))),
      { admissible: true, strength: 'explicit', via: 'admission' });
    // 集成链：Engine.applySettings→gate 过→create 落票（gate→tickets 链·原型 source intake 同构）
    engine = Engine.open(TEST_DIR);
    engine.applySettings(s);
    const hit = engine.policy.gate(humanTrigger({ addressed: 'direct' }));
    assert.equal(hit.admissible, true);
    const created = engine.tickets.create({
      id: 'tk-gated', title: 'from gate', mandate: hit.basis!, channels: [],
      decisionId: 'd-1', origin: { triggerId: 'tg-1', triggerIds: ['tg-1'] }, at: t(0),
    });
    assert.equal(engine.ticketRepo.get(created.id)!.mandate.via, 'addressed');
    // 拒面下 gate 不放行（create 前置门语义·结构化断言·unaddressed 形）
    assert.equal(engine.policy.gate(humanTrigger({ actor: { source: 'test', id: 'x' } })).admissible, false);
  });

  it('案D·gate 全谱（裁①③④）：mode=off admission inferred 拒/auto 过/listed unaddressed explicit 直过/followup participating/machine bot+senderless/reason 谱/scope 拒听', () => {
    const off = new Policy(settingsWith()); // mode=off 缺省（裁①）
    // D1：unlisted unaddressed·mode off→inferred 需 mode≠off（L209）→拒 not_a_member
    assert.deepEqual(gateFace(off.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' } }))),
      { admissible: false, reason: 'not_a_member' });
    const auto = new Policy(settingsWith({ mode: 'auto' }));
    // D2：unlisted unaddressed·auto→admission inferred 过（basis cell+observation·L209）
    const d2 = auto.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' } }));
    assert.deepEqual(gateFace(d2), { admissible: true, strength: 'inferred', via: 'admission' });
    assert.equal(d2.basis?.cell, 'unlistedUnaddressed');
    assert.equal(d2.basis?.observation?.mode, 'auto');
    // D3：listed unaddressed→cell 缺省 explicit 直过先于 followup（原型 L203-204）
    assert.deepEqual(gateFace(auto.gate(humanTrigger())), { admissible: true, strength: 'explicit', via: 'admission' });
    // D4：followup participating（裁④调用方算）：stranger unaddressed+participating→followup inferred
    assert.deepEqual(gateFace(auto.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' } }), { participating: true })),
      { admissible: true, strength: 'inferred', via: 'followup' });
    // D5：explicit 直过先于 followup（原型 L203 注正形直证）：stranger addressed→unlistedAddressed
    // 缺省 explicit 直过（followup 支根本不到·与案 A 名单外 addressed 同谱）
    assert.deepEqual(gateFace(auto.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' }, addressed: 'direct' }), { participating: true })),
      { admissible: true, strength: 'explicit', via: 'admission' });
    // D5b：followup participating 真落地面=unaddressed+participating（admission 非 explicit 谱才轮到 followup 支）：
    // admission 表收紧后 stranger unaddressed→inferred 过 followup 面
    const tight = new Policy(settingsWith({
      mode: 'auto',
      sources: { test: { allowed: [{ id: 'person-1' }], admission: { '*': { unlistedUnaddressed: 'inferred', unlistedAddressed: 'inferred', listedUnaddressed: 'inferred', listedAddressed: 'explicit' } } } },
    }));
    assert.deepEqual(gateFace(tight.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' } }), { participating: true })),
      { admissible: true, strength: 'inferred', via: 'followup' });
    // D6：machine bot 表在（mode auto）→inferred candidate via='bot'（原型 L178-181）
    const botP = new Policy(settingsWith({
      mode: 'auto',
      sources: { test: { allowed: [{ id: 'person-1' }], bots: [{ id: 'ci-bot' }] } },
    }));
    assert.deepEqual(gateFace(botP.gate({ human: false, actor: { source: 'test', id: 'ci-bot' }, source: 'test', addressed: 'direct' })),
      { admissible: true, strength: 'inferred', via: 'bot' });
    // D7：machine 非 bot→not_human（原型 L173）
    assert.deepEqual(gateFace(botP.gate({ human: false, actor: { source: 'test', id: 'rogue' }, source: 'test' })),
      { admissible: false, reason: 'not_human' });
    // D8：senderless 系统事件（actor.id 空→不查 bot 表·scope 全收→admission inferred 过·原型 L183-187）
    const d8 = botP.gate({ human: false, actor: { source: 'test', id: '' }, source: 'test' });
    assert.deepEqual(gateFace(d8), { admissible: true, strength: 'inferred', via: 'admission' });
    assert.equal(d8.basis?.cell, 'unlistedUnaddressed');
    // D9：machine bot mode=off→admission_ignored（原型 L179）
    const botOff = new Policy({ ...settingsWith({ sources: { test: { allowed: [{ id: 'person-1' }], bots: [{ id: 'ci-bot' }] } } }) });
    assert.deepEqual(gateFace(botOff.gate({ human: false, actor: { source: 'test', id: 'ci-bot' }, source: 'test' })),
      { admissible: false, reason: 'admission_ignored' });
    // D10：scope 拒听（裁③注入面）：unaddressed+不收不观→receivable false→ignore→not_a_member
    const deaf = new Policy(settingsWith({ mode: 'auto' }), () => ({ listened: false, observed: false }));
    assert.deepEqual(gateFace(deaf.gate(humanTrigger({ actor: { source: 'test', id: 'stranger' } }))),
      { admissible: false, reason: 'not_a_member' });
  });
});

describe('N5 变更增量通知', () => {
  it('案B·policy 变更增量通知（任务书②）：四支 diff→policy-changed input+held 让位+pending start 效果行+同对反复 id 含 at', async () => {
    engine = Engine.open(TEST_DIR);
    // 初谱 s0：auto+r-1 enabled+allowed[person-1]+bots[ci-bot,ci-bot2]
    const s0 = settingsWith({
      mode: 'auto',
      rules: [R1],
      sources: { test: { allowed: [{ id: 'person-1' }], bots: [{ id: 'ci-bot' }, { id: 'ci-bot2' }] } },
    });
    engine.applySettings(s0);
    const origin = { triggerId: 't', triggerIds: ['t'] };
    // 票1：followup explicit+rules[r-1]（rules 面载体）
    engine.tickets.create({ id: 'tk-rules', title: 'T1', mandate: { via: 'followup', strength: 'explicit', actor: { source: 'test', id: 'person-1' }, source: 'test', rules: ['r-1'] }, channels: [], decisionId: 'd', origin, at: t(0) });
    // 票2：admission inferred+observation+rules[r-1]（held 面+proactive 面）——started+blocked→waitsForPerson
    engine.tickets.create({ id: 'tk-held', title: 'T2', mandate: { via: 'admission', strength: 'inferred', actor: { source: 'test', id: 'person-1' }, source: 'test', cell: 'unlistedUnaddressed', observation: { mode: 'auto' }, rules: ['r-1'] }, channels: [], decisionId: 'd', origin, at: t(0) });
    engine.assignments.started('tk-held', 'assignment:tk-held:0', t(1));
    engine.assignments.report('tk-held', 'assignment:tk-held:0', { state: 'blocked', summary: 'stuck', question: 'q?', at: t(2) });
    // 票3：bot mandate ci-bot（requesterAllowed 面）
    engine.tickets.create({ id: 'tk-bot', title: 'T3', mandate: { via: 'bot', strength: 'inferred', actor: { source: 'test', id: 'ci-bot' }, source: 'test', observation: { mode: 'auto' }, rules: ['r-1'] }, channels: [], decisionId: 'd', origin, at: t(0) });
    // 票4：bot mandate ci-bot2+pending 不 started（start 效果行面）
    engine.tickets.create({ id: 'tk-pending', title: 'T4', mandate: { via: 'bot', strength: 'inferred', actor: { source: 'test', id: 'ci-bot2' }, source: 'test', observation: { mode: 'auto' }, rules: ['r-1'] }, channels: [], decisionId: 'd', origin, at: t(0) });

    // (a) bots 全剔→票3/票4 requesterAllowed=false（原型 L155-159：asBefore 同拒→sender 面丢权）
    const sA: Settings = { paused: false, policy: { rules: [R1], sources: { test: { allowed: [{ id: 'person-1' }], bots: [] } } }, eval: { mode: 'auto' } };
    const effectsA = engine.applySettings(sA);
    assert.deepEqual(effectsA.get('tk-bot'),
      { requesterAllowed: false, requester: { source: 'test', id: 'ci-bot' } });
    assert.deepEqual(effectsA.get('tk-pending'),
      { requesterAllowed: false, requester: { source: 'test', id: 'ci-bot2' } });
    assert.equal(effectsA.has('tk-rules'), false, '票1 followup explicit 全程零效果');
    // 票3 收 policy-changed input（effect 面落 value）
    const pcBot = engine.ticketRepo.inputRows('tk-bot').find((row) => row.kind === 'policy-changed');
    assert.ok(pcBot !== undefined, '票3 收 policy-changed');
    assert.deepEqual(pcBot!.value.policy?.effect, { requesterAllowed: false, requester: { source: 'test', id: 'ci-bot' } });
    // 票4 pending 非 waits→start 效果行（addInput 派发面·N4 效果行谱复用）
    assert.equal(engine.effects.pending('start', 'tk-pending'), true, 'pending 票收 policy-changed→start 效果行');

    // (b) mode auto→off→票2 proactive=false（原型 L160：inferred+old auto+now 非 auto）
    const sB: Settings = { paused: false, policy: { rules: [R1], sources: { test: { allowed: [{ id: 'person-1' }], bots: [] } } }, eval: { mode: 'off' } };
    const effectsB = engine.applySettings(sB);
    assert.deepEqual(effectsB.get('tk-held'), { proactive: false });
    // 票2 waitsForPerson 态：policy-changed held（入队不投·零效果行）
    const pcHeld = engine.ticketRepo.inputRows('tk-held').find((row) => row.kind === 'policy-changed');
    assert.ok(pcHeld !== undefined, '票2 收 policy-changed（入队）');
    assert.deepEqual(engine.ticketRepo.get('tk-held')!.undelivered, [], 'held 让位：waitsForPerson 票零投递');
    assert.equal(engine.effects.pending('deliver-input', `tk-held.${pcHeld!.id}`), false, 'held 票零 deliver 效果行');
    assert.equal(engine.effects.pending('start', 'tk-held'), false, 'held 票零 start 效果行');

    // (c) r-1 disabled→票1 rules disabled 面（原型 L151）
    const sC: Settings = { paused: false, policy: { rules: [{ ...R1, enabled: false }], sources: { test: { allowed: [{ id: 'person-1' }], bots: [] } } }, eval: { mode: 'off' } };
    const effectsC = engine.applySettings(sC);
    assert.deepEqual(effectsC.get('tk-rules')?.rules, [{ id: 'r-1', name: 'R1', change: 'disabled' }]);
    const pcRules = engine.ticketRepo.inputRows('tk-rules').find((row) => row.kind === 'policy-changed');
    assert.ok(pcRules !== undefined, '票1 收 policy-changed');
    assert.equal(pcRules!.value.policy?.from !== undefined && pcRules!.value.policy?.to !== undefined, true, 'value 带 from/to 版本对');

    // 支⑤同版本对反复切换→id 含 at 新输入（原型 L205 注·直调白盒面）
    const effect: PolicyEffect = { rules: [{ id: 'r-1', name: 'R1', change: 'disabled' }] };
    engine.tickets.policyChanged('vA', 'vB', new Map([['tk-rules', effect]]));
    engine.tickets.policyChanged('vA', 'vB', new Map([['tk-rules', effect]]));
    const directRows = engine.ticketRepo.inputRows('tk-rules').filter((row) => row.value.policy?.from === 'vA' && row.value.policy?.to === 'vB');
    assert.equal(directRows.length, 2, '同版本对反复仍记两条新输入');
    assert.notEqual(directRows[0]!.id, directRows[1]!.id, 'id 含 at 区分');
    assert.notEqual(directRows[0]!.at, directRows[1]!.at, 'at 推进');
  });

  it('案F·settings 跨 reload 持久（硬门①同族）：applySettings→真重开→谱仍在+version 对平', async () => {
    engine = Engine.open(TEST_DIR);
    const s = settingsWith({ mode: 'auto', rules: [R1] });
    engine.applySettings(s);
    const v1 = engine.policy.version;
    assert.equal(engine.policy.mode, 'auto');
    await engine.stop();
    engine = undefined;
    // 真重开同库 boot 链（第四型盲区正形）
    engine = Engine.open(TEST_DIR);
    assert.equal(engine.policy.mode, 'auto', '重开读持久 settings');
    assert.equal(engine.policy.version, v1, 'version 对平');
  });
});

describe('N5 基础面', () => {
  it('案C·policyVersion 哈希（裁⑤）：32 hex 形·授权面变→变·paused 变→不变（原型 L114 注）', () => {
    const v0 = policyVersion(settingsWith());
    assert.match(v0, /^[0-9a-f]{32}$/, 'sha256 前 32 hex 形');
    assert.notEqual(policyVersion(settingsWith({ mode: 'auto' })), v0, 'mode 进哈希');
    assert.notEqual(policyVersion(settingsWith({ rules: [R1] })), v0, 'rules 进哈希');
    assert.notEqual(policyVersion(settingsWith({ sources: { test: { allowed: [{ id: 'person-2' }] } } })), v0, 'sources 进哈希');
    assert.equal(policyVersion({ ...settingsWith(), paused: true }), v0, 'paused 不进哈希（原型 L114 正形）');
  });

  it('案E·validateSettings 校验谱（裁面①）+SettingsRepo 单行持久读写', () => {
    assert.equal(validateSettings(DEFAULT_SETTINGS).eval.mode, 'off');
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, paused: 'yes' }), UserError);
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, policy: { rules: 'x', sources: {} } }), UserError);
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, policy: { rules: [{ id: 1 }], sources: {} } }), UserError);
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, eval: { mode: 'turbo' } }), UserError);
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, policy: { rules: [], sources: { test: { allowed: 'x' } } } }), UserError);
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, policy: { rules: [], sources: { test: { allowed: [], admission: { r1: { unlistedUnaddressed: 'turbo' } } } } } }), UserError);
    // SettingsRepo 单行读写（validateSettings 回读面）
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    const repo = new SettingsRepo(store.db);
    assert.equal(repo.get(), undefined);
    repo.put(settingsWith({ mode: 'auto', rules: [R1] }));
    assert.equal(repo.get()!.eval.mode, 'auto');
    assert.equal(repo.get()!.policy.rules[0]!.id, 'r-1');
    repo.put(settingsWith()); // 覆盖写（单行 upsert）
    assert.equal(repo.get()!.eval.mode, 'off');
  });
});
