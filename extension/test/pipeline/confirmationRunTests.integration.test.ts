import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionExecutor } from '../../src/actions/actionExecutor';
import type { Action } from '../../src/actions/actionTypes';
import { ActionGate } from '../../src/confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from '../../src/confirmation/confirmationController';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';
import { ContextService } from '../../src/context/contextService';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import { SymbolService } from '../../src/context/symbolService';
import { route } from '../../src/intent/localIntentRouter';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import { InputPipeline, type AgentGateway } from '../../src/pipeline/inputPipeline';
import { LocalIntentHandler } from '../../src/pipeline/localIntentHandler';
import { formatConfirmation, formatConfirmationReprompt } from '../../src/response/responseFormatter';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { TestRunStore } from '../../src/testing/testRunStore';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ViewModel } from '../../src/webview/viewModel';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';
import { resetVscodeMock, setMockConfiguration, setMockWorkspace } from '../mocks/vscode';

const COMMAND = 'npm.cmd test -- --runInBand';
const RUN_TESTS: Action = { type: 'RUN_TESTS' };

function summary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: 'passed', command: COMMAND, exitCode: 0, passed: 3, failed: 0, totalFailedNames: 0,
    failingTests: [], outputTruncated: false, durationMs: 1, ...overrides,
  };
}

/** Real pipeline, handler, controller, gate, manager and executor; fakes only at the edges. */
function build() {
  resetVscodeMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration({ 'kirosight.testCommand': COMMAND, 'kirosight.testTimeoutSeconds': 5 });

  const state = { next: summary(), testRuns: 0 };
  const store = new TestRunStore();
  const adapter = new FakeEditorAdapter({});
  const diagnostics = new DiagnosticsService(adapter);
  const real = new ActionExecutor({
    adapter, diagnostics, files: new FileService(adapter), navigation: new NavigationService(adapter),
    testRunner: { run: async () => { state.testRuns += 1; return state.next; } },
    testRunStore: store,
  });
  const executed: Action[] = [];
  const executor = {
    execute: async (action: Action) => { executed.push(action); return real.execute(action); },
  };
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
    respond: async (text) => { agentCalls.push(text); return { status: 'not_handled', text: 'agent reply' }; },
  };
  const routed: string[] = [];
  const transcript = new TranscriptStore();
  const models: ViewModel[] = [];
  const pipeline = new InputPipeline({
    transcript, localIntents: handler, agent, confirmation: controller,
    route: (text) => { routed.push(text); return route(text); },
    onViewModel: (model) => { models.push(model); },
  });
  return { pipeline, manager, gate, store, state, executed, adapter, agentCalls, routed, transcript, models };
}

type Harness = ReturnType<typeof build>;

function responses(h: Harness): string[] {
  return h.transcript.getEntries().filter((entry) => entry.role === 'kirosight').map((entry) => entry.text);
}

function status(h: Harness): string {
  return h.models.at(-1)!.statusKind;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pending confirmation isolates input (Req 6.5, 6.6)', () => {
  it.each(['go to line 10', 'what errors are there'])(
    'answers %j with only the confirmation re-prompt',
    async (text) => {
      const h = build();
      await h.pipeline.handle('run my tests', 'typed');
      const routedBefore = h.routed.length;
      const entriesBefore = h.transcript.getEntries().length;
      const pending = h.manager.pending();

      await h.pipeline.handle(text, 'typed');

      const entries = h.transcript.getEntries();
      expect(entries).toHaveLength(entriesBefore + 2);
      expect(entries.at(-2)).toMatchObject({ role: 'user', text });
      expect(entries.at(-1)).toMatchObject({
        role: 'kirosight', text: formatConfirmationReprompt(RUN_TESTS),
      });
      expect(h.routed).toHaveLength(routedBefore);
      expect(h.routed).not.toContain(text);
      expect(h.agentCalls).toEqual([]);
      expect(h.executed).toEqual([]);
      expect(h.state.testRuns).toBe(0);
      expect(h.adapter.opened).toEqual([]);
      expect(h.adapter.revealed).toEqual([]);
      expect(h.manager.pending()).toBe(pending);
      expect(status(h)).toBe('confirmation_pending');
    },
  );

  it('treats ok and just do it as unrecognized while pending', async () => {
    const h = build();
    await h.pipeline.handle('run my tests', 'typed');

    for (const text of ['ok', 'just do it']) {
      await h.pipeline.handle(text, 'typed');
      expect(responses(h).at(-1)).toBe(formatConfirmationReprompt(RUN_TESTS));
    }

    expect(h.executed).toEqual([]);
    expect(h.manager.pending()).not.toBeNull();
  });
});

describe('no expiry (Req 5.4, 6.10)', () => {
  it('keeps the same confirmation pending after hours pass', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const h = build();
    await h.pipeline.handle('run my tests', 'typed');
    await h.gate.submit({
      action: { type: 'GO_TO_LINE', line: 3 }, target: 'line 3', origin: 'agent',
      correlationId: 'agent-B', confirmationRequired: true,
    });
    const pending = h.manager.pending();
    const queued = h.manager.queued();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);

    expect(h.manager.pending()).toBe(pending);
    expect(h.manager.pending()).toMatchObject({ target: COMMAND, origin: 'local', correlationId: 'local-1' });
    expect(h.manager.queued()).toEqual(queued);
    expect(h.executed).toEqual([]);
    expect(status(h)).toBe('confirmation_pending');

    await h.pipeline.handle('confirm', 'typed');
    expect(h.executed).toEqual([RUN_TESTS]);
  });
});

describe('FIFO hold queue and repeat (Req 6.7, 6.9)', () => {
  it('holds a second needs-confirmation request and confirms in order, once each', async () => {
    const h = build();
    await h.pipeline.handle('run my tests', 'typed');
    const promptA = h.manager.pending()!.prompt;

    const held = await h.gate.submit({
      action: { type: 'GO_TO_LINE', line: 3 }, target: 'line 3', origin: 'agent',
      correlationId: 'agent-B', confirmationRequired: true,
    });

    expect(held).toMatchObject({ kind: 'confirmation', state: 'queued' });
    expect(h.manager.pending()).toMatchObject({ correlationId: 'local-1', origin: 'local' });
    expect(h.manager.queued().map((r) => r.correlationId)).toEqual(['agent-B']);
    expect(h.executed).toEqual([]);

    await h.pipeline.handle('repeat', 'typed');
    expect(responses(h).at(-1)).toBe(promptA);
    expect(h.manager.pending()).toMatchObject({ correlationId: 'local-1', prompt: promptA });
    expect(h.manager.queued().map((r) => r.correlationId)).toEqual(['agent-B']);
    expect(h.executed).toEqual([]);
    expect(h.state.testRuns).toBe(0);
    expect(status(h)).toBe('confirmation_pending');

    await h.pipeline.handle('confirm', 'typed');
    expect(h.executed).toEqual([RUN_TESTS]);
    expect(h.state.testRuns).toBe(1);
    expect(h.manager.pending()).toMatchObject({ correlationId: 'agent-B', origin: 'agent', target: 'line 3' });
    expect(responses(h).at(-1)).toContain(formatConfirmation({ type: 'GO_TO_LINE', line: 3 }, 'line 3'));
    expect(status(h)).toBe('confirmation_pending');

    await h.pipeline.handle('confirm', 'typed');
    expect(h.executed).toEqual([RUN_TESTS, { type: 'GO_TO_LINE', line: 3 }]);
    expect(h.state.testRuns).toBe(1);
    expect(h.manager.pending()).toBeNull();
    expect(status(h)).toBe('idle');

    await h.pipeline.handle('confirm', 'typed');
    expect(h.executed).toHaveLength(2);
  });
});

describe('idle affirmatives authorize nothing (Req 6.8)', () => {
  it.each(['yes', 'ok', 'just do it'])('%j executes nothing and cannot authorize a later request', async (text) => {
    const h = build();

    await h.pipeline.handle(text, 'typed');

    expect(h.executed).toEqual([]);
    expect(h.state.testRuns).toBe(0);
    expect(h.manager.pending()).toBeNull();
    expect(h.manager.queued()).toEqual([]);
    expect(h.store.get()).toBeNull();

    await h.pipeline.handle('run my tests', 'typed');
    expect(h.manager.pending()).toMatchObject({ target: COMMAND });
    expect(h.executed).toEqual([]);
    expect(h.state.testRuns).toBe(0);
    expect(status(h)).toBe('confirmation_pending');

    await h.pipeline.handle('confirm', 'typed');
    expect(h.executed).toEqual([RUN_TESTS]);
    expect(h.state.testRuns).toBe(1);
  });
});

describe('did_not_execute is reported differently from a failing run (Req 7.1, 7.7)', () => {
  it('reports a command that could not execute and a real failing run distinctly', async () => {
    const failing = summary({
      outcome: 'failed', exitCode: 1, passed: 4, failed: 2, totalFailedNames: 2,
      failingTests: [{ name: 'alpha test' }, { name: 'beta test' }],
    });
    const h = build();

    h.state.next = failing;
    await h.pipeline.handle('run my tests', 'typed');
    await h.pipeline.handle('confirm', 'typed');
    const failedText = responses(h).at(-1)!;
    expect(h.store.get()).toMatchObject({ outcome: 'failed', passed: 4, failed: 2 });

    h.state.next = summary({
      outcome: 'did_not_execute', exitCode: 1, passed: null, failed: null,
    });
    await h.pipeline.handle('run my tests', 'typed');
    await h.pipeline.handle('confirm', 'typed');
    const notExecutedText = responses(h).at(-1)!;

    expect(h.state.testRuns).toBe(2);
    expect(h.store.get()).toMatchObject({ outcome: 'did_not_execute', passed: null, failed: null });
    expect(failedText).not.toBe(notExecutedText);
    expect(failedText).toContain('4 passed, 2 failed');
    expect(failedText).toContain('alpha test');
    expect(failedText).not.toContain('could not be executed');
    expect(notExecutedText).toBe('The configured test command could not be executed.');
    expect(notExecutedText).not.toMatch(/\d+ (passed|failed)|Tests failed|alpha test/);
    expect(status(h)).toBe('idle');
  });
});

describe('integration harness hygiene', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('spawns no OS process: the test runner is a fake', async () => {
    const h = build();
    await h.pipeline.handle('run my tests', 'typed');
    await h.pipeline.handle('confirm', 'typed');

    expect(h.state.testRuns).toBe(1);
  });
});
