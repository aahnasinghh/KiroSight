/**
 * Task 8.12: timing and substitution tests for the voice layer.
 *
 * Requirements 9.1, 9.3, 10.1, 10.3, 19.5 and 19.6.
 *
 * Everything runs on fake clocks (`FakeScheduler`), a fake WebSocket and fake microphones, so no test
 * waits in real time and none touches a microphone, Deepgram or the network. The real
 * `VoiceController`, `VoiceSession`, `BackendLocalVoiceInput`, `WebviewVoiceInput`, `AudioRelay`,
 * `BackendClipTranscriber`, `InputPipeline`, `TranscriptStore` and the real webview page (main.js in
 * jsdom) are under test.
 *
 * 1. STT with no answer for 10 s: a Transcript entry within 1 s, the typed draft untouched and
 *    push-to-talk still enabled.
 * 2. Initialization not finished by 10 s: the "unavailable for the session" entry, with push-to-talk
 *    still focusable and explained in visible text.
 * 3. A recording stops at 60 s.
 * 4. No non-zero audio sample within 5 s selects the backend-local implementation.
 * 5. The same VoiceController scenarios give identical routing output for a webview input and a
 *    backend-local input.
 * 6. Audio the host receives is relayed within 500 ms, in order (Req 19.5).
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { buildWebviewHtml } from '../../src/webview/html';
import { createViewModel } from '../../src/webview/viewModel';
import { AudioRelay, RELAY_DEADLINE_MS, type AudioChunk, type AudioFrame, type RelayOutcome } from '../../src/voice/audioRelay';
import { BackendClipTranscriber, routeTranscriptions } from '../../src/voice/backendClipTranscriber';
import { BackendLocalVoiceInput } from '../../src/voice/backendLocalVoiceInput';
import {
  FIRST_SAMPLE_WATCHDOG_MS,
  STT_RESPONSE_LIMIT_MS,
  VOICE_INIT_BUDGET_MS,
  VoiceController,
} from '../../src/voice/voiceController';
import {
  MAX_VOICE_DURATION_MS,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceClip,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import { VoiceSession } from '../../src/voice/voiceSession';
import { WebviewVoiceInput, type WebviewCaptureBridge } from '../../src/voice/webviewVoiceInput';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(resolve(here, '../../media/main.js'), 'utf8');

const LOCAL_CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };
const WEBVIEW_CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'not_applicable' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

// --- the real webview page, driven by the real view model ---------------------------------------------------------

const opened: JSDOM[] = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.window.close();
});

/** The generated page with the real main.js, a typed draft in its input, and a way to push view state. */
function openPanel() {
  const html = buildWebviewHtml({
    cspSource: "'self' https://*.vscode-cdn.net",
    styleUri: 'https://webview.example.invalid/media/styles.css',
    scriptUri: 'https://webview.example.invalid/media/main.js',
    nonce: 'dGVzdC1ub25jZS12YWx1ZQ==',
  });
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  opened.push(dom);
  const { window } = dom;
  const posts: unknown[] = [];
  (window as unknown as Record<string, unknown>).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => { posts.push(message); },
  });
  window.eval(mainSource);

  const byId = (id: string) => window.document.getElementById(id) as HTMLElement;
  const input = byId('input') as HTMLInputElement;
  return {
    posts,
    input,
    byId,
    /** What the extension would send after the voice session changed: the real view model. */
    show(session: VoiceSession, transcript: TranscriptStore): void {
      const view = session.view;
      window.dispatchEvent(new window.MessageEvent('message', {
        data: {
          type: 'view_state',
          ...createViewModel({
            statusKind: view.statusKind ?? 'idle',
            voice: view.voice,
            listening: view.listening,
            transcript: transcript.getEntries(),
          }),
        },
      }));
    },
    submit(): void {
      byId('cmd').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    },
    lines: () => Array.from(byId('transcript').children).map((child) => child.textContent),
    pttEnabled: () => byId('ptt').getAttribute('aria-disabled') === 'false',
    pttFocusable: () => !byId('ptt').hasAttribute('disabled') && byId('ptt').tagName === 'BUTTON',
  };
}

// --- the real backend-local stack on a fake socket ----------------------------------------------------------------------

/** Records the time on the controller clock at which each Transcript entry is written. */
function timestamped(transcript: TranscriptStore, clock: FakeScheduler): Array<{ at: number; text: string }> {
  const written: Array<{ at: number; text: string }> = [];
  const append = transcript.append.bind(transcript);
  transcript.append = ((role, text, source) => {
    written.push({ at: clock.now, text });
    return append(role, text, source);
  }) as typeof transcript.append;
  return written;
}

async function buildLocalStack(capabilities: Capabilities | null = LOCAL_CAPS) {
  const factory = new FakeSocketFactory();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
  client.connect();
  factory.last.triggerOpen();
  if (capabilities !== null) {
    factory.last.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities });
  }

  const transcript = new TranscriptStore();
  const routed: Array<{ text: string; source: string }> = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async (intent) => { routed.push({ text: intent.kind, source: 'local' }); return `did ${intent.kind}`; } },
  });
  const input = new BackendLocalVoiceInput({ client, scheduler: new FakeScheduler() });
  const clips = new BackendClipTranscriber(client);
  const controllerClock = new FakeScheduler();
  const sessionClock = new FakeScheduler();
  const controller = new VoiceController({
    inputs: { backend_local: input },
    transcriber: routeTranscriptions(input, clips),
    pipeline,
    scheduler: controllerClock,
  });
  const session = new VoiceSession({
    controller,
    transcript,
    getCapabilities: () => client.capabilities,
    scheduler: sessionClock,
  });
  input.onRecordingEnded((end) => session.notifyRecordingEnded(end));
  return { factory, client, transcript, pipeline, routed, input, controller, session, controllerClock, sessionClock };
}

const frameTypes = (factory: FakeSocketFactory): unknown[] => factory.last.sentMessages.map((frame) => frame.type);
const systemTexts = (transcript: TranscriptStore): string[] =>
  transcript.getEntries().filter((entry) => entry.role === 'system').map((entry) => entry.text);

// =====================================================================================================================
// 1. STT with no answer for 10 s (Req 9.3, 10.1)
// =====================================================================================================================

describe('STT that never answers (Req 9.3, 10.1)', () => {
  const TIMEOUT_TEXT =
    'Voice input could not be processed: speech recognition did not answer in time. You can type the same request.';

  it('states the failure within 1 s of the 10 s limit, routes nothing, keeps the draft and leaves push-to-talk enabled', async () => {
    const stack = await buildLocalStack();
    await stack.session.initialize();
    const panel = openPanel();
    panel.input.value = 'explain this error'; // a typed draft the user has not sent yet

    await stack.session.activate(() => undefined);
    const written = timestamped(stack.transcript, stack.controllerClock);
    const stoppedAt = stack.controllerClock.now;
    const stopping = stack.session.togglePushToTalk();
    await flush();
    expect(frameTypes(stack.factory).at(-1)).toBe('record_stop'); // the clip went to the backend, which stays silent

    stack.controllerClock.advance(STT_RESPONSE_LIMIT_MS - 1);
    await flush();
    expect(written).toEqual([]); // nothing is claimed before the limit
    expect(stack.session.view.statusKind).toBe('processing');

    stack.controllerClock.advance(1);
    await stopping;

    // The entry exists exactly when the 10 s limit ends, which is well inside "within 1 s" of detection.
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toBe(TIMEOUT_TEXT);
    expect(written[0]!.at - stoppedAt).toBe(STT_RESPONSE_LIMIT_MS);
    expect(written[0]!.at - (stoppedAt + STT_RESPONSE_LIMIT_MS)).toBeLessThanOrEqual(1_000);
    expect(stack.routed).toEqual([]); // nothing was routed
    expect(stack.transcript.getEntries().filter((entry) => entry.role === 'user')).toEqual([]);

    panel.show(stack.session, stack.transcript);
    expect(panel.lines()).toContain(`System: ${TIMEOUT_TEXT}`);
    expect(panel.input.value).toBe('explain this error'); // the draft is untouched
    expect(panel.pttEnabled()).toBe(true);
    expect(panel.pttFocusable()).toBe(true);
    expect(stack.session.view.statusKind).toBeNull();
  });

  it('keeps typing working after the timeout, and push-to-talk can be used again', async () => {
    const stack = await buildLocalStack();
    await stack.session.initialize();
    await stack.session.activate(() => undefined);
    const stopping = stack.session.togglePushToTalk();
    await flush();
    stack.controllerClock.advance(STT_RESPONSE_LIMIT_MS);
    await stopping;

    await expect(stack.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    expect(stack.routed).toEqual([{ text: 'WHERE_AM_I', source: 'local' }]);

    await stack.session.togglePushToTalk(); // starts a fresh recording
    expect(stack.session.view.listening).toBe(true);
  });

  it('the limit is exactly 10 s and the abandoned clip is cancelled at the backend', async () => {
    expect(STT_RESPONSE_LIMIT_MS).toBe(10_000);
    const stack = await buildLocalStack();
    await stack.session.initialize();
    await stack.session.activate(() => undefined);
    const stopping = stack.session.togglePushToTalk();
    await flush();

    stack.controllerClock.advance(STT_RESPONSE_LIMIT_MS);
    await stopping;

    expect(frameTypes(stack.factory).at(-1)).toBe('cancel');
    expect(stack.controllerClock.pendingCount).toBe(0); // no timer is left running
  });

  it('negative control: an answer that arrives just before the limit is routed, not timed out', async () => {
    const stack = await buildLocalStack();
    await stack.session.initialize();
    await stack.session.activate(() => undefined);
    const stopping = stack.session.togglePushToTalk();
    await flush();

    stack.controllerClock.advance(STT_RESPONSE_LIMIT_MS - 1);
    stack.factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'where am I' });
    await stopping;

    expect(stack.routed).toEqual([{ text: 'WHERE_AM_I', source: 'local' }]);
    expect(systemTexts(stack.transcript)).toEqual([]);
  });
});

// =====================================================================================================================
// 2. Initialization not finished by 10 s (Req 10.3)
// =====================================================================================================================

describe('voice initialization that never finishes (Req 10.3)', () => {
  const UNAVAILABLE_TEXT =
    'Voice input and output are unavailable for this session because setup did not finish in time. You can keep typing.';

  it('adds the "unavailable for the session" entry at 10 s, once, and not a moment before', async () => {
    const stack = await buildLocalStack(null);
    const written = timestamped(stack.transcript, stack.sessionClock);

    stack.session.begin();
    await stack.session.initialize(); // still no backend: keeps waiting
    stack.sessionClock.advance(VOICE_INIT_BUDGET_MS - 1);

    expect(written).toEqual([]);
    expect(stack.session.view.voice.state).toBe('initializing');

    stack.sessionClock.advance(1);

    expect(written).toEqual([{ at: VOICE_INIT_BUDGET_MS, text: UNAVAILABLE_TEXT }]);
    expect(stack.session.view).toMatchObject({ voice: { state: 'unavailable' }, listening: false, statusKind: 'voice_unavailable' });

    stack.sessionClock.advance(60_000);
    expect(systemTexts(stack.transcript)).toEqual([UNAVAILABLE_TEXT]); // stated once, not repeatedly
  });

  it('keeps push-to-talk focusable with visible text, and typing with its draft working', async () => {
    const stack = await buildLocalStack(null);
    const panel = openPanel();
    panel.input.value = 'where am I';
    stack.session.begin();
    stack.sessionClock.advance(VOICE_INIT_BUDGET_MS);

    panel.show(stack.session, stack.transcript);

    expect(panel.lines()).toContain(`System: ${UNAVAILABLE_TEXT}`);
    expect(panel.byId('ptt').getAttribute('aria-disabled')).toBe('true'); // unavailable, but...
    expect(panel.pttFocusable()).toBe(true); // ...a real, focusable, non-disabled button
    expect(panel.byId('ptt-note').textContent).toBe(UNAVAILABLE_TEXT); // and the reason is visible text
    expect(panel.byId('status').textContent).toContain('Voice unavailable');
    expect(panel.input.value).toBe('where am I');
    panel.submit();
    expect(panel.posts.at(-1)).toMatchObject({ type: 'submit_text', text: 'where am I' });
    await expect(stack.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
  });

  it('negative control: initialization that finishes in time adds no such entry', async () => {
    const stack = await buildLocalStack();
    stack.session.begin();
    stack.sessionClock.advance(VOICE_INIT_BUDGET_MS - 1);
    await stack.session.initialize();
    stack.sessionClock.advance(VOICE_INIT_BUDGET_MS * 2);

    expect(systemTexts(stack.transcript)).toEqual([]);
    expect(stack.session.view.voice.state).toBe('available');
  });

  it('the controller itself gives up on a microphone check that never answers after exactly 10 s', async () => {
    expect(VOICE_INIT_BUDGET_MS).toBe(10_000);
    const clock = new FakeScheduler();
    const never: VoiceInput = {
      kind: 'backend_local',
      maxDurationMs: MAX_VOICE_DURATION_MS,
      available: () => new Promise<VoiceAvailability>(() => undefined),
      start: async () => undefined,
      stop: async () => ({ backendClipId: 'x' }),
      cancel: () => undefined,
    };
    const controller = new VoiceController({
      inputs: { backend_local: never },
      transcriber: { transcribe: async () => ({ ok: false, reason: 'timeout' }) },
      pipeline: { handle: async () => undefined },
      scheduler: clock,
    });

    const initializing = controller.initialize(LOCAL_CAPS);
    await flush();
    clock.advance(VOICE_INIT_BUDGET_MS - 1);
    await flush();
    expect(controller.status.phase).toBe('initializing');

    clock.advance(1);
    const status = await initializing;

    expect(status).toMatchObject({ phase: 'unavailable', cause: 'init_timeout' });
    expect(status.text).toContain('You can keep typing.');
  });
});

// =====================================================================================================================
// 3. A recording stops at 60 s (Req 9.1)
// =====================================================================================================================

describe('the 60 s recording cap (Req 9.1)', () => {
  it('stops and transcribes at exactly 60 s without the user pressing anything', async () => {
    const stack = await buildLocalStack();
    await stack.session.initialize();
    await stack.session.activate(() => undefined);
    expect(stack.controllerClock.pendingDelays).toContain(MAX_VOICE_DURATION_MS);

    stack.controllerClock.advance(MAX_VOICE_DURATION_MS - 1);
    await flush();
    expect(stack.session.view.listening).toBe(true);
    expect(frameTypes(stack.factory)).toEqual(['hello', 'record_start']); // still recording

    stack.controllerClock.advance(1);
    await flush();
    expect(frameTypes(stack.factory)).toEqual(['hello', 'record_start', 'record_stop']);
    expect(stack.session.view.listening).toBe(false);

    stack.factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'where am I' });
    await flush();
    expect(stack.routed).toEqual([{ text: 'WHERE_AM_I', source: 'local' }]);
    expect(stack.transcript.getEntries()[0]).toMatchObject({ role: 'user', text: 'where am I', source: 'voice' });
  });

  it('is 60 seconds for both implementations', () => {
    expect(MAX_VOICE_DURATION_MS).toBe(60_000);
    const backendLocal = new BackendLocalVoiceInput({
      client: new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: new FakeSocketFactory().create, scheduler: new FakeScheduler() }),
      scheduler: new FakeScheduler(),
    });
    const webview = new WebviewVoiceInput({
      bridge: { isOpen: () => true, command: () => undefined },
      relay: new AudioRelay({ sendAudioClip: () => true, cancelAudioClip: () => true }),
      scheduler: new FakeScheduler(),
    });

    expect(backendLocal.maxDurationMs).toBe(60_000);
    expect(webview.maxDurationMs).toBe(60_000);
  });

  it('does not stop a user-ended recording a second time at 60 s', async () => {
    const stack = await buildLocalStack();
    await stack.session.initialize();
    await stack.session.activate(() => undefined);
    const stopping = stack.session.togglePushToTalk();
    await flush();
    stack.factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'next error' });
    await stopping;

    stack.controllerClock.advance(MAX_VOICE_DURATION_MS * 2);
    await flush();

    expect(frameTypes(stack.factory).filter((type) => type === 'record_stop')).toHaveLength(1);
    expect(stack.controllerClock.pendingCount).toBe(0);
  });
});

// =====================================================================================================================
// 4. No non-zero sample within 5 s selects the backend-local implementation (Req 19.6)
// =====================================================================================================================

class FakeBridge implements WebviewCaptureBridge {
  public readonly commands: string[] = [];
  public isOpen(): boolean { return true; }
  public command(type: 'start_capture' | 'stop_capture'): void { this.commands.push(type); }
}

class FakeBackendLocal implements VoiceInput {
  public readonly kind = 'backend_local' as const;
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;
  public starts = 0;
  public async available(): Promise<VoiceAvailability> { return { ok: true }; }
  public async start(): Promise<void> { this.starts += 1; }
  public async stop(): Promise<VoiceClip> { return { backendClipId: 'rec-1' }; }
  public cancel(): void { /* nothing to release */ }
}

function webviewWithFallback() {
  const bridge = new FakeBridge();
  const relayOutcomes: RelayOutcome[] = [];
  const relay = new AudioRelay({ sendAudioClip: () => true, cancelAudioClip: () => true });
  const clock = new FakeScheduler();
  let controller: VoiceController | null = null;
  const webview = new WebviewVoiceInput({
    bridge,
    relay: {
      accept: (chunk) => { const outcome = relay.accept(chunk); relayOutcomes.push(outcome); return outcome; },
      reset: () => relay.reset(),
    },
    scheduler: clock,
    onFirstSample: () => controller?.notifyFirstSample(),
  });
  const fallback = new FakeBackendLocal();
  controller = new VoiceController({
    inputs: { webview, backend_local: fallback },
    transcriber: { transcribe: async () => ({ ok: true, text: 'where am I' }) },
    pipeline: { handle: async () => undefined },
    scheduler: clock,
    preferred: 'webview',
  });
  const chunk = (base64: string, seq: number): AudioChunk => ({ clipId: 'clip-1', mimeType: 'audio/webm', base64, seq, final: false });
  const start = async () => {
    const listening = controller!.startListening();
    await flush();
    webview.handleMicState('granted');
    return listening;
  };
  return { bridge, clock, controller, webview, fallback, chunk, start, relayOutcomes };
}

describe('webview capture that produces no audio (Req 19.6)', () => {
  it('uses the backend-local implementation once 5 s pass with no non-zero sample', async () => {
    const { controller, clock, bridge, start, fallback } = webviewWithFallback();
    await controller.initialize(LOCAL_CAPS);
    expect(controller.status.kind).toBe('webview'); // the preferred implementation
    expect(await start()).toEqual({ status: 'listening' });

    clock.advance(FIRST_SAMPLE_WATCHDOG_MS - 1);
    expect(controller.status).toMatchObject({ phase: 'listening', kind: 'webview', webviewUnreliable: false });

    clock.advance(1);

    expect(controller.status).toMatchObject({ phase: 'idle', kind: 'backend_local', webviewUnreliable: true });
    expect(bridge.commands).toEqual(['start_capture', 'stop_capture']); // the page was told to release the microphone
    expect(await controller.startListening()).toEqual({ status: 'listening' });
    expect(fallback.starts).toBe(1);
    expect(controller.status.kind).toBe('backend_local');
  });

  it('is 5 seconds', () => {
    expect(FIRST_SAMPLE_WATCHDOG_MS).toBe(5_000);
  });

  it('an empty chunk is not a sample: only non-zero length audio counts', async () => {
    const { controller, clock, webview, chunk, start } = webviewWithFallback();
    await controller.initialize(LOCAL_CAPS);
    await start();

    clock.advance(4_000);
    webview.handleAudioClip(chunk('', 0)); // zero-length
    clock.advance(1_000);

    expect(controller.status).toMatchObject({ kind: 'backend_local', webviewUnreliable: true });
  });

  it('negative control: a real sample before 5 s keeps the webview', async () => {
    const { controller, clock, webview, chunk, start, bridge } = webviewWithFallback();
    await controller.initialize(LOCAL_CAPS);
    await start();

    clock.advance(4_999);
    webview.handleAudioClip(chunk(Buffer.from([1, 2, 3]).toString('base64'), 0));
    clock.advance(60_000 - 4_999 - 1);

    expect(controller.status).toMatchObject({ phase: 'listening', kind: 'webview', webviewUnreliable: false });
    expect(bridge.commands).toEqual(['start_capture']);
  });

  it('never returns to the webview during the session, even when asked to prefer it', async () => {
    const { controller, clock, start } = webviewWithFallback();
    await controller.initialize(LOCAL_CAPS);
    await start();
    clock.advance(FIRST_SAMPLE_WATCHDOG_MS);

    const status = await controller.initialize(LOCAL_CAPS);

    expect(status).toMatchObject({ kind: 'backend_local', webviewUnreliable: true });
  });
});

// =====================================================================================================================
// 5. Substitution: identical routing for a webview and a backend-local input (Req 19.7 via the controller)
// =====================================================================================================================

class ScriptedInput implements VoiceInput {
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;
  public starts = 0;
  public stops = 0;
  public cancels = 0;
  public constructor(public readonly kind: VoiceKind) {}
  public async available(): Promise<VoiceAvailability> { return { ok: true }; }
  public async start(): Promise<void> { this.starts += 1; }
  public async stop(): Promise<VoiceClip> {
    this.stops += 1;
    return this.kind === 'webview' ? new Uint8Array([1, 2, 3]) : { backendClipId: `rec-${this.stops}` };
  }
  public cancel(): void { this.cancels += 1; }
}

class ScriptedTranscriber implements VoiceTranscriber {
  public next: Array<TranscriptionOutcome | 'hang'> = [];
  public cancels = 0;
  private waiting: Array<(outcome: TranscriptionOutcome) => void> = [];

  public transcribe(): Promise<TranscriptionOutcome> {
    const outcome = this.next.shift() ?? { ok: true, text: 'where am I' };
    if (outcome !== 'hang') return Promise.resolve(outcome);
    return new Promise((resolveOutcome) => { this.waiting.push(resolveOutcome); });
  }

  public cancel(): void {
    this.cancels += 1;
    for (const resolveOutcome of this.waiting.splice(0)) resolveOutcome({ ok: false, reason: 'timeout' });
  }
}

function substitutionHarness(kind: VoiceKind) {
  const clock = new FakeScheduler();
  const input = new ScriptedInput(kind);
  const transcriber = new ScriptedTranscriber();
  const handled: Array<[string, string]> = [];
  const controller = new VoiceController({
    inputs: { [kind]: input },
    transcriber,
    pipeline: { handle: async (text, source) => { handled.push([text, source]); } },
    scheduler: clock,
    preferred: kind,
  });
  const capabilities = kind === 'webview' ? WEBVIEW_CAPS : LOCAL_CAPS;
  return { clock, input, transcriber, handled, controller, capabilities };
}

/** One scripted run of the controller; everything that is returned must not depend on the kind. */
async function runScript(kind: VoiceKind) {
  const { clock, input, transcriber, handled, controller, capabilities } = substitutionHarness(kind);
  const observed: unknown[] = [];
  const phases: string[] = [];
  controller.onStatus((status) => phases.push(status.phase));

  // A webview input reports its first audio sample as soon as it records; the scripted one does too,
  // so the 5 s watchdog (tested separately above) does not interfere with these scenarios.
  const listen = async () => {
    const outcome = await controller.startListening();
    if (kind === 'webview') controller.notifyFirstSample();
    return outcome;
  };

  const initial = await controller.initialize(capabilities);
  observed.push(['initialized', initial.phase, initial.cause, initial.text]);

  // 1. A normal utterance: padded text is trimmed once and handed over as a voice utterance.
  transcriber.next = [{ ok: true, text: '  next error  ' }];
  observed.push(await listen(), await controller.stopListening());

  // 2. Nothing recognised, 3. a speech failure, 4. an empty result: nothing is routed.
  for (const outcome of [{ ok: false, reason: 'no_speech' }, { ok: false, reason: 'stt_unavailable' }, { ok: true, text: '   ' }] as const) {
    transcriber.next = [outcome];
    observed.push(await listen(), await controller.stopListening());
  }

  // 5. No answer for 10 s: a timeout, nothing routed.
  transcriber.next = ['hang'];
  observed.push(await listen());
  const stopping = controller.stopListening();
  await flush();
  clock.advance(STT_RESPONSE_LIMIT_MS);
  observed.push(await stopping);

  // 6. Cancelled while listening: nothing routed, microphone released.
  observed.push(await listen());
  controller.cancel();
  observed.push(await controller.stopListening());

  // 7. The 60 s cap ends a recording and routes its text.
  transcriber.next = [{ ok: true, text: 'where am I' }];
  const capped = new Promise<unknown>((resolveCap) => { controller.onCapReached(resolveCap); });
  observed.push(await listen());
  clock.advance(MAX_VOICE_DURATION_MS);
  observed.push(await capped);

  // 8. Stopping with nothing started.
  observed.push(await controller.stopListening());

  return { observed, handled, phases, finalPhase: controller.status.phase, pending: clock.pendingCount, input };
}

describe.each<VoiceKind>(['webview', 'backend_local'])('the VoiceController scenarios with a %s input', (kind) => {
  it('routes exactly the spoken, trimmed texts as voice utterances and nothing else', async () => {
    const run = await runScript(kind);

    expect(run.handled).toEqual([['next error', 'voice'], ['where am I', 'voice']]);
    expect(run.observed).toEqual([
      ['initialized', 'idle', null, 'Voice is ready. Press push-to-talk to speak.'],
      { status: 'listening' }, { status: 'routed' },
      { status: 'listening' }, { status: 'failed', reason: 'no_speech' },
      { status: 'listening' }, { status: 'failed', reason: 'stt_unavailable' },
      { status: 'listening' }, { status: 'failed', reason: 'empty' },
      { status: 'listening' }, { status: 'failed', reason: 'timeout' },
      { status: 'listening' }, { status: 'not_listening' },
      { status: 'listening' }, { status: 'routed' },
      { status: 'not_listening' },
    ]);
  });

  it('releases the microphone and every timer, and ends idle', async () => {
    const run = await runScript(kind);

    expect(run.finalPhase).toBe('idle');
    expect(run.pending).toBe(0);
    expect(run.input.starts).toBe(run.input.stops + 1); // all but the cancelled recording were stopped
    expect(run.input.cancels).toBeGreaterThanOrEqual(1);
  });
});

describe('substituting the VoiceInput implementation', () => {
  it('gives identical routing output, results and status sequence for a webview and a backend-local input', async () => {
    const webview = await runScript('webview');
    const backendLocal = await runScript('backend_local');

    expect(backendLocal.handled).toEqual(webview.handled);
    expect(backendLocal.observed).toEqual(webview.observed);
    expect(backendLocal.phases).toEqual(webview.phases);
    expect(webview.handled.length).toBeGreaterThan(0); // not vacuous
  });

  it('is sensitive to a difference: a transcriber that answers differently changes the output', async () => {
    const a = substitutionHarness('webview');
    const b = substitutionHarness('backend_local');
    await a.controller.initialize(a.capabilities);
    await b.controller.initialize(b.capabilities);
    a.transcriber.next = [{ ok: true, text: 'next error' }];
    b.transcriber.next = [{ ok: true, text: 'previous error' }];

    await a.controller.startListening();
    await a.controller.stopListening();
    await b.controller.startListening();
    await b.controller.stopListening();

    expect(b.handled).not.toEqual(a.handled);
  });

  it('the real inputs also agree: a webview recording and a backend-local one route the same text the same way', async () => {
    // Webview: the host relays the page's audio and asks the backend for the text.
    const bridge = new FakeBridge();
    const relay = new AudioRelay({ sendAudioClip: () => true, cancelAudioClip: () => true });
    const webviewClock = new FakeScheduler();
    const webviewHandled: Array<[string, string]> = [];
    let webviewController: VoiceController | null = null;
    const webviewInput = new WebviewVoiceInput({
      bridge, relay, scheduler: webviewClock, onFirstSample: () => webviewController?.notifyFirstSample(),
    });
    webviewController = new VoiceController({
      inputs: { webview: webviewInput },
      transcriber: { transcribe: async () => ({ ok: true, text: 'what errors are there' }) },
      pipeline: { handle: async (text, source) => { webviewHandled.push([text, source]); } },
      scheduler: webviewClock,
      preferred: 'webview',
    });
    await webviewController.initialize(WEBVIEW_CAPS);
    const listening = webviewController.startListening();
    await flush();
    webviewInput.handleMicState('granted');
    await listening;
    webviewInput.handleAudioClip({ clipId: 'c', mimeType: 'audio/webm', base64: Buffer.from([1, 2]).toString('base64'), seq: 0, final: false });
    const stopping = webviewController.stopListening();
    await flush();
    webviewInput.handleAudioClip({ clipId: 'c', mimeType: 'audio/webm', base64: '', seq: 1, final: true });
    expect(await stopping).toEqual({ status: 'routed' });

    // Backend-local: the backend records and returns the text.
    const stack = await buildLocalStack();
    await stack.session.initialize();
    await stack.session.activate(() => undefined);
    const localStopping = stack.session.togglePushToTalk();
    await flush();
    stack.factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'what errors are there' });
    await localStopping;

    // Same text, same transcript entry for the user's query, whichever input produced it.
    expect(webviewHandled).toEqual([['what errors are there', 'voice']]);
    expect(stack.transcript.getEntries()[0]).toMatchObject({ role: 'user', text: 'what errors are there', source: 'voice' });
  });
});

// =====================================================================================================================
// 6. Relay timing (Req 19.5)
// =====================================================================================================================

describe('relaying received audio within 500 ms, in order (Req 19.5)', () => {
  class Clock {
    public current = 10_000;
    public readonly now = (): number => this.current;
  }

  function relayStack(sendDelayMs: number) {
    const clock = new Clock();
    const frames: Array<{ frame: AudioFrame; at: number }> = [];
    const relay = new AudioRelay(
      {
        sendAudioClip: (frame) => { clock.current += sendDelayMs; frames.push({ frame, at: clock.current }); return true; },
        cancelAudioClip: () => true,
      },
      undefined,
      clock.now,
    );
    const outcomes: RelayOutcome[] = [];
    const webview = new WebviewVoiceInput({
      bridge: new FakeBridge(),
      relay: { accept: (chunk) => { const outcome = relay.accept(chunk); outcomes.push(outcome); return outcome; }, reset: () => relay.reset() },
      scheduler: new FakeScheduler(),
    });
    return { clock, frames, outcomes, webview };
  }

  async function capturing(stack: ReturnType<typeof relayStack>) {
    const starting = stack.webview.start();
    stack.webview.handleMicState('granted');
    await starting;
  }

  const slice = (seq: number): AudioChunk => ({
    clipId: 'clip-1', mimeType: 'audio/webm', base64: Buffer.from([seq + 1, seq + 2]).toString('base64'), seq, final: false,
  });

  it('forwards each received chunk at the moment it is received, and in the order received', async () => {
    const stack = relayStack(0);
    await capturing(stack);
    const receivedAt: number[] = [];

    for (let seq = 0; seq < 4; seq += 1) {
      stack.clock.current += 1_000; // the recorder delivers a one-second slice
      receivedAt.push(stack.clock.current);
      stack.webview.handleAudioClip(slice(seq));
    }

    expect(stack.frames.map((entry) => entry.at)).toEqual(receivedAt); // each frame left when its chunk arrived
    expect(stack.frames.map((entry) => entry.frame.seq)).toEqual([0, 1, 2, 3]); // order preserved
    expect(stack.outcomes.every((outcome) => outcome.status === 'relayed' && !outcome.late)).toBe(true);
  });

  it('meets the 500 ms deadline at exactly 500 ms and misses it at 501 ms', async () => {
    expect(RELAY_DEADLINE_MS).toBe(500);
    const onTime = relayStack(500);
    await capturing(onTime);
    onTime.webview.handleAudioClip(slice(0));

    const slow = relayStack(501);
    await capturing(slow);
    slow.webview.handleAudioClip(slice(0));

    expect(onTime.outcomes[0]).toMatchObject({ status: 'relayed', latencyMs: 500, late: false });
    expect(slow.outcomes[0]).toMatchObject({ status: 'relayed', latencyMs: 501, late: true });
  });

  it('relays nothing for audio that arrives when no capture was requested', () => {
    const stack = relayStack(0);

    stack.webview.handleAudioClip(slice(0));

    expect(stack.frames).toEqual([]); // no capture was started: unrequested audio never leaves the host
  });
});
