// ── TriRLC Edit tool ──
// CC-equivalent string-replacement editor. Supports replace_all and
// exact-match semantics (old_string must appear verbatim in file).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute, dirname } from 'node:path';
import { register as registerTool, type ToolContext } from '@tricompany/agent-core';

// ── Quote normalization (A级复制 from CC FileEditTool/utils.ts) ──
// CC's fuzzy match: when exact old_string match fails, normalize curly quotes
// to straight quotes and try again. This catches the common case where the
// model uses straight quotes " " but the file has curly quotes " " (or vice
// versa), avoiding spurious "String not found" errors.
const RIGHT_SINGLE_CURLY = '’';   // '
const LEFT_DOUBLE_CURLY = '“';    // "
const RIGHT_DOUBLE_CURLY = '”';   // "
function normalizeQuotes(s: string): string {
  return s
    .replaceAll(RIGHT_SINGLE_CURLY, "'")
    .replaceAll(LEFT_DOUBLE_CURLY, '"')
    .replaceAll(RIGHT_DOUBLE_CURLY, '"');
}

export function registerEditTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'Edit',
        description:
          'Performs exact string replacements in a file.\n' +
          'Usage:\n' +
          '- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.\n' +
          '- ALWAYS prefer editing existing files. NEVER write new files unless explicitly required.\n' +
          '- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n' +
          '- The edit will FAIL if old_string is not unique in the file.\n' +
          '  * Either provide a larger string with more surrounding context to make it unique.\n' +
          '  * Or set replace_all to true to replace every occurrence of old_string.',
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'The absolute path to the file to modify',
            },
            old_string: {
              type: 'string',
              description: 'The text to replace',
            },
            new_string: {
              type: 'string',
              description: 'The text to replace it with (must be different from old_string)',
            },
            replace_all: {
              type: 'boolean',
              description: 'Replace all occurrences of old_string (default false)',
            },
          },
          required: ['file_path', 'old_string', 'new_string'],
        },
      },
    },
    async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const filePath = args.file_path as string;
      const oldString = args.old_string as string;
      const newString = args.new_string as string;
      const replaceAll = args.replace_all === true;

      if (!filePath) return JSON.stringify({ error: 'file_path is required' });
      if (oldString === undefined || oldString === null) return JSON.stringify({ error: 'old_string is required' });

      const base = ctx?.cwd ?? process.cwd();
      const absolutePath = isAbsolute(filePath)
        ? filePath
        : resolve(base, filePath);

      // REQ-014b defense: edits must stay within the agent workspace
      const workspaceRoot = resolve(base);
      const normalizedTarget = resolve(absolutePath);
      if (!normalizedTarget.startsWith(workspaceRoot + '\\') && normalizedTarget !== workspaceRoot) {
        return JSON.stringify({
          error: `edit path outside workspace: ${normalizedTarget} (workspace: ${workspaceRoot})`,
        });
      }

      try {
        // Read existing file
        let originalContent: string;
        try {
          originalContent = readFileSync(absolutePath, 'utf-8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            return JSON.stringify({
              error: `File does not exist: ${filePath}`,
              file_path: filePath,
            });
          }
          throw e;
        }

        if (oldString === newString) {
          return JSON.stringify({
            error: 'No changes to make: old_string and new_string are exactly the same.',
            file_path: filePath,
          });
        }

        // Try exact match first; fall back to quote-normalized fuzzy match.
        let actualOldString: string;
        if (originalContent.includes(oldString)) {
          actualOldString = oldString;
        } else {
          const normOld = normalizeQuotes(oldString);
          const normFile = normalizeQuotes(originalContent);
          const normIndex = normFile.indexOf(normOld);
          if (normIndex !== -1) {
            actualOldString = originalContent.substring(normIndex, normIndex + oldString.length);
          } else {
            return JSON.stringify({
              error: `String to replace not found in file.\nString: ${oldString.slice(0, 200)}`,
              file_path: filePath,
            });
          }
        }

        // Count matches
        const occurrences = originalContent.split(actualOldString).length - 1;

        if (occurrences > 1 && !replaceAll) {
          return JSON.stringify({
            error: `Found ${occurrences} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${oldString.slice(0, 200)}`,
            file_path: filePath,
          });
        }

        // Perform replacement (0-occurrence already handled above)
        let updatedContent: string;
        if (replaceAll) {
          updatedContent = originalContent.split(actualOldString).join(newString);
        } else {
          updatedContent = originalContent.replace(actualOldString, newString);
        }

        // Ensure parent directory exists
        mkdirSync(dirname(absolutePath), { recursive: true });

        // Write back
        writeFileSync(absolutePath, updatedContent, 'utf-8');

        return JSON.stringify({
          file_path: filePath,
          message: replaceAll
            ? `The file ${filePath} has been updated. All ${occurrences} occurrences were successfully replaced.`
            : `The file ${filePath} has been updated successfully.`,
          occurrences_replaced: replaceAll ? occurrences : 1,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ error: msg, file_path: filePath });
      }
    },
  );
}
