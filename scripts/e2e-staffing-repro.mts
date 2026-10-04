// e2e-staffing-repro.mts — FADE-004 候选岗位发布隔离 E2E 复现（批次2 验证临时产物，跑完可删，不 commit）
// 配方：隔离 dataDir + 种子开业态（总助在岗 + 链态 ready）→ 8 步链 → 审计文件 copy 补证目录
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTriRLCApp } from '../src/server/app.js';
import { readEnv } from '../src/config/env.js';
import { defaultChainFile } from '../src/company/init-chain.js';

const results: Array<{ step: string; pass: boolean; detail: string }> = [];
const check = (step: string, cond: boolean, detail: string) => {
  results.push({ step, pass: cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${step} | ${detail}`);
};

// ① 隔离 dataDir + 种子开业态
const dataDir = await mkdtemp(join(tmpdir(), 'staffing-e2e-'));
await mkdir(join(dataDir, 'company'), { recursive: true });
await writeFile(join(dataDir, 'company', 'state.json'), JSON.stringify({
  state: 'initialized', companyName: 'E2E Co', ceoName: 'Tester',
  employees: [{ role: 'ceo-chief-of-staff', name: '小贾' }],
  onboardedAt: '2026-08-20T00:00:00.000Z',
}, null, 2), 'utf-8');
await writeFile(join(dataDir, 'company', 'init-chain.json'),
  JSON.stringify({ ...defaultChainFile(), chainState: 'ready' }, null, 2), 'utf-8');

// ② env 隔离
process.env.TRILC_DATA_DIR = dataDir;
process.env.TRILC_PROJECT_ROOT = dataDir;
process.env.TRILC_PORT = '0';
delete process.env.TRIMODEL_API_TOKEN;
process.env.TRILC_TRIMODEL_API_URL = 'http://127.0.0.1:1';
delete process.env.TRILC_WEEKLY_PLANE_ROOT;

const EVIDENCE_DIR = resolve('D:/Code/ai/TriCompany/docs/engineering/fade-papers/FADE-004-evidence');

let app: ReturnType<typeof createTriRLCApp>;
try {
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1';
  app = createTriRLCApp(env);
  await app.start();
  const port = env.port;
  if (!port) throw new Error('app did not bind a port');
  const base = `http://127.0.0.1:${port}`;
  console.log(`[e2e] daemon on :${port} dataDir=${dataDir}`);

  const getJSON = async (p: string) => {
    const res = await fetch(base + p); const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  };
  const postJSON = async (p: string, body: unknown) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let json: any = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json };
  };

  // e2e-1 总助 active（开业选定打钩）
  const r1 = await getJSON('/internal/v1/staffing/roster');
  const chief = r1.json?.roster?.find((x: any) => x.roleId === 'ceo-chief-of-staff');
  check('e2e-1 总助 active | counts.total=13', r1.status === 200 && chief?.status === 'active'
    && r1.json?.counts?.total === 13 && r1.json?.counts?.active === 1,
    `status=${r1.status} 总助=${chief?.status} total=${r1.json?.counts?.total} active=${r1.json?.counts?.active}`);

  // e2e-2 CMO onboard → 202 pending（requestId+runId）
  const r2 = await postJSON('/internal/v1/staffing/onboard', { roleId: 'chief-marketing-officer', requester: 'ceo-panel' });
  const requestId = r2.json?.requestId;
  check('e2e-2 CMO onboard → 202 pending', r2.status === 202 && !!requestId && !!r2.json?.runId && r2.json?.statusText === 'pending-cho',
    `status=${r2.status} requestId=${requestId} runId=${r2.json?.runId}`);

  // e2e-3 pending 可见 + counts
  const r3 = await getJSON('/internal/v1/staffing/roster');
  const cmoP = r3.json?.roster?.find((x: any) => x.roleId === 'chief-marketing-officer');
  check('e2e-3 pending 可见 + counts', cmoP?.status === 'pending-cho' && r3.json?.counts?.pending === 1 && r3.json?.counts?.active === 1,
    `CMO=${cmoP?.status} pending=${r3.json?.counts?.pending} active=${r3.json?.counts?.active}`);

  // e2e-3b 重复 onboard → 409
  const r3b = await postJSON('/internal/v1/staffing/onboard', { roleId: 'chief-marketing-officer', requester: 'ceo-panel' });
  check('e2e-3b 重复 onboard → 409 already_pending', r3b.status === 409 && r3b.json?.error === 'already_pending',
    `status=${r3b.status} error=${r3b.json?.error}`);

  // e2e-4 非 CHO 审批人 → 403
  const r4 = await postJSON('/internal/v1/staffing/decide', { requestId, decision: 'approved', approver: 'cmo' });
  check('e2e-4 非 CHO 审批人 → 403 cho_gate', r4.status === 403 && r4.json?.error === 'cho_gate',
    `status=${r4.status} error=${r4.json?.error}`);

  // e2e-5 CHO 批准 → 200（面板代理 approver=panel-cho，规范 §二 Close Skill）
  const r5 = await postJSON('/internal/v1/staffing/decide', { requestId, decision: 'approved', approver: 'panel-cho', note: 'E2E 复现（批次2 验证）' });
  check('e2e-5 CHO 批准 → 200', r5.status === 200 && r5.json?.ok === true && r5.json?.decision === 'approved',
    `status=${r5.status} decision=${r5.json?.decision}`);

  // e2e-6 CMO → active（2/13 在岗）
  const r6 = await getJSON('/internal/v1/staffing/roster');
  const cmoA = r6.json?.roster?.find((x: any) => x.roleId === 'chief-marketing-officer');
  check('e2e-6 CMO → active（2/13）', cmoA?.status === 'active' && r6.json?.counts?.active === 2,
    `CMO=${cmoA?.status} active=${r6.json?.counts?.active}/${r6.json?.counts?.total}`);

  // e2e-7 驳回 → 回 candidate 可再申请（CFO 演示）
  const r7a = await postJSON('/internal/v1/staffing/onboard', { roleId: 'chief-financial-officer', requester: 'ceo-panel' });
  const r7b = await postJSON('/internal/v1/staffing/decide', { requestId: r7a.json?.requestId, decision: 'rejected', approver: 'panel-cho', note: '驳回演示' });
  const r7c = await getJSON('/internal/v1/staffing/roster');
  const cfo = r7c.json?.roster?.find((x: any) => x.roleId === 'chief-financial-officer');
  const r7d = await postJSON('/internal/v1/staffing/onboard', { roleId: 'chief-financial-officer', requester: 'ceo-panel' });
  check('e2e-7 驳回 → 回 candidate 可再申请', r7a.status === 202 && r7b.status === 200 && cfo?.status === 'candidate' && r7d.status === 202,
    `onboard=${r7a.status} decide=${r7b.status} CFO=${cfo?.status} 再申请=${r7d.status}`);

  // e2e-8 官方审计 json 落盘（对齐 CHO-clone-staffing 形态字段族）
  const auditPath = join(dataDir, 'staffing', `CHO-staffing-${requestId}.json`);
  let audit: any = null;
  try { audit = JSON.parse(await readFile(auditPath, 'utf-8')); } catch { /* missing */ }
  check('e2e-8 官方审计落盘 CHO-staffing-<requestId>.json', !!audit && audit.requestType === 'STAFFING_ONBOARDING_APPROVAL'
    && audit.approver === 'panel-cho' && audit.approverRole === 'ChiefHumanResourcesOfficer'
    && audit.decision === 'APPROVED' && audit.employee?.roleId === 'chief-marketing-officer'
    && !!audit.requester && !!audit.runId && Array.isArray(audit.conditions) && !!audit.auditAt,
    audit ? `requestType=${audit.requestType} decision=${audit.decision} employee=${audit.employee?.roleId} runId=${audit.runId} auditAt=${audit.auditAt}` : 'audit file missing');
  check('e2e-8b requests.json 持久', await readFile(join(dataDir, 'staffing', 'requests.json'), 'utf-8').then(() => true).catch(() => false), 'requests.json exists');

  // e2e-9 审计文件 copy 至补证目录（FADE-004-evidence/）
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const evAudit = join(EVIDENCE_DIR, `CHO-staffing-${requestId}.json`);
  await copyFile(auditPath, evAudit);
  await copyFile(join(dataDir, 'staffing', 'requests.json'), join(EVIDENCE_DIR, 'requests.json'));
  check('e2e-9 审计 copy 至补证目录', true, evAudit);

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n== SUMMARY: ${results.length} checks, ${results.length - passed} FAIL ==`);
  console.log(`dataDir(证据保留，可复核): ${dataDir}`);
  console.log(`补证目录: ${EVIDENCE_DIR}`);
  await app.stop();
  process.exit(passed === results.length ? 0 : 1);
} catch (err) {
  console.error('[e2e] script crashed:', err);
  process.exit(1);
}
