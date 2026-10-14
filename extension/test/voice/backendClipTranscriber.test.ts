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
import type { Capabilities, ErrorCode } from '../../src/protocol/messages';
import {
  BackendClipTranscriber,
  MAX_BUFFERED_RESULTS,
  routeTranscriptions,
} from '../../src/voice/backendClipTranscriber';
import { BackendLocalVoiceInput, type RecorderClient } from '../../src/voice/backendLocalVoiceInput';
import { VoiceController } from '../../src/voice/voiceController';
import {
  MAX_VOICE_DURATION_MS,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceInput,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

class FakeClient implements RecorderClient {
  public state: ConnectionState = 'connected';
  public capabilities: Capabilities | null = CAPS;
  public readonly sent: string[] = [];
  private readonly eventListeners = new Set<(event: BackendEvent) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  public get listenerCount(): number { return this.eventListeners.size + this.stateListeners.size; }

  public sendRecordStart(id: string): boolean { this.sent.push(`start:${id}`); return true; }
  public sendRecordStop(id: string): boolean { this.sent.push(`stop:${id}`); return true; }
  public cancelAudioClip(id: string): boolean { this.sent.push(`cancel:${id}`); return true; }

  public onEvent(listener: (event: BackendEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => void this.eventListeners.delete(listener) };
  }

  public onStateChange(listener: (state: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => void this.stateListeners.delete(listener) };
  }

  public result(replyTo: string, text: string): void {
    for (const listener of [...this.eventListeners]) listener({ version: 1, type: 'transcription_result', replyTo, text });
  }

  public error(replyTo: string | undefined, code: ErrorCode): void {
    for (const listener of [...this.eventListeners]) {
      listener({ version: 1, type: 'error_message', ...(replyTo === undefined ? {} : { replyTo }), code, message: 'RAW-DETAIL', recoverable: true });
    }
  }

  public setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }
}

describe('BackendClipTranscriber', () => {
  it('waits for the matching reply and returns its text', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);

    const pending = transcriber.transcribe({ backendClipId: 'voice-1' });
    client.result('voice-1', 'next error');

    await expect(pending).resolves.toEqual({ ok: true, text: 'next error' });
  });

  it('keeps a reply that arrives before transcribe() is called', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);

    client.result('voice-1', 'early');

    await expect(transcriber.transcribe({ backendClipId: 'voice-1' })).resolves.toEqual({ ok: true, text: 'early' });
  });

  it.each<[ErrorCode, string]>([
    ['STT_NO_SPEECH', 'no_speech'],
    ['STT_UNAVAILABLE', 'stt_unavailable'],
    ['CREDENTIAL_MISSING', 'stt_unavailable'],
    ['TIMEOUT', 'timeout'],
    ['MIC_DENIED', 'mic_denied'],
  ])('maps the backend error %s to %s without exposing backend text', async (code, reason) => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);
    const pending = transcriber.transcribe({ backendClipId: 'voice-2' });

    client.error('voice-2', code);

    const outcome = await pending;
    expect(outcome).toEqual({ ok: false, reason });
    expect(JSON.stringify(outcome)).not.toContain('RAW-DETAIL');
  });

  it('only the first reply for a clip counts, and replies for other ids never settle it', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);
    const outcomes: TranscriptionOutcome[] = [];
    void transcriber.transcribe({ backendClipId: 'voice-1' }).then((outcome) => outcomes.push(outcome));

    client.result('voice-9', 'someone else');
    client.error(undefined, 'MIC_DENIED');
    client.result('rec-1', 'a backend-local recording');
    await flush();
    expect(outcomes).toEqual([]);

    client.result('voice-1', 'first');
    client.result('voice-1', 'second');
    await flush();
    expect(outcomes).toEqual([{ ok: true, text: 'first' }]);
  });

  it('refuses audio bytes and ids that are not relayed webview clips', async () => {
    const transcriber = new BackendClipTranscriber(new FakeClient());

    await expect(transcriber.transcribe(new Uint8Array([1, 2, 3]))).resolves.toEqual({ ok: false, reason: 'stt_unavailable' });
    await expect(transcriber.transcribe({ backendClipId: 'rec-1' })).resolves.toEqual({ ok: false, reason: 'stt_unavailable' });
  });

  it('fails at once when the backend is not connected, and when it drops while waiting', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);

    const waiting = transcriber.transcribe({ backendClipId: 'voice-1' });
    client.setState('disconnected');
    await expect(waiting).resolves.toEqual({ ok: false, reason: 'backend_unavailable' });

    await expect(transcriber.transcribe({ backendClipId: 'voice-2' })).resolves.toEqual({ ok: false, reason: 'backend_unavailable' });
  });

  it('forgets a buffered reply when the connection is lost', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);
    client.result('voice-1', 'stale');
    client.setState('disconnected');
    client.setState('connected');

    const outcomes: TranscriptionOutcome[] = [];
    void transcriber.transcribe({ backendClipId: 'voice-1' }).then((outcome) => outcomes.push(outcome));
    await flush();

    expect(outcomes).toEqual([]);
  });

  it('settles a cancelled wait and ignores the reply that comes later', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);
    const pending = transcriber.transcribe({ backendClipId: 'voice-1' });

    transcriber.cancel();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    client.result('voice-1', 'too late');

    const outcomes: TranscriptionOutcome[] = [];
    void transcriber.transcribe({ backendClipId: 'voice-1' }).then((outcome) => outcomes.push(outcome));
    await flush();
    expect(outcomes).toEqual([]); // the stale reply was dropped, not kept for a later wait
  });

  it('keeps at most a few unclaimed replies', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);
    for (let index = 1; index <= MAX_BUFFERED_RESULTS + 5; index += 1) client.result(`voice-${index}`, `text ${index}`);

    await expect(transcriber.transcribe({ backendClipId: `voice-${MAX_BUFFERED_RESULTS + 5}` }))
      .resolves.toEqual({ ok: true, text: `text ${MAX_BUFFERED_RESULTS + 5}` });
    const outcomes: TranscriptionOutcome[] = [];
    void transcriber.transcribe({ backendClipId: 'voice-1' }).then((outcome) => outcomes.push(outcome));
    await flush();
    expect(outcomes).toEqual([]); // the oldest was evicted, so this one waits
  });

  it('removes its listeners and settles any wait on dispose', async () => {
    const client = new FakeClient();
    const transcriber = new BackendClipTranscriber(client);
    expect(client.listenerCount).toBe(2);
    const pending = transcriber.transcribe({ backendClipId: 'voice-1' });

    transcriber.dispose();
    transcriber.dispose();

    await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
    expect(client.listenerCount).toBe(0);
    await expect(transcriber.transcribe({ backendClipId: 'voice-1' })).resolves.toEqual({ ok: false, reason: 'stt_unavailable' });
  });

  it('has no routing, execution, logging or upload of its own', () => {
    const source = readFileSync(resolve(__dirname, '../../src/voice/backendClipTranscriber.ts'), 'utf8');
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/InputPipeline|\.handle\(|ActionGate|ActionExecutor|validateAction|console\.|logger|sendAudioClip|from 'vscode'/);
  });
});

describe('routeTranscriptions', () => {
  function fakeTranscriber(label: string, calls: string[]): VoiceTranscriber {
    return {
      transcribe: async () => { calls.push(`${label}:transcribe`); return { ok: true, text: label }; },
      cancel: () => { calls.push(`${label}:cancel`); },
    };
  }

  it('sends a clip the local input owns to that input, and any other clip to the clip transcriber', async () => {
    const calls: string[] = [];
    const local = { owns: (clip: unknown) => (clip as { backendClipId?: string }).backendClipId === 'rec-1', transcriber: fakeTranscriber('local', calls) };
    const routed = routeTranscriptions(local, fakeTranscriber('clips', calls));

    await expect(routed.transcribe({ backendClipId: 'rec-1' })).resolves.toEqual({ ok: true, text: 'local' });
    await expect(routed.transcribe({ backendClipId: 'voice-1' })).resolves.toEqual({ ok: true, text: 'clips' });
    routed.cancel?.();

    expect(calls).toEqual(['local:transcribe', 'clips:transcribe', 'local:cancel', 'clips:cancel']);
  });
});

describe('BackendLocalVoiceInput.owns', () => {
  it('is true only for the clip the current recording produced', async () => {
    const client = new FakeClient();
    const input = new BackendLocalVoiceInput({ client, scheduler: new FakeScheduler() });
    expect(input.owns({ backendClipId: 'rec-1' })).toBe(false);

    await input.start();
    const clip = await input.stop();

    expect(input.owns(clip)).toBe(true);
    expect(input.owns({ backendClipId: 'voice-1' })).toBe(false);
    expect(input.owns(new Uint8Array([1]))).toBe(false);

    const pending = input.transcriber.transcribe(clip);
    client.result('rec-1', 'done');
    await pending;
    expect(input.owns(clip)).toBe(false);
  });
});

describe('a relayed webview recording takes the same path as typed text (Req 9.2, 19.7)', () => {
  it('routes transcription_result text through the controller to the pipeline as a voice utterance', async () => {
    const factory = new FakeSocketFactory();
    const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities: CAPS });

    const webview: VoiceInput = {
      kind: 'webview',
      maxDurationMs: MAX_VOICE_DURATION_MS,
      available: async (): Promise<VoiceAvailability> => ({ ok: true }),
      start: async () => undefined,
      stop: async () => ({ backendClipId: 'voice-1' }),
      cancel: () => undefined,
    };
    const handled: Array<{ text: string; source: 'voice' }> = [];
    const transcriber = new BackendClipTranscriber(client);
    const controller = new VoiceController({
      inputs: { webview },
      transcriber,
      pipeline: { handle: async (text, source) => { handled.push({ text, source }); } },
      scheduler: new FakeScheduler(),
      preferred: 'webview',
    });
    await controller.initialize(CAPS);
    await controller.startListening();

    const outcome = controller.stopListening();
    await flush();
    factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'voice-1', text: 'what errors are there' });

    await expect(outcome).resolves.toEqual({ status: 'routed' });
    expect(handled).toEqual([{ text: 'what errors are there', source: 'voice' }]);
    transcriber.dispose();
  });
});
