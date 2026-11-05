// ── β-2 Effects 持久退避队列（形三 α+β · CTO 准动令 2026-11-05T13:42:43Z / 裁定卷 84f50517a③）──
//
// 思想源=dsh-superagent 原型 src/app/effects.ts（161 行·N1 深读笔记小卷·思想复用≠代码
// 照抄）。现役对表=TriMMC notify pull 幂等重放面（β-2 补退避序列/health/死信出口三缺）。
//
// CTO 裁定落形：
// - 退避 A 形：delay = min(300_000, 2_000 * 2 ** min(attempts, 16))·2s 起指数·300s 封顶
//   （默认 retry=[2000, 300_000]·第 n 败 delay=2000*2^(n-1)·照原型用旧 attempts 值）
// - FAILURES_BEFORE_ERROR=3·Later 免计数重排（照原型）
// - 死信出口入范围（裁定③）：attempts≥16 且封顶 delay 连续 3 轮仍败→dead-letter 态+
//   health 可见+人工处置入口（requeue 复位/discard 显式丢弃）·**零自动丢弃**——死信行
//   留库不再自动 dispatch（stalled 列追踪封顶连败）
//
// v2 shadow 形零接现役进程·db 由调用方持有（与 ReceiptsStore 共享同一 DatabaseSync·
// 库生命周期归外层）。

import type { DatabaseSync } from 'node:sqlite';

/** 「现在不能跑」信号：重排 initial delay 不计失败数（照原型 Later·β-1 receipts 消费）。 */
export class Later extends Error {}

/** 连续失败阈值：达阈标 health error（照原型 FAILURES_BEFORE_ERROR）。 */
export const FAILURES_BEFORE_ERROR = 3;

export interface EffectHandler {
  run: (payload: unknown, key: string) => Promise<void>;
  /** 此刻可并发数；0=hold 该 kind（如暂停面）。 */
  limit: () => number;
  /** 初使与封顶退避毫秒（照原型 [initial, max]）。 */
  retry: readonly [number, number];
  /** 同 kind 串行·失败阻塞后行（照原型 ordered）。 */
  ordered: boolean;
  /** 失败不上 health error 面（照原型 quiet）。 */
  quiet: boolean;
}

export type EffectHandlerOptions = Partial<Pick<EffectHandler, 'limit' | 'retry' | 'ordered' | 'quiet'>>;

export interface EffectHealthEntry {
  state: 'ready' | 'error' | 'dead-letter';
  detail: string;
  at: string;
}

/** effect 行读形（dispatch/死信面用）。 */
export interface EffectRow {
  kind: string;
  key: string;
  value: string;
  seq: number;
  generation: number;
  attempts: number;
  stalled: number;
  error: string;
  due: number;
}

/** 死信判定（CTO 裁定③·attempts≥16 且封顶 delay 连续 3 轮仍败）。 */
export function isDeadLetter(row: Pick<EffectRow, 'attempts' | 'stalled'>): boolean {
  return row.attempts >= 16 && row.stalled >= 3;
}

const DEAD_LETTER_PREDICATE = '(attempts >= 16 AND stalled >= 3)';

/**
 * effect 表 DDL（β-1 自 receipts 内聚面迁入+stalled 列新增=死信追踪）。
 * PRIMARY KEY(kind, key)=去重合并面·effect_due=dispatch 扫描索引。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS effect (
  kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, seq INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  stalled INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', due INTEGER NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX IF NOT EXISTS effect_due ON effect(kind, due, seq);
`;

/**
 * 持久退避队列：SQLite 行持久+kind/key 去重合并+指数退避+health+死信出口。
 * 验收门对表：失败重试序列对拍/去重断言/进程重启后队列仍在（SQLite 持久）。
 */
export class Effects {
  private readonly handlers = new Map<string, EffectHandler>();
  private readonly health = new Map<string, EffectHealthEntry>();
  private readonly tasks = new Set<{ kind: string; key: string; done: Promise<void> }>();
  /** 上轮 dispatch 抛错的 kind；下轮成功即恢复（照原型 broken）。 */
  private readonly broken = new Set<string>();
  private seq: number;
  private started = false;
  private stopped = false;
  private scheduled = false;

  /**
   * @param now 可控时钟注入（测试退避序列断言面·缺省 Date.now）
   */
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = () => Date.now()) {
    this.db.exec(SCHEMA);
    const row = this.db.prepare('SELECT IFNULL(MAX(seq), 0) AS seq FROM effect').get() as { seq: number | bigint } | undefined;
    this.seq = Number(row?.seq ?? 0);
  }

  /** 入队（kind+key 去重合并保队列位·generation 自增防运行中覆盖·attempts/stalled 归零）。 */
  enqueue(kind: string, key: string, payload: unknown): void {
    this.seq += 1;
    this.db.prepare(`INSERT INTO effect (kind, key, value, seq, due, since) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET value = excluded.value, generation = generation + 1,
        attempts = 0, stalled = 0, error = '', due = excluded.due`)
      .run(kind, key, JSON.stringify(payload), this.seq, this.now(), new Date(this.now()).toISOString());
    this.kick();
  }

  /** 注册 handler（同 kind 唯一·retry 缺省 [2000, 300_000]=退避 A 形）。 */
  handle(kind: string, run: EffectHandler['run'], options: EffectHandlerOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`The ${kind} effects already have a handler`);
    const { limit = () => 1, retry = [2000, 300_000], ordered = false, quiet = false } = options;
    this.handlers.set(kind, { run, limit: ordered ? () => Math.min(1, limit()) : limit, retry, ordered, quiet });
    this.report(kind);
  }

  pending(kind: string, key?: string): boolean {
    if (key === undefined) {
      return this.db.prepare('SELECT 1 FROM effect WHERE kind = ? LIMIT 1').get(kind) !== undefined;
    }
    return this.db.prepare('SELECT 1 FROM effect WHERE kind = ? AND key = ?').get(kind, key) !== undefined;
  }

  /** 撤待投行（照原型 cancel·死信行的人工丢弃走 discard）。 */
  cancel(kind: string, key: string): void {
    this.db.prepare('DELETE FROM effect WHERE kind = ? AND key = ?').run(kind, key);
  }

  /** 启动 dispatch（start 前入队行等待——setup 未完同族语义照原型）。 */
  start(): void {
    this.started = true;
    this.kick();
  }

  /** 停机：停新起等运行中（drain 后等待行留 SQLite 下次 start）。 */
  async drain(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.tasks].map((task) => task.done));
  }

  /** 触发 dispatch（queueMicrotask 单飞防重入——照原型 kick）。 */
  kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.dispatch();
    });
  }

  /** 等到无该 kind（或全 kind）运行中且无 due 可起（照原型 idle）。 */
  async idle(kind?: string): Promise<void> {
    for (;;) {
      this.dispatch();
      const running = [...this.tasks].filter((task) => kind === undefined || task.kind === kind).map((task) => task.done);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  /** health 读面（v2 最小内置形·N1 Engine 骨架阶段对齐 HealthBoard 完整形）。 */
  snapshot(): Record<string, EffectHealthEntry> {
    return Object.fromEntries(this.health);
  }

  // ── 死信出口（CTO 裁定③·零自动丢弃·人工处置入口）──

  /** 死信列举（行留库候人工·可按 kind 过滤）。 */
  deadLetters(kind?: string): EffectRow[] {
    const where = kind === undefined
      ? `WHERE ${DEAD_LETTER_PREDICATE}`
      : 'WHERE kind = ? AND ' + DEAD_LETTER_PREDICATE.slice(1, -1);
    const sql = `SELECT kind, key, value, seq, generation, attempts, stalled, error, due FROM effect ${where} ORDER BY seq`;
    return (kind === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(kind)) as unknown as EffectRow[];
  }

  /** 人工处置：复位重排（attempts/stalled 归零·due=now·行复活）——返回是否命中死信行。 */
  requeue(kind: string, key: string): boolean {
    const result = this.db.prepare(`UPDATE effect SET attempts = 0, stalled = 0, error = '', due = ?
      WHERE kind = ? AND key = ? AND ${DEAD_LETTER_PREDICATE}`).run(this.now(), kind, key);
    const hit = Number(result.changes) > 0;
    if (hit) this.report(kind);
    return hit;
  }

  /** 人工处置：显式丢弃（唯一删死信行通道·非自动）——返回是否命中死信行。 */
  discard(kind: string, key: string): boolean {
    const result = this.db.prepare(`DELETE FROM effect WHERE kind = ? AND key = ? AND ${DEAD_LETTER_PREDICATE}`)
      .run(kind, key);
    const hit = Number(result.changes) > 0;
    if (hit) this.report(kind);
    return hit;
  }

  // ── 内部 dispatch/attempt 面（照原型形·死信行过滤）──

  private dispatch(): void {
    if (!this.started || this.stopped) return;
    for (const [kind, handler] of this.handlers) {
      try {
        const running = new Set([...this.tasks].filter((task) => task.kind === kind).map((task) => task.key));
        const columns = 'kind, key, value, seq, generation, attempts, stalled, error, due';
        const rows = (handler.ordered
          ? this.db.prepare(`SELECT ${columns} FROM effect WHERE kind = ? AND NOT ${DEAD_LETTER_PREDICATE} ORDER BY seq LIMIT 1`).all(kind)
          : this.db.prepare(`SELECT ${columns} FROM effect WHERE kind = ? AND NOT ${DEAD_LETTER_PREDICATE} AND due <= ? ORDER BY seq LIMIT ?`)
            .all(kind, this.now(), 16 + running.size)) as unknown as EffectRow[];
        const ready = handler.ordered && running.size > 0 ? [] : rows.filter((row) => row.due <= this.now() && !running.has(row.key));
        let room = ready.length > 0 ? handler.limit() - running.size : 0;
        for (const row of ready) {
          if (room-- <= 0) break;
          this.runOne(kind, handler, row);
        }
        if (this.broken.delete(kind)) this.report(kind);
      } catch (error) {
        this.failed(kind, error);
      }
    }
  }

  private runOne(kind: string, handler: EffectHandler, row: EffectRow): void {
    const task: { kind: string; key: string; done: Promise<void> } = { kind, key: row.key, done: Promise.resolve() };
    task.done = this.attempt(kind, handler, row)
      .catch((error: unknown) => { this.failed(kind, error); })
      .finally(() => {
        this.tasks.delete(task);
        this.kick();
      });
    this.tasks.add(task);
  }

  private async attempt(kind: string, handler: EffectHandler, row: EffectRow): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      await handler.run(JSON.parse(row.value) as never, row.key);
    } catch (error) {
      failure = { error };
    }
    // 匹配 seq+generation：运行中被替换/重排的行不被旧 attempt 覆写（照原型）。
    const own = 'kind = ? AND key = ? AND seq = ? AND generation = ?';
    const ownArgs = [kind, row.key, row.seq, row.generation];
    if (failure === undefined) {
      this.db.prepare(`DELETE FROM effect WHERE ${own}`).run(...ownArgs);
      if (!this.stopped) this.report(kind);
      return;
    }
    // 停机：运行行原样留库下次 start 重试（照原型）。
    if (this.stopped) return;
    if (failure.error instanceof Later) {
      // 免计数重排：initial delay·attempts/stalled 不增（照原型）。
      this.db.prepare(`UPDATE effect SET due = ? WHERE ${own}`).run(this.now() + handler.retry[0], ...ownArgs);
      this.report(kind);
      return;
    }
    // 普通失败：指数退避 A 形（第 n 败 delay=initial*2^(n-1)·封顶 max·照原型用旧 attempts 值）。
    const attempts = row.attempts + 1;
    const delay = Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(row.attempts, 16));
    // 封顶连败追踪（死信判定输入·非封顶失败清零）。
    const stalled = delay >= handler.retry[1] ? row.stalled + 1 : 0;
    const errorText = String(failure.error).slice(0, 1000);
    this.db.prepare(`UPDATE effect SET attempts = ?, stalled = ?, error = ?, due = ? WHERE ${own}`)
      .run(attempts, stalled, errorText, this.now() + delay, ...ownArgs);
    if (!isDeadLetter({ attempts, stalled })) this.report(kind);
    // 死信态由 markDeadLetter 立（report 跳过防覆盖 dead-letter 面）。
    if (isDeadLetter({ attempts, stalled })) {
      this.health.set(kind, {
        state: 'dead-letter',
        detail: `Dead letter: '${row.key}' failed ${attempts} times (stalled ${stalled} at max backoff); awaiting manual disposition (requeue/discard)`,
        at: new Date(this.now()).toISOString(),
      });
    }
  }

  /** dispatch 自身抛错面（照原型 failed·下轮成功恢复）。 */
  private failed(kind: string, error: unknown): void {
    this.broken.add(kind);
    this.health.set(kind, {
      state: 'error',
      detail: `The effect queue failed: ${String(error)}`,
      at: new Date(this.now()).toISOString(),
    });
  }

  /** health 逐 kind 报告（照原型 report·FAILURES 达阈 error·quiet 豁免）。 */
  private report(kind: string): void {
    const handler = this.handlers.get(kind);
    const row = this.db.prepare(`SELECT COUNT(*) AS waiting, MIN(since) AS since, MAX(attempts) AS attempts,
      (SELECT error FROM effect WHERE kind = ? AND attempts > 0 ORDER BY seq DESC LIMIT 1) AS error
      FROM effect WHERE kind = ?`).get(kind, kind) as
      { waiting: number | bigint; since: string | null; attempts: number | bigint; error: string | null } | undefined;
    const waiting = Number(row?.waiting ?? 0);
    const failing = Number(row?.attempts ?? 0) >= FAILURES_BEFORE_ERROR && handler?.quiet !== true;
    const detail = waiting > 0 ? `${waiting} waiting since ${String(row?.since)}` : 'Nothing waiting';
    this.health.set(kind, failing
      ? {
          state: 'error',
          detail: `${detail}; the last failure: ${String(row?.error)}`,
          at: new Date(this.now()).toISOString(),
        }
      : { state: 'ready', detail, at: new Date(this.now()).toISOString() });
  }
}
