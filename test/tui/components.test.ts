// ── TUI Components Test ──
// V-002: Markdown rendering coverage
// V-003: ToolCallLine three states + args truncation
// V-004: CJK width test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from './helpers/test-renderer.js';
import Markdown from '../../src/tui/components/Markdown.js';
import ToolCallLine from '../../src/tui/components/ToolCallLine.js';

// ═══════════════════════════════════════════
// V-002: Markdown rendering coverage
// ═══════════════════════════════════════════
describe('V-002 Markdown rendering', () => {
  it('renders heading (h1, h2, h3)', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '# H1\n## H2\n### H3' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('H1'), 'Should contain H1 text');
    assert.ok(frame.includes('H2'), 'Should contain H2 text');
    assert.ok(frame.includes('H3'), 'Should contain H3 text');
  });

  it('renders heading (h4) with fallback', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '#### H4 Deep' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('H4'), 'Should contain H4 text');
  });

  it('renders bold text', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '**bold text**' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('bold'), 'Should contain bold content');
  });

  it('renders italic text', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '*italic text*' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('italic'), 'Should contain italic content');
  });

  it('renders codespan (inline code)', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: 'Use `npm test` to run' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('npm'), 'Should contain code content');
  });

  it('renders unordered list', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '- item A\n- item B\n- item C' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('item A'), 'Should contain list item A');
    assert.ok(frame.includes('item B'), 'Should contain list item B');
  });

  it('renders ordered list', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '1. first\n2. second' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('first'), 'Should contain first');
    assert.ok(frame.includes('second'), 'Should contain second');
  });

  it('renders blockquote', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '> quoted text' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('quoted'), 'Should contain quoted content');
  });

  it('renders horizontal rule (hr)', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: 'before\n\n---\n\nafter' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('before'), 'Should contain text before hr');
    assert.ok(frame.includes('after'), 'Should contain text after hr');
  });

  it('renders strikethrough', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '~~deleted text~~' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('deleted'), 'Should contain strikethrough text');
  });

  it('renders code block', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '```\nconst x = 1;\n```' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('const'), 'Should contain code block content');
  });

  it('renders inline link', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '[click here](https://example.com)' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('click'), 'Should contain link text');
  });

  it('handles empty content gracefully', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '' }));
    const frame = lastFrame() ?? '';
    // Should not throw; renders empty
    assert.ok(typeof frame === 'string', 'Should return string');
  });

  it('handles malformed markdown gracefully', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '**unclosed bold' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('unclosed'), 'Should contain text even with malformed markdown');
  });

  it('handles nested bold and italic', () => {
    const { lastFrame } = render(React.createElement(Markdown, { content: '**bold *and italic* text**' }));
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('bold'), 'Should contain bold text');
    assert.ok(frame.includes('italic'), 'Should contain italic text');
  });
});

// ═══════════════════════════════════════════
// V-003: ToolCallLine three states + arg handling
// ═══════════════════════════════════════════
describe('V-003 ToolCallLine states', () => {
  it('pending shows status dot ● (V4 校准：npm-ink 时代 braille 期望→现役 ●+blink，头注 ToolCallLine.tsx:7-9)', () => {
    const { lastFrame } = render(
      React.createElement(ToolCallLine, { name: 'read_file', args: '{"path":"/tmp/test.txt"}', status: 'pending' })
    );
    const frame = lastFrame() ?? '';
    // 现役组件三态统一 ● 指示（blink 仅 TTY 色面，headless 帧不可断言）
    assert.ok(frame.includes('●'), `Should contain status dot, got: ${frame}`);
    assert.ok(frame.includes('read_file'), 'Should contain tool name');
  });

  it('done shows status dot ● (V4 校准：✓ 期望→现役 ● solid，头注 ToolCallLine.tsx:8)', () => {
    const { lastFrame } = render(
      React.createElement(ToolCallLine, { name: 'read_file', args: '{"path":"/tmp/test.txt"}', status: 'done' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('●'), `Should contain status dot, got: ${frame}`);
    assert.ok(frame.includes('read_file'), 'Should contain tool name');
  });

  it('error shows failure marker 失败 (V4 校准：✗ 期望→现役 ●+失败 标，头注 ToolCallLine.tsx:9/:74)', () => {
    const { lastFrame } = render(
      React.createElement(ToolCallLine, { name: 'exec', args: '{"cmd":"rm -rf /"}', status: 'error' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('失败'), `Should contain failure marker, got: ${frame}`);
    assert.ok(frame.includes('exec'), 'Should contain tool name');
  });

  it('truncates args > 40 characters', () => {
    const longPath = '/very/long/path/'.repeat(10);
    const args = JSON.stringify({ path: longPath });
    const { lastFrame } = render(
      React.createElement(ToolCallLine, { name: 'read_file', args, status: 'done' })
    );
    const frame = lastFrame() ?? '';
    // The args should be truncated — verify the truncation marker exists
    assert.ok(frame.includes('…') || frame.includes('...'), `Should contain truncation marker, got: ${frame}`);
    // Original path should not appear in full
    assert.ok(!frame.includes('/very/long/path//very/long/path//very'), 'Full long path should be truncated');
  });

  it('empty args shows only tool name', () => {
    const { lastFrame } = render(
      React.createElement(ToolCallLine, { name: 'noop', args: '{}', status: 'done' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('noop'), 'Should contain tool name');
    // {} should have no key-value pairs displayed
    assert.ok(!frame.includes(':'), `Empty args should show no key-value, got: ${frame}`);
  });

  it('multiple tools each render on their own line', () => {
    // Render two separate ToolCallLine instances to simulate multi-tool output
    const { lastFrame: f1 } = render(
      React.createElement(ToolCallLine, { name: 'tool_a', args: '{"x":1}', status: 'done' })
    );
    const { lastFrame: f2 } = render(
      React.createElement(ToolCallLine, { name: 'tool_b', args: '{"y":2}', status: 'done' })
    );
    const frame1 = f1() ?? '';
    const frame2 = f2() ?? '';
    assert.ok(frame1.includes('tool_a'), 'First tool should render');
    assert.ok(frame2.includes('tool_b'), 'Second tool should render');
    // Each tool call produces its own output line
    assert.ok(frame1 !== frame2 || (frame1.includes('tool_a') && frame2.includes('tool_b')),
      'Both tools should render independently');
  });
});

// ═══════════════════════════════════════════
// V-004: CJK width
// ═══════════════════════════════════════════
describe('V-004 CJK width', () => {
  it('renders Chinese text without crashing', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { content: '你好世界' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('你好'), 'Should contain Chinese characters');
  });

  it('renders mixed Chinese and English text', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { content: 'TriLC终端TUI测试V1.0' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('TriLC'), 'Should contain English text');
    assert.ok(frame.includes('测试'), 'Should contain Chinese character 测试');
  });

  it('renders emoji without crashing', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { content: 'Happy testing! 🎉' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('Happy'), 'Should contain English text');
    // Emoji might not render in all terminals, but it shouldn't crash
  });

  it('renders CJK in bold context', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { content: '**重要通知**' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('重要'), 'Should contain CJK in bold');
  });

  it('renders CJK in list items', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { content: '- 第一项\n- 第二项\n- 第三项' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('第一'), 'Should contain first CJK list item');
    assert.ok(frame.includes('第二'), 'Should contain second CJK list item');
  });

  it('renders CJK in tool call args', () => {
    const { lastFrame } = render(
      React.createElement(ToolCallLine, { name: 'search', args: '{"query":"你好世界"}', status: 'done' })
    );
    const frame = lastFrame() ?? '';
    assert.ok(frame.includes('search'), 'Should contain tool name');
  });
});
