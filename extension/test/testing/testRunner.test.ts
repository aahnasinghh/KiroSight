import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BoundedOutput,
  PARSE_BUFFER_MAX_BYTES,
  TEST_OUTPUT_CHANNEL_NAME,
  TestRunner,
  createProcessTreeKiller,
  isShellMissingCommand,
  type TestProcess,
} from '../../src/testing/testRunner';
import { parseTestOutput, type TestOutputInput } from '../../src/testing/testOutputParser';
import {
  resetVscodeMock,
  setMockConfiguration,
  setMockWorkspace,
  vscodeMockState,
} from '../mocks/vscode';

class FakeProcess extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public constructor(public readonly pid: number | undefined) {
    super();
  }

  public out(text: string | Buffer): void { this.stdout.emit('data', text); }
  public err(text: string | Buffer): void { this.stderr.emit('data', text); }
  public exit(code: number | null): void { this.emit('exit', code, null); }
  public close(code: number | null): void { this.emit('close', code, null); }
  public finish(code: number | null): void { this.exit(code); this.close(code); }
}

interface Harness {
  runner: TestRunner;
  processes: FakeProcess[];
  spawnCalls: Array<{ command: string; options: unknown }>;
  kills: number[];
  parseInputs: TestOutputInput[];
  timers: Array<{ callback: () => void; ms: number; cleared: boolean }>;
  clock: { now: number };
  channel(): { text: string } | undefined;
}

const FAILING_JEST = 'Tests:       1 failed, 2 passed, 3 total';

function harness(options: { command?: string; timeoutSeconds?: unknown; pid?: number | undefined } = {}): Harness {
  resetVscodeMock();
  setMockWorkspace(['/ws/first', '/ws/second']);
  const configuration: Record<string, unknown> = {
    'kirosight.testCommand': options.command ?? 'npm.cmd test',
  };
  if ('timeoutSeconds' in options) configuration['kirosight.testTimeoutSeconds'] = options.timeoutSeconds;
  else configuration['kirosight.testTimeoutSeconds'] = 5;
  setMockConfiguration(configuration);

  const processes: FakeProcess[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const kills: number[] = [];
  const parseInputs: TestOutputInput[] = [];
  const timers: Harness['timers'] = [];
  const clock = { now: 1000 };
  let nextPid = 4000;
  const runner = new TestRunner({
    spawner: (command, spawnOptions) => {
      spawnCalls.push({ command, options: spawnOptions });
      const pid = 'pid' in options ? options.pid : nextPid++;
      const child = new FakeProcess(pid);
      processes.push(child);
      return child as unknown as TestProcess;
    },
    killTree: (pid) => { kills.push(pid); },
    now: () => clock.now,
    scheduler: {
      set: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clear: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    },
    parse: (input) => { parseInputs.push(input); return parseTestOutput(input); },
  });
  return {
    runner, processes, spawnCalls, kills, parseInputs, timers, clock,
    channel: () => vscodeMockState.outputChannels.find((c) => c.name === TEST_OUTPUT_CHANNEL_NAME),
  };
}

describe('TestRunner trusted configuration', () => {
  it('returns not_configured without spawning when the setting is empty or blank', async () => {
    for (const command of ['', '   ', '\t']) {
      const h = harness({ command });

      const summary = await h.runner.run();

      expect(summary).toEqual({
        outcome: 'not_configured', command: '', exitCode: null, passed: null, failed: null,
        totalFailedNames: 0, failingTests: [], outputTruncated: false, durationMs: 0,
      });
      expect(h.spawnCalls).toHaveLength(0);
    }
  });

  it('spawns exactly the trimmed configured command with the approved options', async () => {
    const h = harness({ command: '  npm.cmd test -- --runInBand  ' });

    const pending = h.runner.run();

    expect(h.spawnCalls).toEqual([{
      command: 'npm.cmd test -- --runInBand',
      options: { shell: true, cwd: '/ws/first', windowsHide: true },
    }]);
    h.processes[0]!.finish(0);
    await pending;
  });

  it('accepts no command argument and ignores any extra runtime argument', async () => {
    const h = harness({ command: 'configured-command' });

    expect(TestRunner.prototype.run.length).toBe(0);
    const pending = (h.runner.run as (injected?: string) => Promise<unknown>).call(h.runner, 'evil && rm -rf /');

    expect(h.spawnCalls.map((call) => call.command)).toEqual(['configured-command']);
    h.processes[0]!.finish(0);
    await pending;
  });

  it('uses the first workspace folder and fails closed with no workspace', async () => {
    const h = harness();
    const pending = h.runner.run();
    expect((h.spawnCalls[0]!.options as { cwd: string }).cwd).toBe('/ws/first');
    h.processes[0]!.finish(0);
    await pending;

    setMockWorkspace(undefined);
    setMockConfiguration({ 'kirosight.testCommand': 'npm.cmd test' });
    const summary = await h.runner.run();

    expect(h.spawnCalls).toHaveLength(1);
    expect(summary).toMatchObject({
      outcome: 'did_not_execute', command: 'npm.cmd test', passed: null, failed: null, failingTests: [],
    });
  });

  it('reads the timeout setting in seconds with a 300 second fallback', async () => {
    const cases: Array<[unknown, number]> = [[5, 5000], [undefined, 300000], [0, 300000], ['x', 300000], [1.5, 1500]];
    for (const [setting, expectedMs] of cases) {
      const h = harness({ timeoutSeconds: setting });
      const pending = h.runner.run();
      expect(h.timers[0]!.ms).toBe(expectedMs);
      h.processes[0]!.finish(0);
      await pending;
    }
  });

  it('never creates a Test Explorer controller', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../src/testing/testRunner.ts'), 'utf8');

    expect(source).not.toMatch(/createTestController|vscode\.tests/);
  });
});

describe('TestRunner output', () => {
  it('merges stdout and stderr in arrival order and parses only after close', async () => {
    const h = harness();
    const pending = h.runner.run();
    const child = h.processes[0]!;

    child.out('A\n');
    child.err('B\n');
    child.out('C\n');
    child.exit(1);
    expect(h.parseInputs).toHaveLength(0);
    child.out(`${FAILING_JEST}\n`);
    child.close(1);
    const summary = await pending;

    expect(h.parseInputs).toHaveLength(1);
    expect(h.parseInputs[0]!.output).toBe(`A\nB\nC\n${FAILING_JEST}\n`);
    expect(h.parseInputs[0]!.exitCode).toBe(1);
    expect(summary).toMatchObject({ outcome: 'failed', passed: 2, failed: 1 });
  });

  it('does not settle on exit alone and settles exactly once on close', async () => {
    const h = harness();
    let settled = 0;
    const pending = h.runner.run().then((summary) => { settled += 1; return summary; });
    const child = h.processes[0]!;

    child.exit(0);
    await Promise.resolve();
    expect(settled).toBe(0);
    child.close(0);
    child.close(0);
    child.exit(0);
    await pending;

    expect(settled).toBe(1);
    expect(h.parseInputs).toHaveLength(1);
  });

  it('writes stdout and stderr to the KiroSight Tests channel with append, faithfully', async () => {
    const h = harness();
    const pending = h.runner.run();
    const child = h.processes[0]!;

    child.out('out-1');
    child.err('err-1\n');
    child.out(Buffer.from('é'.repeat(3)));
    child.finish(0);
    await pending;

    expect(h.channel()?.text).toBe('out-1err-1\nééé');
    expect(vscodeMockState.outputChannels).toHaveLength(1);
  });

  it('does not echo the configured command into the output channel', async () => {
    const h = harness({ command: 'SECRET_COMMAND_SENTINEL' });
    const pending = h.runner.run();
    h.processes[0]!.out('hello');
    h.processes[0]!.finish(0);
    const summary = await pending;

    expect(h.channel()?.text).toBe('hello');
    expect(summary.command).toBe('SECRET_COMMAND_SENTINEL');
  });

  it('keeps output up to 256 KB intact and untruncated', async () => {
    const h = harness();
    const pending = h.runner.run();
    const exact = 'x'.repeat(PARSE_BUFFER_MAX_BYTES);
    h.processes[0]!.out(exact.slice(0, 1000));
    h.processes[0]!.out(exact.slice(1000));
    h.processes[0]!.finish(0);
    const summary = await pending;

    expect(h.parseInputs[0]!.output).toBe(exact);
    expect(h.parseInputs[0]!.outputTruncated).toBe(false);
    expect(summary.outputTruncated).toBe(false);
  });

  it('keeps head and tail beyond 256 KB while the channel receives everything', async () => {
    const h = harness();
    const pending = h.runner.run();
    const child = h.processes[0]!;
    const first = `HEAD_SENTINEL\n${'x'.repeat(100_000)}`;
    const middle = `${'y'.repeat(150_000)}MIDDLE_SENTINEL${'y'.repeat(150_000)}`;
    const last = `${'z'.repeat(100_000)}\nTAIL_SENTINEL\n`;

    child.out(first);
    child.err(middle);
    child.out(last);
    child.finish(0);
    const summary = await pending;
    const parsed = h.parseInputs[0]!.output;

    expect(parsed).toContain('HEAD_SENTINEL');
    expect(parsed).toContain('TAIL_SENTINEL');
    expect(parsed).not.toContain('MIDDLE_SENTINEL');
    expect(Buffer.byteLength(parsed, 'utf8')).toBeLessThanOrEqual(PARSE_BUFFER_MAX_BYTES);
    expect(h.parseInputs[0]!.outputTruncated).toBe(true);
    expect(summary.outputTruncated).toBe(true);
    const text = h.channel()!.text;
    expect(text).toContain('HEAD_SENTINEL');
    expect(text).toContain('MIDDLE_SENTINEL');
    expect(text).toContain('TAIL_SENTINEL');
    expect(text.length).toBe(first.length + middle.length + last.length);
  });

  it('bounds BoundedOutput memory for a single huge chunk and many small chunks', () => {
    const huge = new BoundedOutput();
    huge.push(Buffer.alloc(5_000_000, 'a'));
    expect(huge.retainedBytes).toBeLessThanOrEqual(PARSE_BUFFER_MAX_BYTES);
    expect(huge.truncated).toBe(true);

    const small = new BoundedOutput();
    for (let index = 0; index < 20_000; index += 1) small.push(`line ${index}\n`);
    expect(small.retainedBytes).toBeLessThanOrEqual(PARSE_BUFFER_MAX_BYTES);
    expect(small.text()).toContain('line 19999');
    expect(small.text()).toContain('line 0\n');
  });

  it('does not hold the full output in TestRunner fields', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../src/testing/testRunner.ts'), 'utf8');

    expect(source).not.toMatch(/allOutput|outputChunks|\.join\(''\)/);
  });
});

describe('TestRunner outcomes', () => {
  it('returns recognized passing output as parsed passed', async () => {
    const h = harness();
    const pending = h.runner.run();
    h.processes[0]!.out('Tests:       4 passed, 4 total\n');
    h.processes[0]!.finish(0);

    expect(await pending).toMatchObject({ outcome: 'passed', passed: 4, failed: 0, exitCode: 0, command: 'npm.cmd test' });
  });

  it('returns recognized failing output with exit 1 as a normal failed result', async () => {
    const h = harness();
    const pending = h.runner.run();
    h.processes[0]!.out(`  ● Suite › broken\n    Expected: 1\n${FAILING_JEST}\n`);
    h.processes[0]!.finish(1);
    const summary = await pending;

    expect(summary).toMatchObject({ outcome: 'failed', failed: 1, passed: 2, exitCode: 1 });
    expect(summary.outcome).not.toBe('did_not_execute');
  });

  it('keeps unrecognized exit-1 output as completed_unparsed, not did_not_execute', async () => {
    const outputs = ['something went wrong\n', "'tool' is not recognized as an internal or external command, but I printed more\n"];
    for (const output of outputs) {
      const h = harness();
      const pending = h.runner.run();
      h.processes[0]!.err(output);
      h.processes[0]!.finish(1);

      expect(await pending).toMatchObject({ outcome: 'completed_unparsed', exitCode: 1, passed: null, failed: null });
    }
  });

  it('classifies a genuine spawn error as did_not_execute exactly once', async () => {
    const h = harness();
    let settled = 0;
    const pending = h.runner.run().then((summary) => { settled += 1; return summary; });
    const child = h.processes[0]!;

    child.emit('error', new Error('spawn failed'));
    child.emit('error', new Error('again'));
    child.close(null);
    const summary = await pending;

    expect(summary).toMatchObject({
      outcome: 'did_not_execute', exitCode: null, passed: null, failed: null, failingTests: [],
    });
    expect(settled).toBe(1);
    expect(h.timers[0]!.cleared).toBe(true);
    expect(h.parseInputs).toHaveLength(0);
  });

  it('applies the Spike C missing-executable heuristic only to the exact cmd.exe diagnostic', async () => {
    const h = harness();
    const pending = h.runner.run();
    h.processes[0]!.err(
      "'kirosight_definitely_missing_executable_5_1' is not recognized as an internal or external command,\r\n" +
      'operable program or batch file.\r\n',
    );
    h.processes[0]!.finish(1);

    expect(await pending).toMatchObject({ outcome: 'did_not_execute', exitCode: 1, passed: null, failed: null });
    expect(h.parseInputs).toHaveLength(0);
  });

  it('documents the heuristic limits through isShellMissingCommand', () => {
    const diagnostic = "'x' is not recognized as an internal or external command, operable program or batch file.";

    expect(isShellMissingCommand(1, diagnostic)).toBe(true);
    expect(isShellMissingCommand(2, diagnostic)).toBe(false);
    expect(isShellMissingCommand(null, diagnostic)).toBe(false);
    expect(isShellMissingCommand(1, `${diagnostic}\nTests: 1 failed, 1 total`)).toBe(false);
    expect(isShellMissingCommand(1, '')).toBe(false);
    expect(isShellMissingCommand(1, 'npm ERR! failed')).toBe(false);
  });

  it('reports a non-negative duration from the injected clock', async () => {
    const h = harness();
    const pending = h.runner.run();
    h.clock.now = 1750;
    h.processes[0]!.finish(0);
    expect((await pending).durationMs).toBe(750);

    const backwards = harness();
    const second = backwards.runner.run();
    backwards.clock.now = 10;
    backwards.processes[0]!.finish(0);
    expect((await second).durationMs).toBe(0);
  });
});

describe('TestRunner single run', () => {
  it('joins overlapping runs and allows a later run after completion', async () => {
    const h = harness();
    const first = h.runner.run();
    const second = h.runner.run();

    expect(h.spawnCalls).toHaveLength(1);
    h.processes[0]!.out('Tests:       1 passed, 1 total\n');
    h.processes[0]!.finish(0);
    const [a, b] = await Promise.all([first, second]);
    expect(b).toBe(a);

    const third = h.runner.run();
    expect(h.spawnCalls).toHaveLength(2);
    h.processes[1]!.finish(0);
    await third;
  });

  it('clears the timer and the active run on completion', async () => {
    const h = harness();
    const pending = h.runner.run();
    h.processes[0]!.finish(0);
    await pending;

    expect(h.timers[0]!.cleared).toBe(true);
    h.runner.interrupt();
    expect(h.kills).toEqual([]);
  });

  it('ignores late events from an old process during a newer run', async () => {
    const h = harness();
    const first = h.runner.run();
    const old = h.processes[0]!;
    old.finish(0);
    await first;

    const second = h.runner.run();
    old.out('STALE_OUTPUT');
    old.close(1);
    h.processes[1]!.out('FRESH');
    h.processes[1]!.finish(0);
    await second;

    expect(h.parseInputs[1]!.output).toBe('FRESH');
    expect(h.channel()!.text).not.toContain('STALE_OUTPUT');
  });
});

describe('TestRunner interrupt and timeout', () => {
  it('does nothing when idle and does not affect a later run', async () => {
    const h = harness();
    h.runner.interrupt();
    const pending = h.runner.run();
    h.processes[0]!.out('Tests:       1 passed, 1 total\n');
    h.processes[0]!.finish(0);

    expect(h.kills).toEqual([]);
    expect(await pending).toMatchObject({ outcome: 'passed' });
  });

  it('kills the exact active pid once and reports cancelled over the killed exit code', async () => {
    const h = harness();
    const pending = h.runner.run();
    const child = h.processes[0]!;
    child.out('partial Tests:       1 failed, 1 total\n');

    h.runner.interrupt();
    h.runner.interrupt();
    expect(h.kills).toEqual([4000]);
    child.finish(1);
    const summary = await pending;

    expect(summary).toMatchObject({
      outcome: 'cancelled', exitCode: null, passed: null, failed: null, failingTests: [],
    });
    expect(h.parseInputs).toHaveLength(0);

    const next = h.runner.run();
    h.processes[1]!.out('Tests:       2 passed, 2 total\n');
    h.processes[1]!.finish(0);
    expect(await next).toMatchObject({ outcome: 'passed' });
    expect(h.kills).toEqual([4000]);
  });

  it('times out, kills once and reports timed_out over the killed exit code', async () => {
    const h = harness();
    const pending = h.runner.run();
    const child = h.processes[0]!;

    h.timers[0]!.callback();
    h.timers[0]!.callback();
    expect(h.kills).toEqual([4000]);
    child.finish(1);
    const summary = await pending;

    expect(summary).toMatchObject({ outcome: 'timed_out', exitCode: null, passed: null, failed: null });
    expect(h.timers[0]!.cleared).toBe(true);
  });

  it('does not let an old timer affect the next run', async () => {
    const h = harness();
    const first = h.runner.run();
    h.processes[0]!.finish(0);
    await first;

    const second = h.runner.run();
    h.timers[0]!.callback();
    expect(h.kills).toEqual([]);
    h.processes[1]!.finish(0);
    expect(await second).not.toMatchObject({ outcome: 'timed_out' });
  });

  it('settles once and kills once when timeout and interrupt race', async () => {
    const h = harness();
    let settled = 0;
    const pending = h.runner.run().then((summary) => { settled += 1; return summary; });
    const child = h.processes[0]!;

    h.timers[0]!.callback();
    h.runner.interrupt();
    child.close(1);
    child.close(1);
    const summary = await pending;

    expect(h.kills).toEqual([4000]);
    expect(summary.outcome).toBe('timed_out');
    expect(settled).toBe(1);

    const other = harness();
    const racing = other.runner.run();
    other.runner.interrupt();
    other.timers[0]!.callback();
    other.processes[0]!.close(1);
    expect((await racing).outcome).toBe('cancelled');
    expect(other.kills).toEqual([4000]);
  });

  it('never kills when the child has no valid pid', async () => {
    for (const pid of [undefined, 0, -3, 1.5]) {
      const h = harness({ pid });
      const pending = h.runner.run();

      h.runner.interrupt();

      expect(h.kills).toEqual([]);
      expect((await pending).outcome).toBe('cancelled');
    }
  });

  it('settles with the requested outcome when the tree kill throws', async () => {
    const h = harness();
    const throwing = new TestRunner({
      spawner: (command, options) => {
        h.spawnCalls.push({ command, options });
        return new FakeProcess(77) as unknown as TestProcess;
      },
      killTree: () => { throw new Error('kill failed'); },
    });
    const pending = throwing.run();

    throwing.interrupt();

    expect((await pending).outcome).toBe('cancelled');
  });
});

describe('process tree killer', () => {
  it('invokes taskkill /PID <pid> /T /F with an argument array on win32', () => {
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const kill = createProcessTreeKiller({
      platform: 'win32',
      spawnProcess: (command, args, options) => {
        calls.push({ command, args, options });
        return { on: () => undefined };
      },
    });

    kill(1234);

    expect(calls).toEqual([{
      command: 'taskkill',
      args: ['/PID', '1234', '/T', '/F'],
      options: { windowsHide: true, stdio: 'ignore' },
    }]);
  });

  it('signals the process group first and the process as a fallback elsewhere', () => {
    const signals: Array<[number, string]> = [];
    const kill = createProcessTreeKiller({
      platform: 'linux',
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid < 0) throw new Error('no group');
      },
    });

    kill(55);

    expect(signals).toEqual([[-55, 'SIGKILL'], [55, 'SIGKILL']]);
  });
});
