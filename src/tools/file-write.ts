// ── TriRLC Write tool ──
// CC-equivalent file writer. Creates or overwrites files.
// Creates parent directories automatically.

import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { register as registerTool, type ToolContext } from '@tricompany/agent-core';

export function registerWriteTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'Write',
        description:
          'Writes a file to the local filesystem.\n' +
          'Usage:\n' +
          '- This tool will overwrite the existing file if there is one at the provided path.\n' +
          '- If this is an existing file, you MUST use the Read tool first to read the file\'s contents.\n' +
          '- ALWAYS prefer editing existing files using the Edit tool in the codebase.\n' +
          '- NEVER proactively create documentation files (*.md) or README files unless explicitly requested.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The absolute path to the file to write (must be absolute, not relative)',
            },
            content: {
              type: 'string',
              description: 'The content to write to the file',
            },
          },
          required: ['file_path', 'content'],
        },
      },
    },
    async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const filePath = args.file_path as string;
      const content = args.content as string;

      if (!filePath) return JSON.stringify({ error: 'file_path is required' });

      const base = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : resolve(base, filePath);

      // REQ-014b+defense: write path must stay within the agent workspace.
      // Prevents the agent from writing outside its cwd (e.g. System32).
      const workspaceRoot = resolve(base);
      const normalizedTarget = resolve(absolutePath);
      if (!normalizedTarget.startsWith(workspaceRoot + '\\') && normalizedTarget !== workspaceRoot) {
        return JSON.stringify({
          error: `write path outside workspace: ${normalizedTarget} (workspace: ${workspaceRoot})`,
        });
      }

      try {
        let isNew = false;
        try {
          statSync(absolutePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            isNew = true;
          } else {
            throw e;
          }
        }

        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath, content, 'utf-8');

        if (isNew) {
          return JSON.stringify({
            type: 'create',
            file_path: filePath,
            message: `File created successfully at: ${filePath}`,
          });
        }
        return JSON.stringify({
          type: 'update',
          file_path: filePath,
          message: `The file ${filePath} has been updated successfully.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: msg, file_path: filePath });
      }
    },
  );
}
