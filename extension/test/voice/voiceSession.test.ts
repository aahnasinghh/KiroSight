import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { RecordingEnd } from '../../src/voice/backendLocalVoiceInput';
import {
  FIRST_SAMPLE_WATCHDOG_MS,
  STT_RESPONSE_LIMIT_MS,
  VOICE_INIT_BUDGET_MS,
  VoiceController,
  type VoiceStatus,
} from '../../src/voice/voiceController';
import {
  MAX_VOICE_DURATION_MS,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import {
  VoiceSession,
  describeVoiceFailure,
  resolveStatusKind,
  type VoiceControllerPort,
  type VoiceSessionView,
} from '../../src/voice/voiceSession';
import { FakeScheduler } from '../mocks/fakeScheduler';

const CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

class FakeInput implements VoiceInput {
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;
  public availability: VoiceAvailability = { ok: true };
  public startCalls = 0;
  public stopCalls = 0;
  public cancelCalls = 0;
  public startFails = false;
  public stopFails = false;

  public constructor(public readonly kind: VoiceKind = 'backend_local') {}

  public async available(): Promise<VoiceAvailability> { return this.availability; }

  public async start(): Promise<void> {
    this.startCalls += 1;
    if (this.startFails) throw new Error('start failed');
  }

  public async stop(): Promise<{ backendClipId: string }> {
    this.stopCalls += 1;
    if (this.stopFails) throw new Error('stop failed');
    return { backendClipId: `clip-${this.stopCalls}` };
  }

  public cancel(): void { this.cancelCalls += 1; }
}

class FakeTranscriber implements VoiceTranscriber {
  public outcomes: Array<TranscriptionOutcome | 'hang'> = [];
  public calls = 0;
  public cancelCalls = 0;
  private waiting: Array<(outcome: TranscriptionOutcome) => void> = [];

  public transcribe(): Promise<TranscriptionOutcome> {
    this.calls += 1;
    const next = this.outcomes.shift() ?? { ok: true, text: 'where am I' };
    if (next !== 'hang') return Promise.resolve(next);
    return new Promise((resolve) => { this.waiting.push(resolve); });
  }

  /** Like the real transcribers: giving up settles the wait, and the controller then discards it. */
  public cancel(): void {
    this.cancelCalls += 1;
    for (const resolve of this.waiting.splice(0)) resolve({ ok: false, reason: 'timeout' });
  }
}

function build(options: { kind?: VoiceKind; caps?: Capabilities | null } = {}) {
  const input = new FakeInput(options.kind ?? 'backend_local');
  const transcriber = new FakeTranscriber();
  const handled: Array<{ text: string; source: 'voice' }> = [];
  const controllerClock = new FakeScheduler();
  const sessionClock = new FakeScheduler();
  const transcript = new TranscriptStore();
  const caps: { value: Capabilities | null } = { value: options.caps === undefined ? CAPS : options.caps };
  const controller = new VoiceController({
    inputs: { [input.kind]: input },
    transcriber,
    pipeline: { handle: async (text, source) => { handled.push({ text, source }); } },
    scheduler: controllerClock,
  });
  const session = new VoiceSession({ controller, transcript, getCapabilities: () => caps.value, scheduler: sessionClock });
  const views: VoiceSessionView[] = [];
  session.onChange((view) => views.push(view));
  return { input, transcriber, handled, controllerClock, sessionClock, transcript, caps, controller, session, views };
}

type Harness = ReturnType<typeof build>;

async function ready(options: { kind?: VoiceKind; caps?: Capabilities | null } = {}): Promise<Harness> {
  const harness = build(options);
  await harness.session.initialize();
  return harness;
}

const systemTexts = (transcript: TranscriptStore): string[] =>
  transcript.getEntries().filter((entry) => entry.role === 'system').map((entry) => entry.text);

describe('VoiceSession view', () => {
  it('shows a ready, enabled push-to-talk once initialized, with no status override', async () => {
    const { session } = await ready();
    expect(session.view).toEqual({
      voice: { state: 'available', reasonText: 'Voice is ready. Press push-to-talk to speak.' },
      listening: false,
      statusKind: null,
    });
  });

  it('shows Listening while recording and Processing while the text is awaited', async () => {
    const { session, transcriber, controllerClock, handled } = await ready();
    transcriber.outcomes = ['hang'];

    await session.togglePushToTalk();
    expect(session.view).toMatchObject({ listening: true, statusKind: 'listening', voice: { state: 'available' } });

    const stopping = session.togglePushToTalk();
    await flush();
    expect(session.view).toMatchObject({ listening: false, statusKind: 'processing' });

    controllerClock.advance(STT_RESPONSE_LIMIT_MS);
    await stopping;
    expect(session.view.statusKind).toBeNull();
    expect(handled).toEqual([]);
  });

  it('reports every change to listeners, and a throwing listener does not break the session', async () => {
    const { session, views } = await ready();
    session.onChange(() => { throw new Error('listener bug'); });
    const before = views.length;

    await session.togglePushToTalk();

    expect(views.length).toBeGreaterThan(before);
    expect(session.view.listening).toBe(true);
  });

  it('lets voice speak up in the status only while the rest of the panel is idle', () => {
    const listening: VoiceSessionView = { voice: { state: 'available', reasonText: null }, listening: true, statusKind: 'listening' };
    const quiet: VoiceSessionView = { ...listening, listening: false, statusKind: null };

    expect(resolveStatusKind('idle', listening)).toBe('listening');
    expect(resolveStatusKind('confirmation_pending', listening)).toBe('confirmation_pending');
    expect(resolveStatusKind('error', listening)).toBe('error');
    expect(resolveStatusKind('processing', listening)).toBe('processing');
    expect(resolveStatusKind('idle', quiet)).toBe('idle');
  });
});

describe('VoiceSession push-to-talk toggle', () => {
  it('starts on one press and, on the next, routes the recognized text as a voice utterance', async () => {
    const { session, input, handled, transcript } = await ready();

    await session.togglePushToTalk();
    expect(input.startCalls).toBe(1);
    await session.togglePushToTalk();

    expect(input.stopCalls).toBe(1);
    expect(handled).toEqual([{ text: 'where am I', source: 'voice' }]);
    expect(systemTexts(transcript)).toEqual([]); // the pipeline records the user's query; no failure to state
  });

  it('never starts without a press', async () => {
    const { input, session } = await ready();
    await flush();
    expect(input.startCalls).toBe(0);
    expect(session.view.listening).toBe(false);
  });

  it('ignores a press while processing and a double start', async () => {
    const { session, input, transcriber, controllerClock } = await ready();
    transcriber.outcomes = ['hang'];
    await session.togglePushToTalk();
    const stopping = session.togglePushToTalk();
    await flush();

    await session.togglePushToTalk(); // processing: nothing happens
    expect(input.startCalls).toBe(1);
    expect(input.stopCalls).toBe(1);

    controllerClock.advance(STT_RESPONSE_LIMIT_MS);
    await stopping;
  });

  it('starts no capture when voice is unavailable, and says why again', async () => {
    const { session, input, transcript } = await ready({ caps: null });
    const before = systemTexts(transcript).length;

    await session.togglePushToTalk();

    expect(input.startCalls).toBe(0);
    expect(systemTexts(transcript).length).toBe(before + 1);
    expect(systemTexts(transcript).at(-1)).toContain('backend is not connected');
  });

  it('does nothing while the session is still starting', async () => {
    const { session, input, transcript } = build();
    session.begin();
    await session.togglePushToTalk();
    expect(input.startCalls).toBe(0);
    expect(systemTexts(transcript)).toEqual([]);
  });
});

describe('VoiceSession failures: route nothing, say so, keep push-to-talk enabled', () => {
  async function failWith(outcome: TranscriptionOutcome, setup?: (harness: Harness) => void): Promise<Harness> {
    const harness = await ready();
    harness.transcriber.outcomes = [outcome];
    setup?.(harness);
    await harness.session.togglePushToTalk();
    await harness.session.togglePushToTalk();
    return harness;
  }

  it.each<[TranscriptionOutcome, string]>([
    [{ ok: false, reason: 'no_speech' }, 'no speech was recognized'],
    [{ ok: false, reason: 'stt_unavailable' }, 'speech recognition is unavailable'],
    [{ ok: false, reason: 'mic_denied' }, 'microphone permission was denied'],
    [{ ok: false, reason: 'mic_unavailable' }, 'no microphone was found'],
    [{ ok: false, reason: 'backend_unavailable' }, 'backend is not connected'],
    [{ ok: true, text: '   ' }, 'no speech was recognized'],
  ])('states the reason for %j', async (outcome, expected) => {
    const harness = await failWith(outcome);
    const entries = systemTexts(harness.transcript);

    expect(harness.handled).toEqual([]); // nothing reached the pipeline
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('Voice input could not be processed');
    expect(entries[0]).toContain(expected);
    expect(entries[0]).toContain('You can type the same request.');
    expect(harness.session.view.voice.state).toBe('available'); // push-to-talk stays enabled
    expect(harness.transcript.getEntries().filter((entry) => entry.role === 'user')).toEqual([]);
  });

  it('states a timeout after the 10 s limit, routes nothing, and cancels the pending transcription', async () => {
    const { session, transcriber, controllerClock, handled, transcript } = await ready();
    transcriber.outcomes = ['hang'];
    await session.togglePushToTalk();
    const stopping = session.togglePushToTalk();
    await flush();

    controllerClock.advance(STT_RESPONSE_LIMIT_MS);
    await stopping;

    expect(handled).toEqual([]);
    expect(systemTexts(transcript)).toEqual([describeVoiceFailure('timeout')]);
    expect(transcriber.cancelCalls).toBeGreaterThan(0);
    expect(session.view.voice.state).toBe('available');
  });

  it('states a failed recording when the input cannot start or stop', async () => {
    const start = await ready();
    start.input.startFails = true;
    await start.session.togglePushToTalk();
    expect(systemTexts(start.transcript)).toEqual([describeVoiceFailure('capture_failed')]);

    const stop = await ready();
    stop.input.stopFails = true;
    await stop.session.togglePushToTalk();
    await stop.session.togglePushToTalk();
    expect(systemTexts(stop.transcript)).toEqual([describeVoiceFailure('capture_failed')]);
    expect(stop.handled).toEqual([]);
  });

  it('recovers: after a failure the next press records and routes normally', async () => {
    const harness = await failWith({ ok: false, reason: 'no_speech' });

    harness.transcriber.outcomes = [{ ok: true, text: 'next error' }];
    await harness.session.togglePushToTalk();
    await harness.session.togglePushToTalk();

    expect(harness.handled).toEqual([{ text: 'next error', source: 'voice' }]);
    expect(systemTexts(harness.transcript)).toHaveLength(1);
  });

  it('shows retry guidance, not a stale "ready", after a denied microphone', async () => {
    const harness = await failWith({ ok: false, reason: 'mic_denied' });
    expect(harness.session.view.voice.reasonText).toContain('Microphone access was denied earlier');
  });

  it('states the cap result too when the 60 s cap, not the user, ended the capture', async () => {
    const { session, controllerClock, transcriber, transcript, handled } = await ready();
    transcriber.outcomes = [{ ok: false, reason: 'no_speech' }];
    await session.togglePushToTalk();

    controllerClock.advance(MAX_VOICE_DURATION_MS);
    await flush();

    expect(handled).toEqual([]);
    expect(systemTexts(transcript)).toEqual([describeVoiceFailure('no_speech')]);
  });

  it('routes the text, with no failure entry, when the cap ends a capture that has speech', async () => {
    const { session, controllerClock, transcript, handled } = await ready();
    await session.togglePushToTalk();

    controllerClock.advance(MAX_VOICE_DURATION_MS);
    await flush();

    expect(handled).toEqual([{ text: 'where am I', source: 'voice' }]);
    expect(systemTexts(transcript)).toEqual([]);
  });
});

describe('VoiceSession initialization budget (Req 10.3)', () => {
  it('is "starting" until capabilities arrive, then ready, and stops its timer', async () => {
    const { session, sessionClock, caps } = build({ caps: null });
    session.begin();
    expect(session.view).toMatchObject({ voice: { state: 'initializing' }, listening: false });
    expect(sessionClock.pendingDelays).toEqual([VOICE_INIT_BUDGET_MS]);

    await session.initialize(); // backend still not connected: keep waiting
    expect(session.view.voice.state).toBe('initializing');

    caps.value = CAPS;
    await session.initialize();

    expect(session.view.voice.state).toBe('available');
    expect(sessionClock.pendingCount).toBe(0);
  });

  it('adds one "unavailable for the session" entry at 10 s, keeping push-to-talk focusable with text', async () => {
    const { session, sessionClock, transcript } = build({ caps: null });
    session.begin();

    sessionClock.advance(VOICE_INIT_BUDGET_MS - 1);
    expect(systemTexts(transcript)).toEqual([]);
    sessionClock.advance(1);

    const entries = systemTexts(transcript);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('unavailable for this session');
    expect(entries[0]).toContain('You can keep typing.');
    expect(session.view).toMatchObject({
      voice: { state: 'unavailable', reasonText: entries[0] },
      listening: false,
      statusKind: 'voice_unavailable',
    });
  });

  it('recovers when the backend connects after the budget ran out', async () => {
    const { session, sessionClock, caps } = build({ caps: null });
    session.begin();
    sessionClock.advance(VOICE_INIT_BUDGET_MS);

    caps.value = CAPS;
    await session.initialize();

    expect(session.view.voice.state).toBe('available');
    expect(session.view.statusKind).toBeNull();
  });

  it('states a missing backend or microphone once per cause, not on every re-check', async () => {
    const { session, transcript, caps } = build({ caps: { ...CAPS, mic: 'denied' } });

    await session.initialize();
    await session.initialize();
    expect(systemTexts(transcript)).toEqual([expect.stringContaining('microphone permission was denied')]);

    caps.value = null; // a different cause is news again
    await session.initialize();
    expect(systemTexts(transcript)).toHaveLength(2);
    expect(systemTexts(transcript)[1]).toContain('backend is not connected');
  });

  it('states missing speech recognition', async () => {
    const { session, transcript } = build({ caps: { ...CAPS, stt: false } });
    await session.initialize();
    expect(systemTexts(transcript)[0]).toContain('speech recognition is not set up');
  });

  it('does not record anything or open a microphone while starting', async () => {
    const { session, input, transcript } = build({ caps: null });
    session.begin();
    await session.initialize();
    expect(input.startCalls).toBe(0);
    expect(transcript.getEntries()).toEqual([]);
  });
});

describe('VoiceSession activation (Req 18)', () => {
  it('opens the panel and begins listening when the microphone is known to be granted', async () => {
    const { session, input } = await ready();
    let opened = 0;

    await session.activate(() => { opened += 1; });

    expect(opened).toBe(1);
    expect(input.startCalls).toBe(1);
    expect(session.view.listening).toBe(true);
  });

  it('opens the panel before voice does anything', async () => {
    const { session, input } = await ready();
    const order: string[] = [];
    const original = input.start.bind(input);
    input.start = async () => { order.push('start'); await original(); };

    await session.activate(() => order.push('panel'));

    expect(order).toEqual(['panel', 'start']);
  });

  it('does not begin listening a second time when already listening', async () => {
    const { session, input } = await ready();
    await session.activate(() => undefined);
    await session.activate(() => undefined);
    expect(input.startCalls).toBe(1);
  });

  it('only opens the panel, with typing intact, while the session is still starting', async () => {
    const { session, input, transcript } = build({ caps: null });
    session.begin();
    let opened = 0;

    await session.activate(() => { opened += 1; });

    expect(opened).toBe(1);
    expect(input.startCalls).toBe(0);
    expect(systemTexts(transcript)).toEqual([]);
  });

  it('records that voice is unavailable on each activation and still opens the panel', async () => {
    const { session, input, transcript } = await ready({ caps: null });
    const before = systemTexts(transcript).length;
    let opened = 0;

    await session.activate(() => { opened += 1; });
    await session.activate(() => { opened += 1; });

    expect(opened).toBe(2);
    expect(input.startCalls).toBe(0);
    const added = systemTexts(transcript).slice(before);
    expect(added).toHaveLength(2);
    for (const text of added) expect(text).toContain('You can keep typing.');
  });

  it('offers push-to-talk as the permission request when permission is undetermined, once', async () => {
    const harness = build({ kind: 'webview' });
    harness.input.availability = { ok: false, reason: 'undetermined' };
    await harness.session.initialize();

    await harness.session.activate(() => undefined);
    await harness.session.activate(() => undefined);

    expect(harness.input.startCalls).toBe(0); // nothing records until the user presses the control
    expect(systemTexts(harness.transcript)).toEqual([
      'Microphone permission has not been granted yet. Press push-to-talk to request it.',
    ]);
    expect(harness.session.view.voice.state).toBe('available'); // the control is operable

    await harness.session.togglePushToTalk(); // the keyboard-operable request
    expect(harness.input.startCalls).toBe(1);
  });

  it('begins listening after access is granted later, without a restart (Req 18.6)', async () => {
    const harness = build({ caps: { ...CAPS, mic: 'denied' } });
    await harness.session.initialize();
    expect(harness.session.view.voice.state).toBe('unavailable');
    expect(harness.input.startCalls).toBe(0);

    // The user allows access in system settings. The handshake snapshot still says "denied".
    await harness.session.activate(() => undefined);

    expect(harness.input.startCalls).toBe(1);
    expect(harness.session.view.listening).toBe(true);
    harness.transcriber.outcomes = [{ ok: true, text: 'next error' }];
    await harness.session.togglePushToTalk();
    expect(harness.handled).toEqual([{ text: 'next error', source: 'voice' }]);
  });

  it('says so, and does not fail, when access is still denied', async () => {
    const harness = build({ caps: { ...CAPS, mic: 'denied' } });
    await harness.session.initialize();
    harness.input.availability = { ok: false, reason: 'denied' };
    let opened = 0;

    await expect(harness.session.activate(() => { opened += 1; })).resolves.toBeUndefined();

    expect(opened).toBe(1);
    expect(harness.input.startCalls).toBe(0);
    expect(systemTexts(harness.transcript).at(-1)).toContain('microphone permission was denied');
    expect(systemTexts(harness.transcript).at(-1)).toContain('You can keep typing.');
  });

  it('completes successfully whatever the voice implementation, microphone, speech and backend state', async () => {
    const kinds: VoiceKind[] = ['webview', 'backend_local'];
    const microphones: VoiceAvailability[] = [
      { ok: true },
      { ok: false, reason: 'denied' },
      { ok: false, reason: 'undetermined' },
      { ok: false, reason: 'unavailable' },
      { ok: false, reason: 'unsupported' },
    ];
    const capabilities: Array<Capabilities | null> = [
      CAPS,
      { ...CAPS, stt: false },
      { ...CAPS, mic: 'denied' },
      { ...CAPS, mic: 'unavailable' },
      { ...CAPS, mic: 'not_applicable' },
      null,
    ];

    for (const kind of kinds) {
      for (const microphone of microphones) {
        for (const caps of capabilities) {
          const harness = build({ kind, caps });
          harness.input.availability = microphone;
          await harness.session.initialize();
          let opened = 0;

          await expect(harness.session.activate(() => { opened += 1; })).resolves.toBeUndefined();

          expect(opened).toBe(1);
          // Listening begins only when speech recognition exists.
          if (harness.input.startCalls > 0) expect(caps?.stt).toBe(true);
        }
      }
    }
  });

  it('never throws when the panel or the whole voice layer fails', async () => {
    const boom = (): never => { throw new Error('boom'); };
    const broken: VoiceControllerPort = {
      get status(): VoiceStatus { return boom(); },
      initialize: async () => boom(),
      startListening: async () => boom(),
      stopListening: async () => boom(),
      cancel: boom,
      onStatus: () => ({ dispose: () => undefined }),
      onCapReached: () => ({ dispose: () => undefined }),
    };
    const session = new VoiceSession({
      controller: broken,
      transcript: new TranscriptStore(),
      getCapabilities: () => CAPS,
      scheduler: new FakeScheduler(),
    });
    let opened = 0;

    await expect(session.activate(() => { opened += 1; boom(); })).resolves.toBeUndefined();
    await expect(session.togglePushToTalk()).resolves.toBeUndefined();
    expect(opened).toBe(1);
  });
});

describe('VoiceSession cancellation and early endings', () => {
  it('cancels listening and a pending transcription, routing nothing, and ignores a late result', async () => {
    const { session, transcriber, handled, controller } = await ready();
    transcriber.outcomes = ['hang'];
    await session.togglePushToTalk();
    const stopping = session.togglePushToTalk();
    await flush();

    session.cancel();
    await stopping;

    expect(handled).toEqual([]);
    expect(controller.status.phase).toBe('idle');
    expect(session.view.listening).toBe(false);
  });

  it('cancels a recording that has not been stopped', async () => {
    const { session, input, handled } = await ready();
    await session.togglePushToTalk();

    session.cancel();
    session.cancel();

    expect(input.cancelCalls).toBeGreaterThan(0);
    expect(handled).toEqual([]);
    expect(session.view.listening).toBe(false);
  });

  it('stops "Listening" at once when the microphone fails after the start, and states why', async () => {
    const { session, input, transcript, handled } = await ready();
    await session.togglePushToTalk();
    const failure: RecordingEnd = { ok: false, reason: 'mic_denied' };

    session.notifyRecordingEnded(failure);

    expect(input.cancelCalls).toBeGreaterThan(0);
    expect(session.view.listening).toBe(false);
    expect(systemTexts(transcript)).toEqual([describeVoiceFailure('mic_denied')]);
    expect(handled).toEqual([]);
  });

  it('leaves a successful early result to the controller, and ignores endings when not listening', async () => {
    const { session, transcript } = await ready();
    session.notifyRecordingEnded({ ok: false, reason: 'mic_denied' }); // not listening: ignored
    await session.togglePushToTalk();
    session.notifyRecordingEnded({ ok: true });

    expect(session.view.listening).toBe(true);
    expect(systemTexts(transcript)).toEqual([]);
  });
});

describe('VoiceSession disposal', () => {
  it('cancels a recording and stops reacting to the controller and to its own timers', async () => {
    const { session, controller, input, transcript, sessionClock, views } = build({ caps: null });
    session.begin();
    session.dispose();
    session.dispose();
    expect(sessionClock.pendingCount).toBe(0);

    await controller.initialize(null);
    sessionClock.advance(VOICE_INIT_BUDGET_MS);
    await session.togglePushToTalk();
    await session.activate(() => undefined);

    expect(transcript.getEntries()).toEqual([]);
    expect(input.startCalls).toBe(0);
    expect(views.at(-1)?.voice.state).toBe('initializing'); // nothing was emitted after dispose
  });

  it('releases a live recording on dispose', async () => {
    const { session, input } = await ready();
    await session.togglePushToTalk();

    session.dispose();

    expect(input.cancelCalls).toBeGreaterThan(0);
  });
});

describe('VoiceSession boundaries', () => {
  const source = readFileSync(resolve(__dirname, '../../src/voice/voiceSession.ts'), 'utf8');
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');

  it('never routes, validates or executes text, records audio, or logs', () => {
    expect(code).not.toMatch(/InputPipeline|\.handle\(|ActionGate|ActionExecutor|ActionValidator|validateAction|LocalIntentRouter/);
    expect(code).not.toMatch(/getUserMedia|MediaRecorder|navigator|sounddevice|acquireVsCodeApi|from 'vscode'/);
    expect(code).not.toMatch(/console\.|logger|token|apiKey|API_KEY|process\.env|(^|[^.\w])setTimeout\(/m);
  });

  it('uses the first-sample watchdog constant only through the controller', () => {
    expect(FIRST_SAMPLE_WATCHDOG_MS).toBe(5_000);
    expect(code).not.toContain('FIRST_SAMPLE_WATCHDOG_MS');
  });
});
