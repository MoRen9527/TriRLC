// ── N8 TUI 命令族自测门（形三 α · 设计卷 ec79feb7d §三·门①裁 c8544a1e7）──
// 案10 seats list 15 席谱稳定序 案11 send 命中三断言+pending true 案12 send
// 未知名零行落 案12b seats get 未知名+用法面（裁量注②顺手补）案13 零拨号
// （行留库+payload 三键结构+零 handler health 面）案14 seat-send 跨 reload
// （硬门①同族·保存→真重开→断言仍在）案15 status 视图冒烟（施工顺手补）。
// 裁量注③：at=数据字段固定注入（fixedNow）·与 D-47 落款时戳语义两分勿混。
// 形制照 v2-engine.test.ts（Engine.open + tmp 目录 + afterEach 停机先关再删）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { Engine } from '../src/v2/engine.js';
import { UserError } from '../src/v2/errors.js';
import { runCommand } from '../src/v2/tui.js';

const TEST_DIR = join(tmpdir(), `trirlc-test-v2-tui-${process.pid}-${Date.now()}`);
const FIXED_AT = '2026-11-06T00:00:00.000Z';
const fixedNow = (): string => FIXED_AT;

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

let engine: Engine | undefined;

beforeEach(cleanup);
afterEach(async () => {
  if (engine !== undefined) {
    await engine.stop(); // 幂等停机（close+release·先关再删——β-1 实锚教训）
    engine = undefined;
  }
  cleanup();
});

function open(): Engine {
  engine = Engine.open(TEST_DIR);
  return engine;
}

/** seat-send 原始行读面（结构断言用·payload JSON 直读）。 */
function seatSendRow(db: DatabaseSync, key: string): unknown {
  const r = db.prepare(`SELECT value FROM effect WHERE kind = 'seat-send' AND key = ?`).get(key) as
    { value: string } | undefined;
  return r === undefined ? undefined : JSON.parse(r.value);
}

describe('N8 TUI 命令族', () => {
  it('案10·seats list：15 席谱计数+首尾谱名+稳定序（ORDER BY name 现形）', () => {
    const e = open();
    const lines = runCommand(e, ['seats', 'list']).split('\n');
    assert.equal(lines[0], 'seats (15)', '15 席种子谱');
    const rows = lines.slice(1);
    assert.equal(rows.length, 15);
    assert.equal(rows[0], 'business-strategy\tm-bs\tidle\tdev', '首行（name 升序头）');
    assert.equal(rows.at(-1), 'senior-test-engineer\tm-ste\tidle\tdev', '末行（name 升序尾）');
    assert.ok(rows.includes('full-stack-developer\tm-fsd\tidle\tdev'), '本席四字段行');
    const names = rows.map((r) => r.split('\t')[0]);
    assert.deepEqual(names, [...names].sort(), '稳定序=name 升序全谱');
  });

  it('案11·send 命中：seat-send 行落库 kind/key/payload 三断言+pending true（at=固定注入）', () => {
    const e = open();
    const out = runCommand(e, ['send', 'chief-technology-officer', '设计卷', '已收到'], fixedNow);
    assert.equal(out, 'queued seat-send → chief-technology-officer (m-cto)');
    assert.equal(e.effects.pending('seat-send', 'chief-technology-officer'), true, '行落库 pending');
    assert.deepEqual(
      seatSendRow(e.store.db, 'chief-technology-officer'),
      { address: 'm-cto', text: '设计卷 已收到', at: FIXED_AT },
      'payload={address,text,at}·key=name·at=数据字段（裁量注③）',
    );
  });

  it('案12·send 未知名：UserError 错误输出+零行落（pending false）', () => {
    const e = open();
    assert.throws(
      () => runCommand(e, ['send', 'no-such-seat', 'hi'], fixedNow),
      (error: unknown) => error instanceof UserError && /unknown seat: no-such-seat/.test(error.message),
    );
    assert.equal(e.effects.pending('seat-send'), false, '零行落');
    const count = e.store.db.prepare(`SELECT COUNT(*) AS n FROM effect WHERE kind = 'seat-send'`).get() as { n: number };
    assert.equal(count.n, 0, 'effect 表零 seat-send 行');
  });

  it('案12b·seats get 未知名+用法面（裁量注②顺手补）', () => {
    const e = open();
    assert.throws(
      () => runCommand(e, ['seats', 'get', 'no-such-seat']),
      (error: unknown) => error instanceof UserError && /unknown seat: no-such-seat/.test(error.message),
    );
    assert.equal(runCommand(e, ['seats', 'get', 'chief-technology-officer']), 'chief-technology-officer\tm-cto\tidle\tdev');
    assert.throws(() => runCommand(e, ['seats', 'get']), /usage: seats get <name>/);
    assert.throws(() => runCommand(e, ['send']), /usage: send <name> <text...>/);
    assert.throws(() => runCommand(e, ['send', 'chief-technology-officer']), /send: text is required/);
    assert.throws(() => runCommand(e, ['bogus']), /unknown command: bogus/);
  });

  it('案13·零拨号：dispatch 循环过行不动+payload 恰三键+零 handler health 面（结构断言）', async () => {
    const e = open();
    runCommand(e, ['send', 'full-stack-developer', 'hello 零拨号'], fixedNow);
    for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); // dispatch 循环沉降
    assert.equal(e.effects.pending('seat-send', 'full-stack-developer'), true, '真消费 handler 嫁接域未注册=行留库候消费（裁⑤）');
    assert.deepEqual(
      seatSendRow(e.store.db, 'full-stack-developer'),
      { address: 'm-fsd', text: 'hello 零拨号', at: FIXED_AT },
      'payload 恰三键·无连接面字段',
    );
    assert.equal('seat-send' in e.effects.snapshot(), false, '零 handler→零 health 面（无退避/死信路径·零拨号结构）');
  });

  it('案14·seat-send 跨 reload 持久（硬门①同族）：send→真重开→行 pending 仍在', async () => {
    const e1 = open();
    runCommand(e1, ['send', 'senior-test-engineer', 'reload persistence probe'], fixedNow);
    await e1.stop();
    engine = undefined;
    const e2 = Engine.open(TEST_DIR); // 真重开同库 boot 链（第四型盲区正形）
    engine = e2;
    assert.equal(e2.effects.pending('seat-send', 'senior-test-engineer'), true, '跨 reload 行仍在');
    assert.deepEqual(
      seatSendRow(e2.store.db, 'senior-test-engineer'),
      { address: 'm-ste', text: 'reload persistence probe', at: FIXED_AT },
      'payload 原样持久',
    );
    assert.equal(e2.seats.list().length, 15, '种子幂等重开零冲（INSERT OR IGNORE）');
  });

  it('案15·status 视图冒烟（施工顺手补）：初态两行→send 后 pending 翻 true', () => {
    const e = open();
    assert.deepEqual(runCommand(e, ['status']).split('\n'), ['passes\tno pass yet', 'pending seat-send\tfalse']);
    runCommand(e, ['send', 'chief-technology-officer', 'status probe'], fixedNow);
    assert.equal(runCommand(e, ['status']), 'passes\tno pass yet\npending seat-send\ttrue');
  });
});
