// e2e-agenttool-spawn.mts — FADE-ASSESS-005 AgentTool 合同岗 spawn 前置门禁端到端（批次2 验证临时产物，跑完可删，不 commit）
// 场景：隔离 daemon（full-stack-developer active / test-engineer candidate）→ AgentTool handler 全链路
// 断言① 非在岗合同岗 → role_not_active 显式拒绝（不 spawn）；断言② 在岗 → 放行进入 spawnAgent
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createTriRLCApp } from '../src/server/app.js';
import { readEnv } from '../src/config/env.js';
import { defaultChainFile } from '../src/company/init-chain.js';
import { registerAgentTool } from '../src/tools/agent-tool.js';
import { executeTool } from '@tricompany/agent-core';

const results: Array<{ step: string; pass: boolean; detail: string }> = [];
const check = (step: string, cond: boolean, detail: string) => {
  results.push({ step, pass: cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${step} | ${detail}`);
};

// agent-tool.ts:136 硬编码 fetch localhost:8711/internal/v1/agents —— 先探测
const isPortFree = (port: number) => new Promise<boolean>((res) => {
  const srv = createServer();
  srv.once('error', () => res(false));
  srv.listen(port, '127.0.0.1', () => { srv.close(() => res(true)); });
});
const portFree = await isPortFree(8711);
let stub: ReturnType<typeof createServer> | null = null;

// 隔离 dataDir + 种子：full-stack-developer active / test-engineer candidate
const dataDir = await mkdtemp(join(tmpdir(), 'spawn-e2e-'));
await mkdir(join(dataDir, 'company'), { recursive: true });
await writeFile(join(dataDir, 'company', 'state.json'), JSON.stringify({
  state: 'initialized', companyName: 'Spawn E2E Co', ceoName: 'Tester',
  employees: [{ role: 'full-stack-developer', name: '小全' }],
  onboardedAt: '2026-08-20T00:00:00.000Z',
}, null, 2), 'utf-8');
await writeFile(join(dataDir, 'company', 'init-chain.json'),
  JSON.stringify({ ...defaultChainFile(), chainState: 'ready' }, null, 2), 'utf-8');

process.env.TRILC_DATA_DIR = dataDir;
process.env.TRILC_PROJECT_ROOT = dataDir;
process.env.TRILC_PORT = portFree ? '8711' : '0';
delete process.env.TRIMODEL_API_TOKEN;
process.env.TRILC_TRIMODEL_API_URL = 'http://127.0.0.1:1';
delete process.env.TRILC_WEEKLY_PLANE_ROOT;
console.log(`[probe] 8711 ${portFree ? '空闲 → 隔离 daemon 直绑 8711（自闭环）' : '被占用 → fetch 现役 /agents（只读）'}`);

let app: ReturnType<typeof createTriRLCApp>;
try {
  const env = readEnv();
  env.port = portFree ? 8711 : 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1';
  app = createTriRLCApp(env);
  await app.start();
  const port = env.port;
  if (!port) throw new Error('app did not bind a port');
  const base = `http://127.0.0.1:${port}`;

  if (!portFree) {
    let upstreamOk = false;
    try { upstreamOk = (await fetch('http://127.0.0.1:8711/internal/v1/agents?scope=company')).ok; } catch { /* */ }
    if (!upstreamOk) {
      stub = createServer(async (req, res) => {
        if (req.url === '/internal/v1/agents') {
          try {
            const upstream = await fetch(`${base}/internal/v1/agents?scope=company`);
            res.writeHead(upstream.status, { 'content-type': 'application/json' });
            res.end(await upstream.text());
          } catch { res.writeHead(503); res.end('{}'); }
        } else { res.writeHead(404); res.end(); }
      });
      await new Promise<void>((r) => stub!.listen(8711, () => r()));
      console.log('[probe] 现役 /agents 不可用 → stub 8711 转发隔离 daemon /agents');
    }
  }

  // 生产路径同款注册（src/index.ts:46 registerAgentTool；rosterGate 已由 app.start() 注入 app.ts:965）
  registerAgentTool();

  // 断言①：非在岗合同岗 test-engineer（candidate）→ role_not_active 显式拒绝，不 spawn
  const j1 = JSON.parse(await executeTool('AgentTool', { description: 'verify gate', prompt: 'no-op check', subagent_type: 'test-engineer' }));
  check('spawn-1 非在岗合同岗(candidate) → role_not_active 拒绝', j1?.error === 'role_not_active'
    && j1?.rosterStatus === 'candidate' && j1?.roleId === 'test-engineer' && j1?.status === 'error',
    `error=${j1?.error} rosterStatus=${j1?.rosterStatus} roleId=${j1?.roleId}`);
  check('spawn-1b 拒绝时不进入 spawn（无 agentUsed/result）', !j1?.agentUsed && !j1?.result,
    `agentUsed=${j1?.agentUsed ?? '(none)'} result=${'result' in j1}`);

  // 断言②：在岗岗 full-stack-developer（active）→ 门禁放行，进入 spawnAgent
  const before = (await (await fetch(`${base}/internal/v1/knowledge/metrics`)).json()) as any;
  const res2 = await Promise.race([
    executeTool('AgentTool', { description: 'spawn allowed', prompt: 'say hello', subagent_type: 'full-stack-developer' }),
    new Promise<string>((_, rej) => setTimeout(() => rej(new Error('spawn timeout 60s')), 60_000)),
  ]);
  let j2: any = {};
  try { j2 = JSON.parse(res2); } catch { j2 = { raw: res2 }; }
  check('spawn-2 在岗岗(active) → 门禁放行（无 role_not_active）', j2?.error !== 'role_not_active',
    `error=${j2?.error ?? '(none)'} status=${j2?.status}`);
  check('spawn-2b 放行后进入 spawnAgent（返回 spawn 结果结构）', typeof j2?.agentUsed === 'string' && 'result' in j2,
    `agentUsed=${j2?.agentUsed} status=${j2?.status} result=${String(j2?.result ?? '').slice(0, 100)}（模型面不可达为预期标注）`);

  // 断言③：拒绝埋点 routing_error（detail=spawn_gate_denied:candidate）计数 +1
  const after = (await (await fetch(`${base}/internal/v1/knowledge/metrics`)).json()) as any;
  const routingCount = (m: any) => m?.metrics?.counts?.find((c: any) => c.event === 'routing_error')?.count ?? 0;
  check('spawn-3 拒绝埋点 routing_error 计数 +1', routingCount(after) >= routingCount(before) + 1,
    `before=${routingCount(before)} after=${routingCount(after)}`);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n== SUMMARY: ${results.length} checks, ${results.length - passed} FAIL ==`);
  console.log(`dataDir: ${dataDir}`);
  await app.stop();
  if (stub) await new Promise<void>((r) => stub!.close(() => r()));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(passed === results.length ? 0 : 1);
} catch (err) {
  console.error('[spawn-e2e] script crashed:', err);
  if (stub) { try { stub.close(); } catch { /* */ } }
  process.exit(1);
}
