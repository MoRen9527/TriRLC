#!/usr/bin/env node
// ── TriLC CLI ──
// Provides start/stop/status/run commands for the TriLC daemon.
// CTO-008-P P.1: CLI entry point for PC desktop packaging.

import { spawn, type ChildProcess } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import type { TriLCDaemonServiceConfig } from './daemon/service.js';
// REQ-018: PID management lives in pidfile.ts (shared with the daemon).
import { findProcessByPort, isProcessAlive, readPid, removePidFile, verifyPortPidConsistency, waitProcessExit } from './pidfile.js';
import { installTrimcTokenFetch } from './trimc-auth.js';
// TASK-TRIMODEL-RECOVERY-LADDER-01 波③：TriModel 直连恢复梯命令族（core=TriCode trimodel-cli，
// 本 bin 只做 CoreIO 注入+runCli 派发——core 零仓感知，仓特有项在此注入）。
import { defaultL2FlagPath, makeCoreIO, runCli, type ProbeReading } from '@trimetaverse/tricode/trimodel-cli';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──
const DEFAULT_PORT = 8711;
const HEALTHZ_TIMEOUT_MS = 3000;
const DEFAULT_SERVICE_NAME = 'TriLC';
const REGRUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const REGRUN_VALUE = 'TriLC';

// ── Help ──
function printHelp(): void {
  console.log(`TriLC (Local Controller) — TriMetaverse Desktop Daemon

Usage: trilc <command> [options]

Commands:
  start              Start daemon in background       trilc start [--port 8711]
  stop               Stop background daemon           trilc stop
  restart            Restart daemon (stop → start)    trilc restart [--port 8711]
  status             Show daemon status               trilc status [--port 8711]
  run                Run daemon in foreground         trilc run [--port 8711]
  chat               Start TUI chat (auto-starts daemon) trilc chat [--port 8711] [--agent &lt;id&gt;] [--resume &lt;id&gt;] [--permission-mode &lt;mode&gt;]
  list-sessions      List all saved sessions            trilc list-sessions [--port 8711]
  session compact    Compact a session's messages         trilc session compact <id>
  install-service    Register as Windows Service       trilc install-service [--name TriLC] [--displayName "..."]
  uninstall-service  Unregister Windows Service        trilc uninstall-service [--name TriLC]
  install-regrun     Register to Registry Run (no-admin) trilc install-regrun
  uninstall-regrun   Remove from Registry Run           trilc uninstall-regrun
  daemon             OS-level daemon management         trilc daemon <install|uninstall|stage|status>
  cron               Cron job management                trilc cron <add|list|update|remove|run|log|status>
  config             TriModel config page family (LG-058) trilc config <pull|show|verify|cache show|cache clear>
  mcp                MCP server management               trilc mcp <add|remove|list|status>
  watchdog           Start watchdog supervisor process   trilc watchdog [--port 8711] [--data-dir <path>]

Options:
  --port <n>          Port for HTTP server (default: ${DEFAULT_PORT})
  --name <s>          Windows Service name (default: ${DEFAULT_SERVICE_NAME})
  --displayName <s>   Windows Service display name
  --agent <id>        Agent contract ID for chat (e.g. ceo-chief-of-staff)
  --resume <id>       Resume a previous session by ID
  --list-sessions     List all saved sessions
  --permission-mode <mode>  Permission mode (default/acceptEdits/auto/dontAsk/bypass/plan)
                            default: bypass (backward compatible)
  --allow <rule>        Allow a tool (repeatable). Format: \"ToolName\" or \"ToolName(content)\"
  --deny <rule>         Deny a tool (repeatable). Format: \"ToolName\" or \"ToolName(content)\"
  --add-dir <path>      Additional allowed directory (repeatable, e.g. sibling repos)
  -p, --print           Non-interactive print mode: ask→deny, no TUI, requires --allow/--deny`);
}

// ── Argument parsing ──
function parseArgs(args: string[]): { command: string; port: number; serviceName: string; displayName: string; agent?: string; resume?: string; listSessions?: boolean; permissionMode?: string; allowRules?: string[]; denyRules?: string[]; addDirs?: string[]; printMode?: boolean } {
  const command = args[0] ?? 'help';
  let port = DEFAULT_PORT;
  let serviceName = DEFAULT_SERVICE_NAME;
  let displayName = 'TriMetaverse Local Controller';
  let agent: string | undefined;
  let resume: string | undefined;
  let listSessions = false;
  let permissionMode: string | undefined;
  const allowRules: string[] = [];
  const denyRules: string[] = [];
  const addDirs: string[] = [];
  let printMode = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--name' && args[i + 1]) {
      serviceName = args[i + 1];
      i++;
    } else if (args[i] === '--displayName' && args[i + 1]) {
      displayName = args[i + 1];
      i++;
    } else if (args[i] === '--agent' && args[i + 1]) {
      agent = args[i + 1];
      i++;
    } else if (args[i] === '--resume' && args[i + 1]) {
      resume = args[i + 1];
      i++;
    } else if (args[i] === '--permission-mode' && args[i + 1]) {
      permissionMode = args[i + 1];
      i++;
    } else if (args[i] === '--allow' && args[i + 1]) {
      allowRules.push(args[i + 1]);
      i++;
    } else if (args[i] === '--deny' && args[i + 1]) {
      denyRules.push(args[i + 1]);
      i++;
    } else if (args[i] === '--add-dir' && args[i + 1]) {
      addDirs.push(args[i + 1]);
      i++;
    } else if (args[i] === '--print' || args[i] === '-p') {
      printMode = true;
    } else if (args[i] === '--list-sessions') {
      listSessions = true;
    }
  }

  // C8: Validate permission-mode value (CLI-level early check)
  if (permissionMode !== undefined) {
    const validModes = ['default', 'acceptEdits', 'auto', 'dontAsk', 'bypass', 'plan'];
    if (!validModes.includes(permissionMode)) {
      console.error(`[trilc] invalid permission mode: "${permissionMode}". Valid: ${validModes.join(', ')}`);
      process.exit(1);
    }
  }

  // C9: -p implies non-interactive: force default permission mode,
  // override bypass to default (bypass is interactive and unsafe for -p).
  if (printMode && !permissionMode) {
    permissionMode = 'default';
    console.log('[trilc] -p mode: permission mode defaulting to "default" (non-interactive)');
  }
  if (printMode && (permissionMode === 'bypass' || permissionMode === 'bypassPermissions')) {
    console.error('[trilc] -p mode: permission mode "bypass" is not allowed in non-interactive mode. Use "default" or "dontAsk".');
    process.exit(1);
  }

  return { command, port, serviceName, displayName, agent, resume, listSessions, permissionMode, allowRules, denyRules, addDirs, printMode };
}

// ── Process identity (REQ-018) ──
// A "running trilc" is a PID that is alive AND answers healthz on the port.
// A bare alive PID could be an unrelated process that reused the PID slot.
async function isPidTrilc(pid: number, port: number): Promise<boolean> {
  if (!isProcessAlive(pid)) return false;
  const health = await healthCheck(port);
  return health.ok;
}

// ── HTTP health check ──
async function healthCheck(port: number): Promise<{ ok: boolean; data?: unknown }> {
  const url = `http://127.0.0.1:${port}/healthz`;

  return new Promise((resolve) => {
    import('node:http').then((http) => {
      const req = http.get(url, { timeout: HEALTHZ_TIMEOUT_MS }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ ok: true, data: JSON.parse(body) });
          } catch {
            resolve({ ok: true, data: { raw: body } });
          }
        });
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false });
      });
    });
  });
}

// ── Commands ──

async function cmdStart(port: number, permissionMode?: string, allowRules?: string[], denyRules?: string[], addDirs?: string[], printMode?: boolean): Promise<void> {
  installTrimcTokenFetch(); // TriMMC /internal token 全局注入（P0 加固配套）
  // Existing PID file → healthy daemon → already running.
  // REQ-018 identity check: PID alive AND healthz ok.
  const existingPid = await readPid(port);
  if (existingPid !== null && await isPidTrilc(existingPid, port)) {
    console.log(`[trilc] daemon already running (pid=${existingPid})`);
    return;
  }

  // Port-in-use guard: if daemon was started by another path (nssm service, tricade,
  // pre-REQ-018 foreground run), the PID file may be missing while the port is taken.
  if (await isPortInUse(port)) {
    const health = await healthCheck(port);
    if (health.ok) {
      console.log(`[trilc] daemon already running on port ${port}.`);
      return;
    }
    // Occupied but unhealthy — identify the owner instead of guessing.
    const owner = await findProcessByPort(port);
    if (owner) {
      console.error(`[trilc] port ${port} occupied by pid ${owner.pid} — not a healthy trilc daemon.`);
      console.error('[trilc] stop that process (or run trilc stop) before starting.');
    } else {
      console.error(`[trilc] port ${port} already in use by another process.`);
    }
    process.exit(1);
  }

  // Clean up stale PID file (the daemon self-registers on startup — REQ-018)
  await removePidFile();

  // ①诊断修复（日志两层第一层）：daemon 子进程输出落盘
  // <dataDir>/daemon/daemon.log（此前 stdio:'ignore' 全丢——崩溃无可诊断）
  const daemonDataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
  const daemonLogDir = join(daemonDataDir, 'daemon');
  mkdirSync(daemonLogDir, { recursive: true });
  const daemonLogPath = join(daemonLogDir, 'daemon.log');
  const daemonLogFd = openSync(daemonLogPath, 'a');

  const entryPoint = resolve(__dirname, 'index.js');
  const child: ChildProcess = spawn(
    process.execPath,
    [entryPoint],
    {
      detached: true,
      stdio: ['ignore', daemonLogFd, daemonLogFd],
      env: {
        ...process.env,
        TRILC_PORT: String(port),
        ...(permissionMode ? { TRILC_PERMISSION_MODE: permissionMode } : {}),
        ...(allowRules && allowRules.length > 0 ? { TRILC_ALLOW_RULES: JSON.stringify(allowRules) } : {}),
        ...(denyRules && denyRules.length > 0 ? { TRILC_DENY_RULES: JSON.stringify(denyRules) } : {}),
        ...(addDirs && addDirs.length > 0 ? { TRILC_ADD_DIRS: JSON.stringify(addDirs) } : {}),
        ...(printMode ? { TRILC_PRINT_MODE: '1' } : {}),
      },
    },
  );

  child.unref();

  if (!child.pid) {
    console.error('[trilc] failed to spawn daemon');
    process.exit(1);
  }

  // ①诊断修复（健康窗口）：10s 单次 → 30s 轮询。冷启动需拉 keys +
  // 13 员工 roster + 14 contracts + TriMC 连接，10s 过窄（22:05/22:12
  // auto-start 连败实证）。失败输出明确诊断原因 + 日志路径。
  const pidDeadline = Date.now() + 30000;
  let registered = false;
  let spawnDied = false;
  while (Date.now() < pidDeadline) {
    const registeredPid = await readPid(port);
    if (registeredPid === child.pid) { registered = true; break; }
    if (!isProcessAlive(child.pid)) { spawnDied = true; break; } // spawn died before registering
    await new Promise((r) => setTimeout(r, 500));
  }

  let ready = false;
  let lastHealthDetail = '';
  const healthDeadline = Date.now() + 30000;
  while (Date.now() < healthDeadline) {
    const check = await healthCheck(port);
    if (check.ok) { ready = true; break; }
    lastHealthDetail = 'healthz not responding';
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (!ready) {
    const reason = spawnDied
      ? `daemon process exited during startup (pid=${child.pid})`
      : `daemon not healthy within 30s (pid=${child.pid}): ${lastHealthDetail || 'no detail'}`;
    console.error(`[trilc] daemon failed to start — ${reason}`);
    console.error(`[trilc] daemon log: ${daemonLogPath}`);
    process.exit(1);
  }

  if (!registered) {
    console.warn('[trilc] daemon healthy but PID file not registered (check ~/.trimetaverse permissions)');
  }
  console.log(`[trilc] daemon started (pid=${child.pid} port=${port})`);
}

async function cmdStop(port: number = DEFAULT_PORT): Promise<void> {
  const pid = await readPid(port);

  // ── Case A: PID file present ──
  if (pid !== null) {
    // 端口-pid 一致性校验（2026-09-18 CTO 裁）：pidfile 记载必须==port 现监听
    // pid——不一致（陈旧文件/跨 daemon 写入）=拒绝 kill 防二次误杀（8711 双录
    // 实锚；legacy trilc.pid 兼容读同样过本门）。
    const consistency = await verifyPortPidConsistency(port, pid);
    if (!consistency.ok) {
      console.error(
        `[trilc] refusing to stop: PID file records pid=${pid} but port ${port} ` +
        `is currently owned by pid=${consistency.actualPid ?? 'none'} — ` +
        'stale or cross-daemon pidfile. Remove the stale file manually if this is expected.',
      );
      return;
    }
    if (isProcessAlive(pid)) {
      // Graceful HTTP shutdown first (Windows-compatible), then confirm exit.
      const shutdownOk = await gracefulShutdown(port);
      if (shutdownOk) {
        const exited = await waitProcessExit(pid);
        if (exited) {
          console.log(`[trilc] daemon stopped gracefully (pid=${pid})`);
          await removePidFile();
          return;
        }
        // Shutdown endpoint accepted but the process is still alive — escalate.
        console.warn(`[trilc] graceful shutdown accepted but pid ${pid} still alive, sending SIGTERM...`);
      } else {
        console.log(`[trilc] shutdown endpoint unavailable, sending SIGTERM (pid=${pid})...`);
      }

      // Fallback: SIGTERM (Linux) / TerminateProcess (Windows)
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        console.error(`[trilc] failed to signal daemon (pid=${pid}):`, (err as Error).message);
      }
      const exited = await waitProcessExit(pid);
      if (exited) {
        console.log(`[trilc] daemon stopped via signal (pid=${pid})`);
      } else {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        await waitProcessExit(pid, 3000);
        console.log(`[trilc] daemon force-killed (pid=${pid})`);
      }
      await removePidFile();
      return;
    }

    // Stale PID file — clean it and fall through to the port-based check.
    console.log(`[trilc] daemon not running (stale pid=${pid})`);
    await removePidFile();
  }

  // ── Case B: no PID file — locate the daemon by port (REQ-018 fallback) ──
  const owner = await findProcessByPort(port);
  if (!owner) {
    console.log('[trilc] no daemon running');
    return;
  }

  const health = await healthCheck(port);
  if (!health.ok) {
    console.log(`[trilc] port ${port} occupied by pid ${owner.pid} — not a healthy trilc daemon; not killing it.`);
    return;
  }

  // Healthy trilc with no PID record (foreground run / foreign path): stop it.
  const shutdownOk = await gracefulShutdown(port);
  if (shutdownOk) {
    const exited = await waitProcessExit(owner.pid);
    if (exited) {
      console.log(`[trilc] daemon stopped via port lookup (pid=${owner.pid})`);
      return;
    }
    console.warn(`[trilc] graceful shutdown accepted but pid ${owner.pid} still alive, sending SIGTERM...`);
  } else {
    console.log(`[trilc] shutdown endpoint unavailable, sending SIGTERM (pid=${owner.pid})...`);
  }

  try {
    process.kill(owner.pid, 'SIGTERM');
  } catch (err) {
    console.error(`[trilc] failed to signal pid ${owner.pid}:`, (err as Error).message);
  }
  const exited = await waitProcessExit(owner.pid);
  if (exited) {
    console.log(`[trilc] daemon stopped via signal (pid=${owner.pid})`);
  } else {
    try { process.kill(owner.pid, 'SIGKILL'); } catch { /* already gone */ }
    await waitProcessExit(owner.pid, 3000);
    console.log(`[trilc] daemon force-killed (pid=${owner.pid})`);
  }
}

async function gracefulShutdown(port: number): Promise<boolean> {
  try {
    const url = `http://127.0.0.1:${port}/shutdown`;
    await new Promise<void>((resolve, reject) => {
      import('node:http').then((http) => {
        const req = http.request(url, { method: 'POST', timeout: 3000 }, (res) => {
          res.resume();
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
    });
    return true;
  } catch {
    return false;
  }
}

async function cmdRestart(port: number): Promise<void> {
  console.log('[trilc] restarting daemon...');
  await cmdStop(port);
  // brief pause to allow port release
  await new Promise((r) => setTimeout(r, 1000));
  await cmdStart(port);
  console.log('[trilc] daemon restarted');
}

async function cmdStatus(port: number): Promise<void> {
  const pid = await readPid(port);
  const health = await healthCheck(port);
  const pidAlive = pid !== null && isProcessAlive(pid);

  // PID file may be missing while a healthy daemon owns the port
  // (foreground run / foreign start path) — fall back to port discovery.
  let effectivePid: number | null = pid;
  if (!pidAlive && health.ok) {
    const owner = await findProcessByPort(port);
    effectivePid = owner?.pid ?? pid;
  }

  const status = {
    running: health.ok,
    pid: effectivePid,
    port,
    healthz: health.ok,
    healthData: health.data ?? null,
  };

  console.log(JSON.stringify(status, null, 2));
}

async function cmdRun(port: number, permissionMode?: string, allowRules?: string[], denyRules?: string[], addDirs?: string[], printMode?: boolean): Promise<void> {
  // Port-in-use guard: if another daemon (nssm service / tricade / previous cmdStart)
  // is already listening, exit cleanly instead of conflicting.
  if (await isPortInUse(port)) {
    console.log(`[trilc] port ${port} already in use — daemon is already running.`);
    return;
  }

  // Foreground mode: set env port and permission config
  process.env.TRILC_PORT = String(port);
  if (permissionMode) process.env.TRILC_PERMISSION_MODE = permissionMode;
  if (allowRules && allowRules.length > 0) process.env.TRILC_ALLOW_RULES = JSON.stringify(allowRules);
  if (denyRules && denyRules.length > 0) process.env.TRILC_DENY_RULES = JSON.stringify(denyRules);
  if (addDirs && addDirs.length > 0) process.env.TRILC_ADD_DIRS = JSON.stringify(addDirs);
  if (printMode) process.env.TRILC_PRINT_MODE = '1';

  // index.ts runs main() at top level when imported
  await import('./index.js');
}

// ── TUI Chat command ──

async function cmdChat(port: number, agent?: string, resume?: string, permissionMode?: string, allowRules?: string[], denyRules?: string[], addDirs?: string[], printMode?: boolean): Promise<void> {
  // Step 1: healthz check
  const health = await healthCheck(port);

  if (!health.ok) {
    console.log('[trilc] daemon not running, auto-starting...');
    // Kill any stale daemon occupying the port but not responding.
    // REQ-018: confirm the process actually exited (poll) before removing
    // the PID file; escalate to SIGKILL only after the wait timeout.
    const existingPid = await readPid(port);
    if (existingPid !== null && isProcessAlive(existingPid)) {
      console.log(`[trilc] stale daemon detected (pid=${existingPid}), killing...`);
      try { process.kill(existingPid, 'SIGTERM'); } catch {}
      const exited = await waitProcessExit(existingPid, 5000);
      if (!exited) {
        try { process.kill(existingPid, 'SIGKILL'); } catch { /* already gone */ }
        await waitProcessExit(existingPid, 3000);
      }
      await removePidFile(port);
    }
  }

  // Step 2: ensure daemon is running
  await cmdStart(port, permissionMode, allowRules, denyRules, addDirs, printMode);

  // Step 3: wait for daemon to be ready (poll up to 30s)
  const startTime = Date.now();
  const maxWaitMs = 30000;
  const pollIntervalMs = 5000;

  while (Date.now() - startTime < maxWaitMs) {
    const check = await healthCheck(port);
    if (check.ok) {
      console.log('[trilc] daemon ready, starting TUI...');
      break;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  // Step 4: final healthz check
  const finalCheck = await healthCheck(port);
  if (!finalCheck.ok) {
    console.error(`[trilc] daemon failed to start within ${maxWaitMs / 1000}s`);
    process.exit(1);
  }

  // Step 4.5: fetch notifications (REQ-021) — pass via TUI options (no console.log
  // before TUI; Ink needs clean terminal state for first paint).
  const notificationMessages: Array<{ role: 'assistant'; content: string }> = [];
  try {
    const notifUrl = `http://127.0.0.1:${port}/internal/v1/notifications`;
    const notifRes = await fetch(notifUrl);
    const notifJson = await notifRes.json() as { ok?: boolean; notifications?: Array<{ title: string; body?: string }> };
    if (notifJson.ok && notifJson.notifications?.length) {
      for (const n of notifJson.notifications) {
        const line = `📬 ${n.title}${n.body ? ': ' + n.body.slice(0, 120) : ''}`;
        notificationMessages.push({ role: 'assistant', content: line });
      }
    }
  } catch { /* notifications are best-effort */ }

  // Step 5: if resume, fetch session from daemon
  let resumeOpts: { sessionId?: string; messages?: Array<{ role: 'user' | 'assistant'; content: string }>; systemPrompt?: string } | undefined;
  if (resume) {
    try {
      const fetchUrl = `http://127.0.0.1:${port}/internal/v1/sessions/${resume}`;
      const res = await fetch(fetchUrl);
      const json = await res.json() as { ok: boolean; session?: { id: string }; messages?: Array<{ role: string; content: string | null }> };
      if (json.ok && json.messages) {
        const msgs = json.messages
          .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content! }));
        resumeOpts = { sessionId: resume, messages: msgs };
        console.log(`[trilc] resumed session ${resume} with ${msgs.length} messages`);
      } else {
        console.error(`[trilc] session ${resume} not found or has no messages`);
        process.exit(1);
      }
    } catch (err) {
      console.error(`[trilc] failed to fetch session ${resume}:`, (err as Error).message);
      process.exit(1);
    }
  }

  // i2-2 §五 叙事态下线：hb_company-onboarding auto-resume 分支已移除。
  // 结构化 init 流程取代叙事 auto-resume（同 release 一次性，无并存期）。

  // i2-2 §四.2：chat 模式启动时 chain/status 呈初始化阶段 → init 模式文本化
  // 流程（编号多选 + 命名问答 + 汇总确认 + assemble 提交）。员工 --agent 会话
  // 路径不动；流程只渲染 + 发 daemon 端点指令（零本地执行）。
  if (!agent) {
    try {
      const { runInitCliFlow } = await import('./company/init-cli-flow.js');
      console.log('[trilc:init] 提示：任意阶段想重来，退出后运行 trilc chat reset（或 trilc chat reset --include-project 同时清项目关联）');
      const flow = await runInitCliFlow(port);
      // 2026-08-16 CEO UX：链在 selfcheck 未触发即跳过 → 留在 shell（不进 TUI 聊天）
      if (flow.outcome === 'skipped' && String(flow.detail || '').includes('selfcheck not triggered')) {
        console.log('[trilc:init] 未触发自检 — 退出（回到终端；trilc chat 随时再进）。');
        return;
      }
      if (flow.outcome === 'assembled') {
        console.log('\n[trilc] 公司开张完成 ✓ — 自动衔接项目初始化…');
        // v2.1 衔接（2026-08-16）：开张后链态已 project-link——直接串联项目流程（免重启 chat）
        const { runInitCliFlow: continueFlow } = await import('./company/init-cli-flow.js');
        const next = await continueFlow(port);
        console.log(`[trilc] 项目流程结束（outcome=${next.outcome}）— 五维同步/确认请重新运行 trilc chat 继续。`);
      }
    } catch (err) {
      console.warn('[trilc] init cli flow failed, falling back to chat:', (err as Error).message);
    }
  }

  // Step 6: start TUI
  if (agent) console.log(`[trilc] agent: ${agent}`);
  try {
    const { startTUI } = await import('./tui/render.js');
    // REQ-021: pass notifications as initial assistant messages (clean terminal,
    // no console.log before Ink's first paint)
    const opts = resumeOpts
      ? { ...resumeOpts, messages: [...notificationMessages, ...(resumeOpts.messages ?? [])] }
      : { messages: notificationMessages };
    const root = await startTUI(opts);
    await root.waitUntilExit();
      // 2026-08-16 CEO UX：/exit 花屏——退出时 ANSI 清屏 + 光标复位（Ink 残留边框清理）
      process.stdout.write('[2J[H[0J');
    console.log('[trilc] TUI closed.');
  } catch (err) {
    console.error('[trilc] TUI error:', (err as Error).message);
  }
  process.exit(0);
}

// ── Windows Service commands (admin required) ──

/** Check if a TCP port is already in use (another daemon / nssm service). */
async function isPortInUse(port: number): Promise<boolean> {
  try {
    const { createServer } = await import('node:net');
    return await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(true));   // EADDRINUSE
      s.once('listening', () => { s.close(); resolve(false); });
      s.listen(port, '127.0.0.1');
    });
  } catch {
    return true; // assume occupied on error
  }
}

async function checkAdminPrivilege(): Promise<boolean> {
  if (platform() !== 'win32') return false;
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    // net session requires admin; will fail with access denied for non-admin
    await execAsync('net session');
    return true;
  } catch {
    return false;
  }
}

async function checkServiceExists(name: string): Promise<boolean> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    await execAsync(`sc query ${name}`);
    return true;
  } catch {
    return false;
  }
}

async function checkRegRunExists(): Promise<boolean> {
  if (platform() !== 'win32') return false;
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    await execAsync(`reg query "${REGRUN_KEY}" /v ${REGRUN_VALUE}`);
    return true;
  } catch {
    return false;
  }
}

// ── install-service / uninstall-service ──
// DEPRECATED after architecture review (2026-07-27):
//   nssm SYSTEM service cannot access user API keys and introduced port-conflict
//   complexity.  Delegate to install-regrun / uninstall-regrun instead.
//   RegRun auto-starts TriLC at user login — no admin, users own keys, zero external
//   dependencies.  The old CLI names are kept so existing MSI CustomActions and
//   install scripts do not break — they transparently map to RegRun now.

async function cmdInstallService(_name: string, _displayName: string): Promise<void> {
  console.log('[trilc] install-service → install-regrun (nssm/SYSTEM service deprecated).');
  await cmdInstallRegRun();
}

async function cmdUninstallService(_name: string): Promise<void> {
  console.log('[trilc] uninstall-service → uninstall-regrun.');
  await cmdUninstallRegRun();
}

// ── Registry Run commands (no admin required) ──

async function cmdInstallRegRun(): Promise<void> {
  if (platform() !== 'win32') {
    console.error('ERROR: Registry Run registration is only available on Windows.');
    process.exit(1);
  }

  // Check mutual exclusion: if Service already registered
  if (await checkServiceExists(DEFAULT_SERVICE_NAME)) {
    console.error('ERROR: TriLC already registered as Windows Service.');
    console.error('Run trilc uninstall-service first, then retry install-regrun.');
    process.exit(1);
  }

  if (await checkRegRunExists()) {
    console.log('[trilc] TriLC already registered in Registry Run.');
    return;
  }

  const nodePath = process.execPath;
  const cliPath = resolve(__dirname, 'cli.js');

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    const cmd = `reg add "${REGRUN_KEY}" /v ${REGRUN_VALUE} /t REG_SZ /d "\\"${nodePath}\\" \\"${cliPath}\\" start" /f`;
    await execAsync(cmd);
    console.log('[OK] TriLC registered in Registry Run (auto-start on login).');
  } catch (err) {
    console.error(`ERROR: Registry Run registration failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function cmdUninstallRegRun(): Promise<void> {
  if (platform() !== 'win32') return;

  const exists = await checkRegRunExists();
  if (!exists) {
    console.log('[trilc] TriLC not found in Registry Run.');
    return;
  }

  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  try {
    await execAsync(`reg delete "${REGRUN_KEY}" /v ${REGRUN_VALUE} /f`);
    console.log('[OK] TriLC 已从 Registry Run 移除。');
  } catch (err) {
    console.error(`ERROR: Registry Run 移除失败: ${(err as Error).message}`);
    process.exit(1);
  }
}

// ── List Sessions ──

async function cmdListSessions(port: number): Promise<void> {
  const health = await healthCheck(port);
  if (!health.ok) {
    console.log('[trilc] daemon not running. Start with: trilc start');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/v1/sessions?limit=50`);
    const json = await res.json() as { ok: boolean; sessions?: Array<{ id: string; title?: string; status: string; createdAt: string }> };
    if (json.ok && json.sessions) {
      if (json.sessions.length === 0) {
        console.log('No saved sessions.');
      } else {
        console.log(`\n${'SESSION ID'.padEnd(28)} STATUS     CREATED`);
        console.log('-'.repeat(60));
        for (const s of json.sessions) {
          console.log(`${s.id.padEnd(28)} ${s.status.padEnd(10)} ${s.createdAt}`);
        }
        console.log(`\nResume a session: trilc chat --resume <id>`);
      }
    } else {
      console.log('No sessions available.');
    }
  } catch (err) {
    console.error('[trilc] failed to list sessions:', (err as Error).message);
  }
}

// ── Daemon subcommands ──

function resolveDaemonConfig(port: number): TriLCDaemonServiceConfig {
  const entryScript = resolve(__dirname, 'cli.js');
  return {
    nodeBin: process.execPath,
    entryScript,
    programArgs: ['start', '--port', String(port)],
    cwd: process.cwd(),
    dataDir: process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`,
    port,
  };
}

// ── Cron subcommands ──

// ── LG-058 N4：config 命令族（方案 §5.1；daemon 进程内执行，CLI=触发器+读数渲染；
// CLI 不开写面=§5.2 差异①）──
async function configRequest(port: number, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  // P0 安全门契约（fail-closed）：daemon 要求 X-Internal-Token；cronRequest 先例
  // 未带 token（族外既有缺口，候修不属本席）——本命令族按门契约带。
  const token = process.env.TRILC_INTERNAL_TOKEN ?? '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-internal-token'] = token;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (res.status === 401) {
    if (String(json.error ?? '') === 'internal_auth_disabled') {
      throw new Error('daemon 未配置 TRILC_INTERNAL_TOKEN（P0 安全门缺省全拒）——配置该 env 后重启 daemon 再试');
    }
    throw new Error('鉴权失败：TRILC_INTERNAL_TOKEN 未设置或与 daemon 不一致');
  }
  if (!res.ok) {
    throw new Error(json && 'error' in json ? String(json.error) : `HTTP ${res.status}`);
  }
  return json;
}

function ts(n: unknown): string {
  return typeof n === 'number' && n > 0 ? new Date(n).toISOString() : '-';
}

async function cmdConfig(subcommand: string, port: number): Promise<void> {
  try {
    switch (subcommand) {
      case 'pull': {
        const r = await configRequest(port, 'POST', '/internal/v1/config/pull') as {
          ok?: boolean; mode?: string; defaultModel?: string | null; source?: string;
          message?: string; attribution?: string | null;
        };
        console.log(`config pull: ${r.ok ? 'OK' : 'FAILED'} (mode=${r.mode})`);
        console.log(`  default model: ${r.defaultModel ?? '-'}   source: ${r.source}`);
        console.log(`  ${r.message ?? ''}`);
        if (r.attribution) console.log(`  attribution: ${r.attribution}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'show':
      case 'cache': {
        // `config cache` 无子命令=show；`cache clear` 走下方分支
        if (subcommand === 'cache' && (process.argv[4] ?? 'show') === 'clear') {
          const r = await configRequest(port, 'DELETE', '/internal/v1/config/cache') as {
            hadCache?: boolean; removedFiles?: string[];
          };
          console.log(`config cache clear: done (hadCache=${!!r.hadCache}, removed=${(r.removedFiles ?? []).length} file(s))`);
          console.log('  梯语义验证：接 `config pull` 强制回 tier1；daemon env 现值待下次成功 pull 覆盖');
          break;
        }
        const r = await configRequest(port, 'GET', '/internal/v1/config/show') as {
          face?: string; hasCache?: boolean; fresh?: boolean; staleGrace?: boolean;
          defaultModel?: string | null; effectiveModel?: string | null; effectiveSource?: string;
          fetchedAt?: number | null; expiresAt?: number | null; refreshIntervalS?: number | null;
          providerCount?: number; providers?: string[];
          lastFetchAt?: number | null; lastFetchError?: string | null; lastAttribution?: string | null;
        };
        console.log(`config show (face=${r.face}):`);
        console.log(`  effective model: ${r.effectiveModel ?? '-'}   source: ${r.effectiveSource}`);
        if (r.hasCache) {
          console.log(`  cache: ${r.fresh ? 'fresh' : r.staleGrace ? 'stale-grace (tier2.5)' : 'expired'}  fetched ${ts(r.fetchedAt)}  expires ${ts(r.expiresAt)}  refresh=${r.refreshIntervalS ?? '-'}s`);
          console.log(`  providers(${r.providerCount}): ${(r.providers ?? []).join(', ') || '-'}`);
        } else {
          console.log('  cache: none (tier3 env 语义)');
        }
        console.log(`  last fetch: ${ts(r.lastFetchAt)}${r.lastFetchError ? `  error: ${r.lastFetchError}` : ''}${r.lastAttribution ? `  attribution: ${r.lastAttribution}` : ''}`);
        break;
      }
      case 'verify': {
        const r = await configRequest(port, 'POST', '/internal/v1/config/verify') as {
          ok?: boolean; connectivity?: string; credentials?: string; decryptHealth?: string;
          cardPresent?: boolean; defaultModel?: string | null; providers?: number; message?: string;
        };
        console.log(`config verify: ${r.ok ? 'HEALTHY' : 'UNHEALTHY'}`);
        console.log(`  connectivity: ${r.connectivity}   credentials: ${r.credentials}   decrypt: ${r.decryptHealth}`);
        console.log(`  card_present: ${r.cardPresent}   default model: ${r.defaultModel ?? '-'}   providers: ${r.providers ?? 0}`);
        console.log(`  ${r.message ?? ''}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      default:
        console.error(`ERROR: unknown config subcommand '${subcommand}'. Usage: trilc config <pull|show|verify|cache show|cache clear>`);
        process.exitCode = 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED/i.test(msg)) {
      console.error(`ERROR: daemon 无响应（127.0.0.1:${port}）——先 \`trilc start\` 再试`);
    } else {
      console.error(`ERROR: ${msg}`);
    }
    process.exitCode = 1;
  }
}

async function cronRequest(port: number, method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `http://127.0.0.1:${port}${path}`;
  // F-2 同漏即同修（CEO 2026-09-29 22:05 直令；镜像分叉防复踩——本函数与
  // TriMLC cronRequest 逐字同构同漏，勘钉 2026-09-29 上午在案）：与 configRequest
  // 同构带 X-Internal-Token，daemon /internal/v1/cron/* 门 fail-closed。
  const token = process.env.TRILC_INTERNAL_TOKEN ?? '';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers['x-internal-token'] = token;
  const options: RequestInit = {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetch(url, options);
  const json = await res.json();
  if (!res.ok) {
    const err = json && typeof json === 'object' && 'error' in json ? String(json.error) : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json;
}

async function cmdCron(subcommand: string, args: string[], port: number): Promise<void> {
  switch (subcommand) {
    case 'add': {
      // Interactive or flagged add: name, schedule, prompt
      let name = '';
      let scheduleExpr = '';
      let scheduleKind: 'every' | 'cron' = 'every';
      let scheduleEveryMs = 0;
      let scheduleCron = '';
      let systemPrompt = '';
      let command = '';
      let enabled = true;

      // Parse flags; first positional arg (if --name not given) is the job name
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--name' && args[i + 1]) { name = args[++i]; }
        else if (args[i] === '--every' && args[i + 1]) { scheduleKind = 'every'; scheduleEveryMs = parseInt(args[++i], 10); }
        else if (args[i] === '--cron' && args[i + 1]) { scheduleKind = 'cron'; scheduleCron = args[++i]; }
        else if (args[i] === '--prompt' && args[i + 1]) { systemPrompt = args[++i]; }
        else if (args[i] === '--command' && args[i + 1]) { command = args[++i]; }
        else if (args[i] === '--disabled') { enabled = false; }
        else if (!args[i].startsWith('-') && !name) { name = args[i]; }
      }

      if (!name) {
        // Interactive prompt
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));
        name = await ask('Job name: ');
        if (!name.trim()) { console.error('ERROR: name is required.'); rl.close(); process.exit(1); }
        const scheduleInput = await ask('Schedule (e.g. "5m", "1h", or cron expr): ');
        scheduleExpr = scheduleInput.trim();
        if (!scheduleExpr) { console.error('ERROR: schedule is required.'); rl.close(); process.exit(1); }
        const promptInput = await ask('System prompt (optional, press Enter to skip): ');
        systemPrompt = promptInput.trim();
        rl.close();
      }

      // Parse schedule expression if interactive
      if (scheduleExpr && !scheduleEveryMs && !scheduleCron) {
        const parsed = parseHumanSchedule(scheduleExpr);
        if (parsed) {
          scheduleKind = 'every';
          scheduleEveryMs = parsed.everyMs;
        } else {
          // Assume cron expression
          scheduleKind = 'cron';
          scheduleCron = scheduleExpr;
        }
      }

      const schedule = scheduleKind === 'every'
        ? { kind: 'every' as const, everyMs: scheduleEveryMs || 3600000 }
        : { kind: 'cron' as const, expr: scheduleCron || '0 9 * * *' };

      const body = { name: name || 'Unnamed job', schedule, systemPrompt: systemPrompt || '', command: command || undefined, enabled };
      const result = await cronRequest(port, 'POST', '/internal/v1/cron/jobs', body);
      const job = (result as Record<string, unknown>).job;
      console.log('[OK] job created:', JSON.stringify(job, null, 2));
      break;
    }

    case 'list': {
      const result = await cronRequest(port, 'GET', '/internal/v1/cron/jobs');
      const data = result as { ok: boolean; jobs: Array<Record<string, unknown>>; count: number };
      if (data.jobs.length === 0) {
        console.log('No cron jobs.');
      } else {
        console.log(`\n${'ID'.padEnd(24)} ${'NAME'.padEnd(20)} ${'SCHEDULE'.padEnd(24)} ${'STATE'.padEnd(10)} ${'LAST RUN'}`);
        console.log('-'.repeat(100));
        for (const j of data.jobs) {
          const scheduleStr = typeof j.schedule === 'object' && j.schedule
            ? ((j.schedule as Record<string, unknown>).kind === 'every'
              ? `every ${(j.schedule as Record<string, unknown>).everyMs}ms`
              : (j.schedule as Record<string, unknown>).expr)
            : '?';
          console.log(`${String(j.id).slice(0, 22).padEnd(24)} ${String(j.name).slice(0, 18).padEnd(20)} ${String(scheduleStr).slice(0, 22).padEnd(24)} ${String(j.state).padEnd(10)} ${String(j.lastRunAt ?? '-').slice(0, 19)}`);
        }
        console.log(`\n${data.count} job(s)`);
      }
      break;
    }

    case 'update': {
      const jobId = args[0];
      if (!jobId) { console.error('ERROR: job ID required. Usage: trilc cron update <id> [--enable|--disable] [--prompt ...] [--schedule ...]'); process.exit(1); }
      const patch: Record<string, unknown> = {};
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--enable') { patch.enabled = true; }
        else if (args[i] === '--disable') { patch.enabled = false; }
        else if (args[i] === '--name' && args[i + 1]) { patch.name = args[++i]; }
        else if (args[i] === '--prompt' && args[i + 1]) { patch.systemPrompt = args[++i]; }
        else if (args[i] === '--command' && args[i + 1]) { patch.command = args[++i]; }
        else if (args[i] === '--every' && args[i + 1]) { patch.schedule = { kind: 'every', everyMs: parseInt(args[++i], 10) }; }
        else if (args[i] === '--cron' && args[i + 1]) { patch.schedule = { kind: 'cron', expr: args[++i] }; }
      }
      if (Object.keys(patch).length === 0) { console.error('ERROR: no patch fields. Use --enable, --disable, --name, --prompt, --every, or --cron.'); process.exit(1); }
      const result = await cronRequest(port, 'PATCH', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`, patch);
      console.log('[OK] job updated:', JSON.stringify((result as Record<string, unknown>).job, null, 2));
      break;
    }

    case 'remove': {
      const jobId = args[0];
      if (!jobId) { console.error('ERROR: job ID required. Usage: trilc cron remove <id>'); process.exit(1); }
      await cronRequest(port, 'DELETE', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`);
      console.log(`[OK] job removed: ${jobId}`);
      break;
    }

    case 'run': {
      const jobId = args[0];
      if (!jobId) { console.error('ERROR: job ID required. Usage: trilc cron run <id> [--force]'); process.exit(1); }
      const force = args.includes('--force');
      const result = await cronRequest(port, 'POST', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}/run`, { force });
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'log': {
      const jobId = args.find((a, i) => a === '--job' && args[i + 1]) ? args[args.indexOf('--job') + 1] : undefined;
      const limit = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1] || '20', 10) : 20;
      const queryString = jobId ? `?jobId=${encodeURIComponent(jobId)}&limit=${limit}` : `?limit=${limit}`;
      const result = await cronRequest(port, 'GET', `/internal/v1/cron/log${queryString}`);
      const data = result as { ok: boolean; logs: Array<Record<string, unknown>>; count: number };
      if (data.logs.length === 0) {
        console.log('No execution logs.');
      } else {
        console.log(`\n${'ID'.padEnd(6)} ${'JOB ID'.padEnd(24)} ${'STATUS'.padEnd(10)} ${'STARTED AT'.padEnd(22)} ${'DURATION'.padEnd(10)} ${'ERROR'}`);
        console.log('-'.repeat(100));
        for (const l of data.logs) {
          const duration = typeof l.durationMs === 'number' ? `${l.durationMs}ms` : '-';
          console.log(`${String(l.id).padEnd(6)} ${String(l.jobId).slice(0, 22).padEnd(24)} ${String(l.status).padEnd(10)} ${String(l.startedAt).slice(0, 20).padEnd(22)} ${duration.padEnd(10)} ${String(l.errorMessage ?? '-').slice(0, 30)}`);
        }
        console.log(`\n${data.count} log entry(s)`);
      }
      break;
    }

    case 'status': {
      const result = await cronRequest(port, 'GET', '/internal/v1/cron/status');
      const data = result as { ok: boolean; status: { running: boolean; degraded: boolean; consecutiveFailures: number; jobCount: number } };
      if (!data.ok) {
        console.error('[trilc] cron status: failed to retrieve status');
        process.exit(1);
      }
      const s = data.status;
      console.log(`Cron Engine Status:`);
      console.log(`  Running:              ${s.running ? 'yes' : 'no'}`);
      console.log(`  Degraded:             ${s.degraded ? 'YES (3+ consecutive failures)' : 'no'}`);
      console.log(`  Consecutive Failures: ${s.consecutiveFailures}`);
      console.log(`  Job Count:            ${s.jobCount}`);
      break;
    }

    default:
      console.error(`[trilc] cron: unknown subcommand: ${subcommand}`);
      console.error('Usage: trilc cron <add|list|update|remove|run|log|status>');
      process.exit(1);
  }
}

/** Parse human-readable schedule expressions like "5m", "1h", "30s" */
function parseHumanSchedule(input: string): { kind: 'every'; everyMs: number } | null {
  const match = input.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return { kind: 'every', everyMs: value * (multipliers[unit] || 60000) };
}

async function cmdDaemon(subcommand: string, port: number): Promise<void> {
  const { resolveDaemonService } = await import('./daemon/service.js');
  const service = await resolveDaemonService();
  const config = resolveDaemonConfig(port);

  switch (subcommand) {
    case 'install': {
      console.log('[trilc] daemon: installing...');
      await service.install(config);
      console.log('[OK] daemon installed.');
      break;
    }
    case 'uninstall': {
      console.log('[trilc] daemon: uninstalling...');
      await service.uninstall(config);
      console.log('[OK] daemon uninstalled.');
      break;
    }
    case 'stage': {
      const path = await service.stage(config);
      console.log(`[OK] daemon staged: ${path}`);
      break;
    }
    case 'status': {
      const state = await service.status(config);
      console.log(JSON.stringify(state, null, 2));
      break;
    }
    default:
      console.error(`[trilc] daemon: unknown subcommand: ${subcommand}`);
      console.error('Usage: trilc daemon <install|uninstall|stage|status>');
      process.exit(1);
  }
}

// ── MCP Server Management (C10) ──

async function cmdMcp(subcommand: string, args: string[], port: number): Promise<void> {
  const cwd = process.cwd();

  switch (subcommand) {
    case 'add': {
      // trilc mcp add <name> <command> [args...] [--type stdio|sse] [--url <url>] [--env KEY=VALUE] [--project]
      const serverName = args[0];
      if (!serverName) {
        console.error('Usage: trilc mcp add <name> <command> [args...] [--type stdio|sse] [--url <url>] [--env KEY=VALUE] [--project]');
        process.exit(1);
      }

      let command: string | undefined;
      const serverArgs: string[] = [];
      let type: string = 'stdio';
      let url: string | undefined;
      const env: Record<string, string> = {};
      let project = false;
      let parsingCommand = true;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--type' && args[i + 1]) {
          type = args[i + 1];
          i++;
          parsingCommand = false;
        } else if (arg === '--url' && args[i + 1]) {
          url = args[i + 1];
          i++;
          parsingCommand = false;
        } else if (arg === '--env' && args[i + 1]) {
          const kv = args[i + 1];
          const eqIdx = kv.indexOf('=');
          if (eqIdx > 0) {
            env[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
          }
          i++;
          parsingCommand = false;
        } else if (arg === '--project') {
          project = true;
          parsingCommand = false;
        } else if (parsingCommand) {
          if (!command) {
            command = arg;
          } else {
            serverArgs.push(arg);
          }
        }
      }

      if (type === 'sse') {
        // SSE servers require --url, not command
        if (!url) {
          console.error('[trilc] SSE MCP server requires --url');
          process.exit(1);
        }
      } else {
        // stdio requires a command
        if (!command) {
          console.error('[trilc] stdio MCP server requires a command');
          process.exit(1);
        }
      }

      const { addMCPServerConfig } = await import('./mcp/mcp-config.js');

      // Validate type
      const validType = type === 'sse' || type === 'streamableHttp' ? type : 'stdio';
      if (type !== 'stdio' && type !== 'sse' && type !== 'streamableHttp') {
        console.warn(`[trilc] unknown MCP type "${type}", defaulting to "stdio"`);
      }

      addMCPServerConfig({
        name: serverName,
        type: validType as 'stdio' | 'sse' | 'streamableHttp',
        command,
        args: serverArgs.length > 0 ? serverArgs : undefined,
        env: Object.keys(env).length > 0 ? env : undefined,
        url,
      }, cwd, project);

      const targetFile = project ? '.claude/mcp.json' : '.trilc/mcp.json';
      console.log(`[OK] MCP server "${serverName}" added to ${targetFile}`);
      break;
    }

    case 'remove': {
      const serverName = args[0];
      if (!serverName) {
        console.error('Usage: trilc mcp remove <name>');
        process.exit(1);
      }

      const { removeMCPServerConfig } = await import('./mcp/mcp-config.js');
      const removed = removeMCPServerConfig(serverName, cwd);
      if (removed) {
        console.log(`[OK] MCP server "${serverName}" removed`);
      } else {
        console.error(`[trilc] MCP server "${serverName}" not found in .trilc/mcp.json or .claude/mcp.json`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const json = args.includes('--json');

      const { listProjectMCPServers } = await import('./mcp/mcp-config.js');
      const servers = listProjectMCPServers(cwd);

      if (json) {
        console.log(JSON.stringify({ servers, count: servers.length }, null, 2));
        break;
      }

      if (servers.length === 0) {
        console.log('No MCP servers configured.');
        console.log('Add one: trilc mcp add <name> <command>');
        break;
      }

      // Try to get live connection status from daemon
      let connectedNames: string[] = [];
      try {
        const health = await healthCheck(port);
        if (health.ok) {
          const res = await fetch(`http://127.0.0.1:${port}/internal/v1/mcp/servers`);
          if (res.ok) {
            const data = await res.json() as { servers?: Array<{ name: string; connected: boolean }> };
            connectedNames = (data.servers ?? []).filter(s => s.connected).map(s => s.name);
          }
        }
      } catch { /* daemon not running — show config-only */ }

      console.log(`MCP Servers (${servers.length}):`);
      for (const s of servers) {
        const status = s.disabled ? 'disabled' : connectedNames.includes(s.name) ? 'connected' : 'disconnected';
        const marker = status === 'connected' ? '●' : status === 'disabled' ? '✕' : '○';
        const shortPath = s.source.replace(cwd, '.').replace(/\\/g, '/');
        console.log(`  ${marker} ${s.name} (${s.type}, ${status}) [${shortPath}]`);
      }
      break;
    }

    case 'status': {
      const serverName = args[0];
      if (!serverName) {
        console.error('Usage: trilc mcp status <name>');
        process.exit(1);
      }

      const { listProjectMCPServers } = await import('./mcp/mcp-config.js');
      const servers = listProjectMCPServers(cwd);
      const server = servers.find(s => s.name === serverName);

      if (!server) {
        console.error(`[trilc] MCP server "${serverName}" not configured`);
        process.exit(1);
      }

      // Try to get live details from daemon
      let liveInfo: { toolCount?: number; resourceCount?: number; promptCount?: number; connected?: boolean } = {};
      try {
        const res = await fetch(`http://127.0.0.1:${port}/internal/v1/mcp/servers/${encodeURIComponent(serverName)}`);
        if (res.ok) {
          liveInfo = await res.json() as typeof liveInfo;
        }
      } catch { /* daemon not running */ }

      console.log(`Name:        ${server.name}`);
      console.log(`Type:        ${server.type}`);
      if (server.command) {
        console.log(`Command:     ${server.command} ${(server.args ?? []).join(' ')}`);
      }
      if (server.url) console.log(`URL:         ${server.url}`);
      if (server.env && Object.keys(server.env).length > 0) {
        console.log('Environment:');
        for (const [k, v] of Object.entries(server.env)) {
          console.log(`  ${k}=${v}`);
        }
      }
      console.log(`Status:      ${server.disabled ? 'disabled' : liveInfo.connected ? 'connected' : 'disconnected'}`);
      if (liveInfo.toolCount !== undefined) console.log(`Tools:       ${liveInfo.toolCount}`);
      if (liveInfo.resourceCount !== undefined) console.log(`Resources:   ${liveInfo.resourceCount}`);
      if (liveInfo.promptCount !== undefined) console.log(`Prompts:     ${liveInfo.promptCount}`);
      console.log(`Config:      ${server.source.replace(cwd, '.').replace(/\\/g, '/')}`);
      break;
    }

    default:
      console.error(`[trilc] mcp: unknown subcommand: ${subcommand}`);
      console.error('Usage: trilc mcp <add|remove|list|status>');
      process.exit(1);
  }
}

// ── TriModel 直连恢复梯命令族（波③ 范围②④）──

/** 旧 bin 名调用识别（argv[1] basename 词干；覆盖 POSIX symlink 与直调命名面）。
 * 已知限制（技术债如实标记）：Windows npm .cmd/.ps1 shim 的 argv[1]=真实 cli.js 路径，
 * 调名不达子进程——该面弃用提示候 M3 删旧键窗随文档收口，不静默不假装。 */
function legacyBinInvocation(oldName: string): boolean {
  const raw = process.argv[1] ?? '';
  const stem = (raw.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|ps1|exe|js|cjs|mjs)$/, '');
  return stem === oldName;
}

/** daemon healthz 探活回调（core status 实时探活用；回调型注入=core 零端点知识）。 */
// 探针端口取 TRILC_PORT env（watchdog→daemon 既有契约键；部署态注入部署端口即自动对位），
// 缺省回退 CLI 缺省端口；healthz body 的 service 身份校验兜底——端口上跑的若非本 bin 服务
// 如实报错位而非误报健康（2026-09-26 实勘：本机 8711=trirlc / 8713=trimlc，代码缺省与部署位分歧）。
function daemonProbePort(cliPort: number): number {
  const envPort = Number(process.env.TRILC_PORT);
  return Number.isInteger(envPort) && envPort > 0 ? envPort : cliPort;
}

function daemonHealthProbe(cliPort: number, expectedService: string): { name: string; probe: () => Promise<ProbeReading> } {
  const port = daemonProbePort(cliPort);
  return {
    name: `daemon-healthz:${port}`,
    probe: async () => {
      const h = await healthCheck(port);
      if (!h.ok) return { up: false, detail: 'healthz 不可达' };
      const svc = (h.data as { service?: string } | undefined)?.service;
      if (svc && svc !== expectedService) {
        return { up: false, detail: `端口 ${port} 上 service=${svc} 非 ${expectedService}（部署端口错位嫌疑；可在 TRILC_PORT 注入部署端口）` };
      }
      return { up: true, detail: 'healthz 200' };
    },
  };
}

/** `model` 父命令：TriCode core runCli 派发（daemon 家族命令零触碰；退出码直通进程退出码）。
 * CoreIO 注入：who=审计身份（门⑤ 落行）、machine=四象限路由键（joint-plan 问3 21:44 勘正版：
 * trirlc=本机 Win·R 本地域）、probes=本 daemon healthz 值面。 */
async function runModelCommand(restArgs: string[], port: number): Promise<void> {
  const io = makeCoreIO({
    who: 'trirlc-cmd',
    binName: 'trirlc',
    machine: 'local-r',
    probes: [daemonHealthProbe(port, 'trirlc')],
    l2FlagPath: defaultL2FlagPath(),
  });
  process.exitCode = await runCli(restArgs, io);
}

// ── Entry ──
const { command, port, serviceName, displayName, agent, resume, listSessions, permissionMode, allowRules, denyRules, addDirs, printMode } = parseArgs(process.argv.slice(2));

(async () => {
  // 正名过渡期（范围④）：旧名调用→单行弃用引导（stderr，不阻塞），随后照常执行。
  if (legacyBinInvocation('trilc')) {
    console.error('[trilc] 提示：命令已正名为 trirlc（trilc=过渡期别名，M3 版本移除）；本次照常执行。');
  }
  switch (command) {
    case 'model':
      await runModelCommand(process.argv.slice(3), port);
      break;
    case 'config': {
      // LG-058 N4（方案 §5.1）：config pull|show|verify|cache show|cache clear
      const subcommand = process.argv[3] ?? 'show';
      await cmdConfig(subcommand, port);
      break;
    }
    case 'start':
      await cmdStart(port, permissionMode, allowRules, denyRules, addDirs, printMode);
      break;
    case 'stop':
      await cmdStop(port);
      break;
    case 'restart':
      await cmdRestart(port);
      break;
    case 'status':
      await cmdStatus(port);
      break;
    case 'run':
      await cmdRun(port, permissionMode, allowRules, denyRules, addDirs, printMode);
      break;
    case 'chat':
      await cmdChat(port, agent, resume, permissionMode, allowRules, denyRules, addDirs, printMode);
      break;
    case 'company': {
      // REQ-017: debug reset — wipe company state + workspace skeleton for re-onboarding
      const sub = process.argv[3];
      if (sub === 'reset') {
        const { CompanyInitState } = await import('./company/init-state.js');
        const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
        const init = new CompanyInitState(dataDir);
        await init.reset();
        console.log('[trilc] company state reset — re-onboarding will start');

        // Clean onboarding-assembled skeleton in the workspace — PRECISE boundary.
        // Only company-skeleton artifacts are removed; project assets (docs/product,
        // docs/engineering, etc.) must be preserved (CTO review: reset boundary bug).
        const wsRoot = process.env.TRILC_PROJECT_ROOT ?? process.env.TRILC_CWD ?? process.cwd();
        const { rm } = await import('node:fs/promises');
        const { join, resolve } = await import('node:path');
        const target = resolve(wsRoot);

        // Safety: never operate on system dirs or Program Files.
        const sysGuard = /^[A-Za-z]:[\\/]windows(?:[\\/]|$)|^[A-Za-z]:[\\/]program files(?:[\\/]|$)/i;
        if (sysGuard.test(target) || target === 'C:\\Windows\\System32' || target.endsWith('\\System32')) {
          console.error(`[trilc] REFUSED: refusing to reset workspace ${target} (system directory)`);
          process.exit(1);
        }

        const artifacts = [
          join('.claude', 'agents'),
          join('docs', 'registry', 'company-state.json'),
          join('docs', 'registry', 'business-state.md'),
          'AGENTS.md',
        ];
        for (const rel of artifacts) {
          const p = join(target, rel);
          try {
            await rm(p, { recursive: true, force: true });
            console.log(`[trilc] skeleton cleaned: ${p}`);
          } catch { /* best-effort */ }
        }

        // Prune empty skeleton dirs (deepest first). NEVER touch non-empty dirs —
        // they may hold project assets.
        const { readdir } = await import('node:fs/promises');
        for (const dir of [join('docs', 'registry'), '.claude', 'docs']) {
          const p = join(target, dir);
          try {
            const entries = await readdir(p);
            if (entries.length === 0) {
              await rm(p, { recursive: true, force: true });
              console.log(`[trilc] pruned empty dir: ${p}`);
            }
          } catch { /* dir may not exist */ }
        }
        console.log(`[trilc] company skeleton reset — .git preserved for audit/rollback`);
      } else {
        console.error('Usage: trilc company reset');
        process.exit(1);
      }
      break;
    }
    case 'session': {
      const sub = process.argv[3];
      if (sub === 'compact' && process.argv[4]) {
        const sessionId = process.argv[4];
        try {
          const res = await fetch(`http://127.0.0.1:${port}/internal/v1/sessions/${sessionId}/compact`, { method: 'POST' });
          const json = await res.json() as { ok?: boolean; error?: string; message?: string; summary?: string; tokensRemoved?: number; originalMessageCount?: number };
          if (json.ok) {
            console.log(`[OK] Session ${sessionId} compacted:`);
            console.log(`     Original messages: ${json.originalMessageCount}`);
            console.log(`     Tokens removed: ~${json.tokensRemoved}`);
            console.log(`     Summary length: ${json.summary?.length ?? 0} chars`);
          } else {
            console.error(`[trilc] compact failed: ${json.message ?? json.error ?? 'unknown'}`);
            process.exit(1);
          }
        } catch (err) {
          console.error(`[trilc] compact failed: ${(err as Error).message}`);
          process.exit(1);
        }
      } else {
        console.error('Usage: trilc session compact <id>');
        process.exit(1);
      }
      break;
    }
    case 'list-sessions':
      await cmdListSessions(port);
      break;
    case 'install-service':
      await cmdInstallService(serviceName, displayName);
      break;
    case 'uninstall-service':
      await cmdUninstallService(serviceName);
      break;
    case 'install-regrun':
      await cmdInstallRegRun();
      break;
    case 'uninstall-regrun':
      await cmdUninstallRegRun();
      break;
    case 'daemon': {
      const subcommand = process.argv[3] ?? 'status';
      await cmdDaemon(subcommand, port);
      break;
    }
    case 'cron': {
      const subcommand = process.argv[3] ?? 'list';
      const subArgs = process.argv.slice(4);
      await cmdCron(subcommand, subArgs, port);
      break;
    }
    case 'mcp': {
      const subcommand = process.argv[3] ?? 'list';
      const subArgs = process.argv.slice(4);
      await cmdMcp(subcommand, subArgs, port);
      break;
    }
    case 'watchdog': {
      const { resolveWatchdogConfig, createWatchdog } = await import('./daemon/watchdog.js');
      const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
      const wdConfig = resolveWatchdogConfig(port, dataDir);
      const watchdog = createWatchdog(wdConfig);

      console.log(`[trilc] watchdog starting (port=${wdConfig.port}, dataDir=${wdConfig.dataDir})`);
      console.log(`[trilc] watchdog will restart the daemon up to 5 times per 10-minute window`);
      console.log(`[trilc] backoff: 1s→2s→4s→8s→16s→32s cap, reset after 60s stable uptime`);
      console.log(`[trilc] child entry: ${wdConfig.entryScript}`);

      // Handle parent process signals
      const cleanup = () => {
        watchdog.stop();
        process.exit(0);
      };
      process.on('SIGTERM', cleanup);
      process.on('SIGINT', cleanup);

      const started = watchdog.start();
      if (!started) {
        console.error('[trilc] watchdog failed to start child process');
        process.exit(1);
      }

      // Keep the watchdog process alive; it monitors the child via event handlers
      // The process stays alive because child process events keep the event loop active
      break;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`[trilc] unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
})().catch((err) => {
  console.error('[trilc] CLI error:', err);
  process.exit(1);
});