// ── Markdown parser coverage test (V-002 + V-004) ──
// Tests the underlying marked.lexer() that Markdown.tsx depends on.
// Avoids ink/react-reconciler import conflict.
//
// This verifies that the parser correctly handles all token types
// that Markdown.tsx's renderBlockToken() dispatches on.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lexer } from 'marked';

type Token = { type: string; text?: string; tokens?: Token[]; depth?: number; ordered?: boolean; items?: Token[]; raw?: string };

describe('V-002 Markdown parser — token coverage', () => {
  it('heading — parsed as heading token', () => {
    const tokens = lexer('# Title\n## Section\n### Sub\n#### Deep') as Token[];
    const headings = tokens.filter(t => t.type === 'heading');
    assert.equal(headings.length, 4, 'Should parse 4 headings');
    assert.equal(headings[0].depth, 1);
    assert.equal(headings[1].depth, 2);
    assert.equal(headings[2].depth, 3);
    assert.equal(headings[3].depth, 4);
  });

  it('bold — parsed as strong in inline tokens', () => {
    const tokens = lexer('this is **bold text** here') as Token[];
    const p = tokens[0];
    assert.equal(p.type, 'paragraph');
    const hasStrong = p.tokens?.some(t => t.type === 'strong');
    assert.ok(hasStrong, 'Should contain strong token');
  });

  it('italic — parsed as em in inline tokens', () => {
    const tokens = lexer('this is *italic text* here') as Token[];
    const p = tokens[0];
    const hasEm = p.tokens?.some(t => t.type === 'em');
    assert.ok(hasEm, 'Should contain em token');
  });

  it('codespan — parsed as codespan in inline tokens', () => {
    const tokens = lexer('use `trilc chat` to start') as Token[];
    const p = tokens[0];
    const hasCodespan = p.tokens?.some(t => t.type === 'codespan');
    assert.ok(hasCodespan, 'Should contain codespan token');
  });

  it('unordered list — parsed as list token with items', () => {
    const tokens = lexer('- item A\n- item B\n- item C') as Token[];
    const list = tokens[0];
    assert.equal(list.type, 'list');
    assert.equal(list.ordered, false);
    assert.equal(list.items?.length, 3, 'Should have 3 list items');
  });

  it('ordered list — parsed as list token with start', () => {
    const tokens = lexer('1. first\n2. second\n3. third') as Token[];
    const list = tokens[0];
    assert.equal(list.type, 'list');
    assert.equal(list.ordered, true);
    assert.equal(list.items?.length, 3);
  });

  it('blockquote — parsed as blockquote token', () => {
    const tokens = lexer('> quoted text here') as Token[];
    const bq = tokens[0];
    assert.equal(bq.type, 'blockquote');
    assert.ok(bq.tokens && bq.tokens.length > 0, 'Should have inner tokens');
  });

  it('hr — parsed as hr token', () => {
    const tokens = lexer('before\n\n---\n\nafter') as Token[];
    const hrTokens = tokens.filter(t => t.type === 'hr');
    assert.equal(hrTokens.length, 1, 'Should parse exactly 1 hr');
  });

  it('strikethrough — parsed as del in inline tokens', () => {
    const tokens = lexer('fix ~~wrong answer~~ please') as Token[];
    const p = tokens[0];
    const hasDel = p.tokens?.some(t => t.type === 'del');
    assert.ok(hasDel, 'Should contain del (strikethrough) token');
  });

  it('code block — parsed as code token', () => {
    const tokens = lexer('```\nconst x = 1;\nconsole.log(x);\n```') as Token[];
    const code = tokens[0];
    assert.equal(code.type, 'code');
    assert.ok(code.text?.includes('const'), 'Should contain code text');
  });

  it('link — parsed as link in inline tokens', () => {
    const tokens = lexer('see [the docs](https://example.com)') as Token[];
    const p = tokens[0];
    const hasLink = p.tokens?.some(t => t.type === 'link');
    assert.ok(hasLink, 'Should contain link token');
  });

  it('nested bold + italic — nested strong/em tokens', () => {
    const tokens = lexer('**bold *and italic* text**') as Token[];
    const p = tokens[0];
    const strongTokens = p.tokens?.filter(t => t.type === 'strong');
    assert.ok(strongTokens && strongTokens.length > 0, 'Should contain strong token');
    // Check that strong contains em
    const innerEm = strongTokens[0]?.tokens?.some(t => t.type === 'em');
    assert.ok(innerEm, 'Strong should contain nested em token');
  });

  it('empty content — returns empty token array', () => {
    const tokens = lexer('');
    assert.equal(tokens.length, 0);
  });

  it('malformed markdown — parser handles gracefully', () => {
    assert.doesNotThrow(() => {
      const tokens = lexer('**unclosed bold\n\n*still going');
      assert.ok(tokens.length > 0, 'Should produce tokens even for malformed input');
    });
  });
});

describe('V-004 CJK handling in Markdown parser', () => {
  it('Chinese text — parses as paragraph', () => {
    const tokens = lexer('你好世界') as Token[];
    assert.equal(tokens[0].type, 'paragraph');
  });

  it('Mixed Chinese and English — parses correctly', () => {
    const tokens = lexer('TriRLC终端TUI测试V1.0') as Token[];
    assert.equal(tokens[0].type, 'paragraph');
  });

  it('Emoji — parses correctly', () => {
    const tokens = lexer('测试通过 🎉') as Token[];
    assert.equal(tokens[0].type, 'paragraph');
  });

  it('CJK in bold — parses as strong', () => {
    const tokens = lexer('**重要通知**') as Token[];
    const p = tokens[0];
    const hasStrong = p.tokens?.some(t => t.type === 'strong');
    assert.ok(hasStrong, 'CJK in bold should be parsed');
  });

  it('CJK in list items — parses as list', () => {
    const tokens = lexer('- 第一项\n- 第二项\n- 第三项') as Token[];
    assert.equal(tokens[0].type, 'list');
    assert.equal(tokens[0].items?.length, 3);
  });

  it('CJK heading — parses as heading', () => {
    const tokens = lexer('# 系统升级通知') as Token[];
    assert.equal(tokens[0].type, 'heading');
    assert.equal(tokens[0].depth, 1);
  });
});
