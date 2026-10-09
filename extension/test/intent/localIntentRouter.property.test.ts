import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Action } from '../../src/actions/actionTypes';
import { validateAction } from '../../src/actions/actionValidator';
import { applyExactlyOneMatchPolicy, route } from '../../src/intent/localIntentRouter';
import { normalize } from '../../src/intent/normalize';
import type { LocalIntent } from '../../src/intent/intentTypes';

const ACTION_TYPES: readonly Action['type'][] = [
  'NO_ACTION', 'GO_TO_DIAGNOSTIC', 'NEXT_DIAGNOSTIC', 'PREVIOUS_DIAGNOSTIC',
  'OPEN_FILE', 'GO_TO_LINE', 'FOCUS_EDITOR', 'RUN_TESTS',
];
const PATHS = ['src/auth.ts', 'src/please.ts', 'test/fixture.test.ts', 'lib/shared.ts'] as const;
const APPROVED = [
  'where am i', 'current function', 'read selection', 'what errors are there',
  'errors in this file', 'next error', 'previous error', 'go to the first error',
  'go to line 1', 'open src/auth.ts', 'focus editor', 'run tests', 'help',
  'summarize the test failures',
] as const;
const semanticPhrases = [
  'explain this', 'why is this failing', 'what does this code do',
  'summarize this function',
] as const;
const symbolPhrases = ['go to function foo', 'go to symbol foo', 'go to function validateToken'] as const;
const failure = (result: ReturnType<typeof route>): void => {
  expect(result.route).toBe('agent');
};

const pathArb = fc.constantFrom(...PATHS);
const lineArb = fc.integer({ min: 1, max: 100 });
const whitespaceArb = fc.constantFrom('', ' ', '  ', '\t');

function varied(phrase: string): fc.Arbitrary<string> {
  return fc.record({
    leading: whitespaceArb,
    trailing: whitespaceArb,
    upper: fc.boolean(),
    filler: fc.constantFrom('', 'please ', 'can you ', 'could you ', 'kirosight '),
  }).map(({ leading, trailing, upper, filler }) => {
    const text = `${filler}${phrase}`;
    return `${leading}${upper ? text.toUpperCase() : text}${trailing}`;
  });
}

function actionFrom(result: ReturnType<typeof route>): Action {
  expect(result.route).toBe('local');
  if (result.route !== 'local' || result.intent.kind !== 'ACTION') {
    throw new Error('Expected a local action');
  }
  return result.intent.action;
}

describe('Property 10: Local router is deterministic and conservative', () => {
  it('is deterministic for arbitrary utterances', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (text) => {
        expect(route(text)).toEqual(route(text));
        expect(normalize(text)).toBe(normalize(text));
      }),
      { numRuns: 100 },
    );
  });

  it('routes deliberately unknown arbitrary text to the agent without an action', () => {
    const approved = new Set(APPROVED.map(normalize));
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }).filter((text) => !approved.has(normalize(text))),
        (text) => {
          const result = route(text);
          if (result.route === 'local') {
            expect(result.intent.kind).not.toBe('ACTION');
          } else {
            expect(['unrecognized', 'semantic', 'ambiguous']).toContain(result.reason);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('applies the exactly-one-match policy for zero, one, and multiple candidates', () => {
    const first: LocalIntent = { kind: 'ACTION', action: { type: 'FOCUS_EDITOR' } };
    const second: LocalIntent = { kind: 'ACTION', action: { type: 'RUN_TESTS' } };
    expect(applyExactlyOneMatchPolicy([])).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(applyExactlyOneMatchPolicy([first])).toEqual({ route: 'local', intent: first });
    expect(applyExactlyOneMatchPolicy([first, second])).toEqual({
      route: 'agent', reason: 'ambiguous',
    });
    expect(applyExactlyOneMatchPolicy([first, second])).not.toEqual({ route: 'local', intent: first });
    expect(applyExactlyOneMatchPolicy([first, second])).not.toEqual({ route: 'local', intent: second });
  });

  it('preserves approved local meanings across safe normalization variants', () => {
    const cases: Array<[string, Action['type'] | 'intent']> = [
      ['where am i', 'intent'], ['current function', 'intent'], ['read selection', 'intent'],
      ['next error', 'NEXT_DIAGNOSTIC'], ['previous error', 'PREVIOUS_DIAGNOSTIC'],
      ['go to the first error', 'GO_TO_DIAGNOSTIC'], ['go to line 4', 'GO_TO_LINE'],
      ['open src/auth.ts', 'OPEN_FILE'], ['focus editor', 'FOCUS_EDITOR'],
      ['run tests', 'RUN_TESTS'], ['help', 'intent'],
    ];
    for (const [phrase, expected] of cases) {
      fc.assert(
        fc.property(varied(phrase), (text) => {
          const result = route(text);
          expect(result.route).toBe('local');
          if (expected !== 'intent') expect(actionFrom(result).type).toBe(expected);
        }),
        { numRuns: 100 },
      );
    }
  });

  it('maps only approved diagnostic ordinals to zero-based indexes', () => {
    for (const [phrase, index] of [
      ['go to the first error', 0], ['go to the second error', 1], ['go to the third error', 2],
    ] as const) {
      fc.assert(
        fc.property(varied(phrase), (text) => {
          const action = actionFrom(route(text));
          expect(action).toEqual({ type: 'GO_TO_DIAGNOSTIC', index, severity: 'error' });
        }),
        { numRuns: 100 },
      );
    }
  });

  it('creates only valid go-to-line actions and rejects invalid forms conservatively', () => {
    fc.assert(
      fc.property(lineArb, (line) => {
        const action = actionFrom(route(`go to line ${line}`));
        expect(action).toEqual({ type: 'GO_TO_LINE', line });
        expect(validateAction(action, 'local')).toMatchObject({ ok: true });
      }),
      { numRuns: 100 },
    );
    for (const text of ['go to line 0', 'go to line -1', 'go to line 1.5', 'go to line nope', 'go to line 999999999999999999999']) {
      failure(route(text));
    }
  });

  it('preserves safe OPEN_FILE targets without searching or making absolute paths', () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        const action = actionFrom(route(`open ${path}`));
        expect(action).toEqual({ type: 'OPEN_FILE', path });
        expect(action.path).not.toMatch(/^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/);
        expect(validateAction(action, 'local')).toMatchObject({ ok: true });
      }),
      { numRuns: 100 },
    );
  });

  it('validates every generated local action and keeps the exact allow-list', () => {
    const phrases = ['next error', 'previous error', 'go to the first error', 'go to line 10', 'open src/auth.ts', 'focus editor', 'run tests'];
    fc.assert(
      fc.property(fc.constantFrom(...phrases), (phrase) => {
        const action = actionFrom(route(phrase));
        expect(ACTION_TYPES).toContain(action.type);
        expect(validateAction(action, 'local')).toMatchObject({ ok: true });
        expect(action).not.toHaveProperty('command');
        expect(action).not.toHaveProperty('cmd');
        expect(action).not.toHaveProperty('shell');
        expect(action).not.toHaveProperty('args');
      }),
      { numRuns: 100 },
    );
  });

  it('keeps RUN_TESTS as the needs-confirmation action', () => {
    fc.assert(
      fc.property(varied('run tests'), (text) => {
        const action = actionFrom(route(text));
        expect(action).toEqual({ type: 'RUN_TESTS' });
        expect(validateAction(action, 'local')).toMatchObject({ ok: true, risk: 'needs-confirmation' });
      }),
      { numRuns: 100 },
    );
  });

  it('routes semantic and symbol-navigation phrases conservatively', () => {
    for (const phrase of semanticPhrases) {
      fc.assert(
        fc.property(varied(phrase), (text) => {
          const result = route(text);
          return result.route === 'agent' && result.reason === 'semantic';
        }),
        { numRuns: 100 },
      );
    }
    for (const phrase of symbolPhrases) {
      fc.assert(
        fc.property(varied(phrase), (text) => {
          const result = route(text);
          return result.route === 'agent' && result.reason === 'unrecognized';
        }),
        { numRuns: 100 },
      );
    }
  });

  it('keeps approved commands anchored to the whole utterance', () => {
    const invalid = ['random text go to line 4', 'go to line 4 and explain it', 'please open auth.ts then run tests'];
    for (const text of invalid) {
      failure(route(text));
    }
  });

  it('does not mutate input strings or pure candidate arrays', () => {
    const text = '  PLEASE, go to the second error! ';
    const candidates: LocalIntent[] = [
      { kind: 'ACTION', action: { type: 'FOCUS_EDITOR' } },
      { kind: 'ACTION', action: { type: 'RUN_TESTS' } },
    ];
    const before = JSON.stringify(candidates);
    route(text);
    applyExactlyOneMatchPolicy(candidates);
    expect(text).toBe('  PLEASE, go to the second error! ');
    expect(JSON.stringify(candidates)).toBe(before);
  });
});
