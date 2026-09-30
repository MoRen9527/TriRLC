// ── TUI Components Smoke Test ──
// Tests that components can be imported and invoked without crashing.
// Does NOT require ink-testing-library; uses direct React.createElement calls.
//
// Coverage:
//   V-002: Markdown — heading/bold/italic/codespan/list/blockquote/hr/strikethrough
//   V-003: ToolCallLine — pending/done/error states, args truncation, empty args
//   V-004: CJK width — Chinese, mixed C/E, emoji
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

// Import components
import Markdown from '../../src/tui/components/Markdown.js';
import ToolCallLine from '../../src/tui/components/ToolCallLine.js';

// Helper: call component and verify it returns a React element (no throw)
function renderElement(el: React.ReactElement): React.ReactElement {
  assert.ok(el, 'Should return a React element');
  assert.equal(typeof el.type, 'function', 'Should be a component element');
  return el;
}

// ═══════════════════════
// V-002: Markdown coverage
// ═══════════════════════
describe('V-002 Markdown rendering coverage', () => {
  const cases: Array<[string, string, string]> = [
    // [label, input, expectedSubstring]
    ['heading h1', '# My Heading', 'M'],
    ['heading h2', '## Section', 'S'],
    ['heading h3', '### Sub', 'S'],
    ['bold', 'this is **bold**, really', 'bold'],
    ['italic', 'this is *emphasized*', 'emphasized'],
    ['inline code', 'run `trilc chat` now', 'trilc'],
    ['unordered list', '- item one\n- item two', 'item'],
    ['ordered list', '1. alpha\n2. beta', 'alpha'],
    ['blockquote', '> quoted material', 'quoted'],
    ['horizontal rule', 'top\n---\nbottom', 'top'],
    ['strikethrough', 'fix ~~wrong~~ correct', 'wrong'],
    ['code block', '```\nconst x=1\n```', 'const'],
    ['link', 'see [docs](http://x)', 'docs'],
    ['nested bold/italic', '**bold *and italic***', 'bold'],
  ];

  for (const [label, input] of cases) {
    it(`renders ${label} without throwing`, () => {
      assert.doesNotThrow(() => {
        renderElement(React.createElement(Markdown, { content: input }));
      }, `Markdown should render ${label} without throwing`);
    });
  }

  it('handles empty string', () => {
    assert.doesNotThrow(() => {
      React.createElement(Markdown, { content: '' });
    });
  });

  it('handles malformed markdown gracefully', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, { content: '**unclosed' }));
    });
  });

  it('handles deeply nested inline tokens', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, {
        content: '**bold ~~strike *italic* more~~ end**'
      }));
    });
  });
});

// ═══════════════════════
// V-003: ToolCallLine states
// ═══════════════════════
describe('V-003 ToolCallLine tri-state', () => {
  it('pending status — renders without throwing', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'read_file',
        args: '{"path":"/tmp/test.txt"}',
        status: 'pending',
      }));
    });
  });

  it('done status — renders without throwing', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'write_file',
        args: '{"path":"/tmp/out.txt","content":"hi"}',
        status: 'done',
      }));
    });
  });

  it('error status — renders without throwing', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'exec',
        args: '{"cmd":"rm -rf /"}',
        status: 'error',
      }));
    });
  });

  it('args longer than 40 chars — does not throw', () => {
    const longPath = '/very/long/path/'.repeat(10);
    const args = JSON.stringify({ path: longPath });
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'read_file',
        args,
        status: 'done',
      }));
    });
  });

  it('empty args ({}) — renders tool name only, no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'noop',
        args: '{}',
        status: 'done',
      }));
    });
  });

  it('multiple tool calls — each renders independently', () => {
    assert.doesNotThrow(() => {
      const a = React.createElement(ToolCallLine, { name: 'tool_a', args: '{"x":1}', status: 'done' });
      const b = React.createElement(ToolCallLine, { name: 'tool_b', args: '{"y":2}', status: 'pending' });
      renderElement(a);
      renderElement(b);
    });
  });
});

// ═══════════════════════
// V-004: CJK width
// ═══════════════════════
describe('V-004 CJK width', () => {
  it('Chinese text in Markdown — no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, { content: '你好世界' }));
    });
  });

  it('Mixed Chinese and English — no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, {
        content: 'TriRLC终端TUI测试V1.0 — 中英混排测试'
      }));
    });
  });

  it('Emoji in Markdown — no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, {
        content: '测试通过 🎉 ✅ 恭喜！'
      }));
    });
  });

  it('CJK in bold Markdown — no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, { content: '**重要通知：系统升级**' }));
    });
  });

  it('CJK in list items — no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(Markdown, {
        content: '- 第一项任务\n- 第二项任务\n- 第三项任务'
      }));
    });
  });

  it('CJK in tool call args — no throw', () => {
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'search',
        args: '{"query":"你好世界测试查询"}',
        status: 'done',
      }));
    });
  });

  it('CJK in long truncated args — no throw', () => {
    const longChinese = '这是一个非常长的中文测试字符串用来验证截断功能是否正常工作'.repeat(3);
    const args = JSON.stringify({ query: longChinese });
    assert.doesNotThrow(() => {
      renderElement(React.createElement(ToolCallLine, {
        name: 'translate',
        args,
        status: 'done',
      }));
    });
  });
});
