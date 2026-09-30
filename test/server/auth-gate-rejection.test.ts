// ── P0 加固对抗套件：通道一(token fail-closed) + 通道二(Host/Origin 防 rebinding) ──
// 树 p0fix3-trilc-http / 节点 PD-T，TestEngineer 小柯 fresh 实例（20260827T074800Z）。
//
// 审计真源：docs/workflow/operating-records/2026-W35/trees/rmc-audit-cmp-001/reports/
// rmc-TriLC.md P0-1（发现 8）——「全 HTTP 面零认证 + 无 Host 校验可被 DNS rebinding
// 远程触达」。修复语义（src/server/app.ts，行号为 TriRLC HEAD=26720dd 工作树 Read 实证）：
//
//   门序契约：/healthz 精确豁免(:1548) → Host 门(:1593-1599) → Origin 门(:1600-1607)
//             → X-Internal-Token 门(:1609-1624) → 其余业务路由。
//   文案契约钉死（逐字对照实现原文）：
//     token 未配置/空串（任意非 healthz 路由）→ 401 {"error":"internal_auth_disabled"}      :1614-1617
//     已配置但缺头/不匹配                      → 401 {"error":"unauthorized: missing or invalid X-Internal-Token"} :1619-1623
//     Host 存在但不在允许集                    → 403 {"error":"forbidden_host"}      :1593-1599
//       （完全无 Host 的裸请求由 llhttp 解析器层先回 400 不到达本门——pdT-round1 实测，见 e8 双层口径）
//     Origin 存在且非 'null' 且不命中          → 403 {"error":"forbidden_origin"}    :1600-1607
//   token 于请求期读 env 不缓存启动快照(:1612)，支持运行中注入测试；
//   允许集每判定重建(:164-180)；与 TriMMC 参照实现的差异 = 参照为 fail-open 变体，
//   本面反转 fail-closed（故意语义变化，漏配即全拒）。
//
// 分层：六导出纯函数单元直测(:110-214) + createTriRLCApp 真起服端到端。端到端起服配方
// 对齐 test/server/tasks-submit-weekly-hint.test.ts 既有先例（临时数据目录 + port 0 +
// trimodelApiUrl 指向死端口快速降级）；HTTP 全部走 node:http 裸请求而非 fetch——
// fetch 规范禁止覆写/省略 Host 头，裸客户端才能伪造与省略。
//
// 诚实申报：本套件 PD-T 轮为静态推演落盘（fresh TestEngineer 实例无 Bash 面），经编排层
// 重开门禁 pdT-round1 实测＝59 例中 58 例首轮命中；唯一增差 e8 暴露真实事实——完全无 Host
// 的 HTTP/1.1 由 llhttp 解析器严格模式在协议层先回 400，请求不到达应用层全局门，已按实测
// 把该例改钉「协议层+应用层双层拒」口径并移除其「推演待实证」标注（本申报块同步更新）。
// 其余在用例旁保留「推演待实证」标注处继续以实测轮背书为准；安全性质结论不变：无 Host
// 形态 fail-closed 成立于协议栈层，Host 在但不命中允许集成立于应用层 forbidden_host 门。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createTriRLCApp,
  extractInternalToken,
  timingSafeStringEquals,
  collectHostAllowEntries,
  hostHeaderAllowed,
  originHeaderAllowed,
} from '../../src/server/app.js';

/** 用后还原 env 的最小封装：设定时快照旧值，返回恢复函数。 */
function withEnv(key: string, value: string | undefined): () => void {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return () => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  };
}

// 单元层统一使用固定端口常量，避免任何真实监听/端口依赖。
const UNIT_PORT = 18923;

// ══════════════════════ 单元层一：extractInternalToken 头提取 ══════════════════════

describe('P0 通道一单元层：extractInternalToken（app.ts:110-119）', () => {
  it('u-e1 x-internal-token 直头字符串原样返回', () => {
    assert.strictEqual(extractInternalToken({ 'x-internal-token': 'tok-abc' }), 'tok-abc');
  });

  it('u-e2 x-internal-token 数组头取首元素（node 重复头形态）', () => {
    assert.strictEqual(extractInternalToken({ 'x-internal-token': ['tok-a', 'tok-b'] }), 'tok-a');
  });

  it('u-e3 两路皆缺失 → undefined（不得返回空串冒充提取成功）', () => {
    assert.strictEqual(extractInternalToken({}), undefined);
  });

  it('u-e4 Bearer 前缀兜底（无 x-internal-token 时）', () => {
    assert.strictEqual(extractInternalToken({ authorization: 'Bearer tok-bearer' }), 'tok-bearer');
  });

  it('u-e5 Bearer 方案大小写敏感：小写 bearer 不触发兜底', () => {
    // 源 :117 startsWith('Bearer ') 字面量；小写形态解析失败比宽松放行更安全。
    assert.strictEqual(extractInternalToken({ authorization: 'bearer tok-x' }), undefined);
  });

  it('u-e6 非 Bearer 方案（Basic 等）不触发兜底', () => {
    assert.strictEqual(extractInternalToken({ authorization: 'Basic dXNlcjpwd2Q=' }), undefined);
  });

  it('u-e7 数组首元素非字符串 → undefined（防御支 :113 typeof 门）', () => {
    const malformed = { 'x-internal-token': [42] } as unknown as Record<string, string>;
    assert.strictEqual(extractInternalToken(malformed), undefined);
  });

  it('u-e8 空值既定口径：空串直头与空 Bearer 均返回空串而非 undefined（:115/:117 typeof-string 分支不做空折叠）', () => {
    assert.strictEqual(extractInternalToken({ 'x-internal-token': '' }), '');
    assert.strictEqual(extractInternalToken({ authorization: 'Bearer ' }), '');
    // 注：空串进入门回调后走 timingSafeStringEquals 长度不等支 → unauthorized，
    // 与 internal_auth_disabled 可区分；helper 层只钉提取契约本身。
  });
});

// ══════════════════════ 单元层二：timingSafeStringEquals ══════════════════════

describe('P0 通道一单元层：timingSafeStringEquals（app.ts:121-131）', () => {
  it('u-t1 完全相等 → true', () => {
    assert.strictEqual(timingSafeStringEquals('same-token-value', 'same-token-value'), true);
  });

  it('u-t2 同长不同内容 → false', () => {
    assert.strictEqual(timingSafeStringEquals('aaaa', 'bbbb'), false);
  });

  it('u-t3 长度不等 → false 且必须先做同长哑比较抹平耗时特征（:126-129）', () => {
    assert.strictEqual(timingSafeStringEquals('short', 'a-much-longer-token'), false);
    assert.strictEqual(timingSafeStringEquals('a-much-longer-token', 'short'), false);
  });

  it('u-t4 多字节 UTF-8 字节面等值：相同汉字对 true', () => {
    assert.strictEqual(timingSafeStringEquals('令牌', '令牌'), true);
  });

  it('u-t5 多字节 UTF-8 大小写与变体差异一律 false（字节面比较不做折叠）', () => {
    assert.strictEqual(timingSafeStringEquals('Token', 'token'), false);
    assert.strictEqual(timingSafeStringEquals('令牌A', '令牌B'), false);
  });
});

// ══════════════════════ 单元层三：collectHostAllowEntries ══════════════════════

describe('P0 通道二单元层：collectHostAllowEntries（app.ts:164-180，port 取当时值非缓存）', () => {
  it('u-h0 未配置 TRILC_HOST_ALLOWLIST ⇒ 允许集恰好为回环三形（含端口整串、full 模式）', () => {
    const restore = withEnv('TRILC_HOST_ALLOWLIST', undefined);
    try {
      const entries = collectHostAllowEntries(UNIT_PORT);
      assert.deepEqual(
        entries.map((e) => ({ mode: e.mode, value: e.value })),
        [
          { mode: 'full', value: `localhost:${UNIT_PORT}` },
          { mode: 'full', value: `127.0.0.1:${UNIT_PORT}` },
          { mode: 'full', value: `[::1]:${UNIT_PORT}` },
        ],
      );
    } finally {
      restore();
    }
  });

  it('u-h1 追加集分类三支正道：无端口=hostname 模式、host:纯数字=[full]、[ 开头 IPv6=[full]；空白段剔除', () => {
    const restore = withEnv(
      'TRILC_HOST_ALLOWLIST',
      '  plain.host , dev.corp:8080 , [::1]:9099 , ,  ',
    );
    try {
      const extra = collectHostAllowEntries(UNIT_PORT).slice(3);
      assert.deepEqual(
        extra.map((e) => ({ mode: e.mode, value: e.value })),
        [
          { mode: 'hostname', value: 'plain.host' },
          { mode: 'full', value: 'dev.corp:8080' },
          { mode: 'full', value: '[::1]:9099' },
        ],
      );
    } finally {
      restore();
    }
  });
});

// ══════════════════════ 单元层四：hostHeaderAllowed ══════════════════════

describe('P0 通道二单元层：hostHeaderAllowed（app.ts:195-199 + 判定核心 :183-193）', () => {
  it('w1 缺失/空白三态全拒（fail-closed，防 DNS rebinding 首要防线）', () => {
    assert.strictEqual(hostHeaderAllowed(undefined, UNIT_PORT), false);
    assert.strictEqual(hostHeaderAllowed('', UNIT_PORT), false);
    assert.strictEqual(hostHeaderAllowed('   ', UNIT_PORT), false);
  });

  it('w2 回环三形各带正确端口命中', () => {
    assert.strictEqual(hostHeaderAllowed(`localhost:${UNIT_PORT}`, UNIT_PORT), true);
    assert.strictEqual(hostHeaderAllowed(`127.0.0.1:${UNIT_PORT}`, UNIT_PORT), true);
    assert.strictEqual(hostHeaderAllowed(`[::1]:${UNIT_PORT}`, UNIT_PORT), true);
  });

  it('w3 双侧 canonical 归一：大写候选命中（authority 归一大小写折叠 :140-144）', () => {
    assert.strictEqual(hostHeaderAllowed(`LOCALHOST:${UNIT_PORT}`, UNIT_PORT), true);
  });

  it('w4 回环错端口严格拒绝（整串口径，非仅 hostname 匹配）', () => {
    assert.strictEqual(hostHeaderAllowed('localhost:11111', UNIT_PORT), false);
    assert.strictEqual(hostHeaderAllowed(`127.0.0.1:${UNIT_PORT + 1}`, UNIT_PORT), false);
  });

  it('w5 无端口形态一律不放行：裸 localhost / 裸 [::1] / 裸 ::1（rebinding 防线不留端口缺省旁门）', () => {
    assert.strictEqual(hostHeaderAllowed('localhost', UNIT_PORT), false);
    assert.strictEqual(hostHeaderAllowed('[::1]', UNIT_PORT), false);
    assert.strictEqual(hostHeaderAllowed('::1', UNIT_PORT), false);
  });

  it('w6 allowlist hostname 条目：任意端口/无端口命中；后缀伪装与左粘连冒充拒绝；双侧归一命中', () => {
    const restore = withEnv('TRILC_HOST_ALLOWLIST', ' DEVBOX.LOCAL ');
    try {
      assert.strictEqual(hostHeaderAllowed('devbox.local:7777', UNIT_PORT), true);
      assert.strictEqual(hostHeaderAllowed('devbox.local', UNIT_PORT), true);
      // 后缀吞并不成立：hostname 模式精确等值，无 endsWith/前缀语义。
      assert.strictEqual(hostHeaderAllowed('devbox.local.evil.com:80', UNIT_PORT), false);
      assert.strictEqual(hostHeaderAllowed('evil-devbox.local:80', UNIT_PORT), false);
      // 候选侧大写 + 条目侧大写双侧归一仍命中。
      assert.strictEqual(hostHeaderAllowed('DEVBOX.LOCAL:70', UNIT_PORT), true);
    } finally {
      restore();
    }
  });

  it('w7 allowlist 含端口条目整串比对：同 host 异端口拒绝，完全一致+大小写归一双向收敛', () => {
    const restore = withEnv('TRILC_HOST_ALLOWLIST', 'api.corp:8443');
    try {
      assert.strictEqual(hostHeaderAllowed('api.corp:8443', UNIT_PORT), true);
      assert.strictEqual(hostHeaderAllowed('API.CORP:8443', UNIT_PORT), true);
      assert.strictEqual(hostHeaderAllowed('api.corp:9000', UNIT_PORT), false);
      assert.strictEqual(hostHeaderAllowed('api.corp', UNIT_PORT), false);
    } finally {
      restore();
    }
  });
});

// ══════════════════════ 单元层五：originHeaderAllowed ══════════════════════

describe('P0 通道二单元层：originHeaderAllowed（app.ts:201-214）', () => {
  it("v1 空/'null'/'NULL'/'Null' 直通（helper 口径；调用方在 :1601-1603 仅对非 null 强制要求）", () => {
    assert.strictEqual(originHeaderAllowed('', UNIT_PORT), true);
    assert.strictEqual(originHeaderAllowed('null', UNIT_PORT), true);
    assert.strictEqual(originHeaderAllowed('NULL', UNIT_PORT), true);
    assert.strictEqual(originHeaderAllowed('Null', UNIT_PORT), true);
  });

  it('v2 同源命中：path/query 不参与、方案差异（http/https）不参与，仅 authority 参与', () => {
    assert.strictEqual(originHeaderAllowed(`http://localhost:${UNIT_PORT}/admin/path?q=1`, UNIT_PORT), true);
    assert.strictEqual(originHeaderAllowed(`https://127.0.0.1:${UNIT_PORT}`, UNIT_PORT), true);
  });

  it('v3 跨域拒绝且子域不被 hostname 吞噬（sub.localhost ≠ localhost）', () => {
    assert.strictEqual(originHeaderAllowed('https://evil.example.com', UNIT_PORT), false);
    assert.strictEqual(originHeaderAllowed(`https://sub.localhost:${UNIT_PORT}`, UNIT_PORT), false);
  });

  it('v4 解析失败与无 host 形态保守拒（不可信即拒 :209-212）', () => {
    assert.strictEqual(originHeaderAllowed('not-a-url', UNIT_PORT), false);
    assert.strictEqual(originHeaderAllowed('file:///tmp/secret', UNIT_PORT), false);
  });
});

// ══════════════════════ 端到端层：createTriRLCApp 真起服过全局门 ══════════════════════

const TEST_INTERNAL_TOKEN = 'pd-t-auth-gate-fixed-token';
// 业务可达锚路由：GET /internal/v1/cron/jobs（:3591-3602），最小副作用、稳定 JSON 形状。

describe('P0 通道一/二端到端：createTriRLCApp 真实 HTTP 全局门（rmc-TriLC.md P0-1 向量复现）', () => {
  let app: ReturnType<typeof createTriRLCApp>;
  let appPort: number;
  let tmpDataDir: string;

  const SAVED_ENV = {
    TRILC_DATA_DIR: process.env.TRILC_DATA_DIR,
    TRILC_PORT: process.env.TRILC_PORT,
    TRIMODEL_API_TOKEN: process.env.TRIMODEL_API_TOKEN,
    TRILC_INTERNAL_TOKEN: process.env.TRILC_INTERNAL_TOKEN,
    TRILC_HOST_ALLOWLIST: process.env.TRILC_HOST_ALLOWLIST,
  };

  /** node:http 裸请求 helper：显式控制 Host 头有无与取值，绕开 fetch 的
   *  forbidden-header 限制；JSON 解析失败保留 null 让断言显式翻红。 */
  async function rawRequest(
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string; setHost?: boolean } = {},
  ): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: appPort,
          path,
          method: opts.method ?? 'GET',
          headers: opts.headers ?? {},
          // 默认由 node 自动补 Host: 127.0.0.1:<port>（恰为允许集回环项）；false 则完全不发 Host 头。
          setHost: opts.setHost !== false,
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
    tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-authgate-'));
    process.env.TRILC_DATA_DIR = tmpDataDir;
    process.env.TRILC_PORT = '0';
    delete process.env.TRIMODEL_API_TOKEN;
    process.env.TRILC_INTERNAL_TOKEN = TEST_INTERNAL_TOKEN;

    const { readEnv } = await import('../../src/config/env.js');
    const env = readEnv();
    env.port = 0;
    env.trimodelApiUrl = 'http://127.0.0.1:1'; // 死端口，密钥初始化快速降级、零外呼

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

  it('e1 /healthz 精确豁免：门前公开面，token 已配置态无需任何头即可达（:1548 先于全局门）', async () => {
    const res = await rawRequest('/healthz');
    assert.equal(res.status, 200);
    assert.equal(res.json?.service, 'trilc');
    assert.equal(res.json?.ok, true);
  });

  it("e2 '/healthz?x=1' 带 query 不豁免（req.url 精确匹配语义）→ 落入 token 门 401 unauthorized:*", async () => {
    // 既定行为 pin＝残差清单第④项的实证位：拼 query 的探测脚本将撞门而非免检。
    const res = await rawRequest('/healthz?probe=1');
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it('e3 token 未配置 × 正常 Host → 401 internal_auth_disabled（fail-closed 死证；请求期直读 env 不缓存）', async () => {
    const restore = withEnv('TRILC_INTERNAL_TOKEN', undefined);
    try {
      const res = await rawRequest('/internal/v1/cron/jobs');
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'internal_auth_disabled' });
    } finally {
      restore();
    }
  });

  it('e15 未配置态 × 任意攻击者头 → 同样 internal_auth_disabled（未配置态连头比对都不发生，无残余旁路——姊妹树 p0fix2 同型审计要求移植）', async () => {
    const restore = withEnv('TRILC_INTERNAL_TOKEN', undefined);
    try {
      const res = await rawRequest('/internal/v1/cron/jobs', {
        headers: { 'x-internal-token': 'attacker-supplied-garbage' },
      });
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'internal_auth_disabled' });
    } finally {
      restore();
    }
  });

  it('e4 配置态 × 缺头 → 401 与 disabled 态可区分的 unauthorized 文案（审计明文要求）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs');
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it('e5 配置态 × 错头 → 401 unauthorized 文案保持不变', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { 'x-internal-token': 'attacker-supplied-garbage' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it('e6 正确 x-internal-token → 200 业务层真实可达（正向锚，防过度收紧破坏可用性）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
    assert.ok(Array.isArray(res.json?.jobs));
    // 推演待实证：jobs 数组就绪形状依赖 cron 引擎随 start() 就绪——静态依据为
    // qa-json-runtime-stub/tasks-submit-weekly-hint 同型起服先例均实证过该配方。
  });

  it('e7 Authorization: Bearer 正确形态兜底放行（extractInternalToken 兜底支活的路径）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { authorization: `Bearer ${TEST_INTERNAL_TOKEN}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json?.ok, true);
  });

  it("e8 无 Host 的 HTTP/1.1 裸请求 ⇒ 协议层+应用层双层拒死证（pdT-round1 实测：完全缺 Host 由 llhttp 解析器层先行 400）", async () => {
    // 双层防线分工（pdT-round1 实测定谳）：
    //   · 完全无 Host —— Node 底层解析器（llhttp 严格模式）在协议层直接回 400，
    //     请求根本到不了应用层全局门；拒绝面在协议栈，fail-closed 性质不减损，
    //     故只断 status===400（响应体形状属解析器实现细节，不臆造体断言）。
    //   · Host 存在但不在允许集 —— 才由应用层门以 403 forbidden_host 拒绝，
    //     该路径已由 e9（伪造外域带正确 token）与 e14（allowlist 含端口条目异口）
    //     两死证固定；w1/w5 单元层 hostHeaderAllowed 缺失→false 契约同步未变，
    //     它钉的是 helper 判定语义而非协议栈行为。
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { 'x-internal-token': TEST_INTERNAL_TOKEN },
      setHost: false,
    });
    assert.equal(res.status, 400);
  });

  it('e9 伪造外域 Host + 正确 token → 403 forbidden_host（DNS rebinding 主向量死证：token 再对也不救伪造来源）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { host: 'evil.example.com', 'x-internal-token': TEST_INTERNAL_TOKEN },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'forbidden_host' });
  });

  it('e10 Origin 外域 + 无 token → 403 forbidden_origin（Origin 门先于 401 门顺序死证：若 token 门先行应得 401）', async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { error: 'forbidden_origin' });
  });

  it("e11 Origin 'null' 放行穿透 Origin 门落到下一层：无 token → 401 unauthorized（非 forbidden_origin）", async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { origin: 'null' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it("e12 Origin 'NULL' 大小写变体同样视为 null 直通（门回调 :1602 toLowerCase 口径）", async () => {
    const res = await rawRequest('/internal/v1/cron/jobs', {
      headers: { origin: 'NULL' },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
  });

  it('e13 TRILC_HOST_ALLOWLIST hostname 条目运行中注入生效：任意端口命中 Host 门落到 token 门（401 非 403）', async () => {
    const restore = withEnv('TRILC_HOST_ALLOWLIST', 'unit-test.host');
    try {
      const res = await rawRequest('/internal/v1/cron/jobs', {
        headers: { host: 'unit-test.host:5555' }, // 条目无端口 ⇒ hostname 模式，5555 亦命中
      });
      assert.equal(res.status, 401); // 若 Host 门未接受应得 403 forbidden_host
      assert.deepEqual(res.json, { error: 'unauthorized: missing or invalid X-Internal-Token' });
    } finally {
      restore();
    }
  });

  it('e14 allowlist 含端口条目整串口径端到端：同 host 异端口 → 403 forbidden_host（w7 单元语义的真实连接复现）', async () => {
    const restore = withEnv('TRILC_HOST_ALLOWLIST', 'strict.host:9999');
    try {
      const res = await rawRequest('/internal/v1/cron/jobs', {
        headers: { host: 'strict.host:12345', 'x-internal-token': TEST_INTERNAL_TOKEN },
      });
      assert.equal(res.status, 403);
      assert.deepEqual(res.json, { error: 'forbidden_host' });
    } finally {
      restore();
    }
  });
});
