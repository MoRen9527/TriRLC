// ── D' 段 2a 河源真进程联调探针（隔离 HOME + env 注入凭据·不落仓交付件）──
// 用法: tsx lt-probe.mts create|resume
//  - create: initialize → list(预期空) → session/new → prompt → settle → close
//  - resume: initialize → list(取最新) → session/resume → prompt → settle → close
// 生命周期四断言的载体: create 案 + 「独立进程重跑 resume 案」+ close 读数。
// D-46: 输出只含 sessionId/stopReason/判别谱计数/耗时 —— 零 prompt 内容零凭据面。
// 凭据: DEEPSEEK_API_KEY 由外层 shell env 注入 (读自 TriModel/.env, 不落盘不回显)。
import { AcpClient } from './acp-client.js';
import { buildPromptBlocks } from './session-mapping.js';

const mode = process.argv[2] ?? 'create';
const DSH_BIN = process.env.DSH_BIN ?? 'dsh';
const cwd = process.env.LT_CWD ?? process.cwd();
const promptText = mode === 'create' ? '只回复一个字：好' : '只回复一个字：成';

const client = new AcpClient({
  command: DSH_BIN,
  args: ['--profile', 'acp'],
  cwd,
  requestTimeoutMs: 30_000,
  promptTimeoutMs: 90_000,
});

let updates = 0;
const kinds: Record<string, number> = {};
client.onNotification(({ update }) => {
  updates++;
  const k = String((update as { sessionUpdate?: string }).sessionUpdate ?? 'unknown');
  kinds[k] = (kinds[k] ?? 0) + 1;
});

const t0 = Date.now();
const el = () => `${Date.now() - t0}ms`;
const out = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

async function main(): Promise<void> {
  client.start();
  await client.initialize({ protocolVersion: 1, clientInfo: { name: 'trirlc-lt', version: '0.1.0' } });
  out({ step: 'initialize', ok: true, at: el() });

  const list = await client.listSessions(cwd);
  const sessions = [...(list.sessions ?? [])].sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  out({ step: 'list', count: sessions.length, at: el() });

  let sid: string | undefined;
  if (mode === 'create' || sessions.length === 0) {
    const created = await client.newSession(cwd);
    sid = created.sessionId;
    out({ step: 'new', sessionId: sid ?? null, at: el() });
  } else {
    const resumed = await client.resumeSession(sessions[0]!.sessionId!, cwd);
    sid = resumed.sessionId ?? sessions[0]!.sessionId;
    out({ step: 'resume', sessionId: sid ?? null, resumedFrom: sessions[0]!.sessionId, at: el() });
  }
  if (!sid) throw new Error('no sessionId');

  const settled = await client.prompt(sid, buildPromptBlocks(promptText));
  out({ step: 'prompt', stopReason: settled.stopReason ?? null, updates, kinds, at: el() });

  await client.closeSession(sid);
  out({ step: 'close', ok: true, at: el() });
  await client.dispose();
  out({ step: 'dispose', ok: true, total: el() });
}

main().then(() => process.exit(0)).catch((err: unknown) => {
  const e = err as { message?: string; code?: string; stderrTail?: string };
  const masked = String(e.stderrTail ?? '').replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***');
  out({ error: e.message ?? String(err), code: e.code ?? null, stderrTail: masked.slice(-500) });
  process.exit(1);
});
