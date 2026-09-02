// ── LG-026-P2-B3 组长工具集单测 ──
// registerLeadTools：letter_* 五件 minTier:'heartbeat' 声明式注册（agent-core 裁甲）；
// 清单级白名单断言 + handler 行为（actor 固定 LEAD_AGENT_ID / 无 read 工具）。

import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { createLetterStore, LEAD_AGENT_ID, ESCALATE_ACTOR_ALLOWLIST } from '../src/letter-store/store.js';
import type { LetterStore } from '../src/letter-store/store.js';
import { registerLeadTools } from '../src/letter-store/lead-tools.js';
import { register, unregister, getToolDefinitions, executeTool, hasTool } from '@tricompany/agent-core';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DB = join(tmpdir(), `trilc-test-lead-tools-${Date.now()}.db`);

const LEAD_TOOLS = [
  'letter_list_pending',
  'letter_deliver',
  'letter_escalate',
  'send_letter',
  'ledger_read',
];

describe('LeadTools (LG-026-P2-B3)', () => {
  let store: LetterStore;

  const cleanup = () => {
    for (const t of LEAD_TOOLS) { try { unregister(t); } catch { /* ok */ } }
    try { unlinkSync(TEST_DB); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
    try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
  };

  afterEach(() => {
    try { store.close(); } catch { /* ok */ }
    cleanup();
  });

  it('registers letter_* tools visible to heartbeat tier, invisible to subagent', () => {
    cleanup();
    store = createLetterStore(TEST_DB, { leaderId: LEAD_AGENT_ID });
    registerLeadTools(store);

    for (const name of LEAD_TOOLS) {
      assert.ok(hasTool(name), `${name} should be registered`);
      assert.ok(
        getToolDefinitions('heartbeat').some((d) => d.function.name === name),
        `${name} visible at heartbeat tier`,
      );
      assert.ok(
        !getToolDefinitions('subagent').some((d) => d.function.name === name),
        `${name} invisible at subagent tier`,
      );
    }
    // 组长工具集无 read（收件人唯一定读权，组长不得代标）且无 shell/文件写工具注册进来
    assert.ok(!hasTool('letter_read'));
  });

  it('letter_deliver handler delivers with fixed leader actor', async () => {
    cleanup();
    store = createLetterStore(TEST_DB, { leaderId: LEAD_AGENT_ID });
    registerLeadTools(store);

    const rec = store.insertLetter({ from: 'alice', to: 'bob', priority: '常规', payload: { n: 1 } });
    const raw = await executeTool('letter_deliver', { letter_id: rec.letterId });
    const result = JSON.parse(raw);
    assert.equal(result.ok, true);
    assert.equal(result.letter.status, 'delivered');
    // 台账留痕：send + deliver(actor=组长)
    const trail = store.listLedger({ letterId: rec.letterId });
    assert.deepStrictEqual(
      trail.map((e) => e.action),
      ['send', 'deliver'],
    );
    assert.equal(trail[1]!.actor, LEAD_AGENT_ID);
    // store 门禁兜底：组长也不得代标 read
    assert.throws(() => store.transition(rec.letterId, 'read', LEAD_AGENT_ID), /actor_forbidden/);
  });

  it('letter_escalate handler freezes original and creates ref envelope', async () => {
    cleanup();
    store = createLetterStore(TEST_DB, { leaderId: LEAD_AGENT_ID });
    registerLeadTools(store);

    const rec = store.insertLetter({ from: 'alice', to: 'bob', priority: '急件', payload: { q: 1 } });
    const raw = await executeTool('letter_escalate', {
      letter_id: rec.letterId,
      to: 'COS',
      reason: '急件即时升级',
    });
    const result = JSON.parse(raw);
    assert.equal(result.ok, true);
    assert.equal(result.original.status, 'escalated');
    assert.equal(result.envelope.refLetterId, rec.letterId);
    assert.equal(result.envelope.to, 'COS');
  });

  it('send_letter handler sends as leader and rejects bad priority', async () => {
    cleanup();
    store = createLetterStore(TEST_DB, { leaderId: LEAD_AGENT_ID });
    registerLeadTools(store);

    const raw = await executeTool('send_letter', {
      to: 'bob',
      priority: '重要',
      payload: { text: '办理完毕' },
    });
    const result = JSON.parse(raw);
    assert.equal(result.ok, true);
    const got = store.getLetter(result.letter_id)!;
    assert.equal(got.from, LEAD_AGENT_ID);
    assert.equal(got.priority, '重要');

    const bad = JSON.parse(await executeTool('send_letter', {
      to: 'bob', priority: '紧急', payload: {},
    }));
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid_priority/);
  });

  it('LEAD_AGENT_ID is the single source shared with escalate ACL allowlist (CTO 提醒②)', () => {
    assert.ok(ESCALATE_ACTOR_ALLOWLIST.includes(LEAD_AGENT_ID));
    assert.ok(ESCALATE_ACTOR_ALLOWLIST.includes('COS'));
  });
});
