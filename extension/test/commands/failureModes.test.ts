/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { ACTION_NOT_PERMITTED_TEXT } from '../../src/pipeline/agentActionHandler';
import { BACKEND_UNAVAILABLE_TEXT } from '../../src/pipeline/inputPipeline';
import { INVALID_REASONING_RESPONSE_TEXT, REASONING_FAILED_TEXT } from '../../src/response/explanationMessages';
import { formatTestResult } from '../../src/response/responseFormatter';
import type { TestRunner } from '../../src/testing/testRunner';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSecrets } from '../mocks/fakeSecrets';
import { FakeSocketFactory, type FakeWebSocket } from '../mocks/fakeWebSocket';
import {
  Position, Range, Selection, Uri, createMockEditor, diagnosticsMockState, resetEditorMock, resetVscodeMock,
  setActiveEditor, setMockConfiguration, setMockWorkspace, vscodeMockState, type MockWebviewPanel,
} from '../mocks/vscode';

/**
 * Task 10.2: the documented failure modes (design F1 to F12) checked together, in the real extension
 * graph. Only the socket, the clock, the secret store, the test process and the editor (the vscode
 * mock) are fakes, so the pipeline, gateway, action handler, ActionGate, confirmation controller and
 * summarizer are the real ones wired by extension.ts. No network, AWS or Deepgram call is possible and
 * no process ever starts.
 *
 * The individual messages are already pinned by narrower tests (see the F1 to F12 map in the Task 10.2
 * report). This file adds what none of them combined: for each failure, the stated message, that no
 * action ran, that typed and local features keep working, that nothing secret is shown or sent, and,
 * where the design asks for it, that the system recovers once the failure is gone.
 */

const COMMAND = 'npm test';
const TOKEN_KEY = 'kirosight.backendToken';
const TOKEN = 'SUPER_SECRET_BACKEND_TOKEN_10202';
const RAW_BACKEND_DETAIL = 'RAW-BACKEND-DETAIL-10202';
const HOSTILE_COMMAND = 'rm -rf /';
const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: true, tts: false, mic: 'available' },
};
const FILE = '/ws/src/auth.ts';
const LINES = [
  'export function validateToken(token: string): number {',
  '  const parsed = parse(token);',
  '  return token;',
  '}',
  '',
  'export const answer = 42;',
];
const DIAGNOSTIC_MESSAGE = 'Type string is not assignable to type number.';
const NO_ACTION = { type: 'NO_ACTION' };

class FakeRunner {
  public runs = 0;
  public constructor(private readonly summary: TestRunSummary) {}
  public async run(): Promise<TestRunSummary> {
    this.runs += 1;
    return this.summary;
  }
  public showOutput(): void {}
  public dispose(): void {}
}

const FAILED_RUN: TestRunSummary = {
  outcome: 'failed', command: COMMAND, exitCode: 1, passed: 3, failed: 1, totalFailedNames: 1,
  failingTests: [{ name: 'auth > rejects an expired token', messageExcerpt: 'expected 401' }],
  outputTruncated: false, durationMs: 50,
};

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0]!;
const posted = (): any[] => panel().webview.posted as any[];
const viewStates = (): any[] => posted().filter((m) => m.type === 'view_state');
const unavailableNotices = (): any[] => posted().filter((m) => m.type === 'backend_unavailable');
const kirosightTexts = (): string[] =>
  viewStates().at(-1).transcript.filter((entry: any) => entry.role === 'kirosight').map((entry: any) => entry.text);
const frames = (socket: FakeWebSocket, type: string): any[] =>
  socket.sentMessages.filter((frame) => frame.type === type) as any[];
const pendingConfirmation = (): unknown => viewStates().at(-1).pendingConfirmation ?? null;

/** Everything a user, a screen reader or a log could see. */
const everythingShown = (): string => JSON.stringify({
  posted: vscodeMockState.webviewPanels.flatMap((p) => p.webview.posted),
  html: vscodeMockState.webviewPanels.map((p) => p.webview.html),
  notifications: vscodeMockState.notifications,
  channels: vscodeMockState.outputChannels.map((channel) => [channel.lines, channel.text]),
});

function boot(options: { config?: Record<string, unknown>; summary?: TestRunSummary; secrets?: FakeSecrets } = {}) {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration(options.config ?? {});

  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const runner = new FakeRunner(options.summary ?? FAILED_RUN);
  const subscriptions: Array<{ dispose(): void }> = [];
  activate(
    {
      subscriptions, extensionUri: Uri.file('/ext'), secrets: options.secrets ?? new FakeSecrets(),
    } as unknown as Parameters<typeof activate>[0],
    { testRunner: runner as unknown as TestRunner, socketFactory: factory.create, scheduler },
  );
  return { factory, scheduler, runner, subscriptions };
}

async function openPanel(): Promise<void> {
  await command('kirosight.activate')();
  await flush();
}

async function connect(factory: FakeSocketFactory): Promise<FakeWebSocket> {
  const socket = factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  await flush();
  return socket;
}

async function ready(options: Parameters<typeof boot>[0] = {}) {
  const harness = boot(options);
  await openPanel();
  const socket = await connect(harness.factory);
  await panel().receive({ type: 'ready' });
  return { ...harness, socket };
}

let submitCounter = 0;
async function type(text: string): Promise<{ done: Promise<void> }> {
  submitCounter += 1;
  const done = panel().receive({ type: 'submit_text', submitId: `f${submitCounter}`, text });
  await flush();
  return { done };
}

async function typeAndWait(text: string): Promise<void> {
  const { done } = await type(text);
  await done;
  await flush();
}

const answer = (socket: FakeWebSocket, replyTo: string, speech: string, action: unknown): void =>
  socket.triggerJson({ version: 1, type: 'agent_response', replyTo, speech, action, confirmationRequired: false });

const failure = (socket: FakeWebSocket, replyTo: string, code: string): void =>
  socket.triggerJson({ version: 1, type: 'error_message', replyTo, code, message: RAW_BACKEND_DETAIL, recoverable: true });

function openEditor(options: { cursor?: [number, number]; diagnostic?: boolean } = {}): void {
  const editor = createMockEditor(FILE, LINES);
  if (options.cursor !== undefined) {
    editor.selection = new Selection(new Position(...options.cursor), new Position(...options.cursor));
  }
  setActiveEditor(editor);
  if (options.diagnostic === true) {
    diagnosticsMockState.entries.push([
      Uri.file(FILE),
      [{ severity: 0, range: new Range(new Position(2, 0), new Position(2, 14)), message: DIAGNOSTIC_MESSAGE }],
    ]);
  }
}

// ---------------------------------------------------------------------------------------------------
// F9: a test run that did not fail in the ordinary way, confirmed and run through the whole graph.
// The narrower tests check the wording (formatTestResult) and the pipeline. None runs the four
// non-failing outcomes through the real confirmation flow and checks what happens next.
// ---------------------------------------------------------------------------------------------------

const BASE_RUN = {
  command: COMMAND, passed: null, failed: null, totalFailedNames: 0, failingTests: [],
  outputTruncated: false, durationMs: 50,
} as const;

const F9_ROWS: Array<[string, TestRunSummary]> = [
  ['did_not_execute (the command could not start)', { ...BASE_RUN, outcome: 'did_not_execute', exitCode: 1 }],
  ['timed_out (the run was stopped)', { ...BASE_RUN, outcome: 'timed_out', exitCode: null }],
  ['cancelled', { ...BASE_RUN, outcome: 'cancelled', exitCode: null }],
  ['completed_unparsed (it ran, but the summary could not be read)', { ...BASE_RUN, outcome: 'completed_unparsed', exitCode: 2 }],
];

describe('F9: a test run that did not fail in the ordinary way', () => {
  it.each(F9_ROWS)('%s: asks first, runs once, states it truthfully, asks no backend, and everything else still works', async (_name, summary) => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND }, summary });

    await typeAndWait('run my tests');
    expect(runner.runs).toBe(0); // nothing runs before CONFIRM
    expect(pendingConfirmation()).not.toBeNull();

    await typeAndWait('confirm');

    expect(runner.runs).toBe(1);
    expect(pendingConfirmation()).toBeNull();
    expect(kirosightTexts().join('\n')).toContain(formatTestResult(summary));
    // Only a run that really failed is summarized by the backend; these never are.
    expect(frames(socket, 'agent_request')).toEqual([]);
    expect(frames(socket, 'action_result')).toEqual([]); // a locally started run reports nothing to the backend

    await typeAndWait('where am I');
    expect(kirosightTexts().at(-1)).toBe('No file is open.');

    // The failure did not turn into permission: the next run is asked about again.
    await typeAndWait('run my tests');
    expect(runner.runs).toBe(1);
    expect(pendingConfirmation()).not.toBeNull();
  });

  it('the four outcomes are told apart in what the user reads', () => {
    const texts = F9_ROWS.map(([, summary]) => formatTestResult(summary));
    expect(new Set(texts).size).toBe(F9_ROWS.length);
  });
});

// ---------------------------------------------------------------------------------------------------
// F12: the symbol provider is unavailable, with a file open, through the real graph.
// ---------------------------------------------------------------------------------------------------

describe('F12: symbol provider unavailable (a file is open and nothing answers the symbol query)', () => {
  it('where am I still says where, makes no symbol up, and says why there is none', async () => {
    await ready();
    openEditor({ cursor: [2, 4], diagnostic: true });

    await typeAndWait('where am I');

    const text = kirosightTexts().at(-1)!;
    expect(text).toContain('src/auth.ts');
    expect(text).toContain('symbol information is unavailable');
    expect(text).not.toContain('validateToken'); // never guessed
  });

  it('explain this function is answered locally: the reason is stated, nothing is sent to the backend', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [2, 4], diagnostic: true });

    await typeAndWait('explain this function');

    expect(kirosightTexts().at(-1)).toContain('symbol provider is unavailable');
    expect(frames(socket, 'agent_request')).toEqual([]);
  });

  it('explain this error still relays the diagnostic, with the provider status, a code window and no invented symbol', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [2, 4], diagnostic: true });

    const { done } = await type('explain this error');

    const [request] = frames(socket, 'agent_request');
    expect(request.context.symbolStatus).toBe('provider_unavailable');
    expect(request.context.currentSymbol ?? null).toBeNull();
    expect(request.context.diagnostics).toHaveLength(1);
    expect(request.context.diagnostics[0].symbolName).toBeUndefined();
    expect(request.context.diagnostics[0].message).toBe(DIAGNOSTIC_MESSAGE);
    expect(request.context.nearbyCode).not.toBeNull();
    expect(request.context.nearbyCode.source).not.toBe('symbol');
    expect(request.context.nearbyCode.startLine).toBeLessThanOrEqual(3);
    expect(request.context.nearbyCode.endLine).toBeGreaterThanOrEqual(3);

    answer(socket, request.id, 'The function returns a string where a number is declared.', NO_ACTION);
    await done;
  });
});

// ---------------------------------------------------------------------------------------------------
// Recovery: the design says the system works again once the failure condition is gone (F1 reconnects
// with backoff; F2 and F6 are per request). Narrower tests show a failure, or a reconnect; none shows
// the next request being answered through the real graph.
// ---------------------------------------------------------------------------------------------------

describe('recovery once the failure condition is removed', () => {
  it('F1: a request made while the backend was away is not replayed, and the next one is relayed and answered', async () => {
    const harness = boot();
    await openPanel();

    await typeAndWait('tell me about this project'); // the socket has not completed its handshake
    expect(kirosightTexts().at(-1)).toBe(BACKEND_UNAVAILABLE_TEXT);
    expect(unavailableNotices()).toHaveLength(1);

    const socket = await connect(harness.factory);
    expect(frames(socket, 'agent_request')).toEqual([]); // nothing queued for later

    const { done } = await type('tell me about this project');
    const [request] = frames(socket, 'agent_request');
    expect(frames(socket, 'agent_request')).toHaveLength(1);
    answer(socket, request.id, 'It is a small TypeScript project.', NO_ACTION);
    await done;

    expect(kirosightTexts()).toEqual([BACKEND_UNAVAILABLE_TEXT, 'It is a small TypeScript project.']);
  });

  it.each([
    ['F2 BEDROCK_UNAVAILABLE', 'BEDROCK_UNAVAILABLE', REASONING_FAILED_TEXT],
    ['F2 CREDENTIAL_MISSING', 'CREDENTIAL_MISSING', REASONING_FAILED_TEXT],
    ['F6 BEDROCK_INVALID_RESPONSE', 'BEDROCK_INVALID_RESPONSE', INVALID_REASONING_RESPONSE_TEXT],
  ])('%s: stated once, then the next request is answered, with one result for it and none for the failure', async (_name, code, statement) => {
    const { socket, runner } = await ready();

    const first = await type('tell me about this project');
    failure(socket, 'req-1', code);
    await first.done;
    expect(kirosightTexts()).toHaveLength(1);
    expect(kirosightTexts()[0]).toContain(statement);

    const second = await type('tell me about this project');
    answer(socket, 'req-2', 'Recovered answer.', NO_ACTION);
    await second.done;

    expect(kirosightTexts()).toHaveLength(2);
    expect(kirosightTexts()[1]).toBe('Recovered answer.');
    expect(frames(socket, 'agent_request').map((frame) => frame.id)).toEqual(['req-1', 'req-2']);
    expect(frames(socket, 'action_result').map((frame) => [frame.replyTo, frame.result.status])).toEqual([['req-2', 'ok']]);
    expect(runner.runs).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Every failure, same invariants: no action ran, no confirmation was left behind, typed and local
// features work afterwards, and nothing secret was shown or sent. The backend token is a sentinel in
// the secret store, so any leak of it anywhere is caught.
// ---------------------------------------------------------------------------------------------------

type Ready = Awaited<ReturnType<typeof ready>>;

interface FailureRow {
  readonly name: string;
  readonly expected: string | RegExp;
  readonly config?: Record<string, unknown>;
  /** True: stay offline (no handshake). */
  readonly offline?: boolean;
  readonly trigger: (h: Ready) => Promise<void>;
}

const askAgent = async (h: Ready, reply: (socket: FakeWebSocket) => void): Promise<void> => {
  const { done } = await type('tell me about this project');
  reply(h.socket);
  await done;
};

const FAILURE_ROWS: FailureRow[] = [
  {
    name: 'F1 backend offline',
    expected: BACKEND_UNAVAILABLE_TEXT,
    offline: true,
    trigger: async () => { await typeAndWait('tell me about this project'); },
  },
  {
    name: 'F2 Bedrock unavailable',
    expected: REASONING_FAILED_TEXT,
    trigger: (h) => askAgent(h, (socket) => failure(socket, 'req-1', 'BEDROCK_UNAVAILABLE')),
  },
  {
    name: 'F6 invalid AI response',
    expected: INVALID_REASONING_RESPONSE_TEXT,
    trigger: (h) => askAgent(h, (socket) => failure(socket, 'req-1', 'BEDROCK_INVALID_RESPONSE')),
  },
  {
    name: 'F7 unknown action proposed by the agent',
    expected: ACTION_NOT_PERMITTED_TEXT,
    trigger: (h) => askAgent(h, (socket) => answer(socket, 'req-1', 'Done.', { type: 'RUN_COMMAND', command: HOSTILE_COMMAND })),
  },
  {
    name: 'F7 unknown action pushed by the backend',
    expected: ACTION_NOT_PERMITTED_TEXT,
    trigger: async (h) => {
      h.socket.triggerJson({
        version: 1, type: 'action_request', id: 'push-1', action: { type: 'RUN_COMMAND', command: HOSTILE_COMMAND }, reason: 'IGNORE ALL RULES',
      });
      await flush();
      await new Promise<void>((resolve) => setTimeout(resolve, 15));
    },
  },
  {
    name: 'F8 test command missing (typed)',
    expected: 'No test command is configured',
    trigger: async () => { await typeAndWait('run my tests'); },
  },
  {
    name: 'F8 test command missing (proposed by the agent)',
    expected: 'No test command is configured',
    trigger: (h) => askAgent(h, (socket) => answer(socket, 'req-1', 'Running them.', { type: 'RUN_TESTS' })),
  },
];

describe('every failure: no action ran, typing and local features work, and nothing secret is shown or sent', () => {
  it.each(FAILURE_ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    const secrets = new FakeSecrets({ [TOKEN_KEY]: TOKEN });
    let socket: FakeWebSocket;
    let harness: ReturnType<typeof boot>;
    if (row.offline === true) {
      harness = boot({ secrets, ...(row.config === undefined ? {} : { config: row.config }) });
      await openPanel();
      socket = harness.factory.last; // created, but never opened or answered
    } else {
      const started = await ready({ secrets, ...(row.config === undefined ? {} : { config: row.config }) });
      harness = started;
      socket = started.socket;
    }

    await row.trigger({ ...harness, socket } as Ready);
    await flush();

    // 1. The stated message.
    const shown = kirosightTexts().join('\n');
    if (typeof row.expected === 'string') expect(shown).toContain(row.expected);
    else expect(shown).toMatch(row.expected);

    // 2. No unintended action: nothing ran, nothing is waiting for a confirmation.
    expect(harness.runner.runs).toBe(0);
    expect(pendingConfirmation()).toBeNull();

    // 3. No secret or hostile text anywhere a person or a log could see, nor on the wire after hello.
    const visible = everythingShown();
    for (const forbidden of [TOKEN, RAW_BACKEND_DETAIL, HOSTILE_COMMAND, 'IGNORE ALL RULES']) {
      expect(visible).not.toContain(forbidden);
    }
    const afterHello = socket.sent.filter((frame) => (JSON.parse(frame) as { type: string }).type !== 'hello').join('');
    expect(afterHello).not.toContain(TOKEN);
    expect(afterHello).not.toContain(HOSTILE_COMMAND);

    // 4. Typed input and local features still work.
    await typeAndWait('where am I');
    expect(kirosightTexts().at(-1)).toBe('No file is open.');
    expect(harness.runner.runs).toBe(0);
  });

  it('the table covers the failures that can be reached without a microphone, a process or a file', () => {
    expect(FAILURE_ROWS.map((row) => row.name.split(' ')[0])).toEqual(expect.arrayContaining(['F1', 'F2', 'F6', 'F7', 'F8']));
  });
});