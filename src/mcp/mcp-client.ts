// ── MCP Client Manager (P6 + P7 + P8) ──
// Minimal MCP connection lifecycle manager using @modelcontextprotocol/sdk.
// Handles: stdio + SSE transport, tool listing, tool call proxying.
//
// CC equivalent: services/mcp/client.ts (~1500 lines) — stripped to ~200
// lines for TriRLC MVP. No OAuth, no resource/prompt support, no LRU cache.
//
// Architecture:
//   McpClientManager
//     ├── connectAll(configs) → Map<serverName, MCPConnection>
//     ├── listAllTools() → ToolDefinition[]
//     ├── listAllResources() → ResourceDef[]
//     ├── listAllPrompts() → PromptDef[]
//     ├── callTool(serverName, toolName, args) → result
//     ├── readResource(serverName, uri) → content
//     └── getPrompt(serverName, name, args) → messages

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  MCPServerConfig,
} from './mcp-config.js';

export interface MCPToolDef {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ── MCP Resource Definition (P7) ──
export interface MCPResourceDef {
  serverName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}


// ── MCP Prompt Definition (P8) ──
export interface MCPPromptDef {
  serverName: string;
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

interface MCPConnection {
  serverName: string;
  client: Client;
  transport: Transport;
  tools: MCPToolDef[];
  resources: MCPResourceDef[];
  prompts: MCPPromptDef[];
}

/**
 * Minimal MCP client manager. Connects to configured MCP servers,
 * discovers their tools, and proxies tool calls.
 */
export class McpClientManager {
  private connections = new Map<string, MCPConnection>();
  private connected = false;

  /**
   * Connect to all configured MCP servers.
   * For each server, establishes transport, initializes MCP handshake,
   * and discovers available tools.
   */
  async connectAll(configs: MCPServerConfig[]): Promise<void> {
    if (this.connected) {
      await this.disconnectAll();
    }

    const results = await Promise.allSettled(
      configs
        .filter(c => !c.disabled)
        .map(config => this.connectOne(config)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result?.status === 'rejected') {
        const serverName = configs[i]?.name ?? 'unknown';
        console.warn(`[mcp] failed to connect to "${serverName}": ${(result.reason as Error).message}`);
      }
    }

    this.connected = true;
    console.log(`[mcp] connected to ${this.connections.size}/${configs.length} servers (${this.totalToolCount()} tools, ${this.totalResourceCount()} resources, ${this.totalPromptCount()} prompts)`);
  }

  /**
   * Connect to a single MCP server.
   */
  private async connectOne(config: MCPServerConfig): Promise<void> {
    let transport: Transport;

    if (config.type === 'sse' || config.type === 'streamableHttp') {
      if (!config.url) {
        throw new Error(`SSE/streamableHttp server "${config.name}" requires a url`);
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else {
      // stdio (default)
      if (!config.command) {
        throw new Error(`Stdio server "${config.name}" requires a command`);
      }
      transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        stderr: 'inherit',
      });
    }

    const client = new Client(
      { name: 'triLC', version: '0.1.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    // Discover tools
    const toolsResult = await client.listTools();
    const tools: MCPToolDef[] = (toolsResult.tools ?? []).map(t => ({
      serverName: config.name,
      toolName: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
    }));

    // Discover resources (P7)
    let resources: MCPResourceDef[] = [];
    try {
      const resResult = await client.listResources();
      resources = (resResult.resources ?? []).map(r => ({
        serverName: config.name,
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      }));
    } catch (err) {
      // Server doesn't support resources — degrade gracefully
      console.warn(`[mcp] server "${config.name}" does not support resources: ${(err as Error).message}`);
    }

    // Discover prompts (P8)
    let prompts: MCPPromptDef[] = [];
    try {
      const promptResult = await client.listPrompts();
      prompts = (promptResult.prompts ?? []).map(p => ({
        serverName: config.name,
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      }));
    } catch (err) {
      // Server doesn't support prompts — degrade gracefully
      console.warn(`[mcp] server "${config.name}" does not support prompts: ${(err as Error).message}`);
    }

    this.connections.set(config.name, {
      serverName: config.name,
      client,
      transport,
      tools,
      resources,
      prompts,
    });
  }

  /**
   * Get all tools from all connected MCP servers.
   * Tool names are prefixed with the server name to avoid collisions
   * (e.g., "filesystem_read_file" → "mcp__filesystem__read_file").
   * The canonical prefix is "mcp__{serverName}__{toolName}".
   */
  listAllTools(): MCPToolDef[] {
    const all: MCPToolDef[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.tools);
    }
    return all;
  }

  /**
   * Build the canonical MCP tool name from server + tool name.
   */
  static buildToolName(serverName: string, toolName: string): string {
    return `mcp__${serverName}__${toolName}`;
  }

  /**
   * Parse a canonical MCP tool name back into server and tool names.
   */
  static parseToolName(canonicalName: string): { serverName: string; toolName: string } | null {
    const match = canonicalName.match(/^mcp__([^_]+)__(.+)$/);
    if (!match) return null;
    return { serverName: match[1]!, toolName: match[2]! };
  }

  /**
   * Call a tool on a specific MCP server and return the result as a string.
   */
  async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return JSON.stringify({ error: `MCP server "${serverName}" not connected` });
    }

    try {
      const result = await conn.client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: 120_000 },
      );

      // Extract text content from the result
      const contents = (result.content ?? []) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
      const textParts = contents
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map(c => c.text!);

      if (textParts.length > 0) {
        return textParts.join('\n');
      }

      return JSON.stringify(result.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg, serverName, toolName });
    }
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    const disconnects: Promise<void>[] = [];
    for (const conn of this.connections.values()) {
      disconnects.push(
        conn.client.close().catch(e =>
          console.warn(`[mcp] error closing "${conn.serverName}": ${(e as Error).message}`),
        ),
      );
    }
    await Promise.allSettled(disconnects);
    this.connections.clear();
    this.connected = false;
  }

  /**
   * Total number of tools across all connected servers.
   */
  totalToolCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      count += conn.tools.length;
    }
    return count;
  }

  // ── Resource Methods (P7) ──

  /**
   * Get all resources from all connected MCP servers.
   */
  listAllResources(): MCPResourceDef[] {
    const all: MCPResourceDef[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.resources);
    }
    return all;
  }

  /**
   * Read a resource from a specific MCP server by URI.
   */
  async readResource(serverName: string, uri: string): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return JSON.stringify({ error: `MCP server "${serverName}" not connected` });
    }

    try {
      const result = await conn.client.readResource({ uri });
      // MCP resource contents are TextResourceContents | BlobResourceContents
      // Both have uri+mimeType; text has .text, blob has .blob (not .type)
      const contents = (result.contents ?? []) as unknown as Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>;
      const textParts = contents
        .filter((c) => typeof c.text === 'string')
        .map(c => c.text!);

      if (textParts.length > 0) {
        return textParts.join('\n');
      }
      return JSON.stringify(result.contents);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg, serverName, uri });
    }
  }

  /**
   * Total number of resources across all connected servers.
   */
  totalResourceCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      count += conn.resources.length;
    }
    return count;
  }

  /**
   * Check if any servers are connected.
   */
  isConnected(): boolean {
    return this.connected && this.connections.size > 0;
  }

  /**
   * Get connected server names for diagnostics.
   */
  getConnectedServerNames(): string[] {
    return [...this.connections.keys()];
  }

  // ── C10: Per-server connection management ──

  /**
   * Connect a single MCP server at runtime (no daemon restart).
   * Registers each MCP tool as an individual agent tool: mcp__<server>__<tool>.
   * Returns the list of registered tool names.
   */
  async connectServer(config: MCPServerConfig): Promise<string[]> {
    if (this.connections.has(config.name)) {
      await this.disconnectServer(config.name);
    }

    await this.connectOne(config);
    const conn = this.connections.get(config.name);
    if (!conn) return [];

    const registered: string[] = [];
    const { register: registerTool } = await import('@tricompany/agent-core');

    for (const tool of conn.tools) {
      const canonicalName = McpClientManager.buildToolName(config.name, tool.toolName);
      try {
        registerTool(
          {
            type: 'function',
            function: {
              name: canonicalName,
              description: `[MCP:${config.name}] ${tool.description}`,
              parameters: tool.inputSchema,
            },
          },
          async (args: Record<string, unknown>) => {
            return this.callTool(config.name, tool.toolName, args);
          },
        );
        registered.push(canonicalName);
      } catch (err) {
        console.warn(`[mcp] failed to register tool "${canonicalName}": ${(err as Error).message}`);
      }
    }

    console.log(`[mcp] server "${config.name}" connected: ${registered.length} tools registered`);
    return registered;
  }

  /**
   * Disconnect a single MCP server at runtime. Unregisters all its per-tool agent tools.
   */
  async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) {
      console.warn(`[mcp] server "${name}" not connected — nothing to disconnect`);
      return;
    }

    const { unregister } = await import('@tricompany/agent-core');
    for (const tool of conn.tools) {
      const canonicalName = McpClientManager.buildToolName(name, tool.toolName);
      try { unregister(canonicalName); } catch { /* best-effort */ }
    }

    try { await conn.client.close(); } catch { /* transport may already be closed */ }
    this.connections.delete(name);
    console.log(`[mcp] server "${name}" disconnected: ${conn.tools.length} tools unregistered`);
  }

  /**
   * C10: Refresh a single server (disconnect + reconnect from config).
   */
  async refreshServer(config: MCPServerConfig): Promise<string[]> {
    await this.disconnectServer(config.name);
    return this.connectServer(config);
  }

  /**
   * C10: List all connected servers with status.
   */
  listServers(): Array<{
    name: string; type: string; status: 'connected';
    toolCount: number; resourceCount: number; promptCount: number;
  }> {
    const result: Array<{
      name: string; type: string; status: 'connected';
      toolCount: number; resourceCount: number; promptCount: number;
    }> = [];
    for (const conn of this.connections.values()) {
      result.push({
        name: conn.serverName,
        type: 'stdio', // approximate — detailed type tracked by config layer
        status: 'connected',
        toolCount: conn.tools.length,
        resourceCount: conn.resources.length,
        promptCount: conn.prompts.length,
      });
    }
    return result;
  }

  // ── Prompt Methods (P8) ──

  /**
   * Get all prompts from all connected MCP servers.
   */
  listAllPrompts(): MCPPromptDef[] {
    const all: MCPPromptDef[] = [];
    for (const conn of this.connections.values()) {
      all.push(...conn.prompts);
    }
    return all;
  }

  /**
   * Get a prompt from a specific MCP server by name.
   * Returns the prompt messages as a JSON string.
   */
  async getPrompt(serverName: string, promptName: string, promptArgs?: Record<string, string>): Promise<string> {
    const conn = this.connections.get(serverName);
    if (!conn) {
      return JSON.stringify({ error: `MCP server "${serverName}" not connected` });
    }

    try {
      const result = await conn.client.getPrompt({ name: promptName, arguments: promptArgs });
      return JSON.stringify({
        messages: result.messages,
        description: result.description,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: msg, serverName, promptName });
    }
  }

  /**
   * Total number of prompts across all connected servers.
   */
  totalPromptCount(): number {
    let count = 0;
    for (const conn of this.connections.values()) {
      count += conn.prompts.length;
    }
    return count;
  }

}
