// ── TriLC Letter Store (SQLite) ──
// LG-026 P1 数据层：信件 DB（letters + ledger 分表）。
// Uses Node 22 built-in node:sqlite (same pattern as session-store / event-queue store).
//
// Schema（lg-026-business-lead-daemon-design.md §二③ / spec §8.6）：
//   letters: 信封主体 — letter_id PK / seq_no(daemon 级全局单调 UNIQUE) /
//            from / to / priority / status / 时间戳四枚 / payload / ttl /
//            retries / last_error / ref_letter_id(升级新信封引用原信)
//   ledger:  分表一信多行（actor/action/at）状态流转流水留痕，
//            支撑「组长唯一投递执行者 + 收件人唯一定读权」审计
//
// Key behaviors:
//   - seq 全局单调：寄信事务内 MAX(seq_no)+1 分配，崩溃回滚无空洞，重启 MAX 续号
//   - 状态机门禁 store 层实现（非法流转拒绝，严格冻结版）：
//       deliver:  pending → delivered   （actor 须为组长 — 唯一投递执行者）
//       read:     delivered → read      （actor 须为收件人 — 唯一定读权，组长不得代标）
//       escalate: pending|delivered|read → escalated（旁路绝对终态，升后原件冻结全拒）
//       done:     read → done（办结终态，此后全拒；升级件办结走 ref 新信封自身状态机）
//   - 原件冻结校验：refLetterId 只许引用 status='escalated' 的原信
//   - escalateLetter() 单事务原子完成「冻结原信 + 建新信封 ref」防中间态

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type {
  LetterPriority,
  LetterStatus,
  LetterAction,
  LedgerAction,
  LetterEnvelope,
  LetterRecord,
  LedgerEntry,
  LetterQueryFilter,
  LedgerQueryFilter,
} from './types.js';

const CURRENT_SCHEMA_VERSION = 1;

// "from" 是 SQL 保留字，列名加引号；"to" 随同加引号防呆。
const DDL = `
CREATE TABLE IF NOT EXISTS letters (
  letter_id TEXT PRIMARY KEY,
  seq_no INTEGER NOT NULL UNIQUE,
  "from" TEXT NOT NULL,
  "to" TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT '常规' CHECK (priority IN ('常规', '重要', '急件')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'read', 'escalated', 'done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  read_at TEXT,
  escalated_at TEXT,
  payload TEXT NOT NULL,
  ttl INTEGER,
  retries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  ref_letter_id TEXT REFERENCES letters(letter_id)
);

CREATE INDEX IF NOT EXISTS idx_letters_to ON letters("to", status);
CREATE INDEX IF NOT EXISTS idx_letters_seq ON letters(seq_no);

CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  letter_id TEXT NOT NULL REFERENCES letters(letter_id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_letter ON ledger(letter_id, id);
`;

// 状态机门禁表：action → 合法源状态 / 目标状态 / 时间戳列
const TRANSITIONS: Record<LetterAction, { from: LetterStatus[]; to: LetterStatus; atColumn: string | null }> = {
  deliver: { from: ['pending'], to: 'delivered', atColumn: 'delivered_at' },
  read: { from: ['delivered'], to: 'read', atColumn: 'read_at' },
  escalate: { from: ['pending', 'delivered', 'read'], to: 'escalated', atColumn: 'escalated_at' },
  done: { from: ['read'], to: 'done', atColumn: null },
};

const PRIORITIES: LetterPriority[] = ['常规', '重要', '急件'];

export interface LetterStoreOptions {
  // 组长身份标识：deliver 动作唯一合法 actor（P2 组长 agent 接线时传注册名）
  leaderId?: string;
}

export function createLetterStore(dbPath: string, opts?: LetterStoreOptions) {
  const leaderId = opts?.leaderId ?? '组长';

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(DDL);

  // ── Schema version stamp ──
  const currentVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (currentVersion < CURRENT_SCHEMA_VERSION) {
    db.prepare(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION}`).run();
  }

  // ── Prepared statements ──

  const insertLetterStmt = db.prepare(`
    INSERT INTO letters
      (letter_id, seq_no, "from", "to", priority, status, payload, ttl, ref_letter_id)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `);

  const nextSeqStmt = db.prepare(
    'SELECT COALESCE(MAX(seq_no), 0) + 1 AS next_seq FROM letters',
  );

  const getLetterStmt = db.prepare('SELECT * FROM letters WHERE letter_id = ?');

  const updateTransitionStmt = db.prepare(
    'UPDATE letters SET status = ?, delivered_at = ?, read_at = ?, escalated_at = ? WHERE letter_id = ?',
  );

  const insertLedgerStmt = db.prepare(
    'INSERT INTO ledger (letter_id, actor, action) VALUES (?, ?, ?)',
  );

  // ── Row mapper ──

  function rowToLetter(row: Record<string, unknown>): LetterRecord {
    const payloadRaw = row.payload;
    return {
      letterId: row.letter_id as string,
      seqNo: Number(row.seq_no),
      from: row.from as string,
      to: row.to as string,
      priority: row.priority as LetterPriority,
      status: row.status as LetterStatus,
      createdAt: row.created_at as string,
      deliveredAt: (row.delivered_at as string) ?? null,
      readAt: (row.read_at as string) ?? null,
      escalatedAt: (row.escalated_at as string) ?? null,
      payload: typeof payloadRaw === 'string' ? JSON.parse(payloadRaw) : payloadRaw,
      ttlSeconds: (row.ttl as number | null) ?? null,
      retries: Number(row.retries ?? 0),
      lastError: (row.last_error as string) ?? null,
      refLetterId: (row.ref_letter_id as string) ?? null,
    };
  }

  // ── Core helpers（不启事务，供组合 API 在外层事务内复用）──

  function genLetterId(): string {
    const d = new Date();
    const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
    return `LT-${ymd}-${randomBytes(4).toString('hex')}`;
  }

  function doInsertLetter(env: LetterEnvelope): LetterRecord {
    if (env.priority !== undefined && !PRIORITIES.includes(env.priority)) {
      throw new Error(`invalid_priority: ${String(env.priority)}`);
    }
    if (env.letterId) {
      const dup = getLetterStmt.get(env.letterId);
      if (dup) throw new Error(`duplicate_id: ${env.letterId}`);
    }
    if (env.refLetterId) {
      // 原件冻结校验：升级新信封只许引用已 escalated 冻结的原信
      const ref = getLetterStmt.get(env.refLetterId) as Record<string, unknown> | undefined;
      if (!ref) throw new Error(`not_found: ref ${env.refLetterId}`);
      if (ref.status !== 'escalated') {
        throw new Error(`ref_not_frozen: ${env.refLetterId} status=${String(ref.status)}`);
      }
    }
    const seqNo = Number((nextSeqStmt.get() as { next_seq: number | bigint }).next_seq);
    const letterId = env.letterId ?? genLetterId();
    insertLetterStmt.run(
      letterId,
      seqNo,
      env.from,
      env.to,
      env.priority ?? '常规',
      JSON.stringify(env.payload ?? null),
      env.ttlSeconds ?? null,
      env.refLetterId ?? null,
    );
    insertLedgerStmt.run(letterId, env.from, 'send');
    return rowToLetter(getLetterStmt.get(letterId) as Record<string, unknown>);
  }

  function doTransition(letterId: string, action: LetterAction, actor: string): LetterRecord {
    const row = getLetterStmt.get(letterId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`not_found: ${letterId}`);
    const cur = row.status as LetterStatus;

    const rule = TRANSITIONS[action];
    if (!rule.from.includes(cur)) {
      throw new Error(`illegal_transition: ${action} on ${cur} (${letterId})`);
    }
    if (action === 'deliver' && actor !== leaderId) {
      throw new Error(`actor_forbidden: deliver requires leader(${leaderId}), got ${actor}`);
    }
    if (action === 'read' && actor !== row.to) {
      throw new Error(`actor_forbidden: read requires recipient(${String(row.to)}), got ${actor}`);
    }

    const now = db.prepare("SELECT datetime('now') AS t").get() as { t: string };
    updateTransitionStmt.run(
      rule.to,
      action === 'deliver' ? now.t : (row.delivered_at as string | null),
      action === 'read' ? now.t : (row.read_at as string | null),
      action === 'escalate' ? now.t : (row.escalated_at as string | null),
      letterId,
    );
    insertLedgerStmt.run(letterId, actor, action);
    return rowToLetter(getLetterStmt.get(letterId) as Record<string, unknown>);
  }

  // ── Letter CRUD ──

  /** 寄信：seq 事务内分配（全局单调、崩溃安全），轨迹自 send 起留痕。 */
  function insertLetter(env: LetterEnvelope): LetterRecord {
    db.exec('BEGIN');
    try {
      const rec = doInsertLetter(env);
      db.exec('COMMIT');
      return rec;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  function getLetter(letterId: string): LetterRecord | null {
    const row = getLetterStmt.get(letterId) as Record<string, unknown> | undefined;
    return row ? rowToLetter(row) : null;
  }

  /** 状态流转（门禁：非法流转拒绝 + actor 校验 + ledger 留痕）。 */
  function transition(letterId: string, action: LetterAction, actor: string): LetterRecord {
    db.exec('BEGIN');
    try {
      const rec = doTransition(letterId, action, actor);
      db.exec('COMMIT');
      return rec;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 升级（原子组合）：单事务内「冻结原信 → 建新信封 ref_letter_id 引用原信」，
   * 崩溃无中间态（原信已冻结而升级信封缺失会丢升级轨迹）。
   * 终裁升级权在 COS（业务规则），store 层不做 escalate actor 白名单，留痕交审计。
   */
  function escalateLetter(
    letterId: string,
    actor: string,
    envelope: Omit<LetterEnvelope, 'refLetterId'>,
  ): { original: LetterRecord; envelope: LetterRecord } {
    db.exec('BEGIN');
    try {
      const original = doTransition(letterId, 'escalate', actor);
      const env = doInsertLetter({ ...envelope, refLetterId: letterId });
      db.exec('COMMIT');
      return { original, envelope: env };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 投递失败重推留痕：retries+1 + last_error，不改 status（重推流转仍走 deliver/escalate 门禁）。 */
  function recordRetry(letterId: string, error: string): number {
    const result = db
      .prepare('UPDATE letters SET retries = retries + 1, last_error = ? WHERE letter_id = ?')
      .run(error, letterId);
    if (Number(result.changes) === 0) throw new Error(`not_found: ${letterId}`);
    const row = getLetterStmt.get(letterId) as Record<string, unknown>;
    return Number(row.retries);
  }

  // ── Query ──

  function listLetters(filter?: LetterQueryFilter): LetterRecord[] {
    let sql = 'SELECT * FROM letters WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.to) {
      sql += ' AND "to" = ?';
      params.push(filter.to);
    }
    if (filter?.from) {
      sql += ' AND "from" = ?';
      params.push(filter.from);
    }
    if (filter?.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.sinceSeq !== undefined) {
      sql += ' AND seq_no > ?';
      params.push(filter.sinceSeq);
    }
    sql += ' ORDER BY seq_no ASC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = (db.prepare(sql).all as (...args: unknown[]) => unknown[])(...params) as unknown as Record<string, unknown>[];
    return rows.map(rowToLetter);
  }

  function getLastSeq(): number {
    const row = db.prepare('SELECT COALESCE(MAX(seq_no), 0) AS max_seq FROM letters').get() as {
      max_seq: number | bigint;
    };
    return Number(row.max_seq);
  }

  // ── Ledger ──

  function listLedger(filter?: LedgerQueryFilter): LedgerEntry[] {
    let sql = 'SELECT * FROM ledger WHERE 1=1';
    const params: unknown[] = [];
    if (filter?.letterId) {
      sql += ' AND letter_id = ?';
      params.push(filter.letterId);
    }
    if (filter?.sinceId !== undefined) {
      sql += ' AND id > ?';
      params.push(filter.sinceId);
    }
    sql += ' ORDER BY id ASC';
    if (filter?.limit) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    const rows = (db.prepare(sql).all as (...args: unknown[]) => unknown[])(...params) as unknown as Record<string, unknown>[];
    return rows.map((r) => ({
      id: Number(r.id),
      letterId: r.letter_id as string,
      actor: r.actor as string,
      action: r.action as LedgerAction,
      at: r.at as string,
    }));
  }

  function close(): void {
    db.close();
  }

  return {
    insertLetter,
    getLetter,
    transition,
    escalateLetter,
    recordRetry,
    listLetters,
    getLastSeq,
    listLedger,
    close,
  };
}

export type LetterStore = ReturnType<typeof createLetterStore>;
