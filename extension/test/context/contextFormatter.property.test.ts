import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatWhereAmI } from '../../src/context/contextFormatter';
import type { IDEContext, Pos } from '../../src/context/editorAdapter';

const relativePathArb = fc.constantFrom('src/login.ts', 'lib/parser.ts', 'test/example.ts');
const positionArb: fc.Arbitrary<Pos> = fc.record({
  line: fc.integer({ min: 1, max: 200 }),
  column: fc.integer({ min: 1, max: 120 }),
});
const symbolNameArb = fc.constantFrom('validateLogin', 'parseInput', 'exampleTest');
const symbolKindArb = fc.constantFrom('Function', 'Method', 'Class');

const symbolStateArb = fc.oneof(
  fc.record({
    status: fc.constant<'found'>('found'),
    name: symbolNameArb,
    kind: symbolKindArb,
  }).map(({ status, name, kind }) => ({
    symbolStatus: status,
    currentSymbol: { name, kind, startLine: 1, endLine: 200 },
  })),
  fc.constant({ symbolStatus: 'none_enclosing' as const, currentSymbol: null }),
  fc.constant({ symbolStatus: 'provider_unavailable' as const, currentSymbol: null }),
);

const activeContextArb: fc.Arbitrary<IDEContext> = fc.record({
  relativePath: relativePathArb,
  cursor: positionArb,
  selection: fc.oneof(
    fc.constant({ isEmpty: true as const }),
    fc.record({ start: positionArb, end: positionArb }).map(({ start, end }) => ({
      isEmpty: false as const,
      start,
      end,
    })),
  ),
  symbolState: symbolStateArb,
}).map(({ relativePath, cursor, selection, symbolState }) => ({
  workspace: { name: 'property-test', rootCount: 1 },
  activeFile: 'fixture.ts',
  relativePath,
  languageId: 'typescript',
  cursor,
  selection,
  nearbyCode: null,
  currentSymbol: symbolState.currentSymbol,
  symbolStatus: symbolState.symbolStatus,
  diagnostics: [],
  diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
}));

describe('formatWhereAmI', () => {
  it('reports every active-editor category with 1-indexed values', () => {
    // Feature: kirosight-mvp, Property 19: Editor context report is complete
    fc.assert(
      fc.property(activeContextArb, (context) => {
        const report = formatWhereAmI(context);

        expect(report).toContain(context.relativePath);
        expect(report).toContain(`line ${context.cursor!.line}`);
        expect(report).toContain(`column ${context.cursor!.column}`);

        if (context.selection!.isEmpty) {
          expect(report).toContain('Nothing is selected.');
        } else {
          expect(report).toContain(
            `Selection from line ${context.selection.start.line}, column ${context.selection.start.column} to line ${context.selection.end.line}, column ${context.selection.end.column}.`,
          );
        }

        if (context.symbolStatus === 'found') {
          expect(report).toContain(context.currentSymbol!.name);
        } else if (context.symbolStatus === 'none_enclosing') {
          expect(report).toContain('No enclosing symbol found.');
        } else {
          expect(report).toContain('symbol information is unavailable');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('returns the exact no-editor message', () => {
    const noEditorContext: IDEContext = {
      workspace: { name: null, rootCount: 0 },
      activeFile: null,
      relativePath: null,
      languageId: null,
      cursor: null,
      selection: null,
      nearbyCode: null,
      currentSymbol: null,
      symbolStatus: 'no_editor',
      diagnostics: [],
      diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
    };

    expect(formatWhereAmI(noEditorContext)).toBe('No file is open.');
  });
});
