import { describe, expect, it } from 'vitest';

import type { DiagnosticInfo } from '../../src/context/editorAdapter';
import { next, previous, resolve } from '../../src/navigation/diagnosticNavigation';

function diagnostic(
  relativePath: string,
  line: number,
  severity: DiagnosticInfo['severity'] = 'error',
  message = `${relativePath}:${line}`,
): DiagnosticInfo {
  return { relativePath, line, severity, column: 1, message };
}

describe('diagnostic navigation', () => {
  const diagnostics = [
    diagnostic('src/z.ts', 20, 'error'),
    diagnostic('src/a.ts', 10, 'warning'),
    diagnostic('src/a.ts', 3, 'error'),
    diagnostic('src/m.ts', 7, 'error'),
  ];

  it('resolves the first and second diagnostics using zero-based indexes', () => {
    expect(resolve(diagnostics, 0)).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 3), wrapped: false,
    });
    expect(resolve(diagnostics, 1)).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 10, 'warning'), wrapped: false,
    });
  });

  it('returns a deterministic failure for an out-of-range ordinal', () => {
    expect(resolve(diagnostics, 4)).toEqual({
      status: 'failed', message: 'No matching diagnostic was found',
    });
  });

  it('filters ordinal, next, and previous candidates by severity', () => {
    expect(resolve(diagnostics, 0, 'warning')).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 10, 'warning'), wrapped: false,
    });
    expect(next(diagnostics, { relativePath: 'src/a.ts', line: 1 }, 'warning')).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 10, 'warning'), wrapped: false,
    });
    expect(previous(diagnostics, { relativePath: 'src/z.ts', line: 99 }, 'warning')).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 10, 'warning'), wrapped: false,
    });
  });

  it('moves next strictly after the current path and line', () => {
    expect(next(diagnostics, { relativePath: 'src/a.ts', line: 3 })).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 10, 'warning'), wrapped: false,
    });
    expect(next(diagnostics, { relativePath: 'src/a.ts', line: 10 })).toEqual({
      status: 'ok', diagnostic: diagnostic('src/m.ts', 7), wrapped: false,
    });
  });

  it('wraps next to the first matching diagnostic', () => {
    expect(next(diagnostics, { relativePath: 'src/z.ts', line: 20 })).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 3), wrapped: true,
    });
  });

  it('moves previous strictly before the current path and line', () => {
    expect(previous(diagnostics, { relativePath: 'src/z.ts', line: 20 })).toEqual({
      status: 'ok', diagnostic: diagnostic('src/m.ts', 7), wrapped: false,
    });
    expect(previous(diagnostics, { relativePath: 'src/m.ts', line: 7 })).toEqual({
      status: 'ok', diagnostic: diagnostic('src/a.ts', 10, 'warning'), wrapped: false,
    });
  });

  it('wraps previous to the last matching diagnostic', () => {
    expect(previous(diagnostics, { relativePath: 'src/a.ts', line: 3 })).toEqual({
      status: 'ok', diagnostic: diagnostic('src/z.ts', 20), wrapped: true,
    });
  });

  it('returns no-match for empty candidates', () => {
    expect(resolve([], 0)).toEqual({ status: 'failed', message: 'No matching diagnostic was found' });
    expect(next(diagnostics, { relativePath: 'src/a.ts', line: 1 }, 'information')).toEqual({
      status: 'failed', message: 'No matching diagnostic was found',
    });
    expect(previous([], { relativePath: 'src/a.ts', line: 1 })).toEqual({
      status: 'failed', message: 'No matching diagnostic was found',
    });
  });

  it('preserves stable order for same-path and same-line diagnostics', () => {
    const first = diagnostic('src/a.ts', 3, 'warning', 'first');
    const second = diagnostic('src/a.ts', 3, 'error', 'second');
    expect(resolve([first, second], 0)).toEqual({ status: 'ok', diagnostic: first, wrapped: false });
    expect(resolve([first, second], 1)).toEqual({ status: 'ok', diagnostic: second, wrapped: false });
    expect(next([first, second], { relativePath: 'src/a.ts', line: 3 })).toEqual({
      status: 'ok', diagnostic: first, wrapped: true,
    });
  });

  it('uses compareForNavigation cross-file path and line ordering', () => {
    const unordered = [
      diagnostic('src/b.ts', 1),
      diagnostic('src/a.ts', 20),
      diagnostic('src/a.ts', 2),
    ];
    expect(resolve(unordered, 0)).toMatchObject({ diagnostic: { relativePath: 'src/a.ts', line: 2 } });
    expect(resolve(unordered, 1)).toMatchObject({ diagnostic: { relativePath: 'src/a.ts', line: 20 } });
    expect(resolve(unordered, 2)).toMatchObject({ diagnostic: { relativePath: 'src/b.ts', line: 1 } });
  });
});
