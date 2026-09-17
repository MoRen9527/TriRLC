// ── TriLC Daemon — Windows schtasks ──
// Phase 2: Windows Scheduled Task registration via schtasks.exe.
// Pattern adapted from vendor/openclaw/src/daemon/schtasks.ts.
//
// Log prefix: [trilc:daemon]

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { TRILC_TASK_NAME } from "./constants.js";
import type {
  TriLCDaemonService,
  TriLCDaemonServiceConfig,
  DaemonServiceState,
  DaemonServiceStartResult,
} from "./service.js";

const LOG_PREFIX = "[trilc:daemon]";

function resolveStateDir(config: TriLCDaemonServiceConfig): string {
  return path.join(config.dataDir, "daemon");
}

function resolveTaskScriptPath(config: TriLCDaemonServiceConfig): string {
  return path.join(resolveStateDir(config), "trilc-daemon.cmd");
}

function resolveTaskName(config: TriLCDaemonServiceConfig): string {
  return config.label?.trim() || TRILC_TASK_NAME;
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/g.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quoteSchtasksArg(value: string): string {
  if (!/[ \t"]/g.test(value)) return value;
  return `"${value.replace(/"/g, '\\"')}"`;
}

function resolveTaskUser(): string | null {
  const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME;
  if (!username) return null;
  if (username.includes("\\")) return username;
  const domain = process.env.USERDOMAIN;
  return domain ? `${domain}\\${username}` : username;
}

function buildTaskScript(config: TriLCDaemonServiceConfig): string {
  const lines: string[] = ["@echo off"];
  const label = config.label || TRILC_TASK_NAME;
  // 纯 ASCII（装后验收①）：em-dash 在 GBK cmd.exe 下尾字节解析成 "m"
  // 破坏 rem 行 → 下一行被吞/杂音。rem 行严禁非 ASCII。
  lines.push(`rem ${label} - TriMetaverse Local Controller`);
  lines.push(`cd /d ${quoteCmdArg(config.cwd)}`);
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!value) continue;
      lines.push(`set ${key}=${value}`);
    }
  }
  const allArgs = [config.entryScript, ...config.programArgs];
  const command = [quoteCmdArg(config.nodeBin), ...allArgs.map(quoteCmdArg)].join(" ");
  // r19 修复：cmd 层不做输出重定向——日志捕获由 daemon 层 stdio append
  // 负责（cli.js start 的 spawn fd）。两层同文件双 open 在 Windows 触发
  // EBUSY 文件锁（schtasks 实例自锁起不来）。
  lines.push(command);
  return `${lines.join("\r\n")}\r\n`;
}

function execSchtasks(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("schtasks.exe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
  });
}

// ── Service Operations ──

async function isTaskRegistered(config: TriLCDaemonServiceConfig): Promise<boolean> {
  const taskName = resolveTaskName(config);
  const res = await execSchtasks(["/Query", "/TN", taskName]);
  return res.code === 0;
}

async function readTaskCommand(config: TriLCDaemonServiceConfig): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
} | null> {
  const scriptPath = resolveTaskScriptPath(config);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("@echo") || line.toLowerCase().startsWith("rem ")) continue;
      const lower = line.toLowerCase();
      if (lower.startsWith("set ")) {
        const eq = line.indexOf("=", 4);
        if (eq > 0) {
          environment[line.slice(4, eq).trim()] = line.slice(eq + 1).trim();
        }
        continue;
      }
      if (lower.startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) return null;
    return {
      programArguments: [commandLine],
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    };
  } catch {
    return null;
  }
}

async function readTaskRuntime(config?: TriLCDaemonServiceConfig): Promise<{
  status: "running" | "stopped" | "unknown";
  pid?: number;
}> {
  // Try the PID file first (now self-registered by the daemon — REQ-018)
  if (config) {
    // 2026-09-18 端口命名空间：schtasks 任务绑定的就是本 daemon 实例——有
    // config.port 用新代文件，legacy 兜底（readPid 兼容读一版）。
    const { readPid } = await import("../pidfile.js");
    if (typeof config.port === "number") {
      const pidFromPort = await readPid(config.port);
      if (pidFromPort !== null) {
        try {
          process.kill(pidFromPort, 0);
          return { status: "running", pid: pidFromPort };
        } catch {
          /* dead — fall through to legacy */
        }
      }
    }
    const { PID_FILE } = await import("../paths.js");
    const pidFile = PID_FILE;
    try {
      const content = await fs.readFile(pidFile, "utf-8");
      const pid = parseInt(content.trim(), 10);
      if (!isNaN(pid) && pid > 0) {
        // Verify process is alive
        try {
          process.kill(pid, 0);
          return { status: "running", pid };
        } catch {
          // PID file exists but process dead => stale
          return { status: "stopped" };
        }
      }
    } catch {
      // PID file doesn't exist
    }
  }

  // Fallback: query schtasks for task state
  if (config) {
    const taskName = resolveTaskName(config);
    try {
      const res = await execSchtasks(["/Query", "/TN", taskName, "/FO", "CSV", "/NH"]);
      if (res.code === 0 && res.stdout.includes(taskName)) {
        // Extract status from CSV
        const fields = res.stdout.split(",");
        // Status is typically the 3rd field in CSV output
        const status = fields[2]?.trim();
        if (status === "Running") {
          return { status: "running" };
        } else if (status === "Ready") {
          return { status: "stopped" };
        }
      }
    } catch {
      // ignore
    }
  }

  return { status: "unknown" };
}

async function stageService(config: TriLCDaemonServiceConfig): Promise<string> {
  const stateDir = resolveStateDir(config);
  await fs.mkdir(stateDir, { recursive: true });
  const scriptPath = resolveTaskScriptPath(config);
  const script = buildTaskScript(config);
  await fs.writeFile(scriptPath, script, "utf8");
  console.log(`${LOG_PREFIX} staged task script: ${scriptPath}`);
  return scriptPath;
}

async function installService(config: TriLCDaemonServiceConfig): Promise<void> {
  const scriptPath = await stageService(config);
  const taskName = resolveTaskName(config);
  const quotedScript = quoteSchtasksArg(scriptPath);

  const baseArgs = [
    "/Create", "/F",
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/TN", taskName,
    "/TR", quotedScript,
  ];

  const taskUser = resolveTaskUser();
  let result = await execSchtasks(
    taskUser ? [...baseArgs, "/RU", taskUser, "/NP", "/IT"] : baseArgs,
  );

  if (result.code !== 0 && taskUser) {
    result = await execSchtasks(baseArgs);
  }

  if (result.code !== 0) {
    const detail = result.stderr || result.stdout;
    throw new Error(`schtasks create failed: ${detail}`.trim());
  }

  await execSchtasks(["/Run", "/TN", taskName]);
  console.log(`${LOG_PREFIX} installed scheduled task: ${taskName}`);
}

async function uninstallService(config: TriLCDaemonServiceConfig): Promise<void> {
  const taskName = resolveTaskName(config);
  const taskExists = await isTaskRegistered(config);

  if (taskExists) {
    const result = await execSchtasks(["/Delete", "/F", "/TN", taskName]);
    if (result.code !== 0) {
      console.warn(`${LOG_PREFIX} schtasks delete warning: ${result.stderr || result.stdout}`.trim());
    }
    console.log(`${LOG_PREFIX} uninstalled scheduled task: ${taskName}`);
  }

  const scriptPath = resolveTaskScriptPath(config);
  try { await fs.unlink(scriptPath); } catch { /* ignore */ }

  const stateDir = resolveStateDir(config);
  try { await fs.rmdir(stateDir); } catch { /* ignore */ }
}

async function stopService(config: TriLCDaemonServiceConfig): Promise<void> {
  const taskName = resolveTaskName(config);
  const taskExists = await isTaskRegistered(config);

  if (taskExists) {
    const result = await execSchtasks(["/End", "/TN", taskName]);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).toLowerCase();
      if (!detail.includes("not running")) {
        console.warn(`${LOG_PREFIX} schtasks end warning: ${result.stderr || result.stdout}`.trim());
      }
    }
  }
  console.log(`${LOG_PREFIX} stopped scheduled task: ${taskName}`);
}

async function restartService(config: TriLCDaemonServiceConfig): Promise<DaemonServiceStartResult> {
  const taskName = resolveTaskName(config);
  const taskExists = await isTaskRegistered(config);

  if (!taskExists) {
    const state = await readServiceState(config);
    return { outcome: "missing-install", state };
  }

  await execSchtasks(["/End", "/TN", taskName]);
  await new Promise((r) => setTimeout(r, 1000));

  const result = await execSchtasks(["/Run", "/TN", taskName]);
  if (result.code !== 0) {
    throw new Error(`schtasks run failed: ${result.stderr || result.stdout}`.trim());
  }

  const state = await readServiceState(config);
  console.log(`${LOG_PREFIX} restarted scheduled task: ${taskName}`);
  return { outcome: "started", state };
}

async function readServiceState(config: TriLCDaemonServiceConfig): Promise<DaemonServiceState> {
  const taskName = resolveTaskName(config);
  const [installed, loaded, command, runtime] = await Promise.all([
    isTaskRegistered(config).catch(() => false),
    isTaskRegistered(config).catch(() => false),
    readTaskCommand(config).catch(() => null),
    readTaskRuntime(config).catch(() => null),
  ]);

  return {
    installed,
    loaded,
    running: runtime?.status === "running",
    label: taskName,
    command: command
      ? {
          programArguments: command.programArguments,
          ...(command.workingDirectory ? { workingDirectory: command.workingDirectory } : {}),
          ...(command.environment ? { environment: command.environment } : {}),
        }
      : null,
    runtime: runtime ?? { status: "unknown" },
  };
}

// ── Factory ──

export function createSchtasksService(): TriLCDaemonService {
  return {
    stage: stageService,
    install: installService,
    uninstall: uninstallService,
    stop: stopService,
    restart: restartService,
    status: readServiceState,
    isLoaded: isTaskRegistered,
  };
}
