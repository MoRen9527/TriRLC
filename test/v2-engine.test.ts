// ── N1+N2/N3 自测门九案（形三 α · 门①裁定 §四：八案+补一案）──
// ①活锁第二实例立即拒（API 形+子进程非零 exit 真闭环）②stale 夺位
// ③atomic 嵌套全回滚+committed 分层（外层提交才跑/回滚丢弃/错误不败事务）
// ④schema 版本门 ⑤release 闭包守卫（裁定①补案：非本实例的锁零副作用）
// ⑥deliverAndTrack 挂接三态（sent mark/dropped 零 mark/Later 零 mark）
// ⑦停机序（closing 拒新→drain 等运行中→锁最后放）⑧多 Promise 交错零乱序。
// β 三套零改动复跑 27/27=独立命令（receipts 9+effects 11+read-tracker 7）。
// 形制照 v2-receipts.test.ts（node:test + tmp 目录·fresh-per-case 先停机再删）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Engine, LockHeldError } from '../src/v2/engine.js';
import { acquireDirectoryLock } from '../src/v2/lock.js';
import { V2Store } from '../src/v2/store.js';
import { Later } from '../src/v2/effects.js';
import { isProcessAlive } from '../src/pidfile.js';

const TEST_DIR = join(tmpdir(), `trirlc-test-v2-engine-${process.pid}-${Date.now()}`);
const ENGINE_URL = pathToFileURL(fileURLToPath(new URL('../src/v2/engine.ts', import.meta.url))).href;
const lockPath = join(TEST_DIR, 'v2.lock');

let engine: Engine | undefined;

/** microtask/事件环链清空（β-2 教训：精确等待·不靠 idle 追平巧合）。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** 造一个已死进程的真 pid（spawn 立即退出+轮询确认死——零侥幸 pid）。 */
function makeDeadPid(): number {
  const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 10_000 });
  assert.equal(result.status, 0);
  const pid = result.pid as number;
  for (let i = 0; i < 50 && isProcessAlive(pid); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); // 同步睡 100ms
  }
  assert.equal(isProcessAlive(pid), false, 'failed to observe the spawned pid dying');
  return pid;
}

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

beforeEach(() => {
  cleanup();
});
afterEach(async () => {
  if (engine !== undefined) {
    await engine.stop(); // 幂等停机（close+release·先关再删——β-1 首轮实锚教训）
    engine = undefined;
  }
  cleanup();
});

/** 最小 sent transport（to 唯一防 behind 同目标乱序防护误触）。 */
function sentTransport(): { send: () => Promise<'sent'> } {
  return { async send() { return 'sent' as const; } };
}

function send(engine_: Engine, id: string): void {
  engine_.receipts.send({ id, from: 'a', to: `target-${id}`, text: 'x' });
}

describe('N1 lock 目录锁', () => {
  it('裁定②自测门·活锁持有者：第二实例 LockHeldError 立即拒·错误指向持有者 pid', async () => {
    engine = Engine.open(TEST_DIR);
    // 同进程第二实例（API 形）：立即抛·pid 指向持有者
    assert.throws(() => Engine.open(TEST_DIR), (error: unknown) =>
      error instanceof LockHeldError && error.pid === process.pid);
    // 锁文件仍在（第一实例持有未动）
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf-8') as string).pid, process.pid);
    // 子进程形（裁定「立即退出非零 exit」真闭环）：独立进程 open 同目录→exit 1+错误指向本 pid
    const runner = `
      try {
        const { Engine } = await import(${JSON.stringify(ENGINE_URL)});
        Engine.open(${JSON.stringify(TEST_DIR)});
        console.log('UNEXPECTED_SUCCESS');
        process.exit(0);
      } catch (error) {
        console.error(String(error instanceof Error ? error.message : error));
        process.exit(1);
      }
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', runner],
      { timeout: 30_000, cwd: join(fileURLToPath(new URL('..', import.meta.url))) });
    assert.equal(result.status, 1, `expected non-zero exit, stderr=${String(result.stderr)}`);
    assert.match(String(result.stderr), new RegExp(`pid ${process.pid}`));
  });

  it('stale 锁（持有者 pid 死）→安全夺位·锁内容换本进程', () => {
    const dead = makeDeadPid();
    mkdirSync(TEST_DIR, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: dead, at: 'stale' }));
    engine = Engine.open(TEST_DIR); // 夺位成功不抛
    assert.equal(engine.receipts.get('probe'), undefined); // 库可用
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf-8') as string).pid, process.pid);
  });

  it('裁定①补案·release 闭包守卫：非本实例的锁零副作用·本实例的锁正常删', () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const lock = acquireDirectoryLock(TEST_DIR);
    // 分支一：锁内容被外部覆写为他者 pid（stale 夺位后旧闭包的模拟面）→release 零副作用
    const foreign = makeDeadPid();
    writeFileSync(lockPath, JSON.stringify({ pid: foreign, at: 'foreign' }));
    lock.release();
    assert.equal(existsSync(lockPath), true, 'foreign-pid lock must survive a stale release()');
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf-8') as string).pid, foreign);
    // 分支二：恢复本实例内容→release 正常删
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: 'self' }));
    lock.release();
    assert.equal(existsSync(lockPath), false);
  });
});

describe('N1 store V2Store', () => {
  it('atomic 嵌套：内层抛→全回滚零残留（异常冒泡穿外层）', () => {
    const store = new V2Store(TEST_DIR);
    store.db.exec('CREATE TABLE t (v INTEGER)');
    assert.throws(() => store.atomic(() => {
      store.db.prepare('INSERT INTO t VALUES (1)').run();
      store.atomic(() => {
        store.db.prepare('INSERT INTO t VALUES (2)').run();
        throw new Error('inner boom');
      });
    }), /inner boom/);
    const count = store.db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number | bigint };
    assert.equal(Number(count.c), 0); // 两层全回滚零残留
    store.close();
  });

  it('committed 分层：外层提交才跑（内层注册不早跑·依注册序）·回滚丢弃·错误不败事务', () => {
    const store = new V2Store(TEST_DIR);
    store.db.exec('CREATE TABLE t (v INTEGER)');
    // 外层提交才跑：内层 RELEASE 后未跑·外层 RELEASE 后依注册序跑
    const order: string[] = [];
    store.atomic(() => {
      store.onCommitted(() => order.push('inner-cb'));
      store.atomic(() => { /* 内层剥栈（无操作） */ });
      order.push('after-inner-release');
      assert.deepEqual(order, ['after-inner-release']); // 内层 RELEASE 未触发回调
      store.onCommitted(() => order.push('outer-cb'));
    });
    assert.deepEqual(order, ['after-inner-release', 'inner-cb', 'outer-cb']);
    // 外层真提交：数据落库
    assert.equal((store.db.prepare('SELECT COUNT(*) AS c FROM t').get() as { c: number }).c !== undefined, true);
    // 回滚丢弃：抛错事务的 committed 回调清空
    const ran: string[] = [];
    assert.throws(() => store.atomic(() => {
      store.onCommitted(() => ran.push('x'));
      throw new Error('boom');
    }), /boom/);
    assert.deepEqual(ran, []);
    // 回调错误 report 不败事务：atomic 正常返回·库仍可用
    let callbackRan = false;
    const value = store.atomic(() => {
      store.onCommitted(() => { callbackRan = true; throw new Error('cb boom'); });
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(callbackRan, true);
    store.db.prepare('INSERT INTO t VALUES (7)').run(); // 库仍可用
    store.close();
  });

  it('schema 版本门：范围外拒开·新库自动标版本·版本一致正常开', () => {
    engine = Engine.open(TEST_DIR); // 新库→user_version 写 1
    void engine.stop();
    engine = undefined;
    const db = new DatabaseSync(join(TEST_DIR, 'v2.db'));
    db.exec('PRAGMA user_version = 99');
    db.close();
    assert.throws(() => new V2Store(TEST_DIR), /version mismatch/);
    const dbFix = new DatabaseSync(join(TEST_DIR, 'v2.db'));
    dbFix.exec('PRAGMA user_version = 1');
    dbFix.close();
    const ok = new V2Store(TEST_DIR); // 版本 1 精确匹配→正常开
    ok.close();
  });
});

describe('N2/N3 Engine 并入挂接', () => {
  it('deliverAndTrack：sent→delivered·dropped 零 mark·Later 冒泡零 mark', async () => {
    engine = Engine.open(TEST_DIR);
    // sent→markDelivered
    send(engine, 'm-1');
    await engine.deliverAndTrack('m-1', sentTransport());
    assert.equal(engine.receipts.get('m-1')?.status, 'sent');
    assert.equal(engine.readTracker.stateOf('m-1'), 'delivered');
    // dropped（gone→targetGone）零 mark
    send(engine, 'm-2');
    await engine.deliverAndTrack('m-2', { async send() { return 'gone' as const; } });
    assert.equal(engine.receipts.get('m-2')?.status, 'dropped');
    assert.equal(engine.readTracker.stateOf('m-2'), undefined); // 零 mark 断言（裁定采认入表）
    // Later（waiting）冒泡零 mark（未送达不标已读）
    send(engine, 'm-3');
    await assert.rejects(() => engine!.deliverAndTrack('m-3', { async send() { throw new Later('not ready'); } }),
      /not ready/);
    assert.equal(engine.readTracker.stateOf('m-3'), undefined);
  });

  it('停机序：closing 拒新→drain 等运行中（锁仍在）→stop 毕锁已放', async () => {
    engine = Engine.open(TEST_DIR);
    let releaseSend!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSend = resolve; });
    engine.receipts.send({ id: 'm-slow', from: 'a', to: 'target-slow', text: 'x' });
    engine.effects.handle('reply', async () => { await gate; });
    engine.effects.kick(); // dispatch m-slow→handler 挂 gate
    await settle(); // 等任务真起
    assert.equal(existsSync(lockPath), true);
    const stopping = engine.stop(); // 不 await——观察停机中途
    await settle();
    assert.equal(existsSync(lockPath), true, 'drain 中锁仍在（锁最后放）');
    try {
      await assert.rejects(() => engine!.deliverAndTrack('m-x', sentTransport()), /closing/); // async 拒面（throws 捕不到）
    } finally {
      releaseSend(); // 案败也放行 gate——drain 收敛·afterEach 走到 close+release（防挂死污染 cleanup）
      await stopping;
    }
    assert.equal(existsSync(lockPath), false, 'stop 毕锁已放');
    assert.throws(() => engine.receipts.get('m-slow')); // 库已关（同步抛=close 面可同步断言）
    await engine.stop(); // 幂等重入零副作用
  });

  it('单进程多 Promise 交错 deliver→迁移零乱序（事件环交错非并行·语义注⑤）', async () => {
    engine = Engine.open(TEST_DIR);
    const sendOrder: string[] = [];
    const transport = {
      async send(receipt: { id: string }) {
        await new Promise((resolve) => setTimeout(resolve, receipt.id === 'm-1' ? 20 : 5)); // m-2 先完成=交错
        sendOrder.push(receipt.id);
        return 'sent' as const;
      },
    };
    for (const id of ['m-1', 'm-2', 'm-3']) send(engine!, id);
    // markDelivered 时点记录（白盒 patch——交错完成序实证）
    const marks: string[] = [];
    const tracker = engine.readTracker as unknown as { markDelivered: (id: string) => boolean };
    const original = tracker.markDelivered.bind(engine.readTracker);
    tracker.markDelivered = (id: string) => { marks.push(id); return original(id); };
    await Promise.all([
      engine.deliverAndTrack('m-1', transport),
      engine.deliverAndTrack('m-2', transport),
      engine.deliverAndTrack('m-3', transport),
    ]);
    assert.deepEqual([...sendOrder].sort(), ['m-1', 'm-2', 'm-3']);
    assert.notEqual(sendOrder[0], 'm-1', 'expected interleaved completion (m-2/m-3 before m-1)');
    // 零乱序：各 id 状态独立正确·markDelivered 每行恰一次（零串行错位）
    assert.deepEqual([...marks].sort(), ['m-1', 'm-2', 'm-3']);
    assert.equal(new Set(marks).size, marks.length);
    for (const id of ['m-1', 'm-2', 'm-3']) assert.equal(engine.readTracker.stateOf(id), 'delivered');
    // 票末收敛 API 位（裁定④）：批量 settle 照常推进
    engine.settleTicket(['m-1', 'm-2', 'm-3']);
    for (const id of ['m-1', 'm-2', 'm-3']) assert.equal(engine.readTracker.stateOf(id), 'settled');
  });
});
