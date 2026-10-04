// ── LG-058 N4 config 端点真链路（HTTP 层）：五路由过 P0 门 + boot pull→show/pull/verify/cache clear 全周期 ──
//
// STE 纪律（09-15 第三次命中教训）：新端点必配真链路案——单测直调四函数
// 不覆盖 app.ts 路由注册/URL 拼写/门集成，此处以 createTriRLCApp 真实
// HTTP 全链路补位。mock TriModel 上游随 boot pull 自然进食。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriRLCApp } from '../../src/server/app.js';
import { stopKeyCache } from '../../src/config/key-cache.js';

const SAVED_ENV: Record<string, string | undefined> = {};

let tmpDataDir: string;
let app: ReturnType<typeof createTriRLCApp>;
let appPort: number;
let mock: Server;
let mockPort: number;

const TOKEN = 'config-e2e-token';

before(async () => {
  for (const k of [
    'TRILC_DATA_DIR', 'TRILC_WEEKLY_PLANE_ROOT', 'TRILC_PORT', 'TRILC_PROJECT_ROOT',
    'TRIMODEL_API_TOKEN', 'TRILC_TRIMODEL_API_URL', 'TRILC_INTERNAL_TOKEN',
    'TRIMODEL_KEY_STORAGE_MODE', 'TRIMODEL_ADMIN_TOKEN', 'TRIMODEL_FACE_ID',
  ]) {
    SAVED_ENV[k] = process.env[k];
  }

  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-config-e2e-'));
  process.env.TRILC_DATA_DIR = tmpDataDir;
  process.env.TRILC_PROJECT_ROOT = tmpDataDir;
  delete process.env.TRILC_WEEKLY_PLANE_ROOT;
  process.env.TRILC_PORT = '0';
  process.env.TRIMODEL_KEY_STORAGE_MODE = 's3'; // 明文沙箱模式
  delete process.env.TRIMODEL_ADMIN_TOKEN;
  delete process.env.TRIMODEL_API_TOKEN;
  delete process.env.TRIMODEL_FACE_ID; // FACE_ID 默认 'rlc'

  // mock TriModel 上游：pull 卡面 + status 回写面
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/v1/config/cards/rlc' && url.searchParams.get('view') === 'pull') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'config.card-pull', face: 'rlc', card_present: true,
        default_model: 'deepseek-v4-pro',
        entries: {
          e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: 'sk-e2e-1', enabled: true, updated_at: '2026-09-28T01:00:00Z' },
          e3: { provider: 'anthropic', model: 'claude-fallback', api_key: 'sk-e2e-3', enabled: true, updated_at: '2026-09-28T01:30:00Z', base_url: 'https://anthropic.example' },
        },
        strategy: null,
        refresh_interval_s: 900,
      }));
      return;
    }
    if (url.pathname === '/v1/config/cards/rlc/status' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockPort = (mock.address() as { port: number }).port;

  process.env.TRILC_TRIMODEL_API_URL = `http://127.0.0.1:${mockPort}`;
  process.env.TRILC_INTERNAL_TOKEN = TOKEN;

  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = `http://127.0.0.1:${mockPort}`;

  app = createTriRLCApp(env);
  await app.start();
  appPort = env.port;
  if (!appPort) throw new Error('app did not bind a port');
});

after(async () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await app.stop(); } catch { /* swallow */ }
  try { stopKeyCache(); } catch { /* swallow */ }
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(tmpDataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

async function request(method: string, path: string, withToken: boolean): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(withToken ? { 'x-internal-token': TOKEN } : {}),
    },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

describe('LG-058 N4 config 端点真链路（HTTP 层）', () => {
  it('P0 门 fail-closed：config 五路由无 token 全 401', async () => {
    const cases: Array<[string, string]> = [
      ['POST', '/internal/v1/config/pull'],
      ['GET', '/internal/v1/config/show'],
      ['POST', '/internal/v1/config/verify'],
      ['GET', '/internal/v1/config/cache'],
      ['DELETE', '/internal/v1/config/cache'],
    ];
    for (const [method, path] of cases) {
      const { status, json } = await request(method, path, false);
      assert.equal(status, 401, `${method} ${path} 应 401`);
      assert.ok(String(json?.error ?? '').startsWith('unauthorized'), `${method} ${path} 错误码应 unauthorized 族`);
    }
  });

  it('boot pull 落 cache：show=tier2-cache-fresh + providers/refresh 读数', async () => {
    const { status, json } = await request('GET', '/internal/v1/config/show', true);
    assert.equal(status, 200);
    assert.equal(json.object, 'config.show');
    assert.equal(json.face, 'rlc');
    assert.equal(json.hasCache, true);
    assert.equal(json.fresh, true);
    assert.equal(json.effectiveSource, 'tier2-cache-fresh');
    assert.equal(json.effectiveModel, 'deepseek-v4-pro');
    assert.equal(json.providerCount, 2);
    assert.equal(json.refreshIntervalS, 900);
    assert.ok(json.lastFetchAt > 0);
  });

  it('POST pull 即时生效：mode=full + tier1-card 归因', async () => {
    const { status, json } = await request('POST', '/internal/v1/config/pull', true);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'full');
    assert.equal(json.source, 'tier1-card');
    assert.equal(json.defaultModel, 'deepseek-v4-pro');
  });

  it('POST verify 三查全 ok：connectivity/credentials/decrypt + card_present', async () => {
    const { status, json } = await request('POST', '/internal/v1/config/verify', true);
    assert.equal(status, 200);
    assert.equal(json.object, 'config.verify');
    assert.equal(json.ok, true);
    assert.equal(json.connectivity, 'ok');
    assert.equal(json.credentials, 'ok');
    assert.equal(json.decryptHealth, 'ok');
    assert.equal(json.cardPresent, true);
    assert.equal(json.providers, 2);
  });

  it('GET cache 读数面 = describeConfig 投影', async () => {
    const { status, json } = await request('GET', '/internal/v1/config/cache', true);
    assert.equal(status, 200);
    assert.equal(json.object, 'config.cache');
    assert.equal(json.hasCache, true);
  });

  it('DELETE cache 双清+回 tier3：cleared 后 show=tier3-env', async () => {
    const del = await request('DELETE', '/internal/v1/config/cache', true);
    assert.equal(del.status, 200);
    assert.equal(del.json.object, 'config.cache-cleared');
    assert.equal(del.json.cleared, true);
    assert.equal(del.json.hadCache, true);
    assert.ok(del.json.removedFiles.length >= 1, '至少清掉 canonical 载体');

    const show = await request('GET', '/internal/v1/config/show', true);
    assert.equal(show.status, 200);
    assert.equal(show.json.hasCache, false);
    assert.equal(show.json.effectiveSource, 'tier3-env');
  });
});
