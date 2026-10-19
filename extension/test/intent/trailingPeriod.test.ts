import { describe, expect, it } from 'vitest';

import { normalize, route } from '../../src/intent/localIntentRouter';

/**
 * Speech-to-text with smart formatting ends a sentence with a period ("Run my tests."). The router
 * must treat that period as punctuation, not as part of the command, while a period INSIDE the
 * utterance (a file name) is kept. Nothing else about matching changes: still whole-utterance, exact
 * phrases, no fuzzy or natural-language interpretation.
 *
 * Defects these would catch: a spoken command falling through to the agent because of its final
 * period; a file name losing an internal period; matching quietly widening.
 */
describe('normalize: trailing sentence periods', () => {
  it.each([
    ['Run my tests.', 'run my tests'],
    ['Where am I.', 'where am i'],
    ['  Next error.  ', 'next error'],
    ['Go to line 10.', 'go to line 10'],
    ['Where am I...', 'where am i'],
    ['Where am I . ', 'where am i'],
    ['Where am I?.', 'where am i'],
    ['Please run my tests.', 'run my tests'],
    ['.', ''],
    [' . . ', ''],
    ['kirosight.', ''],
  ])('%j becomes %j', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it('keeps periods inside file names, and drops only the sentence period after them', () => {
    expect(normalize('Open auth.ts.')).toBe('open auth.ts');
    expect(normalize('Open auth.ts')).toBe('open auth.ts');
    expect(normalize('Open .env')).toBe('open .env');
    expect(normalize('Open .env.')).toBe('open .env');
    expect(normalize('open src/a.test.ts.')).toBe('open src/a.test.ts');
    expect(normalize('Go to line 1.5')).toBe('go to line 1.5');
  });

  it('is idempotent, including for stacked and spaced periods', () => {
    for (const input of ['x. .', 'Run my tests. .', 'a.b. . .', 'open a.ts..', '. a', 'Where am I.']) {
      expect(normalize(normalize(input))).toBe(normalize(input));
    }
  });
});

describe('route: punctuated speech routes like the unpunctuated command', () => {
  const cases: ReadonlyArray<readonly [string, string, unknown]> = [
    ['Run my tests.', 'run my tests', { kind: 'ACTION', action: { type: 'RUN_TESTS' } }],
    ['Where am I.', 'where am I', { kind: 'WHERE_AM_I' }],
    ['Next error.', 'next error', { kind: 'ACTION', action: { type: 'NEXT_DIAGNOSTIC', severity: 'error' } }],
    ['Go to line 10.', 'go to line 10', { kind: 'ACTION', action: { type: 'GO_TO_LINE', line: 10 } }],
    ['Open auth.ts.', 'open auth.ts', { kind: 'ACTION', action: { type: 'OPEN_FILE', path: 'auth.ts' } }],
    ['Open .env', 'open .env', { kind: 'ACTION', action: { type: 'OPEN_FILE', path: '.env' } }],
    ['Run tests.', 'run tests', { kind: 'ACTION', action: { type: 'RUN_TESTS' } }],
    ['Help.', 'help', { kind: 'HELP' }],
  ];

  it.each(cases)('%j routes locally, exactly as %j does', (spoken, plain, intent) => {
    expect(route(spoken)).toEqual({ route: 'local', intent });
    expect(route(plain)).toEqual({ route: 'local', intent });
  });

  it('every unpunctuated command still routes as before', () => {
    expect(route('run my tests')).toEqual({ route: 'local', intent: { kind: 'ACTION', action: { type: 'RUN_TESTS' } } });
    expect(route('where am i')).toEqual({ route: 'local', intent: { kind: 'WHERE_AM_I' } });
    expect(route('open src/auth.ts')).toEqual({
      route: 'local', intent: { kind: 'ACTION', action: { type: 'OPEN_FILE', path: 'src/auth.ts' } },
    });
  });
});

describe('route: no accidental widening', () => {
  it.each([
    'Run my tests please.',
    'Run my test.',
    'Run my tests and delete files.',
    'Run the tests, then open auth.ts.',
    'Open auth.ts and delete it.',
    'Go to line 10.5.',
    'Go to line 1.5',
    'Where am I now.',
    'Next. Error.',
    'Open .',
    'Run. My tests.',
  ])('%j is not a local command', (text) => {
    expect(route(text).route).toBe('agent');
  });

  it('a semantic phrase stays semantic with or without a final period', () => {
    expect(route('Explain this error.')).toEqual({ route: 'agent', reason: 'semantic' });
    expect(route('Why is this slow.')).toEqual({ route: 'agent', reason: 'semantic' });
  });

  it('a period never makes an invalid action valid', () => {
    expect(route('Go to line 0.').route).toBe('agent');
    expect(route('Open /etc/passwd.').route).toBe('agent');
    expect(route('Open C:\\Windows\\win.ini.').route).toBe('agent');
  });
});
