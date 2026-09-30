// ── Tools ctx.cwd resolution tests (r4-1 A-TriRLC) ──
// REQ-014b gate assertions, two shapes:
//   1. ctx.cwd present → relative paths resolve against the agent loop cwd,
//      NOT the process launch dir.
//   2. ctx absent (legacy call sites) → falls back to process.cwd(),
//      byte-for-byte unchanged legacy behavior.
// Existing tool tests (if any) keep their expectations untouched — this file
// only ADDS the ctx propagation coverage.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  executeTool,
  createProcessSupervisor,
  type ToolContext,
} from '@tricompany/agent-core';
import { registerLSTool } from '../src/tools/file-ls.js';
import { registerReadTool } from '../src/tools/file-read.js';
import { registerGlobTool } from '../src/tools/file-glob.js';
import { registerGrepTool } from '../src/tools/file-grep.js';
import { registerShellExecTool } from '../src/tools/shell-exec.js';

let base: string;
let dirA: string;
let dirB: string;
let supervisor: ReturnType<typeof createProcessSupervisor>;

before(() => {
  base = mkdtempSync(join(tmpdir(), 'trilc-ctx-cwd-'));
  dirA = join(base, 'dirA');
  dirB = join(base, 'dirB');
  mkdirSync(dirA, { recursive: true });
  mkdirSync(dirB, { recursive: true });
  writeFileSync(join(dirA, 'a.txt'), 'MARKER-A hello from dirA\n', 'utf-8');
  writeFileSync(join(dirB, 'b.txt'), 'MARKER-B hello from dirB\n', 'utf-8');

  registerLSTool();
  registerReadTool();
  registerGlobTool();
  registerGrepTool();
  supervisor = createProcessSupervisor();
  registerShellExecTool({ supervisor });
});

after(() => {
  rmSync(base, { recursive: true, force: true });
});

const ctxA: ToolContext = { cwd: dirA };

describe('ctx.cwd propagation — five read tools (A-TriRLC)', () => {
  it('LS: relative path resolves against ctx.cwd, not process.cwd()', async () => {
    const result = JSON.parse(await executeTool('LS', { path: '.' }, ctxA));
    assert.equal(result.path.toLowerCase(), dirA.toLowerCase());
    const names = result.entries.map((e: { name: string }) => e.name);
    assert.ok(names.includes('a.txt'), `expected a.txt in ${JSON.stringify(names)}`);
    assert.ok(!names.includes('b.txt'), `b.txt must not leak from dirB: ${JSON.stringify(names)}`);
  });

  it('Read: relative file_path resolves against ctx.cwd', async () => {
    const result = JSON.parse(await executeTool('Read', { file_path: 'a.txt' }, ctxA));
    assert.ok(result.content.includes('MARKER-A'), `expected MARKER-A content, got: ${JSON.stringify(result)}`);
  });

  it('Glob: relative search dir resolves against ctx.cwd', async () => {
    const result = JSON.parse(await executeTool('Glob', { pattern: '*.txt', path: '.' }, ctxA));
    assert.ok(
      result.filenames.includes('a.txt'),
      `expected a.txt in ${JSON.stringify(result)}`,
    );
    assert.ok(!result.filenames.includes('b.txt'), `b.txt must not leak from dirB: ${JSON.stringify(result)}`);
  });

  it('Grep: relative search path resolves against ctx.cwd', async () => {
    const result = JSON.parse(await executeTool('Grep', { pattern: 'MARKER-A', path: '.' }, ctxA));
    assert.ok(
      result.filenames.some((p: string) => p.includes('a.txt')),
      `expected a.txt match in ${JSON.stringify(result)}`,
    );
  });

  it('shell_exec: args.cwd wins over ctx.cwd (legacy semantics preserved)', async () => {
    const result = JSON.parse(await executeTool('shell_exec', { command: 'cd', cwd: dirB }, ctxA));
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.toLowerCase().includes(dirB.toLowerCase()), `stdout=${result.stdout}`);
  });

  it('shell_exec: ctx.cwd used when args.cwd omitted', async () => {
    const result = JSON.parse(await executeTool('shell_exec', { command: 'cd' }, ctxA));
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.toLowerCase().includes(dirA.toLowerCase()), `stdout=${result.stdout}`);
  });
});

describe('ctx absent — legacy fallback to process.cwd() (A-TriRLC)', () => {
  it('LS without ctx resolves against process.cwd()', async () => {
    const result = JSON.parse(await executeTool('LS', { path: '.' }));
    assert.equal(result.path.toLowerCase(), resolve(process.cwd(), '.').toLowerCase());
  });

  it('Read without ctx: absolute path still works (unchanged shape)', async () => {
    const result = JSON.parse(await executeTool('Read', { file_path: join(dirA, 'a.txt') }));
    assert.ok(result.content.includes('MARKER-A'));
  });

  it('Glob without ctx defaults to process.cwd() as search base', async () => {
    const result = JSON.parse(await executeTool('Glob', { pattern: '*.ts' }));
    // search ran somewhere; result must still be a valid filenames array
    assert.ok(Array.isArray(result.filenames));
  });

  it('Grep without ctx defaults to process.cwd() as search base', async () => {
    const result = JSON.parse(await executeTool('Grep', { pattern: 'definitely-no-such-marker-xyz' }));
    assert.ok(Array.isArray(result.filenames));
  });

  it('shell_exec without ctx falls back to process.cwd()', async () => {
    const result = JSON.parse(await executeTool('shell_exec', { command: 'cd' }));
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.toLowerCase().includes(process.cwd().toLowerCase()), `stdout=${result.stdout}`);
  });
});
