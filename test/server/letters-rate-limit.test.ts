// ── LG-026-P3-F3 寄信速率上限端到端 ──
// 独立实例（TRILC_LETTER_RATE_LIMIT=2）：滑窗内第 3 封 429；留痕=console+计数
// （ledger 拒 letter_id 外键无法挂行，不造孤儿——落法已在回报候核）。

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
  TRILC_LETTER_RATE_LIMIT: process.env.TRILC_LETTER_RATE_LIMIT,
  TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
  TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
};

const TEST_INTERNAL_TOKEN = 'letters-rate-internal-token';

let tmpDataDir: string;
let app: ReturnType<typeof createTriLCApp>;
let appPort: number;

async function postLetter(): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/letters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TEST_INTERNAL_TOKEN },
    body: JSON.stringify({ actor: 'spammy', to: 'inbox', priority: '常规', payload: {} }),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-letters-rate-'));
  process.env.TRILC_DATA_DIR = tmpDataDir;
  process.env.TRILC_PORT = '0';
  process.env.TRILC_PROJECT_ROOT = tmpDataDir;
  process.env.TRILC_LETTER_RATE_LIMIT = '2';
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

describe('letter rate limit (LG-026-P3-F3)', () => {
  it('allows up to limit, then 429 (per-token sliding window)', async () => {
    assert.equal((await postLetter()).status, 201);
    assert.equal((await postLetter()).status, 201);
    const third = await postLetter();
    assert.equal(third.status, 429);
    assert.equal(third.json.error, 'rate_limited');
    // 限流不影响已入库信件
    const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/letters?box=in&to=inbox`, {
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
    });
    const json = await res.json() as { letters: unknown[] };
    assert.equal(json.letters.length, 2);
  });
});
