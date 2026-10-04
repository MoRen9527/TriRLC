// ── TriLC Daemon Service Interface ──
// OS-level service management abstraction (schtasks / launchd / systemd).
// Phase 2: Windows schtasks implementation; macOS/Linux are @platform-deferred.
//
// Based on vendor/openclaw/src/daemon/service.ts GatewayService pattern.

// ── Configuration ──

export interface TriRLCDaemonServiceConfig {
  /** Service label / task name. Default: "TriLC Daemon". */
  label?: string;
  /** Path to node binary (typically process.execPath). */
  nodeBin: string;
  /** Path to the entry script (dist/cli.js or dist/index.js). */
  entryScript: string;
  /** CLI program arguments (e.g. ["start", "--port", "8711"]). */
  programArgs: string[];
  /** Working directory for the daemon process. */
  cwd: string;
  /** Environment variables to pass to the daemon process. */
  env?: Record<string, string>;
  /** TriRLC data directory for PID/session/event persistence. */
  dataDir: string;
  /** Port the daemon listens on. */
  port: number;
}

// ── State ──

export interface DaemonServiceState {
  /** Whether the OS-level registration exists (schtasks task / plist / unit). */
  installed: boolean;
  /** Whether the service is loaded/enabled (will start on boot/login). */
  loaded: boolean;
  /** Whether the daemon process is currently running. */
  running: boolean;
  /** Service label / task name. */
  label: string;
  /** Parsed command configuration (program args, working dir, env). */
  command: {
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
  } | null;
  /** Runtime status (pid, uptime) if process is found. */
  runtime: {
    status: "running" | "stopped" | "unknown";
    pid?: number;
    uptimeMs?: number;
  } | null;
}

export interface DaemonServiceStartResult {
  outcome: "started" | "scheduled" | "missing-install";
  state: DaemonServiceState;
}

// ── Service Interface ──

export interface TriRLCDaemonService {
  /** Stage: write the service definition file without registering with the OS. */
  stage(config: TriRLCDaemonServiceConfig): Promise<string>;
  /** Install: stage + register with the OS. */
  install(config: TriRLCDaemonServiceConfig): Promise<void>;
  /** Uninstall: remove OS registration + staged files. */
  uninstall(config: TriRLCDaemonServiceConfig): Promise<void>;
  /** Stop the running daemon service. */
  stop(config: TriRLCDaemonServiceConfig): Promise<void>;
  /** Restart: stop + start. Returns the outcome. */
  restart(config: TriRLCDaemonServiceConfig): Promise<DaemonServiceStartResult>;
  /** Query the current OS-level state. */
  status(config: TriRLCDaemonServiceConfig): Promise<DaemonServiceState>;
  /** Whether the service is registered / loaded. */
  isLoaded(config: TriRLCDaemonServiceConfig): Promise<boolean>;
}

// ── Platform Resolution ──

type SupportedPlatform = "darwin" | "linux" | "win32";

function isSupportedPlatform(p: NodeJS.Platform): p is SupportedPlatform {
  return p === "darwin" || p === "linux" || p === "win32";
}

/**
 * Resolve the platform-appropriate daemon service implementation.
 */
export async function resolveDaemonService(): Promise<TriRLCDaemonService> {
  if (!isSupportedPlatform(process.platform)) {
    throw new Error(
      `TriRLC daemon service is not supported on ${process.platform}`,
    );
  }

  switch (process.platform) {
    case "win32": {
      const { createSchtasksService } = await import("./schtasks.js");
      return createSchtasksService();
    }
    case "darwin": {
      const { createLaunchdService } = await import("./launchd.js");
      return createLaunchdService();
    }
    case "linux": {
      const { createSystemdService } = await import("./systemd.js");
      return createSystemdService();
    }
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}
