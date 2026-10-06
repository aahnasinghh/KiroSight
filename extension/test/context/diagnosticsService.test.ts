import { describe, expect, it } from 'vitest';

import {
  compareForNavigation,
  compareForReport,
  DiagnosticsService,
} from '../../src/context/diagnosticsService';
import type { DiagnosticInfo, EditorSnapshot, RawDiagnostic } from '../../src/context/editorAdapter';
import { ContextService } from '../../src/context/contextService';
import { MAX_DIAGNOSTIC_MESSAGE_CHARS, MAX_DIAGNOSTICS_SENT } from '../../src/context/contextWindow';
import { SymbolService } from '../../src/context/symbolService';
import { FakeEditorAdapter } from './fakeEditorAdapter';

function snapshot(fsPath = 'C:/project/src/current.ts'): EditorSnapshot {
  return {
    workspaceName: 'diagnostics-test',
    rootCount: 1,
    file: {
      fsPath,
      relativePath: 'src/current.ts',
      languageId: 'typescript',
      lineCount: 20,
    },
    cursor: { line: 4, column: 2 },
    selection: null,
    getLines: () => ['const current = true;'],
  };
}

function raw(
  fsPath: string,
  relativePath: string,
  severity: RawDiagnostic['severity'],
  line: number,
  message = `diagnostic-${line}`,
): RawDiagnostic {
  return {
    fsPath,
    relativePath,
    severity,
    range: {
      start: { line, column: 3 },
      end: { line, column: 9 },
    },
    message,
    source: 'ts',
    code: 'TS0001',
  };
}

function info(
  relativePath: string,
  severity: DiagnosticInfo['severity'],
  line: number,
  message = `diagnostic-${line}`,
): DiagnosticInfo {
  return {
    relativePath,
    severity,
    line,
    column: 3,
    message,
  };
}

describe('DiagnosticsService', () => {
  it('maps and report-sorts workspace diagnostics', () => {
    const adapter = new FakeEditorAdapter({
      diagnostics: [
        raw('C:/project/src/z.ts', 'src/z.ts', 'warning', 2),
        raw('C:/project/src/a.ts', 'src/a.ts', 'error', 8),
        raw('C:/project/src/a.ts', 'src/a.ts', 'error', 3),
        raw('C:/project/src/b.ts', 'src/b.ts', 'hint', 1),
      ],
    });

    const result = new DiagnosticsService(adapter).getDiagnostics('workspace');

    expect(result.status).toBe('ok');
    expect(result.diagnostics.map(({ relativePath, severity, line }) => [relativePath, severity, line])).toEqual([
      ['src/a.ts', 'error', 3],
      ['src/a.ts', 'error', 8],
      ['src/z.ts', 'warning', 2],
      ['src/b.ts', 'hint', 1],
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      relativePath: 'src/a.ts',
      severity: 'error',
      line: 3,
      column: 3,
      source: 'ts',
      code: 'TS0001',
    });
    expect(result.diagnostics[0]).not.toHaveProperty('fsPath');
  });

  it('filters current-file diagnostics and preserves same-line report order', () => {
    const adapter = new FakeEditorAdapter({
      snapshot: snapshot(),
      diagnostics: [
        raw('C:/project/src/other.ts', 'src/other.ts', 'error', 1),
        raw('C:/project/src/current.ts', 'src/current.ts', 'warning', 5, 'first'),
        raw('C:/project/src/current.ts', 'src/current.ts', 'error', 5, 'second'),
        raw('C:/project/src/current.ts', 'src/current.ts', 'hint', 2),
      ],
    });

    const result = new DiagnosticsService(adapter).getDiagnostics('current_file');

    expect(result.status).toBe('ok');
    expect(result.diagnostics.map(({ message, line }) => [message, line])).toEqual([
      ['diagnostic-2', 2],
      ['first', 5],
      ['second', 5],
    ]);
  });

  it('reports no-file-open and empty-result states', () => {
    const noEditor = new DiagnosticsService(new FakeEditorAdapter()).getDiagnostics('current_file');
    expect(noEditor).toEqual({ status: 'no_file_open', diagnostics: [] });

    const empty = new DiagnosticsService(new FakeEditorAdapter({ snapshot: snapshot() }))
      .getDiagnostics('workspace');
    expect(empty).toEqual({ status: 'no_diagnostics', diagnostics: [] });
  });

  it('caps diagnostic messages using the context-window constant', () => {
    const message = 'x'.repeat(MAX_DIAGNOSTIC_MESSAGE_CHARS + 10);
    const result = new DiagnosticsService(new FakeEditorAdapter({
      diagnostics: [raw('C:/project/src/a.ts', 'src/a.ts', 'error', 1, message)],
    })).getDiagnostics('workspace');

    expect(result.diagnostics[0]?.message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_CHARS);
  });

  it('uses the specified pure comparator orderings', () => {
    expect([
      info('z.ts', 'error', 1),
      info('a.ts', 'warning', 1),
      info('a.ts', 'error', 3),
      info('a.ts', 'error', 2),
    ].sort(compareForReport).map(({ relativePath, severity, line }) => [relativePath, severity, line])).toEqual([
      ['a.ts', 'error', 2],
      ['a.ts', 'error', 3],
      ['z.ts', 'error', 1],
      ['a.ts', 'warning', 1],
    ]);

    expect(compareForNavigation(info('a.ts', 'error', 4), info('a.ts', 'warning', 4))).toBe(0);
    expect(compareForNavigation(info('a.ts', 'error', 4), info('b.ts', 'error', 1))).toBeLessThan(0);
  });

  it('caps ContextService diagnostics while retaining full severity counts', async () => {
    const diagnostics = Array.from({ length: MAX_DIAGNOSTICS_SENT + 5 }, (_, index) =>
      raw('C:/project/src/current.ts', 'src/current.ts', index % 2 === 0 ? 'error' : 'warning', index + 1),
    );
    const adapter = new FakeEditorAdapter({ snapshot: snapshot(), diagnostics });
    const context = await new ContextService(adapter, new SymbolService(adapter)).getContext();

    expect(context.diagnostics).toHaveLength(MAX_DIAGNOSTICS_SENT);
    expect(context.diagnosticCounts).toEqual({
      error: Math.ceil(diagnostics.length / 2),
      warning: Math.floor(diagnostics.length / 2),
      information: 0,
      hint: 0,
    });
  });
});
