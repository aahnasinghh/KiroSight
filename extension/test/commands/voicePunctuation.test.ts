/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Task 9.8 bug fix: punctuated speech-to-text in the real extension graph.
 *
 * Deepgram's smart formatting returns "Run my tests." and "Confirm." with sentence punctuation.
 * These tests drive exactly that through the real `activate()` wiring (the panel, the voice stack,
 * the pipeline, the confirmation manager, the gate and the speech controller). Only the edges are
 * fake: the WebSocket (a scripted backend that returns scripted transcriptions), the clocks, VS Code,
 * and the test runner, which only counts calls and never starts a process. No microphone,
 * Deepgram, AWS or real command is involved.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { formatConfirmation } from '../../src/response/responseFormatter';
import type { TestRunner } from '../../src/testing/testRunner';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSecrets } from '../mocks/fakeSecrets';
import { FakeSocketFactory, type FakeWebSocket } from '../mocks/fakeWebSocket';
import {
  Uri, resetEditorMock, resetVscodeMock, setMockConfiguration, setMockWorkspace, vscodeMockState,
  type MockWebviewPanel,
} from '../mocks/vscode';

const COMMAND = 'node --version';
const PROMPT = formatConfirmation({ type: 'RUN_TESTS' }, COMMAND);
const CAPS = { bedrock: false, stt: true, tts: true, mic: 'available' };
const PASSED: TestRunSummary = {
  outcome: 'passed', command: COMMAND, exitCode: 0, passed: 1, failed: 0, totalFailedNames: 0,
  failingTests: [], outputTruncated: false, durationMs: 1,
};

class CountingRunner {
  public runs = 0;
  public async run(): Promise<TestRunSummary> { this.runs += 1; return PASSED; }
  public showOutput(): void {}
  public dispose(): void {}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0]!;
const viewStates = (): any[] => (panel().webview.posted as any[]).filter((m) => m.type === 'view_state');
const frames = (socket: FakeWebSocket, type: string): any[] => socket.sentMessages.filter((f) => f.type === type) as any[];

async function boot() {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration({ 'kirosight.testCommand': COMMAND });
  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const voiceScheduler = new FakeScheduler();
  const runner = new CountingRunner();
  activate(
    { subscriptions: [], extensionUri: Uri.file('/ext'), secrets: new FakeSecrets() } as unknown as Parameters<typeof activate>[0],
    { testRunner: runner as unknown as TestRunner, socketFactory: factory.create, scheduler, voiceScheduler },
  );
  await command('kirosight.ask')();
  await flush();
  const socket = factory.last;
  socket.triggerOpen();
  socket.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities: CAPS });
  await flush();

  /** A spoken query, exactly as the product receives it: two presses and the scripted transcript. */
  let recordings = 0;
  const say = async (transcript: string): Promise<void> => {
    recordings += 1;
    await panel().receive({ type: 'ptt_toggle' });
    await flush();
    const done = panel().receive({ type: 'ptt_toggle' });
    await flush();
    socket.triggerJson({ version: 1, type: 'transcription_result', replyTo: `rec-${recordings}`, text: transcript });
    await done;
    await flush();
  };
  const type = async (text: string, submitId: string): Promise<void> => {
    await panel().receive({ type: 'submit_text', submitId, text });
    await flush();
  };
  const transcriptTexts = (): string[] => viewStates().at(-1).transcript.map((e: any) => e.text);
  const userEntries = (): Array<{ text: string; source?: string }> =>
    viewStates().at(-1).transcript.filter((e: any) => e.role === 'user');
  const pending = (): { promptText: string } | null => viewStates().at(-1).pendingConfirmation ?? null;
  const speechTexts = (): string[] => frames(socket, 'speech_request').map((f) => f.text);
  return { socket, runner, say, type, transcriptTexts, userEntries, pending, speechTexts };
}

beforeEach(() => resetVscodeMock());

describe('a spoken "Run my tests." now asks for confirmation instead of reaching the agent', () => {
  it('produces the RUN_TESTS prompt with the exact configured command, and runs nothing', async () => {
    const h = await boot();

    await h.say('Run my tests.');

    expect(h.userEntries().at(-1)).toMatchObject({ text: 'Run my tests.', source: 'voice' }); // the words, as heard
    expect(h.pending()?.promptText).toBe(PROMPT);
    expect(PROMPT).toContain(COMMAND);
    expect(h.transcriptTexts()).not.toContain('KiroSight backend is connected.');
    expect(frames(h.socket, 'agent_request')).toEqual([]); // never relayed
    expect(h.speechTexts()).toEqual([PROMPT]); // spoken once
    expect(h.runner.runs).toBe(0);
  });

  it('a typed "Run my tests." with its period does the same', async () => {
    const h = await boot();

    await h.type('Run my tests.', 'submit-1');

    expect(h.pending()?.promptText).toBe(PROMPT);
    expect(frames(h.socket, 'agent_request')).toEqual([]);
    expect(h.speechTexts()).toEqual([]); // typed stays silent
    expect(h.runner.runs).toBe(0);
  });
});

describe('spoken replies with sentence punctuation', () => {
  it('"Confirm." runs the approved action exactly once', async () => {
    const h = await boot();
    await h.say('Run my tests.');

    await h.say('Confirm.');

    expect(h.runner.runs).toBe(1);
    expect(h.pending()).toBeNull();
    expect(frames(h.socket, 'agent_request')).toEqual([]);
    expect(h.speechTexts()).toHaveLength(2); // the prompt, then its result: one request each
  });

  it('"Decline." never runs anything and clears the request', async () => {
    const h = await boot();
    await h.say('Run my tests.');

    await h.say('Decline.');

    expect(h.runner.runs).toBe(0);
    expect(h.pending()).toBeNull();
  });

  it('"Cancel." behaves like decline', async () => {
    const h = await boot();
    await h.say('Run my tests.');

    await h.say('Cancel.');

    expect(h.runner.runs).toBe(0);
    expect(h.pending()).toBeNull();
  });

  it('"Repeat." repeats the stored prompt with exactly one new speech request, and runs nothing', async () => {
    const h = await boot();
    await h.say('Run my tests.');
    const before = h.speechTexts().length;

    await h.say('Repeat.');

    expect(h.speechTexts().length).toBe(before + 1); // one new request, not two
    expect(h.speechTexts().at(-1)).toBe(PROMPT); // the stored prompt itself
    expect(h.pending()?.promptText).toBe(PROMPT); // still pending, unchanged
    expect(h.runner.runs).toBe(0);
  });

  it('after "Repeat." the action can still be confirmed once', async () => {
    const h = await boot();
    await h.say('Run my tests.');
    await h.say('Repeat.');

    await h.say('Yes!');

    expect(h.runner.runs).toBe(1);
  });
});

describe('unsafe or unrelated speech never confirms', () => {
  it.each([
    'Yes please run something else.',
    "Don't confirm.",
    'Confirm and delete files.',
    'Confirm?',
    'Banana.',
  ])('%j leaves the action pending and runs nothing', async (spoken) => {
    const h = await boot();
    await h.say('Run my tests.');

    await h.say(spoken);

    expect(h.runner.runs).toBe(0);
    expect(h.pending()?.promptText).toBe(PROMPT);
    expect(frames(h.socket, 'agent_request')).toEqual([]); // not relayed while a confirmation waits
  });
});
