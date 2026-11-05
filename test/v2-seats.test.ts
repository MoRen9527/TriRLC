// ── N6 Seats registry 自测门五案（形三 α · 设计卷 72edda33b §三·门①裁 2cfe40575）──
// G 列席断言（裁⑦·种子 15 席逐席在册+计数=15·kebab-case 正名谱）
// H 点名解析（resolve 命中四字段+未知名 undefined+正名精确等值别名不采）
// I host 机位断言（D-24 投影·值域校验）J put 幂等+status 翻转+validateSeat 谱
// K 跨 reload 持久+种子幂等零冲已改（硬门同族·真重开 boot 链）。
// 形制照 v2-policy.test.ts（node:test + tmp 目录·fresh-per-case）。

import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/v2/engine.js';
import { V2Store } from '../src/v2/store.js';
import { SeatRepo, Seats, seedSeats, validateSeat, SEAT_SEEDS } from '../src/v2/seats.js';
import { UserError } from '../src/v2/errors.js';

const TEST_DIR = join(tmpdir(), `trirlc-test-v2-seats-${process.pid}-${Date.now()}`);

let engine: Engine | undefined;
const stores: V2Store[] = [];

function cleanup() {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

beforeEach(cleanup);

afterEach(async () => {
  if (engine !== undefined) {
    await engine.stop();
    engine = undefined;
  }
  for (const store of stores.splice(0)) {
    try { store.close(); } catch { /* 已关零害 */ }
  }
  cleanup();
});

describe('N6 Seats registry', () => {
  it('案G·列席断言（裁⑦）：种子 15 席逐席在册+计数=15·name=source-agents 正名 kebab-case 谱', () => {
    engine = Engine.open(TEST_DIR);
    const roster = engine.seats.list();
    assert.equal(roster.length, 15, '种子谱计数=15（活体名址·门①裁⑦）');
    const expected = SEAT_SEEDS.map((seed) => seed.name).sort();
    assert.deepEqual(roster.map((seat) => seat.name).sort(), expected, '正名谱逐席在册');
    // kebab-case 正名逐席断言（首尾谱抽查+全谱形判）
    for (const seat of roster) {
      assert.match(seat.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `正名 kebab-case：${seat.name}`);
    }
    assert.ok(roster.some((seat) => seat.name === 'full-stack-developer'), '本席在册');
    assert.ok(roster.some((seat) => seat.name === 'ceo-chief-of-staff'), 'COS 在册');
    assert.ok(roster.some((seat) => seat.name === 'senior-test-engineer'), 'STE 在册');
    // 机构面不入员工谱（board/registries=机构面非员工·设计卷 §三 实勘注）
    assert.equal(roster.some((seat) => seat.name === 'board'), false, 'board 不在谱');
  });

  it('案H·点名解析：resolve 命中四字段·未知名 undefined·正名精确等值别名不采（裁注）', () => {
    engine = Engine.open(TEST_DIR);
    const hit = engine.seats.resolve('full-stack-developer');
    assert.deepEqual(hit, { name: 'full-stack-developer', address: 'm-fsd', status: 'idle', host: 'dev' }, '四字段完整回读');
    assert.equal(engine.seats.resolve('no-such-seat'), undefined, '未知名 undefined');
    // 正名精确等值：工作名/别名不入 name 值域（门①裁注·案 H 同源）
    assert.equal(engine.seats.resolve('小全'), undefined, '工作名不采');
    assert.equal(engine.seats.resolve('FSD'), undefined, '大写别名不采');
    assert.equal(engine.seats.resolve('Full-Stack-Developer'), undefined, '大小写变体不采（精确等值）');
  });

  it('案I·host 机位断言：值域校验门+回读 D-24 投影（dev/sg/r-hy）', () => {
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    seedSeats(store.db);
    const seats = new Seats(new SeatRepo(store.db));
    // 种子 host 初值回读（落形注：dev 初值·值谱演进归 N8 派工登记）
    assert.equal(seats.get('chief-technology-officer')!.host, 'dev');
    // D-24 投影三值域：sg/r-hy put 更新回读（纯数据字段·N8 派工登记同形）
    seats.put({ name: 'chief-technology-officer', address: 'm-cto', status: 'busy', host: 'sg' });
    assert.equal(seats.get('chief-technology-officer')!.host, 'sg', 'sg 面登记回读');
    seats.put({ name: 'rd-trainer', address: 'm-rdt', status: 'idle', host: 'r-hy' });
    assert.equal(seats.get('rd-trainer')!.host, 'r-hy', 'r-hy 面登记回读');
    // 值域外拒（D-24 投影三值硬界）
    assert.throws(() => validateSeat({ name: 'x-seat', address: 'a', status: 'idle', host: 'eu-west' }), UserError);
    assert.throws(() => validateSeat({ name: 'x-seat', address: 'a', status: 'idle', host: '' }), UserError);
  });

  it('案J·put 幂等 upsert+status 可写翻转+validateSeat 校验谱（零依赖）', () => {
    const store = new V2Store(TEST_DIR, 'v2.db');
    stores.push(store);
    seedSeats(store.db);
    const seats = new Seats(new SeatRepo(store.db));
    // put 幂等：同 name 再 put=覆写非新增
    seats.put({ name: 'senior-test-engineer', address: 'm-ste', status: 'busy', host: 'dev' });
    seats.put({ name: 'senior-test-engineer', address: 'm-ste', status: 'busy', host: 'dev' });
    assert.equal(seats.list().length, 15, 'put 幂等零重增');
    assert.equal(seats.get('senior-test-engineer')!.status, 'busy', 'status 可写翻转');
    seats.put({ name: 'senior-test-engineer', address: 'm-ste', status: 'idle', host: 'dev' });
    assert.equal(seats.get('senior-test-engineer')!.status, 'idle', 'status 回翻');
    // validateSeat 校验谱：name 形/address 空/status 值域/非对象
    assert.throws(() => validateSeat({ name: 'X Seat', address: 'a', status: 'idle', host: 'dev' }), UserError);
    assert.throws(() => validateSeat({ name: 'x-seat', address: '', status: 'idle', host: 'dev' }), UserError);
    assert.throws(() => validateSeat({ name: 'x-seat', address: 'a', status: 'paused', host: 'dev' }), UserError);
    assert.throws(() => validateSeat('seat'), UserError);
    assert.throws(() => validateSeat(null), UserError);
    // 合形过（回读面）
    assert.deepEqual(validateSeat({ name: 'x-seat', address: 'a', status: 'busy', host: 'sg' }),
      { name: 'x-seat', address: 'a', status: 'busy', host: 'sg' });
  });

  it('案K·跨 reload 持久+种子幂等零冲已改（硬门同族·真重开 boot 链）', async () => {
    engine = Engine.open(TEST_DIR);
    // put 改两席（status 翻转+host 迁移）——运行时已改记录
    engine.seats.put({ name: 'senior-test-engineer', address: 'm-ste', status: 'busy', host: 'sg' });
    engine.seats.put({ name: 'rd-trainer', address: 'm-rdt', status: 'busy', host: 'r-hy' });
    await engine.stop();
    engine = undefined;
    // 真重开同库 boot 链（第四型盲区正形：非进程内复刻）
    engine = Engine.open(TEST_DIR);
    assert.equal(engine.seats.list().length, 15, '重开计数仍 15（种子幂等零重增）');
    const ste = engine.seats.get('senior-test-engineer')!;
    assert.deepEqual(ste, { name: 'senior-test-engineer', address: 'm-ste', status: 'busy', host: 'sg' }, '已改记录零被种子冲（INSERT OR IGNORE 幂等）');
    assert.equal(engine.seats.get('rd-trainer')!.host, 'r-hy', 'host 迁移持久');
    assert.equal(engine.seats.get('full-stack-developer')!.status, 'idle', '未改席位种子初值仍在');
  });
});
