// ── FADE-ASSESS-005 HTTP 集成：派工门禁（tasks/submit ownerRoleId）+
// /agents 可见性回归（contract 全量不改）──
//
// 语义：名册 = 决策面。/agents API 保持 contract 全量可见（可见性不动）；
// 派工（owner 岗位）→ 仅 roster.active 放行，非在岗 409 owner_not_active。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTriRLCApp } from '../../src/server/app.js';

const SAVED_ENV: Record<string, string | undefined> = {};

let tmpDataDir: string;
let app: ReturnType<typeof createTriRLCApp>;
let appPort: number;

before(async () => {
  for (const k of [
    'TRILC_DATA_DIR', 'TRILC_WEEKLY_PLANE_ROOT', 'TRILC_PORT', 'TRILC_PROJECT_ROOT',
    'TRIMODEL_API_TOKEN', 'TRILC_TRIMODEL_API_URL', 'TRILC_INTERNAL_TOKEN',
  ]) {
    SAVED_ENV[k] = process.env[k];
  }

  tmpDataDir = mkdtempSync(join(tmpdir(), 'trilc-gating-'));
  process.env.TRILC_DATA_DIR = tmpDataDir;
  // FADE-ASSESS-003: 知识注入启动同步的 projectRoot 隔离到临时目录，
  // 防止 knowledge.db 落进仓库根（cwd）。
  process.env.TRILC_PROJECT_ROOT = tmpDataDir;
  delete process.env.TRILC_WEEKLY_PLANE_ROOT;
  process.env.TRILC_PORT = '0';
  delete process.env.TRIMODEL_API_TOKEN;
  process.env.TRILC_TRIMODEL_API_URL = 'http://127.0.0.1:1'; // keys degrade fast, no real calls

  // 预置公司态：full-stack-developer 在岗（active），其余 12 岗未上岗（candidate）。
  const stateDir = join(tmpDataDir, 'company');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'state.json'),
    JSON.stringify({
      state: 'initialized',
      companyName: 'Gating Test Co',
      ceoName: 'Tester',
      employees: [{ role: 'full-stack-developer', name: '小全' }],
      onboardedAt: '2026-08-20T00:00:00.000Z',
    }),
    'utf-8',
  );

  // WO-F fixture 自足化：candidate 判据依赖 resolver 单例 catalog（getRoleCatalog
  // 无 roster 即 null→全 unknown）——显式挂真源+loadAll+roster（防跨文件单例泄漏偶通）。
  const { getContractResolver } = await import('../../src/config/contract-resolver.js');
  getContractResolver(resolve('..', 'TriCompany', 'source-agents'));
  await getContractResolver().loadAll();
  getContractResolver().loadEmployeeRoster();

  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1';

  // p0fix3：内部门 fail-closed——app.start() 前注入测试 token，请求统一带头。
  process.env.TRILC_INTERNAL_TOKEN = 'roster-gating-test-token';
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
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(tmpDataDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

async function postJSON(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': process.env.TRILC_INTERNAL_TOKEN ?? '' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

async function getJSON(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${appPort}${path}`, {
    headers: { 'x-internal-token': process.env.TRILC_INTERNAL_TOKEN ?? '' },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

describe('FADE-ASSESS-005 派工门禁 (tasks/submit ownerRoleId)', () => {
  it('不带 ownerRoleId（普通用户会话）→ 201，不受门禁影响', async () => {
    const { status } = await postJSON('/internal/v1/tasks/submit', {
      message: 'ordinary user session',
    });
    assert.equal(status, 201);
  });

  it('ownerRoleId = 在岗岗（full-stack-developer）→ 201 放行', async () => {
    const { status, json } = await postJSON('/internal/v1/tasks/submit', {
      message: 'dispatch to active role',
      ownerRoleId: 'full-stack-developer',
    });
    assert.equal(status, 201);
    assert.ok(json.sessionId);
  });

  it('ownerRoleId = 未上岗岗（senior-test-engineer，candidate）→ 409 owner_not_active，不静默', async () => {
    // WO-F fixture 校准（2026-10-01）：原用 test-engineer 系已改名离场席 id——
    // roster 查无=gate.status 'unknown'（非 candidate）且构成 FADE-003 计数缺格。
    // 对现役席 id 校准；409 门行为零变更。
    // candidate：真实未上岗岗 test-engineer（TriCompany 13 岗之一，本测试仅
    // full-stack-developer 在岗）。终审收口 ③：roleId 对齐真实值 + 断言收紧
    // 为严格 candidate（不再放宽 unknown）。
    const cand = await postJSON('/internal/v1/tasks/submit', {
      message: 'dispatch to not-onboarded role',
      ownerRoleId: 'senior-test-engineer',
    });
    assert.equal(cand.status, 409);
    assert.equal(cand.json.error, 'owner_not_active');
    assert.equal(cand.json.roleId, 'senior-test-engineer');
    assert.equal(cand.json.rosterStatus, 'candidate');

    // unknown：目录外岗位同样拒绝
    const unk = await postJSON('/internal/v1/tasks/submit', {
      message: 'dispatch to unknown role',
      ownerRoleId: 'not-a-role',
    });
    assert.equal(unk.status, 409);
    assert.equal(unk.json.error, 'owner_not_active');
    assert.equal(unk.json.rosterStatus, 'unknown');
  });

  it('ownerRoleId = 待审岗（pending-cho）→ 409 owner_not_active', async () => {
    // 预置 pending-cho 请求：test-engineer 进入待审态（onboard 端点有链态门
    // selfcheck 不可上岗，此处直接写 requests.json，聚焦门禁本身）。
    const staffingDir = join(tmpDataDir, 'staffing');
    mkdirSync(staffingDir, { recursive: true });
    writeFileSync(
      join(staffingDir, 'requests.json'),
      JSON.stringify([
        {
          requestId: 'staffing_test_pending',
          runId: 'run_test_pending',
          roleId: 'senior-test-engineer',
          displayName: '测试工程师',
          requester: 'ceo-panel',
          requestedAt: '2026-08-20T00:00:00.000Z',
          status: 'pending-cho',
        },
      ]),
      'utf-8',
    );

    const res = await postJSON('/internal/v1/tasks/submit', {
      message: 'dispatch to pending role',
      ownerRoleId: 'senior-test-engineer',
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, 'owner_not_active');
    assert.equal(res.json.rosterStatus, 'pending-cho');
  });
});

describe('FADE-ASSESS-005 可见性回归 (/agents contract 全量不改)', () => {
  it('FADE-ASSESS-003 指标：409 派工拒绝后 GET /knowledge/metrics 可见 routing_error 计数', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/internal/v1/knowledge/metrics`, {
      headers: { 'x-internal-token': process.env.TRILC_INTERNAL_TOKEN ?? '' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as {
      ok: boolean;
      metrics: {
        counts: Array<{ event: string; count: number }>;
        consumptionTotal: number;
        documentsTotal: number;
        sessionStats: { total: number; withSession: number; distinctSessions: number };
      };
    };
    assert.equal(body.ok, true);
    // 本 describe 前置用例已触发 ≥3 次派工 409（candidate×2 + unknown×1）→ routing_error 计数可见
    const routing = body.metrics.counts.find((c) => c.event === 'routing_error');
    assert.ok(routing, 'metrics 应含 routing_error 计数');
    assert.ok(routing!.count >= 3, `routing_error 计数应 ≥3（实际 ${routing!.count}）`);
    // 分母面字段齐备（本测试未注入消费，可为零）
    assert.equal(typeof body.metrics.consumptionTotal, 'number');
    assert.equal(typeof body.metrics.sessionStats.total, 'number');
  });

  it('scope=company 返回 contract 全量：未在岗岗同样可见', async () => {
    const { status, json } = await getJSON('/internal/v1/agents?scope=company');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.agents));
    assert.equal(json.scope, 'company');
    assert.ok(typeof json.tricompanyEnabled === 'boolean');

    // 在岗岗必须可见（既有行为）。
    const active = json.agents.find((a: any) => a.id === 'full-stack-developer');
    assert.ok(active, 'active role must be visible in /agents');

    if (json.tricompanyEnabled && json.agents.length > 0) {
      // contract 全量可见性回归：未上岗（candidate）岗也必须出现在列表——
      // 可见性 = contract 全量，不受 roster.active 门禁影响（门禁只作用于派工/分身/调度）。
      const inRoster = new Set(['full-stack-developer']);
      const notActiveVisible = json.agents.some((a: any) => !inRoster.has(a.id));
      assert.ok(notActiveVisible, `未在岗岗必须可见（contract 全量）；agents=${json.agents.map((a: any) => a.id).join(',')}`);
    }
  });

  it('scope=all 含 builtin 4 岗（既有行为）', async () => {
    const { status, json } = await getJSON('/internal/v1/agents?scope=builtin');
    assert.equal(status, 200);
    assert.equal(json.agents.length, 4);
    const ids = json.agents.map((a: any) => a.id).sort();
    assert.deepEqual(ids, ['code_explorer', 'code_reviewer', 'file_processor', 'test_runner']);
  });
});
