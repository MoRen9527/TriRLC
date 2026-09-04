export type TriLCEnv = {
  nodeId: string;
  port: number;
  trimcBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
  /** TriModel configuration-plane API base URL (Phase 1: http://127.0.0.1:3333) */
  trimodelApiUrl: string;
  /** Working directory for local tool execution */
  cwd: string;
  /** Data directory for SQLite event queue and other persistent state */
  dataDir: string;
  /** Agent core version reported in heartbeat */
  version: string;
  /** TriCompany source-agents root (for contract resolver) */
  tricompanySourcePath: string;
  /**
   * Project root directory for multi-project data isolation (Phase 3 pipe3-1).
   * - Project-level data: {projectRoot}/.tricompany-cognition/
   * - Operating records:  {projectRoot}/docs/execution/operating-records/
   * - Defaults to cwd for backward compatibility.
   * - Env: TRILC_PROJECT_ROOT
   */
  projectRoot: string;
  /**
   * Company weekly plane root (TRILC_WEEKLY_PLANE_ROOT) — read-only shared
   * view of TriMetaverse docs/workflow/operating-records. Raw env passthrough
   * only; resolution order (env → workspace sibling → undefined) lives in
   * src/project/weekly-plane-root.ts. Unset = legacy project-track behavior.
   */
  weeklyPlaneRoot?: string;
  /**
   * Debug mode flag (TRILC_DEBUG=1). Unlocks reset endpoint and UI controls.
   * Production default: false (env var unset).
   */
  debugMode: boolean;
};

import { hostname } from 'node:os';
import { resolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 环境文件候选（纯函数，可测）。
 * r19-gate A1 扩展：安装态（C:\Program Files\TriCade）下 r19 三候选
 * （工作区根/TriLC 根/cwd）全部落空 → schtasks 实例 keys fetch 401。
 * 新增：
 *   1. TRILC_ENV_FILE 显式注入（部署层指路——cmd/任务里只放路径，不放密钥）
 *   2. dataDir 相邻 .env（TRILC_DATA_DIR ?? %LOCALAPPDATA%/trilc）——安装态可达
 */
export function buildEnvFileCandidates(scriptDir: string, cwd: string): string[] {
  const explicit = process.env.TRILC_ENV_FILE;
  const dataDirEnv = process.env.TRILC_DATA_DIR
    ? resolve(process.env.TRILC_DATA_DIR, '.env')
    : (process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'trilc', '.env') : undefined);
  const candidates: Array<string | undefined> = [
    explicit ? resolve(explicit) : undefined,
    resolve(scriptDir, '..', '..', '..', '.env'), // 工作区根 D:/Code/ai/.env（源码态）
    resolve(scriptDir, '..', '..', '.env'),       // TriLC 根 .env
    dataDirEnv,                                   // dataDir 相邻（安装态 schtasks 可达）
    resolve(cwd, '.env'),
  ];
  return candidates.filter((p): p is string => !!p);
}

/**
 * r19 修复：dist 形态（node dist/cli.js）无 tsx 的 dotenv 自动加载，
 * schtasks ONLOGON 环境缺 TRIMODEL_API_TOKEN 等关键变量（keys fetch 401）。
 * 兜底加载 .env 候选——不覆盖已存在的进程 env（r19 口径不变）。
 */
function loadEnvFileFallback(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = buildEnvFileCandidates(scriptDir, process.cwd());
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      for (const rawLine of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(rawLine.trim());
        if (!match) continue;
        const key = match[1];
        let value = match[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      }
    } catch { /* unreadable .env — ignore */ }
  }
}

loadEnvFileFallback();

function resolveFromWorkspace(): string {
  // Check env var first
  if (process.env.TRICOMPANY_SOURCE_PATH) return process.env.TRICOMPANY_SOURCE_PATH;

  // Determine the script's own directory (works in both dev and MSI deployment).
  // Using process.cwd() is unreliable: daemon started via RegRun has cwd=C:\Windows\System32.
  const scriptDir = dirname(fileURLToPath(import.meta.url));

  // MSI deployment: contracts/ sits at tools/trilc/contracts/
  // dist/config/env.js → ../../contracts → tools/trilc/contracts/
  const msiContracts = resolve(scriptDir, '..', '..', 'contracts');
  if (existsSync(msiContracts)) return msiContracts;

  // Development workspace: TriCompany/source-agents next to TriLC
  const devContracts = resolve(scriptDir, '..', '..', '..', 'TriCompany', 'source-agents');
  if (existsSync(devContracts)) return devContracts;

  // Last resort: return the development path (will log a warning in contract-resolver)
  return devContracts;
}

/**
 * Resolve TriLC version from:
 *  1. TRILC_VERSION env var (explicit override)
 *  2. version.json at the TriLC root (relative to this module)
 *  3. Hardcoded fallback '1.0.0'
 *
 * Path derivation: this module compiles to dist/config/env.js,
 * so ../../version.json resolves to <trilc-root>/version.json for
 * both dev workspaces and ZIP/MSI deployments.
 */
function resolveVersion(): string {
  if (process.env.TRILC_VERSION) return process.env.TRILC_VERSION;

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const versionPath = resolve(scriptDir, '..', '..', 'version.json');

  if (existsSync(versionPath)) {
    try {
      const raw = readFileSync(versionPath, 'utf-8');
      // BOM 容错：Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会写 BOM，
      // JSON.parse 对 BOM 开头抛错（BUG-20260805-002 掩盖链的一环）
      const parsed = JSON.parse(raw.replace(/^﻿/, ''));
      if (parsed && typeof parsed.version === 'string' && parsed.version) {
        return parsed.version;
      }
    } catch { /* ignore parse errors, fall through */ }
  }

  return '1.0.0';
}

export function readEnv(): TriLCEnv {
  const nodeId = process.env.TRILC_NODE_ID ?? `${hostname()}-${process.pid}`;
  const dataDir = process.env.TRILC_DATA_DIR ?? `${process.env.LOCALAPPDATA ?? process.env.HOME ?? '/tmp'}/trilc`;
  const projectRoot = process.env.TRILC_PROJECT_ROOT ?? process.cwd();
  const debugMode = process.env.TRILC_DEBUG === '1';
  if (debugMode) {
    console.log('[trilc] debug mode: enabled (TRILC_DEBUG=1)');
  }
  return {
    nodeId,
    port: Number(process.env.TRILC_PORT ?? 8711),
    // trimcBaseUrl：默认 127.0.0.1:8710=dev 同机形态（本机 TriMC 部署）；
    // prod 覆盖走 env 注入（TRIMC_BASE_URL，LG-030 两形态并存合法性 2026-09-04）。
    trimcBaseUrl: process.env.TRIMC_BASE_URL ?? 'http://127.0.0.1:8710',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730',
    trimodelApiUrl: process.env.TRILC_TRIMODEL_API_URL ?? 'http://127.0.0.1:3333',
    // REQ-014b: default to projectRoot when TRILC_CWD unset — chat agents must
    // operate in the project workspace, not the daemon launch dir (e.g. System32).
    cwd: process.env.TRILC_CWD ?? process.env.TRILC_PROJECT_ROOT ?? process.cwd(),
    dataDir,
    version: resolveVersion(),
    tricompanySourcePath: process.env.TRICOMPANY_SOURCE_PATH ?? resolveFromWorkspace(),
    projectRoot,
    weeklyPlaneRoot: process.env.TRILC_WEEKLY_PLANE_ROOT || undefined,
    debugMode,
  };
}