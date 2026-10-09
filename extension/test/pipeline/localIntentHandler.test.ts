import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ActionExecutor } from '../../src/actions/actionExecutor';
import type { ActionResult } from '../../src/actions/actionResult';
import type { Action } from '../../src/actions/actionTypes';
import { ContextService } from '../../src/context/contextService';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import type { EditorSnapshot, RawDiagnostic } from '../../src/context/editorAdapter';
import { SymbolService } from '../../src/context/symbolService';
import type { LocalIntent } from '../../src/intent/intentTypes';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import {
  HELP_TEXT,
  LocalIntentHandler,
  REASONING_NOT_CONNECTED,
  TEST_SUMMARY_UNAVAILABLE,
  type ActionRunner,
} from '../../src/pipeline/localIntentHandler';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';

function raw(file: string, severity: RawDiagnostic['severity'], line: number, message: string): RawDiagnostic {
  return {
    fsPath: `C:/w/${file}`,
    relativePath: file,
    severity,
    range: { start: { line, column: 4 }, end: { line, column: 8 } },
    message,
  };
}

// Navigation order: a.ts:3 e1, a.ts:10 w1, b.ts:5 e2
const DIAGNOSTICS = [
  raw('a.ts', 'warning', 10, 'w1'),
  raw('a.ts', 'error', 3, 'e1'),
  raw('b.ts', 'error', 5, 'e2'),
];

function snapshotAt(relativePath: string, line: number, selected = false): EditorSnapshot {
  return {
    workspaceName: 'handler-test',
    rootCount: 1,
    file: { fsPath: `C:/w/${relativePath}`, relativePath, languageId: 'typescript', lineCount: 30 },
    cursor: { line, column: 9 },
    selection: selected ? { start: { line, column: 1 }, end: { line, column: 6 } } : null,
    getLines: () => ['const value = 1;'],
  };
}

function setup(options: ConstructorParameters<typeof FakeEditorAdapter>[0] = {}) {
  const adapter = new FakeEditorAdapter(options);
  const diagnostics = new DiagnosticsService(adapter);
  const symbols = new SymbolService(adapter);
  const actions = new ActionExecutor({
    adapter,
    diagnostics,
    files: new FileService(adapter),
    navigation: new NavigationService(adapter),
  });
  const handler = new LocalIntentHandler({
    context: new ContextService(adapter, symbols, diagnostics),
    diagnostics,
    symbols,
    actions,
  });
  return { adapter, handler };
}

const act = (action: Action): LocalIntent => ({ kind: 'ACTION', action });

describe('LocalIntentHandler', () => {
  it('formats where-am-I from ContextService', async () => {
    const { handler } = setup({ snapshot: snapshotAt('a.ts', 3) });
    const text = await handler.handleIntent({ kind: 'WHERE_AM_I' });
    expect(text).toContain("You're editing a.ts at line 3, column 9.");
  });

  it('preserves the no-editor message', async () => {
    const { handler } = setup();
    expect(await handler.handleIntent({ kind: 'WHERE_AM_I' })).toBe('No file is open.');
  });

  it('describes the current symbol context without navigating', async () => {
    const { adapter, handler } = setup({ snapshot: snapshotAt('a.ts', 3) });
    const text = await handler.handleIntent({ kind: 'CURRENT_SYMBOL' });
    expect(text).toContain('No enclosing symbol found');
    expect(adapter.revealed).toEqual([]);
  });

  it('reads the selection through existing formatting', async () => {
    const { handler } = setup({ snapshot: snapshotAt('a.ts', 3, true) });
    expect(await handler.handleIntent({ kind: 'READ_SELECTION' })).toContain('Selected text from line 3');
    const none = setup({ snapshot: snapshotAt('a.ts', 3) });
    expect(await none.handler.handleIntent({ kind: 'READ_SELECTION' })).toBe('Nothing is selected.');
  });

  it('reports workspace diagnostics', async () => {
    const { handler } = setup({ diagnostics: DIAGNOSTICS });
    const text = await handler.handleIntent({ kind: 'DESCRIBE_DIAGNOSTICS', scope: 'workspace' });
    expect(text).toContain('Diagnostics:');
    expect(text).toContain('Error in a.ts at line 3: e1');
    expect(text).toContain('Warning in a.ts at line 10: w1');
  });

  it('reports current-file diagnostics only', async () => {
    const { handler } = setup({ snapshot: snapshotAt('a.ts', 3), diagnostics: DIAGNOSTICS });
    const text = await handler.handleIntent({ kind: 'DESCRIBE_DIAGNOSTICS', scope: 'file' });
    expect(text).toContain('a.ts');
    expect(text).not.toContain('b.ts');
  });

  it('reports no file open and no diagnostics states', async () => {
    const noFile = setup({ diagnostics: DIAGNOSTICS });
    expect(await noFile.handler.handleIntent({ kind: 'DESCRIBE_DIAGNOSTICS', scope: 'file' })).toBe('No file is open.');
    const empty = setup({ snapshot: snapshotAt('a.ts', 3) });
    expect(await empty.handler.handleIntent({ kind: 'DESCRIBE_DIAGNOSTICS', scope: 'workspace' })).toBe('No diagnostics found.');
  });

  it('validates an action before executing it and formats the result', async () => {
    const calls: Action[] = [];
    const result: ActionResult = {
      actionType: 'FOCUS_EDITOR', status: 'ok', message: 'ignored',
    };
    const runner: ActionRunner = { execute: async (action) => { calls.push(action); return result; } };
    const adapter = new FakeEditorAdapter();
    const diagnostics = new DiagnosticsService(adapter);
    const symbols = new SymbolService(adapter);
    const handler = new LocalIntentHandler({
      context: new ContextService(adapter, symbols, diagnostics), diagnostics, symbols, actions: runner,
    });

    expect(await handler.handleIntent(act({ type: 'FOCUS_EDITOR' }))).toBe('ignored');
    expect(calls).toEqual([{ type: 'FOCUS_EDITOR' }]);
  });

  it('never executes an invalid action', async () => {
    const calls: Action[] = [];
    const runner: ActionRunner = {
      execute: async (action) => { calls.push(action); return { actionType: action.type, status: 'ok', message: 'x' }; },
    };
    const adapter = new FakeEditorAdapter();
    const diagnostics = new DiagnosticsService(adapter);
    const symbols = new SymbolService(adapter);
    const handler = new LocalIntentHandler({
      context: new ContextService(adapter, symbols, diagnostics), diagnostics, symbols, actions: runner,
    });

    const text = await handler.handleIntent(act({ type: 'GO_TO_LINE', line: 0 }));
    expect(text).toBe('Action rejected: Action parameters are invalid.');
    expect(calls).toEqual([]);
  });

  it('runs diagnostic navigation actions through the executor', async () => {
    const first = setup({ diagnostics: DIAGNOSTICS });
    expect(await first.handler.handleIntent(act({ type: 'GO_TO_DIAGNOSTIC', index: 0, severity: 'error' })))
      .toContain('a.ts, line 3');
    expect(first.adapter.revealed).toEqual([{ fsPath: 'C:/w/a.ts', position: { line: 3, column: 1 } }]);

    const next = setup({ diagnostics: DIAGNOSTICS, snapshot: snapshotAt('a.ts', 3) });
    expect(await next.handler.handleIntent(act({ type: 'NEXT_DIAGNOSTIC', severity: 'error' })))
      .toContain('b.ts, line 5');

    const previous = setup({ diagnostics: DIAGNOSTICS, snapshot: snapshotAt('b.ts', 5) });
    expect(await previous.handler.handleIntent(act({ type: 'PREVIOUS_DIAGNOSTIC', severity: 'error' })))
      .toContain('a.ts, line 3');
  });

  it('runs open-file, go-to-line, and focus actions through the executor', async () => {
    const open = setup({ files: ['src/auth.ts'] });
    expect(await open.handler.handleIntent(act({ type: 'OPEN_FILE', path: 'auth.ts' }))).toBe('Opened src/auth.ts.');
    expect(open.adapter.opened).toEqual(['C:/workspace/src/auth.ts']);

    const line = setup({ snapshot: snapshotAt('a.ts', 3) });
    expect(await line.handler.handleIntent(act({ type: 'GO_TO_LINE', line: 12 }))).toBe('Moved to a.ts, line 12.');

    const focus = setup();
    expect(await focus.handler.handleIntent(act({ type: 'FOCUS_EDITOR' }))).toBe('Focused the editor.');
    expect(focus.adapter.focusCount).toBe(1);
  });

  it('returns the RUN_TESTS placeholder without side effects', async () => {
    const { adapter, handler } = setup({ snapshot: snapshotAt('a.ts', 3) });
    expect(await handler.handleIntent(act({ type: 'RUN_TESTS' }))).toBe('test running is not available yet');
    expect(adapter.revealed).toEqual([]);
    expect(adapter.opened).toEqual([]);
  });

  it('returns deterministic summary and help text', async () => {
    const { handler } = setup();
    expect(await handler.handleIntent({ kind: 'SUMMARIZE_LAST_TEST_RUN' })).toBe(TEST_SUMMARY_UNAVAILABLE);
    expect(await handler.handleIntent({ kind: 'HELP' })).toBe(HELP_TEXT);
    expect(HELP_TEXT).not.toMatch(/symbol|function foo/i);
  });

  it('routes agent results to the placeholder without executing anything', async () => {
    const calls: Action[] = [];
    const runner: ActionRunner = {
      execute: async (action) => { calls.push(action); return { actionType: action.type, status: 'ok', message: 'x' }; },
    };
    const adapter = new FakeEditorAdapter();
    const diagnostics = new DiagnosticsService(adapter);
    const symbols = new SymbolService(adapter);
    const handler = new LocalIntentHandler({
      context: new ContextService(adapter, symbols, diagnostics), diagnostics, symbols, actions: runner,
    });

    for (const reason of ['semantic', 'unrecognized', 'ambiguous'] as const) {
      expect(await handler.handle({ route: 'agent', reason })).toBe(REASONING_NOT_CONNECTED);
    }
    expect(calls).toEqual([]);
  });

  it('handles local route results and has no vscode or executeCommand dependency', async () => {
    const { handler } = setup();
    expect(await handler.handle({ route: 'local', intent: { kind: 'HELP' } })).toBe(HELP_TEXT);

    const source = readFileSync(resolvePath(__dirname, '../../src/pipeline/localIntentHandler.ts'), 'utf8');
    expect(source).not.toMatch(/from 'vscode'/);
    expect(source).not.toMatch(/executeCommand/);
  });
});
