// ── N1 Engine 组合根+N2/N3 并入（形三 α · 门①裁定四点 2026-11-06）──
//
// 构造序（原型 runtime.ts 取舍·轻量形）：acquireDirectoryLock（①目录锁先行·
// 锁失败零资源泄漏）→V2Store 开库→组合 v2 三件（Effects 先建=effect 表 DDL·
// receipts behind 联查依赖其 attempts 列；constructor 注入形零改——β 链测试
// 组合序即正形）→effects.start()（start 前入队行等待·照原型 setup 未完语义）。
// 停机序（原型 shutdown 序取舍）：closing→effects.drain()（停新起等运行中·
// 等待行留库下次 start）→store.close()→lock.release()（锁最后放照原型）。
//
// 单线程面三段确认（CTO 语义注⑤落形·v2 事务面单线程假设成立）：
//   ①目录锁禁二实例=lock.ts 正身（跨进程互斥封）
//   ②进程内 node 单线程事件环+Effects dispatch queueMicrotask 单飞（β-2 已落）
//     =无并发事务面
//   ③Engine 不暴露多线程入口（零 Worker/线程 API）
//   →read-tracker transition 跳段拒 INSERT 的 TOCTOU 窗封死；多 Promise 交错
//   =事件环交错非并行（交错案断言零乱序）。
//
// N2/N3 并入挂接（β 件零改·wrapper 形已定谳 β-3 毕报 §六）：deliverAndTrack=
// receipts.deliver 收敛 sent→readTracker.markDelivered（dropped 零 mark·Later/
// 异常冒泡零 mark——未送达不标已读）。settled 段挂接=票末收敛（settleTicket
// 批量 API 位落·N4 票域生命周期面接——裁定④谱位确认）。
//
// N4 并入（票域 Tickets/Assignments+Policy 最小门·设计卷 eea70d9c6/948171ee0）：
// 组合序扩（依赖单向零环形·判定书三.1）：…→ReadTracker→Policy→TicketRepo→
// Tickets→Assignments（持 tickets 回引=report→end 联动·Assignments→Tickets
// 单向）。closingFlag holder 形（判定书三.1）：票域持 holder 注入·不回指
// Engine——closing getter 引 holder·stop() 置 holder；票域 mutation 入口自感。
// reply handler（判定书②附注 transport 施工定谳形）：open 注入 transport 时
// 注册 effects.handle('reply')→deliverAndTrack（closing 检查移 handler 面=
// deliverAndTrack 自感 closingFlag）；缺省不注册=行留库候消费（β 组合零改）。
//
// N5 并入（Policy 门族完整谱·设计卷 72edda33b §二·门①裁 2cfe40575）：组合序
// 再扩：SettingsRepo→Policy（从持久 settings 构建·空行落 DEFAULT_SETTINGS
// mode='off' 裁①）→…。applySettings=原子链：settings 写+policyEffects diff+
// tickets.policyChanged 增量通知同事务（settings 变更与通知原子性）·事务毕
// policy.rebind 换谱（holder 形·票域 deps 引用零破——失败回滚零换）。scope
// 注入=裁③缺省全收。
//
// N6 并入（Seats registry 第六 Pick·设计卷 72edda33b §三·门①裁 2cfe40575）：
// 组合序再扩：seedSeats（幂等灌 15 席种子·INSERT OR IGNORE 重开零冲已改）→
// SeatRepo→Seats（engine.seats 公开·list=列席面/resolve=点名解析·N8 send
// 消费面）。address 零拨号（本件只存不连）·status 静态裁⑧·name 值域=
// source-agents 正名 kebab-case 裁⑦。

import { acquireDirectoryLock, LockHeldError, type DirectoryLock } from './lock.js';
import { V2Store } from './store.js';
import { Effects } from './effects.js';
import { ReadTracker } from './read-tracker.js';
import { ReceiptsStore, type ReceiptTransport } from './receipts.js';
import {
  Policy, SettingsRepo, policyEffects, policyVersion,
  DEFAULT_SETTINGS, DEFAULT_SCOPE,
  type Settings, type ScopeResolver, type PolicyEffect,
} from './policy.js';
import { TicketRepo, Tickets, Assignments, type ClosingFlag } from './tickets.js';
import { Seats, SeatRepo, seedSeats } from './seats.js';

export { LockHeldError };
export type { DirectoryLock };
export type { ClosingFlag };

export class Engine {
  readonly store: V2Store;
  readonly effects: Effects;
  readonly readTracker: ReadTracker;
  readonly receipts: ReceiptsStore;
  readonly settingsRepo: SettingsRepo;
  /** Policy 实例（applySettings 域内换新——非 readonly 注：重建面收口本类）。 */
  policy: Policy;
  /** N6 Seats registry（第六 Pick·组合序：seedSeats 幂等灌→Seats 公开）。 */
  readonly seats: Seats;
  readonly tickets: Tickets;
  readonly assignments: Assignments;

  /** 停机旗 holder（判定书三.1 注入形·票域持此不回指 Engine=零环形）。 */
  readonly closingFlag: ClosingFlag = { closing: false };

  /** 票域表仓储（读面公开=测试/嫁接消费面·mutation 面=Tickets/Assignments 收口）。 */
  readonly ticketRepo: TicketRepo;

  private get closing(): boolean {
    return this.closingFlag.closing;
  }

  private constructor(store: V2Store, private readonly lock: DirectoryLock, private readonly scope: ScopeResolver) {
    this.store = store;
    this.effects = new Effects(store.db); // 先建：effect 表 DDL（receipts behind 联查依赖）
    this.receipts = new ReceiptsStore(store.db, this.effects);
    this.readTracker = new ReadTracker(store.db);
    this.settingsRepo = new SettingsRepo(store.db);
    this.policy = new Policy(this.settingsRepo.get() ?? DEFAULT_SETTINGS, scope);
    seedSeats(store.db);
    this.seats = new Seats(new SeatRepo(store.db));
    this.ticketRepo = new TicketRepo(store.db);
    this.tickets = new Tickets(
      { store, effects: this.effects, readTracker: this.readTracker, policy: this.policy, closingFlag: this.closingFlag },
      this.ticketRepo,
    );
    this.assignments = new Assignments(
      { store, effects: this.effects, readTracker: this.readTracker, policy: this.policy, closingFlag: this.closingFlag },
      this.ticketRepo,
      this.tickets,
    );
  }

  /**
   * N5 settings 变更原子链：settings 写+policyEffects diff+policyChanged 增量
   * 通知同事务（settings 变更与通知原子性·通知行随事务提交/回滚）；事务毕
   * policy.rebind 换谱（holder 形·票域 deps 引用零破——失败回滚零换谱）。
   * 返回逐票效果 Map（调用方面·同事务内已消费）。
   */
  applySettings(next: Settings): Map<string, PolicyEffect> {
    let effects!: Map<string, PolicyEffect>;
    this.store.atomic(() => {
      const old = this.settingsRepo.get() ?? DEFAULT_SETTINGS;
      this.settingsRepo.put(next);
      effects = policyEffects(this.ticketRepo.openTickets(), old, next, this.scope);
      this.tickets.policyChanged(policyVersion(old), policyVersion(next), effects);
    });
    this.policy.rebind(next, this.scope);
    return effects;
  }

  /** 组合根入口：锁→库→八件→（transport 注入时注册 reply handler）→start。 */
  static open(stateDir: string, options?: { transport?: ReceiptTransport; scope?: ScopeResolver }): Engine {
    const lock = acquireDirectoryLock(stateDir);
    let store: V2Store;
    try {
      store = new V2Store(stateDir);
    } catch (error) {
      lock.release();
      throw error;
    }
    let engine: Engine;
    try {
      engine = new Engine(store, lock, options?.scope ?? DEFAULT_SCOPE);
    } catch (error) {
      store.close();
      lock.release();
      throw error;
    }
    if (options?.transport !== undefined) {
      // reply 效果行消费链（closing 检查移 handler 面=deliverAndTrack 自感 flag）。
      const transport = options.transport;
      engine.effects.handle('reply', (_payload, key) => engine.deliverAndTrack(key, transport));
    }
    engine.effects.start();
    return engine;
  }

  /**
   * β-1 delivery→β-3 delivered 段挂接：deliver 正常收敛且终态 sent→mark；
   * dropped（targetGone/targetIgnored）零 mark；deliver 抛（Later/transport
   * 异常）冒泡零 mark。id 未登记（receipt 缺）→deliver 静默 return→零 mark。
   */
  async deliverAndTrack(id: string, transport: ReceiptTransport): Promise<void> {
    if (this.closingFlag.closing) throw new Error('The engine is closing');
    await this.receipts.deliver(id, transport);
    if (this.receipts.get(id)?.status === 'sent') this.readTracker.markDelivered(id);
  }

  /** 票末收敛 API 位（裁定④·批量 settle——N4 票域生命周期面接）。 */
  settleTicket(messageIds: readonly string[]): void {
    for (const id of messageIds) this.readTracker.settle(id);
  }

  /** 停机序：closing（holder 置位·票域同感）→drain→close→锁最后放。幂等。 */
  async stop(): Promise<void> {
    if (this.closingFlag.closing) return;
    this.closingFlag.closing = true;
    await this.effects.drain();
    this.store.close();
    this.lock.release();
  }
}
