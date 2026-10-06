import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  compareForNavigation,
  compareForReport,
  DiagnosticsService,
} from '../../src/context/diagnosticsService';
import { MAX_DIAGNOSTIC_MESSAGE_CHARS } from '../../src/context/contextWindow';
import type {
  DiagnosticInfo,
  EditorSnapshot,
  RawDiagnostic,
} from '../../src/context/editorAdapter';
import { FakeEditorAdapter } from './fakeEditorAdapter';

const PATHS = ['src/current.ts', 'src/other.ts', 'lib/shared.ts', 'test/fixture.ts'] as const;
const SEVERITIES: RawDiagnostic['severity'][] = [
  'error',
  'warning',
  'information',
  'hint',
];
const activeFilePath = 'src/current.ts';
const activeFileFsPath = 'C:/workspace/src/current.ts';

const pathArb = fc.constantFrom(...PATHS);
const severityArb = fc.constantFrom(...SEVERITIES);

const rawDiagnosticArb: fc.Arbitrary<RawDiagnostic> = fc.record({
  relativePath: pathArb,
  severity: severityArb,
  line: fc.integer({ min: 1, max: 40 }),
  column: fc.integer({ min: 1, max: 80 }),
  message: fc.string({ minLength: 0, maxLength: MAX_DIAGNOSTIC_MESSAGE_CHARS + 40 }),
  source: fc.constantFrom('typescript', 'eslint'),
  code: fc.constantFrom('TS1000', 'E1001', 'W1002'),
}).map(({ relativePath, severity, line, column, message, source, code }) => ({
  fsPath: `C:/workspace/${relativePath}`,
  relativePath,
  severity,
  range: {
    start: { line, column },
    end: { line, column: column + 1 },
  },
  message,
  source,
  code,
}));

const diagnosticsArb = fc.array(rawDiagnosticArb, { minLength: 1, maxLength: 40 });

function activeEditorSnapshot(): EditorSnapshot {
  return {
    workspaceName: 'property-test',
    rootCount: 1,
    file: {
      fsPath: activeFileFsPath,
      relativePath: activeFilePath,
      languageId: 'typescript',
      lineCount: 40,
    },
    cursor: { line: 1, column: 1 },
    selection: null,
    getLines: () => ['const current = true;'],
  };
}

function mapped(raw: RawDiagnostic): DiagnosticInfo {
  return {
    severity: raw.severity,
    relativePath: raw.relativePath,
    line: raw.range.start.line,
    column: raw.range.start.column,
    message: raw.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS),
    source: raw.source,
    code: raw.code,
  };
}

function diagnosticKey(diagnostic: DiagnosticInfo): string {
  return JSON.stringify([
    diagnostic.severity,
    diagnostic.relativePath,
    diagnostic.line,
    diagnostic.column,
    diagnostic.message,
    diagnostic.source,
    diagnostic.code,
  ]);
}

function multiset(values: readonly DiagnosticInfo[]): Map<string, number> {
  return values.reduce((counts, value) => {
    const key = diagnosticKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
}

function expectAdjacentOrder(
  diagnostics: readonly DiagnosticInfo[],
  comparator: (left: DiagnosticInfo, right: DiagnosticInfo) => number,
): void {
  for (let index = 1; index < diagnostics.length; index += 1) {
    expect(comparator(diagnostics[index - 1], diagnostics[index])).toBeLessThanOrEqual(0);
  }
}

function expectNoAbsolutePaths(diagnostics: readonly DiagnosticInfo[]): void {
  for (const diagnostic of diagnostics) {
    expect(diagnostic).not.toHaveProperty('fsPath');
    expect(diagnostic.relativePath).not.toMatch(/^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/);
  }
}

describe('DiagnosticsService Property 15', () => {
  it('reports every generated workspace diagnostic with mapped, report-ordered values', () => {
    fc.assert(
      fc.property(diagnosticsArb, (rawDiagnostics) => {
        const result = new DiagnosticsService(new FakeEditorAdapter({
          diagnostics: rawDiagnostics,
        })).getDiagnostics('workspace');

        expect(result.status).toBe('ok');
        expect(result.diagnostics).toHaveLength(rawDiagnostics.length);
        expect(multiset(result.diagnostics)).toEqual(multiset(rawDiagnostics.map(mapped)));
        expectNoAbsolutePaths(result.diagnostics);
        expectAdjacentOrder(result.diagnostics, compareForReport);
      }),
      { numRuns: 100 },
    );
  });

  it('reports only active-file diagnostics while preserving all matching mappings', () => {
    fc.assert(
      fc.property(diagnosticsArb, (generatedDiagnostics) => {
        const rawDiagnostics = generatedDiagnostics.map((diagnostic) =>
          diagnostic.relativePath === activeFilePath
            ? { ...diagnostic, fsPath: activeFileFsPath }
            : diagnostic,
        );
        const expected = rawDiagnostics
          .filter((diagnostic) => diagnostic.fsPath === activeFileFsPath)
          .map(mapped);
        const result = new DiagnosticsService(new FakeEditorAdapter({
          snapshot: activeEditorSnapshot(),
          diagnostics: rawDiagnostics,
        })).getDiagnostics('current_file');

        if (expected.length === 0) {
          expect(result).toEqual({ status: 'no_diagnostics', diagnostics: [] });
          return;
        }

        expect(result.status).toBe('ok');
        expect(result.diagnostics).toHaveLength(expected.length);
        expect(multiset(result.diagnostics)).toEqual(multiset(expected));
        expect(result.diagnostics.every((diagnostic) => diagnostic.relativePath === activeFilePath)).toBe(true);
        expectAdjacentOrder(result.diagnostics, compareForNavigation);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps navigation ordering independent of severity and stable for same path and line', () => {
    const stableGroupArb = fc.record({
      severity: severityArb,
      message: fc.string({ minLength: 1, maxLength: 30 }),
      column: fc.integer({ min: 1, max: 80 }),
      source: fc.constantFrom('typescript', 'eslint'),
      code: fc.constantFrom('TS1000', 'E1001'),
    }).chain((first) =>
      fc.array(
        fc.record({
          severity: severityArb,
          message: fc.string({ minLength: 1, maxLength: 30 }),
          column: fc.integer({ min: 1, max: 80 }),
          source: fc.constantFrom('typescript', 'eslint'),
          code: fc.constantFrom('TS1000', 'E1001'),
        }),
        { minLength: 2, maxLength: 8 },
      ).map((rest) => [first, ...rest]),
    );

    fc.assert(
      fc.property(stableGroupArb, (entries) => {
        const rawDiagnostics = entries.map((entry, index) => ({
          fsPath: activeFileFsPath,
          relativePath: activeFilePath,
          severity: entry.severity,
          range: {
            start: { line: 12, column: entry.column },
            end: { line: 12, column: entry.column + 1 },
          },
          message: `${entry.message}-${index}`,
          source: entry.source,
          code: entry.code,
        }));
        const result = new DiagnosticsService(new FakeEditorAdapter({
          snapshot: activeEditorSnapshot(),
          diagnostics: rawDiagnostics,
        })).getDiagnostics('current_file');

        expect(result.status).toBe('ok');
        expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
          rawDiagnostics.map((diagnostic) => diagnostic.message),
        );
        expect(compareForNavigation(result.diagnostics[0], result.diagnostics[1])).toBe(0);
        expectAdjacentOrder(result.diagnostics, compareForNavigation);
      }),
      { numRuns: 100 },
    );
  });

  it('returns explicit no-file and empty-result states', () => {
    expect(new DiagnosticsService(new FakeEditorAdapter()).getDiagnostics('current_file')).toEqual({
      status: 'no_file_open',
      diagnostics: [],
    });

    const emptyAdapter = new FakeEditorAdapter({ snapshot: activeEditorSnapshot() });
    const service = new DiagnosticsService(emptyAdapter);
    expect(service.getDiagnostics('workspace')).toEqual({
      status: 'no_diagnostics',
      diagnostics: [],
    });
    expect(service.getDiagnostics('current_file')).toEqual({
      status: 'no_diagnostics',
      diagnostics: [],
    });
  });
});
