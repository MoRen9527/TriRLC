// ── 组长信箱工具集（LG-026-P2-B3）──
// 组长 in-process agentLoop 的工具白名单：信件 CRUD + SendMessage（daemon 语义=
// 写信落库）+ 台账读。minTier:'heartbeat' 声明式注册（agent-core BOD 裁甲）——
// 非 heartbeat+ tier 清单不可见，shell/文件工具不入组长工具集（§8.6 白名单注册制）。
//
// 分层：
//   - 组长是唯一投递执行者：letter_deliver 内部固定 actor=LEAD_AGENT_ID；
//   - 收件人唯一定读权：组长工具集不含 read（组长不得代标，read 仅 state 端点
//     由收件人 actor 触发，store 门禁校验）；
//   - 台账写仅在流转内发生，工具集只读台账。
//
// 工具 handler 同进程调 LetterStore（非 HTTP 自环）——daemon 单进程语义最短路径。

import { register as registerTool } from '@tricompany/agent-core';
import type { ToolDefinition } from 'trimodel';
import type { LetterStore } from './store.js';
import { LEAD_AGENT_ID } from './store.js';
import type { LetterPriority } from './types.js';

const PRIORITIES: LetterPriority[] = ['常规', '重要', '急件'];

function def(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

/**
 * 注册组长工具集（幂等：register 覆盖同名）。channel profile 下启动时调用一次。
 */
export function registerLeadTools(store: LetterStore): void {
  registerTool(
    def(
      'letter_list_pending',
      '查收待投信件（status=pending），返回按 seq 排序的信件列表。',
      {},
      [],
    ),
    async () => JSON.stringify({ letters: store.listLetters({ status: 'pending' }) }),
    { minTier: 'heartbeat' },
  );

  registerTool(
    def(
      'letter_deliver',
      `投递一封信（唯一投递执行者=${LEAD_AGENT_ID}）。信件从 pending 流转为 delivered。`,
      { letter_id: { type: 'string', description: '信件 ID' } },
      ['letter_id'],
    ),
    async (args) => {
      const letterId = String(args.letter_id ?? '');
      try {
        const rec = store.transition(letterId, 'deliver', LEAD_AGENT_ID);
        return JSON.stringify({ ok: true, letter: rec });
      } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
      }
    },
    { minTier: 'heartbeat' },
  );

  registerTool(
    def(
      'letter_escalate',
      `升级一封信（形式复核后）：冻结原信并创建引用原信的升级新信封。终裁升级权在 COS。`,
      {
        letter_id: { type: 'string', description: '原信 ID' },
        to: { type: 'string', description: '升级接收方（如 COS）' },
        reason: { type: 'string', description: '升级理由（形式复核结论）' },
      },
      ['letter_id', 'to', 'reason'],
    ),
    async (args) => {
      try {
        const result = store.escalateLetter(String(args.letter_id ?? ''), LEAD_AGENT_ID, {
          from: LEAD_AGENT_ID,
          to: String(args.to ?? 'COS'),
          priority: '急件',
          payload: { reason: String(args.reason ?? ''), escalatedBy: LEAD_AGENT_ID },
        });
        return JSON.stringify({ ok: true, original: result.original, envelope: result.envelope });
      } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
      }
    },
    { minTier: 'heartbeat' },
  );

  registerTool(
    def(
      'send_letter',
      `以${LEAD_AGENT_ID}名义寄信（SendMessage daemon 语义=写信落库；在线直推属 P3 推送面）。`,
      {
        to: { type: 'string', description: '收件人' },
        priority: { type: 'string', description: '优先级：常规|重要|急件', enum: [...PRIORITIES] },
        payload: { type: 'object', description: '信件内容（JSON 对象）' },
        ttl_seconds: { type: 'number', description: '有效窗秒数（可选）' },
      },
      ['to', 'priority', 'payload'],
    ),
    async (args) => {
      const priority = String(args.priority ?? '常规') as LetterPriority;
      if (!PRIORITIES.includes(priority)) {
        return JSON.stringify({ ok: false, error: `invalid_priority: ${priority}` });
      }
      try {
        const rec = store.insertLetter({
          from: LEAD_AGENT_ID,
          to: String(args.to ?? ''),
          priority,
          payload: args.payload ?? null,
          ttlSeconds: typeof args.ttl_seconds === 'number' ? args.ttl_seconds : null,
        });
        return JSON.stringify({ ok: true, letter_id: rec.letterId, seq_no: rec.seqNo });
      } catch (err) {
        return JSON.stringify({ ok: false, error: (err as Error).message });
      }
    },
    { minTier: 'heartbeat' },
  );

  registerTool(
    def(
      'ledger_read',
      '读台账（状态流转流水）。可按 letter_id 过滤，一信多行。',
      { letter_id: { type: 'string', description: '信件 ID（可选，缺省读全部）' } },
      [],
    ),
    async (args) => {
      const letterId = args.letter_id ? String(args.letter_id) : undefined;
      return JSON.stringify({ entries: store.listLedger(letterId ? { letterId } : undefined) });
    },
    { minTier: 'heartbeat' },
  );
}
