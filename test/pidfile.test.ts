// ── REQ-018 unit tests: PID file primitives + netstat parser ──
// paths.ts reads TRILC_PID_DIR at module evaluation time, so the env var
// must be set BEFORE importing pidfile.js (hence the dynamic import).
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const tmpDir = mkdtempSync(join(tmpdir(), 'trilc-pidfile-'));
process.env.TRILC_PID_DIR = tmpDir;

const pidfile = await import('../src/pidfile.js');
const { PID_FILE } = await import('../src/paths.js');

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseNetstatPid (pure parser, mock netstat output)', () => {
  const sample = `Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:8711         0.0.0.0:0              LISTENING       56789
  TCP    127.0.0.1:9000         0.0.0.0:0              LISTENING       10001
  TCP    [::1]:8711             [::]:0                 LISTENING       99999
  UDP    127.0.0.1:8711         *:*                                    77777`;

  it('finds the 127.0.0.1:port LISTENING owner', () => {
    assert.deepEqual(pidfile.parseNetstatPid(sample, 8711), { pid: 56789, proto: 'LISTENING' });
  });

  it('returns null when the port has no listener', () => {
    assert.equal(pidfile.parseNetstatPid(sample, 8080), null);
  });

  it('ignores IPv6 [::1] listeners and non-TCP lines (daemon binds 127.0.0.1 only)', () => {
    const ipv6Only = `TCP    [::1]:8711    [::]:0    LISTENING    99999`;
    assert.equal(pidfile.parseNetstatPid(ipv6Only, 8711), null);
    const udpOnly = `UDP    127.0.0.1:8711   *:*   77777`;
    assert.equal(pidfile.parseNetstatPid(udpOnly, 8711), null);
  });

  it('matches Linux netstat LISTEN state and lowercase proto', () => {
    const linuxStyle = `tcp        0      0 127.0.0.1:8711      0.0.0.0:*               LISTEN      4242`;
    assert.deepEqual(pidfile.parseNetstatPid(linuxStyle, 8711), { pid: 4242, proto: 'LISTEN' });
  });

  it('returns null on empty output', () => {
    assert.equal(pidfile.parseNetstatPid('', 8711), null);
  });
});

describe('PID file primitives', () => {
  it('writePid is atomic (no tmp residue) and readPid round-trips', async () => {
    await pidfile.writePid(4242);
    assert.equal(await pidfile.readPid(), 4242);
    assert.equal(readFileSync(join(tmpDir, 'trilc.pid'), 'utf-8').trim(), '4242');
    const files = readdirSync(tmpDir);
    assert.ok(files.every((f) => !f.endsWith('.tmp')), `no tmp residue, got: ${files.join(', ')}`);
  });

  it('writePid overwrites and removePidFile cleans up', async () => {
    await pidfile.writePid(111);
    await pidfile.writePid(222);
    assert.equal(await pidfile.readPid(), 222);
    await pidfile.removePidFile();
    assert.equal(await pidfile.readPid(), null);
  });

  it('readPid returns null for a missing/garbage file', async () => {
    await pidfile.removePidFile();
    assert.equal(await pidfile.readPid(), null);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(PID_FILE, 'not-a-number\n', 'utf-8');
    assert.equal(await pidfile.readPid(), null);
    await pidfile.removePidFile();
  });
});

describe('registerPid / unregisterPid (daemon-side ownership)', () => {
  it('registerPid writes this process pid; unregisterPid removes it', async () => {
    await pidfile.registerPid();
    assert.equal(await pidfile.readPid(), process.pid);
    await pidfile.unregisterPid();
    assert.equal(await pidfile.readPid(), null);
  });

  it('unregisterPid leaves a foreign PID file untouched (own-pid guard)', async () => {
    await pidfile.writePid(9999); // simulate another owner
    await pidfile.unregisterPid();
    assert.equal(await pidfile.readPid(), 9999, 'foreign pid file must survive');
    await pidfile.removePidFile();
  });
});

describe('isProcessAlive / livenessFromKillError (stop 假成功修, LG-064 §八裁决②)', () => {
  it('EPERM (process exists, no signal permission) = ALIVE — the false-negative root', () => {
    assert.equal(pidfile.livenessFromKillError('EPERM'), true);
  });

  it('ESRCH (no such process) = dead', () => {
    assert.equal(pidfile.livenessFromKillError('ESRCH'), false);
  });

  it('any other errno / undefined code = dead (fail toward dead, live path is the affirmative one)', () => {
    assert.equal(pidfile.livenessFromKillError('EINVAL'), false);
    assert.equal(pidfile.livenessFromKillError(undefined), false);
  });

  it('real paths: own pid alive, absurd pid dead', () => {
    assert.equal(pidfile.isProcessAlive(process.pid), true);
    assert.equal(pidfile.isProcessAlive(2 ** 30), false);
  });
});

describe('waitProcessExit', () => {
  it('resolves true once a short-lived child exits', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 50)']);
    const exited = await pidfile.waitProcessExit(child.pid!, 3000);
    assert.equal(exited, true);
  });

  it('resolves false when the timeout elapses while the process is alive', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      const exited = await pidfile.waitProcessExit(child.pid!, 300);
      assert.equal(exited, false);
    } finally {
      child.kill();
    }
  });

  it('resolves true immediately for a non-existent pid', async () => {
    const exited = await pidfile.waitProcessExit(2 ** 30, 500);
    assert.equal(exited, true);
  });
});
