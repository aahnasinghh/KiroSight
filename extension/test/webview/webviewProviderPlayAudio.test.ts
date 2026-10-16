import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackendEvent } from '../../src/backend/backendClient';
import { validateHostToWebviewMessage } from '../../src/protocol/bridgeMessages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { SPEECH_UNAVAILABLE_TEXT, SpeechController } from '../../src/voice/speechController';
import { WebviewProvider } from '../../src/webview/webviewProvider';
import { createViewModel } from '../../src/webview/viewModel';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { Uri, resetVscodeMock, vscodeMockState } from '../mocks/vscode';

function setup() {
  const transcript = new TranscriptStore();
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline: {
      handle: async () => 'handled',
      confirm: async () => undefined,
      decline: async () => undefined,
      interrupt: () => undefined,
    },
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
  });
  return { provider, transcript };
}

const panel = () => vscodeMockState.webviewPanels[0]!;

describe('WebviewProvider.sendPlayAudio', () => {
  beforeEach(() => resetVscodeMock());

  it('posts one valid play_audio message with the id, MIME type and data unchanged', () => {
    const { provider } = setup();
    provider.openOrFocus();

    const sent = provider.sendPlayAudio({ id: 'speech-1', mimeType: 'audio/mpeg', base64: 'QUJD/+8=' });

    expect(sent).toBe(true);
    expect(panel().webview.posted).toEqual([
      { type: 'play_audio', id: 'speech-1', mimeType: 'audio/mpeg', base64: 'QUJD/+8=' },
    ]);
    expect(validateHostToWebviewMessage(panel().webview.posted[0]).ok).toBe(true);
  });

  it('returns false and sends nothing when no panel is open, including after it closes', () => {
    const { provider } = setup();
    expect(provider.sendPlayAudio({ id: 'speech-1', mimeType: 'audio/mpeg', base64: 'AA==' })).toBe(false);

    provider.openOrFocus();
    const opened = panel();
    opened.dispose();

    expect(provider.sendPlayAudio({ id: 'speech-1', mimeType: 'audio/mpeg', base64: 'AA==' })).toBe(false);
    expect(opened.webview.posted).toEqual([]);
  });

  it('refuses a message that does not validate, so the panel never receives it', () => {
    const { provider } = setup();
    provider.openOrFocus();

    expect(provider.sendPlayAudio({ id: 'speech-1', mimeType: 'audio/mpeg', base64: 5 as unknown as string })).toBe(false);

    expect(panel().webview.posted).toEqual([]);
  });

  it('puts no audio into the Transcript and does not touch the view', () => {
    const { provider, transcript } = setup();
    provider.openOrFocus();

    provider.sendPlayAudio({ id: 'speech-1', mimeType: 'audio/mpeg', base64: 'U0VDUkVU' });

    expect(JSON.stringify(transcript.getEntries())).not.toContain('U0VDUkVU');
    expect(panel().webview.posted.map((m) => (m as { type: string }).type)).toEqual(['play_audio']);
  });
});

describe('WebviewProvider.sendPlayAudio delivery failure', () => {
  beforeEach(() => resetVscodeMock());

  const clip = { id: 'speech-1', mimeType: 'audio/mpeg', base64: 'AAEC' };
  /** Lets the provider's promise handlers run. */
  const flush = (): Promise<void> => new Promise<void>((done) => setImmediate(done));
  const stubPost = (post: () => unknown): void => {
    (panel().webview as { postMessage: () => unknown }).postMessage = post;
  };

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
  afterEach(() => { process.off('unhandledRejection', onUnhandled); });

  it('postMessage resolves true: delivered, nothing reported', async () => {
    const { provider } = setup();
    provider.openOrFocus();
    let reports = 0;

    expect(provider.sendPlayAudio(clip, () => { reports += 1; })).toBe(true);
    await flush();

    expect(reports).toBe(0);
  });

  it('postMessage resolves false: the webview did not get it, reported once, after a true hand-over', async () => {
    const { provider } = setup();
    provider.openOrFocus();
    stubPost(() => Promise.resolve(false));
    let reports = 0;

    expect(provider.sendPlayAudio(clip, () => { reports += 1; })).toBe(true);
    expect(reports).toBe(0); // not known synchronously
    await flush();

    expect(reports).toBe(1);
  });

  it('postMessage rejects: reported once, never as an unhandled rejection', async () => {
    const { provider } = setup();
    provider.openOrFocus();
    stubPost(() => Promise.reject(new Error('webview gone')));
    let reports = 0;

    expect(provider.sendPlayAudio(clip, () => { reports += 1; })).toBe(true);
    await flush();

    expect(reports).toBe(1);
    expect(unhandled).toEqual([]);
  });

  it('postMessage throws synchronously: returns false at once and reports nothing later', async () => {
    const { provider } = setup();
    provider.openOrFocus();
    stubPost(() => { throw new Error('disposed'); });
    let reports = 0;

    expect(provider.sendPlayAudio(clip, () => { reports += 1; })).toBe(false);
    await flush();

    expect(reports).toBe(0);
  });

  it('a throwing observer, or none at all, is harmless', async () => {
    const { provider } = setup();
    provider.openOrFocus();
    stubPost(() => Promise.resolve(false));

    expect(provider.sendPlayAudio(clip, () => { throw new Error('observer bug'); })).toBe(true);
    expect(provider.sendPlayAudio(clip)).toBe(true);
    await flush();

    expect(unhandled).toEqual([]);
  });

  it('works end to end with the SpeechController: an undelivered clip becomes one prompt note', async () => {
    const { provider, transcript } = setup();
    provider.openOrFocus();
    stubPost(() => Promise.resolve(false));
    const listeners = new Set<(event: BackendEvent) => void>();
    const controller = new SpeechController({
      client: {
        state: 'connected',
        capabilities: { bedrock: true, stt: true, tts: true, mic: 'available' },
        sendSpeechRequest: () => true,
        cancelSpeechRequest: () => true,
        onEvent: (listener) => { listeners.add(listener); return { dispose: () => void listeners.delete(listener) }; },
        onStateChange: () => ({ dispose: () => undefined }),
      },
      panel: provider,
      transcript,
      isSpeechActive: () => true,
      getPendingConfirmation: () => null,
      scheduler: new FakeScheduler(),
    });
    const entry = transcript.append('kirosight', 'Two errors.');
    controller.speakResponse(entry);

    for (const listener of listeners) {
      listener({ version: 1, type: 'speech_audio', replyTo: 'speech-1', mimeType: 'audio/mpeg', base64: 'AAEC' });
    }
    await flush();

    // The panel's own one-time voice notice came first; look at what follows the response.
    const after = transcript.getEntries().slice(transcript.getEntries().findIndex((e) => e.seq === entry.seq));
    expect(after.map((e) => [e.role, e.text])).toEqual([
      ['kirosight', 'Two errors.'],
      ['system', SPEECH_UNAVAILABLE_TEXT],
    ]);
    controller.dispose();
  });
});