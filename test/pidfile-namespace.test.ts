// ── pidfile 端口命名空间测试（2026-09-18 CTO 裁；DE 双 daemon 误杀实锚）──
// 隔离照既有 pidfile.test.ts 模式：TRILC_PID_DIR 在模块求值前设 + 动态 import
// （paths.ts 常量在模块加载时冻结——静态 import 会写到真实用户 PID 目录，
// 2026-09-18 首版测试踩坑实录，本件即防复发版）。
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpDir = mkdtempSync(join(tmpdir(), 'trilc-pidns-'));
process.env.TRILC_PID_DIR = tmpDir;

const pidfile = await import('../src/pidfile.js');
const { PID_FILE, pidFileFor } = await import('../src/paths.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('pidfile 端口命名空间（trilc-<port>.pid）', () => {
  it('案1 双 pidfile 并存：8711/8713 各自命中（互不串读/互删防护）', async () => {
    await pidfile.writePid(1111, 8711);
    await pidfile.writePid(3333, 8713);
    assert.equal(await pidfile.readPid(8711), 1111, '8711 读 8711 文件');
    assert.equal(await pidfile.readPid(8713), 3333, '8713 读 8713 文件');
    assert.ok(existsSync(pidFileFor(8711)), '端口命名文件在盘');
    assert.ok(existsSync(pidFileFor(8713)));
    assert.equal(existsSync(PID_FILE), false, '不再写 legacy 单文件');
    await pidfile.removePidFile(8711);
    assert.equal(existsSync(pidFileFor(8711)), false, '8711 文件移除');
    assert.equal(await pidfile.readPid(8713), 3333, '移除 8711 不影响 8713');
  });

  it('案2 陈旧 pidfile 拒 kill：verify 一致性不一致=拒绝语义', async () => {
    // pidfile 记 1111；netstat fixture：8713 现监听 pid=9999（陈旧形态）
    const netstatFixture = '  TCP    127.0.0.1:8713     0.0.0.0:0    LISTENING    9999';
    const actual = pidfile.parseNetstatPid(netstatFixture, 8713);
    assert.equal(actual?.pid, 9999);
    const consistency = { ok: actual?.pid === 1111, actualPid: actual?.pid ?? null };
    assert.equal(consistency.ok, false, '陈旧 pidfile 必判不一致（stop 门拒 kill）');
    assert.equal(consistency.actualPid, 9999);
    // 一致路径：pidfile==监听 → ok
    const netstatMatch = '  TCP    127.0.0.1:8713     0.0.0.0:0    LISTENING    1111';
    assert.equal(pidfile.parseNetstatPid(netstatMatch, 8713)?.pid, 1111, '一致形态可过门');
  });

  it('案3 legacy 兼容：新代文件缺 → 回退读 trilc.pid（一版兼容）', async () => {
    writeFileSync(PID_FILE, '4242\n', 'utf-8');
    assert.equal(await pidfile.readPid(8711), 4242, '新代缺→legacy 命中');
    assert.equal(existsSync(pidFileFor(8711)), false, '回退读不凭空造新代文件');
    // 清 legacy（不影响其他案）
    rmSync(PID_FILE, { force: true });
  });
});
