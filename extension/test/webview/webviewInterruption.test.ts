import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackendEvent, ConnectionState, Disposable } from '../../src/backend/backendClient';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import { validateHostToWebviewMessage } from '../../src/protocol/bridgeMessages';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { SpeechController, type SpeechClient } from '../../src/voice/speechController';
import { createViewModel } from '../../src/webview/viewModel';
import { WebviewProvider } from '../../src/webview/webviewProvider';
import { Uri, resetVscodeMock, vscodeMockState } from '../mocks/vscode';
import { FakeScheduler } from '../mocks/fakeScheduler';

/**
 * Task 9.5 end to end on fakes: the real panel provider, the real pipeline and the real
 * SpeechController, with a fake backend client and the mock VS Code webview. Escape, a typed
 * utterance and the stop seam all end in one validated `stop_audio` when something was handed to
 * the panel, and in no message at all when nothing was.
 */
const TTS_ON: Capabilities = { bedrock: true, stt: true, tts: true, mic: 'available' };

class FakeClient implements SpeechClient {
  public state: ConnectionState = 'connected';
  public capabilities: Capabilities | null = TTS_ON;
  public readonly sent: string[] = [];
  public readonly cancelled: string[] = [];
  private readonly listeners = new Set<(event: BackendEvent) => void>();

  public sendSpeechRequest(request: { readonly id: string; readonly text: string }): boolean {
    this.sent.push(request.id);
    return true;
  }

  public cancelSpeechRequest(id: string): boolean {
    this.cancelled.push(id);
    return true;
  }

  public onEvent(listener: (event: BackendEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  }

  public onStateChange(): Disposable {
    return { dispose: () => undefined };
  }

  public audio(replyTo: string): void {
    for (const listener of [...this.listeners]) {
      listener({ version: 1, type: 'speech_audio', replyTo, mimeType: 'audio/mpeg', base64: 'U0VDUkVU' });
    }
  }
}

function setup() {
  resetVscodeMock();
  const transcript = new TranscriptStore();
  const client = new FakeClient();
  const scheduler = new FakeScheduler();
  const voiceInterrupts = { count: 0 };
  const handled: string[] = [];
  // The provider needs the pipeline and the speech controller needs the provider: close the loop lazily.
  const ref: { speech?: SpeechController; provider?: WebviewProvider } = {};

  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async (intent) => { handled.push(intent.kind); return 'You are in auth.ts.'; } },
    interruption: { stopSpeaking: () => ref.speech?.stopSpeaking() },
  });
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline,
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
    voice: {
      onMicState: () => undefined,
      onAudioClip: () => undefined,
      onInterrupt: () => { voiceInterrupts.count += 1; },
    },
  });
  const speech = new SpeechController({
    client,
    panel: provider,
    transcript,
    isSpeechActive: () => true,
    getPendingConfirmation: () => null,
    scheduler,
  });
  ref.speech = speech;
  ref.provider = provider;

  provider.openOrFocus();
  const panel = vscodeMockState.webviewPanels[0]!;
  const types = () => (panel.webview.posted as Array<{ type: string }>).map((m) => m.type);
  const respond = (text: string) => speech.speakResponse(transcript.append('kirosight', text));
  return { transcript, client, scheduler, voiceInterrupts, handled, pipeline, provider, speech, panel, types, respond };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('WebviewProvider.sendStopAudio', () => {
  it('posts exactly one valid stop_audio message', () => {
    const h = setup();
    h.panel.webview.posted.length = 0;

    expect(h.provider.sendStopAudio()).toBe(true);

    expect(h.panel.webview.posted).toEqual([{ type: 'stop_audio' }]);
    expect(validateHostToWebviewMessage(h.panel.webview.posted[0]).ok).toBe(true);
  });

  it('returns false and sends nothing when no panel is open, including after it closes', () => {
    const h = setup();
    h.panel.dispose();

    expect(h.provider.sendStopAudio()).toBe(false);
    expect(h.speech.stopSpeaking()).toBe(false);
  });

  it('survives a post that rejects or throws', async () => {
    const h = setup();
    const webview = h.panel.webview as unknown as { postMessage: () => unknown };

    webview.postMessage = () => Promise.reject(new Error('webview gone'));
    expect(h.provider.sendStopAudio()).toBe(true);
    await new Promise<void>((done) => setImmediate(done));

    webview.postMessage = () => { throw new Error('disposed'); };
    expect(h.provider.sendStopAudio()).toBe(false);
  });

  it('a webview cannot send stop_audio to the host: that message type is host to webview only', async () => {
    const h = setup();
    h.panel.webview.posted.length = 0;

    await h.panel.receive({ type: 'stop_audio' });

    expect(h.panel.webview.posted).toEqual([]);
  });
});

describe('Escape reaches speech through the existing interrupt message', () => {
  it('during playback: one stop_audio after the play_audio, the voice hook still runs, Transcript untouched', async () => {
    const h = setup();
    h.respond('There are two errors in auth.ts.');
    h.client.audio('speech-1');
    const entries = JSON.stringify(h.transcript.getEntries());
    expect(h.types().filter((t) => t === 'play_audio')).toHaveLength(1);

    await h.panel.receive({ type: 'interrupt' });
    await h.panel.receive({ type: 'interrupt' }); // a held key repeats

    expect(h.types().filter((t) => t === 'stop_audio')).toHaveLength(1);
    expect(h.types().lastIndexOf('stop_audio')).toBeGreaterThan(h.types().indexOf('play_audio'));
    expect(h.voiceInterrupts.count).toBe(2);
    expect(JSON.stringify(h.transcript.getEntries())).toBe(entries);
  });

  it('during synthesis: the speech request is cancelled and no stop_audio is sent', async () => {
    const h = setup();
    h.respond('There are two errors in auth.ts.');

    await h.panel.receive({ type: 'interrupt' });
    h.client.audio('speech-1'); // late

    expect(h.client.cancelled).toEqual(['speech-1']);
    expect(h.types()).not.toContain('stop_audio');
    expect(h.types()).not.toContain('play_audio');
  });

  it('with nothing speaking: nothing is sent to the panel and nothing is cancelled', async () => {
    const h = setup();
    const before = h.types().length;

    await h.panel.receive({ type: 'interrupt' });

    expect(h.types().slice(before).filter((t) => t === 'stop_audio' || t === 'play_audio')).toEqual([]);
    expect(h.client.cancelled).toEqual([]);
    expect(h.voiceInterrupts.count).toBe(1);
  });

  it('never moves focus: no focus_input message is sent', async () => {
    const h = setup();
    h.respond('answer');
    h.client.audio('speech-1');

    await h.panel.receive({ type: 'interrupt' });

    expect(h.types()).not.toContain('focus_input');
  });
});

describe('a new utterance reaches speech through the pipeline', () => {
  it('typed input during playback stops the audio, is answered, and is acknowledged', async () => {
    const h = setup();
    h.respond('There are two errors in auth.ts.');
    h.client.audio('speech-1');

    await h.panel.receive({ type: 'submit_text', submitId: 'submit-1', text: 'where am I' });

    expect(h.types().filter((t) => t === 'stop_audio')).toHaveLength(1);
    expect(h.handled).toEqual(['WHERE_AM_I']);
    expect(h.panel.webview.posted).toContainEqual({ type: 'submit_ack', submitId: 'submit-1', status: 'handled' });
  });

  it('the answer to the new utterance can be spoken afterwards and is not affected by the old stop', async () => {
    const h = setup();
    h.respond('first answer');
    h.client.audio('speech-1');
    await h.panel.receive({ type: 'submit_text', submitId: 'submit-1', text: 'where am I' });

    h.respond('You are in auth.ts.');
    h.client.audio('speech-2');

    const played = (h.panel.webview.posted as Array<{ type: string; id?: string }>).filter((m) => m.type === 'play_audio');
    expect(played.map((m) => m.id)).toEqual(['speech-1', 'speech-2']);
  });
});
