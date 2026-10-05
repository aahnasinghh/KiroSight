import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CURSOR_WINDOW_RADIUS,
  DIAGNOSTIC_WINDOW_RADIUS,
  MAX_EXCERPT_CHARS,
  MAX_EXCERPT_LINES,
  selectExcerpt,
} from '../../src/context/contextWindow';
import type { EditorSnapshot, Pos } from '../../src/context/editorAdapter';

function makeSnapshot(
  lineCount: number,
  lineLength: number,
  cursorLine: number,
  selection: EditorSnapshot['selection'] = null,
): EditorSnapshot {
  const lines = Array.from(
    { length: lineCount },
    (_, index) => `line-${index + 1}-${'x'.repeat(lineLength)}`,
  );

  return {
    workspaceName: 'property-test',
    rootCount: 1,
    file: {
      fsPath: 'C:/property-test/fixture.ts',
      relativePath: 'fixture.ts',
      languageId: 'typescript',
      lineCount,
    },
    cursor: { line: cursorLine, column: 1 },
    selection,
    getLines(startLine, endLine) {
      return lines.slice(startLine - 1, endLine);
    },
  };
}

const snapshotArb = fc.integer({ min: 1, max: 120 }).chain((lineCount) =>
  fc.record({
    lineLength: fc.integer({ min: 0, max: 120 }),
    cursorLine: fc.integer({ min: 1, max: lineCount }),
  }).map(({ lineLength, cursorLine }) => ({
    snapshot: makeSnapshot(lineCount, lineLength, cursorLine),
    cursorLine,
  })),
);

const selectionCaseArb = fc.integer({ min: 2, max: 120 }).chain((lineCount) =>
  fc.integer({ min: 1, max: lineCount }).chain((startLine) =>
    fc.integer({ min: startLine, max: lineCount }).map((endLine) => ({
      snapshot: makeSnapshot(
        lineCount,
        4,
        startLine,
        {
          start: { line: startLine, column: 1 },
          end: { line: endLine, column: 2 },
        },
      ),
      startLine,
      endLine,
    })),
  ),
);

const boundsCaseArb = fc.integer({ min: 1, max: 120 }).chain((lineCount) =>
  fc.record({
    lineLength: fc.integer({ min: 0, max: 1000 }),
    cursorLine: fc.integer({ min: 1, max: lineCount }),
  }).map(({ lineLength, cursorLine }) => ({
    snapshot: makeSnapshot(lineCount, lineLength, cursorLine),
    cursorLine,
  })),
);

describe('selectExcerpt', () => {
  it('follows selection, symbol, then cursor-window precedence', () => {
    // Feature: kirosight-mvp, Property 13: Context excerpt is bounded and follows the precedence rule
    fc.assert(
      fc.property(selectionCaseArb, ({ snapshot, startLine }) => {
        const result = selectExcerpt(snapshot, {
          startLine: 1,
          endLine: snapshot.file!.lineCount,
        });

        expect(result?.source).toBe('selection');
        expect(result?.startLine).toBeLessThanOrEqual(startLine);
        expect(result?.endLine).toBeGreaterThanOrEqual(startLine);
        expect(result?.text).toContain(`line-${startLine}`);
      }),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(snapshotArb, ({ snapshot, cursorLine }) => {
        const symbolStart = Math.max(1, cursorLine - 1);
        const symbolEnd = Math.min(snapshot.file!.lineCount, cursorLine + 1);
        const result = selectExcerpt(snapshot, {
          startLine: symbolStart,
          endLine: symbolEnd,
        });

        expect(result?.source).toBe('symbol');
        expect(result?.text).toContain(`line-${symbolStart}`);
      }),
      { numRuns: 100 },
    );

    fc.assert(
      fc.property(snapshotArb, ({ snapshot, cursorLine }) => {
        const result = selectExcerpt(snapshot);

        expect(result?.source).toBe('cursor_window');
        expect(result?.startLine).toBeLessThanOrEqual(cursorLine);
        expect(result?.endLine).toBeGreaterThanOrEqual(cursorLine);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps every excerpt within line and character bounds', () => {
    // Feature: kirosight-mvp, Property 13: Context excerpt is bounded and follows the precedence rule
    fc.assert(
      fc.property(boundsCaseArb, ({ snapshot, cursorLine }) => {
        const result = selectExcerpt(snapshot, {
          startLine: 1,
          endLine: snapshot.file!.lineCount,
        });

        expect(result).not.toBeNull();
        expect(result!.endLine - result!.startLine + 1).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
        expect(result!.text.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
        expect(result!.startLine).toBeGreaterThanOrEqual(1);
        expect(result!.endLine).toBeLessThanOrEqual(snapshot.file!.lineCount);
        expect(result!.startLine).toBeLessThanOrEqual(cursorLine);
        expect(result!.endLine).toBeGreaterThanOrEqual(cursorLine);

        const inputIsOversized =
          snapshot.file!.lineCount > MAX_EXCERPT_LINES ||
          snapshot.file!.lineCount * (snapshot.getLines(1, 1)[0].length + 1) > MAX_EXCERPT_CHARS;
        if (inputIsOversized) {
          expect(result!.truncated).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('preserves anchors when line or character limits force truncation', () => {
    const lineCount = MAX_EXCERPT_LINES + 20;
    const cursorLine = 100;
    const snapshot = makeSnapshot(lineCount, 100, cursorLine);
    const result = selectExcerpt(snapshot, { startLine: 1, endLine: lineCount });

    expect(result?.truncated).toBe(true);
    expect(result!.startLine).toBeLessThanOrEqual(cursorLine);
    expect(result!.endLine).toBeGreaterThanOrEqual(cursorLine);
    expect(result!.endLine - result!.startLine + 1).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
    expect(result!.text.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(result!.text).toContain(`line-${cursorLine}`);

    const longLineSnapshot = makeSnapshot(1, MAX_EXCERPT_CHARS + 100, 1);
    const longLineResult = selectExcerpt(longLineSnapshot);
    expect(longLineResult?.truncated).toBe(true);
    expect(longLineResult?.text.length).toBe(MAX_EXCERPT_CHARS);
    expect(longLineResult?.text).toContain('line-1');
  });

  it('covers empty selection, diagnostic anchors, document edges, and no editor', () => {
    const snapshot = makeSnapshot(30, 2, 1, null);
    const symbolResult = selectExcerpt(snapshot, { startLine: 5, endLine: 8 });
    expect(symbolResult?.source).toBe('symbol');

    const startResult = selectExcerpt(snapshot);
    expect(startResult?.source).toBe('cursor_window');
    expect(startResult?.startLine).toBe(1);

    const endSnapshot = makeSnapshot(30, 2, 30);
    const endResult = selectExcerpt(endSnapshot);
    expect(endResult?.endLine).toBe(30);

    const diagnosticResult = selectExcerpt(snapshot, null, 20);
    expect(diagnosticResult?.source).toBe('cursor_window');
    expect(diagnosticResult!.text.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(diagnosticResult!.endLine - diagnosticResult!.startLine + 1).toBeLessThanOrEqual(
      DIAGNOSTIC_WINDOW_RADIUS * 2 + 1,
    );

    expect(selectExcerpt(null)).toBeNull();
  });
});
