import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ActionExecutor } from '../../src/actions/actionExecutor';
import { formatWhereAmI } from '../../src/context/contextFormatter';
import { ContextService } from '../../src/context/contextService';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import { VscodeEditorAdapter } from '../../src/context/editorAdapter';
import { SymbolService } from '../../src/context/symbolService';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import {
  Position,
  Range,
  Selection,
  Uri,
  closeDocument,
  createMockEditor,
  diagnosticsMockState,
  editorMockState,
  resetEditorMock,
  resetVscodeMock,
  setActiveEditor,
  setMockWorkspace,
} from '../mocks/vscode';

const ROOT = '/ws/KiroSight';
const A = `${ROOT}/extension/src/extension.ts`;
const B = `${ROOT}/extension/src/other.ts`;
const LINES = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);

let adapter: VscodeEditorAdapter | undefined;

function create(): VscodeEditorAdapter {
  adapter = new VscodeEditorAdapter();
  return adapter;
}

beforeEach(() => {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace([ROOT], []);
});

afterEach(() => {
  adapter?.dispose();
  adapter = undefined;
});

describe('VscodeEditorAdapter remembered editor', () => {
  it('has no snapshot when no editor has ever been available', () => {
    expect(create().snapshot()).toBeNull();
  });

  it('initializes from the already active editor', () => {
    setActiveEditor(createMockEditor(A, LINES));

    expect(create().snapshot()?.file?.relativePath).toBe('extension/src/extension.ts');
  });

  it('keeps editor A when the webview takes focus (activeTextEditor undefined)', () => {
    const a = createMockEditor(A, LINES);
    const target = create();
    setActiveEditor(a);
    setActiveEditor(undefined);

    const snapshot = target.snapshot();
    expect(snapshot?.file?.fsPath).toBe(A);
    expect(snapshot?.file?.lineCount).toBe(60);
  });

  it('remembers editor B after A -> B -> webview', () => {
    const target = create();
    setActiveEditor(createMockEditor(A, LINES));
    setActiveEditor(createMockEditor(B, LINES));
    setActiveEditor(undefined);

    expect(target.snapshot()?.file?.fsPath).toBe(B);
  });

  it('reads live cursor state from the remembered editor, not a frozen copy', () => {
    const a = createMockEditor(A, LINES);
    const target = create();
    setActiveEditor(a);
    a.selection = new Selection(new Position(22, 4), new Position(22, 4));
    setActiveEditor(undefined);

    expect(target.snapshot()?.cursor).toEqual({ line: 23, column: 5 });
  });

  it('remembers the editor returned by openFile even without an activation event', async () => {
    editorMockState.activateOnShow = false;
    const target = create();

    await target.openFile(B);

    expect(editorMockState.active).toBeUndefined();
    expect(target.snapshot()?.file?.fsPath).toBe(B);
  });

  it('remembers the editor returned by reveal even without an activation event', async () => {
    editorMockState.activateOnShow = false;
    const target = create();

    await target.reveal(B, { line: 3, column: 1 });

    expect(editorMockState.active).toBeUndefined();
    expect(target.snapshot()?.file?.fsPath).toBe(B);
    expect(editorMockState.editorsByPath.get(B)?.selection.active.line).toBe(2);
  });

  it('forgets the remembered editor when its document is really closed', () => {
    const a = createMockEditor(A, LINES);
    const target = create();
    setActiveEditor(a);
    setActiveEditor(undefined);
    expect(target.snapshot()).not.toBeNull();

    closeDocument(a.document);

    expect(target.snapshot()).toBeNull();
  });

  it('keeps the remembered editor when a different document closes', () => {
    const a = createMockEditor(A, LINES);
    const other = createMockEditor(B, LINES);
    const target = create();
    setActiveEditor(a);
    setActiveEditor(undefined);

    closeDocument(other.document);

    expect(target.snapshot()?.file?.fsPath).toBe(A);
  });

  it('switches to another editor after a close when one becomes active', () => {
    const a = createMockEditor(A, LINES);
    const target = create();
    setActiveEditor(a);
    closeDocument(a.document);
    setActiveEditor(createMockEditor(B, LINES));
    setActiveEditor(undefined);

    expect(target.snapshot()?.file?.fsPath).toBe(B);
  });

  it('registers exactly one listener per event and removes them on dispose', () => {
    const target = create();
    expect(editorMockState.activeListeners).toHaveLength(1);
    expect(editorMockState.closeListeners).toHaveLength(1);

    target.dispose();
    target.dispose();

    expect(editorMockState.activeListeners).toHaveLength(0);
    expect(editorMockState.closeListeners).toHaveLength(0);
  });

  it('stops tracking after dispose', () => {
    const target = create();
    target.dispose();
    setActiveEditor(createMockEditor(A, LINES));
    setActiveEditor(undefined);

    expect(target.snapshot()).toBeNull();
  });
});

describe('panel commands while the webview has focus', () => {
  function services(target: VscodeEditorAdapter) {
    const diagnostics = new DiagnosticsService(target);
    const symbols = new SymbolService(target);
    return {
      context: new ContextService(target, symbols, diagnostics),
      executor: new ActionExecutor({
        adapter: target,
        diagnostics,
        files: new FileService(target),
        navigation: new NavigationService(target),
      }),
    };
  }

  it('where am I still describes editor A', async () => {
    const target = create();
    const a = createMockEditor(A, LINES);
    setActiveEditor(a);
    a.selection = new Selection(new Position(22, 0), new Position(22, 0));
    setActiveEditor(undefined);

    const text = formatWhereAmI(await services(target).context.getContext());

    expect(text).toContain('extension.ts');
    expect(text).not.toBe('No file is open.');
  });

  it('where am I still says no file is open when there never was an editor', async () => {
    const text = formatWhereAmI(await services(create()).context.getContext());

    expect(text).toBe('No file is open.');
  });

  it('GO_TO_LINE uses the remembered editor', async () => {
    const target = create();
    setActiveEditor(createMockEditor(A, LINES));
    setActiveEditor(undefined);

    const result = await services(target).executor.execute({ type: 'GO_TO_LINE', line: 40 });

    expect(result.status).toBe('ok');
    expect(editorMockState.shown).toEqual([A]);
    expect(editorMockState.editorsByPath.get(A)?.selection.active.line).toBe(39);
  });

  it('GO_TO_LINE fails cleanly with no editor ever available', async () => {
    const result = await services(create()).executor.execute({ type: 'GO_TO_LINE', line: 1 });

    expect(result.status).toBe('failed');
    expect(editorMockState.shown).toEqual([]);
  });

  describe('diagnostic stepping', () => {
    beforeEach(() => {
      const diagnostic = (line: number) => ({
        severity: 0,
        range: new Range(new Position(line - 1, 0), new Position(line - 1, 1)),
        message: `problem on ${line}`,
      });
      diagnosticsMockState.entries.push([new Uri(A), [diagnostic(10), diagnostic(30)]]);
    });

    it('NEXT_DIAGNOSTIC steps from the remembered cursor', async () => {
      const target = create();
      const a = createMockEditor(A, LINES);
      setActiveEditor(a);
      a.selection = new Selection(new Position(14, 0), new Position(14, 0));
      setActiveEditor(undefined);

      const result = await services(target).executor.execute({ type: 'NEXT_DIAGNOSTIC', severity: 'error' });

      expect(result.status).toBe('ok');
      expect(result.message).toContain('line 30');
    });

    it('PREVIOUS_DIAGNOSTIC steps from the remembered cursor', async () => {
      const target = create();
      const a = createMockEditor(A, LINES);
      setActiveEditor(a);
      a.selection = new Selection(new Position(14, 0), new Position(14, 0));
      setActiveEditor(undefined);

      const result = await services(target).executor.execute({ type: 'PREVIOUS_DIAGNOSTIC', severity: 'error' });

      expect(result.status).toBe('ok');
      expect(result.message).toContain('line 10');
    });

    it('NEXT_DIAGNOSTIC reports no file open when no editor was ever available', async () => {
      const result = await services(create()).executor.execute({ type: 'NEXT_DIAGNOSTIC', severity: 'error' });

      expect(result).toMatchObject({ status: 'failed', message: 'No file is open.' });
    });
  });
});
