// ── N5 Policy 门族完整谱（形三 α · N5 并入·设计卷 72edda33b §二·门①裁 2cfe40575 八裁值）──
//
// 思想源=dsh-superagent 原型 src/policy.ts（242 行·嫁接域转正范围 L105-242 补读）
// +ids.ts key() L3-5（sha256 前 32 hex 实勘）。N4 最小门→N5 完整门族升形：
// Settings 最小 schema+policyVersion 哈希+sender 名单+gate 完整谱+policyEffects
// 变更增量通知（任务书 N5 四件谱位正身演进）。
//
// 门①八裁值落形对表：
//   ①mode 缺省='off'（原型 EvalConfig 默认对表·fail-safe 保守——N4「恒 auto」
//     悬置收口·observation 支升形=mode==='auto'&&rulesOn 原型 L238 正形）；
//   ②强度表分立（N4 STRENGTH 两档零改+ADMISSION_STRENGTH 三档 ignore=0——
//     原型 L141 单表混用拆两表·数值谱 0/1/2 同构·revalidate 跨表比数）；
//   ③scope 注入式缺省全收（真 sources 绑定面=DeepSeek 面不采——ScopeResolver
//     可注入·缺省恒 {listened:true, observed:true} 单机 shadow 形）；
//   ④participating 缺省 false（threads 面=嫁接域——gate context 参调用方算）；
//   ⑤POLICY_REVISION='v2-mandate-1'（谱系独立·原型 mandate-v3 不混用）；
//   ⑥Eval 评估面划出候事件源（assessmentOutcome/DEFAULT_RULES 不落——rules
//     只进 version 哈希与 rulesOn 判）。
//   settings 持久=KV 单行表 policy_settings（SettingsRepo·applySettings 与
//   增量通知同事务=engine.ts 落形）。
//
// N4 件升形注（设计卷 §二.2·门①裁②授权）：revalidate 完整谱照原型 L213-240
// 正形移植——案 7 升形三翻转如实注（followup inferred+auto=rulesOn vacuous 过
// L221／explicit mandate+表值降级=拒 L234——requesterAllowed 面存活依赖此正形／
// observation rules 空=vacuous 过 L219 正形）；缺 cell admission=保守拒（v2 裁·
// 原型宽容跌出 true 系 gate 不产的非正规形差）。gate 产 basis 不带 addressed/
// sender 记录面字段（v2 Mandate=revalidate 消费面投影·N4 同裁延续）；scope
// 记录面带（revalidate 失听判 L217-218 消费）。

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { UserError } from './errors.js';
import type { TicketRecord } from './tickets.js';

/** Actor identity in the source's own vocabulary（照原型 model.ts L5）。 */
export interface ActorRef { source: string; id: string }

/** 授权强度：explicit=人显式请求/inferred=规则推断（照原型 model.ts L96）。 */
export type Strength = 'explicit' | 'inferred';

/** 观察模式（照原型 model.ts L103）。 */
export type AcceptMode = 'off' | 'observe' | 'auto';

/** Admission 表 cell（照原型 model.ts L98·listed/unlisted × addressed/unaddressed）。 */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed';

/** admission 表值谱（原型 policy.ts L141 Admission 三档·含 ignore）。 */
export type AdmissionStrength = 'ignore' | 'inferred' | 'explicit';

/**
 * 授权形（原型 Mandate 的 revalidate 消费面投影·N4 §七A.4 延续+N5 升形）：
 * via 五形照原型 MandateBasis L116-123；scope=N5 升形新带（原型 basis.scope
 * 记录面——revalidate 失听判消费）。
 */
export interface Mandate {
  via: 'addressed' | 'followup' | 'admission' | 'listed' | 'bot';
  strength: Strength;
  actor: ActorRef;
  source: string;
  /** 接受时命中的规则 id（observation→rulesOn 支判据）。 */
  rules?: string[];
  /** via='admission' 时的 cell（原型 basis.cell）。 */
  cell?: AdmissionCell;
  /** inferred 候选在观察模式下记录的观察标记（原型 basis.observation）。 */
  observation?: { mode: AcceptMode };
  /** 受权时 scope 记录（N5 升形·原型 basis.scope——失听判消费）。 */
  scope?: Record<string, unknown>;
}

/** 强度序（授权强度两档·N4 零改）。 */
export const STRENGTH: Record<Strength, number> = { explicit: 2, inferred: 1 };

/** admission 表值强度序（原型 L141 三档含 ignore=0·裁②分立表）。 */
export const ADMISSION_STRENGTH: Record<AdmissionStrength, number> = { ignore: 0, inferred: 1, explicit: 2 };

/**
 * Admission 默认表（cell 谱 3×2 缺省形·值谱放宽为 AdmissionStrength——'ignore'
 * 可入配置·缺省三格值与 N4 零变）。
 */
export const ADMISSION_DEFAULTS: Record<AdmissionCell, AdmissionStrength> = {
  listedUnaddressed: 'explicit',
  unlistedAddressed: 'explicit',
  unlistedUnaddressed: 'inferred',
};

// ── Settings 最小 schema（裁面①·零 zod 手写校验）──

export interface AllowedEntry { id: string; name?: string }

export interface Rule { id: string; name: string; instruction: string; enabled: boolean }

export interface SourcePolicy {
  allowed: AllowedEntry[];
  /** bot 名单（inferred candidate 上限·照原型 listedBot 面）。 */
  bots?: AllowedEntry[];
  /** per-scope-row cell 覆盖表（row→cell→值·缺省落 ADMISSION_DEFAULTS）。 */
  admission?: Record<string, Partial<Record<AdmissionCell, AdmissionStrength>>>;
}

export interface Settings {
  paused: boolean;
  policy: { rules: Rule[]; sources: Record<string, SourcePolicy> };
  eval: { mode: AcceptMode };
}

/** 缺省谱（裁面①：mode='off' fail-safe 保守·paused=false 零 rules 零 sources）。 */
export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  policy: { rules: [], sources: {} },
  eval: { mode: 'off' },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseAllowed = (value: unknown, label: string): AllowedEntry[] => {
  if (!Array.isArray(value)) throw new UserError(`${label} must be an array`);
  return value.map((entry): AllowedEntry => {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      throw new UserError(`${label} entries must be {id, name?}`);
    }
    return { id: entry.id, ...(typeof entry.name === 'string' ? { name: entry.name } : {}) };
  });
};

const ADMISSION_VALUES: readonly AdmissionStrength[] = ['ignore', 'inferred', 'explicit'];

/** 轻量校验（SettingsRepo.put 前置门·形不对抛 UserError——零 zod 依赖）。 */
export function validateSettings(value: unknown): Settings {
  if (!isRecord(value)) throw new UserError('Settings must be an object');
  const { paused, policy, eval: evalBlock } = value as Record<string, unknown>;
  if (typeof paused !== 'boolean') throw new UserError('Settings.paused must be a boolean');
  if (!isRecord(policy)) throw new UserError('Settings.policy must be an object');
  if (!Array.isArray((policy as Record<string, unknown>).rules)) {
    throw new UserError('Settings.policy.rules must be an array');
  }
  const rules = ((policy as Record<string, unknown>).rules as unknown[]).map((rule): Rule => {
    if (!isRecord(rule) || typeof rule.id !== 'string' || typeof rule.name !== 'string'
      || typeof rule.instruction !== 'string' || typeof rule.enabled !== 'boolean') {
      throw new UserError('Settings.policy.rules entries must be {id, name, instruction, enabled}');
    }
    return { id: rule.id, name: rule.name, instruction: rule.instruction, enabled: rule.enabled };
  });
  const rawSources = (policy as Record<string, unknown>).sources;
  if (!isRecord(rawSources)) throw new UserError('Settings.policy.sources must be an object');
  const sources: Record<string, SourcePolicy> = {};
  for (const [source, block] of Object.entries(rawSources)) {
    if (!isRecord(block) || !('allowed' in block)) {
      throw new UserError(`Settings.policy.sources[${source}] must have allowed`);
    }
    const entry: SourcePolicy = { allowed: parseAllowed(block.allowed, `sources[${source}].allowed`) };
    if (block.bots !== undefined) entry.bots = parseAllowed(block.bots, `sources[${source}].bots`);
    if (block.admission !== undefined) {
      if (!isRecord(block.admission)) throw new UserError(`sources[${source}].admission must be an object`);
      const admission: Record<string, Partial<Record<AdmissionCell, AdmissionStrength>>> = {};
      for (const [row, cells] of Object.entries(block.admission)) {
        if (!isRecord(cells)) throw new UserError(`sources[${source}].admission[${row}] must be an object`);
        const cellEntry: Partial<Record<AdmissionCell, AdmissionStrength>> = {};
        for (const [cell, strength] of Object.entries(cells)) {
          if (!(ADMISSION_VALUES as readonly string[]).includes(strength as string)) {
            throw new UserError(`sources[${source}].admission[${row}][${cell}] must be ignore|inferred|explicit`);
          }
          cellEntry[cell as AdmissionCell] = strength as AdmissionStrength;
        }
        admission[row] = cellEntry;
      }
      entry.admission = admission;
    }
    sources[source] = entry;
  }
  if (!isRecord(evalBlock)) throw new UserError('Settings.eval must be an object');
  const mode = (evalBlock as Record<string, unknown>).mode;
  if (mode !== 'off' && mode !== 'observe' && mode !== 'auto') {
    throw new UserError('Settings.eval.mode must be off|observe|auto');
  }
  return { paused, policy: { rules, sources }, eval: { mode } };
}

// ── policyVersion（原型 L111-118 正形·哈希=sha256 前 32 hex·只授权影响面进哈希）──

export const POLICY_REVISION = 'v2-mandate-1';

/** 照原型 ids.ts key() L3-5 正形（JSON.stringify(values)·hex slice 0,32）。 */
const versionKey = (...values: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex').slice(0, 32);

/**
 * 授权影响面版本哈希（原型 L114 注正形：模型/并发/pause 状态/轮询间隔变更
 * 不失效既有决定——只 rules/mode/sources 进哈希）。
 */
export function policyVersion(settings: Settings): string {
  return versionKey(POLICY_REVISION, JSON.stringify({
    rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources,
  }));
}

// ── sender 名单查找（id 精确等值·正名纪律·别名不采）──

export function allowedSender(settings: Settings, actor: ActorRef): AllowedEntry | undefined {
  return settings.policy.sources[actor.source]?.allowed.find((entry) => entry.id === actor.id);
}

/** bot 名单查找（inferred candidate 上限·照原型 listedBot L123-126）。 */
export function listedBot(settings: Settings, actor: ActorRef): AllowedEntry | undefined {
  return settings.policy.sources[actor.source]?.bots?.find((entry) => entry.id === actor.id);
}

/** (allowed,addressed)→cell 四象限（listed+addressed=undefined 直过·照原型 L135-137）。 */
const admissionCell = (allowed: boolean, addressed: boolean): AdmissionCell | undefined =>
  allowed ? (addressed ? undefined : 'listedUnaddressed') : (addressed ? 'unlistedAddressed' : 'unlistedUnaddressed');

/** per-row 表覆盖 ?? ADMISSION_DEFAULTS（照原型 L138-140）。 */
const admissionOf = (settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): AdmissionStrength =>
  (row !== undefined ? settings.policy.sources[source]?.admission?.[row]?.[cell] : undefined)
    ?? ADMISSION_DEFAULTS[cell];

// ── scope 面（裁面③：注入式·缺省全收单机 shadow 形）──

export interface ScopeView { listened: boolean; observed?: boolean; row?: string }
export type ScopeResolver = (source: string, meta?: Record<string, unknown>) => ScopeView;
export const DEFAULT_SCOPE: ScopeResolver = () => ({ listened: true, observed: true });

// ── gate 面与变更效果面类型 ──

export interface GateTrigger {
  human: boolean;
  actor: ActorRef;
  source: string;
  addressed?: string;
  meta?: Record<string, unknown>;
}

export interface GateResult {
  admissible: boolean;
  strength?: Strength;
  basis?: Mandate;
  reason?: 'not_human' | 'not_a_member' | 'admission_ignored' | 'no_mention';
}

/** settings 变更对单票的效果面（原型 PolicyEffect 形）。 */
export interface PolicyEffect {
  rules?: { id: string; name: string; change: 'disabled' | 'changed'; instruction?: string }[];
  requesterAllowed?: false;
  requester?: ActorRef;
  proactive?: false;
}

/**
 * settings 变更 diff→逐 open 票效果面（原型 policyEffects L144-165 正形移植）：
 * ①rules 面（disabled/changed·JSON 等值判）②sender 授权丢失面（before 过∧
 * after 拒且 old-rules-as-before 仍拒→requesterAllowed=false）③proactive 降级面
 * （inferred+auto→非 auto）。空 effect 不入 Map。
 */
export function policyEffects(
  tickets: readonly TicketRecord[],
  old: Settings,
  now: Settings,
  scope: ScopeResolver,
): Map<string, PolicyEffect> {
  const before = new Policy(old, scope);
  const after = new Policy(now, scope);
  const effects = new Map<string, PolicyEffect>();
  for (const ticket of tickets) {
    const rules = (ticket.mandate.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find((rule) => rule.id === id);
      const is = now.policy.rules.find((rule) => rule.id === id);
      if (is?.enabled !== true) return was?.enabled === true ? [{ id, name: was!.name, change: 'disabled' }] : [];
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }];
    });
    const effect: PolicyEffect = rules.length > 0 ? { rules } : {};
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // 授权丢失排除法：old 的 rules/mode 保持下仍拒→sender/scope 面丢权（原型 L156-159）。
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } };
      if (!new Policy(asBefore, scope).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor });
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') {
        effect.proactive = false;
      }
    }
    if (Object.keys(effect).length > 0) effects.set(ticket.id, effect);
  }
  return effects;
}

// ── SettingsRepo（KV 单行持久·表 DDL 归本件照族形）──

export class SettingsRepo {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec('CREATE TABLE IF NOT EXISTS policy_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }

  get(): Settings | undefined {
    const row = this.db.prepare("SELECT value FROM policy_settings WHERE id = 'settings'").get() as { value: string } | undefined;
    return row === undefined ? undefined : validateSettings(JSON.parse(row.value));
  }

  put(settings: Settings): void {
    this.db.prepare("INSERT OR REPLACE INTO policy_settings (id, value) VALUES ('settings', ?)")
      .run(JSON.stringify(settings));
  }
}

/**
 * Policy 完整门族（原型 settingsPolicy L167-242 升形）。**holder 形**（照
 * closingFlag holder 先例·N5 落形勘定）：票域 deps 持本类引用注入——settings
 * 变更走 rebind（引用不变内部重绑·version/paused/mode 更新）=applySettings
 * 换谱零破票域依赖（新谱即对 wake/revalidate 生效）。gate=入票门（原型 gate
 * L191-211+machineGate L171-188 正形）；revalidate=授权重验完整谱（原型
 * L213-240 正形移植·门①裁②升形注见文件头）。
 */
export class Policy {
  version: string;
  paused: boolean;
  mode: AcceptMode;
  private settings: Settings;
  private scope: ScopeResolver;

  constructor(settings: Settings, scope: ScopeResolver = DEFAULT_SCOPE) {
    this.settings = settings;
    this.scope = scope;
    this.version = policyVersion(settings);
    this.paused = settings.paused;
    this.mode = settings.eval.mode;
  }

  /** settings 重绑（applySettings 域内调·引用不变=票域 deps 零破）。 */
  rebind(settings: Settings, scope: ScopeResolver = this.scope): void {
    this.settings = settings;
    this.scope = scope;
    this.version = policyVersion(settings);
    this.paused = settings.paused;
    this.mode = settings.eval.mode;
  }

  private scopeRecord(trigger: GateTrigger, row: string | undefined): Record<string, unknown> {
    const record: Record<string, unknown> = { ...(trigger.meta ?? {}) };
    if (row !== undefined) record.row = row;
    return record;
  }

  /** 非 human 门（原型 machineGate L171-188 正形）：bot 表 candidate+senderless 系统事件。 */
  private machineGate(trigger: GateTrigger): GateResult {
    const bot = trigger.actor.id ? listedBot(this.settings, trigger.actor) : undefined;
    if (trigger.actor.id && bot === undefined) return { admissible: false, reason: 'not_human' };
    const scope = this.scope(trigger.source, trigger.meta);
    if (!scope.listened || !(trigger.addressed !== undefined || scope.observed === true)) {
      return { admissible: false, reason: 'not_human' };
    }
    const scopeRecord = this.scopeRecord(trigger, scope.row);
    const addressed = trigger.addressed !== undefined ? { addressed: trigger.addressed } : {};
    if (bot !== undefined) {
      if (this.mode === 'off') return { admissible: false, reason: 'admission_ignored' };
      return {
        admissible: true,
        strength: 'inferred',
        basis: {
          via: 'bot', strength: 'inferred', actor: trigger.actor, source: trigger.source,
          scope: scopeRecord, ...addressed, observation: { mode: this.mode },
        },
      };
    }
    const cell: AdmissionCell = 'unlistedUnaddressed';
    if (admissionOf(this.settings, trigger.source, scope.row, cell) !== 'inferred' || this.mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' };
    }
    return {
      admissible: true,
      strength: 'inferred',
      basis: {
        via: 'admission', strength: 'inferred', actor: trigger.actor, source: trigger.source,
        scope: scopeRecord, cell, ...addressed, observation: { mode: this.mode },
      },
    };
  }

  /**
   * 入票门（原型 gate L191-211 正形·裁面④participating 调用方算缺省 false）。
   * explicit 直过先于 followup（原型 L203 注：线程票不把显式请求弱化为
   * followup）；拒 reason 谱=not_a_member/admission_ignored/no_mention。
   */
  gate(trigger: GateTrigger, context?: { participating?: boolean }): GateResult {
    if (!trigger.human) return this.machineGate(trigger);
    const allowed = allowedSender(this.settings, trigger.actor);
    const scope = this.scope(trigger.source, trigger.meta);
    const row = scope.listened ? scope.row : undefined;
    const scopeRecord = this.scopeRecord(trigger, row);
    if (allowed !== undefined && trigger.addressed !== undefined) {
      return {
        admissible: true,
        strength: 'explicit',
        basis: { via: 'addressed', strength: 'explicit', actor: trigger.actor, source: trigger.source, scope: scopeRecord },
      };
    }
    const cell = admissionCell(allowed !== undefined, trigger.addressed !== undefined)!;
    // Unaddressed 消息只在 scope 全收（observed）时走 admission 表（原型 L199-200）。
    const receivable = trigger.addressed !== undefined || (scope.listened && scope.observed === true);
    const admission = receivable ? admissionOf(this.settings, trigger.source, row, cell) : 'ignore';
    if (admission === 'explicit') {
      return {
        admissible: true,
        strength: 'explicit',
        basis: { via: 'admission', strength: 'explicit', actor: trigger.actor, source: trigger.source, scope: scopeRecord, cell },
      };
    }
    // followup 支（原型 L206-208）：direct-unlisted 不走+allowed∨mode≠off+participating。
    const directUnlisted = trigger.addressed === 'direct' && allowed === undefined;
    const participating = context?.participating === true;
    if (!directUnlisted && (allowed !== undefined || this.mode !== 'off') && participating) {
      const strength: Strength = allowed !== undefined ? 'explicit' : 'inferred';
      return {
        admissible: true,
        strength,
        basis: { via: 'followup', strength, actor: trigger.actor, source: trigger.source, scope: scopeRecord },
      };
    }
    if (admission === 'inferred' && this.mode !== 'off') {
      return {
        admissible: true,
        strength: 'inferred',
        basis: {
          via: 'admission', strength: 'inferred', actor: trigger.actor, source: trigger.source,
          scope: scopeRecord, cell, observation: { mode: this.mode },
        },
      };
    }
    return {
      admissible: false,
      reason: allowed === undefined
        ? 'not_a_member'
        : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention',
    };
  }

  /** rulesOn（原型 L219 正形·vacuous true——空 rules 全过）。 */
  private rulesOn(ids: string[] | undefined): boolean {
    return (ids ?? []).every((id) => this.settings.policy.rules.some((rule) => rule.enabled && rule.id === id));
  }

  /** 授权重验完整谱（原型 L213-240 正形移植·true=授权仍有效）。 */
  revalidate(mandate: Mandate): boolean {
    const current = mandate.scope !== undefined ? this.scope(mandate.source, mandate.scope) : undefined;
    if (current !== undefined && !current.listened) return false; // 失听拒 L217-218
    if (mandate.via === 'followup') {
      return mandate.strength === 'explicit' || (this.mode === 'auto' && this.rulesOn(mandate.rules)); // L221
    }
    if (mandate.via === 'bot' && listedBot(this.settings, mandate.actor) === undefined) return false; // L223
    if (mandate.via === 'admission') {
      const cell = mandate.cell;
      if (cell === undefined) return false; // 非正规形保守拒（v2 裁·原型宽容差如实注）
      const listed = allowedSender(this.settings, mandate.actor) !== undefined;
      if (cell === 'unlistedAddressed' && listed) return true; // L229
      const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell; // L231 迁移升格
      if (now === 'listedUnaddressed' && !listed) return false; // L232
      const row = current !== undefined && current.listened ? current.row : undefined;
      const admission = admissionOf(this.settings, mandate.source, row, now); // L233
      if (ADMISSION_STRENGTH[admission] < STRENGTH[mandate.strength]) return false; // L234（裁②跨表比数）
      if (mandate.strength === 'explicit') return true; // L235
    } else if (mandate.via !== 'bot' && allowedSender(this.settings, mandate.actor) === undefined) {
      return false; // L236：listed/addressed 需 sender 在册
    }
    if ((mandate.via === 'admission' || mandate.via === 'listed' || mandate.via === 'bot') && mandate.observation !== undefined) {
      return this.mode === 'auto' && this.rulesOn(mandate.rules); // L238
    }
    return true;
  }
}
