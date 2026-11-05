// ── β-2 Effects 持久退避队列自测（形三 α+β · CTO 准动令四要素+裁定③死信出口）──
// 验收门①失败重试序列对拍（可控时钟注入·due 序列=2s/4s/8s/…/256s/封顶 300s）
// ②去重 coalesce 断言（generation+1·attempts/stalled 复位）③进程重启后队列仍在
// （tmp 文件库 close→新实例→行在+seq 续号 MAX 对齐）+死信出口全案（裁定③：
// dead-letter 态+health 可见+零自动丢弃+requeue 复位+discard 显式丢弃）。
// 形制照 v2-receipts.test.ts（node:test + node:sqlite tmp 文件·fresh-per-case
// 先 close 再 unlink——Windows 库复用污染教训正形）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effects, Later } from '../src/v2/effects.js';

const TEST_DB = join(tmpdir(), `trirlc-test-v2-effects-${process.pid}-${Date.now()}.db`);

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
}

// 可控时钟：T0 固定原点·advance 精确推进（退避序列断言零真等 2s/4s）
const T0 = 1_000_000;
function makeClock() {
  let t = T0;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

let db: DatabaseSync;
let effects: Effects;
const clock = makeClock();

beforeEach(() => {
  cleanup();
  db = new DatabaseSync(TEST_DB);
  effects = new Effects(db, clock.now);
});
afterEach(() => {
  db.close(); // 先关连接再 unlink（β-1 首轮实锚教训）
  cleanup();
});

function readRow(kind: string, key: string): { attempts: number; stalled: number; due: number; generation: number; error: string } {
  const row = db.prepare('SELECT attempts, stalled, due, generation, error FROM effect WHERE kind = ? AND key = ?')
    .get(kind, key) as { attempts: number; stalled: number; due: number; generation: number; error: string } | undefined;
  assert.ok(row, `effect row ${kind}/${key} 应存在`);
  return row!;
}

const tick = () => new Promise<void>((r) => setImmediate(r));
// 精确单轮推进：kick 起一轮 attempt·settle 等 microtask 链全清（idle 系「追平所有 due≤now」
// 语义——退避序列逐轮断言面改用 kick+settle 精确单轮·不靠追平巧合）
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

describe('β-2 effects 持久退避队列', () => {
  it('成功删行：run 通过→DELETE WHERE seq+generation·health ready', async () => {
    effects.handle('ok', async () => { /* pass */ });
    effects.enqueue('ok', 'ok-1', { v: 1 });
    effects.start();
    await effects.idle('ok');
    assert.equal(effects.pending('ok', 'ok-1'), false);
    assert.equal(effects.snapshot()['ok']?.state, 'ready');
  });

  it('Later 免计数：重排 initial delay·attempts/stalled 不增', async () => {
    effects.handle('lt', async () => { throw new Later('not now'); });
    effects.enqueue('lt', 'lt-1', {});
    effects.start();
    await effects.idle('lt');
    const row = readRow('lt', 'lt-1');
    assert.equal(row.attempts, 0);
    assert.equal(row.stalled, 0);
    assert.equal(row.due, T0 + 2000); // initial=2000·零计数
    assert.equal(effects.snapshot()['lt']?.state, 'ready');
  });

  it('验收门①·失败重试序列对拍：due 序列 2s/4s/8s/…/256s/封顶 300s（退避 A 形）', async () => {
    effects.handle('bk', async () => { throw new Error('boom'); });
    effects.enqueue('bk', 'bk-1', {});
    effects.start();
    await settle(); // 第 1 败
    // 第 n 败 delay = min(300000, 2000 * 2^(n-1))（照原型用旧 attempts 值）
    const expected = [2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000];
    let due = T0;
    for (let i = 0; i < expected.length; i++) {
      due += expected[i];
      const row = readRow('bk', 'bk-1');
      assert.equal(row.attempts, i + 1, `第 ${i + 1} 败 attempts`);
      assert.equal(row.due, due, `第 ${i + 1} 败 due`);
      assert.equal(row.stalled, i >= 8 ? 1 : 0, `第 ${i + 1} 败 stalled（封顶起追踪）`);
      assert.ok(row.error.includes('boom'));
      clock.advance(expected[i]); // 推到该败 due 时点→触发下一败
      effects.kick();
      await settle();
    }
  });

  it('验收门②·去重 coalesce：同 kind+key 单行·重排 generation+1·attempts/stalled 复位', () => {
    effects.handle('co', async () => { /* pass */ });
    effects.enqueue('co', 'c1', { v: 1 });
    effects.enqueue('co', 'c1', { v: 2 }); // coalesce：同 key 覆盖不新增
    const count = db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind = 'co' AND key = 'c1'").get() as { n: number | bigint };
    assert.equal(Number(count.n), 1);
    // 污染 attempts/stalled/generation 后重排→复位面
    db.prepare("UPDATE effect SET attempts = 5, stalled = 2, generation = 7 WHERE kind = 'co' AND key = 'c1'").run();
    effects.enqueue('co', 'c1', { v: 3 });
    const row = readRow('co', 'c1');
    assert.equal(row.generation, 8); // +1 防运行中覆盖
    assert.equal(row.attempts, 0);
    assert.equal(row.stalled, 0);
    assert.equal(readRow('co', 'c1').error, '');
  });

  it('FAILURES_BEFORE_ERROR=3：3 连败 health error·成功后恢复 ready', async () => {
    let shouldFail = true;
    effects.handle('he', async () => { if (shouldFail) throw new Error('boom'); });
    effects.enqueue('he', 'he-1', {});
    effects.start(); await settle(); // 败 1
    clock.advance(2000); effects.kick(); await settle(); // 败 2
    assert.equal(effects.snapshot()['he']?.state, 'ready'); // 未达阈
    clock.advance(4000); effects.kick(); await settle(); // 败 3 → error
    assert.equal(effects.snapshot()['he']?.state, 'error');
    assert.ok(effects.snapshot()['he']?.detail.includes('boom'));
    // 成功恢复
    shouldFail = false;
    clock.advance(300_000); effects.kick(); await settle();
    assert.equal(effects.pending('he', 'he-1'), false);
    assert.equal(effects.snapshot()['he']?.state, 'ready');
  });

  it('quiet 豁免：3 连败不上 health error 面', async () => {
    effects.handle('qt', async () => { throw new Error('boom'); }, { quiet: true });
    effects.enqueue('qt', 'qt-1', {});
    effects.start(); await settle(); // 败 1
    for (const d of [2000, 4000]) { clock.advance(d); effects.kick(); await settle(); } // 败 2/3
    assert.equal(readRow('qt', 'qt-1').attempts, 3);
    assert.equal(effects.snapshot()['qt']?.state, 'ready'); // quiet 零 error
  });

  it('裁定③·死信出口全案：dead-letter 可见+零自动丢弃+requeue 复位+discard 显式丢弃', async () => {
    effects.handle('dl', async () => { throw new Error('boom'); });
    effects.enqueue('dl', 'dl-1', {});
    effects.start(); await settle(); // 败 1
    for (let i = 0; i < 15; i++) { clock.advance(300_000); effects.kick(); await settle(); } // 共 16 败
    const row = readRow('dl', 'dl-1');
    assert.equal(row.attempts, 16);
    assert.ok(row.stalled >= 3, `封顶连败 stalled=${row.stalled}`);
    // health 可见（dead-letter 态·非普通 error 面）
    assert.equal(effects.snapshot()['dl']?.state, 'dead-letter');
    assert.ok(effects.snapshot()['dl']?.detail.includes('manual disposition'));
    // 死信列举
    assert.equal(effects.deadLetters().length, 1);
    assert.equal(effects.deadLetters('dl').length, 1);
    assert.equal(effects.deadLetters('other').length, 0);
    // 零自动丢弃：死信行不再 dispatch（attempts 不增·行留库）
    for (let i = 0; i < 3; i++) { clock.advance(300_000); effects.kick(); await settle(); }
    assert.equal(readRow('dl', 'dl-1').attempts, 16);
    assert.equal(effects.deadLetters().length, 1);
    // 人工处置 requeue：复位复活（attempts=0·due=now·重试实证）
    assert.equal(effects.requeue('dl', 'dl-1'), true);
    const rq = readRow('dl', 'dl-1');
    assert.equal(rq.attempts, 0);
    assert.equal(rq.stalled, 0);
    clock.advance(300_000); effects.kick(); await settle();
    assert.equal(readRow('dl', 'dl-1').attempts, 1); // 行复活重试
    // 推回死信→discard 显式丢弃（唯一删死信行通道）
    for (let i = 0; i < 15; i++) { clock.advance(300_000); effects.kick(); await settle(); }
    assert.equal(readRow('dl', 'dl-1').attempts, 16);
    assert.equal(effects.discard('dl', 'dl-1'), true);
    assert.equal(effects.pending('dl', 'dl-1'), false);
    assert.equal(effects.deadLetters().length, 0);
    // 非死信行 requeue/discard 拒（pending-only 同族语义）
    effects.enqueue('dl', 'dl-2', {});
    assert.equal(effects.requeue('dl', 'dl-2'), false);
    assert.equal(effects.discard('dl', 'dl-2'), false);
    effects.cancel('dl', 'dl-2'); // 清场
  });

  it('验收门③·进程重启后队列仍在：close→重开同库→行在+seq 续号 MAX 对齐', async () => {
    effects.enqueue('rs', 'r1', { v: 1 });
    db.close(); // 模拟进程重启（同库文件重开·零 cleanup——r1 须在）
    db = new DatabaseSync(TEST_DB);
    const revived = new Effects(db, clock.now);
    assert.equal(revived.pending('rs', 'r1'), true); // 行在（SQLite 持久）
    revived.handle('rs', async () => { /* pass */ });
    revived.start();
    await revived.idle('rs');
    assert.equal(revived.pending('rs', 'r1'), false);
    // seq 续号：新实例 MAX(seq) 对齐（r1 seq=1→r2 seq=2 零重号）
    revived.enqueue('rs', 'r2', { v: 2 });
    const row = db.prepare("SELECT seq FROM effect WHERE kind = 'rs' AND key = 'r2'").get() as { seq: number | bigint };
    assert.equal(Number(row.seq), 2);
    effects = revived; // afterEach 关新连接
  });

  it('limit 单飞：limit()=1 时一轮只起一行·余行等下轮', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    effects.handle('sl', async (p) => { calls.push((p as { k: string }).k); await gate; }, { limit: () => 1 });
    effects.enqueue('sl', 'a', { k: 'a' });
    effects.enqueue('sl', 'b', { k: 'b' });
    effects.start();
    await tick(); // 第一轮 dispatch
    assert.deepEqual(calls, ['a']); // b 未起（room=0）
    release();
    await effects.idle('sl');
    assert.deepEqual(calls, ['a', 'b']);
  });

  it('ordered 串行：同 kind 按 seq 逐行·失败阻塞后行', async () => {
    const calls: string[] = [];
    effects.handle('or', async (p) => { calls.push((p as { k: string }).k); }, { ordered: true });
    effects.enqueue('or', 'o1', { k: 'o1' });
    effects.enqueue('or', 'o2', { k: 'o2' });
    effects.enqueue('or', 'o3', { k: 'o3' });
    effects.start();
    await effects.idle('or');
    assert.deepEqual(calls, ['o1', 'o2', 'o3']); // seq 序串行
    assert.equal(effects.pending('or'), false);
  });

  it('start 前入队等待·drain 停新起（等待行留库下次 start）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    effects.handle('lc', async () => { await gate; });
    effects.enqueue('lc', 'g1', {});
    await tick(); // 未 start→零 dispatch
    assert.equal(effects.pending('lc', 'g1'), true);
    effects.start();
    await tick(); // g1 运行中（挂 gate）
    const draining = effects.drain(); // 等运行中完成
    release();
    await draining;
    assert.equal(effects.pending('lc', 'g1'), false); // g1 完成删行
    // drain 后停新起：enqueue 行留库零 dispatch（下次 start 语义）
    effects.enqueue('lc', 'g2', {});
    await tick();
    assert.equal(effects.pending('lc', 'g2'), true);
  });
});
