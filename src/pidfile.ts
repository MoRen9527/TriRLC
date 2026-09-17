// ── PID file + process identity management (REQ-018) ──
// The daemon OWNS its PID file: it registers on successful listen and
// unregisters on graceful shutdown/exit. The CLI (manager side) reads,
// verifies and cleans up, falling back to port-based process discovery
// when the PID file is missing (pre-REQ-018 foreground runs, foreign
// owners like nssm/tricade).
//
// Module is side-effect-free at import time so unit tests can load it
// directly (unlike cli.ts, which executes its command dispatch on import).
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import { PID_DIR, PID_FILE, pidFileFor } from './paths.js';

const execFileAsync = promisify(execFile);

// ── PID file primitives ──

export async function ensurePidDir(): Promise<void> {
  try {
    await access(PID_DIR, constants.F_OK);
  } catch {
    await mkdir(PID_DIR, { recursive: true });
  }
}

export async function readPid(port?: number): Promise<number | null> {
  // 2026-09-18 端口命名空间：带 port=读 trilc-<port>.pid，缺文件回退 legacy
  // trilc.pid（兼容读一版）；不带 port=legacy 语义原样（既有调用/测试）。
  if (port !== undefined) {
    try {
      const content = await readFile(pidFileFor(port), 'utf-8');
      const pid = parseInt(content.trim(), 10);
      if (Number.isFinite(pid)) return pid;
    } catch {
      /* 新代文件缺——回退 legacy */
    }
  }
  try {
    const content = await readFile(PID_FILE, 'utf-8');
    const pid = parseInt(content.trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Atomic PID write: write tmp sibling then rename — readers never observe partial content. */
export async function writePid(pid: number, port?: number): Promise<void> {
  await ensurePidDir();
  const target = port !== undefined ? pidFileFor(port) : PID_FILE;
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, `${pid}\n`, 'utf-8');
  await rename(tmp, target);
}

export async function removePidFile(port?: number): Promise<void> {
  const targets = port !== undefined ? [pidFileFor(port), PID_FILE] : [PID_FILE];
  for (const target of targets) {
    try {
      await unlink(target);
    } catch {
      // ignore — file may not exist
    }
  }
}

// ── Daemon-side registration (owner) ──

/** Daemon startup: register this process's PID (called after server listen succeeds). */
export async function registerPid(port?: number): Promise<void> {
  await writePid(process.pid, port);
}

/** Daemon shutdown: remove the PID file only if it still names this process. */
export async function unregisterPid(port?: number): Promise<void> {
  const pid = await readPid(port);
  if (pid !== null && pid === process.pid) {
    await removePidFile(port);
  }
}

// ── Process liveness ──

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until the process exits or the timeout elapses. Resolves true when the process is dead. */
export async function waitProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return !isProcessAlive(pid);
}

// ── Port-based process discovery (fallback when PID file is missing) ──

/**
 * Pure parser for `netstat -ano -p tcp` output. Exported for unit testing.
 * Column-based (robust against greedy-token regex backtracking traps):
 * - Windows: [proto, local, foreign, state, pid]
 * - Linux:   [proto, recv-q, send-q, local, foreign, state, pid]
 */
export function parseNetstatPid(netstatOutput: string, port: number): { pid: number; proto: string } | null {
  for (const rawLine of netstatOutput.split(/\r?\n/)) {
    const cols = rawLine.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (!/^tcp$/i.test(cols[0])) continue;

    let local = cols[1];
    let stateIdx = 3;
    if (cols.length >= 7 && /^\d+$/.test(cols[1]) && /^\d+$/.test(cols[2])) {
      // Linux style: [tcp, recv-q, send-q, local, foreign, state, pid]
      local = cols[3];
      stateIdx = 5;
    }

    const m = local.match(/^(\S+):(\d+)$/);
    if (!m) continue;
    const state = cols[stateIdx];
    if (state !== 'LISTENING' && state !== 'LISTEN') continue;
    if (m[2] === String(port) && m[1] === '127.0.0.1') {
      const pid = parseInt(cols[stateIdx + 1], 10);
      if (Number.isFinite(pid)) return { pid, proto: state.toUpperCase() };
    }
  }
  return null;
}

/** Locate the process listening on 127.0.0.1:port (Windows netstat / POSIX lsof|ss). */
export async function findProcessByPort(port: number): Promise<{ pid: number; proto: string } | null> {
  if (platform() === 'win32') {
    try {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp']);
      return parseNetstatPid(stdout, port);
    } catch {
      return null;
    }
  }
  // POSIX: lsof first (exact LISTEN filter), then ss fallback
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    const first = stdout.trim().split(/\r?\n/)[0];
    const pid = parseInt(first, 10);
    if (Number.isFinite(pid)) return { pid, proto: 'LSOF' };
  } catch { /* lsof unavailable */ }
  try {
    const { stdout } = await execFileAsync('ss', ['-tlnp', `sport = :${port}`]);
    const m = stdout.match(/pid=(\d+)/);
    if (m) return { pid: parseInt(m[1], 10), proto: 'SS' };
  } catch { /* ss unavailable */ }
  return null;
}


// ── 端口-pid 一致性校验（2026-09-18 CTO 裁：比分文件更硬的保险）──────────────

/**
 * stop 前定点核对：pidfile 记载 pid 必须==该 port 现监听 pid。
 * 不一致（陈旧文件/跨 daemon 写入）=拒绝 kill 防二次误杀。
 */
export async function verifyPortPidConsistency(
  port: number,
  pidFromFile: number,
): Promise<{ ok: boolean; actualPid: number | null }> {
  const owner = await findProcessByPort(port);
  const actualPid = owner?.pid ?? null;
  return { ok: actualPid === pidFromFile, actualPid };
}
