import { describe, expect, it } from 'vitest';

import type { EditorSnapshot } from '../../src/context/editorAdapter';
import { NavigationService, isValidLine } from '../../src/navigation/navigationService';
import type { FileResolution } from '../../src/navigation/fileService';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';

function snapshot(lineCount = 3): EditorSnapshot {
  return {
    workspaceName: 'navigation-test',
    rootCount: 1,
    file: {
      fsPath: 'C:/workspace/src/current.ts',
      relativePath: 'src/current.ts',
      languageId: 'typescript',
      lineCount,
    },
    cursor: { line: 2, column: 7 },
    selection: null,
    getLines: () => [],
  };
}

const found: FileResolution = {
  status: 'found',
  fsPath: 'C:/workspace/src/auth.ts',
  relativePath: 'src/auth.ts',
};
const notFound: FileResolution = { status: 'not_found' };
const ambiguous: FileResolution = {
  status: 'ambiguous',
  matches: ['src/auth.ts', 'test/auth.ts'],
  totalCount: 2,
};

describe('NavigationService', () => {
  it('opens an exact found file using its trusted fsPath', async () => {
    const adapter = new FakeEditorAdapter();
    const result = await new NavigationService(adapter).openFile(found);

    expect(result).toEqual({ status: 'ok', relativePath: 'src/auth.ts' });
    expect(adapter.opened).toEqual(['C:/workspace/src/auth.ts']);
  });

  it('does not open a not-found or ambiguous file resolution', async () => {
    const adapter = new FakeEditorAdapter();
    const service = new NavigationService(adapter);

    expect(await service.openFile(notFound)).toEqual({ status: 'not_found' });
    expect(await service.openFile(ambiguous)).toEqual(ambiguous);
    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('reveals an exact fsPath at the supplied 1-indexed position', async () => {
    const adapter = new FakeEditorAdapter();
    const result = await new NavigationService(adapter).reveal(
      'C:/workspace/src/auth.ts',
      { line: 4, column: 1 },
    );

    expect(result).toEqual({ status: 'ok' });
    expect(adapter.revealed).toEqual([{
      fsPath: 'C:/workspace/src/auth.ts',
      position: { line: 4, column: 1 },
    }]);
  });

  it('focuses through the adapter seam', async () => {
    const adapter = new FakeEditorAdapter();
    expect(await new NavigationService(adapter).focusEditor()).toEqual({ status: 'ok' });
    expect(adapter.focusCount).toBe(1);
  });

  it('accepts the first and last active-file lines and moves to column 1', async () => {
    const adapter = new FakeEditorAdapter({ snapshot: snapshot(3) });
    const service = new NavigationService(adapter);

    expect(await service.goToLine(1)).toEqual({
      status: 'ok', relativePath: 'src/current.ts', line: 1,
    });
    expect(await service.goToLine(3)).toEqual({
      status: 'ok', relativePath: 'src/current.ts', line: 3,
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/workspace/src/current.ts', position: { line: 1, column: 1 } },
      { fsPath: 'C:/workspace/src/current.ts', position: { line: 3, column: 1 } },
    ]);
  });

  it('validates line bounds and integer-ness before any side effect', async () => {
    const adapter = new FakeEditorAdapter({ snapshot: snapshot(3) });
    const service = new NavigationService(adapter);
    const invalidLines = [0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY];

    for (const line of invalidLines) {
      expect(await service.goToLine(line)).toEqual({
        status: 'failed', message: 'The requested location could not be found',
      });
    }

    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('returns the deterministic failure with no active editor', async () => {
    const adapter = new FakeEditorAdapter({ snapshot: null });
    const result = await new NavigationService(adapter).goToLine(1);

    expect(result).toEqual({
      status: 'failed', message: 'The requested location could not be found',
    });
    expect(adapter.opened).toEqual([]);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.focusCount).toBe(0);
  });

  it('leaves previously tracked navigation state unchanged after failure', async () => {
    const adapter = new FakeEditorAdapter({ snapshot: snapshot(3) });
    await adapter.openFile('C:/workspace/src/previous.ts');
    await adapter.reveal('C:/workspace/src/previous.ts', { line: 2, column: 1 });
    await adapter.focusEditor();
    const openedBefore = [...adapter.opened];
    const revealedBefore = [...adapter.revealed];
    const focusBefore = adapter.focusCount;

    expect(await new NavigationService(adapter).goToLine(4)).toEqual({
      status: 'failed', message: 'The requested location could not be found',
    });
    expect(adapter.opened).toEqual(openedBefore);
    expect(adapter.revealed).toEqual(revealedBefore);
    expect(adapter.focusCount).toBe(focusBefore);
  });

  it('provides a pure line-validity helper', () => {
    expect(isValidLine(1, 1)).toBe(true);
    expect(isValidLine(3, 3)).toBe(true);
    expect(isValidLine(0, 3)).toBe(false);
    expect(isValidLine(4, 3)).toBe(false);
    expect(isValidLine(1.5, 3)).toBe(false);
    expect(isValidLine(Number.NaN, 3)).toBe(false);
    expect(isValidLine(Number.POSITIVE_INFINITY, 3)).toBe(false);
  });
});
