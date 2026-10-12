import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatTestResult } from '../../src/response/responseFormatter';
import {
  parseTestOutput,
  type FailingTest,
  type TestRunSummary,
} from '../../src/testing/testOutputParser';

const NAME_IDS = fc.uniqueArray(fc.integer({ min: 0, max: 999 }), { maxLength: 20 });
const MESSAGE_CHARS = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._:;'];
const messageArb = fc.array(fc.constantFrom(...MESSAGE_CHARS), { minLength: 301, maxLength: 700 })
  .map((characters) => characters.join(''));
const commandArb = fc.constantFrom(
  'PROPERTY_COMMAND_SENTINEL_A',
  'PROPERTY_COMMAND_SENTINEL_B',
  'npm.cmd test -- --property-sentinel',
);

function nameFor(id: number): string {
  return `property-failure-${String(id).padStart(3, '0')}`;
}

function details(ids: readonly number[], withExcerpt = true): FailingTest[] {
  return ids.map((id) => ({
    name: nameFor(id),
    ...(withExcerpt ? { messageExcerpt: `PROPERTY_EXCERPT_SENTINEL_${String(id).padStart(3, '0')}` } : {}),
  }));
}

function summary(overrides: Partial<TestRunSummary>): TestRunSummary {
  return {
    outcome: 'failed',
    command: 'PROPERTY_COMMAND_SENTINEL_A',
    exitCode: 1,
    passed: 10,
    failed: 1,
    totalFailedNames: 1,
    failingTests: [],
    outputTruncated: false,
    durationMs: 42,
    ...overrides,
  };
}

function wordsForName(text: string, name: string): boolean {
  return text.includes(name);
}

describe('Property 6: test summaries are bounded and faithful', () => {
  it('keeps generated failed formatter output faithful and bounded', () => {
    fc.assert(
      fc.property(
        fc.record({
          failed: fc.integer({ min: 0, max: 50 }),
          passed: fc.integer({ min: 0, max: 100 }),
          ids: NAME_IDS,
          outputTruncated: fc.boolean(),
          command: commandArb,
          exitCode: fc.integer({ min: 0, max: 255 }),
        }),
        ({ failed, passed, ids, outputTruncated, command, exitCode }) => {
          const retained = ids.slice(0, Math.min(ids.length, failed));
          const input = summary({
            failed,
            passed,
            totalFailedNames: failed,
            failingTests: details(retained),
            outputTruncated,
            command,
            exitCode,
          });
          const before = JSON.stringify(input);
          const text = formatTestResult(input);

          expect(text).toContain(`${failed} failed`);
          expect(text).not.toContain(command);
          expect(text).not.toContain('PROPERTY_EXCERPT_SENTINEL');
          expect(text).not.toMatch(/\b(?:null|undefined|NaN)\b/);
          for (const [index, failure] of input.failingTests.entries()) {
            if (index < 5) expect(wordsForName(text, failure.name)).toBe(true);
            else expect(wordsForName(text, failure.name)).toBe(false);
          }
          if (failed > 5) {
            expect(text).toContain('list all failures');
            expect(text).toContain('KiroSight Tests');
          }
          if (outputTruncated) expect(text).toContain('output was truncated');
          expect(formatTestResult(input)).toBe(text);
          expect(JSON.stringify(input)).toBe(before);
          expect(input.failingTests.map(({ name }) => name)).toEqual(retained.map(nameFor));
        },
      ),
      { numRuns: 100 },
    );
  });

  it('preserves sparse and zero-name failed totals without fabricating names', () => {
    fc.assert(
      fc.property(
        fc.record({
          failed: fc.integer({ min: 1, max: 50 }),
          passed: fc.integer({ min: 0, max: 100 }),
          ids: NAME_IDS,
        }),
        ({ failed, passed, ids }) => {
          const retained = ids.slice(0, Math.min(ids.length, failed));
          const text = formatTestResult(summary({
            failed, passed, totalFailedNames: failed, failingTests: details(retained, false),
          }));

          expect(text).toContain(`${failed} failed`);
          expect(text).not.toMatch(/Unknown test|Unnamed test|Failure \d+/);
          if (failed > 5) {
            expect(text).toContain('list all failures');
            expect(text).toContain('KiroSight Tests');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not invent counts or names for completed_unparsed summaries', () => {
    fc.assert(
      fc.property(
        fc.option(fc.integer({ min: 0, max: 255 }), { nil: null }),
        fc.boolean(),
        (exitCode, outputTruncated) => {
          const input = summary({
            outcome: 'completed_unparsed', passed: null, failed: null, totalFailedNames: 0,
            failingTests: [], exitCode, outputTruncated,
          });
          const text = formatTestResult(input);

          expect(text).not.toMatch(/\b\d+ passed|\b\d+ failed|Unknown test|PROPERTY_/);
          expect(text).toContain('KiroSight Tests');
          if (exitCode === null) expect(text).not.toContain('Exit code:');
          else expect(text).toContain(`Exit code: ${exitCode}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('does not invent counts or failure names for nonstandard outcomes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('did_not_execute', 'timed_out', 'cancelled', 'not_configured' as const),
        (outcome) => {
          const text = formatTestResult(summary({
            outcome, passed: null, failed: null, totalFailedNames: 0, failingTests: [], exitCode: null,
          }));

          expect(text).not.toMatch(/\b\d+ passed|\b\d+ failed|Unknown test|PROPERTY_/);
          if (outcome === 'not_configured') expect(text).toContain('kirosight.testCommand');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('parses generated recognized Jest output faithfully and preserves the 20-detail cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        messageArb,
        (failed, message) => {
          const passed = 7;
          const blocks = Array.from({ length: failed }, (_, index) => [
            `  ● Generated suite › ${nameFor(index)}`,
            '',
            `    ${message}`,
          ].join('\n'));
          const output = [
            ...blocks,
            `Tests:       ${failed} failed, ${passed} passed, ${failed + passed} total`,
          ].join('\n');
          const parsed = parseTestOutput({
            output,
            exitCode: failed === 0 ? 0 : 1,
            command: 'PROPERTY_COMMAND_SENTINEL_A',
            outputTruncated: false,
            durationMs: 10,
          });

          expect(parsed.failed).toBe(failed);
          expect(parsed.passed).toBe(passed);
          expect(parsed.totalFailedNames).toBe(failed);
          expect(parsed.failingTests.length).toBe(Math.min(failed, 20));
          expect(parsed.failingTests.map(({ name }) => name)).toEqual(
            Array.from({ length: Math.min(failed, 20) }, (_, index) => `Generated suite › ${nameFor(index)}`),
          );
          for (const failure of parsed.failingTests) {
            expect(failure.messageExcerpt?.length ?? 0).toBeLessThanOrEqual(300);
          }

          const formatted = formatTestResult(parsed);
          if (failed > 0) expect(formatted).toContain(`${failed} failed`);
          expect(formatted).not.toContain(message);
          expect(formatted).not.toContain('PROPERTY_COMMAND_SENTINEL_A');
          for (let index = 0; index < Math.min(failed, 5); index += 1) {
            expect(formatted).toContain(`Generated suite › ${nameFor(index)}`);
          }
          for (let index = 5; index < Math.min(failed, 20); index += 1) {
            expect(formatted).not.toContain(`Generated suite › ${nameFor(index)}`);
          }
          if (failed > 5) {
            expect(formatted).toContain('list all failures');
            expect(formatted).toContain('KiroSight Tests');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('keeps parser and formatter deterministic and does not mutate parser input', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), messageArb, (failed, message) => {
        const output = Array.from({ length: failed }, (_, index) =>
          `  ● Suite › ${nameFor(index)}\n    ${message}`,
        ).concat(`Tests:       ${failed} failed, 2 passed, ${failed + 2} total`).join('\n');
        const input = {
          output, exitCode: 1, command: 'PROPERTY_COMMAND_SENTINEL_B', outputTruncated: false, durationMs: 1,
        } as const;
        const inputBefore = JSON.stringify(input);
        const first = parseTestOutput(input);
        const second = parseTestOutput(input);

        expect(second).toEqual(first);
        expect(JSON.stringify(input)).toBe(inputBefore);
        expect(formatTestResult(first)).toBe(formatTestResult(second));
      }),
      { numRuns: 100 },
    );
  });
});
