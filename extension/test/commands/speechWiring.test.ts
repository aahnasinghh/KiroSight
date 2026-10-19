/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Task 9.7: spoken output wired into the extension (`extension.ts`).
 *
 * The real extension graph runs: `activate()`, the real WebviewProvider on the mocked VS Code API,
 * BackendClient and ConnectionManager, VoiceWiring, SpeechController, InputPipeline, the real
 * confirmation manager, gate and controller. Only the edges are fake: the WebSocket (a scripted
 * backend), the two clocks, the secret store, the test process and VS Code itself. No microphone,
 * Deepgram or AWS is reachable.
 *
 * Speech follows the origin of the query: an answer to a SPOKEN query is spoken (after its text is
 * shown); an answer to a TYPED query stays text-only, even with voice enabled. A spoken query here
 * is a real push-to-talk press, stop press and scripted `transcription_result`, so it takes the
 * same door in the pipeline as in the product.
 *
 * What this proves: the pieces are connected as the design describes. What it does not prove: real
 * sound from a real Kiro webview, real Aura audio, or screen-reader behavior. Those need a manual run.
 */
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { describeReasoningFailure } from '../../src/response/explanationMessages';
import { formatConfirmation, formatConfirmationReprompt } from '../../src/response/responseFormatter';
import { PLAYBACK_START_TIMEOUT_MS, SPEECH_UNAVAILABLE_TEXT } from '../../src/voice/speechController';
import type { TestRunner } from '../../src/testing/testRunner';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSecrets } from '../mocks/fakeSecrets';
import { FakeSocketFactory, type FakeWebSocket } from '../mocks/fakeWebSocket';
import {
  Uri, resetEditorMock, resetVscodeMock, setMockConfiguration, setMockWorkspace, vscodeMockState,
  type MockWebviewPanel,
} from '../mocks/vscode';

const COMMAND = 'npm test';
const CAPS = { bedrock: true, stt: true, tts: true, mic: 'available' };
const ANSWER = 'No file is open.'; // the local answer to "where am I" with no editor open
const AUDIO = 'U0VDUkVUQVVESU9CWVRFUw==';
const PASSED: TestRunSummary = {
  outcome: 'passed', command: COMMAND, exitCode: 0, passed: 3, failed: 0, totalFailedNames: 0,
  failingTests: [], outputTruncated: false, durationMs: 5,
};

class FakeRunner {
  public runs = 0;
  public async run(): Promise<TestRunSummary> { this.runs += 1; return PASSED; }
  public showOutput(): void {}
  public dispose(): void {}
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0]!;
const posted = (): any[] => panel().webview.posted as any[];
const viewStates = (): any[] => posted().filter((m) => m.type === 'view_state');
const countPosted = (type: string): number => posted().filter((m) => m.type === type).length;

interface Options {
  readonly config?: Record<string, unknown>;
  readonly caps?: Record<string, unknown>;
}

async function setup(options: Options = {}) {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration({ 'kirosight.testCommand': COMMAND, ...(options.config ?? {}) });

  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const voiceScheduler = new FakeScheduler();
  const runner = new FakeRunner();
  const subscriptions: Array<{ dispose(): void }> = [];
  activate(
    { subscriptions, extensionUri: Uri.file('/ext'), secrets: new FakeSecrets() } as unknown as Parameters<typeof activate>[0],
    { testRunner: runner as unknown as TestRunner, socketFactory: factory.create, scheduler, voiceScheduler },
  );
  return { factory, scheduler, voiceScheduler, runner, subscriptions, caps: options.caps ?? CAPS };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** Opens the panel (without starting to listen), connects the scripted backend, and starts a log. */
async function open(harness: Harness) {
  await command('kirosight.ask')();
  await flush();
  const socket = harness.factory.last;
  socket.triggerOpen();
  socket.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities: harness.caps });
  await flush();

  // One ordered log of what the backend and the webview are sent, to prove text comes first.
  const log: string[] = [];
  const send = socket.send.bind(socket);
  socket.send = (data: string) => { log.push(`frame:${(JSON.parse(data) as { type: string }).type}`); send(data); };
  const webview = panel().webview as unknown as { postMessage: (message: any) => Promise<boolean> };
  const post = webview.postMessage.bind(webview);
  webview.postMessage = (message: any) => {
    if (message.type === 'view_state') log.push(`view:${(message.transcript as any[]).map((e) => e.text).join('|')}`);
    else log.push(`host:${message.type}`);
    return post(message);
  };

  /**
   * A SPOKEN query: press push-to-talk, press again to stop, and have the scripted backend return
   * the transcription. `done` settles when the pipeline has finished with the query (a query that
   * goes to the agent stays pending until the backend answers it).
   */
  let recordings = 0;
  const startVoiceQuery = async (text: string): Promise<{ done: Promise<void> }> => {
    recordings += 1;
    await panel().receive({ type: 'ptt_toggle' });
    await flush();
    const done = panel().receive({ type: 'ptt_toggle' });
    await flush();
    socket.triggerJson({ version: 1, type: 'transcription_result', replyTo: `rec-${recordings}`, text });
    return { done };
  };
  const voiceQuery = async (text: string): Promise<void> => {
    const { done } = await startVoiceQuery(text);
    await done;
    await flush();
  };
  return { socket, log, startVoiceQuery, voiceQuery };
}

type Session = Awaited<ReturnType<typeof open>>;

const frames = (socket: FakeWebSocket, type: string): any[] => socket.sentMessages.filter((f) => f.type === type) as any[];
const typed = async (text: string, submitId = 'submit-1') => {
  await panel().receive({ type: 'submit_text', submitId, text });
  await flush();
};
const escape = async () => { await panel().receive({ type: 'interrupt' }); await flush(); };
const speechAudio = (socket: FakeWebSocket, id: string) =>
  socket.triggerJson({ version: 1, type: 'speech_audio', replyTo: id, mimeType: 'audio/mpeg', base64: AUDIO });
const playback = async (state: 'started' | 'ended' | 'failed', id: string) => {
  await panel().receive({ type: 'playback', state, id });
  await flush();
};
const transcriptTexts = (): string[] => viewStates().at(-1).transcript.map((e: any) => e.text);
const notices = (): string[] => transcriptTexts().filter((t) => t === SPEECH_UNAVAILABLE_TEXT);

/** The Transcript as a freshly reopened panel sees it (the first panel may have been closed). */
async function transcriptAfterReopen(): Promise<string[]> {
  await command('kirosight.ask')();
  await flush();
  const reopened = vscodeMockState.webviewPanels.at(-1)!;
  await reopened.receive({ type: 'ready' });
  const last = (reopened.webview.posted as any[]).filter((m) => m.type === 'view_state').at(-1);
  return last.transcript.map((e: any) => e.text);
}

beforeEach(() => resetVscodeMock());

// =====================================================================================================================
// Defects these groups would catch are named in each group's comment.

// Defects: something speaking, connecting or timing by itself before it is asked to.
describe('construction: nothing speaks, connects or times anything by itself', () => {
  it('activation sends nothing, opens no socket, and starts no timer', async () => {
    const h = await setup();
    await flush();

    expect(h.factory.sockets).toHaveLength(0);
    expect(h.voiceScheduler.pendingCount).toBe(0);
    expect(h.scheduler.pendingCount).toBe(0);
    expect(vscodeMockState.webviewPanels).toHaveLength(0);
  });

  it('registers kirosight.stopSpeaking; the command is safe with nothing speaking, even before the panel opens', async () => {
    const h = await setup();

    expect(vscodeMockState.registeredCommands.has('kirosight.stopSpeaking')).toBe(true);
    await expect(Promise.resolve(command('kirosight.stopSpeaking')())).resolves.toBeUndefined();
    expect(h.factory.sockets).toHaveLength(0);
  });
});

// Defects: a typed answer being spoken; a spoken answer not being spoken; speech before the text is
// shown; the answer shortened or replaced; audio under a different id; a wrong source for a response.
describe('the origin of the query decides whether an answer is spoken', () => {
  it('a SPOKEN query: shows the answer, then requests speech, then plays the audio, with one id', async () => {
    const h = await setup();
    const { socket, log, voiceQuery } = await open(h);

    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();

    const shown = log.findIndex((entry) => entry.startsWith('view:') && entry.includes(ANSWER));
    const requested = log.indexOf('frame:speech_request');
    const played = log.indexOf('host:play_audio');
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(requested).toBeGreaterThan(shown);
    expect(played).toBeGreaterThan(requested);
    expect(frames(socket, 'speech_request')).toEqual([{ version: 1, type: 'speech_request', id: 'speech-1', text: ANSWER }]);
    expect(posted().filter((m) => m.type === 'play_audio')).toEqual([
      { type: 'play_audio', id: 'speech-1', mimeType: 'audio/mpeg', base64: AUDIO },
    ]);
    expect(transcriptTexts()).toContain(ANSWER);
  });

  it('a TYPED query with voice enabled: the complete text, and no speech request, audio or notice', async () => {
    const h = await setup();
    const { socket } = await open(h);

    await typed('where am I');
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 3);

    expect(transcriptTexts()).toContain(ANSWER);
    expect(frames(socket, 'speech_request')).toEqual([]);
    expect(countPosted('play_audio')).toBe(0);
    expect(notices()).toEqual([]);
    expect(h.voiceScheduler.pendingCount).toBe(0);
  });

  it('typed and spoken queries together: only the spoken one is spoken, and each keeps its own origin', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);

    await typed('where am I', 'submit-1');
    await voiceQuery('where am I');
    await typed('where am I', 'submit-2');

    expect(frames(socket, 'speech_request').map((f) => f.id)).toEqual(['speech-1']);
    expect(transcriptTexts().filter((t) => t === ANSWER)).toHaveLength(3); // all three answers are shown
  });

  it('overlapping requests keep their own origin: a typed agent answer arriving after a spoken query is still not spoken', async () => {
    const h = await setup();
    const { socket, startVoiceQuery } = await open(h);

    // A typed query that goes to the agent and is still waiting for its answer.
    const typedPending = panel().receive({ type: 'submit_text', submitId: 'submit-1', text: 'why is this function slow' });
    await flush();
    const typedRequest = frames(socket, 'agent_request')[0];
    expect(typedRequest).toBeDefined();

    const { done } = await startVoiceQuery('where am I'); // a spoken local query meanwhile
    await done;
    await typedPending; // the new utterance superseded it, so it ends without an answer
    await flush();
    expect(frames(socket, 'speech_request').map((f) => f.text)).toEqual([ANSWER]);

    // The typed query was superseded by the new utterance (its request was cancelled); even if its
    // answer still arrived it must neither be shown as current nor spoken.
    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: typedRequest.id, speech: 'A late typed answer',
      action: { type: 'NO_ACTION' }, confirmationRequired: false,
    });
    await flush();

    expect(frames(socket, 'speech_request').map((f) => f.text)).toEqual([ANSWER]);
  });

  it('a Bedrock error answering a spoken query stays visible and is spoken; its provider detail is never shown', async () => {
    const h = await setup();
    const { socket, startVoiceQuery } = await open(h);

    const { done } = await startVoiceQuery('why is this function slow');
    await flush();
    const agentRequest = frames(socket, 'agent_request')[0];
    socket.triggerJson({
      version: 1, type: 'error_message', replyTo: agentRequest.id, code: 'BEDROCK_UNAVAILABLE',
      message: 'PROVIDER-DETAIL', recoverable: true,
    });
    await done;
    await flush();

    const expected = describeReasoningFailure('BEDROCK_UNAVAILABLE', true)!;
    expect(transcriptTexts()).toContain(expected);
    expect(frames(socket, 'speech_request').map((f) => f.text)).toEqual([expected]);
    expect(JSON.stringify(viewStates())).not.toContain('PROVIDER-DETAIL');
  });

  it('a started report from the panel clears the deadline; ended finishes the clip; nothing is added', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();

    await playback('started', 'speech-1');
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 6);
    await playback('ended', 'speech-1');
    await escape(); // nothing is playing any more

    expect(notices()).toEqual([]);
    expect(countPosted('stop_audio')).toBe(0);
  });
});

// Defects: the 10 s deadline off by one; a failure reported twice; a late report reviving a request.
describe('playback failures and the deadline', () => {
  it('without a started report the 10 s deadline adds one separate notice, and the answer stays whole', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();

    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS - 1);
    expect(notices()).toEqual([]);
    h.voiceScheduler.advance(1);
    await flush();

    expect(notices()).toHaveLength(1);
    const texts = transcriptTexts();
    expect(texts.indexOf(ANSWER)).toBeLessThan(texts.indexOf(SPEECH_UNAVAILABLE_TEXT)); // separate, later
  });

  it('a failed report for the real clip id adds exactly one notice, and a repeat adds none', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    const base = h.voiceScheduler.pendingCount;
    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();

    await playback('failed', 'speech-1');
    await playback('failed', 'speech-1');
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 3);
    await flush();

    expect(notices()).toHaveLength(1);
    expect(transcriptTexts()).toContain(ANSWER);
    expect(h.voiceScheduler.pendingCount).toBe(base);
  });

  it('a late started report after the deadline does not revive the request or add anything', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    const base = h.voiceScheduler.pendingCount;
    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS);
    await flush();
    expect(notices()).toHaveLength(1);

    await playback('started', 'speech-1');
    await playback('ended', 'speech-1');
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 3);
    await flush();

    expect(notices()).toHaveLength(1);
    expect(h.voiceScheduler.pendingCount).toBe(base);
  });

  it('a speech error adds one notice; typed input and the next spoken answer keep working', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('where am I');
    socket.triggerJson({
      version: 1, type: 'error_message', replyTo: 'speech-1', code: 'TTS_UNAVAILABLE', message: 'raw backend text', recoverable: true,
    });
    await flush();
    expect(notices()).toHaveLength(1);
    expect(JSON.stringify(viewStates())).not.toContain('raw backend text');

    await typed('where am I', 'submit-2');
    await voiceQuery('where am I');

    expect(transcriptTexts().filter((t) => t === ANSWER)).toHaveLength(3);
    expect(frames(socket, 'speech_request').map((f) => f.id)).toEqual(['speech-1', 'speech-2']);
  });

  it('ignores an invalid playback report and a report for an id it never sent', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    const base = h.voiceScheduler.pendingCount;
    await voiceQuery('where am I');

    await panel().receive({ type: 'playback', state: 'exploded', id: 'speech-1' });
    await playback('started', 'speech-99');
    await playback('failed', 'speech-99');

    expect(notices()).toEqual([]);
    expect(frames(socket, 'speech_request')).toHaveLength(1);
    expect(h.voiceScheduler.pendingCount).toBe(base + 1); // speech-1's own deadline is untouched
  });
});

// Defects: a speech notice for a user who only types; more than one notice per outage.
describe('a backend that reports no text-to-speech', () => {
  it('typed queries get no speech and no notice, however many there are', async () => {
    const h = await setup({ caps: { ...CAPS, tts: false } });
    const { socket } = await open(h);

    await typed('where am I', 'submit-1');
    await typed('where am I', 'submit-2');

    expect(frames(socket, 'speech_request')).toEqual([]);
    expect(notices()).toEqual([]);
    expect(transcriptTexts().filter((t) => t === ANSWER)).toHaveLength(2);
  });

  it('spoken queries get exactly one notice for the outage, after the answer', async () => {
    const h = await setup({ caps: { ...CAPS, tts: false } });
    const { socket, voiceQuery } = await open(h);

    await voiceQuery('where am I');
    await voiceQuery('where am I');

    expect(frames(socket, 'speech_request')).toEqual([]);
    expect(notices()).toHaveLength(1);
    const texts = transcriptTexts();
    expect(texts.indexOf(ANSWER)).toBeLessThan(texts.indexOf(SPEECH_UNAVAILABLE_TEXT));
    expect(transcriptTexts().filter((t) => t === ANSWER)).toHaveLength(2);
  });
});

// Defects: an interruption path that is not connected; a stop sent twice or not at all; a cancel
// aimed at the wrong id; an interruption reported as a speech failure.
describe('every interruption path reaches speech', () => {
  async function playing(h: Harness): Promise<Session> {
    const session = await open(h);
    await session.voiceQuery('where am I');
    speechAudio(session.socket, 'speech-1');
    await flush();
    await playback('started', 'speech-1');
    return session;
  }

  it('Escape from the panel: one stop_audio, no notice, Transcript untouched', async () => {
    const h = await setup();
    await playing(h);
    const before = transcriptTexts();

    await escape();
    await escape();

    expect(countPosted('stop_audio')).toBe(1);
    expect(notices()).toEqual([]);
    expect(transcriptTexts()).toEqual(before);
  });

  it('Escape in the page reports ended first, so the host sends no redundant stop', async () => {
    const h = await setup();
    await playing(h);

    await playback('ended', 'speech-1'); // what the page posts when it stops the clip itself
    await escape();

    expect(countPosted('stop_audio')).toBe(0);
  });

  it('kirosight.stopSpeaking while playing: one stop_audio, and nothing is resolved or lost', async () => {
    const h = await setup();
    await playing(h);
    const before = transcriptTexts();

    await command('kirosight.stopSpeaking')();
    await flush();

    expect(countPosted('stop_audio')).toBe(1);
    expect(notices()).toEqual([]);
    expect(transcriptTexts()).toEqual(before);
  });

  it('kirosight.stopSpeaking while synthesis is pending: cancels that speech request only', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('where am I');

    await command('kirosight.stopSpeaking')();
    await flush();
    speechAudio(socket, 'speech-1'); // late
    await flush();

    expect(frames(socket, 'cancel')).toEqual([{ version: 1, type: 'cancel', targetId: 'speech-1' }]);
    expect(countPosted('play_audio')).toBe(0);
    expect(notices()).toEqual([]);
  });

  it('kirosight.stopSpeaking with nothing speaking sends nothing', async () => {
    const h = await setup();
    const { socket } = await open(h);
    const sent = socket.sentMessages.length;
    const posts = posted().length;

    await command('kirosight.stopSpeaking')();
    await flush();

    expect(socket.sentMessages).toHaveLength(sent);
    expect(posted().slice(posts).filter((m) => m.type === 'stop_audio')).toEqual([]);
  });

  it('push-to-talk start stops speech, starts a new recording, and does not cancel it', async () => {
    const h = await setup();
    const { socket } = await playing(h);

    await panel().receive({ type: 'ptt_toggle' });
    await flush();

    expect(countPosted('stop_audio')).toBe(1);
    expect(frames(socket, 'record_start').map((f) => f.id)).toEqual(['rec-1', 'rec-2']);
    expect(frames(socket, 'cancel').filter((f) => f.targetId === 'rec-2')).toEqual([]);
  });

  it('a new typed utterance stops speech, and its own answer is text-only', async () => {
    const h = await setup();
    const { socket } = await playing(h);

    await typed('where am I', 'submit-2');

    expect(countPosted('stop_audio')).toBe(1);
    expect(frames(socket, 'speech_request').map((f) => f.id)).toEqual(['speech-1']);
    expect(transcriptTexts().filter((t) => t === ANSWER)).toHaveLength(2);
  });

  it('closing the panel with a request pending ends it quietly: cancelled, deadline cleared at once, no failure notice', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    const base = h.voiceScheduler.pendingCount;
    await voiceQuery('where am I');
    expect(h.voiceScheduler.pendingCount).toBe(base + 1); // the speech deadline

    panel().dispose();
    await flush();
    expect(h.voiceScheduler.pendingCount).toBe(base); // cleared by the close itself, before any time passes
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 3);

    expect(frames(socket, 'cancel').map((f) => f.targetId)).toEqual(['speech-1']);
    const texts = await transcriptAfterReopen();
    expect(texts).toContain(ANSWER);
    expect(texts).not.toContain(SPEECH_UNAVAILABLE_TEXT);
  });

  it('closing the panel with a clip delivered but not started also adds no failure notice', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    const base = h.voiceScheduler.pendingCount;
    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();

    panel().dispose();
    await flush();
    expect(h.voiceScheduler.pendingCount).toBe(base);
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 3);

    expect(await transcriptAfterReopen()).not.toContain(SPEECH_UNAVAILABLE_TEXT);
  });
});

// Defects: a prompt spoken without its action and target; spoken for a typed request; spoken twice;
// an interruption or a repeat approving, declining or running the action; Confirm/Decline broken.
describe('confirmation prompts', () => {
  const PROMPT = formatConfirmation({ type: 'RUN_TESTS' }, COMMAND);

  it('a spoken request: the pending prompt is spoken once, exactly as stored, naming the action and the command', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);

    await voiceQuery('run my tests');

    const requests = frames(socket, 'speech_request');
    expect(requests).toHaveLength(1);
    expect(requests[0].text).toBe(PROMPT);
    expect(requests[0].text).toContain(COMMAND);
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(PROMPT);
    expect(h.runner.runs).toBe(0);
  });

  it('a typed request: the prompt is shown, not spoken, and nothing runs', async () => {
    const h = await setup();
    const { socket } = await open(h);

    await typed('run my tests');

    expect(frames(socket, 'speech_request')).toEqual([]);
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(PROMPT);
    expect(h.runner.runs).toBe(0);
  });

  it('a spoken REPEAT speaks the same stored prompt again and approves nothing', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('run my tests');

    await voiceQuery('repeat');

    expect(frames(socket, 'speech_request').map((f) => f.text)).toEqual([PROMPT, PROMPT]);
    expect(h.runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation).not.toBeNull();
  });

  it('a spoken REPEAT of a prompt that was raised by a typed request speaks the stored prompt', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await typed('run my tests');

    await voiceQuery('repeat');

    expect(frames(socket, 'speech_request').map((f) => f.text)).toEqual([PROMPT]);
    expect(h.runner.runs).toBe(0);
  });

  it('survives every interruption, and Confirm still runs the tests exactly once', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('run my tests');
    speechAudio(socket, 'speech-1');
    await flush();
    await playback('started', 'speech-1');

    await escape();
    await command('kirosight.stopSpeaking')();
    await panel().receive({ type: 'ptt_toggle' });
    await flush();

    expect(h.runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(PROMPT);
    expect(viewStates().at(-1).statusKind).toBe('confirmation_pending');

    await panel().receive({ type: 'confirm' });
    await flush();
    await panel().receive({ type: 'confirm' });
    await flush();
    expect(h.runner.runs).toBe(1);
  });

  it('Decline still works after an interruption, and runs nothing', async () => {
    const h = await setup();
    await open(h);
    await typed('run my tests');
    await escape();

    await panel().receive({ type: 'decline' });
    await flush();

    expect(h.runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation ?? null).toBeNull();
  });
});

// Defects: speech starting when voice is off; typed-only use affected; the stop command breaking.
describe('kirosight.voice.enabled', () => {
  it('with voice off nothing is spoken, no notice is added, and typed requests work as ever', async () => {
    const h = await setup({ config: { 'kirosight.voice.enabled': false } });
    const { socket } = await open(h);

    await typed('where am I');
    await typed('run my tests', 'submit-2');
    await escape();
    await command('kirosight.stopSpeaking')();
    await flush();

    expect(frames(socket, 'speech_request')).toEqual([]);
    expect(countPosted('play_audio')).toBe(0);
    expect(countPosted('stop_audio')).toBe(0);
    expect(notices()).toEqual([]);
    expect(transcriptTexts()).toContain(ANSWER);
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(formatConfirmation({ type: 'RUN_TESTS' }, COMMAND));
  });

  it('kirosight.stopSpeaking with voice off is safe: it sends no stop, leaves the Transcript and a pending confirmation alone', async () => {
    const h = await setup({ config: { 'kirosight.voice.enabled': false } });
    await open(h);
    await typed('run my tests');
    const before = transcriptTexts();

    await expect(Promise.resolve(command('kirosight.stopSpeaking')())).resolves.toBeUndefined();
    await flush();

    expect(countPosted('stop_audio')).toBe(0);
    expect(transcriptTexts()).toEqual(before);
    expect(viewStates().at(-1).pendingConfirmation).not.toBeNull();
    expect(h.runner.runs).toBe(0);
  });
});

// Defects: a leaked listener or timer; an unhandled rejection; a clip left playing after the speech
// output is released.
describe('lifecycle', () => {
  it('disposing the extension while speech is in flight stops it quietly and leaves no timer', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const h = await setup();
      const { socket, voiceQuery } = await open(h);
      await voiceQuery('where am I');
      speechAudio(socket, 'speech-1');
      await flush();

      for (const subscription of h.subscriptions) subscription.dispose();
      await flush();

      expect(h.voiceScheduler.pendingCount).toBe(0);
      expect(countPosted('play_audio')).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('releasing the speech output while the panel stays available stops the clip that is playing', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('where am I');
    speechAudio(socket, 'speech-1');
    await flush();
    await playback('started', 'speech-1');
    expect(countPosted('stop_audio')).toBe(0);

    // The last subscription is the group that releases voice, speech output and the connection; the
    // panel itself is a separate, earlier subscription and is left open here.
    h.subscriptions.at(-1)!.dispose();
    await flush();

    expect(countPosted('stop_audio')).toBe(1);
    expect(h.voiceScheduler.pendingCount).toBe(0);
    h.voiceScheduler.advance(PLAYBACK_START_TIMEOUT_MS * 3);
    expect(transcriptTexts()).not.toContain(SPEECH_UNAVAILABLE_TEXT);
  });
});

// Defects: a second controller; a command or process path in the wiring; a missing manifest entry.
describe('composition and manifest', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');
  const manifest = JSON.parse(readFileSync(resolvePath(__dirname, '../../package.json'), 'utf8')) as {
    activationEvents: string[];
    contributes: { commands: Array<{ command: string; title: string }>; keybindings: Array<{ command: string }> };
  };

  it('constructs exactly one SpeechController, from the voice setting, and gives it the shared pieces', () => {
    expect(source.match(/new SpeechController\(/g)).toHaveLength(1);
    expect(source).toContain('client: backendClient');
    expect(source).toContain('stopSpeaking: () => { inputPipeline.interrupt(); }');
    expect(source).toContain('onBeforeListening: () => inputPipeline.interrupt()');
    expect(source).toContain("if (origin !== 'voice') return;");
    expect(source).toContain('speech?.dispose()');
  });

  it('adds no command or process path', () => {
    expect(source).not.toMatch(/executeCommand|RUN_COMMAND|child_process|spawn\(|eval\(/);
  });

  it('contributes kirosight.stopSpeaking with an activation event and no default keybinding', () => {
    expect(manifest.contributes.commands).toContainEqual({ command: 'kirosight.stopSpeaking', title: 'KiroSight: Stop Speaking' });
    expect(manifest.activationEvents).toContain('onCommand:kirosight.stopSpeaking');
    expect(manifest.contributes.keybindings.some((k) => k.command === 'kirosight.stopSpeaking')).toBe(false);
  });
});

// Defects: a confirmation prompt spoken twice for one spoken reply (two clips, the second cutting
// off the first); a prompt not spoken at all for a spoken query; any reply approving or running
// the pending action.
describe('one spoken reply, exactly one speech request, carrying the stored prompt', () => {
  const PROMPT = formatConfirmation({ type: 'RUN_TESTS' }, COMMAND);
  const REPROMPT = formatConfirmationReprompt({ type: 'RUN_TESTS' });
  const requestTexts = (socket: FakeWebSocket): string[] => frames(socket, 'speech_request').map((f) => f.text);

  it('typed request raises the prompt; a spoken "repeat" makes exactly one request with the stored prompt, and runs nothing', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await typed('run my tests'); // pending, text-only
    expect(frames(socket, 'speech_request')).toHaveLength(0);
    const entriesBefore = transcriptTexts().filter((t) => t === PROMPT).length;

    await voiceQuery('repeat');
    speechAudio(socket, 'speech-1');
    await flush();

    expect(frames(socket, 'speech_request')).toHaveLength(1); // exactly one new request
    expect(requestTexts(socket)).toEqual([PROMPT]); // the actual stored prompt
    expect(countPosted('play_audio')).toBe(1); // one clip: nothing to cut off
    expect(transcriptTexts().filter((t) => t === PROMPT).length).toBe(entriesBefore + 1); // shown again too
    expect(h.runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(PROMPT);
  });

  it('typed request raises the prompt; another spoken reply gets the short re-prompt only, not the full prompt as well', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await typed('run my tests');

    await voiceQuery('banana');

    expect(requestTexts(socket)).toEqual([REPROMPT]);
    expect(h.runner.runs).toBe(0);
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(PROMPT);
  });

  it('spoken request raises the prompt: spoken once; a spoken "repeat" then adds exactly one more with the same text', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);

    await voiceQuery('run my tests');
    expect(requestTexts(socket)).toEqual([PROMPT]);

    await voiceQuery('repeat');
    speechAudio(socket, 'speech-2');
    await flush();

    expect(requestTexts(socket)).toEqual([PROMPT, PROMPT]);
    expect(frames(socket, 'cancel').map((f) => f.targetId)).toEqual(['speech-1']); // the first was superseded, not stacked
    expect(countPosted('play_audio')).toBe(1);
    expect(h.runner.runs).toBe(0);
  });

  it('an agent answer that proposes an action asked for by voice speaks the answer and the prompt in ONE request', async () => {
    const h = await setup();
    const { socket, startVoiceQuery } = await open(h);

    const { done } = await startVoiceQuery('why is this function slow');
    await flush();
    const agentRequest = frames(socket, 'agent_request')[0];
    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: agentRequest.id, speech: 'I can run the tests for you.',
      action: { type: 'RUN_TESTS' }, confirmationRequired: true,
    });
    await done;
    await flush();

    const requests = requestTexts(socket);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('I can run the tests for you.');
    expect(requests[0]).toContain(PROMPT);
    expect(h.runner.runs).toBe(0); // proposed, not run
    expect(viewStates().at(-1).pendingConfirmation.promptText).toBe(PROMPT);
  });

  it('a spoken Confirm runs the tests once and speaks its result once; Decline and Confirm still work after an interruption', async () => {
    const h = await setup();
    const { socket, voiceQuery } = await open(h);
    await voiceQuery('run my tests');
    await escape();
    expect(h.runner.runs).toBe(0);

    await voiceQuery('confirm');

    expect(h.runner.runs).toBe(1);
    expect(frames(socket, 'speech_request')).toHaveLength(2); // the prompt, then the result: one each
    expect(requestTexts(socket)[1]).not.toBe(PROMPT);

    const declined = await setup();
    const second = await open(declined);
    await second.voiceQuery('run my tests');
    await escape();
    await second.voiceQuery('decline');
    expect(declined.runner.runs).toBe(0);
    expect(frames(second.socket, 'speech_request')).toHaveLength(2);
  });

  it('a typed request and a typed reply are never spoken: prompt, re-prompt and result all stay text-only', async () => {
    const h = await setup();
    const { socket } = await open(h);

    await typed('run my tests', 'submit-1');
    await typed('banana', 'submit-2');
    await typed('repeat', 'submit-3');
    await typed('confirm', 'submit-4');

    expect(frames(socket, 'speech_request')).toEqual([]);
    expect(h.runner.runs).toBe(1);
    expect(transcriptTexts().filter((t) => t === PROMPT).length).toBeGreaterThanOrEqual(2); // prompt and repeat, in the Transcript
  });

  it('the pipeline never makes a second request for the pending prompt itself', () => {
    const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');
    expect(source).not.toMatch(/speakPendingConfirmation|repeatConfirmation/);
  });
});
