import { describe, expect, it } from 'vitest';

import { validateAction } from '../../src/actions/actionValidator';
import { applyExactlyOneMatchPolicy, route } from '../../src/intent/localIntentRouter';
import type { LocalIntent } from '../../src/intent/intentTypes';

function localAction(input: string): { type: string } {
  const result = route(input);
  expect(result.route).toBe('local');
  if (result.route !== 'local' || result.intent.kind !== 'ACTION') throw new Error('expected action');
  return result.intent.action;
}

describe('LocalIntentRouter', () => {
  it('routes context and description intents locally', () => {
    expect(route('where am I')).toEqual({ route: 'local', intent: { kind: 'WHERE_AM_I' } });
    expect(route('read the current function')).toEqual({ route: 'local', intent: { kind: 'CURRENT_SYMBOL' } });
    expect(route('read selection')).toEqual({ route: 'local', intent: { kind: 'READ_SELECTION' } });
    expect(route('what errors are there')).toEqual({
      route: 'local', intent: { kind: 'DESCRIBE_DIAGNOSTICS', scope: 'workspace' },
    });
    expect(route('errors in this file')).toEqual({
      route: 'local', intent: { kind: 'DESCRIBE_DIAGNOSTICS', scope: 'file' },
    });
  });

  it('routes diagnostic actions with exact severities and zero-based ordinals', () => {
    expect(localAction('next error')).toEqual({ type: 'NEXT_DIAGNOSTIC', severity: 'error' });
    expect(localAction('previous problem')).toEqual({ type: 'PREVIOUS_DIAGNOSTIC', severity: 'error' });
    expect(localAction('go to the first error')).toEqual({ type: 'GO_TO_DIAGNOSTIC', index: 0, severity: 'error' });
    expect(localAction('go to the second error')).toEqual({ type: 'GO_TO_DIAGNOSTIC', index: 1, severity: 'error' });
    expect(localAction('go to the third error')).toEqual({ type: 'GO_TO_DIAGNOSTIC', index: 2, severity: 'error' });
  });

  it('routes line, file, focus, and test actions', () => {
    expect(localAction('go to line 1')).toEqual({ type: 'GO_TO_LINE', line: 1 });
    expect(localAction('line 42')).toEqual({ type: 'GO_TO_LINE', line: 42 });
    expect(localAction('open src/auth.ts')).toEqual({ type: 'OPEN_FILE', path: 'src/auth.ts' });
    expect(localAction('focus editor')).toEqual({ type: 'FOCUS_EDITOR' });
    expect(localAction('run my tests')).toEqual({ type: 'RUN_TESTS' });
    expect(route('summarize the test failures')).toEqual({ route: 'local', intent: { kind: 'SUMMARIZE_LAST_TEST_RUN' } });
    expect(route('help')).toEqual({ route: 'local', intent: { kind: 'HELP' } });
  });

  it('routes "list all failures" locally and only as a whole utterance', () => {
    expect(route('List all failures')).toEqual({ route: 'local', intent: { kind: 'LIST_TEST_FAILURES' } });
    expect(route('please list all failures')).toEqual({ route: 'local', intent: { kind: 'LIST_TEST_FAILURES' } });
    for (const text of ['list all failures in auth.ts', 'list failures', 'show all failures', 'all failures']) {
      expect(route(text).route).toBe('agent');
    }
  });

  it('routes every produced action through local validation', () => {
    const utterances = [
      'next error', 'previous error', 'go to the first error', 'go to line 10',
      'open src/auth.ts', 'focus editor', 'run tests',
    ];
    for (const utterance of utterances) {
      const action = localAction(utterance);
      expect(validateAction(action, 'local')).toMatchObject({ ok: true });
    }
    expect(localAction('run tests')).not.toHaveProperty('command');
  });

  it('routes semantic and unsupported input to the agent conservatively', () => {
    expect(route('explain this error')).toEqual({ route: 'agent', reason: 'semantic' });
    expect(route('why is this failing')).toEqual({ route: 'agent', reason: 'semantic' });
    expect(route('go to function foo')).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(route('go to symbol foo')).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(route('last error')).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(route('please do something mysterious')).toEqual({ route: 'agent', reason: 'unrecognized' });
  });

  it('does not create invalid line actions or absolute file targets', () => {
    expect(route('go to line 0')).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(route('go to line 1.5')).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(route('open C:/workspace/auth.ts')).toEqual({ route: 'agent', reason: 'unrecognized' });
    expect(route('open /workspace/auth.ts')).toEqual({ route: 'agent', reason: 'unrecognized' });
  });

  it('routes multiple matched local candidates to the agent as ambiguous', () => {
    const first: LocalIntent = { kind: 'ACTION', action: { type: 'FOCUS_EDITOR' } };
    const second: LocalIntent = { kind: 'ACTION', action: { type: 'RUN_TESTS' } };

    expect(applyExactlyOneMatchPolicy([first, second])).toEqual({
      route: 'agent', reason: 'ambiguous',
    });
    expect(applyExactlyOneMatchPolicy([first, second])).not.toEqual({
      route: 'local', intent: first,
    });
    expect(applyExactlyOneMatchPolicy([first, second])).not.toEqual({
      route: 'local', intent: second,
    });
  });

  it('is deterministic for repeated calls', () => {
    const input = '  PLEASE, go to the second error! ';
    expect(route(input)).toEqual(route(input));
  });

  it('routes a bare explanation request to the semantic agent route', () => {
    expect(route('explain this')).toEqual({ route: 'agent', reason: 'semantic' });
  });
});
