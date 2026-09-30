// ── TriRLC Read tool ──
// CC-equivalent file reader. Reads text files with offset/limit support.
// Returns content in cat -n format: right-justified 6-digit line number + tab.

import { readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { register as registerTool, type ToolContext } from '@tricompany/agent-core';

const MAX_LINES = 2000;
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB safety cap

function formatFileContent(content: string, startLine: number): string {
  const lines = content.split('\n');
  // Remove trailing empty line from split if content ends with newline
  if (content.endsWith('\n')) lines.pop();
  return lines
    .map((line, i) => `${String(startLine + i).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

export function registerReadTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'Read',
        description:
          'Reads a file from the local filesystem. You can access any file directly by using this tool.\n' +
          'Usage:\n' +
          '- The file_path parameter must be an absolute path, not a relative path\n' +
          `- By default, it reads up to ${MAX_LINES} lines starting from the beginning of the file\n` +
          '- Results are returned using cat -n format, with line numbers starting at 1\n' +
          '- You can optionally specify a line offset and limit (especially handy for long files)',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The absolute path to the file to read',
            },
            offset: {
              type: 'integer',
              description:
                'The line number to start reading from. Only provide if the file is too large to read at once',
            },
            limit: {
              type: 'integer',
              description:
                'The number of lines to read. Only provide if the file is too large to read at once.',
            },
          },
          required: ['file_path'],
        },
      },
    },
    async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const filePath = args.file_path as string;
      const offset = typeof args.offset === 'number' ? args.offset : 1;
      const limit = typeof args.limit === 'number' ? args.limit : undefined;

      if (!filePath) return JSON.stringify({ error: 'file_path is required' });

      // REQ-014b: resolve relative paths against the agent loop cwd (ctx.cwd),
      // not the daemon launch dir. ctx is absent in legacy call sites → fall
      // back to process.cwd() (unchanged legacy behavior).
      const base = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : resolve(base, filePath);

      try {
        // Safety: check file size before reading
        const stats = statSync(absolutePath);
        if (!stats.isFile()) {
          return JSON.stringify({
            error: `Path is not a regular file: ${filePath}`,
          });
        }
        if (stats.size > MAX_SIZE_BYTES) {
          return JSON.stringify({
            error: `File too large (${(stats.size / (1024 * 1024)).toFixed(1)} MB). Use offset and limit to read specific portions.`,
          });
        }

        const rawContent = readFileSync(absolutePath, 'utf-8');
        const lines = rawContent.split('\n');
        // Remove trailing empty line
        if (rawContent.endsWith('\n')) lines.pop();
        const totalLines = lines.length;

        if (totalLines === 0) {
          return JSON.stringify({
            file_path: filePath,
            content: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
            num_lines: 0,
            start_line: 1,
            total_lines: 0,
          });
        }

        const startLine = Math.max(1, Math.min(offset, totalLines));
        const startIdx = startLine - 1;
        const maxRead = limit ?? MAX_LINES;
        const endIdx = Math.min(startIdx + maxRead, totalLines);

        const selectedLines = lines.slice(startIdx, endIdx);
        const selectedContent = selectedLines.join('\n');
        const formatted = formatFileContent(selectedContent, startLine);

        return JSON.stringify({
          file_path: filePath,
          content: formatted,
          num_lines: selectedLines.length,
          start_line: startLine,
          total_lines: totalLines,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return JSON.stringify({
            error: `File does not exist: ${filePath}`,
            file_path: filePath,
          });
        }
        return JSON.stringify({ error: msg, file_path: filePath });
      }
    },
  );
}
