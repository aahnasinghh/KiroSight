import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  findEnclosingSymbol,
} from '../../src/context/symbolService';
import type { Pos, SymbolNode } from '../../src/context/editorAdapter';

function symbol(
  name: string,
  start: Pos,
  end: Pos,
  children: SymbolNode[] = [],
): SymbolNode {
  return {
    name,
    kind: 'Function',
    range: { start, end },
    children,
  };
}

const nestedRangeCase = fc.integer({ min: 5, max: 50 }).map((outerEndLine) => ({
  outer: symbol(
    'outer',
    { line: 1, column: 1 },
    { line: outerEndLine, column: 20 },
    [
      symbol(
        `inner-${outerEndLine}`,
        { line: 2, column: 1 },
        { line: outerEndLine - 1, column: 20 },
      ),
    ],
  ),
  cursor: { line: 3, column: 10 } satisfies Pos,
  expected: `inner-${outerEndLine}`,
}));

describe('findEnclosingSymbol', () => {
  it('returns the innermost containing symbol for valid nested ranges', () => {
    // Feature: kirosight-mvp, Property 14: Enclosing symbol lookup returns the innermost container
    fc.assert(
      fc.property(nestedRangeCase, ({ outer, cursor, expected }) => {
        const result = findEnclosingSymbol([outer], cursor);

        expect(result?.name).toBe(expected);
        expect(result?.kind).toBe('Function');
      }),
      { numRuns: 100 },
    );
  });

  it('returns the only symbol containing the cursor and recursively traverses children', () => {
    const child = symbol('nested', { line: 2, column: 1 }, { line: 4, column: 1 });
    const parent = symbol('parent', { line: 1, column: 1 }, { line: 5, column: 1 }, [child]);

    expect(findEnclosingSymbol([parent], { line: 3, column: 10 })?.name).toBe('nested');
    expect(findEnclosingSymbol([parent], { line: 4, column: 1 })?.name).toBe('parent');
  });

  it('treats starts as inclusive and ends as exclusive', () => {
    const node = symbol('bounded', { line: 2, column: 3 }, { line: 4, column: 5 });

    expect(findEnclosingSymbol([node], { line: 2, column: 3 })?.name).toBe('bounded');
    expect(findEnclosingSymbol([node], { line: 4, column: 5 })).toBeNull();
  });

  it('does not match siblings or positions outside all ranges', () => {
    const first = symbol('first', { line: 1, column: 1 }, { line: 3, column: 1 });
    const second = symbol('second', { line: 3, column: 1 }, { line: 5, column: 1 });

    expect(findEnclosingSymbol([first, second], { line: 3, column: 1 })?.name).toBe('second');
    expect(findEnclosingSymbol([first, second], { line: 6, column: 1 })).toBeNull();
  });
});
