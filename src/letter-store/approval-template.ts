// ── FADE-010 首落②：候批信四行模板（fullauto-loop joint-plan §一；零 LLM 纯确定性）──
// 候批态触发时自动生成信件 payload——四行固定格式（收口notify 顺产调用；bod+coo 双投）。

export interface ApprovalLetterPayload {
  taskRef: string;      // 任务书锚（树路径/工件 id）
  title: string;        // 一句话内容摘要
  waitingSince: string; // 候批态发起时点 ISO+Z
  upstream: string;     // 上游催办链（谁/哪环转来）
}

/** 四行固定模板（payload 五字段直映——零 LLM，纯拼接）。 */
export function renderApprovalLetter(p: ApprovalLetterPayload): string {
  return [
    `【候批】${p.title}`,
    `任务书：${p.taskRef}`,
    `候批起点：${p.waitingSince}`,
    `上游链：${p.upstream}`,
  ].join('\n');
}
