import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyKeyCacheToEnvironment,
  FACE_ID,
  PULL_ATTRIBUTION_CODES,
  keysFromPullEntries,
  getKeyCacheFilePath,
  initKeyCache,
  getKeyCache,
  getKeyCacheStatus,
  stopKeyCache,
  type KeyCache,
  type PullEntry,
} from '../src/config/key-cache.js';

describe('applyKeyCacheToEnvironment', () => {
  it('maps cached providers to the TriModel environment contract', () => {
    const cache: KeyCache = {
      keys: {
        deepseek: { api_key: 'deepseek-key', base_url: 'https://deepseek.example/v1' },
        anthropic: { api_key: 'anthropic-key', base_url: 'https://anthropic.example' },
        openai: { api_key: 'openai-key', base_url: 'https://openai.example/v1' },
        trimetaverse: { api_key: 'tmv-key', base_url: 'https://tmv.example/v1' },
      },
      defaultModel: 'deepseek-chat',
      refreshIntervalS: 900,
      fetchedAt: 1,
      expiresAt: 2,
    };
    const env: NodeJS.ProcessEnv = {};

    applyKeyCacheToEnvironment(cache, env);

    assert.deepEqual(env, {
      DEEPSEEK_API_KEY: 'deepseek-key',
      DEEPSEEK_BASE_URL: 'https://deepseek.example/v1',
      ANTHROPIC_API_KEY: 'anthropic-key',
      ANTHROPIC_BASE_URL: 'https://anthropic.example',
      OPENAI_API_KEY: 'openai-key',
      OPENAI_BASE_URL: 'https://openai.example/v1',
      TRIMODEL_TRIMETAVERSE_API_KEY: 'tmv-key',
      TRIMODEL_TRISTACISS_BASE_URL: 'https://tmv.example/v1',
      TRIMODEL_DEFAULT_MODEL: 'deepseek-chat',
    });
  });
});

// ── LG-058 N3 泛化（config-cache 多维）：新案 ──

function pullEntriesFixture(): Record<string, PullEntry> {
  return {
    e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: 'sk-pull-e1', enabled: true, updated_at: '2026-09-28T01:00:00Z' },
    e2: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: 'sk-pull-e2-newer', enabled: true, updated_at: '2026-09-28T02:00:00Z' },
    e3: { provider: 'anthropic', model: 'claude-fallback', api_key: 'sk-ant-e3', enabled: true, updated_at: '2026-09-28T01:30:00Z', base_url: 'https://anthropic.example' },
    e4: { provider: 'openai', model: 'gpt-x', api_key: 'sk-disabled-ignored', enabled: false, updated_at: '2026-09-28T03:00:00Z' },
  };
}

/** env 钉位/恢复助手（S3 明文沙箱模式，避开 key-encryptor 域指纹依赖）。 */
function pinSandboxEnv(): () => void {
  const saved: Record<string, string | undefined> = {
    TRIMODEL_KEY_STORAGE_MODE: process.env.TRIMODEL_KEY_STORAGE_MODE,
    TRIMODEL_ADMIN_TOKEN: process.env.TRIMODEL_ADMIN_TOKEN,
  };
  process.env.TRIMODEL_KEY_STORAGE_MODE = 's3';
  delete process.env.TRIMODEL_ADMIN_TOKEN;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function withMockFetch(impl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  return () => { globalThis.fetch = real; };
}

describe('LG-058 N3 config-cache 泛化', () => {
  it('keysFromPullEntries: per-provider 取 updated_at 最新，disabled 排除，base_url 透传', () => {
    const keys = keysFromPullEntries(pullEntriesFixture());
    assert.equal(keys.deepseek?.api_key, 'sk-pull-e2-newer'); // 最新者胜
    assert.equal(keys.anthropic?.api_key, 'sk-ant-e3');
    assert.equal(keys.anthropic?.base_url, 'https://anthropic.example');
    assert.equal(keys.openai, undefined); // disabled 不进 keys
  });

  it('FACE_ID 默认 rlc（TriRLC 仓域面身份）；归因码三枚举冻结', () => {
    assert.equal(FACE_ID, 'rlc');
    assert.deepEqual([...PULL_ATTRIBUTION_CODES], ['pull_denied', 'decrypt_failed', 'apply_rejected']);
  });

  it('getKeyCacheFilePath: tier2 载体=config-cache.json（泛化名）', () => {
    assert.ok(getKeyCacheFilePath('D:/tmp/x').endsWith('config-cache.json'));
  });

  it('initKeyCache 端到端（S3 沙箱）：pull 成功→cache 落盘含 strategy+keys 聚合', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trilc-kc-n3-'));
    const restore = pinSandboxEnv();
    try {
      const restoreFetch = withMockFetch(async (input) => {
        const url = String(input);
        assert.ok(url.includes('/v1/config/cards/rlc?view=pull'), `tier1 端点应为卡面 pull: ${url}`);
        return new Response(JSON.stringify({
          object: 'config.card-pull', face: 'rlc', card_present: true,
          default_model: 'deepseek-v4-pro',
          entries: pullEntriesFixture(),
          strategy: { id: 's1', name: 'sandbox-strategy', rule_ids: ['r1'] },
          refresh_interval_s: 900,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      try {
        await initKeyCache('http://127.0.0.1:3333', dir, 'tok');
        const cache = getKeyCache();
        assert.ok(cache);
        assert.equal(cache.defaultModel, 'deepseek-v4-pro');
        assert.equal(cache.keys.deepseek?.api_key, 'sk-pull-e2-newer');
        assert.deepEqual(cache.strategy, { id: 's1', name: 'sandbox-strategy', rule_ids: ['r1'] });
        // tier2 载体落盘 = config-cache.json（新名），S3 明文形态可断言
        assert.ok(existsSync(join(dir, 'config-cache.json')));
        const onDisk = JSON.parse(readFileSync(join(dir, 'config-cache.json'), 'utf-8'));
        assert.equal(onDisk.strategy?.id, 's1');
        assert.equal(getKeyCacheStatus().hasCache, true);
      } finally {
        stopKeyCache();
        restoreFetch();
      }
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('401 → pull_denied 归因；status 回写带 admin 凭据时发出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trilc-kc-n3-'));
    const restore = pinSandboxEnv();
    process.env.TRIMODEL_ADMIN_TOKEN = 'admin-sandbox';
    try {
      const statusCalls: Array<{ url: string; body: unknown }> = [];
      const restoreFetch = withMockFetch(async (input, init) => {
        const url = String(input);
        if (url.includes('/status')) {
          statusCalls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      });
      try {
        await initKeyCache('http://127.0.0.1:3333', dir, 'tok');
        assert.equal(getKeyCache(), null); // 无 cache 无成功拉取 → tier3
        const st = getKeyCacheStatus();
        assert.equal(st.lastAttribution, 'pull_denied');
        assert.equal(st.lastFetchError, 'TriModel card pull denied (401)');
        // pull_denied → 回写 failed+归因码（§3.3；admin 在场故发出）
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(statusCalls.length, 1);
        assert.deepEqual(statusCalls[0].body, { state: 'failed', error: 'pull_denied' });
        assert.ok(statusCalls[0].url.includes('/v1/config/cards/rlc/status'));
      } finally {
        stopKeyCache();
        restoreFetch();
      }
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('card_present:false = tier1 无源：保留既有 cache 不动；admin 缺席=回写跳过', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trilc-kc-n3-'));
    const restore = pinSandboxEnv();
    try {
      // 预置 tier2 cache
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config-cache.json'), JSON.stringify({
        keys: { deepseek: { api_key: 'sk-existing' } },
        defaultModel: 'deepseek-v4-pro',
        refreshIntervalS: 900,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      }));
      const statusCalls: string[] = [];
      const restoreFetch = withMockFetch(async (input) => {
        const url = String(input);
        if (url.includes('/status')) { statusCalls.push(url); return new Response('{}', { status: 200 }); }
        return new Response(JSON.stringify({ object: 'config.card-pull', face: 'rlc', card_present: false }), { status: 200 });
      });
      try {
        await initKeyCache('http://127.0.0.1:3333', dir, 'tok');
        const cache = getKeyCache();
        assert.ok(cache, '既有 tier2 cache 保留');
        assert.equal(cache.keys.deepseek?.api_key, 'sk-existing');
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(statusCalls.length, 0, 'admin 缺席=回写跳过');
      } finally {
        stopKeyCache();
        restoreFetch();
      }
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('legacy keys.json fallback：config-cache.json 未落时读旧载体', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trilc-kc-n3-'));
    const restore = pinSandboxEnv();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'keys.json'), JSON.stringify({
        keys: { anthropic: { api_key: 'sk-legacy' } },
        defaultModel: 'claude-legacy',
        refreshIntervalS: 900,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      }));
      const restoreFetch = withMockFetch(async () => {
        throw new Error('network down');
      });
      try {
        await initKeyCache('http://127.0.0.1:3333', dir, 'tok');
        const cache = getKeyCache();
        assert.ok(cache, 'legacy keys.json 经 fallback 仍为 tier2');
        assert.equal(cache.keys.anthropic?.api_key, 'sk-legacy');
        // 拉取失败后新文件不落（等首次成功 pull）——新载体写入仅在成功时
        assert.ok(!existsSync(join(dir, 'config-cache.json')));
      } finally {
        stopKeyCache();
        restoreFetch();
      }
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
