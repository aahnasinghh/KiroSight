import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ActionExecutor } from '../../src/actions/actionExecutor';
import type { Action } from '../../src/actions/actionTypes';
import { ALLOWLIST } from '../../src/actions/allowlist';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import type { EditorSnapshot, RawDiagnostic } from '../../src/context/editorAdapter';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';

function raw(
  file: string,
  severity: RawDiagnostic['severity'],
  line: number,
  message: string,
): RawDiagnostic {
  return {
    fsPath: `C:/w/${file}`,
    relativePath: file,
    severity,
    range: { start: { line, column: 4 }, end: { line, column: 8 } },
    message,
  };
}

// Navigation order: a.ts:3 e1, a.ts:10 w1, b.ts:5 e2, b.ts:20 w2
const DIAGNOSTICS = [
  raw('a.ts', 'warning', 10, 'w1'),
  raw('a.ts', 'error', 3, 'e1'),
  raw('b.ts', 'error', 5, 'e2'),
  raw('b.ts', 'warning', 20, 'w2'),
];

function snapshotAt(relativePath: string, line: number, lineCount = 30): EditorSnapshot {
  return {
    workspaceName: 'executor-test',
    rootCount: 1,
    file: { fsPath: `C:/w/${relativePath}`, relativePath, languageId: 'typescript', lineCount },
    cursor: { line, column: 9 },
    selection: null,
    getLines: () => [],
  };
}

function setup(options: ConstructorParameters<typeof FakeEditorAdapter>[0] = {}) {
  const adapter = new FakeEditorAdapter(options);
  const executor = new ActionExecutor({
    adapter,
    diagnostics: new DiagnosticsService(adapter),
    files: new FileService(adapter),
    navigation: new NavigationService(adapter),
  });
  return { adapter, executor };
}

function expectNoNavigation(adapter: FakeEditorAdapter): void {
  expect(adapter.revealed).toEqual([]);
  expect(adapter.opened).toEqual([]);
  expect(adapter.focusCount).toBe(0);
}

describe('ActionExecutor', () => {
  it('has an explicit handler for every allow-listed action', async () => {
    const samples: Record<Action['type'], Action> = {
      NO_ACTION: { type: 'NO_ACTION' },
      GO_TO_DIAGNOSTIC: { type: 'GO_TO_DIAGNOSTIC', index: 0 },
      NEXT_DIAGNOSTIC: { type: 'NEXT_DIAGNOSTIC' },
      PREVIOUS_DIAGNOSTIC: { type: 'PREVIOUS_DIAGNOSTIC' },
      OPEN_FILE: { type: 'OPEN_FILE', path: 'a.ts' },
      GO_TO_LINE: { type: 'GO_TO_LINE', line: 1 },
      FOCUS_EDITOR: { type: 'FOCUS_EDITOR' },
      RUN_TESTS: { type: 'RUN_TESTS' },
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(ALLOWLIST).sort());

    for (const [type, action] of Object.entries(samples)) {
      const { executor } = setup({ diagnostics: DIAGNOSTICS, snapshot: snapshotAt('a.ts', 3) });
      expect((await executor.execute(action)).actionType).toBe(type);
    }
  });

  it('NO_ACTION has no side effects', async () => {
    const { adapter, executor } = setup({ diagnostics: DIAGNOSTICS, snapshot: snapshotAt('a.ts', 3) });
    const result = await executor.execute({ type: 'NO_ACTION' });

    expect(result).toMatchObject({ actionType: 'NO_ACTION', status: 'ok' });
    expectNoNavigation(adapter);
  });

  it('GO_TO_DIAGNOSTIC reveals the exact diagnostic at column 1', async () => {
    const { adapter, executor } = setup({ diagnostics: DIAGNOSTICS });
    const result = await executor.execute({ type: 'GO_TO_DIAGNOSTIC', index: 0 });

    expect(result).toMatchObject({
      actionType: 'GO_TO_DIAGNOSTIC',
      status: 'ok',
      details: {
        kind: 'diagnostic_reached',
        relativePath: 'a.ts',
        line: 3,
        severity: 'error',
        message: 'e1',
      },
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/a.ts', position: { line: 3, column: 1 } },
    ]);
    expect(JSON.stringify(result)).not.toContain('C:/w');
  });

  it('GO_TO_DIAGNOSTIC applies the severity filter before the index', async () => {
    const { adapter, executor } = setup({ diagnostics: DIAGNOSTICS });
    await executor.execute({ type: 'GO_TO_DIAGNOSTIC', index: 1, severity: 'error' });

    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/b.ts', position: { line: 5, column: 1 } },
    ]);
  });

  it('GO_TO_DIAGNOSTIC out of range fails without reveal', async () => {
    const { adapter, executor } = setup({ diagnostics: DIAGNOSTICS });
    const result = await executor.execute({ type: 'GO_TO_DIAGNOSTIC', index: 9 });

    expect(result).toEqual({
      actionType: 'GO_TO_DIAGNOSTIC',
      status: 'failed',
      message: 'No matching diagnostic was found',
    });
    expectNoNavigation(adapter);
  });

  it('NEXT_DIAGNOSTIC selects the first diagnostic strictly after the cursor', async () => {
    const { adapter, executor } = setup({
      diagnostics: DIAGNOSTICS,
      snapshot: snapshotAt('a.ts', 3),
    });
    const result = await executor.execute({ type: 'NEXT_DIAGNOSTIC' });

    expect(result).toMatchObject({
      status: 'ok',
      details: { kind: 'diagnostic_reached', relativePath: 'a.ts', line: 10, wrapped: false },
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/a.ts', position: { line: 10, column: 1 } },
    ]);
  });

  it('NEXT_DIAGNOSTIC reports wrapping', async () => {
    const { adapter, executor } = setup({
      diagnostics: DIAGNOSTICS,
      snapshot: snapshotAt('b.ts', 20),
    });
    const result = await executor.execute({ type: 'NEXT_DIAGNOSTIC' });

    expect(result).toMatchObject({
      status: 'ok',
      details: { relativePath: 'a.ts', line: 3, wrapped: true },
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/a.ts', position: { line: 3, column: 1 } },
    ]);
  });

  it('PREVIOUS_DIAGNOSTIC selects the last diagnostic strictly before the cursor', async () => {
    const { adapter, executor } = setup({
      diagnostics: DIAGNOSTICS,
      snapshot: snapshotAt('a.ts', 10),
    });
    const result = await executor.execute({ type: 'PREVIOUS_DIAGNOSTIC' });

    expect(result).toMatchObject({
      status: 'ok',
      details: { relativePath: 'a.ts', line: 3, wrapped: false },
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/a.ts', position: { line: 3, column: 1 } },
    ]);
  });

  it('PREVIOUS_DIAGNOSTIC reports wrapping', async () => {
    const { adapter, executor } = setup({
      diagnostics: DIAGNOSTICS,
      snapshot: snapshotAt('a.ts', 3),
    });
    const result = await executor.execute({ type: 'PREVIOUS_DIAGNOSTIC' });

    expect(result).toMatchObject({
      status: 'ok',
      details: { relativePath: 'b.ts', line: 20, wrapped: true },
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/b.ts', position: { line: 20, column: 1 } },
    ]);
  });

  it('diagnostic navigation with no candidates fails safely', async () => {
    const { adapter, executor } = setup({ snapshot: snapshotAt('a.ts', 3) });

    for (const action of [
      { type: 'GO_TO_DIAGNOSTIC', index: 0 },
      { type: 'NEXT_DIAGNOSTIC' },
      { type: 'PREVIOUS_DIAGNOSTIC' },
    ] satisfies Action[]) {
      expect(await executor.execute(action)).toMatchObject({
        status: 'failed',
        message: 'No matching diagnostic was found',
      });
    }
    expectNoNavigation(adapter);
  });

  it('NEXT and PREVIOUS fail without an active editor', async () => {
    const { adapter, executor } = setup({ diagnostics: DIAGNOSTICS });

    expect(await executor.execute({ type: 'NEXT_DIAGNOSTIC' })).toMatchObject({
      status: 'failed',
      message: 'No file is open.',
    });
    expect(await executor.execute({ type: 'PREVIOUS_DIAGNOSTIC' })).toMatchObject({
      status: 'failed',
      message: 'No file is open.',
    });
    expectNoNavigation(adapter);
  });

  it('OPEN_FILE opens the exact unique match', async () => {
    const { adapter, executor } = setup({ files: ['src/auth.ts'] });
    const result = await executor.execute({ type: 'OPEN_FILE', path: 'auth.ts' });

    expect(result).toMatchObject({
      status: 'ok',
      details: { kind: 'file_opened', relativePath: 'src/auth.ts' },
    });
    expect(adapter.opened).toEqual(['C:/workspace/src/auth.ts']);
    expect(JSON.stringify(result)).not.toContain('C:/workspace');
  });

  it('OPEN_FILE does not open anything when not found', async () => {
    const { adapter, executor } = setup({ files: [] });
    const result = await executor.execute({ type: 'OPEN_FILE', path: 'missing.ts' });

    expect(result).toMatchObject({ status: 'failed', message: 'File not found' });
    expectNoNavigation(adapter);
  });

  it('OPEN_FILE asks for clarification on ambiguity and opens nothing', async () => {
    const { adapter, executor } = setup({ files: ['src/auth.ts', 'test/auth.ts'] });
    const result = await executor.execute({ type: 'OPEN_FILE', path: 'auth.ts' });

    expect(result).toMatchObject({
      status: 'needs_clarification',
      details: {
        kind: 'ambiguous_files',
        matches: ['src/auth.ts', 'test/auth.ts'],
        totalMatches: 2,
      },
    });
    expectNoNavigation(adapter);
  });

  it('GO_TO_LINE delegates and preserves success', async () => {
    const { adapter, executor } = setup({ snapshot: snapshotAt('a.ts', 3, 30) });
    const result = await executor.execute({ type: 'GO_TO_LINE', line: 12 });

    expect(result).toMatchObject({
      status: 'ok',
      details: { kind: 'location_reached', relativePath: 'a.ts', line: 12 },
    });
    expect(adapter.revealed).toEqual([
      { fsPath: 'C:/w/a.ts', position: { line: 12, column: 1 } },
    ]);
  });

  it('GO_TO_LINE preserves failure', async () => {
    const { adapter, executor } = setup({ snapshot: snapshotAt('a.ts', 3, 30) });
    const result = await executor.execute({ type: 'GO_TO_LINE', line: 31 });

    expect(result).toEqual({
      actionType: 'GO_TO_LINE',
      status: 'failed',
      message: 'The requested location could not be found',
    });
    expectNoNavigation(adapter);
  });

  it('FOCUS_EDITOR delegates exactly once', async () => {
    const { adapter, executor } = setup();
    const result = await executor.execute({ type: 'FOCUS_EDITOR' });

    expect(result).toMatchObject({ actionType: 'FOCUS_EDITOR', status: 'ok' });
    expect(adapter.focusCount).toBe(1);
    expect(adapter.revealed).toEqual([]);
    expect(adapter.opened).toEqual([]);
  });

  it('RUN_TESTS is a failed placeholder with no side effects', async () => {
    const { adapter, executor } = setup({ diagnostics: DIAGNOSTICS, snapshot: snapshotAt('a.ts', 3) });
    const result = await executor.execute({ type: 'RUN_TESTS' });

    expect(result).toEqual({
      actionType: 'RUN_TESTS',
      status: 'failed',
      message: 'test running is not available yet',
    });
    expectNoNavigation(adapter);
  });

  it('contains no vscode import or executeCommand path', () => {
    for (const file of ['actionExecutor.ts', 'actionResult.ts']) {
      const source = readFileSync(resolvePath(__dirname, '../../src/actions', file), 'utf8');
      expect(source).not.toMatch(/executeCommand/);
      expect(source).not.toMatch(/from 'vscode'/);
      expect(source).not.toMatch(/child_process/);
    }
  });
});
