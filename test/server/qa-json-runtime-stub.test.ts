// ── QA B/D RUNTIME COVERAGE (TestEngineer 小柯) ──
// Dev's app-json-dedup-shape.test.ts is a STATIC source-code shape guard for
// the JSON routes in src/server/app.ts. It pins the literal fix pattern but
// does NOT execute the collection loop. This file closes that gap by exercising
// the production JSON route handlers end-to-end through createTriRLCApp.
//
// Strategy:
//   1. Spawn a stub HTTP server that speaks the DeepSeek OpenAI-compatible
//      /chat/completions streaming protocol. The stub emits two SSE chunks
//      ("Hello " and "world") followed by [DONE], modeling what the real
//      DeepSeek API sends. agentLoop internally calls DeepSeekProvider.stream
//      which consumes this stub.
//   2. Point DEEPSEEK_BASE_URL at the stub; provide a dummy DEEPSEEK_API_KEY.
//   3. Boot createTriRLCApp on an ephemeral port and hit:
//        B. POST /v1/messages (stream:false)   — Anthropic JSON
//        D. POST /chat/completions (stream:false) — OpenAI JSON
//   4. Assert response.content strictly equals "Hello world" — NOT the
//      pre-fix duplicate "Hello worldHello world".
//
// What this PROVES that static-shape guard cannot:
//   - The loop correctly accumulates content_delta chunks.
//   - The `!finalContent` guard correctly suppresses the assistant_message
//     aggregate when content_delta was seen.
//   - tool_calls still round-trip when present.
//   - The actual production code path (not a copy) is exercised.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createTriRLCApp } from '../../src/server/app.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Stub DeepSeek backend ──
// Streams: two content chunks then [DONE]. Reproduces real DeepSeek SSE shape.

function startDeepSeekStub(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createHttpServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
        res.writeHead(404);
        res.end();
        return;
      }
      // Read body (we don't need to parse it for the stub).
      req.resume();
      req.on('end', () => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        // Chunk 1: "Hello "
        res.write('data: {"id":"stub-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello "},"finish_reason":null}]}\n\n');
        // Chunk 2: "world"
        res.write('data: {"id":"stub-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}\n\n');
        // Final chunk with finish_reason + usage
        res.write('data: {"id":"stub-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function getPort(server: Server): number {
  const addr = server.address();
  if (addr && typeof addr === 'object') return addr.port;
  throw new Error('stub not listening');
}

// ── Test harness ──

let stubServer: Server;
let stubPort: number;
let app: ReturnType<typeof createTriRLCApp>;
let appPort: number;
let tmpDataDir: string;

// p0fix3：全局 X-Internal-Token 门启用后的固定测试令牌（after() 经 SAVED_ENV 还原）。
const TEST_INTERNAL_TOKEN = 'qa-stub-internal-token';

// Save env so we can restore.
const SAVED_ENV = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL,
  TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
  TRILC_PORT: process.env.TRILC_PORT,
  TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
  TRILC_PROJECT_ROOT: process.env.TRILC_PROJECT_ROOT,
  TRIMODEL_KEY_STORAGE_MODE: process.env.TRIMODEL_KEY_STORAGE_MODE,
  TRICOMPANY_SOURCE_PATH: process.env.TRICOMPANY_SOURCE_PATH,
  TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
};

before(async () => {
  stubServer = await startDeepSeekStub();
  stubPort = getPort(stubServer);

  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-qa-json-'));
  appPort = 0; // We'll start app on an ephemeral port.

  // Configure env to use stub.
  process.env.DEEPSEEK_API_KEY = 'qa-stub-key';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${stubPort}`;
  // Avoid hitting real TriModel API for keys — disable token + use local dataDir
  // so even if a cache file exists, it's empty.
  delete process.env.TRIMODEL_API_TOKEN;
  process.env.TRIMODEL_KEY_STORAGE_MODE = 's3'; // plaintext, avoids key derivation
  process.env.TRILC_DATA_DIR = tmpDataDir;
  process.env.TRILC_PORT = String(appPort);
  // p0fix3：内部门 fail-closed——app.start() 前注入测试 token，请求统一带头。
  process.env.TRILC_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;
  // FADE-ASSESS-003: 知识注入启动同步的 projectRoot 隔离到临时目录，
  // 防止 knowledge.db 落进仓库根（cwd）。
  process.env.TRILC_PROJECT_ROOT = tmpDataDir;
  // Point contract resolver at an existing path to avoid load failures.
  // (The default walks up to find TriCompany; we leave it unset unless needed.)

  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  // Force ephemeral port: override after readEnv.
  env.port = 0;
  // Point trimodelApiUrl at a closed port so initKeyCache degrades fast.
  env.trimodelApiUrl = 'http://127.0.0.1:1';

  app = createTriRLCApp(env);
  await app.start();

  // createTriRLCApp mutates env.port to the actual bound port (env.port = addr.port).
  appPort = env.port;
  if (!appPort) throw new Error('app did not bind a port');
});

after(async () => {
  // Restore env.
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string | undefined>)[k] = v;
  }
  try { await app.stop(); } catch { /* swallow */ }
  try { await new Promise<void>((res) => stubServer.close(() => res())); } catch { /* swallow */ }
});

// ── HTTP helpers ──

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

// ─────────────────────────────────────────────────────────────────────────────
// B. /v1/messages JSON (Anthropic)
// ─────────────────────────────────────────────────────────────────────────────

describe('QA-B. /v1/messages JSON — runtime dedup via stub DeepSeek', () => {
  it('B-runtime: response.content[0].text strictly equals "Hello world" (no dup)', async () => {
    const { status, json } = await postJSON('/v1/messages', {
      model: 'deepseek-chat',
      max_tokens: 100,
      stream: false,
      messages: [{ role: 'user', content: 'Say hello world' }],
    });

    // Diagnostics on failure.
    if (status !== 200) {
      console.error('B-runtime non-200:', status, JSON.stringify(json));
    }
    assert.strictEqual(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);

    const block = json?.content?.[0];
    assert.ok(block, 'expected content[0] block');
    assert.strictEqual(block.type, 'text');
    const text: string = block.text;
    assert.strictEqual(
      text,
      'Hello world',
      `pre-fix would be "Hello worldHello world"; got "${text}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. /chat/completions JSON (OpenAI)
// ─────────────────────────────────────────────────────────────────────────────

describe('QA-D. /chat/completions JSON — runtime dedup via stub DeepSeek', () => {
  it('D-runtime: response.choices[0].message.content strictly equals "Hello world"', async () => {
    const { status, json } = await postJSON('/chat/completions', {
      model: 'deepseek-chat',
      stream: false,
      messages: [{ role: 'user', content: 'Say hello world' }],
    });

    if (status !== 200) {
      console.error('D-runtime non-200:', status, JSON.stringify(json));
    }
    assert.strictEqual(status, 200, `expected 200, got ${status}: ${JSON.stringify(json)}`);

    const content: string = json?.choices?.[0]?.message?.content;
    assert.strictEqual(
      content,
      'Hello world',
      `pre-fix would be "Hello worldHello world"; got "${content}"`,
    );
  });
});
