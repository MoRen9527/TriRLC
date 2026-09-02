// ── LG-026-P2-B1/B2 + P3-R1/R2/F1/F2/F4 信件端点端到端 ──
// 配方对齐 test/server/tasks-submit-weekly-hint.test.ts 既有先例：
// 临时数据目录 + port 0 + trimodelApiUrl 死端口 + TRILC_INTERNAL_TOKEN 注入。
// 覆盖：寄信 201（actor 契约+from 强制覆盖 F1+驼峰 F4）/ 校验矩阵 / 收信 box+
// since_seq / 状态流转门禁 / B2 escalate 原子 ACL（envelope.from 必填=actor F1、
// priority 非法 400 F2）/ 台账读 / wake 202 / R1 SSE 直推+上线即报补拉。
// 非通道态实例（无组长注册）：wake 触发为空转，端点行为不受组长影响。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriLCApp } from '../../src/server/app.js';

const SAVED_ENV = {
  TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
  TRILC_PORT: process.env.TRILC_PORT,
  TRILC_PROJECT_ROOT: process.env.TRILC_PROJECT_ROOT,
  TRILC_CHANNEL_MODE: process.env.TRILC_CHANNEL_MODE,
  TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
  TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
};

const TEST_INTERNAL_TOKEN = 'letters-e2e-internal-token';

let tmpDataDir: string;
let app: ReturnType<typeof createTriLCApp>;
let appPort: number;

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-internal-token': TEST_INTERNAL_TOKEN,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

/** 读 SSE 流的首个事件帧（event+data），限时 ms；流提前关返回 null。
 * 读完可选发 cancel 终止会话（否则服务端 agentLoop 死端口重试拖住 server.close）。 */
async function readFirstFrame(
  url: string,
  timeoutMs = 5000,
  cancelSessionId?: string,
): Promise<{ event: string; data: any } | null> {
  const res = await fetch(url, {
    headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
  });
  if (!res.ok || !res.body) return null;
  const reader = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder();
  let buf = '';
  const timer = setTimeout(() => { try { reader.cancel(); } catch { /* ok */ } }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return buf.includes('event:') ? parseFrame(buf) : null;
      buf += decoder.decode(value, { stream: true });
      const idx = buf.indexOf('\n\n');
      if (idx >= 0) {
        if (cancelSessionId) {
          await req('POST', `/internal/v1/sessions/${cancelSessionId}/cancel`, {}).catch(() => { /* best-effort */ });
        }
        return parseFrame(buf.slice(0, idx));
      }
    }
  } finally {
    clearTimeout(timer);
    try { reader.cancel(); } catch { /* ok */ }
  }
}

function parseFrame(block: string): { event: string; data: any } {
  const evLine = block.split('\n').find((l) => l.startsWith('event:'));
  const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
  let data: any = null;
  try { data = JSON.parse(dataLine!.slice(5).trim()); } catch { data = null; }
  return { event: evLine!.slice(6).trim(), data };
}

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-letters-'));
  process.env.TRILC_DATA_DIR = tmpDataDir;
  process.env.TRILC_PORT = '0';
  process.env.TRILC_PROJECT_ROOT = tmpDataDir;
  delete process.env.TRILC_CHANNEL_MODE; // 非通道态：不注册组长
  delete process.env.TRIMODEL_API_TOKEN;
  process.env.TRILC_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1';

  app = createTriLCApp(env);
  await app.start();
  appPort = env.port;
  if (!appPort) throw new Error('app did not bind a port');
});

after(async () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  try { await app.stop(); } catch { /* swallow */ }
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(tmpDataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

describe('letters endpoints (LG-026-P2 + P3)', () => {
  it('rejects requests without internal token (全局门覆盖信件面)', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/letters`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('POST letters → 201 { letterId, seqNo } 驼峰契约 (F4); from forced to actor (F1)', async () => {
    const r1 = await req('POST', '/internal/v1/letters', {
      actor: 'alice', from: 'someone-else', to: 'bob', priority: '常规', payload: { text: 'hello' },
    });
    assert.equal(r1.status, 201);
    assert.ok(r1.json.letterId.startsWith('LT-')); // 驼峰（F4）
    assert.equal(r1.json.seqNo, 1);
    // F1：请求体 from 伪报被覆盖为 actor
    const got = await req('GET', `/internal/v1/letters?box=out&from=alice`);
    assert.equal(got.json.letters[0]!.from, 'alice');
    assert.equal(got.json.letters[0]!.letterId, r1.json.letterId);

    const r2 = await req('POST', '/internal/v1/letters', {
      actor: 'carol', to: 'dave', priority: '急件', payload: { text: 'urgent' },
    });
    assert.equal(r2.json.seqNo, 2); // daemon 级全局单调
  });

  it('validates envelope: missing actor / missing to / bad priority / bad json / dup id', async () => {
    // actor 必填（F1）
    const noActor = await req('POST', '/internal/v1/letters', { to: 'x', payload: {} });
    assert.equal(noActor.status, 400);
    assert.equal(noActor.json.error, 'invalid_actor');
    assert.equal((await req('POST', '/internal/v1/letters', { actor: 'a', payload: {} })).status, 400);
    assert.equal(
      (await req('POST', '/internal/v1/letters', { actor: 'a', to: 'b', priority: '紧急', payload: {} })).status,
      400,
    );
    const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/letters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': TEST_INTERNAL_TOKEN },
      body: '{broken',
    });
    assert.equal(res.status, 400);
    await req('POST', '/internal/v1/letters', { actor: 'a', to: 'b', payload: {}, letter_id: 'LT-dup-1' });
    const dup = await req('POST', '/internal/v1/letters', { actor: 'a', to: 'b', payload: {}, letter_id: 'LT-dup-1' });
    assert.equal(dup.status, 409);
  });

  it('GET letters supports box / status / since_seq replay filters', async () => {
    assert.equal((await req('GET', '/internal/v1/letters?box=in')).status, 400);
    assert.equal((await req('GET', '/internal/v1/letters?box=out')).status, 400);

    const inbox = await req('GET', '/internal/v1/letters?box=in&to=bob');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.json.letters.every((l: any) => l.to === 'bob'));

    const first = inbox.json.letters[0];
    const replay = await req('GET', `/internal/v1/letters?box=in&to=bob&since_seq=${first.seq_no ?? first.seqNo}`);
    assert.equal(replay.json.letters.length, 0); // bob 只有 seq 1 一封

    const pending = await req('GET', '/internal/v1/letters?status=pending&limit=1');
    assert.equal(pending.json.letters.length, 1);
  });

  it('state transitions enforce store gating via HTTP (deliver/read + 403/404/409)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      actor: 'erin', to: 'frank', priority: '常规', payload: {},
    });
    const id = made.json.letterId;

    // 非组长 deliver → 403（actor_forbidden）
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'deliver', actor: 'erin' })).status, 403);
    // 组长 deliver → 200
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'deliver', actor: '组长' })).status, 200);
    // 组长代标 read → 403（收件人唯一定读权）
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'read', actor: '组长' })).status, 403);
    // 收件人 read → 200
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'read', actor: 'frank' })).status, 200);
    // 重复 deliver → 409（非法流转）
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'deliver', actor: '组长' })).status, 409);
    // 不存在信件 → 404
    assert.equal((await req('POST', '/internal/v1/letters/LT-none/state', { action: 'deliver', actor: '组长' })).status, 404);
    // 非法 action/actor → 400
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'explode', actor: 'x' })).status, 400);
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'done' })).status, 400);
  });

  it('escalate ACL: outside allowlist → 403 + ledger trail (B2)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      actor: 'gina', to: 'hank', priority: '重要', payload: {},
    });
    const id = made.json.letterId;

    const denied = await req('POST', `/internal/v1/letters/${id}/state`, { action: 'escalate', actor: 'gina' });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'escalate_actor_forbidden');

    // 拒绝留痕：台账含 escalate_denied 行，信件状态未被改动
    const trail = await req('GET', `/internal/v1/ledger?letter_id=${id}`);
    assert.ok(trail.json.entries.some((e: any) => e.action === 'escalate_denied' && e.actor === 'gina'));
    const letter = await req('GET', `/internal/v1/letters?box=in&to=hank`);
    assert.equal(letter.json.letters[0]!.status, 'pending');
  });

  it('escalate requires envelope with from=actor (F1) and valid priority (F2)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      actor: 'ivy', to: 'jack', priority: '重要', payload: {},
    });
    const id = made.json.letterId;

    // envelope 缺失 → 400
    const noEnv = await req('POST', `/internal/v1/letters/${id}/state`, { action: 'escalate', actor: 'COS' });
    assert.equal(noEnv.status, 400);
    assert.equal(noEnv.json.error, 'invalid_envelope');

    // envelope.from 缺失 → 400（F1：取消缺省，必填=actor）
    const noFrom = await req('POST', `/internal/v1/letters/${id}/state`, {
      action: 'escalate', actor: 'COS', envelope: { to: 'BOD', payload: {} },
    });
    assert.equal(noFrom.status, 400);
    assert.match(noFrom.json.message, /from is required/);

    // envelope.from != actor（伪报）→ 400（F1）
    const fakeFrom = await req('POST', `/internal/v1/letters/${id}/state`, {
      action: 'escalate', actor: 'COS', envelope: { from: '别人', to: 'BOD', payload: {} },
    });
    assert.equal(fakeFrom.status, 400);

    // envelope.priority 非法值 → 400 显拒（F2：缺省仅限未提供）
    const badPri = await req('POST', `/internal/v1/letters/${id}/state`, {
      action: 'escalate', actor: 'COS', envelope: { from: 'COS', to: 'BOD', priority: '紧急', payload: {} },
    });
    assert.equal(badPri.status, 400);
    assert.equal(badPri.json.error, 'invalid_priority');

    // 信件未被冻结（以上 400 全部前置校验不触库）
    const letter = await req('GET', `/internal/v1/letters?box=in&to=jack`);
    assert.equal(letter.json.letters[0]!.status, 'pending');
  });

  it('escalate atomic path: freeze original + create ref envelope (envelope.from=actor)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      actor: 'kate', to: 'leo', priority: '急件', payload: { q: 9 },
    });
    const id = made.json.letterId;

    const esc = await req('POST', `/internal/v1/letters/${id}/state`, {
      action: 'escalate',
      actor: 'COS',
      envelope: { from: 'COS', to: 'BOD', payload: { reason: 'COS 终裁升级' } },
    });
    assert.equal(esc.status, 200);
    assert.equal(esc.json.original.status, 'escalated');
    assert.equal(esc.json.envelope.refLetterId, id);
    assert.equal(esc.json.envelope.to, 'BOD');
    assert.equal(esc.json.envelope.from, 'COS');
    assert.equal(esc.json.envelope.priority, '急件'); // 缺省=升级链语义

    // 原信冻结：后续 deliver 拒（409 非法流转）
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'deliver', actor: '组长' })).status, 409);

    // 台账：原信 send + escalate 两行
    const trail = await req('GET', `/internal/v1/ledger?letter_id=${id}`);
    assert.deepEqual(
      trail.json.entries.map((e: any) => e.action),
      ['send', 'escalate'],
    );
  });

  it('GET /internal/v1/ledger returns full trail with since filter', async () => {
    const all = await req('GET', '/internal/v1/ledger');
    assert.equal(all.status, 200);
    assert.ok(all.json.count >= 2);
    const since = await req('GET', `/internal/v1/ledger?since=${all.json.entries[0].id}`);
    assert.equal(since.json.count, all.json.count - 1);
  });

  it('POST /internal/v1/letters/wake returns 202 (idle without lead agent)', async () => {
    const r = await req('POST', '/internal/v1/letters/wake', {});
    assert.equal(r.status, 202);
    assert.equal(r.json.woken, true);
  });

  // ── P3-R1/R2：SSE 直推 + 上线即报补拉 ──

  it('R2 backlog replay: stream?as=X 推入该席未读（delivered）积压帧', async () => {
    // 准备：给 carl 一封并投递（delivered=未读积压）
    const made = await req('POST', '/internal/v1/letters', {
      actor: 'system', to: 'carl', priority: '常规', payload: { n: 1 },
    });
    await req('POST', `/internal/v1/letters/${made.json.letterId}/state`, { action: 'deliver', actor: '组长' });

    // 提交一个会话（stream 端点要求 taskStreams 有 entry；模型死端口只影响后续 agent 输出）
    const sub = await req('POST', '/internal/v1/tasks/submit', { message: 'backlog probe' });
    assert.equal(sub.status, 201);
    const { sessionId } = sub.json;

    // 连接即补拉：首帧必为 carl 的 delivered 积压帧（注册/补拉先于 agentLoop）
    const frame = await readFirstFrame(
      `http://127.0.0.1:${appPort}/internal/v1/sessions/${sessionId}/stream?as=carl`,
      5000,
      sessionId,
    );
    assert.ok(frame, 'expected a frame');
    assert.equal(frame!.event, 'letter');
    assert.equal(frame!.data.letterId, made.json.letterId);
    assert.equal(frame!.data.to, 'carl');
    assert.equal(frame!.data.status, 'delivered');
  });

  it('R1 live push: stream?as=X 在连接期间收到新信事件帧（无 payload 全文）', async () => {
    const sub = await req('POST', '/internal/v1/tasks/submit', { message: 'live push probe' });
    assert.equal(sub.status, 201);
    const { sessionId } = sub.json;

    // 连接建立（后台读流）
    const streamPromise = readFirstFrame(
      `http://127.0.0.1:${appPort}/internal/v1/sessions/${sessionId}/stream?as=dave-2`,
      5000,
      sessionId,
    );
    // 给连接建立留出窗口，再寄信触发直推
    await new Promise((r) => setTimeout(r, 150));
    const made = await req('POST', '/internal/v1/letters', {
      actor: 'system', to: 'dave-2', priority: '重要', payload: { secret: 'should-not-leak' },
    });
    assert.equal(made.status, 201);

    const frame = await streamPromise;
    assert.ok(frame, 'expected live letter frame');
    assert.equal(frame!.event, 'letter');
    assert.equal(frame!.data.letterId, made.json.letterId);
    assert.equal(frame!.data.priority, '重要');
    // 事件帧不带 payload 全文（派工令边界）
    assert.equal(frame!.data.payload, undefined);
    assert.ok(!JSON.stringify(frame).includes('should-not-leak'));
  });
});
