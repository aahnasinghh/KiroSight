import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TestRunner, type TestOutputChannel } from '../../src/testing/testRunner';
import { resetVscodeMock, setMockConfiguration, setMockWorkspace } from '../mocks/vscode';

/**
 * Task 10.1: the REAL TestRunner with real child processes.
 *
 * The other TestRunner tests inject a fake spawner, so they can never notice how a command really
 * starts, ends or is stopped. These do not: nothing here is faked except the VS Code API. They
 * cover output and exit-code capture, stderr, the working directory, cancellation and timeout.
 *
 * What they prove is limited to ordinary Node on this machine: they cannot reproduce the Electron
 * extension host, and they say nothing about why running `npm test` directly failed there.
 */
const NODE = process.execPath;
const isWindows = process.platform === 'win32';

let root: string;
let work: string;

const scripts = {
  /** Prints a Vitest-style summary on stdout, a warning on stderr, and exits 3. */
  report: [
    "process.stdout.write('Tests  1 failed | 2 passed (3)\\n');",
    "process.stderr.write('WARNING-ON-STDERR\\n');",
    'process.exit(3);',
  ].join('\n'),
  cwd: "process.stdout.write('CWD=' + process.cwd() + '\\n');",
  /** Records its pid in a file named by argv[2], then never exits on its own. */
  hang: [
    "require('node:fs').writeFileSync(process.argv[2], String(process.pid));",
    'setInterval(() => {}, 1000);',
  ].join('\n'),
};

function script(name: keyof typeof scripts): string {
  const file = join(work, `${name}.cjs`);
  writeFileSync(file, scripts[name]);
  return file;
}

const quote = (value: string): string => `"${value}"`;

function channel(): { readonly channel: TestOutputChannel; readonly text: () => string } {
  const parts: string[] = [];
  return {
    channel: { append: (value) => { parts.push(value); }, dispose: () => undefined },
    text: () => parts.join(''),
  };
}

function point(command: string, timeoutSeconds?: number): void {
  resetVscodeMock();
  setMockWorkspace([work]);
  setMockConfiguration({
    'kirosight.testCommand': command,
    ...(timeoutSeconds === undefined ? {} : { 'kirosight.testTimeoutSeconds': timeoutSeconds }),
  });
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await new Promise<void>((done) => setTimeout(done, 50));
  }
  return condition();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kirosight-runner-'));
  work = join(root, 'dir with space'); // a space in the path, as real workspaces have
  mkdirSync(work);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => resetVscodeMock());

describe('TestRunner with a real process', () => {
  it('runs the configured command in the first workspace folder and parses its real output and exit code', async () => {
    point(`${quote(NODE)} ${quote(script('report'))}`);
    const out = channel();
    const runner = new TestRunner({ createOutputChannel: () => out.channel });

    const summary = await runner.run();

    expect(summary).toMatchObject({ outcome: 'failed', exitCode: 3, passed: 2, failed: 1 });
    expect(out.text()).toContain('Tests  1 failed | 2 passed (3)');
    expect(out.text()).toContain('WARNING-ON-STDERR');
  }, 30_000);

  it('uses the workspace folder as the working directory', async () => {
    point(`${quote(NODE)} ${quote(script('cwd'))}`);
    const out = channel();

    await new TestRunner({ createOutputChannel: () => out.channel }).run();

    const reported = /CWD=(.+)/.exec(out.text())?.[1]?.trim() ?? '';
    const normalize = (value: string): string => realpathSync.native(value).toLowerCase();
    expect(normalize(reported)).toBe(normalize(work));
  }, 30_000);

  it.skipIf(!isWindows)('cancels a real run: the whole process tree ends and the run is reported cancelled', async () => {
    const pidFile = join(work, 'cancel.pid');
    rmSync(pidFile, { force: true });
    point(`${quote(NODE)} ${quote(script('hang'))} ${quote(pidFile)}`);
    const runner = new TestRunner({ createOutputChannel: () => channel().channel });

    const pending = runner.run();
    expect(await waitFor(() => existsSync(pidFile), 10_000)).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(pid)).toBe(true);
    runner.interrupt();
    const summary = await pending;

    expect(summary.outcome).toBe('cancelled');
    expect(await waitFor(() => !isAlive(pid), 10_000)).toBe(true);
  }, 40_000);

  it.skipIf(!isWindows)('times a real run out: stopped after the configured seconds, tree gone, reported timed out', async () => {
    const pidFile = join(work, 'timeout.pid');
    rmSync(pidFile, { force: true });
    point(`${quote(NODE)} ${quote(script('hang'))} ${quote(pidFile)}`, 1);
    const runner = new TestRunner({ createOutputChannel: () => channel().channel });
    const started = Date.now();

    const summary = await runner.run();

    expect(summary.outcome).toBe('timed_out');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(20_000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(await waitFor(() => !isAlive(pid), 10_000)).toBe(true);
  }, 40_000);
});
