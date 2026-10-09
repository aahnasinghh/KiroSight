import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Action } from '../../src/actions/actionTypes';
import type { ActionResult, ActionResultDetails, ActionResultStatus } from '../../src/actions/actionResult';
import { formatActionResult } from '../../src/response/responseFormatter';

const ACTION_TYPES: Action['type'][] = [
  'NO_ACTION', 'GO_TO_DIAGNOSTIC', 'NEXT_DIAGNOSTIC', 'PREVIOUS_DIAGNOSTIC',
  'OPEN_FILE', 'GO_TO_LINE', 'FOCUS_EDITOR', 'RUN_TESTS',
];
const PATHS = ['src/auth.ts', 'test/auth.ts', 'packages/core/index.ts', 'lib/shared.ts'] as const;
const SEVERITIES = ['error', 'warning', 'information', 'hint'] as const;
const REASONS = [
  'No matching diagnostic was found',
  'No file is open',
  'File not found',
  'The requested location could not be found',
  'test running is not available yet',
  'The requested operation was rejected safely',
] as const;
const VAGUE = new Set(['Done.', 'Okay.', 'Success.', 'Failed.', 'Error.', 'Something went wrong.']);

const actionTypeArb = fc.constantFrom(...ACTION_TYPES);
const pathArb = fc.constantFrom(...PATHS);
const reasonArb = fc.constantFrom(...REASONS);
const severityArb = fc.constantFrom(...SEVERITIES);
const messageArb = fc.constantFrom('Token is invalid', 'Unused value', 'File was not found', 'Line is unavailable');

const fileDetailsArb: fc.Arbitrary<ActionResultDetails> = pathArb.map((relativePath) => ({
  kind: 'file_opened' as const,
  relativePath,
}));

const diagnosticDetailsArb: fc.Arbitrary<ActionResultDetails> = fc.record({
  relativePath: pathArb,
  line: fc.integer({ min: 1, max: 100 }),
  severity: severityArb,
  message: messageArb,
  wrapped: fc.option(fc.boolean(), { nil: undefined }),
  symbol: fc.option(fc.constantFrom('validateToken', 'renderView'), { nil: undefined }),
}).map(({ relativePath, line, severity, message, wrapped, symbol }) => ({
  kind: 'diagnostic_reached' as const,
  relativePath,
  line,
  severity,
  message,
  ...(wrapped === undefined ? {} : { wrapped }),
  ...(symbol === undefined ? {} : { symbol }),
}));

const locationDetailsArb: fc.Arbitrary<ActionResultDetails> = fc.record({
  relativePath: pathArb,
  line: fc.integer({ min: 1, max: 100 }),
}).map(({ relativePath, line }) => ({ kind: 'location_reached' as const, relativePath, line }));

const ambiguousDetailsArb: fc.Arbitrary<ActionResultDetails> = fc
  .array(pathArb, { minLength: 2, maxLength: 10 })
  .map((matches) => ({ matches, extra: 0 }))
  .chain(({ matches }) => fc.integer({ min: 0, max: 10 }).map((extra) => ({
    kind: 'ambiguous_files' as const,
    matches,
    totalMatches: matches.length + extra,
  })));

const fallbackResultArb: fc.Arbitrary<ActionResult> = fc.record({
  actionType: actionTypeArb,
  status: fc.constantFrom<ActionResultStatus>('ok', 'failed', 'declined', 'not_permitted', 'not_configured'),
  message: reasonArb,
}).map(({ actionType, status, message }) => ({ actionType, status, message }));

function resultWithDetails(
  actionType: Action['type'],
  status: ActionResultStatus,
  details: ActionResultDetails,
): ActionResult {
  return { actionType, status, message: 'Concrete result message', details };
}

function expectConcrete(text: string): void {
  expect(text.trim().length).toBeGreaterThan(0);
  expect(VAGUE.has(text.trim())).toBe(false);
}

describe('Property 21: action results state a concrete outcome or reason', () => {
  it('always produces non-empty, non-vague output for valid generated results', () => {
    const structuredArb = fc.oneof(
      fileDetailsArb.map((details) => resultWithDetails('OPEN_FILE', 'ok', details)),
      diagnosticDetailsArb.map((details) => resultWithDetails('GO_TO_DIAGNOSTIC', 'ok', details)),
      locationDetailsArb.map((details) => resultWithDetails('GO_TO_LINE', 'ok', details)),
      ambiguousDetailsArb.map((details) => resultWithDetails('OPEN_FILE', 'needs_clarification', details)),
      fallbackResultArb,
    );

    fc.assert(
      fc.property(structuredArb, (result) => expectConcrete(formatActionResult(result))),
      { numRuns: 100 },
    );
  });

  it('preserves every file_opened path and communicates that it opened', () => {
    fc.assert(
      fc.property(fileDetailsArb, (details) => {
        const text = formatActionResult(resultWithDetails('OPEN_FILE', 'ok', details));
        expect(text).toContain(details.relativePath);
        expect(text.toLowerCase()).toContain('opened');
      }),
      { numRuns: 100 },
    );
  });

  it('preserves diagnostic path, line, severity, message, and wrap meaning', () => {
    fc.assert(
      fc.property(diagnosticDetailsArb, (details) => {
        const text = formatActionResult(resultWithDetails('GO_TO_DIAGNOSTIC', 'ok', details));
        expect(text).toContain(details.relativePath);
        expect(text).toContain(`line ${details.line}`);
        expect(text).toContain(details.severity);
        expect(text).toContain(details.message);
        if (details.wrapped === true) {
          expect(text.toLowerCase()).toContain('wrapped');
        } else {
          expect(text.toLowerCase()).not.toContain('wrapped');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('preserves location path and line and communicates navigation', () => {
    fc.assert(
      fc.property(locationDetailsArb, (details) => {
        const text = formatActionResult(resultWithDetails('GO_TO_LINE', 'ok', details));
        expect(text).toContain(details.relativePath);
        expect(text).toContain(`line ${details.line}`);
        expect(text.toLowerCase()).toContain('moved');
      }),
      { numRuns: 100 },
    );
  });

  it('preserves specific reasons for every failure status', () => {
    fc.assert(
      fc.property(actionTypeArb, fc.constantFrom<ActionResultStatus>('failed', 'declined', 'not_permitted', 'not_configured'), reasonArb, (actionType, status, message) => {
        const text = formatActionResult({ actionType, status, message });
        expect(text).toContain(message);
        if (status === 'declined') expect(text.toLowerCase()).toContain('declined');
        if (status === 'not_permitted') expect(text.toLowerCase()).toContain('not permitted');
        if (status === 'not_configured') expect(text.toLowerCase()).toContain('configured');
      }),
      { numRuns: 100 },
    );
  });

  it('formats ambiguity using only supplied candidates and communicates the true total', () => {
    fc.assert(
      fc.property(ambiguousDetailsArb, (details) => {
        const text = formatActionResult(resultWithDetails('OPEN_FILE', 'needs_clarification', details));
        expect(text.toLowerCase()).toContain('ambiguous');
        for (const path of details.matches) expect(text).toContain(path);
        if (details.totalMatches > details.matches.length) {
          expect(text).toContain(`${details.totalMatches} matches in total`);
        }
        expect(details.matches.every((path) => !/^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/.test(path))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves fallback messages, including the RUN_TESTS placeholder', () => {
    fc.assert(
      fc.property(actionTypeArb, reasonArb, (actionType, message) => {
        const result: ActionResult = { actionType, status: 'failed', message };
        expect(formatActionResult(result)).toContain(message);
      }),
      { numRuns: 100 },
    );
    expect(formatActionResult({
      actionType: 'RUN_TESTS', status: 'failed', message: 'test running is not available yet',
    })).toContain('test running is not available yet');
  });

  it('does not mutate results and is deterministic', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fileDetailsArb.map((details) => resultWithDetails('OPEN_FILE', 'ok', details)),
          diagnosticDetailsArb.map((details) => resultWithDetails('GO_TO_DIAGNOSTIC', 'ok', details)),
          locationDetailsArb.map((details) => resultWithDetails('GO_TO_LINE', 'ok', details)),
          ambiguousDetailsArb.map((details) => resultWithDetails('OPEN_FILE', 'needs_clarification', details)),
          fallbackResultArb,
        ),
        (result) => {
          const before = JSON.stringify(result);
          const first = formatActionResult(result);
          const second = formatActionResult(result);
          expect(second).toBe(first);
          expect(JSON.stringify(result)).toBe(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
