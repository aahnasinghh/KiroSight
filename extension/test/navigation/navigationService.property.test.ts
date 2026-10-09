import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { EditorSnapshot } from '../../src/context/editorAdapter';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';
import { NavigationService, isValidLine } from '../../src/navigation/navigationService';

function snapshot(lineCount: number): EditorSnapshot {
  return {
    workspaceName: 'navigation-property-test',
    rootCount: 1,
    file: {
      fsPath: 'C:/workspace/src/generated.ts',
      relativePath: 'src/generated.ts',
      languageId: 'typescript',
      lineCount,
    },
    cursor: { line: 2, column: 17 },
    selection: null,
    getLines: () => [],
  };
}

const failure = {
  status: 'failed' as const,
  message: 'The requested location could not be found' as const,
};

describe('Property 18: go-to-line validity', () => {
  const lineCountArb = fc.integer({ min: 1, max: 50 });
  const activeSnapshotArb = lineCountArb.map((lineCount) => ({
    lineCount,
    editorSnapshot: snapshot(lineCount),
  }));

  it('matches the exact integer-inclusive line validity rule', () => {
    const lineArb = fc.oneof(
      fc.integer({ min: -100, max: 100 }),
      fc.double({ noNaN: true, noDefaultInfinity: true }),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
    );

    fc.assert(
      fc.property(lineCountArb, lineArb, (lineCount, line) => {
        expect(isValidLine(line, lineCount)).toBe(
          Number.isInteger(line) && line >= 1 && line <= lineCount,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('reveals every valid generated line at column 1 using the exact fsPath', async () => {
    await fc.assert(
      fc.asyncProperty(
        activeSnapshotArb.chain(({ lineCount, editorSnapshot }) =>
          fc.integer({ min: 1, max: lineCount }).map((line) => ({ line, editorSnapshot }))),
        async ({ line, editorSnapshot }) => {
          const adapter = new FakeEditorAdapter({ snapshot: editorSnapshot });
          const result = await new NavigationService(adapter).goToLine(line);

          expect(result).toEqual({
            status: 'ok', relativePath: 'src/generated.ts', line,
          });
          expect(adapter.revealed).toEqual([{
            fsPath: editorSnapshot.file!.fsPath,
            position: { line, column: 1 },
          }]);
          expect(adapter.opened).toEqual([]);
          expect(adapter.focusCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('accepts first and last lines for every positive line count', async () => {
    await fc.assert(
      fc.asyncProperty(lineCountArb, async (lineCount) => {
        const adapter = new FakeEditorAdapter({ snapshot: snapshot(lineCount) });
        const service = new NavigationService(adapter);

        expect((await service.goToLine(1)).status).toBe('ok');
        expect((await service.goToLine(lineCount)).status).toBe('ok');
        expect(adapter.revealed.map(({ position }) => position)).toEqual([
          { line: 1, column: 1 },
          { line: lineCount, column: 1 },
        ]);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects lower-bound violations without side effects', async () => {
    await fc.assert(
      fc.asyncProperty(
        activeSnapshotArb,
        fc.integer({ min: -100, max: 0 }),
        async ({ editorSnapshot }, line) => {
          const adapter = new FakeEditorAdapter({ snapshot: editorSnapshot });
          expect(await new NavigationService(adapter).goToLine(line)).toEqual(failure);
          expect(adapter.opened).toEqual([]);
          expect(adapter.revealed).toEqual([]);
          expect(adapter.focusCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects upper-bound violations without clamping', async () => {
    await fc.assert(
      fc.asyncProperty(
        activeSnapshotArb.chain(({ lineCount, editorSnapshot }) =>
          fc.integer({ min: lineCount + 1, max: lineCount + 100 }).map((line) => ({ line, editorSnapshot }))),
        async ({ line, editorSnapshot }) => {
          const adapter = new FakeEditorAdapter({ snapshot: editorSnapshot });
          expect(await new NavigationService(adapter).goToLine(line)).toEqual(failure);
          expect(adapter.opened).toEqual([]);
          expect(adapter.revealed).toEqual([]);
          expect(adapter.focusCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects finite fractional values without rounding', async () => {
    await fc.assert(
      fc.asyncProperty(
        activeSnapshotArb,
        fc.double({ min: 1.1, max: 50.9, noInteger: true, noNaN: true, noDefaultInfinity: true }),
        async ({ editorSnapshot }, line) => {
          const adapter = new FakeEditorAdapter({ snapshot: editorSnapshot });
          expect(await new NavigationService(adapter).goToLine(line)).toEqual(failure);
          expect(adapter.revealed).toEqual([]);
          expect(adapter.opened).toEqual([]);
          expect(adapter.focusCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects NaN and both infinities without navigation', async () => {
    await fc.assert(
      fc.asyncProperty(
        activeSnapshotArb,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        async ({ editorSnapshot }, line) => {
          const adapter = new FakeEditorAdapter({ snapshot: editorSnapshot });
          expect(await new NavigationService(adapter).goToLine(line)).toEqual(failure);
          expect(adapter.revealed).toEqual([]);
          expect(adapter.opened).toEqual([]);
          expect(adapter.focusCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects requests with no active editor', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.integer({ min: -20, max: 80 }), fc.constant(Number.NaN)),
        async (line) => {
          const adapter = new FakeEditorAdapter({ snapshot: null });
          expect(await new NavigationService(adapter).goToLine(line)).toEqual(failure);
          expect(adapter.opened).toEqual([]);
          expect(adapter.revealed).toEqual([]);
          expect(adapter.focusCount).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('preserves prior navigation state after invalid requests', async () => {
    await fc.assert(
      fc.asyncProperty(
        activeSnapshotArb,
        fc.integer({ min: -100, max: 0 }),
        async ({ editorSnapshot }, line) => {
          const adapter = new FakeEditorAdapter({ snapshot: editorSnapshot });
          await adapter.openFile('C:/workspace/src/previous.ts');
          await adapter.reveal('C:/workspace/src/previous.ts', { line: 2, column: 9 });
          await adapter.focusEditor();
          const before = {
            opened: [...adapter.opened],
            revealed: [...adapter.revealed],
            focusCount: adapter.focusCount,
          };

          expect(await new NavigationService(adapter).goToLine(line)).toEqual(failure);
          expect(adapter.opened).toEqual(before.opened);
          expect(adapter.revealed).toEqual(before.revealed);
          expect(adapter.focusCount).toBe(before.focusCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});
