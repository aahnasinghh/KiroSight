import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

import * as vscode from 'vscode';

import { read as readTestCommand } from './testCommandConfig';
import {
  parseTestOutput,
  type TestOutputInput,
  type TestRunSummary,
} from './testOutputParser';

export const TEST_OUTPUT_CHANNEL_NAME = 'KiroSight Tests';
export const PARSE_BUFFER_MAX_BYTES = 256 * 1024;
const HEAD_BYTES = PARSE_BUFFER_MAX_BYTES / 2;
const TAIL_BYTES = PARSE_BUFFER_MAX_BYTES / 2;
const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMER_MS = 2_147_483_647;

/** The subset of a Node child process that the runner uses. */
export interface TestProcess {
  readonly pid?: number | undefined;
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface SpawnOptions {
  readonly shell: true;
  readonly cwd: string;
  readonly windowsHide: true;
}

export type ProcessSpawner = (command: string, options: SpawnOptions) => TestProcess;
export type ProcessTreeKiller = (pid: number) => void;

export interface TestOutputChannel {
  append(value: string): void;
  show?(preserveFocus?: boolean): void;
  dispose(): void;
}

export interface Scheduler {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface TestRunnerDeps {
  readonly spawner?: ProcessSpawner;
  readonly killTree?: ProcessTreeKiller;
  readonly now?: () => number;
  readonly scheduler?: Scheduler;
  readonly parse?: (input: TestOutputInput) => TestRunSummary;
  readonly createOutputChannel?: () => TestOutputChannel;
}

/** Streaming head-and-tail buffer. Memory stays bounded however much output arrives. */
export class BoundedOutput {
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private readonly tail: Buffer[] = [];
  private tailBytes = 0;
  private dropped = 0;

  public constructor(
    private readonly headLimit = HEAD_BYTES,
    private readonly tailLimit = TAIL_BYTES,
  ) {}

  public push(data: Buffer | string): void {
    let chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (this.headBytes < this.headLimit) {
      const part = chunk.subarray(0, this.headLimit - this.headBytes);
      this.head.push(Buffer.from(part));
      this.headBytes += part.length;
      chunk = chunk.subarray(part.length);
    }
    if (chunk.length === 0) return;
    if (chunk.length > this.tailLimit) {
      this.dropped += chunk.length - this.tailLimit;
      chunk = chunk.subarray(chunk.length - this.tailLimit);
    }
    this.tail.push(Buffer.from(chunk));
    this.tailBytes += chunk.length;
    while (this.tailBytes > this.tailLimit) {
      const excess = this.tailBytes - this.tailLimit;
      const first = this.tail[0]!;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.dropped += first.length;
      } else {
        this.tail[0] = Buffer.from(first.subarray(excess));
        this.tailBytes -= excess;
        this.dropped += excess;
      }
    }
  }

  public get retainedBytes(): number {
    return this.headBytes + this.tailBytes;
  }

  public get truncated(): boolean {
    return this.dropped > 0;
  }

  public text(): string {
    return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
  }
}

/**
 * Terminates a process and its descendants. On Windows this is `taskkill /PID <pid> /T /F`
 * (Spike C). Elsewhere it signals the process group, then the process itself; the runner
 * does not spawn a detached group, so non-Windows tree termination is best effort.
 */
export function createProcessTreeKiller(options: {
  readonly platform?: NodeJS.Platform;
  readonly spawnProcess?: (
    command: string,
    args: readonly string[],
    options: { readonly windowsHide: true; readonly stdio: 'ignore' },
  ) => { on(event: 'error', listener: () => void): unknown };
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
} = {}): ProcessTreeKiller {
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const killProcess = options.killProcess ?? ((pid, signal) => { process.kill(pid, signal); });
  return (pid) => {
    if (platform === 'win32') {
      spawnProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        .on('error', () => undefined);
      return;
    }
    try {
      killProcess(-pid, 'SIGKILL');
    } catch {
      killProcess(pid, 'SIGKILL');
    }
  };
}

const defaultSpawner: ProcessSpawner = (command, options) =>
  spawn(command, options) as unknown as TestProcess;

const defaultScheduler: Scheduler = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const MISSING_COMMAND_DIAGNOSTIC =
  /^'.+' is not recognized as an internal or external command, operable program or batch file\.$/i;

/**
 * Spike C: with `shell: true`, a missing executable starts cmd.exe successfully, which exits 1
 * and prints only this diagnostic. This is a narrow heuristic: the wording is English/Windows
 * specific and a program could print the same text itself. It never applies to any other
 * output or exit code.
 */
export function isShellMissingCommand(exitCode: number | null, output: string): boolean {
  return exitCode === 1 && MISSING_COMMAND_DIAGNOSTIC.test(output.replace(/\s+/g, ' ').trim());
}

function readTimeoutMs(): number {
  const configured = vscode.workspace.getConfiguration('kirosight').get<unknown>('testTimeoutSeconds');
  const seconds = typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
    ? configured
    : DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.floor(seconds * 1000), MAX_TIMER_MS);
}

interface RunState {
  readonly command: string;
  readonly startedAt: number;
  readonly output: BoundedOutput;
  readonly decoders: StringDecoder[];
  child: TestProcess | undefined;
  timer: unknown;
  reason: 'timed_out' | 'cancelled' | null;
  killed: boolean;
  settled: boolean;
  promise: Promise<TestRunSummary>;
  resolve: (summary: TestRunSummary) => void;
}

/**
 * Runs the command from `kirosight.testCommand` and nothing else. `run()` takes no command,
 * and only one run is active at a time.
 */
export class TestRunner {
  private readonly spawner: ProcessSpawner;
  private readonly killTree: ProcessTreeKiller;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly parse: (input: TestOutputInput) => TestRunSummary;
  private readonly createChannel: () => TestOutputChannel;
  private channel: TestOutputChannel | undefined;
  private active: RunState | null = null;

  public constructor(deps: TestRunnerDeps = {}) {
    this.spawner = deps.spawner ?? defaultSpawner;
    this.killTree = deps.killTree ?? createProcessTreeKiller();
    this.now = deps.now ?? (() => Date.now());
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.parse = deps.parse ?? parseTestOutput;
    this.createChannel = deps.createOutputChannel
      ?? (() => vscode.window.createOutputChannel(TEST_OUTPUT_CHANNEL_NAME));
  }

  /** A second call while a run is active joins that run; it never spawns another process. */
  public run(): Promise<TestRunSummary> {
    if (this.active !== null) return this.active.promise;

    const startedAt = this.now();
    const command = readTestCommand();
    if (command === '') return Promise.resolve(this.processLevel('not_configured', '', startedAt, false, null));

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
      // Fail closed: there is no approved working directory, so nothing is spawned.
      return Promise.resolve(this.processLevel('did_not_execute', command, startedAt, false, null));
    }

    return this.start(command, folder.uri.fsPath, startedAt);
  }

  /** Stops the active run, if any. With no active run this does nothing and remembers nothing. */
  public interrupt(): void {
    const state = this.active;
    if (state === null || state.settled) return;
    if (state.reason === null) state.reason = 'cancelled';
    this.kill(state);
  }

  /** Reveals the `KiroSight Tests` channel that receives test output. Runs and spawns nothing. */
  public showOutput(): void {
    this.channel ??= this.createChannel();
    this.channel.show?.(false);
  }

  public dispose(): void {
    this.channel?.dispose();
    this.channel = undefined;
  }

  private start(command: string, cwd: string, startedAt: number): Promise<TestRunSummary> {
    const state = {
      command, startedAt, output: new BoundedOutput(), decoders: [] as StringDecoder[],
      child: undefined, timer: undefined, reason: null, killed: false, settled: false,
    } as unknown as RunState;
    state.promise = new Promise<TestRunSummary>((resolve) => { state.resolve = resolve; });
    this.active = state;

    try {
      const child = this.spawner(command, { shell: true, cwd, windowsHide: true });
      state.child = child;
      this.listen(state, child, child.stdout);
      this.listen(state, child, child.stderr);
      let exitCode: number | null = null;
      child.on('error', () => {
        if (state.settled) return;
        this.settle(state, this.processLevel(state.reason ?? 'did_not_execute', command, startedAt, state.output.truncated, null));
      });
      child.on('exit', (code) => { exitCode = code; });
      child.on('close', (code) => {
        if (state.settled) return;
        this.flushDecoders(state);
        this.settle(state, this.finish(state, code ?? exitCode));
      });
      state.timer = this.scheduler.set(() => {
        if (state.settled || state.reason !== null) return;
        state.reason = 'timed_out';
        this.kill(state);
      }, readTimeoutMs());
    } catch {
      this.settle(state, this.processLevel('did_not_execute', command, startedAt, false, null));
    }
    return state.promise;
  }

  private listen(
    state: RunState,
    child: TestProcess,
    stream: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null,
  ): void {
    if (stream === null) return;
    const decoder = new StringDecoder('utf8');
    state.decoders.push(decoder);
    stream.on('data', (chunk) => {
      if (state.settled || state.child !== child) return;
      state.output.push(chunk);
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text !== '') this.write(text);
    });
  }

  private write(text: string): void {
    this.channel ??= this.createChannel();
    this.channel.append(text);
  }

  private flushDecoders(state: RunState): void {
    for (const decoder of state.decoders) {
      const rest = decoder.end();
      if (rest !== '') this.write(rest);
    }
  }

  private kill(state: RunState): void {
    if (state.killed || state.settled) return;
    state.killed = true;
    const pid = state.child?.pid;
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
      this.settle(state, this.finish(state, null));
      return;
    }
    try {
      this.killTree(pid);
    } catch {
      this.settle(state, this.finish(state, null));
    }
  }

  private finish(state: RunState, exitCode: number | null): TestRunSummary {
    if (state.reason !== null) {
      return this.processLevel(state.reason, state.command, state.startedAt, state.output.truncated, null);
    }
    const output = state.output.text();
    if (isShellMissingCommand(exitCode, output)) {
      return this.processLevel('did_not_execute', state.command, state.startedAt, state.output.truncated, exitCode);
    }
    return this.parse({
      output,
      exitCode,
      command: state.command,
      outputTruncated: state.output.truncated,
      durationMs: this.duration(state.startedAt),
    });
  }

  private settle(state: RunState, summary: TestRunSummary): void {
    if (state.settled) return;
    state.settled = true;
    if (state.timer !== undefined) this.scheduler.clear(state.timer);
    state.timer = undefined;
    if (this.active === state) this.active = null;
    state.resolve(summary);
  }

  private duration(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  private processLevel(
    outcome: 'not_configured' | 'did_not_execute' | 'timed_out' | 'cancelled',
    command: string,
    startedAt: number,
    outputTruncated: boolean,
    exitCode: number | null,
  ): TestRunSummary {
    return {
      outcome, command, exitCode, passed: null, failed: null, totalFailedNames: 0,
      failingTests: [], outputTruncated, durationMs: this.duration(startedAt),
    };
  }
}
