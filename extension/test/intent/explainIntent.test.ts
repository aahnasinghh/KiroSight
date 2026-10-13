import { describe, expect, it } from 'vitest';

import { parseExplainIntent } from '../../src/intent/explainIntent';
import { route } from '../../src/intent/localIntentRouter';

describe('parseExplainIntent', () => {
  it.each([
    ['explain this error', 'diagnostic'],
    ['Explain the error.', 'diagnostic'],
    ['please explain this problem', 'diagnostic'],
    ['explain this warning', 'diagnostic'],
    ['what does this error mean?', 'diagnostic'],
    ['  EXPLAIN   THIS   ERROR  ', 'diagnostic'],
    ['explain this function', 'function'],
    ['can you explain the current function', 'function'],
    ['explain this method', 'function'],
    ['what does this function do', 'function'],
    ['explain what this function does', 'function'],
    ['explain the selection', 'selection'],
    ['explain this selection', 'selection'],
    ['explain the selected code', 'selection'],
    ["explain what's selected", 'selection'],
  ] as const)('maps %j to %s', (utterance, target) => {
    expect(parseExplainIntent(utterance)).toBe(target);
  });

  it.each([
    '',
    '   ',
    'explain',
    'explain this error and fix it',
    'explain this error then run my tests',
    'explain the error in auth.ts',
    'explain this',
    'explain this code',
    'go to the first error',
    'what errors are there',
    'run my tests',
    'fix this error',
    'explain this functions',
    'unexplain this error',
  ])('does not treat %j as an explanation request', (utterance) => {
    expect(parseExplainIntent(utterance)).toBeNull();
  });

  it('only recognizes phrases the local router already sends to the agent', () => {
    for (const phrase of ['explain this error', 'explain this function', 'explain the selection']) {
      expect(parseExplainIntent(phrase)).not.toBeNull();
      expect(route(phrase)).toEqual({ route: 'agent', reason: 'semantic' });
    }
  });
});
