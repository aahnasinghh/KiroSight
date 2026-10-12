import { describe, expect, it } from 'vitest';

import type { Action } from '../../src/actions/actionTypes';
import type { ActionResult } from '../../src/actions/actionResult';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import {
  formatActionResult,
  formatConfirmation,
  formatConfirmationReprompt,
  formatTestResult,
} from '../../src/response/responseFormatter';

describe('formatActionResult', () => {
  it('formats file_opened with the workspace-relative path only', () => {
    const result: ActionResult = {
      actionType: 'OPEN_FILE', status: 'ok', message: 'Opened src/auth.ts.',
      details: { kind: 'file_opened', relativePath: 'src/auth.ts' },
    };
    expect(formatActionResult(result)).toBe('Opened src/auth.ts.');
    expect(formatActionResult(result)).not.toContain('C:/');
  });

  it('keeps absolute paths out of all display details', () => {
    const result: ActionResult = {
      actionType: 'OPEN_FILE', status: 'ok', message: 'ignored',
      details: { kind: 'file_opened', relativePath: 'C:/workspace/src/auth.ts' },
    };
    expect(formatActionResult(result)).not.toContain('C:/workspace');
  });

  it('formats diagnostic path, line, severity, and message', () => {
    const result: ActionResult = {
      actionType: 'GO_TO_DIAGNOSTIC', status: 'ok', message: 'ignored',
      details: {
        kind: 'diagnostic_reached', relativePath: 'src/auth.ts', line: 42,
        severity: 'error', message: 'Token is invalid',
      },
    };
    const text = formatActionResult(result);
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('line 42');
    expect(text).toContain('error');
    expect(text).toContain('Token is invalid');
    expect(text).not.toContain('Wrapped');
  });

  it('explicitly reports wrapped diagnostic navigation', () => {
    const result: ActionResult = {
      actionType: 'NEXT_DIAGNOSTIC', status: 'ok', message: 'ignored',
      details: {
        kind: 'diagnostic_reached', relativePath: 'src/auth.ts', line: 3,
        severity: 'warning', message: 'Unused value', wrapped: true,
      },
    };
    expect(formatActionResult(result)).toContain('Wrapped to');
  });

  it('formats a reached location with path and line', () => {
    const result: ActionResult = {
      actionType: 'GO_TO_LINE', status: 'ok', message: 'ignored',
      details: { kind: 'location_reached', relativePath: 'src/main.ts', line: 42 },
    };
    expect(formatActionResult(result)).toBe('Moved to src/main.ts, line 42.');
  });

  it('formats NO_ACTION truthfully', () => {
    expect(formatActionResult({
      actionType: 'NO_ACTION', status: 'ok', message: 'No action was taken.',
    })).toBe('No action was taken.');
  });

  it('preserves specific failed reasons', () => {
    expect(formatActionResult({
      actionType: 'GO_TO_LINE', status: 'failed', message: 'The requested location could not be found',
    })).toBe('The requested location could not be found');
    expect(formatActionResult({
      actionType: 'GO_TO_DIAGNOSTIC', status: 'failed', message: 'No matching diagnostic was found',
    })).toBe('No matching diagnostic was found');
  });

  it('formats the RUN_TESTS placeholder message exactly', () => {
    expect(formatActionResult({
      actionType: 'RUN_TESTS', status: 'failed', message: 'test running is not available yet',
    })).toBe('test running is not available yet');
  });

  it('formats ambiguity with candidates and total count when truncated', () => {
    const text = formatActionResult({
      actionType: 'OPEN_FILE', status: 'needs_clarification', message: 'ignored',
      details: {
        kind: 'ambiguous_files', matches: ['src/auth.ts', 'test/auth.ts'], totalMatches: 15,
      },
    });
    expect(text).toContain('ambiguous');
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('test/auth.ts');
    expect(text).toContain('15 matches in total');
  });

  it('does not invent a candidate when ambiguity is not truncated', () => {
    const text = formatActionResult({
      actionType: 'OPEN_FILE', status: 'needs_clarification', message: 'ignored',
      details: { kind: 'ambiguous_files', matches: ['a.ts', 'b.ts'], totalMatches: 2 },
    });
    expect(text).toContain('a.ts');
    expect(text).toContain('b.ts');
    expect(text).not.toContain('3 matches');
  });

  it('formats declined as non-success with its reason', () => {
    const text = formatActionResult({
      actionType: 'RUN_TESTS', status: 'declined', message: 'you declined the action',
    });
    expect(text).toContain('declined');
    expect(text).toContain('you declined the action');
    expect(text).not.toMatch(/^Opened|^Moved|^Focused/);
  });

  it('formats not_permitted with the supplied reason', () => {
    expect(formatActionResult({
      actionType: 'OPEN_FILE', status: 'not_permitted', message: 'Action is not allow-listed',
    })).toBe('Action not permitted: Action is not allow-listed');
  });

  it('formats not_configured with the supplied reason', () => {
    expect(formatActionResult({
      actionType: 'RUN_TESTS', status: 'not_configured', message: 'Test command is not configured',
    })).toBe('Action is not configured: Test command is not configured');
  });

  it('uses the message fallback when structured details are absent', () => {
    const result: ActionResult = {
      actionType: 'FOCUS_EDITOR', status: 'ok', message: 'Focused the editor.',
    };
    expect(formatActionResult(result)).toBe('Focused the editor.');
  });

  it('does not mutate the ActionResult', () => {
    const result: ActionResult = {
      actionType: 'OPEN_FILE', status: 'needs_clarification', message: 'ignored',
      details: { kind: 'ambiguous_files', matches: ['a.ts', 'b.ts'], totalMatches: 2 },
    };
    const before = JSON.stringify(result);
    formatActionResult(result);
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe('confirmation formatting', () => {
  const action: Action = { type: 'RUN_TESTS' };
  const target = 'npm.cmd test -- --runInBand';
  const acceptedReplies = ['confirm', 'decline', 'cancel', 'repeat'];

  it('includes the human-readable action, exact target and every accepted reply', () => {
    const text = formatConfirmation(action, target);

    expect(text).toContain('Run tests');
    expect(text).toContain(target);
    for (const reply of acceptedReplies) {
      expect(text).toContain(reply);
    }
    expect(text).not.toBe('');
  });

  it('preserves target text exactly without shortening or rewriting it', () => {
    const exactTarget = 'npm.cmd test -- --reporter=dot && echo KEEP_THIS_TARGET';

    expect(formatConfirmation(action, exactTarget)).toContain(exactTarget);
  });

  it('formats a concise re-prompt with the pending action and every accepted reply', () => {
    const text = formatConfirmationReprompt(action);

    expect(text).toContain('Run tests');
    for (const reply of acceptedReplies) {
      expect(text).toContain(reply);
    }
    expect(text.trim().split(/\s+/)).toHaveLength(12);
    expect(text.trim().split(/\\s+/).length).toBeLessThanOrEqual(30);
  });

  it('supports deterministic human-readable labels for other actions', () => {
    expect(formatConfirmation({ type: 'OPEN_FILE', path: 'src/auth.ts' }, 'src/auth.ts'))
      .toContain('Open file');
    expect(formatConfirmationReprompt({ type: 'GO_TO_LINE', line: 42 }))
      .toContain('Go to line');
  });

  it('is deterministic and does not mutate the action', () => {
    const before = JSON.stringify(action);

    expect(formatConfirmation(action, target)).toBe(formatConfirmation(action, target));
    expect(formatConfirmationReprompt(action)).toBe(formatConfirmationReprompt(action));
    expect(JSON.stringify(action)).toBe(before);
  });
});

describe('formatTestResult', () => {
  const base = (overrides: Partial<TestRunSummary> = {}): TestRunSummary => ({
    outcome: 'passed', command: 'npm.cmd test', exitCode: 0, passed: 10, failed: 0,
    totalFailedNames: 0, failingTests: [], outputTruncated: false, durationMs: 100,
    ...overrides,
  });

  it('formats parsed passing counts without inventing null counts', () => {
    expect(formatTestResult(base())).toBe('10 passed, 0 failed');
    expect(formatTestResult(base({ passed: 10, failed: null }))).toBe('10 passed');
    expect(formatTestResult(base({ passed: null, failed: null }))).toBe('Tests passed.');
    expect(formatTestResult(base({ passed: null, failed: null }))).not.toMatch(/null|undefined|NaN/);
  });

  it('formats parsed failures with pass/fail counts and one failing name', () => {
    const text = formatTestResult(base({
      outcome: 'failed', passed: 8, failed: 2, totalFailedNames: 2,
      failingTests: [{ name: 'Auth rejects expired tokens' }], exitCode: 1,
    }));

    expect(text).toContain('Tests failed');
    expect(text).toContain('8 passed, 2 failed');
    expect(text).toContain('Auth rejects expired tokens');
  });

  it('shows exactly five names when five are stored', () => {
    const names = Array.from({ length: 5 }, (_, index) => ({ name: `test-${index + 1}` }));

    const text = formatTestResult(base({ outcome: 'failed', passed: 5, failed: 5, totalFailedNames: 5, failingTests: names }));

    for (const { name } of names) expect(text).toContain(name);
    expect(text).not.toContain('full stored failure list');
  });

  it('shows only the first five names and points to the full list and output when more fail', () => {
    const names = Array.from({ length: 20 }, (_, index) => ({ name: `failure-${index + 1}` }));

    const text = formatTestResult(base({ outcome: 'failed', passed: 0, failed: 37, totalFailedNames: 37, failingTests: names }));

    expect(text).toContain('37 failed');
    for (let index = 1; index <= 5; index += 1) expect(text).toContain(`failure-${index}`);
    for (let index = 6; index <= 20; index += 1) expect(text).not.toContain(`failure-${index}`);
    expect(text).toContain('list all failures');
    expect(text).toContain('full stored failure list');
    expect(text).toContain('KiroSight Tests');
  });

  it('keeps the true failed total when fewer names were extracted', () => {
    const text = formatTestResult(base({
      outcome: 'failed', passed: 10, failed: 37, totalFailedNames: 37,
      failingTests: [{ name: 'only-known-failure' }],
    }));

    expect(text).toContain('37 failed');
    expect(text).toContain('only-known-failure');
    expect(text).not.toContain('Unknown');
    expect(text).not.toContain('Failure 2');
    expect(text).toContain('full stored failure list');
  });

  it('reports a failed count even when no names are available', () => {
    const text = formatTestResult(base({ outcome: 'failed', passed: 10, failed: 3, totalFailedNames: 3 }));

    expect(text).toContain('3 failed');
    expect(text).toContain('No failing test names were available');
    expect(text).not.toContain('Unknown test');
  });

  it('uses distinct truthful messages for non-standard outcomes', () => {
    const outcomes = {
      did_not_execute: formatTestResult(base({ outcome: 'did_not_execute', exitCode: 1 })),
      timed_out: formatTestResult(base({ outcome: 'timed_out', exitCode: null })),
      cancelled: formatTestResult(base({ outcome: 'cancelled', exitCode: null })),
      completed_unparsed: formatTestResult(base({ outcome: 'completed_unparsed', exitCode: 2, passed: null, failed: null })),
      not_configured: formatTestResult(base({ outcome: 'not_configured', exitCode: null })),
      failed: formatTestResult(base({ outcome: 'failed', passed: 1, failed: 1, exitCode: 1 })),
    };

    expect(new Set(Object.values(outcomes)).size).toBe(Object.keys(outcomes).length);
    expect(outcomes.did_not_execute).toContain('could not be executed');
    expect(outcomes.timed_out).toContain('timed out');
    expect(outcomes.cancelled).toContain('cancelled');
    expect(outcomes.failed).toContain('Tests failed');
  });

  it('formats completed_unparsed with and without an exit code', () => {
    expect(formatTestResult(base({ outcome: 'completed_unparsed', exitCode: 2, passed: null, failed: null })))
      .toContain('Exit code: 2');
    expect(formatTestResult(base({ outcome: 'completed_unparsed', exitCode: null, passed: null, failed: null })))
      .not.toContain('Exit code:');
    expect(formatTestResult(base({ outcome: 'completed_unparsed', exitCode: 2, passed: null, failed: null })))
      .not.toMatch(/\b\d+ passed|\b\d+ failed/);
  });

  it('explains how to configure a missing test command', () => {
    const text = formatTestResult(base({ outcome: 'not_configured', exitCode: null }));

    expect(text).toContain('configured');
    expect(text).toContain('kirosight.testCommand');
    expect(text).not.toMatch(/npm|pytest|vitest|mocha/);
  });

  it('discloses truncated output without echoing command, raw output or excerpts', () => {
    const text = formatTestResult(base({
      outcome: 'failed', passed: 1, failed: 1, outputTruncated: true,
      command: 'secret internal command',
      failingTests: [{ name: 'broken test', messageExcerpt: 'stack trace and raw output' }],
    }));

    expect(text).toContain('output was truncated');
    expect(text).not.toContain('secret internal command');
    expect(text).not.toContain('stack trace');
    expect(text).not.toContain('raw output');
  });

  it('is deterministic and does not mutate the summary or failure list', () => {
    const summary = base({
      outcome: 'failed', passed: 2, failed: 7, totalFailedNames: 7,
      failingTests: Array.from({ length: 7 }, (_, index) => ({ name: `failure-${index}` })),
    });
    const before = JSON.stringify(summary);
    const first = formatTestResult(summary);
    const second = formatTestResult(summary);

    expect(second).toBe(first);
    expect(JSON.stringify(summary)).toBe(before);
    expect(summary.failingTests.map(({ name }) => name)).toEqual(
      Array.from({ length: 7 }, (_, index) => `failure-${index}`),
    );
  });
});
