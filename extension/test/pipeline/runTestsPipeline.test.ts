import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it } from 'vitest';

import { ActionExecutor } from '../../src/actions/actionExecutor';
import { ActionGate } from '../../src/confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from '../../src/confirmation/confirmationController';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import { ContextService } from '../../src/context/contextService';
import { SymbolService } from '../../src/context/symbolService';
import { route } from '../../src/intent/localIntentRouter';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import { InputPipeline, type AgentGateway } from '../../src/pipeline/inputPipeline';
import { LocalIntentHandler, TEST_SUMMARY_UNAVAILABLE } from '../../src/pipeline/localIntentHandler';
import {
  formatConfirmation,
  formatConfirmationReprompt,
  formatTestResult,
} from '../../src/response/responseFormatter';
import { read as readTestCommand } from '../../src/testing/testCommandConfig';
import { TestRunStore } from '../../src/testing/testRunStore';
import { TestRunner, type TestProcess } from '../../src/testing/testRunner';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ViewModel } from '../../src/webview/viewModel';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';
import { resetVscodeMock, setMockConfiguration, setMockWorkspace } from '../mocks/vscode';

class Child extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public constructor(public readonly pid = 9000) { super(); }
  public finish(code: number): void { this.emit('exit', code, null); this.emit('close', code, null); }
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setCommand(command: string): void {
  setMockConfiguration({ 'kirosight.testCommand': command, 'kirosight.testTimeoutSeconds': 5 });
}

function build() {
  resetVscodeMock();
  setMockWorkspace(['/ws']);
  setCommand('npm.cmd test');

  const children: Child[] = [];
  const spawned: string[] = [];
  const runner = new TestRunner({
    spawner: (command) => {
      spawned.push(command);
      const child = new Child(9000 + children.length);
      children.push(child);
      return child as unknown as TestProcess;
    },
    scheduler: { set: () => ({}) as object, clear: () => undefined },
    createOutputChannel: () => ({ append: () => undefined, dispose: () => undefined }),
  });
  const store = new TestRunStore();
  const adapter = new FakeEditorAdapter({});
  const diagnostics = new DiagnosticsService(adapter);
  const executor = new ActionExecutor({
    adapter, diagnostics, files: new FileService(adapter), navigation: new NavigationService(adapter),
    testRunner: runner, testRunStore: store,
  });
  const manager = new ConfirmationManager(currentTestTarget);
  const gate = new ActionGate({ confirmations: manager, executor });
  const controller = new GateConfirmationController(gate, manager);
  const symbols = new SymbolService(adapter);
  const handler = new LocalIntentHandler({
    context: new ContextService(adapter, symbols, diagnostics), diagnostics, symbols,
    actions: executor, gate, testRuns: store,
  });

  const agentCalls: string[] = [];
  const agent: AgentGateway = {
    respond: async (text) => { agentCalls.push(text); return { status: 'not_handled', text: 'agent' }; },
  };
  const routed: string[] = [];
  const transcript = new TranscriptStore();
  const models: ViewModel[] = [];
  const pipeline = new InputPipeline({
    transcript, localIntents: handler, agent, confirmation: controller,
    route: (text) => { routed.push(text); return route(text); },
    onViewModel: (model) => { models.push(model); },
  });
  return { pipeline, manager, store, spawned, children, agentCalls, routed, transcript, models };
}

function lastResponse(h: ReturnType<typeof build>): string {
  const entries = h.transcript.getEntries().filter((entry) => entry.role === 'kirosight');
  return entries[entries.length - 1]!.text;
}

function summary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: 'failed', command: 'npm.cmd test', exitCode: 1, passed: 2, failed: 2, totalFailedNames: 2,
    failingTests: [{ name: 'alpha' }, { name: 'beta' }], outputTruncated: false, durationMs: 4, ...overrides,
  };
}

describe('RUN_TESTS through the pipeline', () => {
  let h: ReturnType<typeof build>;
  beforeEach(() => { h = build(); });

  it('asks for confirmation with the exact configured command and does not run first', async () => {
    await h.pipeline.handle('run my tests', 'typed');

    expect(lastResponse(h)).toContain('Run tests using "npm.cmd test"');
    expect(h.spawned).toEqual([]);
    expect(h.manager.pending()).toMatchObject({
      target: 'npm.cmd test', origin: 'local', correlationId: 'local-1',
    });
    expect(h.models.at(-1)!.statusKind).toBe('confirmation_pending');
    expect(h.transcript.getEntries().map((e) => e.role)).toEqual(['user', 'kirosight']);
  });

  it('answers not_configured before any confirmation and never reaches the runner', async () => {
    setCommand('   ');

    await h.pipeline.handle('run tests', 'typed');

    expect(lastResponse(h)).toContain('kirosight.testCommand');
    expect(h.manager.pending()).toBeNull();
    expect(h.spawned).toEqual([]);
    expect(h.store.get()).toBeNull();
    expect(h.models.at(-1)!.statusKind).toBe('idle');
  });

  it('keeps an earlier stored run when the command is unset', async () => {
    h.store.set(summary());
    setCommand('');

    await h.pipeline.handle('run tests', 'typed');

    expect(h.store.get()).toMatchObject({ failed: 2 });
  });

  it('runs exactly once after a typed confirm, stores and formats the summary', async () => {
    await h.pipeline.handle('run tests', 'typed');
    const pending = h.pipeline.handle('confirm', 'typed');
    await flush();
    expect(h.spawned).toEqual(['npm.cmd test']);
    h.children[0]!.stdout.emit('data', 'Tests:       4 passed, 4 total\n');
    h.children[0]!.finish(0);
    await pending;

    expect(h.spawned).toHaveLength(1);
    expect(h.store.get()).toMatchObject({ outcome: 'passed', passed: 4 });
    expect(lastResponse(h)).toBe('4 passed, 0 failed');
    expect(h.manager.pending()).toBeNull();
    expect(h.models.at(-1)!.statusKind).toBe('idle');
    expect(h.agentCalls).toEqual([]);
    expect(h.transcript.getEntries().filter((e) => e.role === 'user')).toHaveLength(2);
  });

  it('runs once for the confirm control and does not run again', async () => {
    await h.pipeline.handle('run tests', 'typed');
    const pending = h.pipeline.confirm();
    await flush();
    h.children[0]!.finish(0);
    await pending;
    await h.pipeline.confirm();
    await h.pipeline.decline();

    expect(h.spawned).toHaveLength(1);
    expect(h.store.get()).not.toBeNull();
  });

  it('does not run on decline, cancel or the decline control', async () => {
    for (const how of ['decline', 'cancel', 'control'] as const) {
      const fresh = build();
      await fresh.pipeline.handle('run tests', 'typed');
      if (how === 'control') await fresh.pipeline.decline();
      else await fresh.pipeline.handle(how, 'typed');

      expect(fresh.spawned).toEqual([]);
      expect(fresh.manager.pending()).toBeNull();
      expect(lastResponse(fresh)).toContain('declined');
      expect(fresh.store.get()).toBeNull();
    }
  });

  it('sends pending text only to confirmation handling', async () => {
    await h.pipeline.handle('run tests', 'typed');
    const routedBefore = h.routed.length;

    await h.pipeline.handle('go to line 10', 'typed');
    await h.pipeline.handle('what errors are there', 'typed');
    await h.pipeline.handle('explain this error', 'typed');

    expect(h.routed).toHaveLength(routedBefore);
    expect(h.agentCalls).toEqual([]);
    expect(lastResponse(h)).toBe(formatConfirmationReprompt({ type: 'RUN_TESTS' }));
    expect(h.manager.pending()).not.toBeNull();
    expect(h.spawned).toEqual([]);
    expect(h.models.at(-1)!.statusKind).toBe('confirmation_pending');
  });

  it('repeats the stored prompt without running and survives interrupt()', async () => {
    await h.pipeline.handle('run tests', 'typed');
    const prompt = lastResponse(h);

    await h.pipeline.handle('repeat', 'typed');
    h.pipeline.interrupt();

    expect(lastResponse(h)).toBe(prompt);
    expect(h.manager.pending()).not.toBeNull();
    expect(h.spawned).toEqual([]);
  });

  it('gives a different queued request its own presentation identity even with identical prompt text', async () => {
    await h.pipeline.handle('run tests', 'typed');
    h.manager.request({
      action: { type: 'RUN_TESTS' }, target: 'npm.cmd test', origin: 'agent', correlationId: 'agent-B',
    });
    const first = h.models.at(-1)!.pendingConfirmation!;

    await h.pipeline.handle('repeat', 'typed');
    expect(h.models.at(-1)!.pendingConfirmation).toEqual(first);

    await h.pipeline.decline();

    const second = h.models.at(-1)!;
    expect(second.statusKind).toBe('confirmation_pending');
    expect(second.pendingConfirmation!.promptText).toBe(first.promptText);
    expect(second.pendingConfirmation!.presentationKey).not.toBe(first.presentationKey);
    expect(h.manager.pending()).toMatchObject({ origin: 'agent', correlationId: 'agent-B' });
    expect(JSON.stringify(second.pendingConfirmation)).not.toMatch(/token|secret|password|api[_-]?key/i);
  });

  it('requires a fresh confirmation when the command changes while pending', async () => {
    await h.pipeline.handle('run tests', 'typed');
    setCommand('npm.cmd run other');

    await h.pipeline.handle('confirm', 'typed');
    expect(h.spawned).toEqual([]);
    expect(lastResponse(h)).toContain('Run tests using "npm.cmd run other"');
    expect(h.manager.pending()?.correlationId).toBe('local-1');

    const pending = h.pipeline.handle('confirm', 'typed');
    await flush();
    h.children[0]!.finish(0);
    await pending;
    expect(h.spawned).toEqual(['npm.cmd run other']);
  });

  it('resolves a pending RUN_TESTS as not_configured when the command becomes empty', async () => {
    h.store.set(summary());
    await h.pipeline.handle('run tests', 'typed');
    setCommand('');

    await h.pipeline.handle('confirm', 'typed');

    expect(lastResponse(h)).toBe(
      'No test command is configured. Set `kirosight.testCommand` in your workspace settings.',
    );
    expect(h.spawned).toEqual([]);
    expect(h.manager.pending()).toBeNull();
    expect(h.manager.queued()).toEqual([]);
    expect(h.store.get()).toEqual(summary());
    const everything = h.transcript.getEntries().map((entry) => entry.text).join('\n');
    expect(everything).not.toContain('Run tests using ""');
    expect(h.models.at(-1)!.statusKind).toBe('idle');
  });

  it('cannot be authorized later once the empty command invalidated the request', async () => {
    await h.pipeline.handle('run tests', 'typed');
    setCommand('');
    await h.pipeline.handle('confirm', 'typed');

    setCommand('npm.cmd test');
    await h.pipeline.handle('confirm', 'typed');
    await h.pipeline.handle('yes', 'typed');
    await h.pipeline.confirm();

    expect(h.spawned).toEqual([]);
    expect(h.manager.pending()).toBeNull();
  });

  it('also invalidates through the confirm control', async () => {
    await h.pipeline.handle('run tests', 'typed');
    setCommand('');

    await h.pipeline.confirm();

    expect(lastResponse(h)).toContain('kirosight.testCommand');
    expect(h.spawned).toEqual([]);
    expect(h.manager.pending()).toBeNull();
  });

  it('presents the next valid queued request after an invalidated RUN_TESTS', async () => {
    await h.pipeline.handle('run tests', 'typed');
    h.manager.request({
      action: { type: 'FOCUS_EDITOR' }, target: 'the editor', origin: 'agent', correlationId: 'agent-1',
    });
    setCommand('');

    await h.pipeline.handle('confirm', 'typed');

    expect(lastResponse(h)).toContain('kirosight.testCommand');
    expect(lastResponse(h)).toContain('Focus editor using "the editor"');
    expect(lastResponse(h)).not.toContain('Run tests using');
    expect(h.manager.pending()).toMatchObject({ correlationId: 'agent-1', origin: 'agent' });
    expect(h.spawned).toEqual([]);
    expect(h.models.at(-1)!.statusKind).toBe('confirmation_pending');
  });

  it('drops every queued RUN_TESTS while the command is empty', async () => {
    await h.pipeline.handle('run tests', 'typed');
    h.manager.request({ action: { type: 'RUN_TESTS' }, target: 'npm.cmd test', origin: 'agent', correlationId: 'agent-2' });
    setCommand('');

    await h.pipeline.handle('yes', 'typed');

    expect(h.manager.pending()).toBeNull();
    expect(lastResponse(h)).not.toContain('Run tests using');
    expect(h.spawned).toEqual([]);
  });

  it('stores the raw trusted command as the confirmation target, not decorated prompt text', async () => {
    const command = 'npm.cmd test -- --runInBand "quoted arg" C:\\fixture path\\tests';
    setCommand(`  ${command}  `);

    await h.pipeline.handle('please run my tests', 'typed');

    expect(h.manager.pending()!.target).toBe(readTestCommand());
    expect(h.manager.pending()!.target).toBe(command);
    expect(h.manager.pending()!.prompt).toContain(command);
    expect(h.manager.pending()!.prompt).toBe(formatConfirmation({ type: 'RUN_TESTS' }, command));
    expect(lastResponse(h)).toBe(`Run tests using "${command}"? Reply confirm, decline, cancel, or repeat.`);
  });
});

describe('failure queries', () => {
  it('reports deterministically when nothing is stored, without running tests or the agent', async () => {
    const h = build();

    await h.pipeline.handle('list all failures', 'typed');
    expect(lastResponse(h)).toBe(TEST_SUMMARY_UNAVAILABLE);
    await h.pipeline.handle('summarize the test failures', 'typed');
    expect(lastResponse(h)).toBe(TEST_SUMMARY_UNAVAILABLE);

    expect(h.spawned).toEqual([]);
    expect(h.agentCalls).toEqual([]);
    expect(h.manager.pending()).toBeNull();
  });

  it('lists stored failing names in order and summarizes with the existing formatter', async () => {
    const h = build();
    h.store.set(summary());

    await h.pipeline.handle('list all failures', 'typed');
    expect(lastResponse(h)).toBe('2 failed. Failing tests: alpha; beta.');
    await h.pipeline.handle('summarize the test failures', 'typed');
    expect(lastResponse(h)).toBe(formatTestResult(summary()));
    expect(h.agentCalls).toEqual([]);
    expect(h.spawned).toEqual([]);
  });

  it('lists at most 20 names and stays truthful about the true total', async () => {
    const h = build();
    const failingTests = Array.from({ length: 20 }, (_, i) => ({ name: `failure-${i + 1}` }));
    h.store.set(summary({ failed: 37, totalFailedNames: 37, failingTests }));

    await h.pipeline.handle('list all failures', 'typed');
    const text = lastResponse(h);

    expect(text).toContain('37 failed');
    expect(text).toContain('failure-1;');
    expect(text).toContain('failure-20.');
    expect(text).toContain('Showing 20 of 37');
    expect(text).toContain('KiroSight Tests');
  });

  it('does not fabricate names and handles passing and process-level runs', async () => {
    const h = build();
    h.store.set(summary({ failed: 3, failingTests: [] }));
    await h.pipeline.handle('list all failures', 'typed');
    expect(lastResponse(h)).toContain('3 failed. No failing test names were available.');
    expect(lastResponse(h)).not.toMatch(/Unknown|Unnamed|Failure 1/);

    h.store.set(summary({ outcome: 'passed', failed: 0, passed: 5, totalFailedNames: 0, failingTests: [] }));
    await h.pipeline.handle('list all failures', 'typed');
    expect(lastResponse(h)).toBe('The last test run has no failing tests.');

    h.store.set(summary({ outcome: 'timed_out', exitCode: null, passed: null, failed: null, totalFailedNames: 0, failingTests: [] }));
    await h.pipeline.handle('list all failures', 'typed');
    expect(lastResponse(h)).toContain('No failure list is available');
    expect(lastResponse(h)).toContain('timed out');
  });
});
