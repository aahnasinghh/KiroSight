import { EventEmitter } from 'node:events';

import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import { TestRunner, type TestProcess, type TestRunSummary, type SpawnOptions } from '../../src/testing/testRunner';
import { resetVscodeMock, setMockConfiguration, setMockWorkspace } from '../mocks/vscode';

class PropertyChild extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public constructor(public readonly pid = 7000) { super(); }
  public close(code = 0): void { this.emit('exit', code, null); this.emit('close', code, null); }
}

const commandCharacters = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._/-\\:()[]{}$%^&|;=\'"'];
const commandCoreArb = fc.array(fc.constantFrom(...commandCharacters), { minLength: 1, maxLength: 100 })
  .map((chars) => chars.join(''))
  .filter((value) => /\S/.test(value));
const trustedCommandArb = fc.record({
  leading: fc.constantFrom('', ' ', '  ', '\t', '\n'),
  core: commandCoreArb,
  trailing: fc.constantFrom('', ' ', '  ', '\r', '\n'),
}).map(({ leading, core, trailing }) => `${leading}${core}${trailing}`)
  .filter((value) => value.trim().length > 0);
const whitespaceCommandArb = fc.array(fc.constantFrom(' ', '\t', '\r', '\n'), { minLength: 1, maxLength: 40 })
  .map((chars) => chars.join(''));
const externalTextArb = fc.string({ minLength: 1, maxLength: 80 }).filter((value) => /\S/.test(value));

interface PropertyHarness {
  runner: TestRunner;
  children: PropertyChild[];
  calls: Array<{ command: string; options: SpawnOptions }>;
}

function createHarness(): PropertyHarness {
  const children: PropertyChild[] = [];
  const calls: Array<{ command: string; options: SpawnOptions }> = [];
  const runner = new TestRunner({
    spawner: (command, options) => {
      calls.push({ command, options });
      const child = new PropertyChild(7000 + children.length);
      children.push(child);
      return child as unknown as TestProcess;
    },
    now: () => 100,
    scheduler: { set: () => ({}) as object, clear: () => undefined },
    createOutputChannel: () => ({ append: () => undefined, dispose: () => undefined }),
    parse: (input) => ({
      outcome: 'completed_unparsed', command: input.command, exitCode: input.exitCode,
      passed: null, failed: null, totalFailedNames: 0, failingTests: [],
      outputTruncated: input.outputTruncated, durationMs: input.durationMs,
    }),
  });
  return { runner, children, calls };
}

function configure(command: string): void {
  setMockWorkspace(['/property/workspace']);
  setMockConfiguration({ 'kirosight.testCommand': command, 'kirosight.testTimeoutSeconds': 300 });
}

function finish(harness: PropertyHarness, index = 0): void {
  harness.children[index]!.close(0);
}

beforeEach(() => {
  resetVscodeMock();
});

describe('Property 5: test command comes only from trusted configuration', () => {
  it('passes every non-empty configured command exactly after outer trimming', async () => {
    await fc.assert(
      fc.asyncProperty(trustedCommandArb, async (rawConfigured) => {
        configure(rawConfigured);
        const harness = createHarness();
        const pending = harness.runner.run();

        expect(harness.calls).toHaveLength(1);
        expect(harness.calls[0]!.command).toBe(rawConfigured.trim());
        expect(harness.calls[0]!.options).toEqual({
          shell: true, cwd: '/property/workspace', windowsHide: true,
        });
        finish(harness);
        await pending;
      }),
      { numRuns: 100 },
    );
  });

  it('does not spawn for any whitespace-only configuration', async () => {
    await fc.assert(
      fc.asyncProperty(whitespaceCommandArb, async (rawConfigured) => {
        configure(rawConfigured);
        const harness = createHarness();

        const result = await harness.runner.run();

        expect(result.outcome).toBe('not_configured');
        expect(harness.calls).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('ignores arbitrary runtime arguments and untrusted external text', async () => {
    await fc.assert(
      fc.asyncProperty(trustedCommandArb, externalTextArb, externalTextArb, externalTextArb,
        async (rawConfigured, untrustedA, untrustedB, untrustedC) => {
          fc.pre(rawConfigured.trim() !== untrustedA && rawConfigured.trim() !== untrustedB && rawConfigured.trim() !== untrustedC);
          configure(rawConfigured);
          const harness = createHarness();
          const run = (harness.runner.run as (...args: unknown[]) => Promise<TestRunSummary>);
          const pending = run.call(harness.runner, untrustedA, { command: untrustedB }, ['--args', untrustedC]);

          expect(harness.calls).toHaveLength(1);
          expect(harness.calls[0]!.command).toBe(rawConfigured.trim());
          finish(harness);
          await pending;
        }),
      { numRuns: 100 },
    );
  });

  it('reads fresh configuration for later runs but captures each active command once', async () => {
    await fc.assert(
      fc.asyncProperty(trustedCommandArb, trustedCommandArb, async (rawA, rawB) => {
        fc.pre(rawA.trim() !== rawB.trim());
        configure(rawA);
        const harness = createHarness();
        const first = harness.runner.run();
        setMockConfiguration({ 'kirosight.testCommand': rawB, 'kirosight.testTimeoutSeconds': 300 });
        const overlapping = harness.runner.run();

        expect(overlapping).toBe(first);
        expect(harness.calls).toHaveLength(1);
        expect(harness.calls[0]!.command).toBe(rawA.trim());
        finish(harness, 0);
        await Promise.all([first, overlapping]);

        const later = harness.runner.run();
        expect(harness.calls).toHaveLength(2);
        expect(harness.calls[1]!.command).toBe(rawB.trim());
        finish(harness, 1);
        await later;
      }),
      { numRuns: 100 },
    );
  });

  it('never invents a fallback command when configuration is empty', async () => {
    await fc.assert(
      fc.asyncProperty(whitespaceCommandArb, externalTextArb, async (rawConfigured, external) => {
        configure(rawConfigured);
        const harness = createHarness();
        const result = await (harness.runner.run as (...args: unknown[]) => Promise<TestRunSummary>)
          .call(harness.runner, external);

        expect(result.outcome).toBe('not_configured');
        expect(harness.calls).toHaveLength(0);
        expect(result.command).toBe('');
      }),
      { numRuns: 100 },
    );
  });

  it('has a zero-parameter public run method', () => {
    expect(TestRunner.prototype.run.length).toBe(0);
  });
});
