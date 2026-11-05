// ── β-3 三段已读（形三 α+β · CTO β-3 准动令 2026-11-05T14:16:18Z / 设计小卷 §四）──
//
// 三段语义（照原型 engine.ts inputsRead 判定式·N1 深读笔记）：
//   delivery（β-1 receipts sent 事件源）→ read（消费席显式 ack·CTO 裁定候选 A
//   零 agent-core 侵入）→ settled（report/turn-end 票末收敛）。
//
// 迁移表（线性单调+票末收敛支·毕报标注候 review 勘）：
//   none→delivered→{read, settled}·read→settled·settled=终态锁
//   ——delivered→settled 合法（settled 语义=「计为在票末已读」票末收敛·
//   未读票末不再等）；none→read/settled 跳段拒·倒退拒·settled 后一切迁移拒
//   （同段幂等 true 零变）。
//
// v2 shadow 形零接现役进程：read-tracker 独立件·β-1 receipts 零改面（delivery
// 事件组合挂接归 N2/N3 Engine 组合域）；db 由调用方持有（库生命周期归外层）。
// 验收门③正身=跨 reload 持久断言（第四型盲区案：写→close→真重开同库 boot
// 链→断言仍在——jsdom/进程内复刻不覆盖真 reload 教训直接适用）。

import type { DatabaseSync } from 'node:sqlite';

export type ReadStateName = 'delivered' | 'read' | 'settled';

/** read_state 表（设计小卷 §四表形·单 state+at 全持久·零状态史最小形）。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS read_state (
  message_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  at TEXT NOT NULL
);
`;

/** 合法迁移表（键=当前段·值=可达段·settled 键缺席=终态锁）。 */
const TRANSITIONS: Partial<Record<ReadStateName, readonly ReadStateName[]>> = {
  delivered: ['read', 'settled'],
  read: ['settled'],
};

/** 三段已读追踪器：read_state 持久+显式 ack API+非法迁移拒。 */
export class ReadTracker {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  /** delivery 段（β-1 receipts sent 事件源挂接面·N2/N3 Engine 组合调用）。 */
  markDelivered(messageId: string): boolean {
    return this.transition(messageId, 'delivered');
  }

  /** read 段（显式 ack API·CTO 裁定候选 A——消费方读后调零侵入）。 */
  ack(messageId: string): boolean {
    return this.transition(messageId, 'read');
  }

  /** settled 段（report/turn-end 票末收敛·delivered 直跳合法=未读票末收敛支）。 */
  settle(messageId: string): boolean {
    return this.transition(messageId, 'settled');
  }

  /** 读面：当前段（未 track=undefined）。 */
  stateOf(messageId: string): ReadStateName | undefined {
    const row = this.db.prepare('SELECT state FROM read_state WHERE message_id = ?').get(messageId) as
      { state: string } | undefined;
    return row === undefined ? undefined : row.state as ReadStateName;
  }

  /**
   * 迁移核：非法迁移 false（零写面）·合法 UPDATE WHERE state=当前段防并发
   * 竞态（changes=0 即被他方先迁·返回 false）；同段重入幂等 true 零变。
   */
  private transition(messageId: string, to: ReadStateName): boolean {
    const current = this.stateOf(messageId);
    if (current === to) return true;
    if (current === undefined) {
      if (to !== 'delivered') return false; // 跳段拒（首段唯 delivered）
      this.db.prepare('INSERT INTO read_state (message_id, state, at) VALUES (?, ?, ?)')
        .run(messageId, to, new Date().toISOString());
      return true;
    }
    if (!TRANSITIONS[current]?.includes(to)) return false; // 倒退/终态锁拒
    const result = this.db.prepare('UPDATE read_state SET state = ?, at = ? WHERE message_id = ? AND state = ?')
      .run(to, new Date().toISOString(), messageId, current);
    return Number(result.changes) > 0;
  }
}
