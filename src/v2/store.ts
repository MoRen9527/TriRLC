// ── N1 V2Store（形三 α · SQLite Store+嵌套原子事务+committed 分层·门①裁定③完整形即落）──
//
// 开库形（TriRLC 四先例同构：cron/event-queue/letter-store/session-store WAL
// pragma+原型 store.ts 持久优先采形）：mkdir stateDir+WAL+synchronous=FULL+
// schema 版本门（PRAGMA user_version 范围外拒开——v2 零现役数据·防旧库误开
// 一行门便宜即采）。
//
// atomic 嵌套 depth 计数形（裁定③采完整形·β 件 receipts.atomic 单 depth 固定名
// 嫁接面）：SAVEPOINT v2_atomic_<depth> 计数栈——嵌套内层 RELEASE 不提交只剥栈
// （SQLite SAVEPOINT 语义）·外层 RELEASE 才真提交。committed 回调分层队列：
//   事务内注册（onCommitted）→回调挂队列·外层 RELEASE 后依注册序跑·回滚丢弃
//   ·回调错误 report 不败事务（原型 committed 分层语义采）；
//   事务外注册→立即跑（无事务边界可等）。
// afterCommit 与 Effects 分野（原型语义注释采）：即时内存跟随=直接改·跨 crash
// 持久副作用=committed 回调。Effects kick=queueMicrotask（β-2 零改）——V2Store
// atomic 同步形（op+RELEASE 同步栈内毕）·microtask dispatch 跑在提交后=kick
// 天然事务外安全（N4 票域 atomic 内 enqueue 的 committed 前置已备）。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** schema 版本（库格式契约·范围外拒开）。 */
export const SCHEMA_VERSION = 1;

/** committed 回调错误 report 面（不败事务·照原型 report 语义）。 */
function reportCommittedError(error: unknown): void {
  console.error('[v2] committed callback failed:', error);
}

export class V2Store {
  readonly db: DatabaseSync;
  readonly path: string;

  /** 嵌套深度计数（SAVEPOINT 名后缀·0=事务外）。 */
  private depth = 0;
  /** committed 分层队列：内层注册并入同一队列·外层 RELEASE 才跑（真提交面）。 */
  private committedQueue: Array<() => void> = [];

  constructor(stateDir: string, dbName = 'v2.db') {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, dbName);
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number | bigint };
    const version = Number(row.user_version);
    if (version === 0) {
      // 新库即标版本（零现役数据·表 DDL 归组合件 Effects/ReceiptsStore/ReadTracker）
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } else if (version !== SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`v2 store schema version mismatch: file=${version} expected=${SCHEMA_VERSION}`);
    }
  }

  /**
   * 嵌套原子事务：内层 RELEASE 剥栈不提交·外层 RELEASE 真提交+跑 committed
   * 队列（依注册序·回调错误 report 不败事务）；任层抛→回滚到本层+异常冒泡
   * （外层接续回滚=全回滚）·外层回滚丢弃队列。
   */
  atomic<T>(operation: () => T): T {
    const name = `v2_atomic_${this.depth}`;
    const outer = this.depth === 0;
    this.depth += 1;
    this.db.exec(`SAVEPOINT ${name}`);
    try {
      const value = operation();
      this.depth -= 1;
      this.db.exec(`RELEASE ${name}`);
      if (outer) {
        const callbacks = this.committedQueue;
        this.committedQueue = [];
        for (const callback of callbacks) {
          try { callback(); } catch (error) { reportCommittedError(error); }
        }
      }
      return value;
    } catch (error) {
      this.depth -= 1;
      this.db.exec(`ROLLBACK TO ${name}`);
      this.db.exec(`RELEASE ${name}`);
      if (outer) this.committedQueue = []; // 回滚丢弃
      throw error;
    }
  }

  /** committed 回调注册：事务内=挂队列（外层提交后跑）·事务外=立即跑。 */
  onCommitted(callback: () => void): void {
    if (this.depth === 0) callback();
    else this.committedQueue.push(callback);
  }

  /** 关库（停机序：drain 后·锁放前）。 */
  close(): void {
    this.db.close();
  }
}
