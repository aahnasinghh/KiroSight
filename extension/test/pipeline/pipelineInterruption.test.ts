import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ActionExecutor } from '../../src/actions/actionExecutor';
import type { Action } from '../../src/actions/actionTypes';
import { ActionGate } from '../../src/confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from '../../src/confirmation/confirmationController';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';
import { ContextService } from '../../src/context/contextService';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import { SymbolService } from '../../src/context/symbolService';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import {
  InputPipeline,
  type AgentGateway,
  type AgentGatewayResult,
  type AgentRelayInfo,
  type BackendUnavailableNotice,
  type InterruptionPort,
} from '../../src/pipeline/inputPipeline';
import { LocalIntentHandler } from '../../src/pipeline/localIntentHandler';
import { RequestTracker } from '../../src/pipeline/requestTracker';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { TestRunStore } from '../../src/testing/testRunStore';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ViewModel } from '../../src/webview/viewModel';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';
import { resetVscodeMock, setMockConfiguration, setMockWorkspace } from '../mocks/vscode';

/**
 * Task 9.5: what an interruption (Escape, push-to-talk start, the stop command) or a new utterance
 * does inside the pipeline: bump the RequestTracker lane, cancel the agent requests in flight,
 * drop their late answers, stop spoken output, and leave the Transcript and any pending
 * confirmation exactly as they were. Fakes only.
 */
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => { resolveFn = resolve; rejectFn = reject; });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

class FakeGateway implements AgentGateway {
  public available = true;
  public throwOnRespond = false;
  public throwOnCancel = false;
  public readonly calls: Array<{ text: string; info: AgentRelayInfo | undefined }> = [];
  public readonly cancelled: number[] = [];
  public readonly replies: Array<Deferred<AgentGatewayResult>> = [];

  public isAvailable(): boolean { return this.available; }

  public respond(text: string, info?: AgentRelayInfo): Promise<AgentGatewayResult> {
    if (this.throwOnRespond) throw new Error('gateway broke');
    this.calls.push({ text, info });
    const reply = deferred<AgentGatewayResult>();
    this.replies.push(reply);
    return reply.promise;
  }

  public cancel(requestId: number): void {
    if (this.throwOnCancel) throw new Error('cancel broke');
    this.cancelled.push(requestId);
  }

  public idOf(call: number): number { return this.calls[call]!.info!.requestId; }
}

class FakeInterruption implements InterruptionPort {
  public speechStops = 0;
  public voiceCancels = 0;
  public throwOnSpeech = false;
  public throwOnVoice = false;

  public stopSpeaking(): boolean {
    this.speechStops += 1;
    if (this.throwOnSpeech) throw new Error('speech broke');
    return true;
  }

  public cancelVoiceInput(): void {
    this.voiceCancels += 1;
    if (this.throwOnVoice) throw new Error('voice broke');
  }
}

function build() {
  const gateway = new FakeGateway();
  const interruption = new FakeInterruption();
  const tracker = new RequestTracker();
  const transcript = new TranscriptStore();
  const models: ViewModel[] = [];
  const notices: BackendUnavailableNotice[] = [];
  const local: string[] = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async (intent) => { local.push(intent.kind); return `local: ${intent.kind}`; } },
    agent: gateway,
    tracker,
    interruption,
    onViewModel: (model) => models.push(model),
    onBackendUnavailable: (notice) => notices.push(notice),
  });
  const answers = () => transcript.getEntries().filter((e) => e.role === 'kirosight').map((e) => e.text);
  return { pipeline, gateway, interruption, tracker, transcript, models, notices, local, answers };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  vi.useRealTimers();
  expect(unhandled).toEqual([]);
});

describe('interrupt(): in-flight agent work', () => {
  it('bumps the lane, cancels that agent request, stops speech and drops the late answer', async () => {
    const h = build();
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();
    const id = h.gateway.idOf(0);
    expect(h.tracker.isCurrent(id)).toBe(true);
    const lane = h.tracker.current();
    const stopsBefore = h.interruption.speechStops; // the submission itself stopped speech once
    const cancelsBefore = h.interruption.voiceCancels;

    h.pipeline.interrupt();

    expect(h.tracker.current()).toBeGreaterThan(lane);
    expect(h.tracker.isCurrent(id)).toBe(false);
    expect(h.gateway.cancelled).toEqual([id]);
    expect(h.interruption.speechStops).toBe(stopsBefore + 1);
    expect(h.interruption.voiceCancels).toBe(cancelsBefore); // Escape's voice cancel is the panel hook's job

    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'a late answer' });
    await expect(done).resolves.toBe('handled');
    expect(h.answers()).toEqual([]);
    expect(h.models.at(-1)!.latest).toBeNull();
  });

  it('drops a late "backend unavailable" result without any notice or Transcript entry', async () => {
    const h = build();
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();

    h.pipeline.interrupt();
    h.gateway.replies[0]!.resolve({ status: 'not_handled', text: 'cannot reach it', unavailable: true });
    await done;

    expect(h.notices).toEqual([]);
    expect(h.answers()).toEqual([]);
  });

  it('ends the interrupted submission at once, even if the backend never answers it', async () => {
    const h = build();
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();

    h.pipeline.interrupt();

    await expect(done).resolves.toBe('handled'); // does not wait for replies[0]
    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'much later' });
    await flush();
    expect(h.answers()).toEqual([]);
  });

  it('a gateway failure after the interruption is not reported', async () => {
    const h = build();
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();
    h.pipeline.interrupt();
    await done;

    h.gateway.replies[0]!.reject(new Error('late failure')); // must not become an unhandled rejection
    await flush();

    expect(h.answers()).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('keeps later requests valid: they are sent with new ids and answered', async () => {
    const h = build();
    const first = h.pipeline.handle('explain this error', 'typed');
    await flush();
    h.pipeline.interrupt();

    const second = h.pipeline.handle('why is this function slow', 'typed');
    await flush();
    const newId = h.gateway.idOf(1);
    expect(newId).not.toBe(h.gateway.idOf(0));
    expect(h.tracker.isCurrent(newId)).toBe(true);

    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'old answer' });
    h.gateway.replies[1]!.resolve({ status: 'handled', text: 'new answer' });
    await Promise.all([first, second]);

    expect(h.answers()).toEqual(['new answer']);
    expect(h.gateway.cancelled).toEqual([h.gateway.idOf(0)]); // the new request was never cancelled
  });

  it('cancels each request once however often the user interrupts', async () => {
    const h = build();
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();

    h.pipeline.interrupt();
    h.pipeline.interrupt();
    h.pipeline.interrupt();
    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'late' });
    await done;

    expect(h.gateway.cancelled).toEqual([h.gateway.idOf(0)]);
    expect(h.answers()).toEqual([]);
  });

  it('is safe with nothing in flight, nothing speaking, and no interruption port at all', async () => {
    const h = build();
    expect(() => h.pipeline.interrupt()).not.toThrow();
    expect(h.gateway.cancelled).toEqual([]);
    expect(h.models.at(-1)!.statusKind).toBe('idle');

    const bare = new InputPipeline({ transcript: new TranscriptStore(), localIntents: { handleIntent: async () => 'ok' } });
    expect(() => bare.interrupt()).not.toThrow();
  });

  it('does not cancel an answer that already arrived', async () => {
    const h = build();
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();
    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'answer' });
    await done;

    h.pipeline.interrupt();

    expect(h.gateway.cancelled).toEqual([]);
    expect(h.answers()).toEqual(['answer']);
  });
});

describe('a new utterance', () => {
  it('cancels only the older in-flight request; the new one is answered and the old answer dropped', async () => {
    const h = build();
    const first = h.pipeline.handle('explain this error', 'typed');
    await flush();
    const second = h.pipeline.handle('why is this function slow', 'typed');
    await flush();

    expect(h.gateway.cancelled).toEqual([h.gateway.idOf(0)]);
    expect(h.gateway.calls).toHaveLength(2);

    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'old' });
    h.gateway.replies[1]!.resolve({ status: 'handled', text: 'new' });
    await Promise.all([first, second]);

    expect(h.answers()).toEqual(['new']);
    expect(h.gateway.cancelled).toEqual([h.gateway.idOf(0)]);
  });

  it('a local command also supersedes the agent request in flight and still answers', async () => {
    const h = build();
    const agent = h.pipeline.handle('explain this error', 'typed');
    await flush();

    await expect(h.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'old agent answer' });
    await agent;

    expect(h.gateway.cancelled).toEqual([h.gateway.idOf(0)]);
    expect(h.answers()).toEqual(['local: WHERE_AM_I']);
  });

  it('stops speech, and a typed utterance also cancels voice input; a spoken one does not cancel itself', async () => {
    const h = build();

    await h.pipeline.handle('where am I', 'typed');
    expect(h.interruption.speechStops).toBe(1);
    expect(h.interruption.voiceCancels).toBe(1);

    await h.pipeline.handle('where am I', 'voice');
    expect(h.interruption.speechStops).toBe(2);
    expect(h.interruption.voiceCancels).toBe(1);
  });

  it('empty input is discarded without interrupting anything', async () => {
    const h = build();
    await expect(h.pipeline.handle('   ', 'typed')).resolves.toBe('discarded');
    expect(h.interruption.speechStops).toBe(0);
    expect(h.interruption.voiceCancels).toBe(0);
  });
});

describe('failures never block the pipeline', () => {
  it('a gateway whose cancel throws still has its answer dropped', async () => {
    const h = build();
    h.gateway.throwOnCancel = true;
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();

    expect(() => h.pipeline.interrupt()).not.toThrow();
    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'late' });
    await done;

    expect(h.answers()).toEqual([]);
  });

  it('a gateway without cancel support still drops the answer', async () => {
    const gateway = new FakeGateway();
    const bare: AgentGateway = { isAvailable: () => true, respond: (t, i) => gateway.respond(t, i) };
    const transcript = new TranscriptStore();
    const pipeline = new InputPipeline({ transcript, localIntents: { handleIntent: async () => 'ok' }, agent: bare });
    const done = pipeline.handle('explain this error', 'typed');
    await flush();

    pipeline.interrupt();
    gateway.replies[0]!.resolve({ status: 'handled', text: 'late' });
    await done;

    expect(transcript.getEntries().filter((e) => e.role === 'kirosight')).toEqual([]);
  });

  it('a speech stop or voice cancel that throws does not stop typed input', async () => {
    const h = build();
    h.interruption.throwOnSpeech = true;
    h.interruption.throwOnVoice = true;

    await expect(h.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    expect(() => h.pipeline.interrupt()).not.toThrow();

    expect(h.answers()).toEqual(['local: WHERE_AM_I']);
  });

  it('a gateway that throws while handing over leaves nothing to cancel later', async () => {
    const h = build();
    h.gateway.throwOnRespond = true;

    await expect(h.pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');
    h.pipeline.interrupt();

    expect(h.gateway.cancelled).toEqual([]);
  });

  it('typed input keeps working after any number of interruptions', async () => {
    const h = build();
    h.pipeline.interrupt();
    h.pipeline.interrupt();

    await expect(h.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    await expect(h.pipeline.handle('next error', 'typed')).resolves.toBe('handled');

    expect(h.answers()).toEqual(['local: WHERE_AM_I', 'local: ACTION']);
  });
});

describe('the Transcript', () => {
  it('keeps every entry exactly as it was: nothing deleted, shortened or replaced', async () => {
    const h = build();
    await h.pipeline.handle('where am I', 'typed');
    const done = h.pipeline.handle('explain this error', 'typed');
    await flush();
    const before = JSON.stringify(h.transcript.getEntries());

    h.pipeline.interrupt();
    h.gateway.replies[0]!.resolve({ status: 'handled', text: 'late' });
    await done;

    expect(JSON.stringify(h.transcript.getEntries())).toBe(before);
  });
});

// --- confirmation safety, with the real manager, gate, controller and executor ---

const COMMAND = 'npm.cmd test -- --runInBand';
const RUN_TESTS: Action = { type: 'RUN_TESTS' };

function summary(): TestRunSummary {
  return {
    outcome: 'passed', command: COMMAND, exitCode: 0, passed: 3, failed: 0, totalFailedNames: 0,
    failingTests: [], outputTruncated: false, durationMs: 1,
  };
}

function buildConfirming() {
  resetVscodeMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration({ 'kirosight.testCommand': COMMAND, 'kirosight.testTimeoutSeconds': 5 });

  const state = { testRuns: 0 };
  const adapter = new FakeEditorAdapter({});
  const diagnostics = new DiagnosticsService(adapter);
  const store = new TestRunStore();
  const real = new ActionExecutor({
    adapter, diagnostics, files: new FileService(adapter), navigation: new NavigationService(adapter),
    testRunner: { run: async () => { state.testRuns += 1; return summary(); } },
    testRunStore: store,
  });
  const executed: Action[] = [];
  const executor = { execute: async (action: Action) => { executed.push(action); return real.execute(action); } };
  const manager = new ConfirmationManager(currentTestTarget);
  const gate = new ActionGate({ confirmations: manager, executor });
  const controller = new GateConfirmationController(gate, manager);
  const symbols = new SymbolService(adapter);
  const handler = new LocalIntentHandler({
    context: new ContextService(adapter, symbols, diagnostics), diagnostics, symbols,
    actions: executor, gate, testRuns: store,
  });
  const gateway = new FakeGateway();
  const interruption = new FakeInterruption();
  const transcript = new TranscriptStore();
  const models: ViewModel[] = [];
  const pipeline = new InputPipeline({
    transcript, localIntents: handler, agent: gateway, confirmation: controller, interruption,
    onViewModel: (model) => models.push(model),
  });
  return { pipeline, manager, executed, state, gateway, interruption, transcript, models };
}

describe('a pending confirmation survives an interruption', () => {
  it('is neither approved, declined, executed nor cleared, and can still be confirmed afterwards', async () => {
    const h = buildConfirming();
    await h.pipeline.handle('run my tests', 'typed');
    const pending = h.manager.pending();
    expect(pending).not.toBeNull();
    const entries = h.transcript.getEntries().length;

    h.pipeline.interrupt();
    h.pipeline.interrupt();

    expect(h.manager.pending()).toBe(pending);
    expect(h.executed).toEqual([]);
    expect(h.state.testRuns).toBe(0);
    expect(h.transcript.getEntries()).toHaveLength(entries);
    expect(h.models.at(-1)!.statusKind).toBe('confirmation_pending');
    expect(h.models.at(-1)!.pendingConfirmation).not.toBeNull();

    await h.pipeline.confirm();
    expect(h.executed).toEqual([RUN_TESTS]);
    expect(h.state.testRuns).toBe(1);
    expect(h.manager.pending()).toBeNull();
  });

  it('can still be declined afterwards, and then nothing runs', async () => {
    const h = buildConfirming();
    await h.pipeline.handle('run my tests', 'typed');

    h.pipeline.interrupt();
    await h.pipeline.decline();

    expect(h.executed).toEqual([]);
    expect(h.state.testRuns).toBe(0);
    expect(h.manager.pending()).toBeNull();
  });

  it('a new utterance while it is pending stops speech but only gets the confirmation re-prompt', async () => {
    const h = buildConfirming();
    await h.pipeline.handle('run my tests', 'typed');
    const pending = h.manager.pending();
    const stopsBefore = h.interruption.speechStops;

    await h.pipeline.handle('go to line 10', 'typed');

    expect(h.interruption.speechStops).toBe(stopsBefore + 1);
    expect(h.manager.pending()).toBe(pending);
    expect(h.executed).toEqual([]);
    expect(h.gateway.calls).toEqual([]);
    expect(h.models.at(-1)!.statusKind).toBe('confirmation_pending');
  });
});
