// ── Shared runtime paths (REQ-018) ──
// Single source of truth for the daemon-owned PID file location.
// Both the CLI (manager side) and the daemon process (owner side) import
// from here — previously the constant was duplicated in cli.ts and
// hardcoded again in daemon/schtasks.ts, while the daemon itself had no
// knowledge of its own PID file.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// TRILC_PID_DIR override exists for test isolation (integration tests must
// not touch the real user PID file) and mirrors TRILC_DATA_DIR conventions.
export const PID_DIR = process.env.TRILC_PID_DIR ?? resolve(homedir(), '.trimetaverse');
/** Legacy single-file location（2026-09-18 端口命名空间前形态；兼容读一版）。 */
export const PID_FILE = resolve(PID_DIR, 'trilc.pid');
/** 端口命名空间 pidfile（2026-09-18 CTO 裁，DE 双 daemon 误杀实锚）：TriMLC/TriRLC
 * 共存主机按 port 分文件——daemon 写/CLI stop 读均按 port 定位，杜绝跨 daemon
 * 读到对方 pid 误杀。 */
export function pidFileFor(port: number): string {
  return resolve(PID_DIR, `trilc-${port}.pid`);
}
