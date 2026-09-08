// ── LG-033 7294s 三缺根治件：connection-state.json 持久化链单测 ──
// 覆盖：启动确认行实证 / 写失败注入显式化（catch 吞形态根治）/ 正常落档内容面。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function captureConsole<T>(fn: () => T | Promise<T>): Promise<{ logs: string[]; errors: string[]; result: T }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => errors.push(a.map(String).join(' '));
  try {
    const result = await fn();
    return { logs, errors, result };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

async function buildApp(dataDir: string) {
  process.env.TRILC_DATA_DIR = dataDir;
  process.env.TRILC_PORT = '0';
  process.env.TRILC_PROJECT_ROOT = dataDir;
  const { createTriLCApp } = await import('../../src/server/app.js');
  const { readEnv } = await import('../../src/config/env.js');
  const env = readEnv();
  env.port = 0;
  env.trimodelApiUrl = 'http://127.0.0.1:1';
  return createTriLCApp(env);
}

describe('LG-033 connection-state.json 持久化链', () => {
  test('启动确认行+正常落档：dataDir tmp→文件在盘含 state 字段+log 确认行', async () => {
    const td = mkdtempSync(join(tmpdir(), 'trilc-persist-ok-'));
    let app: ReturnType<typeof buildApp> extends Promise<infer A> ? A : never;
    try {
      const { logs, result } = await captureConsole(async () => buildApp(td));
      app = result;
      const stateFile = join(td, 'connection-state.json');
      assert.equal(existsSync(stateFile), true, 'connection-state.json 应落盘');
      const parsed = JSON.parse(readFileSync(stateFile, 'utf-8'));
      assert.ok('state' in parsed, '落档应含 state 字段');
      assert.ok('lastStateChange' in parsed, '落档应含 lastStateChange');
      assert.ok(
        logs.some((l) => l.includes('state persistence enabled') && l.includes('connection-state.json')),
        `启动确认行缺失: ${JSON.stringify(logs)}`,
      );
    } finally {
      try { await app.stop(); } catch { /* ok */ }
      try { rmSync(td, { recursive: true, force: true }); } catch { /* EBUSY 宽忍 */ }
    }
  });

  test('写失败注入显式化：connection-state.json 位为目录→WRITE FAILED 显式 error+不静默', async () => {
    const td = mkdtempSync(join(tmpdir(), 'trilc-persist-fail-'));
    let app: ReturnType<typeof buildApp> extends Promise<infer A> ? A : never;
    try {
      // 注入形态：stateFile 位预置为「目录」——writeFileSync → EISDIR 写失败
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(td, 'connection-state.json'), { recursive: true });
      const { errors, result } = await captureConsole(async () => buildApp(td));
      app = result;
      assert.ok(
        errors.some((e) => e.includes('state persistence') && (e.includes('WRITE FAILED') || e.includes('write failed'))),
        `写失败显式行缺失: ${JSON.stringify(errors)}`,
      );
    } finally {
      try { await app.stop(); } catch { /* ok */ }
      try { rmSync(td, { recursive: true, force: true }); } catch { /* EBUSY 宽忍 */ }
    }
  });
});
