import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { validateHostToWebviewMessage } from '../../src/protocol/bridgeMessages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { AudioChunk } from '../../src/voice/audioRelay';
import { WebviewProvider, type PipelinePort } from '../../src/webview/webviewProvider';
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

// --- Task 8.9: push-to-talk and Escape reach the voice layer ------------------------------------------------

type VoiceHooks = ConstructorParameters<typeof WebviewProvider>[0]['voice'];

function setupPushToTalk(voice?: VoiceHooks) {
  const transcript = new TranscriptStore();
  const calls = { interrupt: 0, handle: 0 };
  const pipeline: PipelinePort = {
    handle: async () => { calls.handle += 1; return 'handled'; },
    confirm: async () => undefined,
    decline: async () => undefined,
    interrupt: () => { calls.interrupt += 1; },
  };
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline,
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
    ...(voice === undefined ? {} : { voice }),
  });
  provider.openOrFocus();
  return { provider, transcript, calls, panel: vscodeMockState.webviewPanels[0]! };
}

describe('WebviewProvider push-to-talk', () => {
  beforeEach(() => resetVscodeMock());

  it('hands each ptt_toggle message to the voice layer, once per press, and nothing else happens', async () => {
    let toggles = 0;
    const { panel: opened, calls, transcript } = setupPushToTalk({
      onMicState: () => undefined,
      onAudioClip: () => undefined,
      onPushToTalkToggle: () => { toggles += 1; },
    });
    const entries = transcript.getEntries();

    await opened.receive({ type: 'ptt_toggle' });
    await opened.receive({ type: 'ptt_toggle' });

    expect(toggles).toBe(2);
    expect(calls).toEqual({ interrupt: 0, handle: 0 });
    expect(transcript.getEntries()).toEqual(entries);
    expect(opened.webview.posted).toEqual([]);
  });

  it('waits for an asynchronous toggle and survives one that throws', async () => {
    const order: string[] = [];
    const { panel: opened } = setupPushToTalk({
      onMicState: () => undefined,
      onAudioClip: () => undefined,
      onPushToTalkToggle: async () => { order.push('start'); await Promise.resolve(); order.push('end'); },
    });
    await opened.receive({ type: 'ptt_toggle' });
    expect(order).toEqual(['start', 'end']);

    resetVscodeMock();
    const broken = setupPushToTalk({
      onMicState: () => undefined,
      onAudioClip: () => undefined,
      onPushToTalkToggle: () => { throw new Error('voice bug'); },
    });
    await expect(broken.panel.receive({ type: 'ptt_toggle' })).resolves.toBeUndefined();
  });

  it('ignores a press when no voice layer is connected, and with no onPushToTalkToggle', async () => {
    const none = setupPushToTalk();
    await expect(none.panel.receive({ type: 'ptt_toggle' })).resolves.toBeUndefined();

    resetVscodeMock();
    const partial = setupPushToTalk({ onMicState: () => undefined, onAudioClip: () => undefined });
    await expect(partial.panel.receive({ type: 'ptt_toggle' })).resolves.toBeUndefined();
  });

  it('drops a malformed or extended ptt_toggle before it reaches the voice layer', async () => {
    let toggles = 0;
    const { panel: opened } = setupPushToTalk({
      onMicState: () => undefined,
      onAudioClip: () => undefined,
      onPushToTalkToggle: () => { toggles += 1; },
    });

    await opened.receive({ type: 'ptt_toggle', extra: true });
    await opened.receive({ type: 'ptt_toggle', command: 'rm -rf /' });

    expect(toggles).toBe(0);
  });

  it('tells the voice layer about Escape in addition to interrupting the pipeline', async () => {
    let interrupts = 0;
    const { panel: opened, calls } = setupPushToTalk({
      onMicState: () => undefined,
      onAudioClip: () => undefined,
      onInterrupt: () => { interrupts += 1; },
    });

    await opened.receive({ type: 'interrupt' });

    expect(calls.interrupt).toBe(1);
    expect(interrupts).toBe(1);
  });
});

describe('the push-to-talk control in the webview script', () => {
  const script = readFileSync(resolve(__dirname, '../../media/main.js'), 'utf8');

  it('handles only Escape itself, so Enter and Space reach the native button unchanged', () => {
    const keys = [...script.matchAll(/event\.key === '([^']+)'/g)].map((match) => match[1]);
    expect(keys).toEqual(['Escape']);
    expect(script).not.toMatch(/keyCode/);
  });

  it('toggles from the host-provided listening state, with Listening and Processing shown in the status', () => {
    expect(script).toContain("'Stop listening' : 'Push to talk'");
    expect(script).toContain("setAttribute('aria-pressed'");
    expect(script).toContain("post({ type: 'ptt_toggle' })");
  });
});
