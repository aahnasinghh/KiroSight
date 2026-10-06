import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ALLOWLIST } from '../../src/actions/allowlist';
import { MAX_ACTION_PATH_CHARS, validateAction } from '../../src/actions/actionValidator';
import type { Action } from '../../src/actions/actionTypes';

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('Task 3.5 action validation', () => {
  const validActions: readonly Action[] = [
    { type: 'NO_ACTION' },
    { type: 'GO_TO_DIAGNOSTIC', index: 0, severity: 'error' },
    { type: 'NEXT_DIAGNOSTIC', severity: 'warning' },
    { type: 'PREVIOUS_DIAGNOSTIC', severity: 'any' },
    { type: 'OPEN_FILE', path: 'src/index.ts' },
    { type: 'GO_TO_LINE', line: 1 },
    { type: 'FOCUS_EDITOR' },
    { type: 'RUN_TESTS' },
  ];

  it('validates all eight actions with identical local and agent behavior', () => {
    for (const action of validActions) {
      const local = validateAction(action, 'local');
      const agent = validateAction(action, 'agent');

      expect(local).toEqual(agent);
      expect(local).toEqual({
        ok: true,
        action,
        risk: action.type === 'RUN_TESTS' ? 'needs-confirmation' : 'safe',
      });
    }
  });

  it('rejects unknown and forbidden action names', () => {
    for (const type of ['GO_TO_SYMBOL', 'RUN_COMMAND', 'go_to_line', 'Go_To_Line']) {
      expect(validateAction({ type }, 'local')).toMatchObject({
        ok: false,
        code: 'UNKNOWN_ACTION',
      });
      expect(validateAction({ type }, 'agent')).toEqual(validateAction({ type }, 'local'));
    }
  });

  it('rejects missing, invalid, out-of-bounds, and extra parameters', () => {
    const invalidActions: readonly unknown[] = [
      { type: 'GO_TO_DIAGNOSTIC' },
      { type: 'GO_TO_DIAGNOSTIC', index: -1 },
      { type: 'GO_TO_DIAGNOSTIC', index: 0.5 },
      { type: 'GO_TO_LINE' },
      { type: 'GO_TO_LINE', line: 0 },
      { type: 'GO_TO_LINE', line: 1.5 },
      { type: 'OPEN_FILE' },
      { type: 'OPEN_FILE', path: '' },
      { type: 'OPEN_FILE', path: 'bad\u0000path' },
      { type: 'OPEN_FILE', path: 'x'.repeat(MAX_ACTION_PATH_CHARS + 1) },
      { type: 'GO_TO_DIAGNOSTIC', index: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'GO_TO_LINE', line: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'NO_ACTION', command: 'arbitrary' },
      { type: 'FOCUS_EDITOR', cmd: 'arbitrary' },
      { type: 'RUN_TESTS', shell: 'npm test' },
      { type: 'RUN_TESTS', args: ['--watch'] },
    ];

    for (const action of invalidActions) {
      expect(validateAction(action, 'local')).toMatchObject({
        ok: false,
        code: 'INVALID_PARAMS',
      });
      expect(validateAction(action, 'agent')).toEqual(validateAction(action, 'local'));
    }
  });

  it('accepts the boundary values of each numeric and path parameter', () => {
    const boundaryActions: readonly Action[] = [
      { type: 'OPEN_FILE', path: 'x'.repeat(MAX_ACTION_PATH_CHARS) },
      { type: 'GO_TO_DIAGNOSTIC', index: Number.MAX_SAFE_INTEGER },
      { type: 'GO_TO_LINE', line: Number.MAX_SAFE_INTEGER },
    ];

    for (const action of boundaryActions) {
      expect(validateAction(action, 'local')).toMatchObject({ ok: true, risk: 'safe' });
    }
  });

  it('matches the shared fixture to the TypeScript registry', () => {
    const fixture = JSON.parse(
      readFileSync(resolve(testDirectory, '../../src/protocol/fixtures/allowlist.json'), 'utf8'),
    ) as {
      actions: Array<{ name: string; risk: string; parameters: string[] }>;
    };

    expect(fixture.actions).toEqual([
      { name: 'NO_ACTION', risk: ALLOWLIST.NO_ACTION.risk, parameters: [] },
      { name: 'GO_TO_DIAGNOSTIC', risk: ALLOWLIST.GO_TO_DIAGNOSTIC.risk, parameters: ['index', 'severity'] },
      { name: 'NEXT_DIAGNOSTIC', risk: ALLOWLIST.NEXT_DIAGNOSTIC.risk, parameters: ['severity'] },
      { name: 'PREVIOUS_DIAGNOSTIC', risk: ALLOWLIST.PREVIOUS_DIAGNOSTIC.risk, parameters: ['severity'] },
      { name: 'OPEN_FILE', risk: ALLOWLIST.OPEN_FILE.risk, parameters: ['path'] },
      { name: 'GO_TO_LINE', risk: ALLOWLIST.GO_TO_LINE.risk, parameters: ['line'] },
      { name: 'FOCUS_EDITOR', risk: ALLOWLIST.FOCUS_EDITOR.risk, parameters: [] },
      { name: 'RUN_TESTS', risk: ALLOWLIST.RUN_TESTS.risk, parameters: [] },
    ]);
    expect(Object.keys(ALLOWLIST)).toHaveLength(8);
  });
});
