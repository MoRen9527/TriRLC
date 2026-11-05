// ── β-1 事务回执最小件（形三 α+β · 任务书 b76dce4e §二 / CTO 裁定卷 84f50517a）──
//
// 思想源=dsh-superagent 原型 src/app/{outbox,store,effects}.ts（N1 深读笔记小卷
// form3-alpha-beta-impl/fsd-n1-deepread-notes.md·思想复用≠代码照抄——原型缺陷
// 候选逐条验后采形）。现役对表=TriMMC notify 信箱三态（pending→forwarded→
// delivered）+形二 sg 轮 98s 链状态史（ntf-mw3dg9mbih8l6d）。
//
// v2 语义层零接现役进程（shadow 形·默认不启用）——现役栈零触碰红线对表。
// β-1 三缺补位（照任务书）：①withdraw 撤回面（pending-only）②失败计数+乱序
// 防护（behind 联查·FAILURES_BEFORE_ERROR=3）③settle 竞态防护（WHERE pending
// +重建防同 id 再排队）。DropReason 照 CTO 裁定=targetGone/targetIgnored。
//
// 退避参数（CTO 裁定 A）：delay = min(300_000, 2_000 * 2 ** min(attempts, 16))
// ——β-2 Effects 完整类落 src/v2/effects.ts（本件 effect 表 DDL 与之一致·
// dispatch/退避/health/死信出口=β-2 范围；本件只落 enqueue/cancel 最小面）。

import type { DatabaseSync } from 'node:sqlite';

/** 「现在不能跑」信号：重排 initial delay 不计失败数（照原型 Later·β-2 Effects 消费）。 */
export class Later extends Error {}

/** 连续失败阈值（照原型 FAILURES_BEFORE_ERROR·与 behind 防护同源）。 */
export const FAILURES_BEFORE_ERROR = 3;

/** 永久不可达（照原型 channelGone→席语境改名·CTO 裁定 5） */
export type DropReason = 'targetGone' | 'targetIgnored';
export type ReceiptStatus = 'pending' | 'sent' | 'dropped';

/** 状态史条目：accepted（入队）→sent / dropped:<reason>（终态）——形二链对拍投影面。 */
export interface StatusEntry { status: string; at: string }

export interface Receipt extends OutboundMessage {
  status: ReceiptStatus;
  dropped?: { at: string; reason: DropReason };
  status_history: StatusEntry[];
}

export interface OutboundMessage {
  id: string;
  from: string;
  to: string;
  text: string;
}

/** 投递端注入形（shadow 测试 mock·现役挂接面候选=localbus/notify 投递实现）。 */
export interface ReceiptTransport {
  /** false=目标暂不可用→Later（照原型 source disabled 形）。 */
  enabled?(): boolean;
  /** false=目标不再收件→settle targetIgnored（照原型 channelAllowed 形）。 */
  channelAllowed?(): boolean;
  /** 投递：sent=成功 / gone=目标永久不可达 / waiting=暂不可达（照原型 SourceRegistry.send 三态）。 */
  send(receipt: Receipt): Promise<'sent' | 'gone' | 'waiting'>;
}

/**
 * receipts 表生成列 `pending`=同目标乱序防护的排序键（照原型 outbox.pending
 * 复合 key=ticketId+' '+thread→v2 席语境=to 单字段）；effect 表 DDL 与 β-2
 * Effects 类一致（attempts 列=behind 联查依赖）。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  pending TEXT AS (CASE WHEN json_extract(value, '$.status') = 'pending'
    AND json_extract(value, '$.to') IS NOT NULL THEN json_extract(value, '$.to') END)
);
CREATE INDEX IF NOT EXISTS receipts_pending ON receipts(pending) WHERE pending IS NOT NULL;
CREATE TABLE IF NOT EXISTS effect (
  kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
`;

/**
 * β-1 事务回执最小件：receipts 持久+reply effect 入队原子+withdraw/behind/
 * settle 三缺补位。send=store.atomic 内 add→enqueue（照原型 outbox.send·
 * 幂等：add false=重复 id 零重复入队）。
 */
export class ReceiptsStore {
  readonly db: DatabaseSync;
  private seq: number;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    const row = this.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get() as { seq: number | bigint } | undefined;
    this.seq = Number(row?.seq ?? 0);
  }

  /** 关库（照原型 store.close·停机序=先关库后放锁同族语义·测试面 afterEach 用）。 */
  close(): void {
    this.db.close();
  }

  /**
   * SAVEPOINT 事务（照原型 store.atomic·β-1 最小形单 depth 固定名——嵌套
   * depth 计数形=N1 Engine 骨架完整形·本件调用面零嵌套安全）。
   */
  atomic<T>(operation: () => T): T {
    this.db.exec('SAVEPOINT receipts_atomic');
    try {
      const value = operation();
      this.db.exec('RELEASE receipts_atomic');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK TO receipts_atomic');
      this.db.exec('RELEASE receipts_atomic');
      throw error;
    }
  }

  /** 记录回执+入队投递原子（幂等：重复 id 保持原回执·零重复入队）。 */
  send(message: OutboundMessage): void {
    this.atomic(() => {
      if (this.add(message)) this.enqueue('reply', message.id, {});
    });
  }

  /** 新录 pending 回执（accepted 记状态史首项·对拍形二 accepted 语义）。 */
  add(message: OutboundMessage): boolean {
    const receipt: Receipt = {
      ...message,
      status: 'pending',
      status_history: [{ status: 'accepted', at: new Date().toISOString() }],
    };
    return Number(this.db.prepare('INSERT OR IGNORE INTO receipts (id, value) VALUES (?, ?)')
      .run(message.id, JSON.stringify(receipt)).changes) > 0;
  }

  get(id: string): Receipt | undefined {
    const row = this.db.prepare('SELECT value FROM receipts WHERE id = ?').get(id) as { value: string } | undefined;
    return row === undefined ? undefined : JSON.parse(row.value) as Receipt;
  }

  /** 同目标前序 pending 且失败计数未过阈→true（照原型 behind SQL 联查形）。 */
  behind(id: string, failures: number): boolean {
    return this.db.prepare(`
      SELECT 1 FROM receipts earlier
      JOIN receipts message ON message.id = ?
      LEFT JOIN effect ON effect.kind = 'reply' AND effect.key = earlier.id
      WHERE earlier.pending = message.pending AND earlier.rowid < message.rowid
        AND IFNULL(effect.attempts, 0) < ? LIMIT 1
    `).get(id, failures) !== undefined;
  }

  /**
   * 终态收敛（sent 或 dropped+reason）：WHERE pending 防竞态（照原型
   * json_patch 语义·v2 用读改写形拼 status_history 追加）；行已被并发
   * withdraw 删除时重建为终态（照原型：防同 id 再排队）。
   */
  settle(message: Receipt, outcome: 'sent' | DropReason): void {
    const at = new Date().toISOString();
    const entry: StatusEntry = { status: outcome === 'sent' ? 'sent' : `dropped:${outcome}`, at };
    const current = this.get(message.id);
    if (current === undefined || current.status !== 'pending') {
      const rebuilt: Receipt = {
        ...message,
        status: outcome === 'sent' ? 'sent' : 'dropped',
        ...(outcome === 'sent' ? {} : { dropped: { at, reason: outcome } }),
        status_history: [...(message.status_history ?? []), entry],
      };
      this.db.prepare('INSERT OR IGNORE INTO receipts (id, value) VALUES (?, ?)')
        .run(message.id, JSON.stringify(rebuilt));
      return;
    }
    const settled: Receipt = {
      ...current,
      status: outcome === 'sent' ? 'sent' : 'dropped',
      ...(outcome === 'sent' ? {} : { dropped: { at, reason: outcome } }),
      status_history: [...current.status_history, entry],
    };
    this.db.prepare("UPDATE receipts SET value = ? WHERE id = ? AND json_extract(value, '$.status') = 'pending'")
      .run(JSON.stringify(settled), message.id);
  }

  /** 撤回：只有 pending 态可撤（照原型 withdraw·返回是否撤成功）。 */
  withdraw(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM receipts WHERE id = ? AND json_extract(value, '$.status') = 'pending'")
      .run(id).changes) > 0;
  }

  // ── effect 最小面（β-2 完整 Effects 类扩展位：dispatch/指数退避/health/死信出口）──

  /** 入队（kind+key 去重合并保队列位·generation 自增防运行中覆盖——照原型 enqueue）。 */
  enqueue(kind: string, key: string, payload: unknown): void {
    this.seq += 1;
    this.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, generation = generation + 1,
        attempts = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), this.seq, Date.now(), new Date().toISOString());
  }

  /** 撤待投行（照原型 cancel·运行中 attempt 由 β-2 完整类处理 generation 防护）。 */
  cancel(kind: string, key: string): void {
    this.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key);
  }

  /**
   * 投递单件（照原型 Outbox.deliver 序：pending 检查→enabled→behind 乱序
   * 防护→channelAllowed→send 三态收敛）。transport=注入形（shadow mock /
   * 现役挂接实现候选）。Later 抛出=β-2 Effects 重排（免计数）消费面。
   */
  async deliver(id: string, transport: ReceiptTransport): Promise<void> {
    const receipt = this.get(id);
    if (receipt?.status !== 'pending') return;
    if (transport.enabled !== undefined && !transport.enabled()) throw new Later('The target is off or not installed');
    if (this.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message to this target waits');
    if (transport.channelAllowed !== undefined && !transport.channelAllowed()) {
      this.settle(receipt, 'targetIgnored');
      return;
    }
    const result = await transport.send(receipt);
    if (result === 'waiting') throw new Later('The target is not ready');
    this.settle(receipt, result === 'gone' ? 'targetGone' : 'sent');
  }
}
