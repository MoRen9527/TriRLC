// ── Cursor model ──
// Extracted from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts (A级复制)
// Stripped: kill ring, render, imageRef, Vim methods, logical-line methods,
//           delete series, findCharacter, goToLine, viewport methods
// Adapted: left() / right() — no imageRef chip-hopping

import stringWidth from 'string-width';
import { MeasuredText } from './MeasuredText.js';

// ── Kill ring (A级复制 from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts) ──
// Global state shared across all input fields.
const KILL_RING_MAX_SIZE = 10;
let killRing: string[] = [];
let killRingIndex = 0;
let lastActionWasKill = false;
let lastYankStart = 0;
let lastYankLength = 0;
let lastActionWasYank = false;

export function pushToKillRing(text: string, direction: 'prepend' | 'append' = 'append'): void {
  if (text.length > 0) {
    if (lastActionWasKill && killRing.length > 0) {
      if (direction === 'prepend') killRing[0] = text + killRing[0];
      else killRing[0] = killRing[0] + text;
    } else {
      killRing.unshift(text);
      if (killRing.length > KILL_RING_MAX_SIZE) killRing.pop();
    }
    lastActionWasKill = true;
    lastActionWasYank = false;
  }
}

export function getLastKill(): string { return killRing[0] ?? ''; }
export function getKillRingSize(): number { return killRing.length; }
export function resetKillAccumulation(): void { lastActionWasKill = false; }

export function yankPop(): { text: string; start: number; length: number } | null {
  if (!lastActionWasYank || killRing.length <= 1) return null;
  killRingIndex = (killRingIndex + 1) % killRing.length;
  const text = killRing[killRingIndex] ?? '';
  return { text, start: lastYankStart, length: lastYankLength };
}

export function updateYankLength(length: number): void { lastYankLength = length; }

export function recordYank(start: number, length: number): void {
  lastYankStart = start;
  lastYankLength = length;
  killRingIndex = 0;
  lastActionWasYank = true;
}

function clearYankState(): void {
  lastYankStart = 0; lastYankLength = 0; lastActionWasYank = false;
}

// ── Vim helpers (A级复制 from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts) ──
export const WHITESPACE_REGEX = /\s/;
export const isVimWhitespace = (ch: string): boolean => WHITESPACE_REGEX.test(ch);
const VIM_WORD_REGEX = /^[\wÀ-ÖØ-öø-ÿ]$/u;
export const isVimWordChar = (ch: string): boolean =>
  ch.length > 0 && !isVimWhitespace(ch) && VIM_WORD_REGEX.test(ch);
export const isVimPunctuation = (ch: string): boolean =>
  ch.length > 0 && !isVimWhitespace(ch) && !isVimWordChar(ch);

type Position = {
  line: number;
  column: number;
};

export class Cursor {
  readonly offset: number;
  constructor(
    readonly measuredText: MeasuredText,
    offset: number = 0,
    readonly selection: number = 0,
  ) {
    // it's ok for the cursor to be 1 char beyond the end of the string
    this.offset = Math.max(0, Math.min(this.text.length, offset));
  }

  static fromText(
    text: string,
    columns: number,
    offset: number = 0,
    selection: number = 0,
  ): Cursor {
    // make MeasuredText on less than columns width, to account for cursor
    return new Cursor(new MeasuredText(text, columns - 1), offset, selection);
  }

  public get text(): string {
    return this.measuredText.text;
  }

  private get columns(): number {
    return this.measuredText.columns + 1;
  }

  getPosition(): Position {
    return this.measuredText.getPositionFromOffset(this.offset);
  }

  private getOffset(position: Position): number {
    return this.measuredText.getOffsetFromPosition(position);
  }

  // ── adapted: no imageRef chip-hopping ──
  left(): Cursor {
    if (this.offset === 0) return this;
    const prevOffset = this.measuredText.prevOffset(this.offset);
    return new Cursor(this.measuredText, prevOffset);
  }

  // ── adapted: no imageRef chip-hopping ──
  right(): Cursor {
    if (this.offset >= this.text.length) return this;
    const nextOffset = this.measuredText.nextOffset(this.offset);
    return new Cursor(this.measuredText, Math.min(nextOffset, this.text.length));
  }

  /**
   * Move to the start of the current line (column 0).
   * This is the raw version used internally by startOfLine.
   */
  private startOfCurrentLine(): Cursor {
    const { line } = this.getPosition();
    return new Cursor(
      this.measuredText,
      this.getOffset({ line, column: 0 }),
      0,
    );
  }

  startOfLine(): Cursor {
    const { line, column } = this.getPosition();

    // If already at start of line and not at first line, move to previous line
    if (column === 0 && line > 0) {
      return new Cursor(
        this.measuredText,
        this.getOffset({ line: line - 1, column: 0 }),
        0,
      );
    }

    return this.startOfCurrentLine();
  }

  firstNonBlankInLine(): Cursor {
    const { line } = this.getPosition();
    const lineText = this.measuredText.getWrappedText()[line] || '';

    const match = lineText.match(/^\s*\S/);
    const column = match?.index ? match.index + match[0].length - 1 : 0;
    const offset = this.getOffset({ line, column });

    return new Cursor(this.measuredText, offset, 0);
  }

  endOfLine(): Cursor {
    const { line } = this.getPosition();
    const column = this.measuredText.getLineLength(line);
    const offset = this.getOffset({ line, column });
    return new Cursor(this.measuredText, offset, 0);
  }

  // ── Word movement (Intl.Segmenter based) ──

  nextWord(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }

    // Use Intl.Segmenter for proper word boundary detection (including CJK)
    const wordBoundaries = this.measuredText.getWordBoundaries();

    // Find the next word start boundary after current position
    for (const boundary of wordBoundaries) {
      if (boundary.isWordLike && boundary.start > this.offset) {
        return new Cursor(this.measuredText, boundary.start);
      }
    }

    // If no next word found, go to end
    return new Cursor(this.measuredText, this.text.length);
  }

  endOfWord(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }

    // Use Intl.Segmenter for proper word boundary detection (including CJK)
    const wordBoundaries = this.measuredText.getWordBoundaries();

    // Find the current word boundary we're in
    for (const boundary of wordBoundaries) {
      if (!boundary.isWordLike) continue;

      // If we're inside this word but NOT at the last character
      if (this.offset >= boundary.start && this.offset < boundary.end - 1) {
        // Move to end of this word (last character position)
        return new Cursor(this.measuredText, boundary.end - 1);
      }

      // If we're at the last character of a word (end - 1), find the next word's end
      if (this.offset === boundary.end - 1) {
        // Find next word
        for (const nextBoundary of wordBoundaries) {
          if (nextBoundary.isWordLike && nextBoundary.start > this.offset) {
            return new Cursor(this.measuredText, nextBoundary.end - 1);
          }
        }
        return this;
      }
    }

    // If not in a word, find the next word and go to its end
    for (const boundary of wordBoundaries) {
      if (boundary.isWordLike && boundary.start > this.offset) {
        return new Cursor(this.measuredText, boundary.end - 1);
      }
    }

    return this;
  }

  prevWord(): Cursor {
    if (this.isAtStart()) {
      return this;
    }

    // Use Intl.Segmenter for proper word boundary detection (including CJK)
    const wordBoundaries = this.measuredText.getWordBoundaries();

    // Find the previous word start boundary before current position
    // We need to iterate in reverse to find the previous word
    let prevWordStart: number | null = null;

    for (const boundary of wordBoundaries) {
      if (!boundary.isWordLike) continue;

      // If we're at or after the start of this word, but this word starts before us
      if (boundary.start < this.offset) {
        // If we're inside this word (not at the start), go to its start
        if (this.offset > boundary.start && this.offset <= boundary.end) {
          return new Cursor(this.measuredText, boundary.start);
        }
        // Otherwise, remember this as a candidate for previous word
        prevWordStart = boundary.start;
      }
    }

    if (prevWordStart !== null) {
      return new Cursor(this.measuredText, prevWordStart);
    }

    return new Cursor(this.measuredText, 0);
  }

  // ── Vim word navigation (A级复制 from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts) ──

  private graphemeAt(pos: number): string {
    if (pos >= this.text.length) return '';
    const nextOff = this.measuredText.nextOffset(pos);
    return this.text.slice(pos, nextOff);
  }

  private isOverWhitespace(): boolean {
    const currentChar = this.text[this.offset] ?? '';
    return /\s/.test(currentChar);
  }

  nextVimWord(): Cursor {
    if (this.isAtEnd()) return this;
    let pos = this.offset;
    const advance = (p: number): number => this.measuredText.nextOffset(p);
    const currentGrapheme = this.graphemeAt(pos);
    if (!currentGrapheme) return this;
    if (isVimWordChar(currentGrapheme)) {
      while (pos < this.text.length && isVimWordChar(this.graphemeAt(pos))) pos = advance(pos);
    } else if (isVimPunctuation(currentGrapheme)) {
      while (pos < this.text.length && isVimPunctuation(this.graphemeAt(pos))) pos = advance(pos);
    }
    while (pos < this.text.length && WHITESPACE_REGEX.test(this.graphemeAt(pos))) pos = advance(pos);
    return new Cursor(this.measuredText, pos);
  }

  endOfVimWord(): Cursor {
    if (this.isAtEnd()) return this;
    const text = this.text;
    let pos = this.offset;
    const advance = (p: number): number => this.measuredText.nextOffset(p);
    if (this.graphemeAt(pos) === '') return this;
    pos = advance(pos);
    while (pos < text.length && WHITESPACE_REGEX.test(this.graphemeAt(pos))) pos = advance(pos);
    if (pos >= text.length) return new Cursor(this.measuredText, text.length);
    const charAtPos = this.graphemeAt(pos);
    if (isVimWordChar(charAtPos)) {
      while (pos < text.length) { const nextPos = advance(pos); if (nextPos >= text.length || !isVimWordChar(this.graphemeAt(nextPos))) break; pos = nextPos; }
    } else if (isVimPunctuation(charAtPos)) {
      while (pos < text.length) { const nextPos = advance(pos); if (nextPos >= text.length || !isVimPunctuation(this.graphemeAt(nextPos))) break; pos = nextPos; }
    }
    return new Cursor(this.measuredText, pos);
  }

  prevVimWord(): Cursor {
    if (this.isAtStart()) return this;
    let pos = this.offset;
    const retreat = (p: number): number => this.measuredText.prevOffset(p);
    pos = retreat(pos);
    while (pos > 0 && WHITESPACE_REGEX.test(this.graphemeAt(pos))) pos = retreat(pos);
    if (pos === 0 && WHITESPACE_REGEX.test(this.graphemeAt(0))) return new Cursor(this.measuredText, 0);
    const charAtPos = this.graphemeAt(pos);
    if (isVimWordChar(charAtPos)) {
      while (pos > 0) { const prevPos = retreat(pos); if (!isVimWordChar(this.graphemeAt(prevPos))) break; pos = prevPos; }
    } else if (isVimPunctuation(charAtPos)) {
      while (pos > 0) { const prevPos = retreat(pos); if (!isVimPunctuation(this.graphemeAt(prevPos))) break; pos = prevPos; }
    }
    return new Cursor(this.measuredText, pos);
  }

  nextWORD(): Cursor {
    let cursor: Cursor = this;
    while (!cursor.isOverWhitespace() && !cursor.isAtEnd()) cursor = cursor.right();
    while (cursor.isOverWhitespace() && !cursor.isAtEnd()) cursor = cursor.right();
    return cursor;
  }

  endOfWORD(): Cursor {
    if (this.isAtEnd()) return this;
    let cursor: Cursor = this;
    const atEndOfWORD = !cursor.isOverWhitespace() && (cursor.right().isOverWhitespace() || cursor.right().isAtEnd());
    if (atEndOfWORD) { cursor = cursor.right(); return cursor.endOfWORD(); }
    if (cursor.isOverWhitespace()) cursor = cursor.nextWORD();
    while (!cursor.right().isOverWhitespace() && !cursor.isAtEnd()) cursor = cursor.right();
    return cursor;
  }

  prevWORD(): Cursor {
    let cursor: Cursor = this;
    if (cursor.left().isOverWhitespace()) cursor = cursor.left();
    while (cursor.isOverWhitespace() && !cursor.isAtStart()) cursor = cursor.left();
    if (!cursor.isOverWhitespace()) {
      while (!cursor.left().isOverWhitespace() && !cursor.isAtStart()) cursor = cursor.left();
    }
    return cursor;
  }

  // ── Text mutation ──

  modifyText(end: Cursor, insertString: string = ''): Cursor {
    const startOffset = this.offset;
    const endOffset = end.offset;

    const newText =
      this.text.slice(0, startOffset) +
      insertString +
      this.text.slice(endOffset);

    return Cursor.fromText(
      newText,
      this.columns,
      startOffset + insertString.normalize('NFC').length,
    );
  }

  insert(insertString: string): Cursor {
    const newCursor = this.modifyText(this, insertString);
    return newCursor;
  }

  del(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }
    return this.modifyText(this.right());
  }

  backspace(): Cursor {
    if (this.isAtStart()) {
      return this;
    }
    return this.left().modifyText(this);
  }

  // ── Helper stubs for CC API compatibility (TriRLC has no image refs) ──
  private imageRefStartingAt(_offset: number): { start: number; end: number } | null {
    return null;
  }

  private snapOutOfImageRef(offset: number, _toward: 'start' | 'end'): number {
    return offset;
  }

  // ── Deletion series (A级复制 from CC Cursor.ts) ──

  /**
   * Deletes a token before the cursor if one exists.
   * Supports pasted text refs: [Pasted text #1], [Pasted text #1 +10 lines],
   * [...Truncated text #1 +10 lines...]
   *
   * Returns null if no token found at cursor position.
   * Only triggers when cursor is at end of token (followed by whitespace or EOL).
   */
  deleteTokenBefore(): Cursor | null {
    // Cursor at chip.start is the "selected" state — backspace deletes the
    // chip forward, not the char before it.
    const chipAfter = this.imageRefStartingAt(this.offset);
    if (chipAfter) {
      const end =
        this.text[chipAfter.end] === ' ' ? chipAfter.end + 1 : chipAfter.end;
      return this.modifyText(new Cursor(this.measuredText, end));
    }

    if (this.isAtStart()) {
      return null;
    }

    // Only trigger if cursor is at a word boundary (whitespace or end of string after cursor)
    const charAfter = this.text[this.offset];
    if (charAfter !== undefined && !/\s/.test(charAfter)) {
      return null;
    }

    const textBefore = this.text.slice(0, this.offset);

    // Check for pasted/truncated text refs
    const pasteMatch = textBefore.match(
      /(^|\s)\[(Pasted text #\d+(?: \+\d+ lines)?|Image #\d+|\.\.\.Truncated text #\d+ \+\d+ lines\.\.\.)\]$/,
    );
    if (pasteMatch) {
      const matchStart = pasteMatch.index! + pasteMatch[1]!.length;
      return new Cursor(this.measuredText, matchStart).modifyText(this);
    }

    return null;
  }

  /** Delete from cursor to end of line. Returns new cursor and killed text. */
  deleteToLineEnd(): { cursor: Cursor; killed: string } {
    // If cursor is on a newline character, delete just that character
    if (this.text[this.offset] === '\n') {
      const killed = '\n';
      pushToKillRing(killed);
      return { cursor: this.modifyText(this.right()), killed };
    }

    const endCursor = this.endOfLine();
    const killed = this.text.slice(this.offset, endCursor.offset);
    if (killed) pushToKillRing(killed);
    return { cursor: this.modifyText(endCursor), killed };
  }

  /** Delete from cursor to start of line. Returns new cursor and killed text. */
  deleteToLineStart(): { cursor: Cursor; killed: string } {
    // If cursor is right after a newline (at start of line), delete just that
    // newline — symmetric with deleteToLineEnd's newline handling.
    if (this.offset > 0 && this.text[this.offset - 1] === '\n') {
      const killed = '\n';
      pushToKillRing(killed);
      return { cursor: this.left().modifyText(this), killed };
    }

    const startCursor = this.startOfLine();
    const killed = this.text.slice(startCursor.offset, this.offset);
    if (killed) pushToKillRing(killed);
    return { cursor: startCursor.modifyText(this), killed };
  }

  /** Delete the word before cursor. Returns new cursor and killed text. */
  deleteWordBefore(): { cursor: Cursor; killed: string } {
    if (this.isAtStart()) {
      return { cursor: this, killed: '' };
    }
    const target = this.snapOutOfImageRef(this.prevWord().offset, 'start');
    const prevWordCursor = new Cursor(this.measuredText, target);
    const killed = this.text.slice(prevWordCursor.offset, this.offset);
    if (killed) pushToKillRing(killed);
    return { cursor: prevWordCursor.modifyText(this), killed };
  }

  /** Delete the word after cursor. Returns new cursor. */
  deleteWordAfter(): Cursor {
    if (this.isAtEnd()) {
      return this;
    }

    const target = this.snapOutOfImageRef(this.nextWord().offset, 'end');
    return this.modifyText(new Cursor(this.measuredText, target));
  }

  // ── Vim line/file navigation (A级复制 from CC 2.1.88 vendor/cc-tui/utils/Cursor.ts) ──

  up(): Cursor {
    const { line, column } = this.getPosition();
    if (line === 0) return this;

    const prevLine = this.measuredText.getWrappedText()[line - 1];
    if (prevLine === undefined) return this;

    const prevLineDisplayWidth = stringWidth(prevLine);
    if (column > prevLineDisplayWidth) {
      const newOffset = this.getOffset({ line: line - 1, column: prevLineDisplayWidth });
      return new Cursor(this.measuredText, newOffset, 0);
    }

    const newOffset = this.getOffset({ line: line - 1, column });
    return new Cursor(this.measuredText, newOffset, 0);
  }

  down(): Cursor {
    const { line, column } = this.getPosition();
    if (line >= this.measuredText.lineCount - 1) return this;

    const nextLine = this.measuredText.getWrappedText()[line + 1];
    if (nextLine === undefined) return this;

    const nextLineDisplayWidth = stringWidth(nextLine);
    if (column > nextLineDisplayWidth) {
      const newOffset = this.getOffset({ line: line + 1, column: nextLineDisplayWidth });
      return new Cursor(this.measuredText, newOffset, 0);
    }

    const newOffset = this.getOffset({ line: line + 1, column });
    return new Cursor(this.measuredText, newOffset, 0);
  }

  goToLine(lineNumber: number): Cursor {
    const lines = this.text.split('\n');
    const targetLine = Math.min(Math.max(0, lineNumber - 1), lines.length - 1);
    let offset = 0;
    for (let i = 0; i < targetLine; i++) {
      offset += (lines[i]?.length ?? 0) + 1;
    }
    return new Cursor(this.measuredText, offset, 0);
  }

  startOfFirstLine(): Cursor {
    return new Cursor(this.measuredText, 0, 0);
  }

  endOfFile(): Cursor {
    return new Cursor(this.measuredText, this.text.length, 0);
  }

  startOfLastLine(): Cursor {
    const lastNewlineIndex = this.text.lastIndexOf('\n');
    if (lastNewlineIndex === -1) {
      return this.startOfLine();
    }
    return new Cursor(this.measuredText, lastNewlineIndex + 1, 0);
  }

  // ── Logical line navigation (A级复制 from CC Cursor.ts) ──
  // These use literal \n as line separators, independent of display wrapping.

  private findLogicalLineStart(fromOffset: number = this.offset): number {
    const prevNewline = this.text.lastIndexOf('\n', fromOffset - 1);
    return prevNewline === -1 ? 0 : prevNewline + 1;
  }

  private findLogicalLineEnd(fromOffset: number = this.offset): number {
    const nextNewline = this.text.indexOf('\n', fromOffset);
    return nextNewline === -1 ? this.text.length : nextNewline;
  }

  private getLogicalLineBounds(): { start: number; end: number } {
    return {
      start: this.findLogicalLineStart(),
      end: this.findLogicalLineEnd(),
    };
  }

  private createCursorWithColumn(lineStart: number, lineEnd: number, targetColumn: number): Cursor {
    const lineLength = lineEnd - lineStart;
    const clampedColumn = Math.min(targetColumn, lineLength);
    const rawOffset = lineStart + clampedColumn;
    const offset = this.measuredText.snapToGraphemeBoundary(rawOffset);
    return new Cursor(this.measuredText, offset, 0);
  }

  endOfLogicalLine(): Cursor {
    return new Cursor(this.measuredText, this.findLogicalLineEnd(), 0);
  }

  startOfLogicalLine(): Cursor {
    return new Cursor(this.measuredText, this.findLogicalLineStart(), 0);
  }

  firstNonBlankInLogicalLine(): Cursor {
    const { start, end } = this.getLogicalLineBounds();
    const lineText = this.text.slice(start, end);
    const match = lineText.match(/\S/);
    const offset = start + (match?.index ?? 0);
    return new Cursor(this.measuredText, offset, 0);
  }

  upLogicalLine(): Cursor {
    const { start: currentStart } = this.getLogicalLineBounds();
    if (currentStart === 0) {
      return new Cursor(this.measuredText, 0, 0);
    }
    const currentColumn = this.offset - currentStart;
    const prevLineEnd = currentStart - 1;
    const prevLineStart = this.findLogicalLineStart(prevLineEnd);
    return this.createCursorWithColumn(prevLineStart, prevLineEnd, currentColumn);
  }

  downLogicalLine(): Cursor {
    const { start: currentStart, end: currentEnd } = this.getLogicalLineBounds();
    if (currentEnd >= this.text.length) {
      return new Cursor(this.measuredText, this.text.length, 0);
    }
    const currentColumn = this.offset - currentStart;
    const nextLineStart = currentEnd + 1;
    const nextLineEnd = this.findLogicalLineEnd(nextLineStart);
    return this.createCursorWithColumn(nextLineStart, nextLineEnd, currentColumn);
  }

  // ── Equality / boundary checks ──

  equals(other: Cursor): boolean {
    return (
      this.offset === other.offset && this.measuredText === other.measuredText
    );
  }

  isAtStart(): boolean {
    return this.offset === 0;
  }

  isAtEnd(): boolean {
    return this.offset >= this.text.length;
  }

  /** Snapshot of cursor position in visual (wrapped) line/column. */
  cursorPosition(): { line: number; column: number } {
    return this.getPosition();
  }
}
