import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatDiagnostics } from '../../src/context/contextFormatter';
import type { DiagnosticInfo, SymbolNode } from '../../src/context/editorAdapter';
import { SymbolService } from '../../src/context/symbolService';
import { FakeEditorAdapter } from './fakeEditorAdapter';

const PATHS = ['src/current.ts', 'src/other.ts', 'lib/shared.ts', 'test/fixture.ts'] as const;
const SEVERITIES: DiagnosticInfo['severity'][] = [
  'error',
  'warning',
  'information',
  'hint',
];

const pathArb = fc.constantFrom(...PATHS);
const severityArb = fc.constantFrom(...SEVERITIES);
const optionalTextArb = fc.oneof(
  fc.constant(undefined),
  fc.string({ minLength: 1, maxLength: 12 }),
);

const diagnosticArb: fc.Arbitrary<DiagnosticInfo> = fc.record({
  relativePath: pathArb,
  severity: severityArb,
  line: fc.integer({ min: 1, max: 100 }),
  column: fc.integer({ min: 1, max: 100 }),
  message: fc.string({ minLength: 1, maxLength: 120 }),
  source: optionalTextArb,
  code: optionalTextArb,
});

const symbolArb = fc.record({
  name: fc.integer({ min: 1, max: 1_000_000 }).map((value) => `generatedSymbol${value}`),
  kind: fc.constantFrom('Function', 'Class', 'Method'),
});

function symbolNode(name: string, kind: string): SymbolNode {
  return {
    name,
    kind,
    range: {
      start: { line: 1, column: 1 },
      end: { line: 101, column: 1 },
    },
    children: [],
  };
}

function absolutePath(relativePath: string): string {
  return `C:/workspace/${relativePath}`;
}

function resolverWithLog(paths: string[]): (relativePath: string) => string {
  return (relativePath) => {
    const resolved = absolutePath(relativePath);
    paths.push(resolved);
    return resolved;
  };
}

function expectConcrete(report: string, diagnostic: DiagnosticInfo): void {
  expect(report).toContain(diagnostic.relativePath);
  expect(report).toContain(`at line ${diagnostic.line}`);
  expect(report).toContain(diagnostic.message);
  expect(report).not.toContain(absolutePath(diagnostic.relativePath));
}

describe('formatDiagnostics Property 20', () => {
  it('keeps every generated diagnostic concrete with path, line, message, and severity', async () => {
    await fc.assert(
      fc.asyncProperty(diagnosticArb, async (diagnostic) => {
        const resolvedPaths: string[] = [];
        const adapter = new FakeEditorAdapter({
          symbolResult: { status: 'none_enclosing' },
        });
        const report = await formatDiagnostics(
          { status: 'ok', diagnostics: [diagnostic] },
          new SymbolService(adapter),
          resolverWithLog(resolvedPaths),
        );

        expectConcrete(report, diagnostic);
        expect(report).toContain(
          `${diagnostic.severity.charAt(0).toUpperCase()}${diagnostic.severity.slice(1)}`,
        );
        expect(resolvedPaths).toEqual([absolutePath(diagnostic.relativePath)]);
      }),
      { numRuns: 100 },
    );
  });

  it('includes generated known symbols without replacing concrete location details', async () => {
    await fc.assert(
      fc.asyncProperty(diagnosticArb, symbolArb, async (diagnostic, generatedSymbol) => {
        const resolvedPaths: string[] = [];
        const adapter = new FakeEditorAdapter({
          symbolResult: {
            status: 'found',
            nodes: [symbolNode(generatedSymbol.name, generatedSymbol.kind)],
          },
        });
        const report = await formatDiagnostics(
          { status: 'ok', diagnostics: [diagnostic] },
          new SymbolService(adapter),
          resolverWithLog(resolvedPaths),
        );

        expectConcrete(report, diagnostic);
        expect(report).toContain(generatedSymbol.name);
        expect(report).not.toContain(resolvedPaths[0]);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves concrete diagnostics when no enclosing symbol exists', async () => {
    await fc.assert(
      fc.asyncProperty(diagnosticArb, symbolArb, async (diagnostic, generatedSymbol) => {
        const report = await formatDiagnostics(
          { status: 'ok', diagnostics: [diagnostic] },
          new SymbolService(new FakeEditorAdapter({
            symbolResult: { status: 'none_enclosing' },
          })),
          absolutePath,
        );

        expectConcrete(report, diagnostic);
        expect(report).not.toContain(generatedSymbol.name);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves concrete diagnostics when the symbol provider is unavailable', async () => {
    await fc.assert(
      fc.asyncProperty(diagnosticArb, symbolArb, async (diagnostic, generatedSymbol) => {
        const report = await formatDiagnostics(
          { status: 'ok', diagnostics: [diagnostic] },
          new SymbolService(new FakeEditorAdapter({
            symbolResult: { status: 'provider_unavailable' },
          })),
          absolutePath,
        );

        expectConcrete(report, diagnostic);
        expect(report).not.toContain(generatedSymbol.name);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves every diagnostic in a bounded multi-diagnostic result', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(diagnosticArb, { minLength: 2, maxLength: 12 }),
        async (diagnostics) => {
          const report = await formatDiagnostics(
            { status: 'ok', diagnostics },
            new SymbolService(new FakeEditorAdapter({
              symbolResult: { status: 'none_enclosing' },
            })),
            absolutePath,
          );

          expect(report.split('\n')).toHaveLength(diagnostics.length + 1);
          for (const diagnostic of diagnostics) {
            expectConcrete(report, diagnostic);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('uses the exact empty and no-file messages', async () => {
    const symbolService = new SymbolService(new FakeEditorAdapter());

    await expect(formatDiagnostics(
      { status: 'no_diagnostics', diagnostics: [] },
      symbolService,
      absolutePath,
    )).resolves.toBe('No diagnostics found.');

    await expect(formatDiagnostics(
      { status: 'no_file_open', diagnostics: [] },
      symbolService,
      absolutePath,
    )).resolves.toBe('No file is open.');
  });
});
