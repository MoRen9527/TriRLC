// ── N4 Policy 最小门（形三 α · N4 票域并入·设计卷 §三裁减表落形）──
//
// 思想源=dsh-superagent 原型 src/policy.ts（242 行·补读笔记 9f37e4e75 §一）+
// model.ts Mandate/MandateBasis 正形（353 行·条件执行注 §七A）。
// 裁减表（设计卷 §三·判定书采认）：保留 paused flag+revalidate 三支+admission
// cell 表（ADMISSION_DEFAULTS）+STRENGTH 表——gate L191-211/settings schema/
// zod/policyVersion/policyEffects/assessmentOutcome/Eval 全部划出=嫁接域
// （N5/N6+事件源·settings 面候接）。eval mode 面 v2 首版恒 auto 谱（如实注：
// mode 配置候事件源嫁接时补）。
//
// Mandate 最小形=原型 Mandate 正形的 revalidate 消费面投影（§七A.4 对照注）：
// strength 直取+via/cell/rules/observation=basis 投影+actor 直取；原型
// policyVersion/scope 首版裁减不持久（候嫁接域补全）。

/** Actor identity in the source's own vocabulary（照原型 model.ts L5）。 */
export interface ActorRef { source: string; id: string }

/** 授权强度：explicit=人显式请求/inferred=规则推断（照原型 model.ts L96）。 */
export type Strength = 'explicit' | 'inferred';

/** 观察模式（照原型 model.ts L103·v2 首版恒 auto 谱·mode 面候嫁接）。 */
export type AcceptMode = 'off' | 'observe' | 'auto';

/** Admission 表 cell（照原型 model.ts L98·listed/unlisted × addressed/unaddressed）。 */
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed';

/**
 * 授权最小形（原型 Mandate L126-133 的 revalidate 消费面投影·§七A.4）：
 * via 五形照原型 MandateBasis L116-123（addressed/followup/admission/listed/bot）。
 */
export interface Mandate {
  via: 'addressed' | 'followup' | 'admission' | 'listed' | 'bot';
  strength: Strength;
  actor: ActorRef;
  source: string;
  /** 接受时命中的规则 id（原型 basis.rules·observation→rulesOn 支判据）。 */
  rules?: string[];
  /** via='admission' 时的 cell（原型 basis.cell）。 */
  cell?: AdmissionCell;
  /** inferred 候选在观察模式下记录的观察标记（原型 basis.observation）。 */
  observation?: { mode: AcceptMode };
}

/** 强度序（照原型 policy.ts STRENGTH L141 语义：explicit > inferred）。 */
export const STRENGTH: Record<Strength, number> = { explicit: 2, inferred: 1 };

/**
 * Admission 默认表（cell 谱 3×2 裁定保留面·设计卷 §三）。缺省表形如实注：
 * listed sender 未点名与 unlisted 点名均按 explicit 采；unlisted 未点名=inferred
 * ——settings 面嫁接时由配置覆盖（v2 首版零 settings schema）。
 */
export const ADMISSION_DEFAULTS: Record<AdmissionCell, Strength> = {
  listedUnaddressed: 'explicit',
  unlistedAddressed: 'explicit',
  unlistedUnaddressed: 'inferred',
};

/**
 * Policy 最小门：paused flag（wake/addInput 门）+revalidate 三支。
 * revalidate 语义（照原型 settingsPolicy L213-240 裁减三支·true=授权仍有效）：
 *   ① followup explicit 免——人的显式跟单免重验（原型 L220-222 支）；
 *   ② admission cell 强度不降——mandate.strength ≥ 该 cell 缺省强度（原型
 *      L226-228 STRENGTH 表判·降级=拒）；
 *   ③ observation→rulesOn——观察标记 mandate 在规则已启用（rules 非空）时放行
 *      （原型 L238 observation→auto+rulesOn 支·v2 恒 auto 谱=rulesOn 即判）。
 * 其余 via（addressed/listed/bot）最小门保守拒（如实注：完整谱=嫁接域 gate 面）。
 */
export class Policy {
  /** 暂停旗：wake 拒（addInput 门候嫁接域消费）。 */
  paused = false;

  /** 授权重验：true=该 mandate 在当前 policy 下仍可继续/复活。 */
  revalidate(mandate: Mandate): boolean {
    if (mandate.via === 'followup' && mandate.strength === 'explicit') return true;
    if (mandate.via === 'admission' && mandate.cell !== undefined) {
      return STRENGTH[mandate.strength] >= STRENGTH[ADMISSION_DEFAULTS[mandate.cell]];
    }
    if (mandate.observation !== undefined && (mandate.rules?.length ?? 0) > 0) return true;
    return false;
  }
}
