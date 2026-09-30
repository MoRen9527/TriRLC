// ── TriLC Daemon — Linux systemd ──
// Phase 3: Linux systemd user unit registration and lifecycle management.
// Pattern adapted from vendor/openclaw/src/daemon/systemd.ts and schtasks.ts.
//
// Uses user-scoped systemd (systemctl --user) — no root/sudo required.
// Unit file staged at ~/.config/systemd/user/trilc.service.
//
// Log prefix: [trilc:daemon]

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TRILC_SYSTEMD_UNIT } from "./constants.js";
import type {
  TriRLCDaemonService,
  TriRLCDaemonServiceConfig,
  DaemonServiceState,
  DaemonServiceStartResult,
} from "./service.js";

const LOG_PREFIX = "[trilc:daemon]";

// ── Path helpers ──

function resolveUnitDir(): string {
  return path.join(os.homedir(), ".config", "systemd", "user");
}

function resolveUnitPath(): string {
  return path.join(resolveUnitDir(), TRILC_SYSTEMD_UNIT);
}

// ── Unit file generation ──

function buildUnitFile(config: TriRLCDaemonServiceConfig): string {
  const execStart = [config.nodeBin, config.entryScript, ...config.programArgs]
    .map((a) => (/\s/.test(a) ? `"${a}"` : a))
    .join(" ");

  const envVars = config.env ?? {};
  const envLines = Object.entries(envVars)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");

  const lines = [
    "[Unit]",
    `Description=TriMetaverse Local Controller (TriLC)`,
    `Documentation=https://github.com/MoRen9527/TriLC`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execStart}`,
    `WorkingDirectory=${config.cwd}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "",
  ];

  if (envLines) {
    lines.push(envLines, "");
  }

  lines.push(
    "[Install]",
    "WantedBy=default.target",
    "",
  );

  return lines.join("\n");
}

// ── spawn helper ──

function execSystemctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("systemctl", ["--user", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: err.message }));
  });
}

async function isUnitFilePresent(): Promise<boolean> {
  try {
    await fs.access(resolveUnitPath());
    return true;
  } catch {
    return false;
  }
}

// ── Service Operations ──

async function stageService(config: TriRLCDaemonServiceConfig): Promise<string> {
  const unitDir = resolveUnitDir();
  await fs.mkdir(unitDir, { recursive: true });

  const unitPath = resolveUnitPath();
  const unit = buildUnitFile(config);
  await fs.writeFile(unitPath, unit, "utf8");
  console.log(`${LOG_PREFIX} staged systemd unit: ${unitPath}`);
  return unitPath;
}

async function installService(config: TriRLCDaemonServiceConfig): Promise<void> {
  await stageService(config);

  // Reload daemon to pick up the new unit file
  const reloadRes = await execSystemctl(["daemon-reload"]);
  if (reloadRes.code !== 0) {
    const detail = reloadRes.stderr || reloadRes.stdout;
    throw new Error(`systemctl daemon-reload failed: ${detail}`.trim());
  }

  // Enable for auto-start on login
  const enableRes = await execSystemctl(["enable", TRILC_SYSTEMD_UNIT]);
  if (enableRes.code !== 0) {
    const detail = enableRes.stderr || enableRes.stdout;
    console.warn(`${LOG_PREFIX} systemctl enable warning: ${detail}`.trim());
  }

  // Start the service
  const startRes = await execSystemctl(["start", TRILC_SYSTEMD_UNIT]);
  if (startRes.code !== 0) {
    const detail = startRes.stderr || startRes.stdout;
    throw new Error(`systemctl start failed: ${detail}`.trim());
  }

  console.log(`${LOG_PREFIX} installed systemd service: ${TRILC_SYSTEMD_UNIT}`);
}

async function uninstallService(_config: TriRLCDaemonServiceConfig): Promise<void> {
  const unitExists = await isUnitFilePresent();

  if (unitExists) {
    // Stop the service
    await execSystemctl(["stop", TRILC_SYSTEMD_UNIT]);

    // Disable auto-start
    await execSystemctl(["disable", TRILC_SYSTEMD_UNIT]);
  }

  // Reload to clear the removed unit
  await execSystemctl(["daemon-reload"]);

  // Remove unit file
  try { await fs.unlink(resolveUnitPath()); } catch { /* ignore */ }
  console.log(`${LOG_PREFIX} uninstalled systemd service: ${TRILC_SYSTEMD_UNIT}`);
}

async function stopService(_config: TriRLCDaemonServiceConfig): Promise<void> {
  const stopRes = await execSystemctl(["stop", TRILC_SYSTEMD_UNIT]);
  if (stopRes.code !== 0) {
    const detail = (stopRes.stderr || stopRes.stdout).toLowerCase();
    // "not loaded" or "not running" are non-fatal
    if (!detail.includes("not loaded") && !detail.includes("not running")) {
      console.warn(`${LOG_PREFIX} systemctl stop warning: ${stopRes.stderr || stopRes.stdout}`.trim());
    }
  }
  console.log(`${LOG_PREFIX} stopped systemd service: ${TRILC_SYSTEMD_UNIT}`);
}

async function restartService(config: TriRLCDaemonServiceConfig): Promise<DaemonServiceStartResult> {
  const unitExists = await isUnitFilePresent();
  if (!unitExists) {
    const state = await readServiceState(config);
    return { outcome: "missing-install", state };
  }

  const restartRes = await execSystemctl(["restart", TRILC_SYSTEMD_UNIT]);
  if (restartRes.code !== 0) {
    const detail = restartRes.stderr || restartRes.stdout;
    throw new Error(`systemctl restart failed: ${detail}`.trim());
  }

  const state = await readServiceState(config);
  console.log(`${LOG_PREFIX} restarted systemd service: ${TRILC_SYSTEMD_UNIT}`);
  return { outcome: "started", state };
}

async function readServiceState(config: TriRLCDaemonServiceConfig): Promise<DaemonServiceState> {
  const unitExists = await isUnitFilePresent();

  // Query ActiveState and MainPID in one call
  const showRes = await execSystemctl([
    "show", TRILC_SYSTEMD_UNIT,
    "--property=ActiveState",
    "--property=MainPID",
    "--property=SubState",
  ]);

  let running = false;
  let pid: number | undefined;
  let loaded = false;

  if (showRes.code === 0) {
    const activeMatch = showRes.stdout.match(/^ActiveState=(.+)$/m);
    const activeState = activeMatch ? activeMatch[1].trim() : "";

    // ActiveState=active means the service is running
    // ActiveState=inactive means stopped but installed
    // ActiveState=failed means it exited with error
    if (activeState === "active") {
      running = true;
      loaded = true;
    } else if (activeState === "inactive" || activeState === "failed") {
      loaded = true;
    }

    if (running) {
      const pidMatch = showRes.stdout.match(/^MainPID=(\d+)$/m);
      if (pidMatch) {
        const parsedPid = parseInt(pidMatch[1], 10);
        if (!isNaN(parsedPid) && parsedPid > 0) {
          pid = parsedPid;
          // Verify process is alive
          try {
            process.kill(parsedPid, 0);
          } catch {
            running = false;
          }
        }
      }
    }
  }

  // If show failed but unit file exists, we're at least installed
  if (!loaded && unitExists) {
    loaded = true;
  }

  return {
    installed: unitExists,
    loaded,
    running,
    label: TRILC_SYSTEMD_UNIT,
    command: {
      programArguments: [config.nodeBin, config.entryScript, ...config.programArgs],
      workingDirectory: config.cwd,
      environment: config.env ?? {},
    },
    runtime: {
      status: running ? "running" : loaded ? "stopped" : "unknown",
      ...(pid ? { pid } : {}),
    },
  };
}

async function isServiceLoaded(_config: TriRLCDaemonServiceConfig): Promise<boolean> {
  const res = await execSystemctl(["is-enabled", TRILC_SYSTEMD_UNIT]);
  // is-enabled returns 0 for enabled, non-zero otherwise
  // Also accept "static" output (linked but not explicitly enabled)
  const stdout = res.stdout.trim();
  return res.code === 0 || stdout === "static" || stdout === "enabled-runtime";
}

// ── Factory ──

export function createSystemdService(): TriRLCDaemonService {
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
