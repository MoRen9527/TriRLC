// ── Read tool offset/EOF edge tests (REGR-20261020-001) ──
// Beyond-EOF reads must return an explicit EOF system-reminder (zero
// information ≠ valid read); in-bounds reads keep cat -n behavior intact.
// Covers the residual edge from BUG-20260805-001 resurvey (report/
// 20261020-大表清扫 bug001-read-toolresult-resurvey.md §三).
// 上游 4976dda 已含 file-read EOF 分支（本件补其单测锚——测试锚缺位勘定 10-23）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool, type ToolContext } from '@tricompany/agent-core';
import { registerReadTool } from '../src/tools/file-read.js';

let base: string;
let fiveLineFile: string;
const ctx: ToolContext = {};

before(() => {
  base = mkdtempSync(join(tmpdir(), 'trilc-file-read-'));
  fiveLineFile = join(base, 'five-lines.txt');
  writeFileSync(fiveLineFile, 'L1\nL2\nL3\nL4\nL5\n', 'utf-8');
  registerReadTool();
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('Read tool offset vs EOF (REGR-20261020-001)', () => {
  it('offset beyond EOF returns explicit EOF system-reminder, zero lines', async () => {
    const result = JSON.parse(
      await executeTool('Read', { file_path: fiveLineFile, offset: 99 }, ctx),
    );
    assert.match(
      result.content,
      /EOF: file has 5 lines \(requested start line 99 is beyond EOF\)/,
      `expected explicit EOF reminder, got: ${JSON.stringify(result)}`,
    );
    assert.equal(result.num_lines, 0);
    assert.equal(result.total_lines, 5);
    assert.equal(result.start_line, 99);
  });

  it('offset == totalLines still reads the last line (clamp path intact)', async () => {
    const result = JSON.parse(
      await executeTool('Read', { file_path: fiveLineFile, offset: 5 }, ctx),
    );
    assert.ok(result.content.includes('L5'), `expected L5, got: ${JSON.stringify(result)}`);
    assert.equal(result.num_lines, 1);
    assert.equal(result.total_lines, 5);
  });

  it('offset within bounds keeps cat -n baseline behavior', async () => {
    const result = JSON.parse(
      await executeTool('Read', { file_path: fiveLineFile, offset: 2, limit: 2 }, ctx),
    );
    assert.ok(result.content.includes('L2'), `expected L2, got: ${JSON.stringify(result)}`);
    assert.ok(result.content.includes('L3'), `expected L3, got: ${JSON.stringify(result)}`);
    assert.ok(!result.content.includes('L1'), 'L1 must not leak into an offset=2 read');
  });
});
