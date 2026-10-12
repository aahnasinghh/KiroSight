import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  MAX_EXCERPT_CHARS,
  MAX_FAILING_TESTS,
  parseTestOutput,
  stripAnsi,
  type TestOutputInput,
} from '../../src/testing/testOutputParser';

const ESC = '\u001b';
const color = (code: number, text: string) => `${ESC}[${code}m${text}${ESC}[0m`;

function parse(output: string, exitCode: number | null = 1) {
  return parseTestOutput({
    output, exitCode, command: 'npm.cmd test', outputTruncated: false, durationMs: 1234,
  });
}

describe('stripAnsi', () => {
  it('removes colour, cursor and OSC sequences and normalizes line endings', () => {
    const text = `${color(31, 'red')}${ESC}[2K${ESC}[1A\r\n${ESC}]0;title\u0007ok\rnext`;

    expect(stripAnsi(text)).toBe('red\nok\nnext');
  });
});

describe('Jest', () => {
  const failing = [
    'FAIL src/auth.test.ts',
    '  ● Auth › rejects expired tokens',
    '',
    '    expect(received).toBe(expected)',
    '    Expected: true',
    '',
    '  ● Auth › rejects empty tokens',
    '',
    '    Expected: false',
    '',
    'Summary of all failing tests',
    '  ● Auth › rejects expired tokens',
    '    expect(received).toBe(expected)',
    '',
    'Test Suites: 1 failed, 1 total',
    'Tests:       2 failed, 8 passed, 10 total',
    'Time:        1.2 s',
  ].join('\n');

  it('parses a mixed summary with true counts and deduplicated names', () => {
    const summary = parse(failing);

    expect(summary).toMatchObject({
      outcome: 'failed', exitCode: 1, passed: 8, failed: 2, totalFailedNames: 2,
      command: 'npm.cmd test', outputTruncated: false, durationMs: 1234,
    });
    expect(summary.failingTests.map((t) => t.name)).toEqual([
      'Auth › rejects expired tokens', 'Auth › rejects empty tokens',
    ]);
    expect(summary.failingTests[0]!.messageExcerpt).toContain('Expected: true');
  });

  it('parses an all-passing summary', () => {
    expect(parse('Tests:       12 passed, 12 total', 0)).toMatchObject({
      outcome: 'passed', passed: 12, failed: 0, totalFailedNames: 0, failingTests: [],
    });
  });

  it('derives zero passed for an all-failing summary only from the total', () => {
    expect(parse('Tests:       3 failed, 3 total')).toMatchObject({ passed: 0, failed: 3 });
  });

  it('counts skipped and todo tests as neither passed nor failed', () => {
    expect(parse('Tests:       1 failed, 1 skipped, 1 todo, 5 passed, 8 total')).toMatchObject({
      passed: 5, failed: 1,
    });
  });

  it('parses an ANSI-coloured summary and keeps names clean', () => {
    const output = failing
      .replace('  ● Auth › rejects expired tokens', `  ${color(31, '● Auth › rejects expired tokens')}`)
      .replace('Tests:       2 failed, 8 passed, 10 total',
        `${color(1, 'Tests:')}       ${color(31, '2 failed')}, ${color(32, '8 passed')}, 10 total`);
    const summary = parse(output);

    expect(summary).toMatchObject({ passed: 8, failed: 2 });
    expect(JSON.stringify(summary)).not.toContain(ESC);
  });

  it('does not invent counts from a malformed near-match', () => {
    for (const output of ['Tests: many failed', 'Tests: 2 failed, 8 passed', 'Tests 2 failed, 10 total']) {
      expect(parse(output)).toMatchObject({ outcome: 'completed_unparsed', passed: null, failed: null });
    }
  });
});

describe('Vitest', () => {
  const output = [
    ' FAIL  src/math.test.ts > math > adds numbers',
    'AssertionError: expected 2 to be 3',
    ' ❯ src/math.test.ts:4:5',
    '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
    ' FAIL  src/math.test.ts > math > adds numbers',
    'AssertionError: expected 2 to be 3',
    '',
    ' Test Files  1 failed | 1 passed (2)',
    '      Tests  2 failed | 8 passed (10)',
  ].join('\n');

  it('parses the Tests line, not Test Files, with deduplicated names', () => {
    const summary = parse(output);

    expect(summary).toMatchObject({ outcome: 'failed', passed: 8, failed: 2, totalFailedNames: 2 });
    expect(summary.failingTests).toEqual([
      { name: 'src/math.test.ts > math > adds numbers', messageExcerpt: 'AssertionError: expected 2 to be 3 ❯ src/math.test.ts:4:5' },
    ]);
  });

  it('parses all-passing and all-failing summaries', () => {
    expect(parse(' Test Files  1 passed (1)\n      Tests  8 passed (8)', 0)).toMatchObject({
      outcome: 'passed', passed: 8, failed: 0,
    });
    expect(parse('      Tests  4 failed (4)')).toMatchObject({ passed: 0, failed: 4 });
  });

  it('derives passed from the total when other categories are present', () => {
    expect(parse('      Tests  1 failed | 2 skipped | 7 passed (10)')).toMatchObject({ passed: 7, failed: 1 });
  });

  it('ignores a Test Files line on its own', () => {
    expect(parse(' Test Files  1 failed | 1 passed (2)')).toMatchObject({ outcome: 'completed_unparsed' });
  });

  it('handles ANSI colours', () => {
    const coloured = `      ${color(2, 'Tests')}  ${color(31, '2 failed')} | ${color(32, '8 passed')} (10)`;

    expect(parse(coloured)).toMatchObject({ passed: 8, failed: 2 });
  });

  it('does not invent counts from malformed near-matches', () => {
    for (const text of ['Tests  2 failed | 8 passed', 'Tests  lots (10)', 'Tests  2 exploded (2)']) {
      expect(parse(text)).toMatchObject({ outcome: 'completed_unparsed', passed: null });
    }
  });
});

describe('pytest', () => {
  it('parses a mixed summary and FAILED node ids with messages', () => {
    const output = [
      '=========================== short test summary info ===========================',
      'FAILED tests/test_auth.py::test_expired - AssertionError: token expired',
      'FAILED tests/test_auth.py::test_empty[a b]',
      '========== 2 failed, 8 passed, 1 warning in 0.42s ==========',
    ].join('\n');
    const summary = parse(output);

    expect(summary).toMatchObject({ outcome: 'failed', passed: 8, failed: 2, totalFailedNames: 2 });
    expect(summary.failingTests).toEqual([
      { name: 'tests/test_auth.py::test_expired', messageExcerpt: 'AssertionError: token expired' },
      { name: 'tests/test_auth.py::test_empty[a b]' },
    ]);
  });

  it('parses all-passing and all-failing summaries, with and without equals signs', () => {
    expect(parse('10 passed in 0.31s', 0)).toMatchObject({ outcome: 'passed', passed: 10, failed: 0 });
    expect(parse('1 failed in 0.20s')).toMatchObject({ passed: 0, failed: 1 });
    expect(parse('=== 3 passed in 1.00s (0:00:01) ===', 0)).toMatchObject({ passed: 3 });
  });

  it('does not treat skips, warnings or errors as passed tests', () => {
    expect(parse('1 passed, 4 skipped, 2 warnings in 0.1s', 0)).toMatchObject({ passed: 1, failed: 0 });
    for (const text of ['4 skipped in 0.1s', '1 error in 0.2s', '2 warnings in 0.1s', 'no tests ran in 0.01s']) {
      expect(parse(text, 5)).toMatchObject({ outcome: 'completed_unparsed', passed: null, failed: null });
    }
  });

  it('handles ANSI colours', () => {
    const coloured = `${color(31, '=== 1 failed')}, ${color(32, '2 passed')} in 0.1s ===`;

    expect(parse(coloured)).toMatchObject({ passed: 2, failed: 1 });
  });

  it('does not invent counts from malformed near-matches', () => {
    for (const text of ['2 failed, 8 passed', 'many failed in 0.1s', '2 exploded in 0.1s']) {
      expect(parse(text)).toMatchObject({ outcome: 'completed_unparsed' });
    }
  });
});

describe('Mocha', () => {
  const output = [
    '  8 passing (12ms)',
    '  2 failing',
    '',
    '  1) Auth',
    '       rejects expired tokens:',
    '     AssertionError: expected true to equal false',
    '      at Context.<anonymous> (test/auth.js:10:5)',
    '',
    '  2) rejects empty tokens:',
    '     Error: boom',
  ].join('\n');

  it('parses passing and failing counts with numbered failure names', () => {
    const summary = parse(output);

    expect(summary).toMatchObject({ outcome: 'failed', passed: 8, failed: 2, totalFailedNames: 2 });
    expect(summary.failingTests.map((t) => t.name)).toEqual([
      'Auth rejects expired tokens', 'rejects empty tokens',
    ]);
    expect(summary.failingTests[0]!.messageExcerpt).toContain('AssertionError: expected true to equal false');
    expect(summary.failingTests[1]!.messageExcerpt).toBe('Error: boom');
  });

  it('parses singular and all-passing forms', () => {
    expect(parse('  1 passing (3ms)\n  1 failing\n\n  1) it fails:\n     Error: x')).toMatchObject({
      passed: 1, failed: 1,
    });
    expect(parse('  5 passing (9ms)', 0)).toMatchObject({ outcome: 'passed', passed: 5, failed: 0 });
  });

  it('parses an all-failing run', () => {
    expect(parse('  2 failing\n\n  1) a:\n     Error: x\n\n  2) b:\n     Error: y')).toMatchObject({
      passed: 0, failed: 2,
    });
  });

  it('handles ANSI colours', () => {
    const coloured = `  ${color(32, '8 passing')} ${color(90, '(12ms)')}\n  ${color(31, '1 failing')}\n\n  1) ${color(31, 'it fails')}:\n     Error: x`;
    const summary = parse(coloured);

    expect(summary).toMatchObject({ passed: 8, failed: 1 });
    expect(summary.failingTests[0]!.name).toBe('it fails');
  });

  it('does not infer counts from prose', () => {
    for (const text of ['all tests are passing', 'I saw 3 passing cars on the road', 'passing: 4', '8 passes']) {
      expect(parse(text)).toMatchObject({ outcome: 'completed_unparsed', passed: null });
    }
  });
});

describe('parser order', () => {
  it('lets Jest win over later parsers when several summaries appear', () => {
    const output = 'Tests:       1 failed, 2 total\n  5 passing\n3 passed in 0.1s';

    expect(parse(output)).toMatchObject({ passed: 1, failed: 1 });
  });

  it('lets Vitest win over pytest and Mocha', () => {
    expect(parse('      Tests  1 failed | 2 passed (3)\n  9 passing\n4 passed in 0.1s')).toMatchObject({ passed: 2 });
  });

  it('lets pytest win over Mocha', () => {
    expect(parse('4 passed in 0.1s\n  9 passing')).toMatchObject({ passed: 4 });
  });
});

describe('bounds and safety', () => {
  function jestWithFailures(count: number, message = 'Expected: 1'): string {
    const blocks = Array.from({ length: count }, (_, i) => `  ● Suite › test ${i + 1}\n\n    ${message}\n`);
    return [...blocks, `Tests:       ${count} failed, ${count + 5} total`].join('\n');
  }

  it('keeps the true failed total while storing only the first 20 details in order', () => {
    const summary = parse(jestWithFailures(37));

    expect(summary.failed).toBe(37);
    expect(summary.totalFailedNames).toBe(37);
    expect(summary.failingTests).toHaveLength(MAX_FAILING_TESTS);
    expect(summary.failingTests[0]!.name).toBe('Suite › test 1');
    expect(summary.failingTests[19]!.name).toBe('Suite › test 20');
  });

  it('stores exactly 20 details when exactly 20 fail, and fewer when names are unavailable', () => {
    expect(parse(jestWithFailures(20)).failingTests).toHaveLength(20);
    const noNames = parse('Tests:       4 failed, 9 total');

    expect(noNames).toMatchObject({ failed: 4, totalFailedNames: 4, failingTests: [] });
  });

  it('caps every final excerpt at 300 characters', () => {
    const summary = parse(jestWithFailures(3, 'x'.repeat(5000)));

    for (const test of summary.failingTests) {
      expect(test.messageExcerpt!.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    }
    expect(summary.failingTests[0]!.messageExcerpt!.length).toBe(MAX_EXCERPT_CHARS);
  });

  it('redacts secret-like values and cannot leak a secret split by the length cap', () => {
    const awsKey = `AKIA${'B'.repeat(16)}`;
    const bearer = 'example-access-token';
    const padding = 'y'.repeat(250);
    const output = [
      '  ● Suite › leaks',
      `    ${padding} token=${bearer} ${awsKey}`,
      `Tests:       1 failed, 2 total`,
    ].join('\n');
    const stored = JSON.stringify(parse(output));

    for (const secret of [bearer, awsKey, 'AKIABBBB']) {
      expect(stored).not.toContain(secret);
    }
    const excerpt = parse(output).failingTests[0]!.messageExcerpt!;
    expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(excerpt).toContain('[REDACTED]');

    // A secret straddling the 300-character boundary is redacted before the cut, so no part leaks.
    const straddling = output.replace('y'.repeat(250), 'y'.repeat(290));
    const cut = parse(straddling).failingTests[0]!.messageExcerpt!;
    expect(cut.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(cut).not.toContain(bearer);
    expect(cut).not.toContain('example-acc');
  });

  it('puts no ANSI sequences in names or excerpts', () => {
    const output = `  ${color(31, '● Suite › red')}\n    ${color(33, 'Expected: 1')}\nTests:       1 failed, 2 total`;
    const summary = parse(output);

    expect(summary.failingTests[0]).toEqual({ name: 'Suite › red', messageExcerpt: 'Expected: 1' });
  });

  it('returns completed_unparsed with only the exit code for empty or unrelated output', () => {
    for (const output of ['', '   \n\t\n', 'Compiling...\nDone in 3s\nwarning: something']) {
      expect(parse(output, 2)).toEqual({
        outcome: 'completed_unparsed', command: 'npm.cmd test', exitCode: 2, passed: null, failed: null,
        totalFailedNames: 0, failingTests: [], outputTruncated: false, durationMs: 1234,
      });
    }
  });

  it('never turns the exit code into a test count', () => {
    for (const exitCode of [0, 1, 137, null]) {
      const summary = parse('npm ERR! something', exitCode);

      expect(summary).toMatchObject({ outcome: 'completed_unparsed', exitCode, passed: null, failed: null });
    }
  });

  it('preserves the exact exit code and echoes caller metadata', () => {
    const input: TestOutputInput = {
      output: 'Tests:       1 passed, 1 total', exitCode: 0, command: 'pytest -q', outputTruncated: true, durationMs: 7,
    };

    expect(parseTestOutput(input)).toMatchObject({
      outcome: 'passed', exitCode: 0, command: 'pytest -q', outputTruncated: true, durationMs: 7,
    });
  });

  it('does not report passed when the process failed even though no test failed', () => {
    expect(parse('Tests:       3 passed, 3 total', 1)).toMatchObject({ outcome: 'failed', passed: 3, failed: 0 });
  });

  it('is deterministic and does not mutate its input', () => {
    const input: TestOutputInput = {
      output: `${color(31, '  ● Suite › a')}\n    Expected: 1\nTests:       1 failed, 2 total`,
      exitCode: 1, command: 'npm.cmd test', outputTruncated: false, durationMs: 5,
    };
    const before = JSON.stringify(input);
    const first = parseTestOutput(input);
    const second = parseTestOutput(input);

    expect(second).toEqual(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('is pure: no vscode, process, file or timer access', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../src/testing/testOutputParser.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/from 'vscode'|child_process|node:fs|process\.env|setTimeout|setInterval|Date\.now|new Date/);
  });
});
