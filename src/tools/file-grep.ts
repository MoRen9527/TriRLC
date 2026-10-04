// ── TriRLC Grep tool ──
// CC-equivalent content search. Tries system ripgrep (rg) first,
// falls back to pure Node.js regex scan. Supports all CC grep features:
// output_mode, context lines (-A/-B/-C), case-insensitive, glob filter,
// head_limit, offset, multiline mode.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { execSync } from 'node:child_process';
import { register as registerTool, type ToolContext } from '@tricompany/agent-core';

const DEFAULT_HEAD_LIMIT = 250;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB per file max for JS fallback
const VCS_DIRS = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']);

// ── Ripgrep path ──
function findRg(): string | null {
  try {
    // On Windows, try where
    const output = execSync(
      process.platform === 'win32' ? 'where rg 2>nul' : 'which rg 2>/dev/null',
      { encoding: 'utf-8', timeout: 2000 },
    ).trim();
    return output ? output.split('\n')[0].trim() : null;
  } catch {
    return null;
  }
}

// ── Glob-to-regex helper ──
function globToRegex(glob: string): RegExp {
  const normalized = glob.replace(/\\/g, '/');
  let regexStr = '^';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // **/ or ** at end
        if (normalized[i + 2] === '/') {
          regexStr += '(.*\\/)?';
          i += 2;
        } else {
          regexStr += '.*';
          i += 1;
          if (normalized[i + 1] === '/') i++;
        }
      } else {
        regexStr += '[^/]*';
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else if ('.?+^${}()|[]\\'.includes(ch)) {
      regexStr += '\\' + ch;
    } else {
      regexStr += ch;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

// Split comma/whitespace-separated glob filter into individual patterns
function parseGlobFilter(globStr: string): RegExp[] {
  // Split on commas first, then whitespace
  const parts = globStr.split(/[\s,]+/).filter(Boolean);
  // Handle brace patterns by not splitting inside braces
  const merged: string[] = [];
  for (const part of parts) {
    if (part.includes('{') && part.includes('}')) {
      merged.push(part);
    } else {
      merged.push(part);
    }
  }
  return merged.map(globToRegex);
}

// ── JS fallback: recursive file walk ──
function walkFiles(
  dir: string,
  globFilters: RegExp[] | null,
  fileList: string[],
  maxFiles: number = 5000,
): void {
  if (fileList.length >= maxFiles) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (fileList.length >= maxFiles) break;
    if (VCS_DIRS.has(entry)) continue;
    if (entry === 'node_modules') continue;

    const fullPath = join(dir, entry);
    let isDir = false;
    try {
      const stat = statSync(fullPath);
      isDir = stat.isDirectory();
    } catch {
      continue;
    }

    if (!isDir) {
      // Apply glob filter
      if (globFilters && globFilters.length > 0) {
        const basename = entry;
        const matches = globFilters.some((r) => r.test(basename));
        if (!matches) continue;
      }
      fileList.push(fullPath);
    } else if (!entry.startsWith('.')) {
      walkFiles(fullPath, globFilters, fileList, maxFiles);
    }
  }
}

// ── JS fallback: grep implementation ──
function jsGrep(args: {
  pattern: string;
  searchPath: string;
  globFilter: string | undefined;
  outputMode: string;
  contextBefore: number;
  contextAfter: number;
  contextAround: number;
  caseInsensitive: boolean;
  showLineNumbers: boolean;
  headLimit: number | undefined;
  offset: number;
  multiline: boolean;
}): object {
  const {
    pattern,
    searchPath,
    globFilter,
    outputMode,
    contextBefore,
    contextAfter,
    contextAround,
    caseInsensitive,
    showLineNumbers,
    headLimit,
    offset,
    multiline,
  } = args;

  // Build regex
  let flags = 'g';
  if (caseInsensitive) flags += 'i';
  if (multiline) flags += 'ms';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (e) {
    return { error: `Invalid regex pattern: ${(e as Error).message}` };
  }

  // Collect files
  const globFilters = globFilter ? parseGlobFilter(globFilter) : null;
  const files: string[] = [];
  walkFiles(searchPath, globFilters, files);

  // Context
  const ctxBefore = contextAround > 0 ? contextAround : contextBefore;
  const ctxAfter = contextAround > 0 ? contextAround : contextAfter;

  const matchResults: Array<{ file: string; lineNum: number; line: string; context: string[] }> = [];
  let totalMatches = 0;

  for (const filePath of files) {
    let content: string;
    try {
      const stat = statSync(filePath);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    if (content.endsWith('\n')) lines.pop();

    let fileHasMatch = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(regex);
      if (match !== null) {
        fileHasMatch = true;
        totalMatches++;

        if (outputMode === 'files_with_matches') break; // Early exit

        // For content mode, capture context
        if (outputMode === 'content') {
          const ctxStart = Math.max(0, i - ctxBefore);
          const ctxEnd = Math.min(lines.length, i + ctxAfter + 1);
          const contextLines: string[] = [];
          for (let j = ctxStart; j < ctxEnd; j++) {
            if (j === i) continue; // The matched line itself
            contextLines.push(
              (showLineNumbers ? `${String(j + 1).padStart(6, ' ')}:${j === i ? '>' : ' '}` : '') + lines[j],
            );
          }
          matchResults.push({
            file: filePath,
            lineNum: i + 1,
            line,
            context: contextLines,
          });
        }
      }
      // After regex lastIndex with global flag on multiline... need to reset
      regex.lastIndex = 0;
    }

    // For files_with_matches, just record
    if (outputMode === 'files_with_matches' && fileHasMatch) {
      matchResults.push({ file: filePath, lineNum: 0, line: '', context: [] });
    }

    // For count mode
    if (outputMode === 'count') {
      // We'll aggregate later
    }
  }

  // Apply head_limit and offset
  const effectiveLimit = headLimit ?? DEFAULT_HEAD_LIMIT;
  const startIdx = Math.min(offset, matchResults.length);
  const limited = matchResults.slice(startIdx, startIdx + effectiveLimit);

  // Build output based on mode
  if (outputMode === 'files_with_matches') {
    const filenames = limited.map((r) => r.file);
    return {
      mode: 'files_with_matches',
      num_files: filenames.length,
      filenames,
      applied_limit: matchResults.length > startIdx + effectiveLimit ? effectiveLimit : undefined,
      applied_offset: offset > 0 ? offset : undefined,
    };
  }

  if (outputMode === 'content') {
    const parts: string[] = [];
    for (const r of limited) {
      // Show context before
      const beforeLines = r.context.filter((cl, idx) => {
        // context lines before the match
        return idx < ctxBefore;
      });
      for (const cl of beforeLines) {
        parts.push(`${r.file}-${cl}`);
      }
      // Show the matching line
      parts.push(
        `${r.file}:${showLineNumbers ? r.lineNum + ':' : ''}${r.line}`,
      );
      // Show context after
      const afterLines = r.context.slice(ctxBefore);
      for (const cl of afterLines) {
        parts.push(`${r.file}-${cl}`);
      }
      // Separator between file groups
      if (limited.length > 1) parts.push('--');
    }
    return {
      mode: 'content',
      content: parts.join('\n'),
      num_lines: limited.length,
      applied_limit: matchResults.length > startIdx + effectiveLimit ? effectiveLimit : undefined,
      applied_offset: offset > 0 ? offset : undefined,
    };
  }

  // count mode
  if (outputMode === 'count') {
    // Count matches per file
    const fileCounts = new Map<string, number>();
    for (const f of files) {
      let content: string;
      try {
        const stat = statSync(f);
        if (stat.size > MAX_FILE_SIZE_BYTES) continue;
        content = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      const matches = content.match(regex);
      if (matches) {
        fileCounts.set(f, (fileCounts.get(f) || 0) + matches.length);
      }
    }
    const entries = Array.from(fileCounts.entries()).slice(startIdx, startIdx + effectiveLimit);
    return {
      mode: 'count',
      num_files: entries.length,
      num_matches: entries.reduce((sum, [, c]) => sum + c, 0),
      content: entries.map(([f, c]) => `${f}:${c}`).join('\n'),
      applied_limit: fileCounts.size > startIdx + effectiveLimit ? effectiveLimit : undefined,
      applied_offset: offset > 0 ? offset : undefined,
    };
  }

  return { error: `Unknown output_mode: ${outputMode}` };
}

// ── Ripgrep-based implementation ──
function rgGrep(args: {
  pattern: string;
  searchPath: string;
  globFilter: string | undefined;
  outputMode: string;
  contextBefore: number;
  contextAfter: number;
  contextAround: number;
  caseInsensitive: boolean;
  showLineNumbers: boolean;
  headLimit: number | undefined;
  offset: number;
  multiline: boolean;
  typeFilter: string | undefined;
}): object {
  const {
    pattern,
    searchPath,
    globFilter,
    outputMode,
    contextBefore,
    contextAfter,
    contextAround,
    caseInsensitive,
    showLineNumbers,
    headLimit,
    offset,
    multiline,
    typeFilter,
  } = args;

  // Build rg command
  const rgArgs: string[] = ['--no-heading', '--hidden'];

  // VCS exclusions
  for (const dir of VCS_DIRS) {
    rgArgs.push('--glob', `!${dir}`);
  }
  // Skip binary files
  rgArgs.push('--max-columns', '500');

  if (multiline) {
    rgArgs.push('-U', '--multiline-dotall');
  }
  if (caseInsensitive) {
    rgArgs.push('-i');
  }
  if (showLineNumbers && outputMode === 'content') {
    rgArgs.push('-n');
  }
  if (outputMode === 'files_with_matches') {
    rgArgs.push('-l');
  } else if (outputMode === 'count') {
    rgArgs.push('-c');
  }

  // Context
  if (outputMode === 'content') {
    const ctx = contextAround > 0
      ? contextAround
      : Math.max(contextBefore, contextAfter);
    if (ctx > 0) {
      rgArgs.push('-C', String(ctx));
    }
  }

  if (typeFilter) {
    rgArgs.push('--type', typeFilter);
  }
  if (globFilter) {
    const globs = globFilter.split(/[\s,]+/).filter(Boolean);
    for (const g of globs) {
      rgArgs.push('--glob', g);
    }
  }

  // Pattern (use -e if starts with dash)
  if (pattern.startsWith('-')) {
    rgArgs.push('-e', pattern);
  } else {
    rgArgs.push(pattern);
  }

  rgArgs.push(searchPath);

  const rgPath = findRg();
  if (!rgPath) {
    // No rg found, fall through to JS
    return { _fallback: true };
  }

  try {
    const output = execSync(`"${rgPath}" ${rgArgs.map((a) => `"${a}"`).join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });

    const lines = output.trim().split('\n').filter(Boolean);

    // Apply head_limit and offset
    const effectiveLimit = (headLimit === 0) ? Infinity : (headLimit ?? DEFAULT_HEAD_LIMIT);
    const limited = effectiveLimit === Infinity
      ? lines.slice(offset)
      : lines.slice(offset, offset + effectiveLimit);

    if (outputMode === 'files_with_matches') {
      return {
        mode: 'files_with_matches',
        num_files: limited.length,
        filenames: limited,
        applied_limit: lines.length > offset + effectiveLimit && effectiveLimit !== Infinity ? effectiveLimit : undefined,
        applied_offset: offset > 0 ? offset : undefined,
      };
    }

    if (outputMode === 'count') {
      let total = 0;
      for (const line of limited) {
        const idx = line.lastIndexOf(':');
        if (idx > 0) {
          const count = parseInt(line.slice(idx + 1), 10);
          if (!isNaN(count)) total += count;
        }
      }
      return {
        mode: 'count',
        num_files: limited.length,
        num_matches: total,
        content: limited.join('\n'),
        applied_limit: lines.length > offset + effectiveLimit && effectiveLimit !== Infinity ? effectiveLimit : undefined,
        applied_offset: offset > 0 ? offset : undefined,
      };
    }

    // content mode
    return {
      mode: 'content',
      content: limited.join('\n'),
      num_lines: limited.length,
      applied_limit: lines.length > offset + effectiveLimit && effectiveLimit !== Infinity ? effectiveLimit : undefined,
      applied_offset: offset > 0 ? offset : undefined,
    };
  } catch (err) {
    // rg not found or failed — fall through to JS
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found') || msg.includes('ENOENT')) {
      return { _fallback: true };
    }
    return { error: `rg error: ${msg.slice(0, 200)}` };
  }
}

// ── Tool registration ──

export function registerGrepTool(): void {
  registerTool(
    {
      type: 'function',
      function: {
        name: 'Grep',
        description:
          'Content search built on ripgrep (falls back to pure JS). Search specific text (in the pattern parameter) under a specific directory.\n' +
          'Usage:\n' +
          '- Prefer grep for exact symbol/string searches. Whenever possible, use this instead of terminal grep/rg. This tool is faster and respects .gitignore.\n' +
          '- Supports full regex syntax, e.g. "log.*Error", "function\\s+\\w+". Ensure you escape special chars to get exact matches, e.g. "functionCall\\("\n' +
          '- Supports file type filtering, context lines.\n' +
          '- Supports head_limit to limit output lines/entries.\n' +
          '- Supports offset for pagination.\n' +
          '- CRITICAL: output_mode must be specified BEFORE any other parameter. Put it first in the function call arguments.',
        parameters: {
          type: 'object',
          properties: {
            pattern: {
              type: 'string',
              description: 'The regular expression pattern to search for in file contents',
            },
            path: {
              type: 'string',
              description: 'File or directory to search in (rg PATH). Defaults to current working directory.',
            },
            glob: {
              type: 'string',
              description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
            },
            output_mode: {
              type: 'string',
              enum: ['content', 'files_with_matches', 'count'],
              description: 'Output mode. Defaults to "files_with_matches".',
            },
            '-A': {
              type: 'integer',
              description: 'Number of lines to show after each match (rg -A). Requires output_mode: "content".',
            },
            '-B': {
              type: 'integer',
              description: 'Number of lines to show before each match (rg -B). Requires output_mode: "content".',
            },
            '-C': {
              type: 'integer',
              description: 'Alias for context.',
            },
            context: {
              type: 'integer',
              description: 'Number of lines to show before and after each match (rg -C). Requires output_mode: "content".',
            },
            '-n': {
              type: 'boolean',
              description: 'Show line numbers in output. Defaults to true.',
            },
            '-i': {
              type: 'boolean',
              description: 'Case insensitive search (rg -i)',
            },
            type: {
              type: 'string',
              description: 'File type to search (rg --type). Common types: js, py, rust, go, java, etc.',
            },
            head_limit: {
              type: 'integer',
              description: 'Limit output to first N lines/entries. Defaults to 250 when unspecified.',
            },
            offset: {
              type: 'integer',
              description: 'Skip first N lines/entries before applying head_limit. Defaults to 0.',
            },
            multiline: {
              type: 'boolean',
              description: 'Enable multiline mode. Default: false.',
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
      const globFilter = args.glob as string | undefined;
      const outputMode = (args.output_mode as string) || 'files_with_matches';
      const contextBefore = (args['-B'] as number) || 0;
      const contextAfter = (args['-A'] as number) || 0;
      const contextAround = (args['-C'] as number) || (args.context as number) || 0;
      const caseInsensitive = args['-i'] === true;
      const showLineNumbers = args['-n'] !== false; // Default true
      const headLimit = args.head_limit as number | undefined;
      const offset = (args.offset as number) || 0;
      const multiline = args.multiline === true;
      const typeFilter = args.type as string | undefined;

      if (!pattern) return JSON.stringify({ error: 'pattern is required' });

      const absolutePath = isAbsolute(searchPath)
        ? searchPath
        : resolve(base, searchPath);

      // Try ripgrep first
      const rgResult = rgGrep({
        pattern,
        searchPath: absolutePath,
        globFilter,
        outputMode,
        contextBefore,
        contextAfter,
        contextAround,
        caseInsensitive,
        showLineNumbers,
        headLimit: headLimit,
        offset,
        multiline,
        typeFilter,
      });

      if (!(rgResult as { _fallback?: boolean })._fallback) {
        return JSON.stringify(rgResult);
      }

      // JS fallback
      const jsResult = jsGrep({
        pattern,
        searchPath: absolutePath,
        globFilter,
        outputMode,
        contextBefore,
        contextAfter,
        contextAround,
        caseInsensitive,
        showLineNumbers,
        headLimit: headLimit,
        offset,
        multiline,
      });

      return JSON.stringify(jsResult);
    },
  );
}
