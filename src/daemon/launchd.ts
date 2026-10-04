// ── TriLC Daemon — macOS launchd ──
// Phase 3: macOS launchd plist registration and lifecycle management.
// Pattern adapted from vendor/openclaw/src/daemon/launchd.ts and schtasks.ts.
//
// macOS 13+ (Ventura) uses `launchctl bootstrap` / `bootout` instead of
// the deprecated `load` / `unload`. We target the modern API with a
// graceful fallback to the legacy commands on older macOS releases.
//
// Log prefix: [trilc:daemon]

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TRILC_LAUNCHD_LABEL } from "./constants.js";
import type {
  TriRLCDaemonService,
  TriRLCDaemonServiceConfig,
  DaemonServiceState,
  DaemonServiceStartResult,
} from "./service.js";

const LOG_PREFIX = "[trilc:daemon]";

// ── Path helpers ──

function resolvePlistDir(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

function resolvePlistPath(): string {
  return path.join(resolvePlistDir(), TRILC_LAUNCHD_LABEL + ".plist");
}

function resolveLogDir(config: TriRLCDaemonServiceConfig): string {
  return path.join(config.dataDir, "daemon");
}

function getCurrentUserUid(): number {
  try {
    return os.userInfo().uid;
  } catch {
    return -1;
  }
}

// ── plist generation ──

function buildPlist(config: TriRLCDaemonServiceConfig): string {
  const programArgs = [config.nodeBin, config.entryScript, ...config.programArgs];
  const envVars: Record<string, string> = config.env ?? {};

  const logDir = resolveLogDir(config);
  const stdoutPath = path.join(logDir, "trilc-stdout.log");
  const stderrPath = path.join(logDir, "trilc-stderr.log");

  const envEntries = Object.entries(envVars)
    .filter(function (_a) { var _b = _a[1]; return _b !== undefined && _b !== null; })
    .map(function (_a) { var _b = _a[0], _c = _a[1]; return "    <key>" + escapeXml(_b) + "</key>\n    <string>" + escapeXml(_c) + "</string>"; })
    .join("\n");

  const programArgEntries = programArgs
    .map(function (arg) { return "    <string>" + escapeXml(arg) + "</string>"; })
    .join("\n");

  var plist = '<?xml version="1.0" encoding="UTF-8"?>\n';
  plist += '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
  plist += '<plist version="1.0">\n';
  plist += '<dict>\n';
  plist += '  <key>Label</key>\n';
  plist += '  <string>' + escapeXml(TRILC_LAUNCHD_LABEL) + '</string>\n';
  plist += '  <key>ProgramArguments</key>\n';
  plist += '  <array>\n';
  plist += programArgEntries + '\n';
  plist += '  </array>\n';
  plist += '  <key>WorkingDirectory</key>\n';
  plist += '  <string>' + escapeXml(config.cwd) + '</string>\n';
  plist += '  <key>RunAtLoad</key>\n';
  plist += '  <true/>\n';
  plist += '  <key>KeepAlive</key>\n';
  plist += '  <true/>\n';
  plist += '  <key>StandardOutPath</key>\n';
  plist += '  <string>' + escapeXml(stdoutPath) + '</string>\n';
  plist += '  <key>StandardErrorPath</key>\n';
  plist += '  <string>' + escapeXml(stderrPath) + '</string>\n';
  plist += '  <key>EnvironmentVariables</key>\n';
  plist += '  <dict>\n';
  plist += envEntries + '\n';
  plist += '  </dict>\n';
  plist += '</dict>\n';
  plist += '</plist>\n';
  return plist;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── spawn helper ──

function execLaunchctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(function (resolve) {
    var child = spawn("launchctl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    var stdout = "";
    var stderr = "";
    child.stdout?.on("data", function (d: Buffer) { stdout += d.toString(); });
    child.stderr?.on("data", function (d: Buffer) { stderr += d.toString(); });
    child.on("close", function (code) { resolve({ code: code ?? 1, stdout: stdout, stderr: stderr }); });
    child.on("error", function (err) { resolve({ code: 1, stdout: stdout, stderr: err.message }); });
  });
}

async function isPlistFilePresent(): Promise<boolean> {
  try {
    await fs.access(resolvePlistPath());
    return true;
  } catch {
    return false;
  }
}

// ── Service Operations ──

async function stageService(config: TriRLCDaemonServiceConfig): Promise<string> {
  var plistDir = resolvePlistDir();
  await fs.mkdir(plistDir, { recursive: true });

  var logDir = resolveLogDir(config);
  await fs.mkdir(logDir, { recursive: true });

  var plistPath = resolvePlistPath();
  var plist = buildPlist(config);
  await fs.writeFile(plistPath, plist, "utf8");
  console.log(LOG_PREFIX + " staged launchd plist: " + plistPath);
  return plistPath;
}

async function installService(config: TriRLCDaemonServiceConfig): Promise<void> {
  var plistPath = await stageService(config);
  var uid = getCurrentUserUid();

  if (uid < 0) {
    throw new Error(LOG_PREFIX + " launchd: cannot determine user UID");
  }

  var serviceTarget = "gui/" + uid;

  // Bootout first if already registered (to avoid duplicate errors)
  await execLaunchctl(["bootout", serviceTarget, plistPath]);

  var bootstrapRes = await execLaunchctl(["bootstrap", serviceTarget, plistPath]);
  if (bootstrapRes.code !== 0) {
    // Fallback: try legacy launchctl load for older macOS
    var loadRes = await execLaunchctl(["load", "-w", plistPath]);
    if (loadRes.code !== 0) {
      var detail = loadRes.stderr || loadRes.stdout;
      throw new Error("launchctl bootstrap/load failed: " + detail.trim());
    }
  }

  // Ensure the service is started
  await execLaunchctl(["start", TRILC_LAUNCHD_LABEL]);
  console.log(LOG_PREFIX + " installed launchd service: " + TRILC_LAUNCHD_LABEL);
}

async function uninstallService(config: TriRLCDaemonServiceConfig): Promise<void> {
  var plistPath = resolvePlistPath();
  var plistExists = await isPlistFilePresent();

  if (plistExists) {
    var uid = getCurrentUserUid();
    var serviceTarget = uid >= 0 ? "gui/" + uid : null;

    // Stop the service first
    await execLaunchctl(["stop", TRILC_LAUNCHD_LABEL]);

    if (serviceTarget) {
      var bootoutRes = await execLaunchctl(["bootout", serviceTarget, plistPath]);
      if (bootoutRes.code !== 0) {
        // Try legacy unload
        await execLaunchctl(["unload", "-w", plistPath]);
      }
    }
  }

  // Remove plist file
  try { await fs.unlink(resolvePlistPath()); } catch { /* ignore */ }
  console.log(LOG_PREFIX + " uninstalled launchd service: " + TRILC_LAUNCHD_LABEL);
}

async function stopService(config: TriRLCDaemonServiceConfig): Promise<void> {
  var plistPath = resolvePlistPath();
  var plistExists = await isPlistFilePresent();

  if (plistExists) {
    var uid = getCurrentUserUid();
    var serviceTarget = uid >= 0 ? "gui/" + uid : null;

    if (serviceTarget) {
      // bootout stops AND unregisters; re-bootstrap happens on restart.
      var bootoutRes = await execLaunchctl(["bootout", serviceTarget, plistPath]);
      if (bootoutRes.code !== 0) {
        // Fallback: just try to stop the running instance
        await execLaunchctl(["stop", TRILC_LAUNCHD_LABEL]);
      }
    }
  }
  console.log(LOG_PREFIX + " stopped launchd service: " + TRILC_LAUNCHD_LABEL);
}

async function restartService(config: TriRLCDaemonServiceConfig): Promise<DaemonServiceStartResult> {
  var plistExists = await isPlistFilePresent();
  if (!plistExists) {
    var state = await readServiceState(config);
    return { outcome: "missing-install", state: state };
  }

  await stopService(config);

  // Small delay to let process exit
  await new Promise(function (r) { return setTimeout(r, 1000); });

  // Re-bootstrap
  var uid = getCurrentUserUid();
  if (uid < 0) {
    throw new Error(LOG_PREFIX + " launchd: cannot determine user UID");
  }
  var serviceTarget = "gui/" + uid;
  var plistPath = resolvePlistPath();

  var bootstrapRes = await execLaunchctl(["bootstrap", serviceTarget, plistPath]);
  if (bootstrapRes.code !== 0) {
    // Fallback: legacy load
    var loadRes = await execLaunchctl(["load", "-w", plistPath]);
    if (loadRes.code !== 0) {
      throw new Error("launchctl bootstrap/load failed: " + (loadRes.stderr || loadRes.stdout).trim());
    }
  }

  await execLaunchctl(["start", TRILC_LAUNCHD_LABEL]);

  var stateAfter = await readServiceState(config);
  console.log(LOG_PREFIX + " restarted launchd service: " + TRILC_LAUNCHD_LABEL);
  return { outcome: "started", state: stateAfter };
}

async function readServiceState(config: TriRLCDaemonServiceConfig): Promise<DaemonServiceState> {
  var plistExists = await isPlistFilePresent();
  var listRes = await execLaunchctl(["list", TRILC_LAUNCHD_LABEL]);

  // launchctl list <label> JSON-like output:
  //   { "PID" = 12345; "LastExitStatus" = 0; }
  var isLoaded = listRes.code === 0 && listRes.stdout.length > 0;
  var running = false;
  var pid: number | undefined;

  if (isLoaded) {
    var pidMatch = listRes.stdout.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) {
      var parsedPid = parseInt(pidMatch[1], 10);
      if (!isNaN(parsedPid) && parsedPid > 0) {
        pid = parsedPid;
        try {
          process.kill(parsedPid, 0);
          running = true;
        } catch {
          running = false;
        }
      }
    }
  }

  return {
    installed: plistExists,
    loaded: isLoaded,
    running: running,
    label: TRILC_LAUNCHD_LABEL,
    command: {
      programArguments: [config.nodeBin, config.entryScript, ...config.programArgs],
      workingDirectory: config.cwd,
      environment: config.env ?? {},
    },
    runtime: {
      status: running ? "running" : isLoaded ? "stopped" : "unknown",
      ...(pid ? { pid: pid } : {}),
    },
  };
}

async function isServiceLoaded(_config: TriRLCDaemonServiceConfig): Promise<boolean> {
  var listRes = await execLaunchctl(["list", TRILC_LAUNCHD_LABEL]);
  return listRes.code === 0 && listRes.stdout.length > 0;
}

// ── Factory ──

export function createLaunchdService(): TriRLCDaemonService {
  return {
    stage: stageService,
    install: installService,
    uninstall: uninstallService,
    stop: stopService,
    restart: restartService,
    status: readServiceState,
    isLoaded: isServiceLoaded,
  };
}
