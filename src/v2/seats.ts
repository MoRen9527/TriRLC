// ── N6 Seats registry 第六 Pick（形三 α · 设计卷 72edda33b §三·门①裁 2cfe40575）──
//
// 名址面自研件（研究报告 L18：原型无 ListAgents 形列席面——dsh 无自由名址
// 三铁证·补法=自研 seat-registry）。SeatRecord 四字段（任务书 α 表 N6 行）：
//   name    =source-agents 目录正名 kebab-case（门①裁注：工作名不入 name 值域·
//            别名面候嫁接需求时另落 alias 谱——正名精确等值）
//   address =通信面寻址串（N8 send 消费面·零拨号——本件只存不连）
//   status  ='busy'|'idle'（裁⑧：首版静态·联动候 N7/N8）
//   host    =HostId 'dev'|'sg'|'r-hy'（D-24 机位投影·跨机不走 dsh 注正形）
// 种子谱=15 席（门①裁⑦：source-agents 现役实勘·活体名址非历史班底 13）。
// host/address 种子值=dev 初值+通信正名初值（落形选择：纯数据字段·值谱演进
// 归 N8 派工登记面·非架构裁决面）。
// 权限谱限权视图首版不采（设计卷 §三 裁面注——候 N8 权限面需求时另立）。

import type { DatabaseSync } from 'node:sqlite';
import { UserError } from './errors.js';

export type HostId = 'dev' | 'sg' | 'r-hy';

export interface SeatRecord {
  name: string;
  address: string;
  status: 'busy' | 'idle';
  host: HostId;
}

const HOST_VALUES: readonly HostId[] = ['dev', 'sg', 'r-hy'];
const STATUS_VALUES: readonly SeatRecord['status'][] = ['busy', 'idle'];
/** 正名值域形（门①裁注：kebab-case·source-agents 目录正名谱）。 */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 种子谱 15 席（裁⑦：source-agents 目录现役实勘 2026-11-06·kebab-case 正名）。 */
export const SEAT_SEEDS: readonly SeatRecord[] = [
  { name: 'business-strategy', address: 'm-bs', status: 'idle', host: 'dev' },
  { name: 'ceo-chief-of-staff', address: 'm-cos', status: 'idle', host: 'dev' },
  { name: 'chief-administrative-officer', address: 'm-cao', status: 'idle', host: 'dev' },
  { name: 'chief-financial-officer', address: 'm-cfo', status: 'idle', host: 'dev' },
  { name: 'chief-human-resources-officer', address: 'm-cho', status: 'idle', host: 'dev' },
  { name: 'chief-marketing-officer', address: 'm-cmo', status: 'idle', host: 'dev' },
  { name: 'chief-operating-officer', address: 'm-coo', status: 'idle', host: 'dev' },
  { name: 'chief-product-officer', address: 'm-cpo', status: 'idle', host: 'dev' },
  { name: 'chief-technology-officer', address: 'm-cto', status: 'idle', host: 'dev' },
  { name: 'customer-success-officer', address: 'm-cso', status: 'idle', host: 'dev' },
  { name: 'full-stack-developer', address: 'm-fsd', status: 'idle', host: 'dev' },
  { name: 'product-manager', address: 'm-pm', status: 'idle', host: 'dev' },
  { name: 'rd-trainer', address: 'm-rdt', status: 'idle', host: 'dev' },
  { name: 'senior-deployment-engineer', address: 'm-sde', status: 'idle', host: 'dev' },
  { name: 'senior-test-engineer', address: 'm-ste', status: 'idle', host: 'dev' },
];

/** 零依赖手写校验（照 validateSettings 形）——形破抛 UserError。 */
export function validateSeat(record: unknown): SeatRecord {
  if (typeof record !== 'object' || record === null) throw new UserError('seat record must be an object');
  const candidate = record as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || !NAME_PATTERN.test(candidate.name)) {
    throw new UserError(`seat.name must be kebab-case (${NAME_PATTERN.source})`);
  }
  if (typeof candidate.address !== 'string' || candidate.address.length === 0) {
    throw new UserError('seat.address must be a non-empty string');
  }
  if (!STATUS_VALUES.includes(candidate.status as SeatRecord['status'])) {
    throw new UserError(`seat.status must be one of ${STATUS_VALUES.join('|')}`);
  }
  if (!HOST_VALUES.includes(candidate.host as HostId)) {
    throw new UserError(`seat.host must be one of ${HOST_VALUES.join('|')}`);
  }
  return {
    name: candidate.name,
    address: candidate.address,
    status: candidate.status as SeatRecord['status'],
    host: candidate.host as HostId,
  };
}

/** seat 表 KV 单行正形（name PK·value JSON）。 */
export class SeatRepo {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('CREATE TABLE IF NOT EXISTS seat (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  /** 幂等 upsert（ON CONFLICT 覆写——put 面=全记录替换）。 */
  put(record: SeatRecord): void {
    this.db.prepare('INSERT INTO seat (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
      .run(record.name, JSON.stringify(record));
  }

  /** 种子灌面：已存在零覆写（重开不冲运行时已改记录）。 */
  putIfAbsent(record: SeatRecord): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO seat (name, value) VALUES (?, ?)')
      .run(record.name, JSON.stringify(record)).changes === 1;
  }

  get(name: string): SeatRecord | undefined {
    const row = this.db.prepare('SELECT value FROM seat WHERE name = ?').get(name) as { value: string } | undefined;
    return row === undefined ? undefined : validateSeat(JSON.parse(row.value));
  }

  list(): SeatRecord[] {
    const rows = this.db.prepare('SELECT value FROM seat ORDER BY name').all() as { value: string }[];
    return rows.map((row) => validateSeat(JSON.parse(row.value)));
  }
}

/**
 * Seats registry（第六 Pick·engine.seats 公开消费面）：put=登记/更新（校验门）
 ·list=列席面（ListAgents 等价·TUI seats 命令族消费）·get=仓储读面·
 * resolve=点名解析（N8 send 消费面入口·正名精确等值——别名不采·未知名
 * undefined 由调用方裁决）。
 */
export class Seats {
  constructor(private readonly repo: SeatRepo) {}

  put(record: SeatRecord): void {
    this.repo.put(validateSeat(record));
  }

  list(): SeatRecord[] {
    return this.repo.list();
  }

  get(name: string): SeatRecord | undefined {
    return this.repo.get(name);
  }

  /** 点名解析：正名精确等值（语义入口与 get 分层——N8 send 面用）。 */
  resolve(name: string): SeatRecord | undefined {
    return this.repo.get(name);
  }
}

/** 种子灌面（Engine 组合序调·幂等 INSERT OR IGNORE——重开零冲已改记录）。 */
export function seedSeats(db: DatabaseSync): void {
  const repo = new SeatRepo(db);
  for (const seed of SEAT_SEEDS) repo.putIfAbsent(seed);
}
