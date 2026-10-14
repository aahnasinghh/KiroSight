import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BackendClient,
  DEFAULT_BACKEND_URL,
  type BackendEvent,
  type ConnectionState,
  type Disposable,
} from '../../src/backend/backendClient';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import type { Capabilities, ErrorCode } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import {
  BackendLocalVoiceInput,
  UNCLAIMED_RESULT_TTL_MS,
  transcriptionFailureFor,
  type RecorderClient,
  type RecordingEnd,
} from '../../src/voice/backendLocalVoiceInput';
import { STT_RESPONSE_LIMIT_MS, VoiceController, type VoiceOutcome } from '../../src/voice/voiceController';
import { MAX_VOICE_DURATION_MS, type TranscriptionOutcome } from '../../src/voice/voiceInput';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const CAPABILITIES: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

interface Sent {
  readonly type: 'record_start' | 'record_stop' | 'cancel';
  readonly id: string;
}

class FakeRecorderClient implements RecorderClient {
  public state: ConnectionState = 'connected';
  public capabilities: Capabilities | null = CAPABILITIES;
  public readonly sent: Sent[] = [];
  /** When false, every send reports that nothing could be sent. */
  public sendOk = true;
  private readonly eventListeners = new Set<(event: BackendEvent) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  public get listenerCount(): number {
    return this.eventListeners.size + this.stateListeners.size;
  }

  public sendRecordStart(id: string): boolean { return this.push('record_start', id); }
  public sendRecordStop(id: string): boolean { return this.push('record_stop', id); }
  public cancelAudioClip(id: string): boolean { return this.push('cancel', id); }

  public onEvent(listener: (event: BackendEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => void this.eventListeners.delete(listener) };
  }

  public onStateChange(listener: (state: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => void this.stateListeners.delete(listener) };
  }

  public result(replyTo: string, text: string): void {
    this.emit({ version: 1, type: 'transcription_result', replyTo, text });
  }

  public error(replyTo: string | undefined, code: ErrorCode): void {
    this.emit({
      version: 1, type: 'error_message', ...(replyTo === undefined ? {} : { replyTo }),
      code, message: 'RAW-BACKEND-DETAIL', recoverable: true,
    });
  }

  public setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }

  private emit(event: BackendEvent): void {
    for (const listener of [...this.eventListeners]) listener(event);
  }

  private push(type: Sent['type'], id: string): boolean {
    if (!this.sendOk || this.state !== 'connected') return false;
    this.sent.push({ type, id });
    return true;
  }
}

function build() {
  const client = new FakeRecorderClient();
  const scheduler = new FakeScheduler();
  const input = new BackendLocalVoiceInput({ client, scheduler });
  return { client, scheduler, input };
}

async function record(input: BackendLocalVoiceInput): Promise<{ backendClipId: string }> {
  await input.start();
  return await input.stop() as { backendClipId: string };
}

describe('BackendLocalVoiceInput basics', () => {
  it('implements the VoiceInput contract and does nothing on construction', () => {
    const { client, input } = build();
    expect(input.kind).toBe('backend_local');
    expect(input.maxDurationMs).toBe(MAX_VOICE_DURATION_MS);
    expect(input.maxDurationMs).toBe(60_000);
    expect(client.sent).toEqual([]);
    expect(client.listenerCount).toBe(0);
  });

  it('reports availability from the connection and snapshot without recording', async () => {
    const { client, input } = build();
    expect(await input.available()).toEqual({ ok: true });

    // A stale denied/unavailable snapshot is not final: the backend re-checks on every start.
    client.capabilities = { ...CAPABILITIES, mic: 'denied' };
    expect(await input.available()).toEqual({ ok: true });
    client.capabilities = { ...CAPABILITIES, mic: 'unavailable' };
    expect(await input.available()).toEqual({ ok: true });

    client.capabilities = { ...CAPABILITIES, mic: 'not_applicable' };
    expect(await input.available()).toEqual({ ok: false, reason: 'unsupported' });

    client.capabilities = null;
    expect(await input.available()).toEqual({ ok: false, reason: 'unavailable' });

    client.capabilities = CAPABILITIES;
    client.state = 'disconnected';
    expect(await input.available()).toEqual({ ok: false, reason: 'unavailable' });

    expect(client.sent).toEqual([]);
    expect(client.listenerCount).toBe(0);
  });

  it('sends exactly one record_start on start() and rejects a second start without sending', async () => {
    const { client, input } = build();
    await input.start();
    await expect(input.start()).rejects.toThrow();

    expect(client.sent).toEqual([{ type: 'record_start', id: 'rec-1' }]);
  });

  it('rejects start() and leaves no listener behind when the backend is not connected', async () => {
    const { client, input } = build();
    client.state = 'disconnected';
    await expect(input.start()).rejects.toThrow();
    expect(client.sent).toEqual([]);
    expect(client.listenerCount).toBe(0);
  });

  it('rejects start() and cleans up when the frame cannot be sent', async () => {
    const { client, input } = build();
    client.sendOk = false;
    await expect(input.start()).rejects.toThrow();
    expect(client.listenerCount).toBe(0);

    client.sendOk = true;
    await input.start();
    expect(client.sent).toEqual([{ type: 'record_start', id: 'rec-2' }]);
  });

  it('sends one record_stop and resolves to the backend clip id; repeated stop is rejected', async () => {
    const { client, input } = build();
    await input.start();

    await expect(input.stop()).resolves.toEqual({ backendClipId: 'rec-1' });
    await expect(input.stop()).rejects.toThrow();

    expect(client.sent).toEqual([
      { type: 'record_start', id: 'rec-1' },
      { type: 'record_stop', id: 'rec-1' },
    ]);
  });

  it('rejects stop() with no recording and sends nothing', async () => {
    const { client, input } = build();
    await expect(input.stop()).rejects.toThrow();
    expect(client.sent).toEqual([]);
  });
});

describe('BackendLocalVoiceInput transcription', () => {
  it('returns the recognized text for the stopped recording and cleans up', async () => {
    const { client, input } = build();
    const clip = await record(input);

    const pending = input.transcriber.transcribe(clip);
    client.result('rec-1', 'where am I');

    await expect(pending).resolves.toEqual({ ok: true, text: 'where am I' });
    expect(client.listenerCount).toBe(0);
  });

  it('passes an empty transcription through unchanged', async () => {
    const { client, input } = build();
    const clip = await record(input);
    const pending = input.transcriber.transcribe(clip);
    client.result('rec-1', '');
    await expect(pending).resolves.toEqual({ ok: true, text: '' });
  });

  it.each<[ErrorCode, string]>([
    ['MIC_DENIED', 'mic_denied'],
    ['MIC_UNAVAILABLE', 'mic_unavailable'],
    ['STT_NO_SPEECH', 'no_speech'],
    ['STT_UNAVAILABLE', 'stt_unavailable'],
    ['CREDENTIAL_MISSING', 'stt_unavailable'],
    ['TIMEOUT', 'timeout'],
    ['VALIDATION_FAILED', 'stt_unavailable'],
    ['INTERNAL', 'stt_unavailable'],
  ])('maps the backend error %s to %s without exposing backend text', async (code, reason) => {
    expect(transcriptionFailureFor(code)).toBe(reason);

    const { client, input } = build();
    const clip = await record(input);
    const pending = input.transcriber.transcribe(clip);
    client.error('rec-1', code);

    const outcome = await pending;
    expect(outcome).toEqual({ ok: false, reason });
    expect(JSON.stringify(outcome)).not.toContain('RAW-BACKEND-DETAIL');
    expect(client.listenerCount).toBe(0);
  });

  it('keeps a reply that arrives before transcribe() is called', async () => {
    const { client, input } = build();
    const clip = await record(input);
    client.result('rec-1', 'early words');

    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: true, text: 'early words' });
    expect(client.listenerCount).toBe(0);
  });

  it('suppresses duplicate replies: only the first terminal reply counts', async () => {
    const { client, input } = build();
    const clip = await record(input);
    client.result('rec-1', 'first');
    client.result('rec-1', 'second');
    client.error('rec-1', 'MIC_DENIED');

    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: true, text: 'first' });
  });

  it('ignores replies for another recording id and replies without an id', async () => {
    const { client, input } = build();
    const clip = await record(input);
    const outcomes: TranscriptionOutcome[] = [];
    void input.transcriber.transcribe(clip).then((outcome) => outcomes.push(outcome));

    client.result('rec-99', 'someone else');
    client.error('rec-99', 'MIC_DENIED');
    client.error(undefined, 'MIC_DENIED');
    await flush();
    expect(outcomes).toEqual([]);

    client.result('rec-1', 'mine');
    await flush();
    expect(outcomes).toEqual([{ ok: true, text: 'mine' }]);
  });

  it('refuses a clip it did not record, an audio buffer, and a second claim', async () => {
    const { client, input } = build();
    const clip = await record(input);

    await expect(input.transcriber.transcribe({ backendClipId: 'voice-1' })).resolves.toEqual({ ok: false, reason: 'stt_unavailable' });
    await expect(input.transcriber.transcribe(new Uint8Array([1, 2, 3]))).resolves.toEqual({ ok: false, reason: 'stt_unavailable' });

    const first = input.transcriber.transcribe(clip);
    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: false, reason: 'stt_unavailable' });
    client.result('rec-1', 'ok');
    await expect(first).resolves.toEqual({ ok: true, text: 'ok' });
  });
});

describe('BackendLocalVoiceInput early endings', () => {
  it('reports a start failure while still recording, sends no record_stop, and returns the reason', async () => {
    const { client, input } = build();
    const ends: RecordingEnd[] = [];
    input.onRecordingEnded((end) => ends.push(end));
    await input.start();

    client.error('rec-1', 'MIC_DENIED');
    expect(ends).toEqual([{ ok: false, reason: 'mic_denied' }]);

    const clip = await input.stop();
    expect(client.sent.map((frame) => frame.type)).toEqual(['record_start']);
    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: false, reason: 'mic_denied' });
    expect(client.listenerCount).toBe(0);
  });

  it('keeps the backend 60 s cap result that arrives before stop()', async () => {
    const { client, input } = build();
    const ends: RecordingEnd[] = [];
    input.onRecordingEnded((end) => ends.push(end));
    await input.start();

    client.result('rec-1', 'long dictation');
    expect(ends).toEqual([{ ok: true }]);
    expect(JSON.stringify(ends)).not.toContain('long dictation');

    const clip = await input.stop();
    expect(client.sent.map((frame) => frame.type)).toEqual(['record_start']);
    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: true, text: 'long dictation' });
  });

  it('fails with backend_unavailable when the connection drops while recording', async () => {
    const { client, input } = build();
    const ends: RecordingEnd[] = [];
    input.onRecordingEnded((end) => ends.push(end));
    await input.start();

    client.setState('disconnected');
    expect(ends).toEqual([{ ok: false, reason: 'backend_unavailable' }]);

    const clip = await input.stop();
    expect(client.sent.map((frame) => frame.type)).toEqual(['record_start']);
    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: false, reason: 'backend_unavailable' });
  });

  it('fails with backend_unavailable when the connection drops while waiting for the text', async () => {
    const { client, input } = build();
    const clip = await record(input);
    const pending = input.transcriber.transcribe(clip);

    client.setState('disconnected');

    await expect(pending).resolves.toEqual({ ok: false, reason: 'backend_unavailable' });
    expect(client.listenerCount).toBe(0);
  });

  it('fails with backend_unavailable when record_stop cannot be sent', async () => {
    const { client, input } = build();
    await input.start();
    client.sendOk = false;

    const clip = await input.stop();
    await expect(input.transcriber.transcribe(clip)).resolves.toEqual({ ok: false, reason: 'backend_unavailable' });
  });

  it('does not let a throwing end listener break the input, and unsubscribing works', async () => {
    const { client, input } = build();
    const ends: RecordingEnd[] = [];
    input.onRecordingEnded(() => { throw new Error('listener bug'); });
    const subscription = input.onRecordingEnded((end) => ends.push(end));
    await input.start();
    client.error('rec-1', 'MIC_UNAVAILABLE');
    expect(ends).toHaveLength(1);

    subscription.dispose();
    input.cancel();
    await input.start();
    client.error('rec-2', 'MIC_UNAVAILABLE');
    expect(ends).toHaveLength(1);
  });
});

describe('BackendLocalVoiceInput cancellation and cleanup', () => {
  it('cancels a live recording once, ignores later replies, and removes its listeners', async () => {
    const { client, input } = build();
    await input.start();

    input.cancel();
    input.cancel();
    client.result('rec-1', 'too late');

    expect(client.sent).toEqual([
      { type: 'record_start', id: 'rec-1' },
      { type: 'cancel', id: 'rec-1' },
    ]);
    expect(client.listenerCount).toBe(0);
    await expect(input.stop()).rejects.toThrow();
  });

  it('abandons a pending transcription on cancel and ignores the late result', async () => {
    const { client, input } = build();
    const clip = await record(input);
    const pending = input.transcriber.transcribe(clip);

    input.transcriber.cancel?.();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    client.result('rec-1', 'stale words');

    expect(client.sent.map((frame) => frame.type)).toEqual(['record_start', 'record_stop', 'cancel']);
    expect(client.listenerCount).toBe(0);
  });

  it('never applies a late result of a cancelled recording to the next recording', async () => {
    const { client, input } = build();
    await input.start();
    input.cancel();

    const clip = await record(input);
    expect(clip).toEqual({ backendClipId: 'rec-2' });
    const outcomes: TranscriptionOutcome[] = [];
    void input.transcriber.transcribe(clip).then((outcome) => outcomes.push(outcome));

    client.result('rec-1', 'stale');
    await flush();
    expect(outcomes).toEqual([]);

    client.result('rec-2', 'fresh');
    await flush();
    expect(outcomes).toEqual([{ ok: true, text: 'fresh' }]);
  });

  it('drops a finished recording nobody asked for after the unclaimed TTL', async () => {
    const { client, scheduler, input } = build();
    await record(input);
    expect(scheduler.pendingDelays).toEqual([UNCLAIMED_RESULT_TTL_MS]);

    scheduler.advance(UNCLAIMED_RESULT_TTL_MS);

    expect(client.listenerCount).toBe(0);
    expect(client.sent.at(-1)).toEqual({ type: 'cancel', id: 'rec-1' });
    expect(scheduler.pendingCount).toBe(0);
    await input.start();
    expect(client.sent.at(-1)).toEqual({ type: 'record_start', id: 'rec-2' });
  });

  it('clears the TTL timer once the controller claims the recording', async () => {
    const { client, scheduler, input } = build();
    const clip = await record(input);
    const pending = input.transcriber.transcribe(clip);
    expect(scheduler.pendingCount).toBe(0);
    client.result('rec-1', 'x');
    await pending;
  });

  it('recovers after a failed recording: the next start uses a new id', async () => {
    const { client, input } = build();
    const clip = await record(input);
    const failed = input.transcriber.transcribe(clip);
    client.error('rec-1', 'MIC_UNAVAILABLE');
    await expect(failed).resolves.toEqual({ ok: false, reason: 'mic_unavailable' });

    const next = await record(input);
    expect(next).toEqual({ backendClipId: 'rec-2' });
    const pending = input.transcriber.transcribe(next);
    client.result('rec-2', 'working again');
    await expect(pending).resolves.toEqual({ ok: true, text: 'working again' });
  });

  it('dispose cancels an active recording, removes listeners and refuses further use', async () => {
    const { client, scheduler, input } = build();
    await input.start();

    input.dispose();
    input.dispose();

    expect(client.sent.at(-1)).toEqual({ type: 'cancel', id: 'rec-1' });
    expect(client.listenerCount).toBe(0);
    expect(scheduler.pendingCount).toBe(0);
    await expect(input.start()).rejects.toThrow();
    expect(await input.available()).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('BackendLocalVoiceInput with the real BackendClient', () => {
  function connectedClient() {
    const factory = new FakeSocketFactory();
    const client = new BackendClient({
      url: DEFAULT_BACKEND_URL,
      socketFactory: factory.create,
      scheduler: new FakeScheduler(),
    });
    expect(client.connect().ok).toBe(true);
    factory.last.triggerOpen();
    factory.last.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities: CAPABILITIES });
    return { client, socket: factory.last };
  }

  it('sends valid record_start and record_stop frames and receives the transcription', async () => {
    const { client, socket } = connectedClient();
    const input = new BackendLocalVoiceInput({ client, scheduler: new FakeScheduler() });

    const clip = await record(input);
    const pending = input.transcriber.transcribe(clip);
    socket.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'next error' });

    const frames = socket.sentMessages;
    expect(frames.map((frame) => frame.type)).toEqual(['hello', 'record_start', 'record_stop']);
    for (const frame of frames) expect(validateProtocolMessage(frame).ok).toBe(true);
    expect(frames[1]).toEqual({ version: 1, type: 'record_start', id: 'rec-1' });
    expect(frames[2]).toEqual({ version: 1, type: 'record_stop', id: 'rec-1' });
    await expect(pending).resolves.toEqual({ ok: true, text: 'next error' });
  });

  it('sends nothing when the backend is not connected', () => {
    const factory = new FakeSocketFactory();
    const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });

    expect(client.sendRecordStart('rec-1')).toBe(false);
    expect(client.sendRecordStop('rec-1')).toBe(false);
    expect(factory.sockets).toEqual([]);
  });

  it('sends cancel with the recording id as the target when cancelled', async () => {
    const { client, socket } = connectedClient();
    const input = new BackendLocalVoiceInput({ client, scheduler: new FakeScheduler() });
    await input.start();

    input.cancel();

    expect(socket.sentMessages.at(-1)).toEqual({ version: 1, type: 'cancel', targetId: 'rec-1' });
    expect(validateProtocolMessage(socket.sentMessages.at(-1)).ok).toBe(true);
  });
});

describe('BackendLocalVoiceInput behind VoiceController', () => {
  function wired() {
    const { client, scheduler: inputScheduler, input } = build();
    const controllerScheduler = new FakeScheduler();
    const handled: Array<{ text: string; source: 'voice' }> = [];
    const controller = new VoiceController({
      inputs: { backend_local: input },
      transcriber: input.transcriber,
      pipeline: { handle: async (text, source) => { handled.push({ text, source }); } },
      scheduler: controllerScheduler,
    });
    return { client, input, inputScheduler, controllerScheduler, controller, handled };
  }

  async function ready() {
    const harness = wired();
    const status = await harness.controller.initialize(CAPABILITIES);
    expect(status.kind).toBe('backend_local');
    expect(status.phase).toBe('idle');
    return harness;
  }

  /** Presses push-to-talk, then pressing it again, with `reply` delivered while the text is awaited. */
  async function speak(harness: Awaited<ReturnType<typeof ready>>, reply: () => void): Promise<VoiceOutcome> {
    await expect(harness.controller.startListening()).resolves.toEqual({ status: 'listening' });
    const outcome = harness.controller.stopListening();
    await flush();
    reply();
    return await outcome;
  }

  it('routes recognized speech to the pipeline as a voice utterance', async () => {
    const harness = await ready();

    const outcome = await speak(harness, () => harness.client.result('rec-1', '  where am I  '));

    expect(outcome).toEqual({ status: 'routed' });
    expect(harness.handled).toEqual([{ text: 'where am I', source: 'voice' }]);
    expect(harness.client.listenerCount).toBe(0);
    expect(harness.client.sent.map((frame) => frame.type)).toEqual(['record_start', 'record_stop']);
  });

  it('starts recording only on an explicit startListening()', async () => {
    const harness = await ready();
    expect(harness.client.sent).toEqual([]);
    await harness.controller.startListening();
    expect(harness.client.sent).toEqual([{ type: 'record_start', id: 'rec-1' }]);
  });

  it('routes nothing for an empty transcription', async () => {
    const harness = await ready();
    const outcome = await speak(harness, () => harness.client.result('rec-1', '   '));
    expect(outcome).toEqual({ status: 'failed', reason: 'empty' });
    expect(harness.handled).toEqual([]);
  });

  it.each<[ErrorCode, string]>([
    ['MIC_DENIED', 'mic_denied'],
    ['MIC_UNAVAILABLE', 'mic_unavailable'],
    ['CREDENTIAL_MISSING', 'stt_unavailable'],
    ['STT_UNAVAILABLE', 'stt_unavailable'],
    ['STT_NO_SPEECH', 'no_speech'],
  ])('routes nothing and states the reason for %s, then recovers', async (code, reason) => {
    const harness = await ready();

    const failed = await speak(harness, () => harness.client.error('rec-1', code));
    expect(failed).toEqual({ status: 'failed', reason });
    expect(harness.handled).toEqual([]);
    expect(harness.controller.status.phase).toBe('idle');

    const recovered = await speak(harness, () => harness.client.result('rec-2', 'next error'));
    expect(recovered).toEqual({ status: 'routed' });
    expect(harness.handled).toEqual([{ text: 'next error', source: 'voice' }]);
  });

  it('times out after 10 s, routes nothing, cancels the recording, and ignores the late result', async () => {
    const harness = await ready();
    await harness.controller.startListening();
    const pending = harness.controller.stopListening();
    await flush();

    harness.controllerScheduler.advance(STT_RESPONSE_LIMIT_MS);
    await expect(pending).resolves.toEqual({ status: 'failed', reason: 'timeout' });
    harness.client.result('rec-1', 'much too late');
    await flush();

    expect(harness.handled).toEqual([]);
    expect(harness.client.sent.at(-1)).toEqual({ type: 'cancel', id: 'rec-1' });
    expect(harness.client.listenerCount).toBe(0);
  });

  it('routes nothing and closes the microphone when listening is cancelled', async () => {
    const harness = await ready();
    await harness.controller.startListening();

    harness.controller.cancel();
    harness.client.result('rec-1', 'ignored');
    await flush();

    expect(harness.handled).toEqual([]);
    expect(harness.client.sent.at(-1)).toEqual({ type: 'cancel', id: 'rec-1' });
    expect(harness.client.listenerCount).toBe(0);
  });

  it('never applies a late result from a cancelled recording to the next one', async () => {
    const harness = await ready();
    await harness.controller.startListening();
    harness.controller.cancel();

    const outcome = await speak(harness, () => {
      harness.client.result('rec-1', 'stale words');
      harness.client.result('rec-2', 'fresh words');
    });

    expect(outcome).toEqual({ status: 'routed' });
    expect(harness.handled).toEqual([{ text: 'fresh words', source: 'voice' }]);
  });

  it('reports backend_unavailable when the connection drops while listening', async () => {
    const harness = await ready();
    await harness.controller.startListening();
    harness.client.setState('disconnected');

    const outcome = await harness.controller.stopListening();

    expect(outcome).toEqual({ status: 'failed', reason: 'backend_unavailable' });
    expect(harness.handled).toEqual([]);
  });

  it('stops at the 60 s cap and routes the text', async () => {
    const harness = await ready();
    const capOutcomes: VoiceOutcome[] = [];
    harness.controller.onCapReached((outcome) => capOutcomes.push(outcome));
    await harness.controller.startListening();

    harness.controllerScheduler.advance(MAX_VOICE_DURATION_MS);
    await flush();
    expect(harness.client.sent.map((frame) => frame.type)).toEqual(['record_start', 'record_stop']);
    harness.client.result('rec-1', 'run my tests');
    await flush();

    expect(capOutcomes).toEqual([{ status: 'routed' }]);
    expect(harness.handled).toEqual([{ text: 'run my tests', source: 'voice' }]);
  });

  it('does not allow a second push-to-talk while one is in progress', async () => {
    const harness = await ready();
    await harness.controller.startListening();
    await expect(harness.controller.startListening()).resolves.toEqual({ status: 'busy' });
    expect(harness.client.sent).toEqual([{ type: 'record_start', id: 'rec-1' }]);
  });

  it('stays unavailable, sends nothing and leaves typed input untouched without a usable microphone', async () => {
    const { client, input } = build();
    const typedLocal: string[] = [];
    const transcript = new TranscriptStore();
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async (intent) => { typedLocal.push(intent.kind); return 'ok'; } },
    });
    const controller = new VoiceController({
      inputs: { backend_local: input },
      transcriber: input.transcriber,
      pipeline,
      scheduler: new FakeScheduler(),
    });

    const status = await controller.initialize({ ...CAPABILITIES, mic: 'not_applicable' });
    expect(status.phase).toBe('unavailable');
    await expect(controller.startListening()).resolves.toEqual({ status: 'failed', reason: 'not_available' });
    expect(client.sent).toEqual([]);

    await expect(pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    expect(typedLocal).toEqual(['WHERE_AM_I']);
  });

  it('sends spoken text through the same InputPipeline path as typed text', async () => {
    const { client, input } = build();
    const local: string[] = [];
    const transcript = new TranscriptStore();
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async (intent) => { local.push(intent.kind); return 'ok'; } },
    });
    const controller = new VoiceController({
      inputs: { backend_local: input },
      transcriber: input.transcriber,
      pipeline,
      scheduler: new FakeScheduler(),
    });
    await controller.initialize(CAPABILITIES);

    await controller.startListening();
    const outcome = controller.stopListening();
    await flush();
    client.result('rec-1', 'where am I');
    await expect(outcome).resolves.toEqual({ status: 'routed' });
    await pipeline.handle('where am I', 'typed');

    expect(local).toEqual(['WHERE_AM_I', 'WHERE_AM_I']);
    expect(transcript.getEntries().filter((entry) => entry.role === 'user').map((entry) => entry.source))
      .toEqual(['voice', 'typed']);
  });

  it('removes every listener and timer on dispose', async () => {
    const harness = await ready();
    await harness.controller.startListening();

    harness.controller.dispose();
    harness.input.dispose();

    expect(harness.client.listenerCount).toBe(0);
    expect(harness.inputScheduler.pendingCount).toBe(0);
    expect(harness.controllerScheduler.pendingCount).toBe(0);
  });
});

describe('BackendLocalVoiceInput boundaries', () => {
  const source = readFileSync(resolve(__dirname, '../../src/voice/backendLocalVoiceInput.ts'), 'utf8');
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');

  it('has no microphone capture, webview, vscode, logging or credential handling of its own', () => {
    expect(code).not.toMatch(/getUserMedia|MediaRecorder|navigator|sounddevice|AudioContext/);
    expect(code).not.toMatch(/acquireVsCodeApi|from 'vscode'|webview/i);
    expect(code).not.toMatch(/console\.|logger|token|apiKey|API_KEY|SecretStorage|process\.env/i);
    expect(code).not.toMatch(/(^|[^.\w])setTimeout\(|setInterval/m);
  });

  it('never calls the pipeline, the router or the action layer', () => {
    expect(code).not.toMatch(/InputPipeline|handle\(|ActionGate|ActionExecutor|ActionValidator|validateAction/);
  });
});
