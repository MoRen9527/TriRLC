// ── ToolCall line component (CC-aligned, ● + useBlink + human-readable descriptions) ──
// Displays what the tool is DOING, not just raw name+args.
// CC behavior: tool_use renders with tool description from definition.
// TriRLC: hardcodes descriptions for 5 CC tools + generic fallback.
//
// Status rendering:
//   pending: ● blinking (dim) — "正在读取文件…"
//   done:    ● solid green   — "已读取文件"
//   error:   ● solid red     — "读取文件失败"
import React from 'react';
import { Box, Text } from '../fork.js';
import { useBlink } from '../hooks/useBlink.js';

const BLACK_CIRCLE = '●';
const MAX_LINE_LEN = 70;
const BLINK_INTERVAL = 600; // CC-compatible: 600ms (was 800)

// ── Tool descriptions: what the tool is DOING ──
const TOOL_ACTIONS: Record<string, string> = {
  Read:   '读取文件',
  Write:  '写入文件',
  Edit:   '编辑文件',
  Bash:   '执行命令',
  Grep:   '搜索内容',
  Glob:   '查找文件',
};

function toolAction(name: string): string {
  return TOOL_ACTIONS[name] ?? `调用 ${name}`;
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function extractArg(name: string, argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return '';
    switch (name) {
      case 'Read':
      case 'Write':
        return obj.file_path ? `${obj.file_path}` : '';
      case 'Edit':
        if (!obj.file_path) return '';
        if (obj.old_string) {
          return `${obj.file_path} ("${trunc(String(obj.old_string), 20)}"→"${trunc(String(obj.new_string ?? ''), 20)}")`;
        }
        return `${obj.file_path}`;
      case 'Bash':
        return obj.command ? trunc(String(obj.command), 50) : '';
      case 'Grep':
      case 'Glob':
        return obj.pattern ? trunc(String(obj.pattern), 40) : '';
      default: {
        const entries = Object.entries(obj);
        if (entries.length === 0) return '';
        return entries.slice(0, 2).map(([k, v]) =>
          `${k}: ${trunc(String(v), 30)}`
        ).join(', ');
      }
    }
  } catch { return ''; }
}

function buildLine(name: string, argsJson: string, status: 'pending' | 'done' | 'error'): string {
  const action = toolAction(name);
  const arg = extractArg(name, argsJson);

  let full: string;
  if (status === 'pending') {
    full = arg ? `${action} ${arg}…` : `${action}…`;
  } else if (status === 'error') {
    full = arg ? `${action}失败: ${arg}` : `${action}失败`;
  } else {
    full = arg ? `${action}: ${arg}` : `${action}完成`;
  }

  return full.length <= MAX_LINE_LEN ? full : full.slice(0, MAX_LINE_LEN) + '…';
}

interface Props { name: string; args: string; status: 'pending' | 'done' | 'error'; }

export default function ToolCallLine({ name, args, status }: Props) {
  const [ref, isBlinking] = useBlink(status === 'pending', BLINK_INTERVAL);

  const showCircle = status !== 'pending' || isBlinking;

  const color = status === 'done' ? 'green'
              : status === 'error' ? 'red'
              : 'yellow';

  const dim = status === 'pending';
  const line = buildLine(name, args, status);

  // REGR-004: Split into two Boxes so blink toggles only affect the ● indicator.
  // Left Box binds the useBlink ref — only this Box changes on each blink tick.
  // Right Box (description text) is stable during pending, so Ink's reconciler
  // skips terminal updates for it, eliminating the full-line flicker.
  return React.createElement(Box, { marginLeft: 2, flexDirection: 'row' },
    // Left: blinking indicator only
    React.createElement(Box, { ref, minWidth: 2 },
      React.createElement(Text, { color, dimColor: dim }, showCircle ? BLACK_CIRCLE : ' '),
    ),
    // Right: description text (stable during blink, only changes on status transition)
    React.createElement(Box, { flexShrink: 1 },
      React.createElement(Text, { color, dimColor: dim }, ` ${line}`),
    ),
  );
}
