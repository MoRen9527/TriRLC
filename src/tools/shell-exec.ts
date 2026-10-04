// ── TriRLC shell_exec tool ──
// Backed by agent-core ProcessSupervisor for lifecycle management
// (timeout enforcement, cancellation, run registry).
// Security policy mirrors TriMMC: allowlist/denylist with env-var overrides.

import { platform } from 'node:os';
import {
  register as registerTool,
  createProcessSupervisor,
  type ProcessSupervisor,
  type ToolContext,
} from '@tricompany/agent-core';

// ── Security policy ──

const DEFAULT_ALLOWLIST = [
  'echo', 'ls', 'dir', 'cat', 'type', 'find', 'grep', 'findstr',
  'node', 'npm', 'npx', 'tsx', 'tsc',
  'git', 'python', 'pip', 'go', 'cargo', 'rustc',
  'mkdir', 'rmdir', 'mv', 'move', 'cp', 'copy',
  'wc', 'head', 'tail', 'sort', 'uniq', 'cut', 'awk', 'sed',
  'curl', 'wget', 'nslookup', 'ping',
  'pnpm', 'yarn',
  'where', 'which', 'whoami', 'hostname', 'date', 'time', 'pwd', 'cd',
  'printenv', 'env', 'set',
];

const DEFAULT_DENYLIST = [
  'rm -rf', 'rm -r', 'del /s', 'del /q', 'rd /s', 'rd /q',
  'format', 'shutdown', 'reboot', 'init', 'poweroff', 'halt',
  'chmod 777', 'chown',
  'sudo', 'su',
  ':(){ :|:& };:', // fork bomb
  'dd if=', 'mkfs', 'fdisk', 'parted',
  '> /dev/sda', '> /dev/nvme',
  'net user', 'net localgroup',
  'reg add', 'reg delete',
  'sc stop', 'sc config',
  'taskkill', 'Stop-Process',
];

function parsePolicyList(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar.split(',').map((s) => s.trim()).filter(Boolean);
}

function checkShellPolicy(command: string): { allowed: boolean; reason?: string } {
  const allowlistStr = process.env.TRILC_SHELL_ALLOWLIST;
  const denylistStr = process.env.TRILC_SHELL_DENYLIST;

  const allowlist = allowlistStr ? parsePolicyList(allowlistStr) : DEFAULT_ALLOWLIST;
  const denylist = denylistStr ? parsePolicyList(denylistStr) : DEFAULT_DENYLIST;

  const cmdLower = command.toLowerCase().trim();
  const baseCmd = cmdLower.split(/\s+/)[0];

  // 1. Denylist check
  for (const blocked of denylist) {
    if (cmdLower === blocked || cmdLower.startsWith(blocked + ' ')) {
      return { allowed: false, reason: `blocked by denylist: "${blocked}"` };
    }
  }

  // 2. Allowlist check
  const inAllowlist = allowlist.some(
    (allowed) => baseCmd === allowed || baseCmd.endsWith(`\\${allowed}`) || baseCmd.endsWith(`/${allowed}`),
  );

  if (!inAllowlist) {
    return { allowed: false, reason: `command "${baseCmd}" not in allowlist` };
  }

  return { allowed: true };
}

// ── Tool registration ──

export interface ShellExecOptions {
  supervisor: ProcessSupervisor;
  timeoutMs?: number;
}

/**
 * Register the shell_exec tool backed by ProcessSupervisor.
 * Returns the supervisor for daemon-scoped lifecycle management.
 */
export function registerShellExecTool(opts: ShellExecOptions): void {
  const { supervisor, timeoutMs = 30_000 } = opts;

  registerTool(
    {
      type: 'function',
      function: {
        name: 'shell_exec',
        description:
          'Execute a shell command and return stdout+stderr. Commands are validated against a security policy (allowlist/denylist). Capped at a configurable timeout (default 30s).',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command to execute.' },
            cwd: { type: 'string', description: 'Working directory for the command.' },
          },
          required: ['command'],
        },
      },
    },
    async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const command = args.command as string;
      // REQ-014b: model-explicit args.cwd wins (legacy semantics preserved),
      // then the agent loop cwd (ctx.cwd), then the daemon launch dir.
      const cwd = (args.cwd as string) || ctx?.cwd || process.cwd();

      if (!command) return JSON.stringify({ error: 'command is required' });

      // ── Policy gate ──
      const policy = checkShellPolicy(command);
      if (!policy.allowed) {
        return JSON.stringify({ error: policy.reason, command: command.slice(0, 200) });
      }

      try {
        const isWindows = platform() === 'win32';
        const argv = isWindows ? ['cmd', '/c', command] : ['sh', '-c', command];

        const run = await supervisor.spawn({
          argv,
          cwd,
          timeoutMs,
          captureOutput: true,
          scopeKey: SHELL_EXEC_SCOPE,
        });

        const result = await run.wait();
        return JSON.stringify({
          exitCode: result.exitCode,
          stdout: result.stdout?.slice(0, 10_000),
          stderr: result.stderr?.slice(0, 10_000),
          timedOut: result.timedOut ?? false,
          durationMs: result.durationMs,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: msg, command: command.slice(0, 200) });
      }
    },
  );
}

// ── Default supervisor instance for callers that don't need custom config ──
let _defaultSupervisor: ProcessSupervisor | undefined;

export const SHELL_EXEC_SCOPE = 'trilc-shell';

/**
 * Cancel all managed shell processes (daemon shutdown hook).
 */
export function cancelAllShellProcesses(): void {
  if (_defaultSupervisor) {
    _defaultSupervisor.cancelScope(SHELL_EXEC_SCOPE, 'manual-cancel');
  }
}

export function getDefaultSupervisor(): ProcessSupervisor {
  if (!_defaultSupervisor) {
    _defaultSupervisor = createProcessSupervisor();
  }
  return _defaultSupervisor;
}

export function resetDefaultSupervisor(): void {
  _defaultSupervisor = undefined;
}