// ── β-3 三段已读自测（形三 α+β · CTO β-3 准动令验收门三面）──
// 验收门①跨 reload 持久断言（第四型盲区正身：写→close→真重开同库 boot 链→
// 断言仍在→reload 后收敛段照常——非进程内复刻）②三段迁移案（delivery→read→
// settled 逐段+delivered→settled 票末收敛支）③非法迁移拒（跳段/倒退/settled
// 终态锁·零写面）+同段幂等+多消息隔离。
// 形制照 v2-receipts.test.ts（node:test + node:sqlite tmp 文件·fresh-per-case
// 先 close 再 unlink）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadTracker } from '../src/v2/read-tracker.js';

const TEST_DB = join(tmpdir(), `trirlc-test-v2-read-tracker-${process.pid}-${Date.now()}.db`);

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-wal'); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + '-shm'); } catch { /* ok */ }
}

let db: DatabaseSync;
let tracker: ReadTracker;

beforeEach(() => {
  cleanup();
  db = new DatabaseSync(TEST_DB);
  tracker = new ReadTracker(db);
});
afterEach(() => {
  db.close(); // 先关连接再 unlink（β-1 首轮实锚教训）
  cleanup();
});

describe('β-3 read-tracker 三段已读', () => {
  it('验收门②·三段线性迁移：delivered→read→settled 逐段', () => {
    assert.equal(tracker.stateOf('m-1'), undefined);
    assert.equal(tracker.markDelivered('m-1'), true);
    assert.equal(tracker.stateOf('m-1'), 'delivered');
    assert.equal(tracker.ack('m-1'), true);
    assert.equal(tracker.stateOf('m-1'), 'read');
    assert.equal(tracker.settle('m-1'), true);
    assert.equal(tracker.stateOf('m-1'), 'settled');
  });

  it('票末收敛支：delivered→settled 合法（未读票末不再等）', () => {
    tracker.markDelivered('m-2');
    assert.equal(tracker.settle('m-2'), true); // read 未发生·票末收敛支
    assert.equal(tracker.stateOf('m-2'), 'settled');
  });

  it('验收门③·跳段拒：none→read / none→settled 拒（零写面）', () => {
    assert.equal(tracker.ack('m-3'), false); // 未 delivered 先 ack
    assert.equal(tracker.stateOf('m-3'), undefined); // 零写面
    assert.equal(tracker.settle('m-3'), false);
    assert.equal(tracker.stateOf('m-3'), undefined);
  });

  it('验收门③·倒退拒：read 后 delivered 拒·settled 后 read/delivered 拒', () => {
    tracker.markDelivered('m-4');
    tracker.ack('m-4');
    assert.equal(tracker.markDelivered('m-4'), false); // read→delivered 倒退
    assert.equal(tracker.stateOf('m-4'), 'read'); // 零变
    tracker.settle('m-4');
    assert.equal(tracker.ack('m-4'), false); // settled→read 拒
    assert.equal(tracker.markDelivered('m-4'), false); // settled→delivered 拒
    assert.equal(tracker.stateOf('m-4'), 'settled');
  });

  it('settled 终态锁+同段幂等：重入 true 零变', () => {
    tracker.markDelivered('m-5');
    assert.equal(tracker.markDelivered('m-5'), true); // 同段幂等
    tracker.ack('m-5');
    assert.equal(tracker.ack('m-5'), true);
    tracker.settle('m-5');
    assert.equal(tracker.settle('m-5'), true); // settled 同段幂等（终态锁零倒退）
    assert.equal(tracker.stateOf('m-5'), 'settled');
  });

  it('验收门①·跨 reload 持久断言：写→close→真重开同库→read 仍在→收敛段照常', () => {
    // 完整周期前半：delivery→read 落库
    tracker.markDelivered('m-6');
    tracker.ack('m-6');
    assert.equal(tracker.stateOf('m-6'), 'read');
    db.close(); // 模拟进程重启（真落盘链·非进程内复刻）
    db = new DatabaseSync(TEST_DB); // 重开同库文件（boot 链）
    const revived = new ReadTracker(db);
    // 断言仍在（第四型盲区判据：跨 reload 持久）
    assert.equal(revived.stateOf('m-6'), 'read');
    // reload 后收敛段照常推进
    assert.equal(revived.settle('m-6'), true);
    assert.equal(revived.stateOf('m-6'), 'settled');
    tracker = revived; // afterEach 关新连接
  });

  it('多消息隔离：各自独立迁移互不干扰', () => {
    tracker.markDelivered('m-a');
    tracker.markDelivered('m-b');
    tracker.ack('m-a'); // 只 m-a 推进
    assert.equal(tracker.stateOf('m-a'), 'read');
    assert.equal(tracker.stateOf('m-b'), 'delivered'); // m-b 不受影响
    tracker.settle('m-b'); // m-b 走票末收敛支
    assert.equal(tracker.stateOf('m-b'), 'settled');
    assert.equal(tracker.stateOf('m-a'), 'read');
  });
});
