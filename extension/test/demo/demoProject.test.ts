import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TestRunner, type TestProcess } from '../../src/testing/testRunner';
import { parseTestOutput } from '../../src/testing/testOutputParser';
import { resetVscodeMock, setMockConfiguration, setMockWorkspace } from '../mocks/vscode';

/**
 * Task 10.1: the demo fixture in `demo-project/`.
 *
 * These checks are about the FIXTURE, not about the main KiroSight suite. The fixture contains one
 * deliberate type error and one deliberately failing test; this file proves that is exactly what it
 * contains, that its test command is the one KiroSight will run, and that KiroSight's existing parser
 * can summarize the Vitest output it produces. Nothing here installs packages or calls a provider.
 * The two checks marked "after install" run only once `npm install` has been done in demo-project.
 */
const testDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(testDirectory, '../..');
const demo = resolve(extensionRoot, '../demo-project');

const read = (...parts: string[]): string => readFileSync(join(demo, ...parts), 'utf8');
const json = (...parts: string[]): Record<string, any> => JSON.parse(read(...parts)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const DELIBERATE_MARKER = '(deliberately failing demo test)';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else found.push(full);
  }
  return found;
}

interface DeclaredTest { readonly file: string; readonly suite: string; readonly name: string }

/** The tests the fixture declares, read from the files as written (suite and test names). */
function declaredTests(): DeclaredTest[] {
  const tests: DeclaredTest[] = [];
  for (const file of ['tests/cart.test.ts', 'tests/discount.test.ts']) {
    let suite = '';
    for (const line of read(file).split(/\r?\n/)) {
      const describeMatch = /^describe\('(.+)', \(\) => \{$/.exec(line);
      if (describeMatch !== null) suite = describeMatch[1]!;
      const itMatch = /^\s+it\('(.+)', \(\) => \{$/.exec(line);
      if (itMatch !== null) tests.push({ file, suite, name: itMatch[1]! });
    }
  }
  return tests;
}

describe('pinned dependencies', () => {
  const manifest = json('package.json');

  it('uses exact versions only: no caret, tilde, range, tag or wildcard', () => {
    const all = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) } as Record<string, string>;
    expect(Object.keys(all).sort()).toEqual(['typescript', 'vitest']);
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(EXACT_VERSION);
    }
  });

  it('adds nothing unnecessary: no runtime dependencies, private, and its own name', () => {
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.private).toBe(true);
    expect(manifest.name).toBe('kirosight-demo-project');
    expect(manifest.name).not.toBe(json('../extension/package.json').name);
  });

  it('runs Vitest once and plainly: a single run, no watch mode', () => {
    expect(manifest.scripts.test).toBe('vitest --run');
    expect(manifest.scripts.test).not.toMatch(/--watch|-w\b/);
    const config = read('vitest.config.ts');
    expect(config).toContain("include: ['tests/**/*.test.ts']");
    expect(config).not.toMatch(/watch\s*:\s*true/);
  });

  it.skipIf(!existsSync(join(demo, 'package-lock.json')))('the lockfile (once generated) records the same pins', () => {
    const lock = json('package-lock.json');
    expect(lock.packages[''].devDependencies).toEqual(manifest.devDependencies);
    for (const [name, version] of Object.entries(manifest.devDependencies as Record<string, string>)) {
      expect(lock.packages[`node_modules/${name}`].version, name).toBe(version);
    }
  });
});

describe('the workspace test command', () => {
  const settings = json('.vscode', 'settings.json');
  const configured = String(settings['kirosight.testCommand']);

  it('is the confirmed Windows wrapper, powershell.exe -NoProfile -Command "npm.cmd test", and nothing else', () => {
    expect(configured).toBe('powershell.exe -NoProfile -Command "npm.cmd test"');
  });

  it('runs only this project\'s test script: the inner command is npm.cmd test, which the package maps to one Vitest run', () => {
    expect(/-Command "(.+)"$/.exec(configured)?.[1]).toBe('npm.cmd test');
    expect(json('package.json').scripts.test).toBe('vitest --run');
  });

  it('is safe to run: no profile, policy bypass, encoded or file script, download, chaining, redirection or parent path', () => {
    expect(configured).toContain('-NoProfile');
    for (const forbidden of [
      /-ExecutionPolicy|-Bypass/i, /-EncodedCommand|-enc\b/i, /-File\b/i, /-NoExit/i,
      /Invoke-Expression|\biex\b/i, /Invoke-WebRequest|\biwr\b|curl|wget|https?:/i,
      /Start-Process|Set-|Remove-|Out-File/i, /[;&|<>`$]/, /\.\./, /extension/i,
    ]) {
      expect(configured).not.toMatch(forbidden);
    }
    expect(configured.trim()).toBe(configured);
  });

  it('is one plain command: no chaining, redirection, parent paths or the extension\'s own suite', () => {
    const command = String(settings['kirosight.testCommand']);
    expect(command).not.toMatch(/[;&|<>`$]|\.\.|extension/);
    expect(command.trim()).toBe(command);
  });

  it('sets only test settings, and leaves workspace security and the backend command alone', () => {
    expect(Object.keys(settings).sort()).toEqual(['kirosight.testCommand', 'kirosight.testTimeoutSeconds']);
    expect(Number.isInteger(settings['kirosight.testTimeoutSeconds'])).toBe(true);
    expect(settings['kirosight.testTimeoutSeconds']).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(settings)).not.toMatch(/trust|backendCommand/i);
  });

  it('is what the real TestRunner runs: that command, in the first workspace folder, through a shell', async () => {
    resetVscodeMock();
    setMockWorkspace([demo]);
    setMockConfiguration({
      'kirosight.testCommand': settings['kirosight.testCommand'],
      'kirosight.testTimeoutSeconds': settings['kirosight.testTimeoutSeconds'],
    });
    const calls: Array<{ command: string; options: unknown }> = [];
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter() });
    const runner = new TestRunner({
      spawner: (command, options) => { calls.push({ command, options }); return child as unknown as TestProcess; },
      scheduler: { set: () => 1, clear: () => undefined } as never,
    });

    const pending = runner.run();
    child.stdout.emit('data', 'Tests  1 failed | 6 passed (7)\n');
    child.emit('exit', 1, null);
    child.emit('close', 1, null);
    const summary = await pending;

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(configured);
    expect(calls[0]!.options).toEqual({ shell: true, cwd: demo, windowsHide: true });
    expect(summary).toMatchObject({ command: configured, exitCode: 1, outcome: 'failed' });
  });
});

describe('exactly one deliberate type error', () => {
  const cart = read('src', 'cart.ts');

  it('TypeScript reports one error: TS2322 in src/cart.ts, on the line that assigns a number to a string', () => {
    const tsc = join(extensionRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    const result = spawnSync(
      `"${tsc}" -p "${join(demo, 'tsconfig.json')}" --noEmit --pretty false`,
      { cwd: demo, shell: true, encoding: 'utf8', timeout: 40_000, windowsHide: true },
    );
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const errors = [...output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)];

    expect(result.status, output).not.toBe(0);
    expect(errors, output).toHaveLength(1);
    const [, file, line, , code, message] = errors[0]!;
    expect(relative(demo, resolve(demo, file!)).replace(/\\/g, '/')).toBe('src/cart.ts');
    expect(code).toBe('TS2322');
    expect(message).toContain("'number'");
    expect(message).toContain("'string'");
    const expectedLine = cart.split(/\r?\n/).findIndex((text) => text.includes('const label: string = lineTotal;')) + 1;
    expect(expectedLine).toBeGreaterThan(0);
    expect(Number(line)).toBe(expectedLine);
  }, 45_000); // tsc runs as a real process; the default 5 s limit was too short under load

  it('sits inside the named function formatReceiptLine, with no suppression or cast to hide it', () => {
    const start = cart.indexOf('export function formatReceiptLine');
    const end = cart.indexOf('\n}', start);
    expect(start).toBeGreaterThan(-1);
    expect(cart.slice(start, end)).toContain('const label: string = lineTotal;');
    for (const text of [cart, read('src', 'discount.ts')]) {
      expect(text).not.toMatch(/@ts-ignore|@ts-expect-error|@ts-nocheck|\bas any\b|as unknown as/);
    }
  });

  it('has one error source only, checks strictly, and covers just src/ so test files add no diagnostics', () => {
    expect(cart.match(/const label: string = lineTotal;/g)).toHaveLength(1);
    expect(read('tsconfig.json')).toContain('"strict": true');
    expect(json('tsconfig.json').include).toEqual(['src']);
  });
});

describe('a second, distinct file for OPEN_FILE', () => {
  it('discount.ts exists, exports real code, and no other file in the project has that name (or cart.ts)', () => {
    const names = sourceFiles(demo).map((file) => file.split(/[\\/]/).pop()!);
    expect(names.filter((name) => name === 'discount.ts')).toHaveLength(1);
    expect(names.filter((name) => name === 'cart.ts')).toHaveLength(1);
    expect(read('src', 'discount.ts')).toContain('export function applyDiscount');
  });

  it('every source and test file name is unique, so "open <name>" is never ambiguous', () => {
    const names = sourceFiles(demo).filter((file) => /\.(ts|json)$/.test(file)).map((file) => file.split(/[\\/]/).pop()!);
    const code = names.filter((name) => name.endsWith('.ts'));
    expect(new Set(code).size).toBe(code.length);
  });
});

describe('the test suite fixture', () => {
  const tests = declaredTests();

  it('declares 7 tests: 6 meant to pass and exactly 1 deliberately failing, in two files', () => {
    expect(tests).toHaveLength(7);
    expect(tests.filter((test) => test.name.includes(DELIBERATE_MARKER))).toHaveLength(1);
    expect(new Set(tests.map((test) => test.file)).size).toBe(2);
    expect(new Set(tests.map((test) => `${test.suite} > ${test.name}`)).size).toBe(7);
  });

  it('is deterministic: no randomness, clock, timers, network, environment or file access', () => {
    for (const file of ['tests/cart.test.ts', 'tests/discount.test.ts', 'src/cart.ts', 'src/discount.ts']) {
      expect(read(file), file).not.toMatch(
        /Math\.random|Date\.now|new Date|performance\.now|setTimeout|setInterval|fetch\(|XMLHttpRequest|WebSocket|process\.env|require\(|node:fs|node:http|node:net|child_process/,
      );
    }
  });

  it('has clear names: every test name says what it checks and is long enough to be read aloud', () => {
    for (const test of tests) {
      expect(test.name.split(' ').length, test.name).toBeGreaterThanOrEqual(4);
      expect(test.suite).not.toBe('');
    }
  });
});

describe('compatibility with KiroSight\'s existing test-summary parser', () => {
  /** What Vitest prints for this fixture, built from the tests it declares (colors removed). */
  function vitestOutput(): string {
    const tests = declaredTests();
    const failing = tests.find((test) => test.name.includes(DELIBERATE_MARKER))!;
    return [
      ' RUN  v5.0.3 C:/demo-project',
      '',
      ' ✓ tests/cart.test.ts (3 tests) 3ms',
      ' ❯ tests/discount.test.ts (4 tests | 1 failed) 5ms',
      `   × ${failing.suite} > ${failing.name}`,
      '',
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      '',
      ` FAIL  ${failing.file} > ${failing.suite} > ${failing.name}`,
      'AssertionError: expected 895 to be 896 // Object.is equality',
      '',
      ` ❯ ${failing.file}:24:34`,
      '',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯',
      '',
      ` Test Files  1 failed | 1 passed (2)`,
      `      Tests  1 failed | ${tests.length - 1} passed (${tests.length})`,
      '',
    ].join('\n');
  }

  it('summarizes the fixture\'s output as a failed run with 6 passed, 1 failed and the failing test named', () => {
    const summary = parseTestOutput({
      output: vitestOutput(), exitCode: 1, command: 'npm test', outputTruncated: false, durationMs: 1000,
    });

    expect(summary).toMatchObject({ outcome: 'failed', passed: 6, failed: 1, totalFailedNames: 1, exitCode: 1 });
    expect(summary.failingTests).toHaveLength(1);
    expect(summary.failingTests[0]!.name).toContain(DELIBERATE_MARKER);
    expect(summary.failingTests[0]!.name).toContain('tests/discount.test.ts > loyaltyPrice >');
    expect(summary.failingTests[0]!.messageExcerpt).toContain('expected 895 to be 896');
  });

  it('would summarize an all-green run as passed (the failure is the fixture\'s own, nothing else)', () => {
    const summary = parseTestOutput({
      output: ' Test Files  2 passed (2)\n      Tests  7 passed (7)\n', exitCode: 0, command: 'npm test',
      outputTruncated: false, durationMs: 1,
    });

    expect(summary).toMatchObject({ outcome: 'passed', passed: 7, failed: 0 });
  });

  // After install, on Windows: the exact command the demo configures, run by the real TestRunner as
  // a real process, and its real output summarized by the existing parser. The process gets a COPY
  // of the environment without the outer Vitest's markers (a Vitest started inside a Vitest worker
  // would think it is that worker), so this test process's own environment is never changed.
  it.skipIf(!existsSync(join(demo, 'node_modules', 'vitest')) || process.platform !== 'win32')(
    'after install, on Windows: the configured command, run by the real TestRunner, is summarized as 6 passed and 1 failed',
    async () => {
      const settings = json('.vscode', 'settings.json');
      resetVscodeMock();
      setMockWorkspace([demo]);
      setMockConfiguration({
        'kirosight.testCommand': settings['kirosight.testCommand'],
        'kirosight.testTimeoutSeconds': settings['kirosight.testTimeoutSeconds'],
      });
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'CI'));
      const text: string[] = [];
      const runner = new TestRunner({
        spawner: (command, options) => spawn(command, { ...options, env }) as unknown as TestProcess,
        createOutputChannel: () => ({ append: (value) => { text.push(value); }, dispose: () => undefined }),
      });

      const summary = await runner.run();
      const output = text.join('');

      expect(output).not.toContain("reading 'config'");
      expect(summary, output).toMatchObject({ outcome: 'failed', exitCode: 1, passed: 6, failed: 1, totalFailedNames: 1 });
      expect(summary.failingTests.map((test) => test.name).join('\n')).toContain(DELIBERATE_MARKER);
    },
    180_000,
  );
});
