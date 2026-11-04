// tui-acp-cli.test.ts — TriRLC cli.ts --acp parseArgs 契约（自 tui-acp.test.ts t9 段拆归·
// TUI 共有化段一：acp 域测试随 r-ink-tui 迁 TriCode，cli 域测试留 TriRLC）
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── t9: CLI --acp 解析 (段 2 观察项收口: parseArgs 面契约) ──
test('cli parseArgs: --acp flag parsing and default', async () => {
  const { parseArgs } = await import('../src/cli.js');
  assert.equal(parseArgs(['chat', '--acp']).acp, true, '--acp 应解析为 true');
  assert.equal(parseArgs(['chat']).acp, false, '缺省无 --acp 应为 false (daemon 面不动)');
  const both = parseArgs(['chat', '--acp', '--resume', 'sess-x']);
  assert.equal(both.acp, true);
  assert.equal(both.resume, 'sess-x', '--acp 与 --resume 并存应同时解析');
});
