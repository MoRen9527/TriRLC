// ── MCP Configuration Loader (P6) ──
// Reads MCP server definitions from .claude/mcp.json (CC-compatible format)
// and project-local .trilc/mcp.json (TriRLC-specific).
//
// CC format (.claude/mcp.json):
// {
//   "mcpServers": {
//     "server-name": {
//       "type": "stdio" | "sse" | "streamableHttp",
//       "command": "npx",
//       "args": ["-y", "@anthropic/mcp-server-filesystem"],
//       "env": { "KEY": "value" },
//       "url": "http://..."  // for SSE type
//     }
//   }
// }

import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export type MCPServerType = 'stdio' | 'sse' | 'streamableHttp';

export interface MCPServerConfig {
  name: string;
  type: MCPServerType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  cwd?: string;
  disabled?: boolean;
}

interface McpConfigFile {
  mcpServers?: Record<string, {
    type?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    cwd?: string;
    disabled?: boolean;
  }>;
}

function normalizeType(raw?: string): MCPServerType {
  if (raw === 'sse') return 'sse';
  if (raw === 'streamableHttp' || raw === 'streamable_http') return 'streamableHttp';
  return 'stdio'; // default
}

function parseConfigFile(filepath: string): McpConfigFile | null {
  try {
    if (!existsSync(filepath)) return null;
    const raw = readFileSync(filepath, 'utf-8');
    return JSON.parse(raw) as McpConfigFile;
  } catch {
    return null;
  }
}

/**
 * Load MCP server configurations from all standard locations.
 * Priority: project-local takes precedence over user-global.
 */
export function loadMCPServerConfigs(cwd?: string): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];
  const seen = new Set<string>();

  // 1. User-global config: ~/.claude/mcp.json
  const globalPath = join(homedir(), '.claude', 'mcp.json');
  const globalConfig = parseConfigFile(globalPath);

  // 2. Project-local config: {cwd}/.claude/mcp.json
  const projectPath = cwd ? join(cwd, '.claude', 'mcp.json') : null;
  const projectConfig = projectPath ? parseConfigFile(projectPath) : null;

  // 3. TriRLC-specific: {cwd}/.trilc/mcp.json (highest priority)
  const trilcPath = cwd ? join(cwd, '.trilc', 'mcp.json') : null;
  const trilcConfig = trilcPath ? parseConfigFile(trilcPath) : null;

  // Merge: trilc > project > global
  const sources: Array<McpConfigFile | null> = [trilcConfig, projectConfig, globalConfig];
  for (const config of sources) {
    if (!config?.mcpServers) continue;
    for (const [name, serverDef] of Object.entries(config.mcpServers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const sd = serverDef as Record<string, unknown>;
      if (sd.disabled) continue;
      configs.push({
        name,
        type: normalizeType(sd.type as string | undefined),
        command: sd.command as string | undefined,
        args: sd.args as string[] | undefined,
        env: sd.env as Record<string, string> | undefined,
        url: sd.url as string | undefined,
        cwd: sd.cwd as string | undefined,
      });
    }
  }

  return configs;
}

// ── Config Write Functions (C10) ──

/**
 * Read the raw MCP config file, returning { mcpServers: {...} } or empty.
 * Does NOT merge multiple sources — reads a single file for write-modify-write.
 */
function readRawConfigFile(filepath: string): McpConfigFile {
  try {
    if (!existsSync(filepath)) return { mcpServers: {} };
    const raw = readFileSync(filepath, 'utf-8');
    const parsed = JSON.parse(raw) as McpConfigFile;
    if (!parsed.mcpServers) parsed.mcpServers = {};
    return parsed;
  } catch {
    return { mcpServers: {} };
  }
}

/** Write the raw MCP config file, creating parent dirs as needed. */
function writeRawConfigFile(filepath: string, config: McpConfigFile): void {
  const dir = dirname(filepath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filepath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o644 });
}

/**
 * Add or update an MCP server config.
 * Writes to .trilc/mcp.json (TriRLC-specific, highest priority) by default,
 * or .claude/mcp.json project-local when `project` is true.
 */
export function addMCPServerConfig(
  server: MCPServerConfig,
  cwd: string,
  project = false,
): void {
  const filepath = project
    ? join(cwd, '.claude', 'mcp.json')
    : join(cwd, '.trilc', 'mcp.json');

  const config = readRawConfigFile(filepath);
  config.mcpServers = config.mcpServers ?? {};

  config.mcpServers[server.name] = {
    type: server.type === 'sse' || server.type === 'streamableHttp' ? server.type : 'stdio',
    ...(server.command ? { command: server.command } : {}),
    ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
    ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
    ...(server.url ? { url: server.url } : {}),
    ...(server.cwd ? { cwd: server.cwd } : {}),
    ...(server.disabled ? { disabled: true } : {}),
  };

  writeRawConfigFile(filepath, config);
}

/**
 * Remove an MCP server config by name.
 * Searches .trilc/mcp.json first, then .claude/mcp.json project-local.
 */
export function removeMCPServerConfig(name: string, cwd: string): boolean {
  const paths = [
    join(cwd, '.trilc', 'mcp.json'),
    join(cwd, '.claude', 'mcp.json'),
  ];

  for (const filepath of paths) {
    const config = readRawConfigFile(filepath);
    if (config.mcpServers?.[name]) {
      delete config.mcpServers[name];
      writeRawConfigFile(filepath, config);
      return true;
    }
  }
  return false;
}

/**
 * List all configured MCP servers from the project-local config files.
 * Returns configs with their source file path for diagnostics.
 */
export function listProjectMCPServers(cwd: string): Array<MCPServerConfig & { source: string }> {
  const results: Array<MCPServerConfig & { source: string }> = [];
  const seen = new Set<string>();

  const paths = [
    join(cwd, '.trilc', 'mcp.json'),
    join(cwd, '.claude', 'mcp.json'),
  ];

  for (const filepath of paths) {
    const config = readRawConfigFile(filepath);
    if (!config.mcpServers) continue;
    for (const [name, serverDef] of Object.entries(config.mcpServers)) {
      if (seen.has(name)) continue;
      seen.add(name);
      const sd = serverDef as Record<string, unknown>;
      results.push({
        name,
        type: normalizeType(sd.type as string | undefined),
        command: sd.command as string | undefined,
        args: sd.args as string[] | undefined,
        env: sd.env as Record<string, string> | undefined,
        url: sd.url as string | undefined,
        cwd: sd.cwd as string | undefined,
        disabled: sd.disabled as boolean | undefined,
        source: filepath,
      });
    }
  }

  return results;
}

/**
 * C10: Reload MCP server configs from disk.
 * Convenience wrapper for daemon refresh endpoint.
 */
export function reloadMCPServerConfigs(cwd?: string): MCPServerConfig[] {
  return loadMCPServerConfigs(cwd);
}
