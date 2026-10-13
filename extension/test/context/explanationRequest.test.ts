import { describe, expect, it } from 'vitest';

import { MAX_DIAGNOSTIC_MESSAGE_CHARS } from '../../src/context/contextWindow';
import { DiagnosticsService, type DiagnosticEntry } from '../../src/context/diagnosticsService';
import type { EditorSnapshot, RawDiagnostic, SymbolNode, SymbolQueryResult } from '../../src/context/editorAdapter';
import {
  ExplanationRequestBuilder,
  chooseFocusEntry,
  type ExplanationBuild,
  type ExplanationRequestInput,
} from '../../src/context/explanationRequest';
import { SymbolService } from '../../src/context/symbolService';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { FakeEditorAdapter } from './fakeEditorAdapter';

const FS_PATH = 'C:/private/work/src/auth.ts';
const OTHER_FS_PATH = 'C:/private/work/src/other.ts';
const LINES = Array.from({ length: 60 }, (_, index) => `code-line-${index + 1}`);

function snapshot(
  cursor: { line: number; column: number } | null,
  selection: EditorSnapshot['selection'] = null,
): EditorSnapshot {
  return {
    workspaceName: 'sample',
    rootCount: 1,
    file: { fsPath: FS_PATH, relativePath: 'src/auth.ts', languageId: 'typescript', lineCount: LINES.length },
    cursor,
    selection,
    getLines: (start, end) => LINES.slice(start - 1, end),
  };
}

function raw(
  line: number,
  message: string,
  options: Partial<Pick<RawDiagnostic, 'severity' | 'fsPath'>> & { endLine?: number; column?: number; endColumn?: number } = {},
): RawDiagnostic {
  return {
    fsPath: options.fsPath ?? FS_PATH,
    relativePath: options.fsPath === OTHER_FS_PATH ? 'src/other.ts' : 'src/auth.ts',
    severity: options.severity ?? 'error',
    range: {
      start: { line, column: options.column ?? 1 },
      end: { line: options.endLine ?? line, column: options.endColumn ?? 10 },
    },
    message,
  };
}

function fn(name: string, startLine: number, endLine: number): SymbolNode {
  return {
    name,
    kind: 'Function',
    range: { start: { line: startLine, column: 1 }, end: { line: endLine, column: 1 } },
    children: [],
  };
}

function builderFor(options: {
  snapshot: EditorSnapshot | null;
  diagnostics?: RawDiagnostic[];
  symbols?: SymbolQueryResult;
}): ExplanationRequestBuilder {
  const adapter = new FakeEditorAdapter({
    snapshot: options.snapshot,
    diagnostics: options.diagnostics ?? [],
    symbolResult: options.symbols ?? { status: 'found', nodes: [] },
  });
  return new ExplanationRequestBuilder(adapter, new SymbolService(adapter), new DiagnosticsService(adapter));
}

const input = (
  target: ExplanationRequestInput['target'],
  extra: Partial<ExplanationRequestInput> = {},
): ExplanationRequestInput => ({ target, id: 'req-7', utterance: `explain ${target}`, ...extra });

function ready(result: ExplanationBuild) {
  expect(result.status).toBe('ready');
  if (result.status !== 'ready') throw new Error('not ready');
  return result.request;
}

function unavailable(result: ExplanationBuild) {
  expect(result.status).toBe('not_available');
  if (result.status !== 'not_available') throw new Error('unexpectedly ready');
  return result;
}

describe('explain this error: choosing the focus diagnostic', () => {
  it('picks the diagnostic at the cursor, not the first in the file', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 30, column: 4 }),
      diagnostics: [raw(10, 'First problem.'), raw(30, 'Problem at the cursor.', { endColumn: 20 })],
      symbols: { status: 'found', nodes: [fn('validateToken', 25, 40)] },
    });

    const request = ready(await builder.build(input('diagnostic', { source: 'typed' })));

    expect(request.context.diagnostics.map((d) => d.message)).toEqual(['Problem at the cursor.']);
    expect(request.context.diagnostics[0]).toMatchObject({
      severity: 'error', relativePath: 'src/auth.ts', line: 30, symbolName: 'validateToken',
    });
  });

  it('falls back to the first diagnostic in the file, by position and not by adapter order', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 50, column: 1 }),
      diagnostics: [raw(40, 'Later.'), raw(12, 'Earliest.', { severity: 'hint' }), raw(20, 'Middle.')],
    });

    const request = ready(await builder.build(input('diagnostic')));

    expect(request.context.diagnostics.map((d) => d.message)).toEqual(['Earliest.']);
  });

  it('falls back to the first diagnostic when there is no cursor', async () => {
    const builder = builderFor({
      snapshot: snapshot(null),
      diagnostics: [raw(9, 'Second.'), raw(4, 'First.')],
    });
    expect(ready(await builder.build(input('diagnostic'))).context.diagnostics[0]?.message).toBe('First.');
  });

  it('treats the range end as part of the diagnostic and an empty range as a hit', () => {
    const entries: DiagnosticEntry[] = [
      { diagnostic: { severity: 'error', relativePath: 'a.ts', line: 5, column: 1, message: 'a' }, range: { start: { line: 5, column: 1 }, end: { line: 5, column: 9 } } },
      { diagnostic: { severity: 'error', relativePath: 'a.ts', line: 8, column: 4, message: 'b' }, range: { start: { line: 8, column: 4 }, end: { line: 8, column: 4 } } },
    ];
    expect(chooseFocusEntry(entries, { line: 5, column: 9 })?.diagnostic.message).toBe('a');
    expect(chooseFocusEntry(entries, { line: 8, column: 4 })?.diagnostic.message).toBe('b');
    expect(chooseFocusEntry(entries, { line: 5, column: 10 })?.diagnostic.message).toBe('a'); // not inside: first
    expect(chooseFocusEntry([], { line: 1, column: 1 })).toBeUndefined();
  });

  it('prefers the most severe, then the most specific, diagnostic at the cursor', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 20, column: 5 }),
      diagnostics: [
        raw(20, 'Warning here.', { severity: 'warning', endColumn: 9 }),
        raw(18, 'Wide error.', { endLine: 22, endColumn: 2 }),
        raw(20, 'Narrow error.', { endColumn: 9 }),
      ],
    });

    const request = ready(await builder.build(input('diagnostic')));

    expect(request.context.diagnostics.map((d) => d.message)).toEqual(['Narrow error.']);
  });

  it('sends only the focus diagnostic, never diagnostics from other files, but keeps the workspace counts', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 3, column: 1 }),
      diagnostics: [raw(3, 'Mine.'), raw(1, 'Elsewhere.', { fsPath: OTHER_FS_PATH }), raw(9, 'Same file.', { severity: 'warning' })],
    });

    const request = ready(await builder.build(input('diagnostic')));

    expect(request.context.diagnostics).toHaveLength(1);
    expect(request.context.diagnosticCounts).toEqual({ error: 2, warning: 1, information: 0, hint: 0 });
  });
});

describe('explain this error: the code that grounds it (Req 12.1)', () => {
  it('uses the enclosing symbol of the diagnostic line when it resolves', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 1, column: 1 }),
      diagnostics: [raw(30, 'In a function.')],
      symbols: { status: 'found', nodes: [fn('validateToken', 25, 40)] },
    });

    const context = ready(await builder.build(input('diagnostic'))).context;

    expect(context.nearbyCode).toMatchObject({ source: 'symbol', startLine: 25, endLine: 40, truncated: false });
    expect(context.nearbyCode?.text.split('\n')[0]).toBe('code-line-25');
    expect(context.currentSymbol).toEqual({ name: 'validateToken', kind: 'Function', startLine: 25, endLine: 40 });
    expect(context.symbolStatus).toBe('found');
  });

  it.each<[string, SymbolQueryResult, 'none_enclosing' | 'provider_unavailable']>([
    ['no enclosing symbol', { status: 'found', nodes: [fn('elsewhere', 1, 5)] }, 'none_enclosing'],
    ['no symbol at all', { status: 'none_enclosing' }, 'none_enclosing'],
    ['the symbol provider unavailable', { status: 'provider_unavailable' }, 'provider_unavailable'],
  ])('uses exactly 5 lines before and after the diagnostic line with %s', async (_name, symbols, symbolStatus) => {
    const builder = builderFor({ snapshot: snapshot({ line: 1, column: 1 }), diagnostics: [raw(30, 'Loose.')], symbols });

    const context = ready(await builder.build(input('diagnostic'))).context;

    expect(context.nearbyCode).toMatchObject({ source: 'cursor_window', startLine: 25, endLine: 35 });
    expect(context.nearbyCode?.text).toBe(LINES.slice(24, 35).join('\n'));
    expect(context.currentSymbol).toBeNull();
    expect(context.symbolStatus).toBe(symbolStatus);
    expect(context.diagnostics[0]).not.toHaveProperty('symbolName');
  });

  it('clamps the 5-line window at the start and the end of the file', async () => {
    const top = builderFor({ snapshot: snapshot({ line: 1, column: 1 }), diagnostics: [raw(2, 'Top.')] });
    const bottom = builderFor({ snapshot: snapshot({ line: 1, column: 1 }), diagnostics: [raw(59, 'Bottom.')] });

    expect(ready(await top.build(input('diagnostic'))).context.nearbyCode).toMatchObject({ startLine: 1, endLine: 7 });
    expect(ready(await bottom.build(input('diagnostic'))).context.nearbyCode).toMatchObject({ startLine: 54, endLine: 60 });
  });

  it('keeps the diagnostic line when the symbol is too large and the excerpt is cut', async () => {
    const longFile = Array.from({ length: 400 }, (_, index) => `big-line-${index + 1}`);
    const big: EditorSnapshot = {
      ...snapshot({ line: 1, column: 1 }),
      file: { fsPath: FS_PATH, relativePath: 'src/auth.ts', languageId: 'typescript', lineCount: longFile.length },
      getLines: (start, end) => longFile.slice(start - 1, end),
    };
    const builder = builderFor({
      snapshot: big,
      diagnostics: [raw(300, 'Deep inside.')],
      symbols: { status: 'found', nodes: [fn('huge', 1, 400)] },
    });

    const code = ready(await builder.build(input('diagnostic'))).context.nearbyCode;

    expect(code?.source).toBe('symbol');
    expect(code?.truncated).toBe(true);
    expect(code!.startLine).toBeLessThanOrEqual(300);
    expect(code!.endLine).toBeGreaterThanOrEqual(300);
    expect(code!.endLine - code!.startLine + 1).toBeLessThanOrEqual(80);
  });

  it('is not replaced by an unrelated editor selection', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 5, column: 1 }, { start: { line: 1, column: 1 }, end: { line: 3, column: 1 } }),
      diagnostics: [raw(30, 'Away from the selection.')],
    });

    const context = ready(await builder.build(input('diagnostic'))).context;

    expect(context.nearbyCode).toMatchObject({ source: 'cursor_window', startLine: 25, endLine: 35 });
  });

  it('caps a very long diagnostic message', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 3, column: 1 }),
      diagnostics: [raw(3, 'm'.repeat(MAX_DIAGNOSTIC_MESSAGE_CHARS + 400))],
    });
    expect(ready(await builder.build(input('diagnostic'))).context.diagnostics[0]?.message)
      .toHaveLength(MAX_DIAGNOSTIC_MESSAGE_CHARS);
  });
});

describe('explain this error: nothing to explain is reported locally (Req 12.4)', () => {
  it('reports no matching diagnostic when the file has none, even if other files do', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 1, column: 1 }),
      diagnostics: [raw(4, 'In another file.', { fsPath: OTHER_FS_PATH })],
    });

    const result = unavailable(await builder.build(input('diagnostic')));

    expect(result.reason).toBe('no_matching_diagnostic');
    expect(result.message).toContain('No matching diagnostic was found');
    expect(result.message).toContain('src/auth.ts');
    expect(result.message).not.toContain('In another file');
  });

  it('reports no matching diagnostic when no file is open', async () => {
    const result = unavailable(await builderFor({ snapshot: null }).build(input('diagnostic')));
    expect(result.reason).toBe('no_matching_diagnostic');
    expect(result.message).toBe('No matching diagnostic was found because no file is open.');
  });
});

describe('explain this function', () => {
  const symbols: SymbolQueryResult = { status: 'found', nodes: [fn('validateToken', 20, 40)] };

  it('is grounded in the enclosing symbol and sends no diagnostics', async () => {
    const builder = builderFor({ snapshot: snapshot({ line: 25, column: 3 }), diagnostics: [raw(25, 'Noise.')], symbols });

    const context = ready(await builder.build(input('function'))).context;

    expect(context.nearbyCode).toMatchObject({ source: 'symbol', startLine: 20, endLine: 40 });
    expect(context.currentSymbol).toEqual({ name: 'validateToken', kind: 'Function', startLine: 20, endLine: 40 });
    expect(context.diagnostics).toEqual([]);
    expect(context.diagnosticCounts.error).toBe(1);
  });

  it('uses the function, not the selection, when something is selected', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 25, column: 3 }, { start: { line: 26, column: 1 }, end: { line: 27, column: 1 } }),
      symbols,
    });
    expect(ready(await builder.build(input('function'))).context.nearbyCode).toMatchObject({ source: 'symbol', startLine: 20 });
  });

  it('reports that no function is available outside any function (Req 12.5)', async () => {
    const result = unavailable(await builderFor({ snapshot: snapshot({ line: 50, column: 1 }), symbols }).build(input('function')));

    expect(result.reason).toBe('no_function_or_selection');
    expect(result.message).toContain('No function or selection is available to explain.');
    expect(result.message).toContain('line 50 of src/auth.ts is not inside a function');
    expect(result.message).toContain('Nothing is selected either.');
  });

  it('says so, and offers the selection, when the cursor is outside a function but text is selected', async () => {
    const result = unavailable(await builderFor({
      snapshot: snapshot({ line: 50, column: 1 }, { start: { line: 50, column: 1 }, end: { line: 51, column: 1 } }),
      symbols,
    }).build(input('function')));
    expect(result.message).toContain('explain the selection instead');
  });

  it('names the unavailable symbol provider instead of guessing a function', async () => {
    const result = unavailable(await builderFor({
      snapshot: snapshot({ line: 25, column: 1 }),
      symbols: { status: 'provider_unavailable' },
    }).build(input('function')));
    expect(result.message).toContain('symbol provider is unavailable');
  });

  it('reports that no file is open', async () => {
    const result = unavailable(await builderFor({ snapshot: null }).build(input('function')));
    expect(result.message).toBe('No function or selection is available to explain. No file is open.');
  });
});

describe('explain the selection', () => {
  const selection = { start: { line: 12, column: 3 }, end: { line: 15, column: 9 } };

  it('is grounded in the selected lines and reports the selection range', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 15, column: 9 }, selection),
      symbols: { status: 'found', nodes: [fn('validateToken', 10, 20)] },
    });

    const context = ready(await builder.build(input('selection'))).context;

    expect(context.nearbyCode).toMatchObject({ source: 'selection', startLine: 12, endLine: 15 });
    expect(context.nearbyCode?.text).toBe(LINES.slice(11, 15).join('\n'));
    expect(context.selection).toEqual({ isEmpty: false, start: selection.start, end: selection.end });
    expect(context.currentSymbol?.name).toBe('validateToken');
    expect(context.diagnostics).toEqual([]);
  });

  it('reports that nothing is selected (Req 12.5), offering the function when there is one', async () => {
    const inside = unavailable(await builderFor({
      snapshot: snapshot({ line: 15, column: 1 }),
      symbols: { status: 'found', nodes: [fn('validateToken', 10, 20)] },
    }).build(input('selection')));
    const outside = unavailable(await builderFor({ snapshot: snapshot({ line: 55, column: 1 }) }).build(input('selection')));

    expect(inside.reason).toBe('no_function_or_selection');
    expect(inside.message).toContain('No function or selection is available to explain.');
    expect(inside.message).toContain('explain the function instead');
    expect(outside.message).toContain('Nothing is selected in src/auth.ts, and the cursor is not inside a function.');
  });

  it('reports that no file is open', async () => {
    const result = unavailable(await builderFor({ snapshot: null }).build(input('selection')));
    expect(result.message).toBe('No function or selection is available to explain. No file is open.');
  });
});

describe('the request that is built', () => {
  it.each(['diagnostic', 'function', 'selection'] as const)('is a valid utterance agent_request for %s', async (target) => {
    const builder = builderFor({
      snapshot: snapshot({ line: 25, column: 3 }, { start: { line: 24, column: 1 }, end: { line: 26, column: 1 } }),
      diagnostics: [raw(25, 'A problem.')],
      symbols: { status: 'found', nodes: [fn('validateToken', 20, 40)] },
    });

    const request = ready(await builder.build({ target, id: 'req-9', utterance: 'explain it', source: 'voice' }));

    expect(request).toMatchObject({
      version: 1, type: 'agent_request', id: 'req-9', kind: 'utterance',
      utterance: { text: 'explain it', source: 'voice' },
    });
    expect(request).not.toHaveProperty('testRun');
    expect(validateProtocolMessage(JSON.parse(JSON.stringify(request))).ok).toBe(true);
  });

  it('omits the utterance source when none is given and caps the utterance length', async () => {
    const builder = builderFor({ snapshot: snapshot({ line: 3, column: 1 }), diagnostics: [raw(3, 'x')] });
    const request = ready(await builder.build({ target: 'diagnostic', id: 'r', utterance: 'u'.repeat(5000) }));
    expect(request.utterance?.text).toHaveLength(4000);
    expect(request.utterance).not.toHaveProperty('source');
  });

  it('never carries an absolute path, an action or a command', async () => {
    const builder = builderFor({
      snapshot: snapshot({ line: 25, column: 3 }),
      diagnostics: [raw(25, 'A problem.')],
      symbols: { status: 'found', nodes: [fn('validateToken', 20, 40)] },
    });

    for (const target of ['diagnostic', 'function', 'selection'] as const) {
      const wire = JSON.stringify((await builder.build(input(target))));
      expect(wire).not.toContain('C:/private');
      expect(wire).not.toContain('activeFile');
      expect(wire).not.toMatch(/"(?:action|command|shell|cmd)"/);
    }
  });

  it('has no way to reach a backend: a local report builds without any client', async () => {
    // The builder's only collaborators are the adapter, the symbol lookup and the diagnostics
    // service, so a not_available result cannot have been relayed anywhere.
    const result = unavailable(await builderFor({ snapshot: null }).build(input('selection')));
    expect(Object.keys(result).sort()).toEqual(['message', 'reason', 'status']);
  });
});
