// ── D' 段 1 门禁测试: ACP 帧层 + session 映射 + 假子进程端到端 ──
// 架构稿门禁③: 假事件流端到端一案 —— spawn 假子进程 (node -e responder,
// 不 spawn 真 dsh) 断言 new → agent_message_chunk 流 → tool_call →
// settle 全链 blocks 序正确。
// D-46: debug 面断言只含 method/update 类型, 零内容面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient, AcpClientError, ACP_METHODS } from '../src/tui/acp/acp-client.js';
import { applySessionUpdate, settleStreaming, buildPromptBlocks } from '../src/tui/acp/session-mapping.js';
import type { Message } from '../src/tui/hooks/useChat.js';

/**
 * 假 dsh responder (node -e, CJS): stdin JSON-RPC 帧 → stdout 响应/通知,
 * 收到的 method 逐行写 stderr (CALL:<method>) 供编排断言。
 * FAKE_SESSIONS: session/list 返回 (JSON 数组字符串); FAKE_MODE=crash →
 * initialize 后立即 exit(1) (exit 清 pending 案); FAKE_MODE=silent → prompt 不回
 * (硬超时案)。
 */
const RESPONDER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let f; try { f = JSON.parse(line); } catch { return; }
  process.stderr.write('CALL:' + f.method + '\\n');
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: f.id, result }) + '\\n');
  if (f.method === 'initialize') { if (process.env.FAKE_MODE === 'crash') process.exit(1); reply({ protocolVersion: 1 }); return; }
  if (process.env.FAKE_MODE === 'silent' && f.method === 'session/prompt') return;
  if (f.method === 'session/list') { reply({ sessions: JSON.parse(process.env.FAKE_SESSIONS || '[]') }); return; }
  if (f.method === 'session/new') { reply({ sessionId: 'sess-new-1' }); return; }
  if (f.method === 'session/resume') { reply({ sessionId: f.params.sessionId }); return; }
  if (f.method === 'session/prompt') {
    const sid = f.params.sessionId;
    const updates = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read_file', rawInput: { path: 'a.ts' } },
      { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', contentText: 'file-body' },
      { sessionUpdate: 'usage_update', inputTokens: 11, outputTokens: 7 },
    ];
    // FAKE_STREAM_DELAY_MS: update 间分批流送 (ms) —— 流中断言窗口;
    // 缺省 0 = 同步连发。
    const delay = parseInt(process.env.FAKE_STREAM_DELAY_MS || '0', 10);
    const sendUpdate = (i) => {
      if (i >= updates.length) { reply({ stopReason: 'end_turn' }); return; }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: updates[i] } }) + '\\n');
      if (delay > 0) setTimeout(() => sendUpdate(i + 1), delay); else sendUpdate(i + 1);
    };
    sendUpdate(0);
    return;
  }
  reply({});
});
`;

function makeClient(opts: Record<string, unknown> = {}, env: Record<string, string> = {}): AcpClient {
  return new AcpClient({
    command: process.execPath,
    args: ['-e', RESPONDER],
    requestTimeoutMs: 5000,
    ...opts,
    // env 注入走 spawn 环境 (AcpClient 未透出 env 缝 → 用 process.env 快照)。
  }) as AcpClient;
}

/** 轮询等待 (测试用): 条件满足或超时抛错。 */
async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`waitFor timeout: ${label}`);
}

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { saved[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ── t1: 帧层往返 —— initialize/new/prompt 全走通 (假子进程真 spawn) ──
test('acp-client: request/response roundtrip over fake dsh subprocess', async () => {
  await withEnv({ FAKE_SESSIONS: '[]' }, async () => {
    const client = makeClient();
    client.start();
    try {
      const initRes = (await client.initialize({ protocolVersion: 1, clientInfo: { name: 'trirlc-tui', version: 'test' } })) as { protocolVersion: number };
      assert.equal(initRes.protocolVersion, 1);
      const list = await client.listSessions('/tmp/x');
      assert.deepEqual(list.sessions, []);
      const created = await client.newSession('/tmp/x');
      assert.equal(created.sessionId, 'sess-new-1');
      const promptRes = await client.prompt('sess-new-1', buildPromptBlocks('hi'));
      assert.equal(promptRes.stopReason, 'end_turn');
    } finally {
      await client.dispose();
    }
  });
});

// ── t2: 端到端假事件流一案 (门禁③) ──
// client 通知 → reducer 映射 → settle, 断言 blocks 序:
//   [text('Hello world'), tool_use(t1, done), tool_result('file-body')]
// 并断言 usage/token 读数与流式翻转。
test('e2e fake event stream: new → message chunks → tool_call → settle (blocks order)', async () => {
  await withEnv({ FAKE_SESSIONS: '[]', FAKE_STREAM_DELAY_MS: '60' }, async () => {
    const client = makeClient();
    let messages: Message[] = [];
    let todos: Array<Record<string, unknown>> = [];
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    // hook 管线镜像: notification → applySessionUpdate → setState 等价物。
    client.onNotification(({ update }) => {
      const res = applySessionUpdate(messages, update as never);
      messages = res.messages;
      if (res.todos.length > 0) todos = res.todos as never;
      if (res.inputTokens !== null) inputTokens = res.inputTokens;
      if (res.outputTokens !== null) outputTokens = res.outputTokens;
    });
    client.start();
    try {
      await client.initialize({ protocolVersion: 1, clientInfo: { name: 'trirlc-tui', version: 'test' } });
      const created = await client.newSession(process.cwd());
      const sid = created.sessionId!;
      assert.equal(sid, 'sess-new-1');
      // 本地 echo user + streaming assistant (hook send() 形)。
      messages = [
        { role: 'user', content: 'hi', isStreaming: false },
        { role: 'assistant', content: '', isStreaming: true, toolCalls: [], blocks: [] },
      ];
      // ── 流中段断言 (response 未回时): text 已累积, tool_use pending ──
      const promptPromise = client.prompt(sid, buildPromptBlocks('hi'));
      await waitFor(() => {
        const b = messages[messages.length - 1]?.blocks ?? [];
        return b.some((x) => x.type === 'tool_use');
      }, 'tool_use block 未在流中出现');
      const midBlocks = messages[messages.length - 1]!.blocks!;
      assert.equal(midBlocks[0]!.type, 'text');
      assert.equal(midBlocks[0]!.text, 'Hello world');
      assert.equal(midBlocks[1]!.type, 'tool_use');
      assert.equal(midBlocks[1]!.toolStatus, 'pending');
      assert.equal(messages[messages.length - 1]!.isStreaming, true);
      const settled = await promptPromise;
      assert.equal(settled.stopReason, 'end_turn');
      // ── settle ──
      messages = settleStreaming(messages);
      const last = messages[messages.length - 1]!;
      assert.equal(last.role, 'assistant');
      assert.equal(last.isStreaming, false);
      const blocks = last.blocks!;
      assert.equal(blocks.length, 3, `blocks 序: ${JSON.stringify(blocks)}`);
      assert.equal(blocks[0]!.type, 'text');
      assert.equal(blocks[0]!.text, 'Hello world');
      assert.equal(blocks[1]!.type, 'tool_use');
      assert.equal(blocks[1]!.toolId, 't1');
      assert.equal(blocks[1]!.toolName, 'read_file');
      assert.equal(blocks[1]!.toolStatus, 'done');
      assert.equal(blocks[2]!.type, 'tool_result');
      assert.equal(blocks[2]!.toolResultContent, 'file-body');
      assert.equal(inputTokens, 11);
      assert.equal(outputTokens, 7);
      assert.deepEqual(todos, []);
    } finally {
      await client.dispose();
    }
  });
});

// ── t3: 硬超时 —— silent 模式 prompt 超时 reject code='timeout' ──
test('acp-client: hard timeout rejects pending request', async () => {
  await withEnv({ FAKE_SESSIONS: '[]', FAKE_MODE: 'silent' }, async () => {
    const client = makeClient({ promptTimeoutMs: 250 });
    client.start();
    try {
      await client.initialize({ protocolVersion: 1, clientInfo: { name: 't', version: '0' } });
      const created = await client.newSession('/tmp/x');
      await assert.rejects(
        () => client.prompt(created.sessionId!, buildPromptBlocks('hi')),
        (err: AcpClientError) => err instanceof AcpClientError && err.code === 'timeout',
      );
    } finally {
      await client.dispose();
    }
  });
});

// ── t4: exit 清 pending —— crash 模式 initialize 后进程退, 后续请求 reject ──
test('acp-client: child exit rejects pending + fails later requests', async () => {
  await withEnv({ FAKE_MODE: 'crash' }, async () => {
    const client = makeClient({ requestTimeoutMs: 5000 });
    let exitCode: number | null | undefined;
    client.onExit((code) => { exitCode = code; });
    client.start();
    await assert.rejects(
      () => client.initialize({ protocolVersion: 1, clientInfo: { name: 't', version: '0' } }),
      (err: AcpClientError) => err instanceof AcpClientError && err.code === 'exited',
    );
    assert.equal(exitCode, 1);
    await assert.rejects(() => client.listSessions('/tmp/x'));
  });
});

// ── t5: session 生命周期编排 —— list 有段 → resume 最新 (裁决③) ──
test('lifecycle: list with existing session → resume latest (stderr CALL order)', async () => {
  await withEnv({ FAKE_SESSIONS: JSON.stringify([{ sessionId: 'sess-old-1', updatedAt: '2026-10-19T00:00:00Z' }, { sessionId: 'sess-old-9', updatedAt: '2026-10-20T01:00:00Z' }]) }, async () => {
    const client = makeClient();
    client.start();
    try {
      await client.initialize({ protocolVersion: 1, clientInfo: { name: 't', version: '0' } });
      const list = await client.listSessions(process.cwd());
      const sessions = [...(list.sessions ?? [])].sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
      assert.equal(sessions[0]!.sessionId, 'sess-old-9'); // 最新段
      const resumed = await client.resumeSession(sessions[0]!.sessionId!, process.cwd());
      assert.equal(resumed.sessionId, 'sess-old-9');
      // stderr CALL 序含 resume 且指向最新段 (编排证据)。
      await waitFor(() => client.stderrTailContent.includes('CALL:session/resume'), 'stderr CALL 序未达');
      const calls = client.stderrTailContent.split('\n').filter((l) => l.startsWith('CALL:')).map((l) => l.slice(5));
      assert.deepEqual(calls, [ACP_METHODS.initialize, ACP_METHODS.sessionList, ACP_METHODS.sessionResume]);
    } finally {
      await client.dispose();
    }
  });
});

// ── t6: 映射全类型覆盖 (纯函数·不 spawn) ──
test('session-mapping: full update-type coverage', () => {
  const base: Message[] = [
    { role: 'user', content: 'q', isStreaming: false },
    { role: 'assistant', content: '', isStreaming: true, toolCalls: [], blocks: [] },
  ];
  // agent_message_chunk: 两 chunk → 单 text block 累积。
  let r1 = applySessionUpdate(base, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A' } });
  r1 = applySessionUpdate(r1.messages, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } });
  assert.equal(r1.messages[1]!.blocks![0]!.text, 'AB');
  assert.equal(r1.messages[1]!.content, 'AB');
  // agent_thought_chunk → thinking。
  const r2 = applySessionUpdate(r1.messages, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think' } });
  assert.equal(r2.messages[1]!.thinking, 'think');
  // tool_call → tool_use pending + 兼容 toolCalls 维护。
  const r3 = applySessionUpdate(r2.messages, { sessionUpdate: 'tool_call', toolCallId: 'x1', title: 'bash', rawInput: { cmd: 'ls' } });
  const toolBlock = r3.messages[1]!.blocks!.find((b) => b.type === 'tool_use')!;
  assert.equal(toolBlock.toolStatus, 'pending');
  assert.equal(toolBlock.toolName, 'bash');
  assert.equal(toolBlock.toolInput, JSON.stringify({ cmd: 'ls' }));
  const lastCall = r3.messages[1]!.toolCalls![r3.messages[1]!.toolCalls!.length - 1]!;
  assert.deepEqual(lastCall, { id: 'x1', name: 'bash', arguments: '{"cmd":"ls"}', status: 'pending' });
  // tool_call_update: completed → done + tool_result block。
  const r4 = applySessionUpdate(r3.messages, { sessionUpdate: 'tool_call_update', toolCallId: 'x1', status: 'completed', contentText: 'out' });
  assert.equal(r4.messages[1]!.blocks!.find((b) => b.type === 'tool_use')!.toolStatus, 'done');
  const resultBlock = r4.messages[1]!.blocks!.find((b) => b.type === 'tool_result')!;
  assert.equal(resultBlock.toolResultContent, 'out');
  // tool_call_update: failed → error。
  const r4f = applySessionUpdate(r3.messages, { sessionUpdate: 'tool_call_update', toolCallId: 'x1', status: 'failed' });
  assert.equal(r4f.messages[1]!.blocks!.find((b) => b.type === 'tool_use')!.toolStatus, 'error');
  // plan → todos (TodoPanel 形)。
  const r5 = applySessionUpdate(base, { sessionUpdate: 'plan', entries: [{ content: 'step1', status: 'in_progress', priority: 'high' }, { content: 'step2', status: 'pending' }] });
  assert.equal(r5.todos.length, 2);
  assert.deepEqual(r5.todos[0], { id: 'plan-0', subject: 'step1', description: '', status: 'in_progress', priority: 'high' });
  assert.equal(r5.todos[1]!.status, 'pending');
  // usage_update → 读数。
  const r6 = applySessionUpdate(base, { sessionUpdate: 'usage_update', inputTokens: 3, outputTokens: 4 });
  assert.equal(r6.inputTokens, 3);
  assert.equal(r6.outputTokens, 4);
  // user_message_chunk / 未知判别 → 忽略且 applied 面如实。
  assert.equal(applySessionUpdate(base, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } }).applied, true);
  assert.equal(applySessionUpdate(base, { sessionUpdate: 'future_kind_xyz' }).applied, false);
  assert.deepEqual(applySessionUpdate(base, { sessionUpdate: 'future_kind_xyz' }).messages, base);
  // 无 streaming 靶时通知不落空转 (不崩)。
  const noTarget = applySessionUpdate([{ role: 'user', content: 'x', isStreaming: false }], { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'z' } });
  assert.equal(noTarget.messages.length, 1);
  // settleStreaming: pending tool_use 落 done + isStreaming 翻转。
  const settled = settleStreaming(r3.messages);
  assert.equal(settled[1]!.isStreaming, false);
  assert.equal(settled[1]!.blocks!.find((b) => b.type === 'tool_use')!.toolStatus, 'done');
});

// ── t7: D-46 —— debug 观察面零内容面 ──
test('d46: debug lines carry only method/update type, zero content', async () => {
  await withEnv({ FAKE_SESSIONS: '[]' }, async () => {
    const debugLines: string[] = [];
    const client = makeClient({ debug: (l) => debugLines.push(l) });
    client.start();
    try {
      await client.initialize({ protocolVersion: 1, clientInfo: { name: 't', version: '0' } });
      const created = await client.newSession('/tmp/x');
      await client.prompt(created.sessionId!, buildPromptBlocks('SECRET-CONTENT-MARKER'));
      const joined = debugLines.join('\n');
      assert.ok(!joined.includes('SECRET-CONTENT-MARKER'), 'D-46: prompt 内容不得进 debug 面');
      assert.ok(!joined.includes('Hello world'), 'D-46: chunk 文本不得进 debug 面');
      assert.ok(joined.includes('method=initialize'));
      assert.ok(joined.includes('update=agent_message_chunk'));
      assert.ok(joined.includes('update=tool_call'));
    } finally {
      await client.dispose();
    }
  });
});

// ── t8: 非 JSON 行静默忽略 (横幅混流防护) ──
test('frame layer: non-json stdout lines are ignored silently', async () => {
  const bannerResponder = `process.stdout.write('BANNER LINE\\n'); process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'}}}}) + '\\n'); setTimeout(() => process.exit(0), 100);`;
  const client = new AcpClient({ command: process.execPath, args: ['-e', bannerResponder] });
  let got: unknown = null;
  client.onNotification(({ update }) => { got = update; });
  client.start();
  await new Promise((r) => setTimeout(r, 400));
  await client.dispose();
  assert.ok((got as { sessionUpdate?: string })?.sessionUpdate === 'agent_message_chunk', 'JSON 帧应被分发, 横幅行被忽略');
});

// ── t9: CLI --acp 解析 (段 2 观察项收口: parseArgs 面契约) ──
test('cli parseArgs: --acp flag parsing and default', async () => {
  const { parseArgs } = await import('../src/cli.js');
  assert.equal(parseArgs(['chat', '--acp']).acp, true, '--acp 应解析为 true');
  assert.equal(parseArgs(['chat']).acp, false, '缺省无 --acp 应为 false (daemon 面不动)');
  const both = parseArgs(['chat', '--acp', '--resume', 'sess-x']);
  assert.equal(both.acp, true);
  assert.equal(both.resume, 'sess-x', '--acp 与 --resume 并存应同时解析');
});
