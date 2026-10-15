/* eslint-disable @typescript-eslint/no-explicit-any */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BACKEND_UNAVAILABLE_TEXT } from '../../src/pipeline/inputPipeline';
import { activate } from '../../src/extension';
import {
  INVALID_REASONING_RESPONSE_TEXT,
  REASONING_FAILED_TEXT,
  noMatchingDiagnosticText,
} from '../../src/response/explanationMessages';
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
 * Task 7.13: the Milestone 7 pieces assembled in the real extension graph. Only the socket, the
 * clock, the secret store, the test process and the editor (the vscode mock) are fakes, so the
 * pipeline, gateway, action handler, gate, confirmation controller and summarizer are the real
 * ones wired by extension.ts. No network or AWS call is possible.
 */

const COMMAND = 'npm test';
// These tests are about reasoning and actions, not voice. The backend reports working speech
// recognition and microphone so the voice layer (Task 8.13) stays ready and leaves the status label
// to the agent and confirmation states under test.
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
const FAILED_RUN: TestRunSummary = {
  outcome: 'failed', command: COMMAND, exitCode: 1, passed: 3, failed: 1, totalFailedNames: 1,
  failingTests: [{ name: 'auth > rejects an expired token', messageExcerpt: 'expected 401' }],
  outputTruncated: false, durationMs: 50,
};

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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Long enough for the deferred (setTimeout 0) transcript append of a late summary. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 15));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0]!;
const posted = (): any[] => panel().webview.posted as any[];
const viewStates = (): any[] => posted().filter((m) => m.type === 'view_state');
const acks = (): any[] => posted().filter((m) => m.type === 'submit_ack');
const unavailableNotices = (): any[] => posted().filter((m) => m.type === 'backend_unavailable');
const kirosightTexts = (): string[] =>
  viewStates().at(-1).transcript.filter((entry: any) => entry.role === 'kirosight').map((entry: any) => entry.text);
const frames = (socket: FakeWebSocket, type: string): any[] =>
  socket.sentMessages.filter((frame) => frame.type === type) as any[];

function boot(options: { config?: Record<string, unknown>; summary?: TestRunSummary } = {}) {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration(options.config ?? {});

  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const runner = new FakeRunner(options.summary ?? FAILED_RUN);
  const subscriptions: Array<{ dispose(): void }> = [];
  activate(
    { subscriptions, extensionUri: Uri.file('/ext'), secrets: new FakeSecrets() } as unknown as Parameters<typeof activate>[0],
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

/** A panel that is open and a backend that has completed its handshake. */
async function ready(options: Parameters<typeof boot>[0] = {}) {
  const harness = boot(options);
  await openPanel();
  const socket = await connect(harness.factory);
  await panel().receive({ type: 'ready' });
  return { ...harness, socket };
}

let submitCounter = 0;
/** Types `text` into the panel. Returns once the pipeline has had time to relay it. */
async function type(text: string): Promise<{ done: Promise<void>; submitId: string }> {
  submitCounter += 1;
  const submitId = `s${submitCounter}`;
  const done = panel().receive({ type: 'submit_text', submitId, text });
  await flush();
  return { done, submitId };
}

async function typeAndWait(text: string): Promise<void> {
  const { done } = await type(text);
  await done;
  await flush();
}

function answer(socket: FakeWebSocket, replyTo: string, speech: string, action: unknown, confirmationRequired = false): void {
  socket.triggerJson({ version: 1, type: 'agent_response', replyTo, speech, action, confirmationRequired });
}

function failure(socket: FakeWebSocket, replyTo: string, code: string): void {
  socket.triggerJson({ version: 1, type: 'error_message', replyTo, code, message: 'RAW-BACKEND-DETAIL', recoverable: true });
}

function symbol(startLine: number, endLine: number) {
  const range = new Range(new Position(startLine, 0), new Position(endLine, 1));
  return { name: 'validateToken', kind: 11, range, selectionRange: range, children: [] };
}

/** An open editor on FILE. `cursor` and `selection` are zero-based [line, column]. */
function openEditor(options: {
  cursor?: [number, number];
  selection?: [[number, number], [number, number]];
  symbols?: Array<ReturnType<typeof symbol>>;
  diagnostic?: boolean;
} = {}): void {
  const editor = createMockEditor(FILE, LINES);
  if (options.selection !== undefined) {
    const [anchor, active] = options.selection;
    editor.selection = new Selection(new Position(...anchor), new Position(...active));
  } else if (options.cursor !== undefined) {
    editor.selection = new Selection(new Position(...options.cursor), new Position(...options.cursor));
  }
  setActiveEditor(editor);
  if (options.symbols !== undefined) {
    vscodeMockState.commandResults.set('vscode.executeDocumentSymbolProvider', options.symbols);
  }
  if (options.diagnostic === true) {
    diagnosticsMockState.entries.push([
      Uri.file(FILE),
      [{ severity: 0, range: new Range(new Position(2, 0), new Position(2, 14)), message: DIAGNOSTIC_MESSAGE }],
    ]);
  }
}

describe('typed explanation requests, end to end', () => {
  it('explains the error at the cursor: a grounded request out, the answer in the transcript', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [2, 4], symbols: [symbol(0, 3)], diagnostic: true });

    const { done, submitId } = await type('explain this error');

    const [request] = frames(socket, 'agent_request');
    expect(frames(socket, 'agent_request')).toHaveLength(1);
    expect(request).toMatchObject({
      version: 1, kind: 'utterance', id: 'req-1', utterance: { text: 'explain this error', source: 'typed' },
    });
    expect(request.context.diagnostics).toHaveLength(1);
    expect(request.context.diagnostics[0]).toMatchObject({
      severity: 'error', relativePath: 'src/auth.ts', line: 3, message: DIAGNOSTIC_MESSAGE, symbolName: 'validateToken',
    });
    expect(request.context.nearbyCode).toMatchObject({ source: 'symbol', startLine: 1, endLine: 4 });
    expect(JSON.stringify(request)).not.toContain('/ws/');
    expect(JSON.stringify(request)).not.toContain('activeFile');

    const speech = 'The function returns a string where a number is declared.';
    answer(socket, 'req-1', speech, { type: 'NO_ACTION' });
    await done;
    await flush();

    expect(acks().at(-1)).toEqual({ type: 'submit_ack', submitId, status: 'handled' });
    expect(kirosightTexts()).toEqual([speech]);
    expect(viewStates().at(-1)).toMatchObject({ latest: speech, statusKind: 'idle' });
    // The one correlated result for the (no-op) action; no confirmation was asked.
    expect(frames(socket, 'action_result')).toEqual([
      { version: 1, type: 'action_result', replyTo: 'req-1', result: { actionType: 'NO_ACTION', status: 'ok', message: 'No action was taken.' } },
    ]);
  });

  it('explains the function around the cursor with the symbol as its code and no diagnostics', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [1, 2], symbols: [symbol(0, 3)], diagnostic: true });

    const { done } = await type('explain this function');

    const [request] = frames(socket, 'agent_request');
    expect(request.context.nearbyCode).toMatchObject({ source: 'symbol', startLine: 1, endLine: 4 });
    expect(request.context.currentSymbol).toMatchObject({ name: 'validateToken', startLine: 1, endLine: 4 });
    expect(request.context.diagnostics).toEqual([]);
    answer(socket, request.id, 'It validates a token.', { type: 'NO_ACTION' });
    await done;
  });

  it('explains the selection with the selected lines as its code', async () => {
    const { socket } = await ready();
    openEditor({ selection: [[1, 2], [2, 8]], symbols: [symbol(0, 3)] });

    const { done } = await type('explain the selection');

    const [request] = frames(socket, 'agent_request');
    expect(request.context.nearbyCode).toMatchObject({ source: 'selection', startLine: 2, endLine: 3 });
    expect(request.context.selection).toMatchObject({ isEmpty: false });
    answer(socket, request.id, 'It parses and returns the token.', { type: 'NO_ACTION' });
    await done;
  });

  it('stays an ordinary agent request for text that is not an explanation phrase', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [2, 4], diagnostic: true });

    const { done } = await type('tell me about this project');

    const [request] = frames(socket, 'agent_request');
    expect(request.utterance.text).toBe('tell me about this project');
    expect(request.context.diagnostics).toHaveLength(1); // the ordinary bounded context
    answer(socket, request.id, 'It is a small service.', { type: 'NO_ACTION' });
    await done;
    expect(kirosightTexts()).toEqual(['It is a small service.']);
  });
});

describe('nothing to explain is reported locally, without the backend', () => {
  it('reports no matching diagnostic when no file is open', async () => {
    const { socket } = await ready();

    await typeAndWait('explain this error');

    expect(kirosightTexts()).toEqual([noMatchingDiagnosticText(null)]);
    expect(socket.sentMessages.map((frame) => frame.type)).toEqual(['hello']);
    expect(acks().at(-1)).toMatchObject({ status: 'handled' });
  });

  it('reports no matching diagnostic when the file has none', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [0, 0] });

    await typeAndWait('explain this error');

    expect(kirosightTexts()).toEqual([noMatchingDiagnosticText('src/auth.ts')]);
    expect(frames(socket, 'agent_request')).toEqual([]);
  });

  it.each([
    ['explain this function', { cursor: [4, 0] as [number, number], symbols: [symbol(0, 1)] }],
    ['explain the selection', { cursor: [1, 0] as [number, number], symbols: [symbol(0, 3)] }],
  ])('reports that no function or selection is available for "%s"', async (text, editor) => {
    const { socket } = await ready();
    openEditor(editor);

    await typeAndWait(text);

    expect(kirosightTexts()).toHaveLength(1);
    expect(kirosightTexts()[0]).toMatch(/^No function or selection is available to explain\. /);
    expect(frames(socket, 'agent_request')).toEqual([]);
  });

  it('still reports it locally, with no unavailable notice, while the backend is offline', async () => {
    boot();
    await openPanel();
    await panel().receive({ type: 'ready' });

    await typeAndWait('explain this error');

    expect(kirosightTexts()).toEqual([noMatchingDiagnosticText(null)]);
    expect(unavailableNotices()).toEqual([]);
    expect(acks().at(-1)).toMatchObject({ status: 'handled' });
  });
});

describe('backend unavailable and reasoning failures', () => {
  it('says the backend cannot be reached for a groundable explanation, sends nothing, and keeps local commands', async () => {
    const { factory } = boot();
    await openPanel();
    await panel().receive({ type: 'ready' });
    openEditor({ cursor: [2, 4], diagnostic: true });

    await typeAndWait('explain this error');
    await typeAndWait('where am I');

    expect(unavailableNotices()).toEqual([{ type: 'backend_unavailable', kind: 'text', message: BACKEND_UNAVAILABLE_TEXT }]);
    expect(acks().map((ack) => ack.status)).toEqual(['not_handled', 'handled']);
    expect(factory.last.sentMessages).toEqual([]);
  });

  it.each([
    ['BEDROCK_UNAVAILABLE', REASONING_FAILED_TEXT],
    ['CREDENTIAL_MISSING', REASONING_FAILED_TEXT],
    ['BEDROCK_INVALID_RESPONSE', INVALID_REASONING_RESPONSE_TEXT],
  ])('shows a stated error for %s, never the backend text, and local commands keep working', async (code, statement) => {
    const { socket } = await ready();
    openEditor({ cursor: [2, 4], diagnostic: true });

    const { done, submitId } = await type('explain this error');
    failure(socket, 'req-1', code);
    await done;
    await flush();

    expect(kirosightTexts()).toHaveLength(1);
    expect(kirosightTexts()[0]).toContain(statement);
    expect(JSON.stringify(viewStates().at(-1))).not.toContain('RAW-BACKEND-DETAIL');
    expect(acks().at(-1)).toEqual({ type: 'submit_ack', submitId, status: 'not_handled' });
    expect(viewStates().at(-1).statusKind).toBe('error');
    // Nothing was proposed, so nothing is answered and nothing ran.
    expect(frames(socket, 'action_result')).toEqual([]);

    await typeAndWait('where am I');
    expect(acks().at(-1)).toMatchObject({ status: 'handled' });
  });

  it('gives a reasoning failure no second chance on another provider: exactly one request is sent', async () => {
    const { socket } = await ready();
    openEditor({ cursor: [2, 4], diagnostic: true });

    const { done } = await type('explain this error');
    failure(socket, 'req-1', 'BEDROCK_UNAVAILABLE');
    await done;
    await settle();

    expect(frames(socket, 'agent_request')).toHaveLength(1);
  });
});

describe('actions proposed by an answer', () => {
  it('runs a safe action once, without a prompt, and answers once with the same correlation id', async () => {
    const { socket } = await ready();

    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Focusing the editor.', { type: 'FOCUS_EDITOR' });
    await done;
    await flush();

    expect(vscodeMockState.executedCommands.filter((c) => c === 'workbench.action.focusFirstEditorGroup')).toHaveLength(1);
    expect(kirosightTexts()).toEqual(['Focusing the editor. Focused the editor.']);
    expect(frames(socket, 'action_result')).toHaveLength(1);
    expect(frames(socket, 'action_result')[0]).toMatchObject({ replyTo: 'req-1', result: { actionType: 'FOCUS_EDITOR', status: 'ok' } });
    expect(viewStates().at(-1).pendingConfirmation ?? null).toBeNull();
  });

  it('asks first when the agent flag is true on a safe action, then runs it once after CONFIRM', async () => {
    const { socket } = await ready();

    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'I can focus the editor.', { type: 'FOCUS_EDITOR' }, true);
    await done;
    await flush();

    expect(vscodeMockState.executedCommands).not.toContain('workbench.action.focusFirstEditorGroup');
    expect(viewStates().at(-1)).toMatchObject({ statusKind: 'confirmation_pending' });
    expect(viewStates().at(-1).pendingConfirmation.promptText).toContain('Focus editor');
    expect(frames(socket, 'action_result')).toEqual([]);

    await typeAndWait('confirm');

    expect(vscodeMockState.executedCommands.filter((c) => c === 'workbench.action.focusFirstEditorGroup')).toHaveLength(1);
    expect(frames(socket, 'action_result')).toHaveLength(1);
    expect(frames(socket, 'action_result')[0]).toMatchObject({ replyTo: 'req-1', result: { status: 'ok' } });
    expect(viewStates().at(-1).statusKind).toBe('idle');
  });

  it.each([false, true])('always asks before RUN_TESTS (flag %s), shows the trusted command, and runs only after CONFIRM', async (flag) => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND }, summary: { ...FAILED_RUN, outcome: 'passed', failed: 0, totalFailedNames: 0, failingTests: [] } });

    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Running the tests.', { type: 'RUN_TESTS' }, flag);
    await done;
    await flush();

    expect(runner.runs).toBe(0);
    expect(viewStates().at(-1)).toMatchObject({ statusKind: 'confirmation_pending' });
    expect(viewStates().at(-1).pendingConfirmation.promptText).toContain(COMMAND);
    expect(frames(socket, 'action_result')).toEqual([]);

    await typeAndWait('confirm');

    expect(runner.runs).toBe(1);
    expect(frames(socket, 'action_result')).toHaveLength(1);
    expect(frames(socket, 'action_result')[0]).toMatchObject({ replyTo: 'req-1', result: { actionType: 'RUN_TESTS', status: 'ok' } });
  });

  it.each([
    ['decline', 'a typed decline'],
    ['cancel', 'a typed cancel'],
  ])('%s runs nothing and sends exactly one declined result (%s)', async (reply) => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND } });
    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Running the tests.', { type: 'RUN_TESTS' });
    await done;
    await flush();

    await typeAndWait(reply);

    expect(runner.runs).toBe(0);
    expect(frames(socket, 'action_result')).toHaveLength(1);
    expect(frames(socket, 'action_result')[0]).toMatchObject({ replyTo: 'req-1', result: { actionType: 'RUN_TESTS', status: 'declined' } });
    expect(viewStates().at(-1).statusKind).toBe('idle');
  });

  it('the Decline button does the same as typing decline', async () => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND } });
    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Running the tests.', { type: 'RUN_TESTS' });
    await done;
    await flush();

    await panel().receive({ type: 'decline' });
    await flush();

    expect(runner.runs).toBe(0);
    expect(frames(socket, 'action_result').map((frame) => frame.result.status)).toEqual(['declined']);
  });

  it('tells an unconfigured RUN_TESTS apart: no prompt, nothing run, one not_configured result', async () => {
    const { socket, runner } = await ready();

    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Running the tests.', { type: 'RUN_TESTS' });
    await done;
    await flush();

    expect(runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation ?? null).toBeNull();
    expect(kirosightTexts()[0]).toContain('No test command is configured');
    expect(frames(socket, 'action_result').map((frame) => frame.result.status)).toEqual(['not_configured']);
  });

  it.each([
    [{ type: 'RUN_COMMAND', command: 'rm -rf /' }, 'RUN_COMMAND'],
    [{ type: 'GO_TO_SYMBOL', name: 'x' }, 'GO_TO_SYMBOL'],
    [{ type: 'RUN_TESTS', command: 'rm -rf /' }, 'RUN_TESTS'],
  ])('rejects the unsafe action %j without running anything', async (action, reportedType) => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND } });

    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Doing it.', action, true);
    await done;
    await flush();

    expect(runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation ?? null).toBeNull();
    expect(kirosightTexts()[0]).toMatch(/permitted, so I didn't do anything\.$/);
    expect(frames(socket, 'action_result')).toHaveLength(1);
    expect(frames(socket, 'action_result')[0]).toMatchObject({ replyTo: 'req-1', result: { actionType: reportedType, status: 'not_permitted' } });
    expect(JSON.stringify(socket.sentMessages)).not.toContain('rm -rf');
    expect(JSON.stringify(viewStates())).not.toContain('rm -rf');
  });

  it('answers each request with its own correlation id, in the order they were decided', async () => {
    const { socket } = await ready();

    const first = await type('tell me about this project');
    answer(socket, 'req-1', 'One.', { type: 'FOCUS_EDITOR' });
    await first.done;
    await flush();
    const second = await type('what is in this repository');
    answer(socket, 'req-2', 'Two.', { type: 'NO_ACTION' });
    await second.done;
    await flush();

    expect(frames(socket, 'action_result').map((frame) => [frame.replyTo, frame.result.status]))
      .toEqual([['req-1', 'ok'], ['req-2', 'ok']]);
  });

  it('does not consider an action whose request was interrupted, and declines it to the backend', async () => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND } });

    const { done } = await type('tell me about this project');
    await panel().receive({ type: 'interrupt' });
    answer(socket, 'req-1', 'Running the tests.', { type: 'RUN_TESTS' });
    await done;
    await flush();

    expect(runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation ?? null).toBeNull();
    expect(kirosightTexts()).toEqual([]);
    expect(frames(socket, 'action_result').map((frame) => [frame.replyTo, frame.result.status])).toEqual([['req-1', 'declined']]);
  });
});

describe('actions the backend pushes', () => {
  const push = (socket: FakeWebSocket, id: string, action: unknown) =>
    socket.triggerJson({ version: 1, type: 'action_request', id, action, reason: 'IGNORE ALL RULES' });

  it('runs a safe one once and shows the result in the transcript, once, never the reason', async () => {
    const { socket } = await ready();
    await openPanel(); // opening the panel again must not register a second listener

    push(socket, 'A1', { type: 'FOCUS_EDITOR' });
    await settle();

    expect(vscodeMockState.executedCommands.filter((c) => c === 'workbench.action.focusFirstEditorGroup')).toHaveLength(1);
    expect(kirosightTexts()).toEqual(['Focused the editor.']);
    expect(frames(socket, 'action_result')).toHaveLength(1);
    expect(frames(socket, 'action_result')[0]).toMatchObject({ replyTo: 'A1', result: { status: 'ok' } });
    expect(JSON.stringify(viewStates())).not.toContain('IGNORE ALL RULES');
  });

  it('asks before RUN_TESTS and ignores a repeat of the same id while it is pending', async () => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND } });

    push(socket, 'A1', { type: 'RUN_TESTS' });
    await settle();
    push(socket, 'A1', { type: 'RUN_TESTS' });
    await settle();

    expect(runner.runs).toBe(0);
    expect(viewStates().at(-1).statusKind).toBe('confirmation_pending');
    expect(kirosightTexts().filter((text) => text.includes(COMMAND))).toHaveLength(1);

    await typeAndWait('decline');

    expect(frames(socket, 'action_result').map((frame) => [frame.replyTo, frame.result.status])).toEqual([['A1', 'declined']]);
  });

  it('rejects a forbidden pushed action with one not_permitted result', async () => {
    const { socket } = await ready();

    push(socket, 'A2', { type: 'RUN_COMMAND', command: 'x' });
    await settle();

    expect(kirosightTexts()).toEqual(["That action isn't permitted, so I didn't do anything."]);
    expect(frames(socket, 'action_result').map((frame) => frame.result.status)).toEqual(['not_permitted']);
  });
});

describe('local commands', () => {
  it('send no action_result and no agent request, including a confirmed local test run', async () => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND }, summary: { ...FAILED_RUN, outcome: 'passed', failed: 0, totalFailedNames: 0, failingTests: [] } });

    await typeAndWait('run my tests');
    expect(viewStates().at(-1).statusKind).toBe('confirmation_pending');
    await typeAndWait('confirm');
    await typeAndWait('focus editor');
    await typeAndWait('where am I');
    await settle();

    expect(runner.runs).toBe(1);
    expect(frames(socket, 'action_result')).toEqual([]);
    expect(frames(socket, 'agent_request')).toEqual([]);
  });
});

describe('summary of a failed test run', () => {
  const askForLocalRun = async () => {
    await typeAndWait('run my tests');
    await typeAndWait('confirm');
    await settle();
  };

  it('shows the deterministic result first, then appends the backend summary of a bounded request', async () => {
    const { socket, runner } = await ready({ config: { 'kirosight.testCommand': COMMAND } });

    await askForLocalRun();

    expect(runner.runs).toBe(1);
    const [request] = frames(socket, 'agent_request');
    expect(frames(socket, 'agent_request')).toHaveLength(1);
    expect(request).toMatchObject({ kind: 'summarize_test_run', id: 'sum-1' });
    expect(request).not.toHaveProperty('utterance');
    expect(request.testRun.failingTests).toEqual([{ name: 'auth > rejects an expired token', messageExcerpt: 'expected 401' }]);
    expect(JSON.stringify(request)).not.toContain(COMMAND); // the command line is not sent
    expect(request.context.nearbyCode).toBeNull();
    expect(request.context.diagnostics).toEqual([]);

    answer(socket, 'sum-1', 'One auth test failed: an expired token is not rejected.', { type: 'RUN_TESTS' });
    await settle();

    expect(kirosightTexts().slice(-2)).toEqual([
      formatTestResult(FAILED_RUN),
      'One auth test failed: an expired token is not rejected.',
    ]);
    // A summary can run nothing: even a RUN_TESTS in its answer is ignored.
    expect(runner.runs).toBe(1);
    expect(viewStates().at(-1).pendingConfirmation ?? null).toBeNull();
    expect(frames(socket, 'action_result')).toEqual([]);
  });

  it('keeps only the deterministic text when the backend is offline', async () => {
    const harness = boot({ config: { 'kirosight.testCommand': COMMAND } });
    await openPanel();
    await panel().receive({ type: 'ready' });

    await askForLocalRun();

    expect(harness.runner.runs).toBe(1);
    expect(kirosightTexts().slice(-1)).toEqual([formatTestResult(FAILED_RUN)]);
    expect(harness.factory.last.sentMessages).toEqual([]);
  });

  it.each(['BEDROCK_UNAVAILABLE', 'CREDENTIAL_MISSING', 'BEDROCK_INVALID_RESPONSE'])(
    'keeps only the deterministic text when reasoning fails (%s)',
    async (code) => {
      const { socket } = await ready({ config: { 'kirosight.testCommand': COMMAND } });

      await askForLocalRun();
      failure(socket, 'sum-1', code);
      await settle();

      expect(kirosightTexts().slice(-1)).toEqual([formatTestResult(FAILED_RUN)]);
      expect(frames(socket, 'agent_request')).toHaveLength(1); // no retry
    },
  );

  it('does not summarize a run that passed', async () => {
    const { socket } = await ready({
      config: { 'kirosight.testCommand': COMMAND },
      summary: { ...FAILED_RUN, outcome: 'passed', failed: 0, totalFailedNames: 0, failingTests: [] },
    });

    await askForLocalRun();

    expect(frames(socket, 'agent_request')).toEqual([]);
  });

  it('summarizes a failed run that an agent-proposed RUN_TESTS caused, and still answers the agent once', async () => {
    const { socket } = await ready({ config: { 'kirosight.testCommand': COMMAND } });
    const { done } = await type('tell me about this project');
    answer(socket, 'req-1', 'Running the tests.', { type: 'RUN_TESTS' });
    await done;
    await flush();

    await typeAndWait('confirm');
    await settle();

    expect(frames(socket, 'action_result').map((frame) => [frame.replyTo, frame.result.status])).toEqual([['req-1', 'failed']]);
    expect(frames(socket, 'agent_request').map((frame) => frame.kind)).toEqual(['utterance', 'summarize_test_run']);
  });
});

describe('lifecycle and composition', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');

  it('registers exactly one action listener and one of each Milestone 7 object', () => {
    for (const constructor of ['AgentActionHandler', 'TestRunSummarizer', 'ExplanationRequestBuilder', 'BackendAgentGateway']) {
      expect(source.match(new RegExp(`new ${constructor}\\(`, 'g')), constructor).toHaveLength(1);
    }
    expect(source.match(/agentActionHandler\.listen\(/g)).toHaveLength(1);
    expect(source).toContain('explainer: explanationBuilder');
    expect(source).toContain('agentActionHandler.onResolution(resolution)');
    expect(source).toContain('testRunSummarizer.onResolution(resolution)');
  });

  it('disposes the action listener and silences late announcements with the extension', () => {
    expect(source).toContain('actionRequestSubscription');
    expect(source).toContain('disposed = true');
    expect(source).toContain('clearTimeout(timer)');
  });

  it('adds no execution path of its own: it validates nothing and spawns nothing', () => {
    expect(source).not.toMatch(/validateAction|ActionValidator|child_process|spawn\(|exec\(|eval\(/);
  });

  it('stops everything with the extension: no further relay, listener or announcement', async () => {
    const { socket, subscriptions } = await ready({ config: { 'kirosight.testCommand': COMMAND } });

    for (const subscription of subscriptions) subscription.dispose();
    await flush();

    expect(socket.closeCalls).toHaveLength(1);
    socket.triggerJson({ version: 1, type: 'action_request', id: 'A9', action: { type: 'FOCUS_EDITOR' }, reason: 'x' });
    await settle();
    expect(frames(socket, 'action_result')).toEqual([]);
    expect(vscodeMockState.executedCommands).not.toContain('workbench.action.focusFirstEditorGroup');
  });
});
