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

import { acquireDirectoryLock, LockHeldError, type DirectoryLock } from './lock.js';
import { V2Store } from './store.js';
import { Effects } from './effects.js';
import { ReadTracker } from './read-tracker.js';
import { ReceiptsStore, type ReceiptTransport } from './receipts.js';

export { LockHeldError };
export type { DirectoryLock };

export class Engine {
  readonly store: V2Store;
  readonly effects: Effects;
  readonly readTracker: ReadTracker;
  readonly receipts: ReceiptsStore;

  private closing = false;

  private constructor(store: V2Store, private readonly lock: DirectoryLock) {
    this.store = store;
    this.effects = new Effects(store.db); // 先建：effect 表 DDL（receipts behind 联查依赖）
    this.receipts = new ReceiptsStore(store.db, this.effects);
    this.readTracker = new ReadTracker(store.db);
  }

  /** 组合根入口：锁→库→三件→start。活锁=LockHeldError（入口面捕获→非零 exit）。 */
  static open(stateDir: string): Engine {
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
      engine = new Engine(store, lock);
    } catch (error) {
      store.close();
      lock.release();
      throw error;
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
    if (this.closing) throw new Error('The engine is closing');
    await this.receipts.deliver(id, transport);
    if (this.receipts.get(id)?.status === 'sent') this.readTracker.markDelivered(id);
  }

  /** 票末收敛 API 位（裁定④·批量 settle——N4 票域生命周期面接）。 */
  settleTicket(messageIds: readonly string[]): void {
    for (const id of messageIds) this.readTracker.settle(id);
  }

  /** 停机序：closing→drain→close→锁最后放。幂等（重入零副作用）。 */
  async stop(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.effects.drain();
    this.store.close();
    this.lock.release();
  }
}
