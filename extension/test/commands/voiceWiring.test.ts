/**
 * Task 8.13: voice wired into the extension (`extension.ts`).
 *
 * The real extension graph runs here: `activate()`, the real `WebviewProvider` on the mocked VS Code
 * API, the real `BackendClient` and `ConnectionManager`, the real `VoiceWiring` (VoiceController,
 * VoiceSession, BackendLocalVoiceInput, WebviewVoiceInput, AudioRelay, BackendClipTranscriber), the
 * real `InputPipeline` and `TranscriptStore`. Only the edges are fake: the WebSocket (a scripted
 * backend), the two clocks, the secret store and VS Code itself. No microphone, Deepgram or AWS is
 * reachable, so nothing here records, uploads or calls a provider.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { SPEECH_UNAVAILABLE_TEXT } from '../../src/voice/speechController';
import { VOICE_INIT_BUDGET_MS, STT_RESPONSE_LIMIT_MS } from '../../src/voice/voiceController';
import { VOICE_DISABLED_TEXT } from '../../src/voice/voiceWiring';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSecrets } from '../mocks/fakeSecrets';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';
import {
  Uri, resetEditorMock, resetVscodeMock, setMockConfiguration, setMockWorkspace, vscodeMockState,
  type MockWebviewPanel,
} from '../mocks/vscode';

const READY_CAPS = { bedrock: false, stt: true, tts: false, mic: 'available' };
const ack = (capabilities: Record<string, unknown>) =>
  ({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities });
const transcriptionResult = (replyTo: string, text: string) =>
  ({ version: 1, type: 'transcription_result', replyTo, text });
const errorMessage = (replyTo: string, code: string, recoverable = true) =>
  ({ version: 1, type: 'error_message', replyTo, code, message: 'raw backend text', recoverable });

interface ViewState {
  type: string;
  status: string;
  statusKind: string;
  listening: boolean;
  voice: { state: string; reasonText: string | null };
  transcript: Array<{ role: string; text: string; source?: string }>;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels.at(-1)!;
const posted = (): Array<Record<string, unknown>> => panel().webview.posted as Array<Record<string, unknown>>;
const viewStates = (): ViewState[] => posted().filter((m) => m.type === 'view_state') as unknown as ViewState[];
const hostMessages = (type: string): unknown[] => posted().filter((m) => m.type === type);

/** The Transcript as the panel receives it on load. */
async function transcript(): Promise<ViewState['transcript']> {
  await panel().receive({ type: 'ready' });
  return viewStates().at(-1)!.transcript;
}
const systemTexts = async (): Promise<string[]> =>
  (await transcript()).filter((entry) => entry.role === 'system').map((entry) => entry.text);

function boot(config: Record<string, unknown> = {}) {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration(config);
  return start();
}

/** Activates the extension again without resetting VS Code (as after a reload of the extension). */
function start() {
  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const voiceScheduler = new FakeScheduler();
  const subscriptions: Array<{ dispose(): void }> = [];
  activate(
    { subscriptions, extensionUri: Uri.file('/ext'), secrets: new FakeSecrets() } as unknown as Parameters<typeof activate>[0],
    { socketFactory: factory.create, scheduler, voiceScheduler },
  );
  return { factory, scheduler, voiceScheduler, subscriptions };
}

type Harness = ReturnType<typeof boot>;

const frameTypes = (harness: Harness): unknown[] => harness.factory.last.sentMessages.map((frame) => frame.type);
const framesOf = (harness: Harness, type: string) => harness.factory.last.sentMessages.filter((frame) => frame.type === type);

/** Opens the panel without activating voice (the `ask` command only opens or focuses it). */
async function openPanel(harness: Harness): Promise<void> {
  await command('kirosight.ask')();
  await flush();
  expect(harness.factory.sockets.length).toBeGreaterThan(0);
}

async function openAndConnect(harness: Harness, capabilities: Record<string, unknown> = READY_CAPS) {
  await openPanel(harness);
  harness.factory.last.triggerOpen();
  harness.factory.last.triggerJson(ack(capabilities));
  await flush();
  return harness.factory.last;
}

/** Presses push-to-talk the way the webview does: a validated `ptt_toggle` message. */
const pressPushToTalk = () => panel().receive({ type: 'ptt_toggle' });

beforeEach(() => resetVscodeMock());

// =====================================================================================================================

describe('voice wiring: nothing starts by itself', () => {
  it('constructs the voice stack on activation without opening a socket, a timer or a microphone', async () => {
    const harness = boot();
    await flush();

    expect(harness.factory.sockets).toHaveLength(0);
    expect(harness.voiceScheduler.pendingCount).toBe(0);
    expect(harness.scheduler.pendingCount).toBe(0);
    expect(vscodeMockState.webviewPanels).toHaveLength(0);
  });

  it('opening the panel and connecting sends only hello: no recording, no audio, no capture request', async () => {
    const harness = boot();

    await openAndConnect(harness);

    expect(frameTypes(harness)).toEqual(['hello']);
    expect(hostMessages('start_capture')).toEqual([]);
    expect(harness.voiceScheduler.pendingDelays).toEqual([]); // the start budget is over: voice is ready
  });

  it('uses the backend-local input by default: ready with the backend microphone, webview never asked', async () => {
    const harness = boot();
    await openAndConnect(harness);

    await panel().receive({ type: 'ready' });

    expect(viewStates().at(-1)).toMatchObject({
      listening: false,
      voice: { state: 'available', reasonText: 'Voice is ready. Press push-to-talk to speak.' },
    });
    expect(hostMessages('start_capture')).toEqual([]);
  });

  it('starts the 10 s voice start budget only when the panel opens', async () => {
    const harness = boot();
    expect(harness.voiceScheduler.pendingCount).toBe(0);

    await openPanel(harness);

    expect(harness.voiceScheduler.pendingDelays).toEqual([VOICE_INIT_BUDGET_MS]);
  });
});

// =====================================================================================================================

describe('voice wiring: kirosight.activate is voice-aware (Req 18)', () => {
  it('opens the panel and begins listening when the backend microphone is ready', async () => {
    const harness = boot();
    await openAndConnect(harness);

    await command('kirosight.activate')();
    await flush();

    expect(framesOf(harness, 'record_start')).toEqual([{ version: 1, type: 'record_start', id: 'rec-1' }]);
    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(hostMessages('focus_input')).toHaveLength(1);
    expect(viewStates().at(-1)).toMatchObject({ listening: true, statusKind: 'listening' });
  });

  it('opens the panel but does not guess while the backend is still connecting', async () => {
    const harness = boot();

    await command('kirosight.activate')(); // panel closed: opens it and starts the connection
    await flush();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(harness.factory.sockets).toHaveLength(1);
    expect(frameTypes(harness)).not.toContain('record_start');
    expect((await systemTexts())).toEqual([]); // nothing true to say yet
  });

  it('a repeated activation does not start a second recording', async () => {
    const harness = boot();
    await openAndConnect(harness);

    await command('kirosight.activate')();
    await command('kirosight.activate')();
    await command('kirosight.activate')();
    await flush();

    expect(framesOf(harness, 'record_start')).toHaveLength(1);
    expect(vscodeMockState.webviewPanels).toHaveLength(1);
  });

  it('says voice is unavailable, still opens the panel and never throws when speech recognition is not set up', async () => {
    const harness = boot();
    await openAndConnect(harness, { ...READY_CAPS, stt: false });

    await expect(Promise.resolve(command('kirosight.activate')())).resolves.toBeUndefined();

    expect(frameTypes(harness)).toEqual(['hello']);
    // Stated when the capability arrived, and stated again because the user just asked for voice.
    const unavailable = 'Voice input is unavailable because speech recognition is not set up. You can keep typing.';
    expect(await systemTexts()).toEqual([unavailable, unavailable]);
    expect(viewStates().at(-1)!.voice.state).toBe('unavailable');
  });

  it('still opens the panel when the setting turns voice off, and says so', async () => {
    const harness = boot({ 'kirosight.voice.enabled': false });
    await openAndConnect(harness);

    await command('kirosight.activate')();
    await flush();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(frameTypes(harness)).toEqual(['hello']);
    expect(viewStates().at(-1)).toMatchObject({ voice: { state: 'unavailable', reasonText: VOICE_DISABLED_TEXT } });
    expect(await systemTexts()).toEqual([VOICE_DISABLED_TEXT]);
  });
});

// =====================================================================================================================

describe('voice wiring: push-to-talk through the validated bridge', () => {
  it('start, stop, then the transcript takes the typed path: the same pipeline, source "voice"', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);

    await pressPushToTalk();
    expect(framesOf(harness, 'record_start')).toHaveLength(1);
    expect(viewStates().at(-1)).toMatchObject({ listening: true });

    const stopping = pressPushToTalk();
    await flush();
    expect(framesOf(harness, 'record_stop')).toEqual([{ version: 1, type: 'record_stop', id: 'rec-1' }]);
    socket.triggerJson(transcriptionResult('rec-1', 'where am I'));
    await stopping;
    await flush();

    expect((await transcript()).map(({ role, text, source }) => [role, text, source])).toEqual([
      ['user', 'where am I', 'voice'],
      ['kirosight', 'No file is open.', undefined],
      // Task 9.7: this stub backend reports no text-to-speech, so speech output says so once, as a
      // separate entry after the answer (design F3). The answer itself is untouched.
      ['system', SPEECH_UNAVAILABLE_TEXT, undefined],
    ]);
    expect(viewStates().at(-1)).toMatchObject({ listening: false, statusKind: 'idle' });
  });

  it('spoken text is data: shell-like speech reaches the backend as a request and runs nothing', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);
    await pressPushToTalk();
    const stopping = pressPushToTalk();
    await flush();

    socket.triggerJson(transcriptionResult('rec-1', 'run rm -rf / && open /etc/passwd'));
    await flush();

    // It is an ordinary agent request, tagged as spoken: the router does not recognize it as a command.
    const requests = framesOf(harness, 'agent_request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ utterance: { text: 'run rm -rf / && open /etc/passwd', source: 'voice' } });
    // Starting push-to-talk is an interruption (Task 9.5): it advances the request lane before the
    // recording starts, so the first request of the session is req-2 and req-1 is never issued.
    expect(requests[0]!.id).toBe('req-2');

    // A reply for the id that was superseded is stale. It must be ignored: not shown, and no action
    // it proposes may run (a safe FOCUS_EDITOR would visibly execute a command if it were accepted).
    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: 'req-1', speech: 'STALE ANSWER',
      action: { type: 'FOCUS_EDITOR' }, confirmationRequired: false,
    });
    await flush();
    expect(vscodeMockState.executedCommands).toEqual([]);
    expect(JSON.stringify(viewStates())).not.toContain('STALE ANSWER');
    expect(framesOf(harness, 'action_result')).toEqual([]);

    // The current request's reply is still accepted.
    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: 'req-2', speech: 'I cannot do that.',
      action: { type: 'NO_ACTION' }, confirmationRequired: false,
    });
    await stopping;
    await flush();

    expect(vscodeMockState.executedCommands).toEqual([]);
    const entries = await transcript();
    expect(entries[0]).toMatchObject({ role: 'user', source: 'voice' });
    expect(entries.map((entry) => entry.text)).toContain('I cannot do that.');
    expect(entries.map((entry) => entry.text)).not.toContain('STALE ANSWER');
    expect(framesOf(harness, 'action_result')).toHaveLength(1); // the one answer to the proposed NO_ACTION
  });

  it('Escape abandons the recording and a late transcript is not routed', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);
    await pressPushToTalk();

    await panel().receive({ type: 'interrupt' });
    await flush();

    expect(framesOf(harness, 'cancel')).toEqual([{ version: 1, type: 'cancel', targetId: 'rec-1' }]);
    expect(viewStates().at(-1)).toMatchObject({ listening: false });

    socket.triggerJson(transcriptionResult('rec-1', 'where am I'));
    await flush();
    expect((await transcript()).filter((entry) => entry.role === 'user')).toEqual([]);
  });

  it('a duplicate or stale reply is routed at most once', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);
    await pressPushToTalk();
    const stopping = pressPushToTalk();
    await flush();

    socket.triggerJson(transcriptionResult('rec-1', 'where am I'));
    socket.triggerJson(transcriptionResult('rec-1', 'where am I'));
    socket.triggerJson(transcriptionResult('rec-9', 'next error'));
    await stopping;
    await flush();

    expect((await transcript()).filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual(['where am I']);
  });

  it('no answer for 10 s: a stated timeout, nothing routed, push-to-talk usable again', async () => {
    const harness = boot();
    await openAndConnect(harness);
    await pressPushToTalk();
    const stopping = pressPushToTalk();
    await flush();

    harness.voiceScheduler.advance(STT_RESPONSE_LIMIT_MS);
    await stopping;
    await flush();

    expect(await systemTexts()).toEqual([
      'Voice input could not be processed: speech recognition did not answer in time. You can type the same request.',
    ]);
    expect((await transcript()).filter((entry) => entry.role === 'user')).toEqual([]);
    await pressPushToTalk();
    expect(framesOf(harness, 'record_start')).toHaveLength(2);
  });

  it('ignores a push-to-talk press when voice is turned off in the settings', async () => {
    const harness = boot({ 'kirosight.voice.enabled': false });
    await openAndConnect(harness);

    await pressPushToTalk();
    await panel().receive({ type: 'interrupt' });

    expect(frameTypes(harness)).toEqual(['hello']);
    expect(hostMessages('start_capture')).toEqual([]);
  });
});

// =====================================================================================================================

describe('voice wiring: failures are stated and typing keeps working', () => {
  const typedWorks = async (): Promise<void> => {
    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'where am I' });
    expect(posted()).toContainEqual({ type: 'submit_ack', submitId: 's1', status: 'handled' });
  };

  it('microphone denied: a stated entry, no recording left open, typing works, and a later grant works', async () => {
    const harness = boot();
    // The handshake sees a device; the operating system's refusal is only found when it is opened.
    const socket = await openAndConnect(harness);

    await command('kirosight.activate')();
    await flush();
    expect(framesOf(harness, 'record_start')).toHaveLength(1);
    socket.triggerJson(errorMessage('rec-1', 'MIC_DENIED'));
    await flush();

    expect(await systemTexts()).toEqual([
      'Voice input could not be processed: microphone permission was denied. You can type the same request.',
    ]);
    expect(viewStates().at(-1)).toMatchObject({ listening: false });
    await typedWorks();

    await command('kirosight.activate')(); // access granted since: the next activation listens
    await flush();
    expect(framesOf(harness, 'record_start')).toHaveLength(2);
    expect(viewStates().at(-1)).toMatchObject({ listening: true });
  });

  it('missing speech credentials: a plain-language entry without the variable name, nothing routed', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);
    await pressPushToTalk();
    const stopping = pressPushToTalk();
    await flush();

    socket.triggerJson(errorMessage('rec-1', 'CREDENTIAL_MISSING', false));
    await stopping;
    await flush();

    const texts = await systemTexts();
    expect(texts).toEqual([
      'Voice input could not be processed: speech recognition is unavailable. You can type the same request.',
    ]);
    expect(JSON.stringify(viewStates())).not.toContain('raw backend text');
    expect((await transcript()).filter((entry) => entry.role === 'user')).toEqual([]);
    await typedWorks();
  });

  it('no speech: a plain-language entry, nothing routed', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);
    await pressPushToTalk();
    const stopping = pressPushToTalk();
    await flush();

    socket.triggerJson(errorMessage('rec-1', 'STT_NO_SPEECH'));
    await stopping;
    await flush();

    expect(await systemTexts()).toEqual([
      'Voice input could not be processed: no speech was recognized. You can type the same request.',
    ]);
  });

  it('a lost backend stops listening, is stated once, keeps typing local, and recovers when the backend returns', async () => {
    const harness = boot();
    await openAndConnect(harness);
    await pressPushToTalk();
    expect(viewStates().at(-1)).toMatchObject({ listening: true });

    harness.factory.last.triggerClose();
    await flush();

    expect(viewStates().at(-1)).toMatchObject({ listening: false });
    const texts = await systemTexts();
    expect(texts.some((text) => text.includes('backend is not connected'))).toBe(true);
    await typedWorks(); // local commands never need the backend

    harness.scheduler.advance(1_000); // the connection manager retries while the panel is open
    harness.factory.last.triggerOpen();
    harness.factory.last.triggerJson(ack(READY_CAPS));
    await flush();
    await command('kirosight.activate')();
    await flush();
    expect(framesOf(harness, 'record_start')).toHaveLength(1); // on the new connection
    expect(viewStates().at(-1)).toMatchObject({ listening: true });
  });

  it('never clears or changes an unsent typed draft: the host sends no input state at all', async () => {
    const harness = boot();
    await openAndConnect(harness);
    await pressPushToTalk();
    await panel().receive({ type: 'interrupt' });

    for (const state of viewStates()) {
      expect(Object.keys(state)).not.toContain('input');
      expect(Object.keys(state)).not.toContain('draft');
    }
    expect(posted().some((message) => message.type === 'submit_ack')).toBe(false);
  });
});

// =====================================================================================================================

describe('voice wiring: the webview fallback is used carefully', () => {
  it('when the backend microphone is unusable, push-to-talk asks the webview once and does not keep retrying', async () => {
    const harness = boot();
    await openAndConnect(harness, { ...READY_CAPS, mic: 'unavailable' });
    await command('kirosight.activate')();
    await flush();
    expect(hostMessages('start_capture')).toEqual([]); // activation never prompts for the microphone

    const pressing = pressPushToTalk();
    await flush();
    expect(hostMessages('start_capture')).toHaveLength(1); // the explicit press asks the panel to record
    await panel().receive({ type: 'mic_state', state: 'denied' }); // Kiro's webview refuses (Spike D)
    await pressing;
    await flush();

    await pressPushToTalk();
    await pressPushToTalk();
    expect(hostMessages('start_capture')).toHaveLength(1); // not asked again
    expect(frameTypes(harness)).toEqual(['hello']); // and nothing was recorded or uploaded
  });

  it('drops audio the panel was never asked for: it is not relayed to the backend', async () => {
    const harness = boot();
    await openAndConnect(harness);

    await panel().receive({ type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AQID', seq: 0, final: true });
    await panel().receive({ type: 'mic_state', state: 'granted' });

    expect(frameTypes(harness)).toEqual(['hello']);
  });
});

// =====================================================================================================================

describe('voice wiring: cleanup and lifecycle', () => {
  it('closing the panel stops the recording and does not report the intentional disconnect as a failure', async () => {
    const harness = boot();
    await openAndConnect(harness);
    await pressPushToTalk();
    const textsBefore = await systemTexts();

    panel().dispose();
    await flush();

    expect(framesOf(harness, 'cancel')).toEqual([{ version: 1, type: 'cancel', targetId: 'rec-1' }]);
    expect(harness.factory.last.readyState).not.toBe(1); // the connection closed with the panel
    expect(textsBefore.some((text) => text.includes('backend is not connected'))).toBe(false);
    expect(harness.scheduler.pendingCount).toBe(0);
  });

  it('disposing the extension releases the recording and ignores everything afterwards', async () => {
    const harness = boot();
    const socket = await openAndConnect(harness);
    await pressPushToTalk();
    const countBefore = harness.voiceScheduler.pendingCount;
    expect(countBefore).toBeGreaterThan(0); // the 60 s cap is armed while listening

    for (const subscription of harness.subscriptions) subscription.dispose();
    await flush();

    expect(framesOf(harness, 'cancel')).toEqual([{ version: 1, type: 'cancel', targetId: 'rec-1' }]);
    expect(harness.voiceScheduler.pendingCount).toBe(0);

    const framesAfterDispose = socket.sentMessages.length;
    socket.triggerJson(transcriptionResult('rec-1', 'where am I'));
    await flush();
    expect(socket.sentMessages).toHaveLength(framesAfterDispose);
  });

  it('after a reactivation only the new instance routes voice: no duplicated listeners', async () => {
    const first = boot();
    const firstSocket = await openAndConnect(first);
    for (const subscription of first.subscriptions) subscription.dispose();
    await flush();

    const second = start(); // the extension is activated again, without resetting VS Code
    const secondSocket = await openAndConnect(second);
    await pressPushToTalk();
    const stopping = pressPushToTalk();
    await flush();
    secondSocket.triggerJson(transcriptionResult('rec-1', 'where am I'));
    firstSocket.triggerJson(transcriptionResult('rec-1', 'next error')); // the old instance hears nothing
    await stopping;
    await flush();

    expect((await transcript()).filter((entry) => entry.role === 'user').map((entry) => entry.text)).toEqual(['where am I']);
    expect(framesOf(second, 'record_start')).toHaveLength(1);
  });
});

// =====================================================================================================================

describe('voice wiring: construction rules', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');

  it('constructs exactly one voice stack, from the setting, and registers its cleanup', () => {
    expect(source.match(/new VoiceWiring\(/g)).toHaveLength(1);
    expect(source).toContain('readVoiceEnabled()');
    expect(source).toContain('voice?.dispose()');
  });

  it('keeps voice logic out of extension.ts: no second state machine, no microphone, no provider', () => {
    expect(source).not.toMatch(/new VoiceController\(|new VoiceSession\(|new BackendLocalVoiceInput\(|new WebviewVoiceInput\(|new AudioRelay\(/);
    expect(source).not.toMatch(/getUserMedia|MediaRecorder|sounddevice|deepgram|DEEPGRAM|Bedrock\(|api[_-]?key/i);
    expect(source).not.toMatch(/executeCommand|RUN_COMMAND/);
  });

  it('prefers the backend-local input and routes finished text only through the one InputPipeline', () => {
    const wiring = readFileSync(resolvePath(__dirname, '../../src/voice/voiceWiring.ts'), 'utf8');

    const code = wiring.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // ignore comments
    expect(wiring).toContain('preferred: DEFAULT_VOICE_KIND');
    expect(wiring).toContain('pipeline: deps.pipeline');
    expect(code).not.toMatch(/route\(|validateAction|ActionGate|\.handle\(/);
    expect(source).toContain('pipeline: inputPipeline');
  });
});
