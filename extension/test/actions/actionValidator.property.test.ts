import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Action } from '../../src/actions/actionTypes';
import { ALLOWLIST } from '../../src/actions/allowlist';
import { MAX_ACTION_PATH_CHARS, validateAction } from '../../src/actions/actionValidator';

// Feature: kirosight-mvp, Property 1: Action validation
const RUNS = { numRuns: 100 };
const ORIGINS = ['local', 'agent'] as const;

// Exhaustive by construction: the Record forces every Action['type'] key.
const ACTION_TYPE_KEYS: Record<Action['type'], true> = {
  NO_ACTION: true,
  GO_TO_DIAGNOSTIC: true,
  NEXT_DIAGNOSTIC: true,
  PREVIOUS_DIAGNOSTIC: true,
  OPEN_FILE: true,
  GO_TO_LINE: true,
  FOCUS_EDITOR: true,
  RUN_TESTS: true,
};
const EXPECTED_NAMES = Object.keys(ACTION_TYPE_KEYS).sort();
const MAX = Number.MAX_SAFE_INTEGER;

const severityArb = fc.constantFrom('error', 'warning', 'any' as const);
const pathArb = fc
  .string({ minLength: 1, maxLength: MAX_ACTION_PATH_CHARS })
  .filter((s) => !s.includes('\u0000'));

const validActionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant<Action>({ type: 'NO_ACTION' }),
  fc.record({
    type: fc.constant('GO_TO_DIAGNOSTIC' as const),
    index: fc.integer({ min: 0, max: MAX }),
  }),
  fc.record(
    {
      type: fc.constant('GO_TO_DIAGNOSTIC' as const),
      index: fc.integer({ min: 0, max: MAX }),
      severity: severityArb,
    },
    { requiredKeys: ['type', 'index'] },
  ),
  fc.record({ type: fc.constant('NEXT_DIAGNOSTIC' as const) }, { requiredKeys: ['type'] }),
  fc.record({ type: fc.constant('NEXT_DIAGNOSTIC' as const), severity: severityArb }),
  fc.record({ type: fc.constant('PREVIOUS_DIAGNOSTIC' as const), severity: severityArb }),
  fc.record({ type: fc.constant('OPEN_FILE' as const), path: pathArb }),
  fc.record({ type: fc.constant('GO_TO_LINE' as const), line: fc.integer({ min: 1, max: MAX }) }),
  fc.constant<Action>({ type: 'FOCUS_EDITOR' }),
  fc.constant<Action>({ type: 'RUN_TESTS' }),
) as fc.Arbitrary<Action>;

const extraKeyArb = fc.oneof(
  fc.constantFrom('command', 'cmd', 'shell', 'args'),
  fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== 'type' && k !== '__proto__'),
);

describe('Property 1: action validation', () => {
  it('accepts every valid action for both origins with equivalent results and correct risk', () => {
    fc.assert(
      fc.property(validActionArb, (action) => {
        const local = validateAction({ ...action }, 'local');
        const agent = validateAction({ ...action }, 'agent');
        expect(local).toEqual(agent);
        expect(local.ok).toBe(true);
        if (local.ok) {
          expect(local.action).toEqual(action);
          expect(local.risk).toBe(action.type === 'RUN_TESTS' ? 'needs-confirmation' : 'safe');
          expect(local.risk).toBe(ALLOWLIST[action.type].risk);
        }
      }),
      RUNS,
    );
  });

  it('covers all 8 action names with the expected risk classes', () => {
    for (const name of EXPECTED_NAMES) {
      const result = validateAction({ type: name, ...sampleParams(name) }, 'agent');
      expect(result.ok, name).toBe(true);
      if (result.ok) {
        expect(result.risk).toBe(name === 'RUN_TESTS' ? 'needs-confirmation' : 'safe');
      }
    }
  });

  it('rejects unknown action names with UNKNOWN_ACTION', () => {
    const fixed = ['RUN_COMMAND', 'GO_TO_SYMBOL', 'run_tests', 'go_to_line', 'Go_To_Line', 'RUN_tests'];
    const nameArb = fc.oneof(
      fc.constantFrom(...fixed),
      fc.string({ maxLength: 20 }).filter((s) => !EXPECTED_NAMES.includes(s)),
    );
    fc.assert(
      fc.property(nameArb, fc.constantFrom(...ORIGINS), (type, origin) => {
        const result = validateAction({ type }, origin);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('UNKNOWN_ACTION');
      }),
      RUNS,
    );
    for (const raw of [null, undefined, 5, 'RUN_TESTS', [], {}, { type: 1 }, { type: null }]) {
      const result = validateAction(raw, 'agent');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('UNKNOWN_ACTION');
    }
  });

  it('rejects extra properties with INVALID_PARAMS, including on RUN_TESTS', () => {
    fc.assert(
      fc.property(
        validActionArb,
        extraKeyArb,
        fc.anything(),
        fc.constantFrom(...ORIGINS),
        (action, key, value, origin) => {
          fc.pre(!(key in action));
          const raw = Object.defineProperty({ ...action }, key, {
            value,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          const result = validateAction(raw, origin);
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.code).toBe('INVALID_PARAMS');
        },
      ),
      RUNS,
    );
    for (const key of ['command', 'cmd', 'shell', 'args']) {
      const result = validateAction({ type: 'RUN_TESTS', [key]: 'rm -rf /' }, 'agent');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_PARAMS');
    }
  });

  it('rejects invalid parameters with INVALID_PARAMS', () => {
    const badNumber = fc.oneof(
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.constant(NaN),
      fc.constant(Infinity),
      fc.double({ noInteger: true, noNaN: true, noDefaultInfinity: true }).filter((n) => !Number.isInteger(n)),
      fc.constant(MAX + 1),
      fc.constant(-1),
    );
    const badSeverity = fc
      .string()
      .filter((s) => s !== 'error' && s !== 'warning' && s !== 'any');
    const badCases = fc.oneof(
      fc.record({ type: fc.constant('GO_TO_DIAGNOSTIC'), index: badNumber }),
      fc.record({ type: fc.constant('GO_TO_DIAGNOSTIC') }),
      fc.record({ type: fc.constant('GO_TO_DIAGNOSTIC'), index: fc.constant(0), severity: badSeverity }),
      fc.record({ type: fc.constant('NEXT_DIAGNOSTIC'), severity: badSeverity }),
      fc.record({ type: fc.constant('PREVIOUS_DIAGNOSTIC'), severity: badSeverity }),
      fc.record({ type: fc.constant('OPEN_FILE'), path: fc.oneof(fc.integer(), fc.constant(null), fc.constant('')) }),
      fc.record({ type: fc.constant('OPEN_FILE') }),
      fc.record({ type: fc.constant('GO_TO_LINE'), line: badNumber }),
      fc.record({ type: fc.constant('GO_TO_LINE') }),
    );
    fc.assert(
      fc.property(badCases, fc.constantFrom(...ORIGINS), (raw, origin) => {
        const result = validateAction(raw, origin);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('INVALID_PARAMS');
      }),
      RUNS,
    );
  });

  it('only ever yields one of the 8 exact actions on success', () => {
    fc.assert(
      fc.property(fc.anything(), fc.constantFrom(...ORIGINS), (raw, origin) => {
        const result = validateAction(raw, origin);
        if (result.ok) {
          expect(EXPECTED_NAMES).toContain(result.action.type);
        }
      }),
      RUNS,
    );
    fc.assert(
      fc.property(
        fc.record({ type: fc.constantFrom(...EXPECTED_NAMES) }, { withDeletedKeys: false }),
        fc.dictionary(fc.string({ maxLength: 8 }), fc.anything(), { maxKeys: 3 }),
        (base, extra) => {
          const result = validateAction({ ...extra, ...base }, 'agent');
          if (result.ok) expect(EXPECTED_NAMES).toContain(result.action.type);
        },
      ),
      RUNS,
    );
  });

  describe('OPEN_FILE path bounds', () => {
    it('accepts lengths 1..MAX_ACTION_PATH_CHARS', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: MAX_ACTION_PATH_CHARS }),
          fc.constantFrom(...ORIGINS),
          (len, origin) => {
            const result = validateAction({ type: 'OPEN_FILE', path: 'a'.repeat(len) }, origin);
            expect(result.ok).toBe(true);
          },
        ),
        RUNS,
      );
      expect(validateAction({ type: 'OPEN_FILE', path: 'a'.repeat(MAX_ACTION_PATH_CHARS) }, 'agent').ok).toBe(true);
    });

    it('rejects empty, over-length and NUL-containing paths', () => {
      const expectInvalid = (path: string): void => {
        const result = validateAction({ type: 'OPEN_FILE', path }, 'agent');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.code).toBe('INVALID_PARAMS');
      };
      expectInvalid('');
      expectInvalid('a'.repeat(MAX_ACTION_PATH_CHARS + 1));
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: MAX_ACTION_PATH_CHARS - 1 }),
          fc.nat(),
          (len, at) => {
            const chars = 'a'.repeat(len).split('');
            chars.splice(at % (len + 1), 0, '\u0000');
            expectInvalid(chars.join(''));
          },
        ),
        RUNS,
      );
    });
  });

  describe('numeric bounds', () => {
    it('GO_TO_DIAGNOSTIC index', () => {
      for (const index of [0, MAX]) {
        expect(validateAction({ type: 'GO_TO_DIAGNOSTIC', index }, 'agent').ok).toBe(true);
      }
      for (const index of [-1, 0.5, MAX + 1]) {
        const r = validateAction({ type: 'GO_TO_DIAGNOSTIC', index }, 'agent');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('INVALID_PARAMS');
      }
    });

    it('GO_TO_LINE line', () => {
      for (const line of [1, MAX]) {
        expect(validateAction({ type: 'GO_TO_LINE', line }, 'agent').ok).toBe(true);
      }
      for (const line of [0, -1, 1.5, MAX + 1]) {
        const r = validateAction({ type: 'GO_TO_LINE', line }, 'agent');
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.code).toBe('INVALID_PARAMS');
      }
    });
  });

  describe('allow-list parity', () => {
    it('Action union, ALLOWLIST and allowlist.json contain the same 8 names', () => {
      const fixturePath = resolve(__dirname, '../../src/protocol/fixtures/allowlist.json');
      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
        actions: { name: string; risk: string }[];
      };
      const fixtureNames = fixture.actions.map((a) => a.name).sort();
      expect(EXPECTED_NAMES).toHaveLength(8);
      expect(Object.keys(ALLOWLIST).sort()).toEqual(EXPECTED_NAMES);
      expect(fixtureNames).toEqual(EXPECTED_NAMES);
      for (const entry of fixture.actions) {
        expect(ALLOWLIST[entry.name as Action['type']].risk).toBe(entry.risk);
      }
    });
  });
});

function sampleParams(name: string): Record<string, unknown> {
  switch (name) {
    case 'GO_TO_DIAGNOSTIC':
      return { index: 0 };
    case 'OPEN_FILE':
      return { path: 'src/a.ts' };
    case 'GO_TO_LINE':
      return { line: 1 };
    default:
      return {};
  }
}
