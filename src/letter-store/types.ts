// ── TriLC Letter Store Types ──
// LG-026 P1 数据层 — 信件信封与台账模型。
// 依据：lg-026-business-lead-daemon-design.md §二③ +
//       lg026-cto-joint-review-opinion.md ③ + trimlc-channel-daemon-spec.md §8.6。

export type LetterPriority = '常规' | '重要' | '急件';

// 状态机（严格冻结版）：pending → delivered → read → done 主链；
// escalated = 旁路绝对终态（任一主链态可升，升后原件冻结全拒，办结走 ref 新信封自身状态机）
export type LetterStatus = 'pending' | 'delivered' | 'read' | 'escalated' | 'done';

export type LetterAction = 'deliver' | 'read' | 'escalate' | 'done';

// 台账 action 超集：寄信本身留痕 'send'（轨迹自寄信起）
export type LedgerAction = LetterAction | 'send';

export interface LetterEnvelope {
  letterId?: string; // 缺省由 store 生成（LT-<UTC日期>-<8hex>）
  from: string;
  to: string;
  priority: LetterPriority;
  payload: unknown; // JSON 序列化落库
  ttlSeconds?: number | null; // 相对有效窗（秒）；到期语义 P2/P3 定
  refLetterId?: string | null; // 升级新信封引用原信 id（原件须已 escalated 冻结）
}

export interface LetterRecord {
  letterId: string;
  seqNo: number; // daemon 级全局单调（事务内 MAX+1 分配，重启续号）
  from: string;
  to: string;
  priority: LetterPriority;
  status: LetterStatus;
  createdAt: string; // ISO+Z（旧库无 Z 值读侧规范化视为 UTC）
  deliveredAt: string | null;
  readAt: string | null;
  escalatedAt: string | null;
  payload: unknown; // JSON 反序列化；坏 payload 读侧容错落 raw string（lastError='payload_parse_failed'）
  ttlSeconds: number | null;
  retries: number;
  lastError: string | null;
  refLetterId: string | null;
}

export interface LedgerEntry {
  id: number;
  letterId: string;
  actor: string;
  action: LedgerAction;
  at: string;
}

export interface LetterQueryFilter {
  to?: string;
  from?: string;
  status?: LetterStatus;
  sinceSeq?: number; // 积压重放：seq_no > sinceSeq
  limit?: number;
}

export interface LedgerQueryFilter {
  letterId?: string;
  sinceId?: number; // 台账增量读：id > sinceId
  limit?: number;
}

export interface LedgerAppend {
  letterId: string;
  actor: string;
  action: LedgerAction;
}
