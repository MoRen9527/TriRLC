// ── TriRLC LS tool (P2-Batch1-#7) ──
// CC-equivalent directory listing tool. Lists files and directories with formatting options.
// Supports detailed view with permissions, sizes, and timestamps.

import { readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { register as registerTool, type ToolContext } from '@tricompany/agent-core';

interface LSEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink';
  size?: number;
  modified?: string;
}

// Format file size for human reading
function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Format directory listing as table
function formatListing(entries: LSEntry[], path: string, detailed: boolean): string {
  if (entries.length === 0) return `(empty directory)`;

  if (!detailed) {
    // Simple list format
    const dirs = entries.filter(e => e.type === 'directory').map(e => e.name + '/');
    const files = entries.filter(e => e.type !== 'directory').map(e => e.name);
    return [...dirs, ...files].join('  ');
  }

  // Detailed table format
  const lines = [`Listing of ${path}:`, ''];
  const header = 'Type'.padEnd(10) + 'Size'.padEnd(10) + 'Modified'.padEnd(20) + 'Name';
  lines.push(header);
  lines.push('─'.repeat(header.length));

  for (const entry of entries) {
    const type = entry.type === 'directory' ? 'DIR' : entry.type === 'symlink' ? 'SYMLINK' : 'FILE';
    const size = entry.type === 'file' && entry.size ? formatSize(entry.size) : '-';
    const modified = entry.modified || '-';
    lines.push(`${type.padEnd(10)}${size.padEnd(10)}${modified.padEnd(20)}${entry.name}`);
  }

  return lines.join('\n');
}

export function registerLSTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'LS',
        description:
          'List files and directories in a given path.\n' +
          'Usage:\n' +
          '- The path parameter must be an absolute path or relative to current working directory\n' +
          '- Use detailed=true for full information (size, modified date, type)\n' +
          '- Use pattern to filter entries by glob pattern (*.{js,ts}, test_*, etc.)',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path to list (defaults to current directory)',
            },
            detailed: {
              type: 'boolean',
              description: 'Show detailed information (size, type, modified date)',
            },
            pattern: {
              type: 'string',
              description: 'Glob pattern to filter entries (e.g., "*.ts", "test_*")',
            },
          },
        },
      },
    },
    async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const inputPath = args.path as string || '.';
      const detailed = args.detailed === true;
      const pattern = args.pattern as string | undefined;

      // REQ-014b: resolve relative paths against the agent loop cwd (ctx.cwd),
      // not the daemon launch dir. ctx is absent in legacy call sites → fall
      // back to process.cwd() (unchanged legacy behavior).
      const base = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(inputPath)
        ? resolve(inputPath)
        : resolve(base, inputPath);

      try {
        const entries = readdirSync(absolutePath, { withFileTypes: true });
        const result: LSEntry[] = [];

        for (const entry of entries) {
          // Apply pattern filter if specified
          if (pattern) {
            const regex = new RegExp(
              '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
            );
            if (!regex.test(entry.name)) continue;
          }

          const lsEntry: LSEntry = { name: entry.name, type: 'file' };

          if (entry.isDirectory()) {
            lsEntry.type = 'directory';
          } else if (entry.isSymbolicLink()) {
            lsEntry.type = 'symlink';
          } else {
            lsEntry.type = 'file';
          }

          // Get stats for detailed view
          if (detailed) {
            try {
              const fullPath = resolve(absolutePath, entry.name);
              const stats = statSync(fullPath);
              lsEntry.size = stats.size;
              lsEntry.modified = stats.mtime.toISOString().slice(0, 10);
            } catch {
              // Skip stats for inaccessible entries
            }
          }

          result.push(lsEntry);
        }

        // Sort: directories first, then files, both alphabetically
        result.sort((a, b) => {
          if (a.type === b.type) return a.name.localeCompare(b.name);
          return a.type === 'directory' ? -1 : 1;
        });

        return JSON.stringify({
          path: absolutePath,
          count: result.length,
          entries: result,
          formatted: formatListing(result, absolutePath, detailed),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: msg, path: inputPath });
      }
    },
  );
}
