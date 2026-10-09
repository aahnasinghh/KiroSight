import { describe, expect, it } from 'vitest';

import type { ActionResult } from '../../src/actions/actionResult';
import { formatActionResult } from '../../src/response/responseFormatter';

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
