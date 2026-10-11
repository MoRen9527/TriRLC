import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCrashHandlers, makeCrashLogLine } from '../src/crash-handler.js';

function tempLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'crash-handler-test-'));
}

function lastLogLine(dir: string): Record<string, unknown> {
  const raw = readFileSync(join(dir, 'crash.log'), 'utf-8').trim().split('\n');
  return JSON.parse(raw[raw.length - 1]) as Record<string, unknown>;
}

test('makeCrashLogLine: Error 带 message+stack+ISO ts', () => {
  const line = makeCrashLogLine('uncaughtException', new Error('boom'));
  assert.equal(line.kind, 'uncaughtException');
  assert.equal(line.message, 'boom');
  assert.match(line.stack ?? '', /Error: boom/);
  assert.ok(!Number.isNaN(Date.parse(line.ts)));
});

test('makeCrashLogLine: 非 Error 值走 String 化·stack null', () => {
  const line = makeCrashLogLine('unhandledRejection', 'plain reason');
  assert.equal(line.kind, 'unhandledRejection');
  assert.equal(line.message, 'plain reason');
  assert.equal(line.stack, null);
});

test('installCrashHandlers.handle: 落行+onExit(1)·JSON 行可解析', () => {
  const dir = tempLogDir();
  const exits: number[] = [];
  const { handle } = installCrashHandlers({ logDir: dir, logOnly: false, onExit: (c) => exits.push(c) });
  handle('uncaughtException', new Error('test-crash-line'));
  assert.deepEqual(exits, [1]);
  const last = lastLogLine(dir);
  assert.equal(last.kind, 'uncaughtException');
  assert.equal(last.message, 'test-crash-line');
  assert.equal(typeof last.ts, 'string');
  rmSync(dir, { recursive: true, force: true });
});

test('installCrashHandlers.handle: unhandledRejection 同构落行', () => {
  const dir = tempLogDir();
  const { handle } = installCrashHandlers({ logDir: dir, logOnly: false, onExit: () => {} });
  handle('unhandledRejection', 'string rejection');
  const last = lastLogLine(dir);
  assert.equal(last.kind, 'unhandledRejection');
  assert.equal(last.message, 'string rejection');
  assert.equal(last.stack, null);
  rmSync(dir, { recursive: true, force: true });
});

test('installCrashHandlers: logOnly=true 不触发 onExit·日志仍落', () => {
  const dir = tempLogDir();
  let exited = false;
  const { handle } = installCrashHandlers({ logDir: dir, logOnly: true, onExit: () => { exited = true; } });
  handle('uncaughtException', new Error('log-only-case'));
  assert.equal(exited, false);
  assert.equal(lastLogLine(dir).message, 'log-only-case');
  rmSync(dir, { recursive: true, force: true });
});

test('installCrashHandlers: 默认 logOnly 读 TRILC_CRASH_LOG_ONLY=1 env', () => {
  const dir = tempLogDir();
  process.env.TRILC_CRASH_LOG_ONLY = '1';
  let exited = false;
  const { handle } = installCrashHandlers({ logDir: dir, onExit: () => { exited = true; } });
  handle('uncaughtException', new Error('env-gated'));
  assert.equal(exited, false);
  delete process.env.TRILC_CRASH_LOG_ONLY;
  rmSync(dir, { recursive: true, force: true });
});

test('installCrashHandlers: handler 注册在 process 面（listenerCount 双 1 起）', () => {
  const dir = tempLogDir();
  const beforeU = process.listenerCount('uncaughtException');
  const beforeR = process.listenerCount('unhandledRejection');
  installCrashHandlers({ logDir: dir, logOnly: true });
  assert.equal(process.listenerCount('uncaughtException'), beforeU + 1);
  assert.equal(process.listenerCount('unhandledRejection'), beforeR + 1);
  rmSync(dir, { recursive: true, force: true });
});
