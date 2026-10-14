import { beforeEach, describe, expect, it } from 'vitest';

import { validateHostToWebviewMessage } from '../../src/protocol/bridgeMessages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { AudioChunk } from '../../src/voice/audioRelay';
import { WebviewProvider } from '../../src/webview/webviewProvider';
import { createViewModel } from '../../src/webview/viewModel';
import { Uri, resetVscodeMock, vscodeMockState } from '../mocks/vscode';

function setup(withVoice = true) {
  const transcript = new TranscriptStore();
  const micStates: string[] = [];
  const chunks: AudioChunk[] = [];
  const handled: string[] = [];
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline: {
      handle: async (text) => { handled.push(text); return 'handled'; },
      confirm: async () => undefined,
      decline: async () => undefined,
      interrupt: () => undefined,
    },
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
    ...(withVoice
      ? { voice: { onMicState: (state: string) => { micStates.push(state); }, onAudioClip: (chunk: AudioChunk) => { chunks.push(chunk); } } }
      : {}),
  });
  return { provider, micStates, chunks, handled };
}

const panel = () => vscodeMockState.webviewPanels[0]!;

describe('WebviewProvider microphone messages', () => {
  beforeEach(() => resetVscodeMock());

  it('hands validated mic_state and audio_clip messages to the voice layer, and nothing else', async () => {
    const { provider, micStates, chunks, handled } = setup();
    provider.openOrFocus();

    await panel().receive({ type: 'mic_state', state: 'granted' });
    await panel().receive({ type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AQID', seq: 0, final: true });

    expect(micStates).toEqual(['granted']);
    expect(chunks).toEqual([{ type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AQID', seq: 0, final: true }]);
    expect(handled).toEqual([]);
    expect(panel().webview.posted).toEqual([]);
  });

  it.each([
    [{ type: 'mic_state', state: 'recording' }],
    [{ type: 'mic_state' }],
    [{ type: 'audio_clip', clipId: 'c1' }],
    [{ type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AQID', extra: true }],
    [{ type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 5 }],
    [{ type: 'start_capture' }],
    [{ type: 'record_start', id: 'x' }],
  ])('drops the invalid or unknown message %j without effect', async (raw) => {
    const { provider, micStates, chunks } = setup();
    provider.openOrFocus();

    await panel().receive(raw);

    expect(micStates).toEqual([]);
    expect(chunks).toEqual([]);
  });

  it('drops microphone messages when no voice layer is connected, as before voice existed', async () => {
    const { provider } = setup(false);
    provider.openOrFocus();

    await panel().receive({ type: 'mic_state', state: 'granted' });
    await panel().receive({ type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AQID' });

    expect(panel().webview.posted).toEqual([]);
  });

  it('survives a voice layer that throws', async () => {
    const provider = new WebviewProvider({
      extensionUri: Uri.file('/ext') as never,
      pipeline: { handle: async () => 'handled', confirm: async () => undefined, decline: async () => undefined, interrupt: () => undefined },
      transcript: new TranscriptStore(),
      getViewModel: () => createViewModel(),
      voice: { onMicState: () => { throw new Error('bug'); }, onAudioClip: () => { throw new Error('bug'); } },
    });
    provider.openOrFocus();

    await expect(panel().receive({ type: 'mic_state', state: 'granted' })).resolves.toBeUndefined();
  });
});

describe('WebviewProvider capture commands', () => {
  beforeEach(() => resetVscodeMock());

  it('posts start_capture and stop_capture only while a panel is open', () => {
    const { provider } = setup();
    expect(provider.isOpen).toBe(false);
    expect(provider.sendCaptureCommand('start_capture')).toBe(false);

    provider.openOrFocus();
    expect(provider.isOpen).toBe(true);
    expect(provider.sendCaptureCommand('start_capture')).toBe(true);
    expect(provider.sendCaptureCommand('stop_capture')).toBe(true);

    expect(panel().webview.posted).toEqual([{ type: 'start_capture' }, { type: 'stop_capture' }]);
    for (const message of panel().webview.posted) {
      expect(validateHostToWebviewMessage(message).ok).toBe(true);
    }

    panel().dispose();
    expect(provider.isOpen).toBe(false);
    expect(provider.sendCaptureCommand('stop_capture')).toBe(false);
  });

  it('opening or re-focusing the panel never asks it to record', () => {
    const { provider } = setup();
    provider.openOrFocus();
    provider.openOrFocus();
    expect(panel().webview.posted.some((message) => (message as { type: string }).type === 'start_capture')).toBe(false);
  });
});
