// ── TriRLC Glob tool ──
// CC-equivalent file pattern search using pure Node.js fs.readdirSync.
// Supports **, *, ? glob patterns. No external dependencies.

import { readdirSync, statSync } from 'node:fs';
import { resolve, isAbsolute, sep, join } from 'node:path';
import { register as registerTool, type ToolContext } from '@tricompany/agent-core';

const MAX_RESULTS = 100;

// Convert a glob pattern to a regex for path matching.
// Supports: ** (any depth), * (single level), ? (single char), [chars] (char class)
function globToRegex(pattern: string): RegExp {
  // Normalize separators to forward slashes for consistent matching
  const normalized = pattern.replace(/\\/g, '/');

  let regexStr = '';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // ** matches any depth including /
        regexStr += '.*';
        i += 2;
        // Skip trailing slash after ** (e.g. **\/*.ts)
        if (normalized[i] === '/') i++;
      } else {
        // * matches within single directory level (no /)
        regexStr += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
      i++;
    } else if (ch === '[') {
      // Character class — copy verbatim as simplified approach
      const closeIdx = normalized.indexOf(']', i);
      if (closeIdx > i) {
        const charClass = normalized.slice(i, closeIdx + 1);
        regexStr += charClass.replace(/([.?+^${}()|\\])/g, '\\$1');
        i = closeIdx + 1;
      } else {
        regexStr += '\\[';
        i++;
      }
    } else if ('.?+^${}()|\\'.includes(ch)) {
      regexStr += '\\' + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }
  // Anchor: match the full path segment
  return new RegExp('^' + regexStr + '$');
}

function walkSync(dir: string, regex: RegExp, baseDir: string, results: string[]): void {
  if (results.length >= MAX_RESULTS) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // Permission denied or other issues
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    const fullPath = join(dir, entry);
    const relativePath = fullPath.slice(baseDir.length + 1).replace(/\\/g, '/');

    let isDir = false;
    try {
      const stat = statSync(fullPath);
      isDir = stat.isDirectory();
    } catch {
      continue;
    }

    // Match against the regex
    if (regex.test(entry) || regex.test(relativePath)) {
      results.push(fullPath);
      if (results.length >= MAX_RESULTS) break;
    }

    // Recurse into directories (skip node_modules for perf)
    if (isDir && entry !== 'node_modules' && !entry.startsWith('.')) {
      walkSync(fullPath, regex, baseDir, results);
    }
  }
}

// Alternative: also match against the full relative path
function walkSyncFullPath(dir: string, regex: RegExp, baseDir: string, results: string[]): void {
  if (results.length >= MAX_RESULTS) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) break;

    const fullPath = join(dir, entry);
    const relative = fullPath.slice(baseDir.length + 1).replace(/\\/g, '/');

    let isDir = false;
    try {
      const stat = statSync(fullPath);
      isDir = stat.isDirectory();
    } catch {
      continue;
    }

    if (regex.test(relative)) {
      results.push(fullPath);
      if (results.length >= MAX_RESULTS) break;
    }

    if (isDir && entry !== 'node_modules' && !entry.startsWith('.')) {
      walkSyncFullPath(fullPath, regex, baseDir, results);
    }
  }
}

export function registerGlobTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'Glob',
        description:
          'Fast file pattern matching. Supports glob patterns like "**/*.js" or "src/**/*.ts". Returns matching file paths sorted by modification time.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'The glob pattern to match files against',
            },
            path: {
              type: 'string',
              description:
                'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
            },
          },
          required: ['pattern'],
        },
      },
    },
    async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const pattern = args.pattern as string;
      // REQ-014b: resolve relative paths against the agent loop cwd (ctx.cwd),
      // not the daemon launch dir. ctx is absent in legacy call sites → fall
      // back to process.cwd() (unchanged legacy behavior).
      const base = ctx?.cwd ?? process.cwd();
      const searchPath = (args.path as string) || base;

      if (!pattern) return JSON.stringify({ error: 'pattern is required' });

      const absolutePath = isAbsolute(searchPath)
        ? searchPath
        : resolve(base, searchPath);

      // Validate directory exists
      try {
        const stat = statSync(absolutePath);
        if (!stat.isDirectory()) {
          return JSON.stringify({ error: `Path is not a directory: ${searchPath}` });
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return JSON.stringify({ error: `Directory does not exist: ${searchPath}` });
        }
        return JSON.stringify({ error: (e as Error).message });
      }

      const start = Date.now();
      const regex = globToRegex(pattern);
      const results: string[] = [];

      // Walk the directory tree
      walkSyncFullPath(absolutePath, regex, absolutePath, results);

      // Sort by mtime (most recent first)
      const withMtime = results.map((p) => {
        try {
          return { path: p, mtime: statSync(p).mtimeMs };
        } catch {
          return { path: p, mtime: 0 };
        }
      });
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const filenames = withMtime.map((f) => f.path);
      const truncated = results.length >= MAX_RESULTS;
      const durationMs = Date.now() - start;

      // Convert to relative paths for cleaner output
      const relativeFilenames = filenames.map((f) =>
        f.startsWith(absolutePath + sep)
          ? f.slice(absolutePath.length + 1)
          : f,
      );

      return JSON.stringify({
        filenames: relativeFilenames,
        duration_ms: durationMs,
        num_files: filenames.length,
        truncated,
      });
    },
  );
}
