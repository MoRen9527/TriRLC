// ── N4 票域 Tickets/Assignments（形三 α · N4 票域并入·设计卷 §一/§二落形）──
//
// 思想源=dsh-superagent 原型 src/core/{tickets,assignments,model,stage}.ts
// （805 行全读·补读笔记 9f37e4e75；model.ts 353 行+stage.ts 26 行补读对表=
// 条件执行注 §七A·设计卷 948171ee0）。思想复用≠代码照抄——原型 JSON 形 O(n)
// 三点（addInput 线性扫/report 嵌套 find/wake 逐 id 全扫）由 v2 拆表 PK 索引
// 自然消解（判定书①裁面）。
//
// 表形（判定书①采认拆表形）：
//   ticket(id PK, value JSON)+部分索引 ticket_open（ended IS NULL——open 扫描）
//   ticket_input(ticket_id, input_id PK·INSERT OR IGNORE 幂等=消解原型 L235
//   线性扫描)——input 的 readAt/read 态面归 ReadTracker 独立表（β-3 已落·
//   单一真源注）；deliveredTo=票域投递链记录存 input value（非 read 态·§七A
//   对照落形）；assignment 嵌 ticket value JSON（生命周期 state 转换简单·不拆
//   表——设计卷 §一如实注）。
//
// retry 门正形（判定书③条件件·§七A 修正后落形·照原型 stage.ts L24-26+model.ts
// L349-353 谓词移植）：canRetry = !ended ∧ (waitsForPerson ∨ !!delivery)；
// waitsForPerson = 最新 assignment report∈{blocked,failed} ∧ 此后无
// human∧!context∧at>report.at 的 trigger input（lifts：更晚非 blocked/failed
// report·人的消息·retry 起新 assignment）。
//
// readUntil 真信源（§七A.1 收口·照原型 model.ts L341-344）：
//   max(latest report.at, max(各 assignment idleAt))——end/settle 已读截止线。
//
// executor port 映射（判定书②附注·首版 handler 链落形）：原型
// options.executor.start/deliver→v2=effects.enqueue 效果行——'start'（票级·
// pending 非 waitsForPerson 起面）/'deliver-input'（input 级·running 投面）
// 行留库候消费（worker Session=嫁接域 N5/N6）；closing 检查移 handler 面=
// 票域 mutation 入口自感 closingFlag（判定书三.1 注入形）。
//
// 范围裁减（判定书②）：首版落 create/addInput/end/retry/wake/stop 六核心+
// Assignments started/delivered/read/turnEnded/deliveryFailed/report 六面+
// Policy 最小门（policy.ts）；threads/triggers/disposition/Eval/Executor/
// worker Session/interrupted/restart（host 恢复面 assignments L83-92+
// tickets L318-327）全部划出=嫁接域。letGo 落基础形（end 时 undelivered 清+
// assignments 标 ended——queueForEval=嫁接时接留注释锚）。

import type { DatabaseSync } from 'node:sqlite';
import { UserError } from './errors.js';
import type { Mandate, PolicyEffect } from './policy.js';
import type { Effects } from './effects.js';
import type { ReadTracker } from './read-tracker.js';
import type { V2Store } from './store.js';

/** Write-only address on a thread（照原型 model.ts L9）。 */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

/** Assignment 报告态六值域（照原型 model.ts L216）。 */
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped';
export type TicketEndBy = 'executor' | 'human';
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped';

/** 赋值面（嵌 ticket value JSON·照原型 model.ts L218-233 裁减形）。 */
export interface TicketAssignment {
  id: string;
  state: 'pending' | 'running' | 'ended';
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  endedReason?: string;
  report?: { state: ReportState; summary: string; at: string };
  /** Inputs 最后到达 worker 的时点（原型 L226-227）。 */
  deliveredAt?: string;
  /** Turn ended with nothing left to run/waiting（原型 L228-232·readUntil 组成面）。 */
  idleAt?: string;
}

/** 票主体（ticket.value JSON·设计卷 §一清单+§七A 正形对照）。 */
export interface TicketRecord {
  id: string;
  title: string;
  decisionId: string;
  mandate: Mandate;
  channels: ChannelRef[];
  /** Follow 线程壳（首版零 bind 面=恒空数组·queueForEval/followsDone 完整谱=嫁接域）。 */
  follows: { thread: string; own: boolean; closed?: { at: string; outcome: 'merged' | 'closed' } }[];
  assignments: TicketAssignment[];
  /** Inputs 未投 running assignment 的 id 序（队首=先投）。 */
  undelivered: string[];
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string };
  attention?: { id: string; question: string; triggerId?: string };
  answers?: string[];
  /** Latest failed delivery until a delivery succeeds（原型 L306-307·canRetry 组成面）。 */
  delivery?: { error: string; at: string };
  origin: { triggerId: string; triggerIds: string[] };
  createdAt: string;
  updatedAt: string;
}

export type TicketInputKind = 'trigger' | 'policy-changed' | 'reopen' | 'resumed' | 'text' | 'note';

/** 票输入行（ticket_input 表投影·kind 六值域照原型 model.ts L235-257）。 */
export interface TicketInputRecord {
  id: string;
  kind: TicketInputKind;
  at: string;
  /** Variant 特有面（text/triggerId/human/context/deliveredTo/policy——read 态面归 ReadTracker）。 */
  value: {
    text?: string;
    triggerId?: string;
    human?: boolean;
    context?: boolean;
    /** 最后投给的 assignment id（投递链记录·非 read 态——§七A 对照落形）。 */
    deliveredTo?: string;
    /** policy-changed 输入携带（N5·from/to 版本对+效果面——原型 L206 输入形投影）。 */
    policy?: { from: string; to: string; effect: PolicyEffect };
  };
}

/** 停机旗 holder（判定书三.1 注入形：票域持 holder 不回指 Engine=零环形）。 */
export interface ClosingFlag { closing: boolean }

/** 票域组合依赖（Engine 组合注入面·依赖单向零环形）。 */
export interface TicketDomainDeps {
  store: Pick<V2Store, 'atomic'>;
  effects: Pick<Effects, 'enqueue'>;
  readTracker: Pick<ReadTracker, 'markDelivered' | 'ack' | 'settle' | 'stateOf'>;
  policy: PolicyLike;
  closingFlag: ClosingFlag;
  /** N7 status 联动面（裁⑧收口·可选注入——缺省 undefined=零联动 N4 组合零改）。 */
  seats?: Pick<import('./seats.js').SeatRepo, 'get' | 'put'>;
}

/**
 * N7 status 联动（门①裁④+裁量注①·设计卷 ec79feb7d §二.2）：票 mandate.actor.id
 * 经 seats.get 命中席名→全字段写翻转 status（get 回读展开 `{...seat, status}` put
 * 经 validateSeat 门·禁部分字段写）；非席名/零 deps/同态幂等零写。调用方在
 * atomic 事务内调（联动写与票写同事务原子）。
 */
function touchSeat(deps: TicketDomainDeps, ticket: TicketRecord, status: 'busy' | 'idle'): void {
  const seats = deps.seats;
  if (seats === undefined) return;
  const seat = seats.get(ticket.mandate.actor.id);
  if (seat === undefined || seat.status === status) return;
  seats.put({ ...seat, status });
}

/** Policy 消费面（wake paused/revalidate 门——policy.ts Policy 结构子集）。 */
export interface PolicyLike {
  paused: boolean;
  revalidate(mandate: Mandate): boolean;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_open ON ticket(id) WHERE json_extract(value, '$.ended') IS NULL;
CREATE TABLE IF NOT EXISTS ticket_input (
  ticket_id TEXT NOT NULL, input_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, input_id)
);
`;

/** 票域表仓储：裸 SQL 面（mutation 原子性归 Tickets/Assignments 的 store.atomic 包裹）。 */
export class TicketRepo {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  put(ticket: TicketRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO ticket (id, value) VALUES (?, ?)')
      .run(ticket.id, JSON.stringify(ticket));
  }

  get(id: string): TicketRecord | undefined {
    const row = this.db.prepare('SELECT value FROM ticket WHERE id = ?').get(id) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as TicketRecord;
  }

  /** Open 票 id（部分索引 ticket_open 扫描面）。 */
  openIds(): string[] {
    return (this.db.prepare("SELECT id FROM ticket WHERE json_extract(value, '$.ended') IS NULL ORDER BY rowid")
      .all() as { id: string }[]).map((row) => row.id);
  }

  /** Open 票全记录·createdAt 升序（N5 policyChanged oldest first 面·原型 L203 语义）。 */
  openTickets(): TicketRecord[] {
    return (this.db.prepare(
      "SELECT value FROM ticket WHERE json_extract(value, '$.ended') IS NULL "
      + "ORDER BY json_extract(value, '$.createdAt'), rowid",
    ).all() as { value: string }[]).map((row) => JSON.parse(row.value) as TicketRecord);
  }

  /** 输入行插入（INSERT OR IGNORE=PK 天然幂等·消解原型 L235 线性扫描）。 */
  addInputRow(ticketId: string, input: TicketInputRecord): boolean {
    return Number(this.db.prepare(
      'INSERT OR IGNORE INTO ticket_input (ticket_id, input_id, kind, value, at) VALUES (?, ?, ?, ?, ?)',
    ).run(ticketId, input.id, input.kind, JSON.stringify(input.value), input.at).changes) > 0;
  }

  /** 输入行全读（插入序=rowid 序=入队序）。 */
  inputRows(ticketId: string): TicketInputRecord[] {
    return (this.db.prepare('SELECT kind, value, at, input_id FROM ticket_input WHERE ticket_id = ? ORDER BY rowid')
      .all(ticketId) as { kind: string; value: string; at: string; input_id: string }[]).map((row) => ({
      id: row.input_id,
      kind: row.kind as TicketInputKind,
      at: row.at,
      value: JSON.parse(row.value) as TicketInputRecord['value'],
    }));
  }

  /** 输入行读改写（deliveredTo 面·返回是否命中）。 */
  updateInputValue(ticketId: string, inputId: string, patch: Partial<TicketInputRecord['value']>): boolean {
    const rows = this.inputRows(ticketId);
    const input = rows.find((row) => row.id === inputId);
    if (input === undefined) return false;
    this.db.prepare('UPDATE ticket_input SET value = ? WHERE ticket_id = ? AND input_id = ?')
      .run(JSON.stringify({ ...input.value, ...patch }), ticketId, inputId);
    return true;
  }
}

/** automatic 输入判（照原型 tickets.ts L11 谓词：非 trigger 或非 human）。 */
const automatic = (input: TicketInputRecord): boolean => input.kind !== 'trigger' || input.value.human !== true;

/**
 * 票是否在等人（照原型 model.ts L349-353 正形移植·§七A）：
 * 最新 assignment report∈{blocked,failed} 且此后无 human∧!context∧at>report.at
 * 的 trigger input。lifts：更晚非 blocked/failed report·人的消息·retry。
 */
export function waitsForPerson(ticket: TicketRecord, inputs: readonly TicketInputRecord[]): boolean {
  const report = ticket.assignments.at(-1)?.report;
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false;
  return !inputs.some((input) => input.kind === 'trigger' && input.value.human === true
    && input.value.context !== true && input.at > report.at);
}

/**
 * 票可否 retry（判定书③条件件正形·照原型 stage.ts L24-26+model.ts L349-353）：
 * open ticket stalled on a blocked/failed report without a newer human
 * follow-up, or has a failed input delivery。
 */
export function canRetry(ticket: TicketRecord, inputs: readonly TicketInputRecord[]): boolean {
  return ticket.ended === undefined && (waitsForPerson(ticket, inputs) || ticket.delivery !== undefined);
}

/** 已读截止线（照原型 model.ts L341-344 正形·§七A.1：max(latest report.at, max idleAt)）。 */
function readUntil(ticket: TicketRecord): string {
  const report = [...ticket.assignments].reverse().find((assignment) => assignment.report !== undefined)?.report;
  const maxIdle = ticket.assignments.reduce(
    (max, assignment) => (assignment.idleAt !== undefined && assignment.idleAt > max ? assignment.idleAt : max), '',
  );
  const reportAt = report?.at ?? '';
  return reportAt > maxIdle ? reportAt : maxIdle;
}

/** 同渠道判（照原型 tickets.ts sameChannel L12 JSON 比对）。 */
const sameChannel = (a: ChannelRef, b: ChannelRef): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Tickets 六核心（判定书②采认范围）：create/addInput/end/retry/wake/stop。
 * 全 mutation 走 store.atomic（票域事务面·emit enqueue 在 atomic 内=微任务
 * 天然提交后跑·store.ts 注释锚）；方法入口自感 closingFlag（判定书三.1）。
 */
export class Tickets {
  constructor(private readonly deps: TicketDomainDeps, private readonly repo: TicketRepo) {}

  private guardClosing(): void {
    if (this.deps.closingFlag.closing) throw new UserError('The engine is closing');
  }

  private guard(ticketId: string): TicketRecord {
    const ticket = this.repo.get(ticketId);
    if (ticket === undefined) throw new UserError(`Unknown ticket: ${ticketId}`);
    return ticket;
  }

  private emit(eventName: string, ticketId: string, payload: Record<string, unknown>): void {
    this.deps.effects.enqueue('emit', `${eventName}.${ticketId}`, payload);
  }

  /**
   * 开票（原型 create L37-56 裁减形）：票+mandate+channels 去重（sameChannel
   * JSON 比对）+first assignment（pending·id=assignment:<ticketId>:<n>）+
   * emit ticket.created。原型 subscribe triggers/ack（replies 面）=嫁接域划出。
   */
  create(input: {
    id: string;
    title: string;
    mandate: Mandate;
    channels: ChannelRef[];
    decisionId: string;
    origin: { triggerId: string; triggerIds: string[] };
    at?: string;
  }): TicketRecord {
    this.guardClosing();
    return this.deps.store.atomic(() => {
      if (this.repo.get(input.id) !== undefined) throw new UserError(`Ticket already exists: ${input.id}`);
      const at = input.at ?? new Date().toISOString();
      const channels: ChannelRef[] = [];
      for (const channel of input.channels) {
        if (!channels.some((existing) => sameChannel(existing, channel))) channels.push(channel);
      }
      const ticket: TicketRecord = {
        id: input.id,
        title: input.title,
        decisionId: input.decisionId,
        mandate: input.mandate,
        channels,
        follows: [],
        assignments: [{ id: `assignment:${input.id}:0`, state: 'pending', createdAt: at }],
        undelivered: [],
        origin: input.origin,
        createdAt: at,
        updatedAt: at,
      };
      this.repo.put(ticket);
      this.emit('ticket.created', ticket.id, { title: ticket.title });
      return ticket;
    });
  }

  /**
   * 入输入（原型 addInput L234-245 裁减形）：PK 幂等（INSERT OR IGNORE·重复
   * id 零重入 return false）+held 让位（live∧automatic∧waitsForPerson→不入
   * undelivered——自动输入让位给人等待 L237-239）+派发面（running→
   * 'deliver-input' 效果行/pending 且非 waitsForPerson→'start' 效果行=
   * executor.start/deliver 映射·行留库候消费）。ended 票：非 held 面 human
   * 输入照原型积压 undelivered（wake 复活消费）。
   */
  addInput(ticketId: string, input: {
    id: string;
    kind: TicketInputKind;
    at: string;
    text?: string;
    triggerId?: string;
    human?: boolean;
    context?: boolean;
    /** policy-changed 输入携带面（N5·Tickets.policyChanged 消费）。 */
    policy?: { from: string; to: string; effect: PolicyEffect };
  }): boolean {
    this.guardClosing();
    return this.deps.store.atomic(() => {
      const ticket = this.guard(ticketId);
      const record: TicketInputRecord = {
        id: input.id,
        kind: input.kind,
        at: input.at,
        value: {
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.triggerId !== undefined ? { triggerId: input.triggerId } : {}),
          ...(input.human === true ? { human: true } : {}),
          ...(input.context === true ? { context: true } : {}),
          ...(input.policy !== undefined ? { policy: input.policy } : {}),
        },
      };
      if (!this.repo.addInputRow(ticketId, record)) return false; // PK 幂等
      const inputs = this.repo.inputRows(ticketId);
      const held = ticket.ended === undefined && automatic(record) && waitsForPerson(ticket, inputs);
      if (!held) {
        ticket.undelivered.push(input.id);
        const latest = ticket.assignments.at(-1);
        if (latest?.state === 'running') {
          this.deps.effects.enqueue('deliver-input', `${ticketId}.${input.id}`, { inputId: input.id });
        } else if (latest?.state === 'pending' && !waitsForPerson(ticket, inputs)) {
          this.deps.effects.enqueue('start', ticketId, { assignmentId: latest.id });
        }
      }
      ticket.updatedAt = new Date().toISOString();
      this.repo.put(ticket);
      return true;
    });
  }

  /**
   * 终局（原型 end L345-363 裁减形）：liveTicket 幂等（已 ended return false）+
   * settle 票末收敛（§七A.1 readUntil 正形=已读截止线——已投（delivered/read
   * 态）inputs 照 β-3 批量 settle·delivered→settled 直跳=原型票末收敛语义正身）
   * +ended 记录+undelivered 清+assignments 标 ended+attention 清（原型 L287 注）
   * +emit ticket.ended/assignment.ended。executor.stop 逐个=assignment 标 ended
   * 覆盖（v2 无 executor 进程面·如实注）；letGo queueForEval=嫁接时接留锚。
   */
  end(ticketId: string, input: { by: TicketEndBy; outcome: TicketOutcome; reason?: string; at?: string }): boolean {
    this.guardClosing();
    return this.deps.store.atomic(() => {
      const ticket = this.guard(ticketId);
      if (ticket.ended !== undefined) return false; // liveTicket 幂等
      const at = input.at ?? new Date().toISOString();
      // 票末收敛：已投 inputs（delivered/read 态）批量 settle——未投递（undelivered/
      // held）零 settle 行（ReadTracker 无行自然跳过=原型 waiting 面）。
      for (const row of this.repo.inputRows(ticketId)) {
        const state = this.deps.readTracker.stateOf(row.id);
        if (state === 'delivered' || state === 'read') this.deps.readTracker.settle(row.id);
      }
      ticket.ended = { at, by: input.by, outcome: input.outcome, ...(input.reason !== undefined ? { reason: input.reason } : {}) };
      ticket.undelivered = [];
      touchSeat(this.deps, ticket, 'idle'); // N7 status 联动（裁⑧·事务内同写）
      for (const assignment of ticket.assignments) {
        if (assignment.state !== 'ended') {
          assignment.state = 'ended';
          assignment.endedAt = at;
          assignment.endedReason = `${input.by}:${input.outcome}`;
        }
      }
      ticket.attention = undefined;
      ticket.updatedAt = at;
      this.repo.put(ticket);
      this.emit('ticket.ended', ticketId, { by: input.by, outcome: input.outcome });
      this.emit('assignment.ended', ticketId, { ticketId });
      return true;
    });
  }

  /**
   * 重试（原型 retry L168-180·判定书③条件件正形门）：canRetry 门
   * （!ended∧(waitsForPerson∨!!delivery)——§七A 修正后正形）拒→UserError；
   * 通过=新 assignment（pending·序号递进）+requeueUntaken（原型 L333-337：
   * 已投未读（ReadTracker delivered 态=readAt null 哨兵同构）且
   * deliveredTo=被替换 assignment 的 trigger input 重排队首归新 assignment——
   * context 输入排除=v2 裁量如实注）。delivery 不在此清（照原型：投递成功面
   * 清——Assignments.delivered 消费）。
   */
  retry(ticketId: string, at?: string): TicketAssignment {
    this.guardClosing();
    return this.deps.store.atomic(() => {
      const ticket = this.guard(ticketId);
      const inputs = this.repo.inputRows(ticketId);
      if (!canRetry(ticket, inputs)) throw new UserError(`The ticket is not retriable: ${ticketId}`);
      const replaced = ticket.assignments.at(-1)!;
      const assignment: TicketAssignment = {
        id: `assignment:${ticketId}:${ticket.assignments.length}`,
        state: 'pending',
        createdAt: at ?? new Date().toISOString(),
      };
      ticket.assignments.push(assignment);
      // requeueUntaken：已投未读+deliveredTo=replaced 的 trigger 输入重排队首。
      const untaken = inputs.filter((row) => row.kind === 'trigger' && row.value.context !== true
        && this.deps.readTracker.stateOf(row.id) === 'delivered' && row.value.deliveredTo === replaced.id);
      for (const row of [...untaken].reverse()) {
        this.repo.updateInputValue(ticketId, row.id, { deliveredTo: assignment.id });
        ticket.undelivered = [row.id, ...ticket.undelivered.filter((id) => id !== row.id)];
      }
      ticket.updatedAt = assignment.createdAt;
      this.repo.put(ticket);
      return assignment;
    });
  }

  /**
   * 复活（原型 wake L252-270 门谱）：ended 票收到 human trigger 时走——
   * ①未 ended→UserError（open 票走 addInput 谱）；②human stop 不自动复活；
   * ③paused 拒；④revalidate 拒→UserError（原型 refuse 记录面=嫁接域候·v2
   * 首版显式败如实注）；⑤只 human 复活（bot/CI 与 end 前输入同排等待）。
   * 通过=ended 清+resumed marker 入 undelivered 队首（先于积压投递·原型 L261）
   * +emit ticket.resumed。
   */
  wake(ticketId: string, trigger: { id: string; human: boolean; at: string }): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const ticket = this.guard(ticketId);
      if (ticket.ended === undefined) throw new UserError(`The ticket is open: ${ticketId}`);
      if (ticket.ended.by === 'human') throw new UserError('A human-stopped ticket does not resume on its own');
      if (!trigger.human) throw new UserError('Only a human trigger can resume an ended ticket');
      if (this.deps.policy.paused) throw new UserError('Policy is paused');
      if (!this.deps.policy.revalidate(ticket.mandate)) {
        throw new UserError('Policy revalidation refused the wakeup');
      }
      ticket.ended = undefined;
      const markerId = `resumed:${trigger.id}:${trigger.at}`;
      this.repo.addInputRow(ticketId, {
        id: markerId, kind: 'resumed', at: trigger.at, value: { triggerId: trigger.id },
      });
      ticket.undelivered = [markerId, ...ticket.undelivered];
      ticket.updatedAt = new Date().toISOString();
      this.repo.put(ticket);
      this.emit('ticket.resumed', ticketId, { triggerId: trigger.id });
    });
  }

  /** 人停（原型 stop L160-163 形=end(by='human', outcome='stopped')便捷面）。 */
  stop(ticketId: string, reason?: string, at?: string): boolean {
    return this.end(ticketId, { by: 'human', outcome: 'stopped', ...(reason !== undefined ? { reason } : {}), at });
  }

  /**
   * Policy 变更增量通知（原型 policyChanged L200-208 正形·N5 并入）：逐 open
   * 票 oldest first（createdAt 升序=投递按接受序）·effect 命中→addInput
   * （kind='policy-changed'·held 让位语义自然适用——waitsForPerson 票入队不投；
   * id 含 at：同版本对反复切换仍记新输入·原型 L205 注）。空 effects=零通知面。
   */
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect>): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const at = new Date().toISOString();
      for (const ticket of this.repo.openTickets()) {
        const effect = effects.get(ticket.id);
        if (effect === undefined) continue;
        this.addInput(ticket.id, {
          id: `policy:${ticket.id}:${from}->${to}:${at}`,
          kind: 'policy-changed',
          at,
          policy: { from, to, effect },
        });
      }
    });
  }
}

/**
 * Assignments 报告面（判定书②采认范围）：started/delivered/read/turnEnded/
 * deliveryFailed/report。持 tickets 回引（report ready/dropped→end 联动·
 * 原型 assignments.report L129-132）——Assignments→Tickets 单向零环形。
 * replies 依赖划出（判定书④语义注）：withdrawAttention/replies 槽位=嫁接位
 * 注释锚·不落首版（closingFlag 不经 replies 参数位传递）。
 */
export class Assignments {
  constructor(
    private readonly deps: TicketDomainDeps,
    private readonly repo: TicketRepo,
    private readonly tickets: Tickets,
  ) {}

  private guardClosing(): void {
    if (this.deps.closingFlag.closing) throw new UserError('The engine is closing');
  }

  private guardPair(ticketId: string, assignmentId: string): { ticket: TicketRecord; assignment: TicketAssignment } {
    const ticket = this.repo.get(ticketId);
    if (ticket === undefined) throw new UserError(`Unknown ticket: ${ticketId}`);
    const assignment = ticket.assignments.find((row) => row.id === assignmentId);
    if (assignment === undefined) throw new UserError(`Unknown assignment: ${assignmentId}`);
    return { ticket, assignment };
  }

  private emit(eventName: string, ticketId: string, payload: Record<string, unknown>): void {
    this.deps.effects.enqueue('emit', `${eventName}.${ticketId}`, payload);
  }

  /** 起跑（原型 started L34-43）：pending→running+startedAt 首记（??=）+
   *  undelivered flush（逐 input 'deliver-input' 效果行）+emit assignment.started。
   *  running 重入幂等零变；ended→UserError。 */
  started(ticketId: string, assignmentId: string, at?: string): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const { ticket, assignment } = this.guardPair(ticketId, assignmentId);
      if (assignment.state === 'ended') throw new UserError(`The assignment has ended: ${assignmentId}`);
      if (assignment.state === 'running') return; // 幂等重入
      const now = at ?? new Date().toISOString();
      assignment.state = 'running';
      assignment.startedAt ??= now;
      for (const inputId of ticket.undelivered) {
        this.deps.effects.enqueue('deliver-input', `${ticketId}.${inputId}`, { inputId });
      }
      ticket.updatedAt = now;
      this.repo.put(ticket);
      touchSeat(this.deps, ticket, 'busy'); // N7 status 联动（裁⑧·事务内同写）
      this.emit('assignment.started', ticketId, { assignmentId });
    });
  }

  /** 投达（原型 delivered L48-58）：undelivered 剔+deliveredAt 首记+逐 input
   *  deliveredTo=assignmentId+ReadTracker.markDelivered（β-3 delivery 段正身）
   *  +ticket.delivery 清（「until a delivery succeeds」——投递成功面）。 */
  delivered(ticketId: string, assignmentId: string, inputIds: readonly string[], at?: string): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const { ticket, assignment } = this.guardPair(ticketId, assignmentId);
      const now = at ?? new Date().toISOString();
      ticket.undelivered = ticket.undelivered.filter((id) => !inputIds.includes(id));
      assignment.deliveredAt ??= now;
      for (const inputId of inputIds) {
        this.repo.updateInputValue(ticketId, inputId, { deliveredTo: assignmentId });
        this.deps.readTracker.markDelivered(inputId);
      }
      ticket.delivery = undefined;
      ticket.updatedAt = now;
      this.repo.put(ticket);
    });
  }

  /** 已读（β-3 read 段·显式 ack 面）：逐 input ReadTracker.ack——返回 ack 命中数。 */
  read(inputIds: readonly string[]): number {
    this.guardClosing();
    let acked = 0;
    this.deps.store.atomic(() => {
      for (const inputId of inputIds) {
        if (this.deps.readTracker.ack(inputId)) acked += 1;
      }
    });
    return acked;
  }

  /** Turn 收尾（原型 turnEnded L66-71 裁减形）：idleAt 首记（??=·readUntil 组成面）。 */
  turnEnded(ticketId: string, assignmentId: string, at?: string): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const { ticket, assignment } = this.guardPair(ticketId, assignmentId);
      assignment.idleAt ??= at ?? new Date().toISOString();
      ticket.updatedAt = assignment.idleAt;
      this.repo.put(ticket);
    });
  }

  /** 投递失败记录（原型 deliveryFailed L72-77）：ticket.delivery={error, at}——
   *  canRetry 组成面（!!delivery 支·直到下次投递成功清）。 */
  deliveryFailed(ticketId: string, error: string, at?: string): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const ticket = this.repo.get(ticketId);
      if (ticket === undefined) throw new UserError(`Unknown ticket: ${ticketId}`);
      ticket.delivery = { error, at: at ?? new Date().toISOString() };
      ticket.updatedAt = ticket.delivery.at;
      this.repo.put(ticket);
    });
  }

  /**
   * 报告（原型 report L99-134 裁减形）：UserError 谱（unknownAssignment/
   * ticketEnded/assignmentEnded/questionWithResult——question 配非 asking 态/
   * askerWithoutQuestion——asking 态缺 question）+report={state, summary, at}
   * 记+attention 生命周期（asking 置·非 asking 清）+blocked/failed→undelivered
   * 剔 automatic（原型 L126）+ready/dropped→end 联动（原型 L129-132 outcome 谱·
   * 首版 follows 空=followsDone vacuous true→ready 即 completed 终局判·如实注）。
   * answers→takeUp/withdrawAttention（replies 面）=嫁接位注释锚不落首版。
   */
  report(ticketId: string, assignmentId: string, input: {
    state: ReportState;
    summary: string;
    question?: string;
    triggerId?: string;
    at?: string;
  }): void {
    this.guardClosing();
    this.deps.store.atomic(() => {
      const { ticket, assignment } = this.guardPair(ticketId, assignmentId);
      if (ticket.ended !== undefined) throw new UserError(`The ticket has ended: ${ticketId}`);
      if (assignment.state === 'ended') throw new UserError(`The assignment has ended: ${assignmentId}`);
      const asking = input.state === 'waiting' || input.state === 'blocked' || input.state === 'failed';
      if (input.question !== undefined && !asking) {
        throw new UserError('A question goes with a waiting, blocked, or failed report');
      }
      if (input.question === undefined && asking) {
        throw new UserError(`A ${input.state} report needs a question`);
      }
      const at = input.at ?? new Date().toISOString();
      assignment.report = { state: input.state, summary: input.summary, at };
      if (asking && input.question !== undefined) {
        ticket.attention = { id: `attention:${assignmentId}:${at}`, question: input.question, ...(input.triggerId !== undefined ? { triggerId: input.triggerId } : {}) };
      } else if (!asking) {
        ticket.attention = undefined;
      }
      if (input.state === 'blocked' || input.state === 'failed') {
        const inputs = this.repo.inputRows(ticketId);
        ticket.undelivered = ticket.undelivered.filter((id) => {
          const row = inputs.find((candidate) => candidate.id === id);
          return row !== undefined && !automatic(row); // 剔 automatic·保 human 输入
        });
      }
      ticket.updatedAt = at;
      this.repo.put(ticket);
      // ready/dropped→followsDone 联动 end（首版 follows 恒空=vacuous true）。
      if (input.state === 'ready' || input.state === 'dropped') {
        this.tickets.end(ticketId, {
          by: 'executor',
          outcome: input.state === 'ready' ? 'completed' : 'dropped',
          at,
        });
      }
    });
  }
}
