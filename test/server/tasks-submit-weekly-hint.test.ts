// ── C side: tasks/submit weekly-plane hint assembly assertions (r4-1 C) ──
// Gate: app.ts tasks/submit must append buildWeeklyPlaneHint() when the client
// supplies a systemPrompt (which skips defaultSystemPrompt entirely), and must
// NOT double-inject. No model calls needed — tasks/submit only persists the
// session entry; the agent loop runs later on the /stream endpoint.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriRLCApp } from '../../src/server/app.js';

const SAVED_ENV = {
  TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
  TRILC_WEEKLY_PLANE_ROOT: process.env.TRILC_WEEKLY_PLANE_ROOT,
  TRILC_PORT: process.env.TRILC_PORT,
  TRILC_PROJECT_ROOT: process.env.TRILC_PROJECT_ROOT,
  TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
  TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
};

const HINT_MARKER = 'Company Weekly Plane';

// p0fix3：全局 X-Internal-Token 门启用后的固定测试令牌（after() 经 SAVED_ENV 还原）。
const TEST_INTERNAL_TOKEN = 'hint-test-internal-token';

let tmpDataDir: string;
let planeRoot: string;
let app: ReturnType<typeof createTriRLCApp>;
let appPort: number;

async function readSessionPrompt(sessionId: string): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(tmpDataDir, 'sessions.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT system_prompt FROM sessions WHERE id = ?').get(sessionId) as
      | { system_prompt: string }
      | undefined;
    return row?.system_prompt ?? '';
  } finally {
    db.close();
  }
}

before(async () => {
  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-hint-'));
  planeRoot = mkdtempSync(join(tmpdir(), 'trilc-plane-'));
  // resolveWeeklyPlaneRoot requires the env root to exist.
  mkdirSync(planeRoot, { recursive: true });

  process.env.TRILC_DATA_DIR = tmpDataDir;
  process.env.TRILC_WEEKLY_PLANE_ROOT = planeRoot;
  process.env.TRILC_PORT = '0';
  // FADE-ASSESS-003: 知识注入启动同步的 projectRoot 隔离到临时目录，
  // 防止 knowledge.db 落进仓库根（cwd）。
  process.env.TRILC_PROJECT_ROOT = tmpDataDir;
  delete process.env.TRIMODEL_API_TOKEN;
  // p0fix3：内部门 fail-closed——app.start() 前注入测试 token，请求统一带头。
  process.env.TRILC_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1'; // keys degrade fast, no real calls

  app = createTriRLCApp(env);
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
  // app.stop() may leave SQLite handles (cron.db) briefly locked on Windows —
  // retry a few times, then leave the temp dir to the OS tmp cleaner.
  for (const target of [tmpDataDir, planeRoot]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(target, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }
});

async function postJSON(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': TEST_INTERNAL_TOKEN },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

describe('C: tasks/submit weekly-plane hint assembly', () => {
  it('client systemPrompt path gets hint appended exactly once', async () => {
    const { status, json } = await postJSON('/internal/v1/tasks/submit', {
      message: 'hello',
      systemPrompt: 'CLIENT-PROMPT-123',
      context: { workspaceRoot: planeRoot },
    });
    assert.equal(status, 201);
    const prompt = await readSessionPrompt(json.sessionId);
    assert.ok(prompt.includes('CLIENT-PROMPT-123'), 'client prompt must be preserved');
    assert.ok(prompt.includes(HINT_MARKER), `hint missing in prompt: ${prompt.slice(-400)}`);
    assert.ok(prompt.includes(planeRoot), `hint must carry plane root: ${prompt.slice(-400)}`);
    const occurrences = prompt.split(HINT_MARKER).length - 1;
    assert.equal(occurrences, 1, `hint injected ${occurrences} times, expected exactly 1`);
  });

  // i2-2 §三：daemon 启动后链态 = selfcheck（uninitialized 自动转移）→ 无显式
  // systemPrompt 的提交走 init 模式 bootstrap 替代 defaultSystemPrompt；
  // 周平面提示仍恒有一次（r4-1 C 口径：no-prompt 路径无双重注入）。
  it('no-prompt path during init phase: init-mode bootstrap + hint exactly once', async () => {
    const { status, json } = await postJSON('/internal/v1/tasks/submit', {
      message: 'hello again',
      context: { workspaceRoot: planeRoot },
    });
    assert.equal(status, 201);
    const prompt = await readSessionPrompt(json.sessionId);
    assert.ok(prompt.includes('TriCade 安装初始化阶段'), 'init 模式 bootstrap 替代 defaultSystemPrompt');
    assert.ok(prompt.includes('当前阶段：selfcheck'), 'bootstrap 含当前链态');
    assert.ok(prompt.includes('/internal/v1/init/chain/status'), 'bootstrap 含状态真源引用');
    assert.ok(!prompt.includes('CLIENT-PROMPT-123'), 'no-prompt path must not carry the client prompt');
    assert.ok(!prompt.includes('Project Instructions (from CLAUDE.md)'), 'init 模式不携带 defaultSystemPrompt 主体');
    assert.ok(prompt.includes(HINT_MARKER), 'init 模式同样注入周平面提示');
    const occurrences = prompt.split(HINT_MARKER).length - 1;
    assert.equal(occurrences, 1, `hint injected ${occurrences} times, expected exactly 1 (no double injection)`);
  });
});
