import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compareForNavigation } from '../../src/context/diagnosticsService';
import type { DiagnosticInfo } from '../../src/context/editorAdapter';
import {
  next,
  previous,
  resolve,
  type DiagnosticLocation,
  type DiagnosticNavigationResult,
} from '../../src/navigation/diagnosticNavigation';

const PATHS = ['src/a.ts', 'src/b.ts', 'lib/shared.ts', 'test/fixture.ts'] as const;
const SEVERITIES: DiagnosticInfo['severity'][] = [
  'error',
  'warning',
  'information',
  'hint',
];
const NAVIGATION_SEVERITIES = ['error', 'warning', 'any', undefined] as const;
const NO_MATCH = { status: 'failed', message: 'No matching diagnostic was found' } as const;

const pathArb = fc.constantFrom(...PATHS);
const severityArb = fc.constantFrom(...SEVERITIES);
const navigationSeverityArb = fc.constantFrom(...NAVIGATION_SEVERITIES);

const diagnosticArb: fc.Arbitrary<DiagnosticInfo> = fc.record({
  relativePath: pathArb,
  line: fc.integer({ min: 1, max: 40 }),
  column: fc.integer({ min: 1, max: 80 }),
  severity: severityArb,
  message: fc.string({ minLength: 1, maxLength: 30 }),
});

const diagnosticCollectionArb: fc.Arbitrary<DiagnosticInfo[]> = fc.array(diagnosticArb, {
  minLength: 1,
  maxLength: 10,
}).map((generated) => {
  const seed = generated[0]!;
  return [
    { relativePath: 'src/a.ts', line: 3, column: 1, severity: 'error', message: 'same-error' },
    { relativePath: 'src/a.ts', line: 3, column: 2, severity: 'warning', message: 'same-warning' },
    { relativePath: 'src/b.ts', line: 2, column: 1, severity: 'information', message: 'cross-file-information' },
    { relativePath: 'lib/shared.ts', line: 8, column: 1, severity: 'hint', message: 'cross-file-hint' },
    ...generated,
    { ...seed, column: seed.column + 1, message: `${seed.message}-duplicate` },
  ];
});

const errorOnlyCollectionArb: fc.Arbitrary<DiagnosticInfo[]> = fc.array(
  diagnosticArb.map((diagnostic) => ({ ...diagnostic, severity: 'error' as const })),
  { minLength: 1, maxLength: 10 },
);

const sameLocationCollectionArb: fc.Arbitrary<DiagnosticInfo[]> = fc.array(
  fc.record({
    column: fc.integer({ min: 1, max: 80 }),
    severity: severityArb,
    message: fc.string({ minLength: 1, maxLength: 30 }),
  }),
  { minLength: 2, maxLength: 8 },
).map((entries) => entries.map((entry, index) => ({
  relativePath: 'src/same.ts',
  line: 12,
  column: entry.column,
  severity: entry.severity,
  message: `${entry.message}-${index}`,
})));

function ordered(
  diagnostics: readonly DiagnosticInfo[],
  severity: typeof NAVIGATION_SEVERITIES[number],
): DiagnosticInfo[] {
  const matching = severity === undefined || severity === 'any'
    ? [...diagnostics]
    : diagnostics.filter((diagnostic) => diagnostic.severity === severity);

  return matching
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort(({ diagnostic: left, index: leftIndex }, { diagnostic: right, index: rightIndex }) =>
      compareForNavigation(left, right) || leftIndex - rightIndex,
    )
    .map(({ diagnostic }) => diagnostic);
}

function locationOf(diagnostic: DiagnosticInfo): DiagnosticLocation {
  return { relativePath: diagnostic.relativePath, line: diagnostic.line };
}

function probe(location: DiagnosticLocation): DiagnosticInfo {
  return {
    relativePath: location.relativePath,
    line: location.line,
    column: 1,
    severity: 'error',
    message: 'location-probe',
  };
}

function compareToLocation(diagnostic: DiagnosticInfo, location: DiagnosticLocation): number {
  return compareForNavigation(diagnostic, probe(location));
}

function expectSuccess(
  result: DiagnosticNavigationResult,
  expected: DiagnosticInfo,
  wrapped: boolean,
): void {
  expect(result).toEqual({ status: 'ok', diagnostic: expected, wrapped });
}

function expectLocation(result: DiagnosticNavigationResult, expected: DiagnosticInfo): void {
  expect(result.status).toBe('ok');
  if (result.status === 'ok') {
    expect(locationOf(result.diagnostic)).toEqual(locationOf(expected));
  }
}

describe('Property 29: next and previous diagnostics wrap and invert', () => {
  it('selects the first strictly later diagnostic or wraps to the first candidate', () => {
    fc.assert(
      fc.property(
        diagnosticCollectionArb,
        navigationSeverityArb,
        fc.record({ relativePath: pathArb, line: fc.integer({ min: 1, max: 40 }) }),
        (diagnostics, severity, location) => {
        const candidates = ordered(diagnostics, severity);
        const later = candidates.find((candidate) => compareToLocation(candidate, location) > 0);
        const result = next(diagnostics, location, severity);

        if (candidates.length === 0) {
          expect(result).toEqual(NO_MATCH);
        } else if (later !== undefined) {
          expectSuccess(result, later, false);
        } else {
          expectSuccess(result, candidates[0]!, true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('selects the last strictly earlier diagnostic or wraps to the last candidate', () => {
    fc.assert(
      fc.property(
        diagnosticCollectionArb,
        navigationSeverityArb,
        fc.record({ relativePath: pathArb, line: fc.integer({ min: 1, max: 40 }) }),
        (diagnostics, severity, location) => {
          const candidates = ordered(diagnostics, severity);
          const earlier = candidates.filter((candidate) => compareToLocation(candidate, location) < 0).at(-1);
          const result = previous(diagnostics, location, severity);

          if (candidates.length === 0) {
            expect(result).toEqual(NO_MATCH);
          } else if (earlier !== undefined) {
            expectSuccess(result, earlier, false);
          } else {
            expectSuccess(result, candidates.at(-1)!, true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('wraps at or beyond the final and at or before the first matching location', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, navigationSeverityArb, (diagnostics, severity) => {
        const candidates = ordered(diagnostics, severity);
        fc.pre(candidates.length > 0);
        const first = candidates[0]!;
        const last = candidates.at(-1)!;
        const atOrAfterLast = { relativePath: last.relativePath, line: last.line + 1 };
        const atOrBeforeFirst = { relativePath: '0/before.ts', line: 1 };

        expectSuccess(next(diagnostics, atOrAfterLast, severity), first, true);
        expectSuccess(previous(diagnostics, atOrBeforeFirst, severity), last, true);
      }),
      { numRuns: 100 },
    );
  });

  it('is inverse by navigation location for adjacent distinct locations', () => {
    fc.assert(
      fc.property(
        diagnosticCollectionArb,
        navigationSeverityArb,
        (diagnostics, severity) => {
          const candidates = ordered(diagnostics, severity);
          const groups: DiagnosticInfo[][] = [];

          for (const candidate of candidates) {
            const currentGroup = groups.at(-1);
            if (currentGroup !== undefined && compareForNavigation(currentGroup[0]!, candidate) === 0) {
              currentGroup.push(candidate);
            } else {
              groups.push([candidate]);
            }
          }

          for (let index = 0; index < groups.length - 1; index += 1) {
            const current = groups[index]![0]!;
            const following = groups[index + 1]![0]!;
            const forward = next(diagnostics, locationOf(current), severity);
            const backward = previous(diagnostics, locationOf(following), severity);

            expectSuccess(forward, following, false);
            expectSuccess(backward, groups[index]!.at(-1)!, false);
            expectLocation(backward, current);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('respects error, warning, any, and omitted severity filters', () => {
    fc.assert(
      fc.property(
        diagnosticCollectionArb,
        navigationSeverityArb,
        fc.record({ relativePath: pathArb, line: fc.integer({ min: 1, max: 40 }) }),
        (diagnostics, severity, location) => {
          const candidates = ordered(diagnostics, severity);
          const forward = next(diagnostics, location, severity);
          const backward = previous(diagnostics, location, severity);

          for (const result of [forward, backward]) {
            if (result.status !== 'ok') {
              expect(result).toEqual(NO_MATCH);
            } else if (severity === 'error' || severity === 'warning') {
              expect(result.diagnostic.severity).toBe(severity);
            } else {
              expect(candidates).toContain(result.diagnostic);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('returns the deterministic failed result when the severity filter removes all candidates', () => {
    fc.assert(
      fc.property(errorOnlyCollectionArb, (diagnostics) => {
        expect(next(diagnostics, { relativePath: 'src/a.ts', line: 1 }, 'warning')).toEqual(NO_MATCH);
        expect(previous(diagnostics, { relativePath: 'src/a.ts', line: 1 }, 'warning')).toEqual(NO_MATCH);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves stable same-location order without using severity, column, or message as tie-breakers', () => {
    fc.assert(
      fc.property(sameLocationCollectionArb, (diagnostics) => {
        for (const [index, diagnostic] of diagnostics.entries()) {
          expect(resolve(diagnostics, index)).toEqual({
            status: 'ok', diagnostic, wrapped: false,
          });
        }

        const location = locationOf(diagnostics[0]!);
        expectSuccess(next(diagnostics, location), diagnostics[0]!, true);
        expectSuccess(previous(diagnostics, location), diagnostics.at(-1)!, true);
      }),
      { numRuns: 100 },
    );
  });
});


describe('Property 16: diagnostic ordinal navigation follows path/line order', () => {
  it('resolves every zero-based index from the stable filtered navigation list', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, navigationSeverityArb, (diagnostics, severity) => {
        const candidates = ordered(diagnostics, severity);

        for (const [index, expected] of candidates.entries()) {
          expect(resolve(diagnostics, index, severity)).toEqual({
            status: 'ok',
            diagnostic: expected,
            wrapped: false,
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('maps the first, second, and third user ordinals to indexes 0, 1, and 2', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, navigationSeverityArb, (diagnostics, severity) => {
        const candidates = ordered(diagnostics, severity);
        const userOrdinals = Math.min(3, candidates.length);

        for (let ordinal = 1; ordinal <= userOrdinals; ordinal += 1) {
          const index = ordinal - 1;
          const result = resolve(diagnostics, index, severity);
          expectSuccess(result, candidates[index]!, false);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('filters candidates before resolving the zero-based ordinal', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, (diagnostics) => {
        const errors = ordered(diagnostics, 'error');
        const warnings = ordered(diagnostics, 'warning');

        for (const [index, expected] of errors.entries()) {
          expect(resolve(diagnostics, index, 'error')).toEqual({
            status: 'ok', diagnostic: expected, wrapped: false,
          });
        }
        for (const [index, expected] of warnings.entries()) {
          expect(resolve(diagnostics, index, 'warning')).toEqual({
            status: 'ok', diagnostic: expected, wrapped: false,
          });
        }
      }),
      { numRuns: 100 },
    );
  });

  it('covers error, warning, any, and omitted severity candidate sets', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, (diagnostics) => {
        for (const severity of NAVIGATION_SEVERITIES) {
          const candidates = ordered(diagnostics, severity);
          for (const [index, expected] of candidates.entries()) {
            expect(resolve(diagnostics, index, severity)).toEqual({
              status: 'ok', diagnostic: expected, wrapped: false,
            });
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('returns the deterministic failure for out-of-range indexes without wrapping', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, navigationSeverityArb, (diagnostics, severity) => {
        const candidates = ordered(diagnostics, severity);
        expect(candidates.length).toBeGreaterThanOrEqual(0);
        expect(resolve(diagnostics, candidates.length, severity)).toEqual(NO_MATCH);
        expect(resolve(diagnostics, candidates.length + 1, severity)).toEqual(NO_MATCH);
      }),
      { numRuns: 100 },
    );
  });

  it('returns the deterministic failure when diagnostics exist but the filter is empty', () => {
    fc.assert(
      fc.property(errorOnlyCollectionArb, (diagnostics) => {
        expect(resolve(diagnostics, 0, 'warning')).toEqual(NO_MATCH);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves same-path and same-line input order for ordinal resolution', () => {
    fc.assert(
      fc.property(sameLocationCollectionArb, (diagnostics) => {
        const before = JSON.stringify(diagnostics);
        const candidates = ordered(diagnostics, undefined);

        for (const [index, expected] of candidates.entries()) {
          expect(resolve(diagnostics, index)).toEqual({
            status: 'ok', diagnostic: expected, wrapped: false,
          });
        }

        expect(candidates).toEqual(diagnostics);
        expect(JSON.stringify(diagnostics)).toBe(before);
      }),
      { numRuns: 100 },
    );
  });

  it('resolves cross-file ordinals using compareForNavigation rather than input order', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, (diagnostics) => {
        const candidates = ordered(diagnostics, 'any');
        expect(candidates.length).toBeGreaterThan(0);

        for (const [index, expected] of candidates.entries()) {
          expect(resolve(diagnostics, index, 'any')).toEqual({
            status: 'ok', diagnostic: expected, wrapped: false,
          });
        }

        expect(candidates.map(({ relativePath, line }) => [relativePath, line])).not.toEqual(
          diagnostics.map(({ relativePath, line }) => [relativePath, line]),
        );
      }),
      { numRuns: 100 },
    );
  });

  it('does not mutate the caller diagnostics array or its diagnostic objects', () => {
    fc.assert(
      fc.property(diagnosticCollectionArb, navigationSeverityArb, (diagnostics, severity) => {
        const arrayBefore = [...diagnostics];
        const valuesBefore = diagnostics.map((diagnostic) => ({ ...diagnostic }));
        const candidates = ordered(diagnostics, severity);

        for (let index = 0; index <= candidates.length; index += 1) {
          resolve(diagnostics, index, severity);
        }

        expect(diagnostics).toEqual(arrayBefore);
        expect(diagnostics).toEqual(valuesBefore);
      }),
      { numRuns: 100 },
    );
  });
});
