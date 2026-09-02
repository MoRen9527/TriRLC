// ── LG-026-P2-B1/B2 信件端点五件端到端 ──
// 配方对齐 test/server/tasks-submit-weekly-hint.test.ts 既有先例：
// 临时数据目录 + port 0 + trimodelApiUrl 死端口 + TRILC_INTERNAL_TOKEN 注入。
// 覆盖：寄信 201 / 校验矩阵 400/409 / 收信 box+since_seq 重放 / 状态流转门禁
// 403/404/409 / B2 escalate 端点层 ACL（白名单外 403+台账留痕，白名单内过）/
// 台账读 / wake 202 / 全局门 token fail-closed 覆盖信件面。
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

describe('letters endpoints (LG-026-P2-B1/B2)', () => {
  it('rejects requests without internal token (全局门覆盖信件面)', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/letters`, { method: 'POST' });
    assert.equal(res.status, 401);
  });

  it('POST /internal/v1/letters delivers letter_id + seq_no (201)', async () => {
    const r1 = await req('POST', '/internal/v1/letters', {
      from: 'alice', to: 'bob', priority: '常规', payload: { text: 'hello' },
    });
    assert.equal(r1.status, 201);
    assert.ok(r1.json.letter_id.startsWith('LT-'));
    assert.equal(r1.json.seq_no, 1);

    const r2 = await req('POST', '/internal/v1/letters', {
      from: 'carol', to: 'dave', priority: '急件', payload: { text: 'urgent' },
    });
    assert.equal(r2.json.seq_no, 2); // daemon 级全局单调
  });

  it('validates envelope: missing fields / bad priority / bad json (400/409)', async () => {
    assert.equal((await req('POST', '/internal/v1/letters', { to: 'x', payload: {} })).status, 400);
    assert.equal(
      (await req('POST', '/internal/v1/letters', { from: 'a', to: 'b', priority: '紧急', payload: {} })).status,
      400,
    );
    const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/letters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-token': TEST_INTERNAL_TOKEN },
      body: '{broken',
    });
    assert.equal(res.status, 400);
    // duplicate explicit id → 409
    await req('POST', '/internal/v1/letters', { from: 'a', to: 'b', payload: {}, letter_id: 'LT-dup-1' });
    const dup = await req('POST', '/internal/v1/letters', { from: 'a', to: 'b', payload: {}, letter_id: 'LT-dup-1' });
    assert.equal(dup.status, 409);
  });

  it('GET letters supports box / status / since_seq replay filters', async () => {
    assert.equal((await req('GET', '/internal/v1/letters?box=in')).status, 400);
    assert.equal((await req('GET', '/internal/v1/letters?box=out')).status, 400);

    const inbox = await req('GET', '/internal/v1/letters?box=in&to=bob');
    assert.equal(inbox.status, 200);
    assert.ok(inbox.json.letters.every((l: any) => l.to === 'bob'));

    const first = inbox.json.letters[0];
    const replay = await req('GET', `/internal/v1/letters?box=in&to=bob&since_seq=${first.seq_no}`);
    assert.equal(replay.json.letters.length, 0); // bob 只有 seq 1 一封

    const pending = await req('GET', '/internal/v1/letters?status=pending&limit=1');
    assert.equal(pending.json.letters.length, 1);
  });

  it('state transitions enforce store gating via HTTP (deliver/read + 403/404/409)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      from: 'erin', to: 'frank', priority: '常规', payload: {},
    });
    const id = made.json.letter_id;

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

  it('escalate ACL: outside allowlist → 403 + ledger trail; COS passes (B2)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      from: 'gina', to: 'hank', priority: '重要', payload: {},
    });
    const id = made.json.letter_id;

    const denied = await req('POST', `/internal/v1/letters/${id}/state`, { action: 'escalate', actor: 'gina' });
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error, 'escalate_actor_forbidden');

    // 拒绝留痕：台账含 escalate_denied 行，信件状态未被改动
    const trail = await req('GET', `/internal/v1/ledger?letter_id=${id}`);
    assert.ok(trail.json.entries.some((e: any) => e.action === 'escalate_denied' && e.actor === 'gina'));
    const letter = await req('GET', `/internal/v1/letters?box=in&to=hank`);
    assert.equal(letter.json.letters[0]!.status, 'pending');
  });

  it('escalate requires envelope.to (原子版强制，缺失 400)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      from: 'ivy', to: 'jack', priority: '重要', payload: {},
    });
    const id = made.json.letter_id;
    // 白名单内但缺 envelope → 400
    const noEnv = await req('POST', `/internal/v1/letters/${id}/state`, { action: 'escalate', actor: 'COS' });
    assert.equal(noEnv.status, 400);
    assert.equal(noEnv.json.error, 'invalid_envelope');
    // 信件未被冻结（400 前置校验不触库）
    const letter = await req('GET', `/internal/v1/letters?box=in&to=jack`);
    assert.equal(letter.json.letters[0]!.status, 'pending');
  });

  it('escalate atomic path: freeze original + create ref envelope in one call (CTO 终验裁示③)', async () => {
    const made = await req('POST', '/internal/v1/letters', {
      from: 'kate', to: 'leo', priority: '急件', payload: { q: 9 },
    });
    const id = made.json.letter_id;

    // 白名单内 + envelope 完整 → 200 {original, envelope}
    const esc = await req('POST', `/internal/v1/letters/${id}/state`, {
      action: 'escalate',
      actor: 'COS',
      envelope: { to: 'BOD', payload: { reason: 'COS 终裁升级' } },
    });
    assert.equal(esc.status, 200);
    assert.equal(esc.json.original.status, 'escalated');
    assert.equal(esc.json.envelope.refLetterId, id);
    assert.equal(esc.json.envelope.to, 'BOD');
    assert.equal(esc.json.envelope.from, 'COS'); // 缺省 from=actor
    assert.equal(esc.json.envelope.priority, '急件'); // 缺省升级链语义

    // 原信冻结：后续 deliver 拒（409 非法流转）
    assert.equal((await req('POST', `/internal/v1/letters/${id}/state`, { action: 'deliver', actor: '组长' })).status, 409);

    // 台账：原信含 send + escalate 两行，新信封含 send 行
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
});
