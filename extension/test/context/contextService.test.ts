import { describe, expect, it } from 'vitest';

import { ContextService, toWireContext } from '../../src/context/contextService';
import { formatWhereAmI, formatSelection } from '../../src/context/contextFormatter';
import { MAX_EXCERPT_CHARS, MAX_EXCERPT_LINES } from '../../src/context/contextWindow';
import type { EditorSnapshot, SymbolNode } from '../../src/context/editorAdapter';
import { SymbolService } from '../../src/context/symbolService';
import { FakeEditorAdapter } from './fakeEditorAdapter';
import type { ResponseSink } from '../../src/response/responseSink';

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
    workspaceName: 'context-test',
    rootCount: 1,
    file: {
      fsPath: 'C:/Users/test/project/src/example.ts',
      relativePath: 'src/example.ts',
      languageId: 'typescript',
      lineCount,
    },
    cursor: { line: cursorLine, column: 3 },
    selection,
    getLines(startLine, endLine) {
      return lines.slice(startLine - 1, endLine);
    },
  };
}

function node(name: string, startLine: number, endLine: number): SymbolNode {
  return {
    name,
    kind: 'Function',
    range: {
      start: { line: startLine, column: 1 },
      end: { line: endLine, column: 1 },
    },
    children: [],
  };
}

class RecordingResponseSink implements ResponseSink {
  public readonly responses: string[] = [];

  public send(text: string): void {
    this.responses.push(text);
  }
}

function createContextService(adapter: FakeEditorAdapter): ContextService {
  return new ContextService(adapter, new SymbolService(adapter));
}

describe('ContextService examples', () => {
  it('returns a safe no-editor context and formatter message', async () => {
    const context = await createContextService(new FakeEditorAdapter()).getContext();

    expect(context.symbolStatus).toBe('no_editor');
    expect(context.activeFile).toBeNull();
    expect(context.nearbyCode).toBeNull();
    expect(formatWhereAmI(context)).toBe('No file is open.');
  });

  it('preserves a non-empty selection and formats it', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: makeSnapshot(20, 4, 8, {
        start: { line: 3, column: 2 },
        end: { line: 5, column: 4 },
      }),
      symbolResult: { status: 'found', nodes: [node('outer', 1, 20)] },
    });
    const context = await createContextService(adapter).getContext();

    expect(context.selection).toEqual({
      isEmpty: false,
      start: { line: 3, column: 2 },
      end: { line: 5, column: 4 },
    });
    expect(context.nearbyCode?.source).toBe('selection');
    expect(formatWhereAmI(context)).toContain('Selection from line 3, column 2 to line 5, column 4.');
    expect(context.nearbyCode!.endLine - context.nearbyCode!.startLine + 1).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
    expect(context.nearbyCode!.text.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
  });

  it('represents an empty selection and falls through to the symbol excerpt', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: makeSnapshot(20, 4, 8),
      symbolResult: { status: 'found', nodes: [node('outer', 1, 20)] },
    });
    const context = await createContextService(adapter).getContext();

    expect(context.selection).toEqual({ isEmpty: true });
    expect(context.nearbyCode?.source).toBe('symbol');
    expect(formatWhereAmI(context)).toContain('Nothing is selected.');
    expect(formatSelection(context)).toBe('Nothing is selected.');
  });

  it('falls back to the cursor window when the cursor is outside every symbol', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: makeSnapshot(20, 4, 10),
      symbolResult: { status: 'found', nodes: [node('other', 1, 3)] },
    });
    const context = await createContextService(adapter).getContext();

    expect(context.symbolStatus).toBe('none_enclosing');
    expect(context.currentSymbol).toBeNull();
    expect(context.nearbyCode?.source).toBe('cursor_window');
    expect(formatWhereAmI(context)).toContain('No enclosing symbol found.');
  });

  it('preserves provider_unavailable and uses cursor-window context', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: makeSnapshot(20, 4, 10),
      symbolResult: { status: 'provider_unavailable' },
    });
    const context = await createContextService(adapter).getContext();

    expect(context.symbolStatus).toBe('provider_unavailable');
    expect(context.currentSymbol).toBeNull();
    expect(context.nearbyCode?.source).toBe('cursor_window');
    expect(formatWhereAmI(context)).toContain('symbol information is unavailable');
    expect(formatWhereAmI(context)).not.toContain('other');
  });

  it('keeps large nearby code bounded and retains the cursor anchor', async () => {
    const adapter = new FakeEditorAdapter({
      snapshot: makeSnapshot(140, 100, 100),
      symbolResult: { status: 'found', nodes: [node('largeFunction', 1, 140)] },
    });
    const context = await createContextService(adapter).getContext();

    expect(context.nearbyCode).not.toBeNull();
    expect(context.nearbyCode!.endLine - context.nearbyCode!.startLine + 1).toBeLessThanOrEqual(MAX_EXCERPT_LINES);
    expect(context.nearbyCode!.text.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(context.nearbyCode!.truncated).toBe(true);
    expect(context.nearbyCode!.startLine).toBeLessThanOrEqual(100);
    expect(context.nearbyCode!.endLine).toBeGreaterThanOrEqual(100);
    expect(context.nearbyCode!.text).toContain('line-100');
  });

  it('sends already-formatted context text to a recording sink', async () => {
    const adapter = new FakeEditorAdapter({ snapshot: makeSnapshot(5, 2, 2) });
    const context = await createContextService(adapter).getContext();
    const response = formatWhereAmI(context);
    const sink = new RecordingResponseSink();

    sink.send(response);

    expect(sink.responses).toEqual([response]);
  });

  it('removes only filesystem metadata from wire context', async () => {
    const adapter = new FakeEditorAdapter({ snapshot: makeSnapshot(5, 2, 2) });
    const context = await createContextService(adapter).getContext();
    const wire = toWireContext(context);

    expect(wire).not.toHaveProperty('activeFile');
    expect(wire.relativePath).toBe('src/example.ts');
    expect(context.activeFile).toBe('C:/Users/test/project/src/example.ts');
  });
});
