import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackendEvent, ConnectionState, Disposable } from '../../src/backend/backendClient';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore, type TranscriptEntry } from '../../src/transcript/transcriptStore';
import type { PendingConfirmationView } from '../../src/webview/viewModel';
import {
  PLAYBACK_START_TIMEOUT_MS,
  SPEECH_UNAVAILABLE_TEXT,
  SpeechController,
  type SpeechClient,
  type SpeechPanelPort,
} from '../../src/voice/speechController';
import { FakeScheduler } from '../mocks/fakeScheduler';

/**
 * Task 9.5: SpeechController.stopSpeaking() is the speech half of an interruption. These tests use
 * fakes only: no backend, no webview, no audio, no provider.
 */
const TTS_ON: Capabilities = { bedrock: true, stt: true, tts: true, mic: 'available' };
const AUDIO = { mimeType: 'audio/mpeg', base64: 'U0VDUkVUQVVESU9CWVRFUw==' };

class FakeClient implements SpeechClient {
  public state: ConnectionState = 'connected';
  public capabilities: Capabilities | null = TTS_ON;
  public readonly sent: Array<{ id: string; text: string }> = [];
  public readonly cancelled: string[] = [];
  public cancelResult = true;
  public throwOnCancel = false;
  private readonly eventListeners = new Set<(event: BackendEvent) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  public sendSpeechRequest(request: { readonly id: string; readonly text: string }): boolean {
    this.sent.push({ id: request.id, text: request.text });
    return true;
  }

  public cancelSpeechRequest(id: string): boolean {
    if (this.throwOnCancel) throw new Error('cancel failed');
    this.cancelled.push(id);
    return this.cancelResult;
  }

  public onEvent(listener: (event: BackendEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => void this.eventListeners.delete(listener) };
  }

  public onStateChange(listener: (state: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => void this.stateListeners.delete(listener) };
  }

  public audio(replyTo: string): void {
    for (const listener of [...this.eventListeners]) {
      listener({ version: 1, type: 'speech_audio', replyTo, ...AUDIO });
    }
  }

  public error(replyTo: string): void {
    for (const listener of [...this.eventListeners]) {
      listener({ version: 1, type: 'error_message', replyTo, code: 'TTS_UNAVAILABLE', message: 'detail', recoverable: true });
    }
  }
}

class FakePanel implements SpeechPanelPort {
  public readonly played: Array<{ id: string; mimeType: string; base64: string }> = [];
  public readonly undelivered: Array<(() => void) | undefined> = [];
  public stops = 0;
  public stopResult = true;
  public throwOnStop = false;

  public sendPlayAudio(
    audio: { readonly id: string; readonly mimeType: string; readonly base64: string },
    onUndelivered?: () => void,
  ): boolean {
    this.played.push({ ...audio });
    this.undelivered.push(onUndelivered);
    return true;
  }

  public sendStopAudio(): boolean {
    if (this.throwOnStop) throw new Error('panel gone');
    this.stops += 1;
    return this.stopResult;
  }
}

function setup(options: { panel?: SpeechPanelPort } = {}) {
  const transcript = new TranscriptStore();
  const scheduler = new FakeScheduler();
  const client = new FakeClient();
  const panel = new FakePanel();
  const state = { pending: null as PendingConfirmationView | null };
  const controller = new SpeechController({
    client,
    panel: options.panel ?? panel,
    transcript,
    isSpeechActive: () => true,
    getPendingConfirmation: () => state.pending,
    scheduler,
  });
  const respond = (text: string): TranscriptEntry => {
    const entry = transcript.append('kirosight', text);
    controller.speakResponse(entry);
    return entry;
  };
  const notices = () => transcript.getEntries().filter((e) => e.text === SPEECH_UNAVAILABLE_TEXT);
  return { transcript, scheduler, client, panel, state, controller, respond, notices };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

/** Plays speech-1 up to the point the panel has the clip but has not reported it started. */
function handedOver(h: ReturnType<typeof setup>): void {
  h.respond('There are two errors in auth.ts.');
  h.client.audio('speech-1');
}

describe('stopSpeaking: interruption during synthesis', () => {
  it('cancels only that speech request, sends no stop_audio, adds no notice and drops the late audio', () => {
    const h = setup();
    h.respond('There are two errors in auth.ts.');

    expect(h.controller.stopSpeaking()).toBe(true);

    expect(h.client.cancelled).toEqual(['speech-1']);
    expect(h.panel.stops).toBe(0); // nothing had reached the panel
    expect(h.notices()).toEqual([]);
    expect(h.scheduler.pendingCount).toBe(0);

    h.client.audio('speech-1'); // late audio
    h.client.error('speech-1'); // late error
    expect(h.panel.played).toEqual([]);
    expect(h.notices()).toEqual([]);
  });

  it('cancels each waiting request by its own id', () => {
    const h = setup();
    h.respond('first');
    h.respond('second');

    h.controller.stopSpeaking();

    expect(h.client.cancelled).toEqual(['speech-1', 'speech-2']);
  });
});

describe('stopSpeaking: before and during playback', () => {
  it('before playback began: sends one stop_audio, cancels nothing at the backend, clears the deadline', () => {
    const h = setup();
    handedOver(h);
    expect(h.panel.played).toHaveLength(1);

    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(1);
    expect(h.client.cancelled).toEqual([]); // its audio was already delivered
    expect(h.scheduler.pendingCount).toBe(0);
    h.scheduler.advance(PLAYBACK_START_TIMEOUT_MS * 2);
    expect(h.notices()).toEqual([]); // an interruption is not a missed deadline
  });

  it('during playback: sends one stop_audio, and late acknowledgments for the clip change nothing', () => {
    const h = setup();
    handedOver(h);
    h.controller.handlePlayback('started', 'speech-1');

    h.controller.stopSpeaking();
    h.controller.handlePlayback('started', 'speech-1');
    h.controller.handlePlayback('ended', 'speech-1');
    h.controller.handlePlayback('failed', 'speech-1');

    expect(h.panel.stops).toBe(1);
    expect(h.notices()).toEqual([]);
    expect(h.scheduler.pendingCount).toBe(0);
  });

  it('after playback ended: nothing is active, so nothing is sent', () => {
    const h = setup();
    handedOver(h);
    h.controller.handlePlayback('started', 'speech-1');
    h.controller.handlePlayback('ended', 'speech-1');

    expect(h.controller.stopSpeaking()).toBe(false);

    expect(h.panel.stops).toBe(0);
    expect(h.client.cancelled).toEqual([]);
  });

  it('after the panel reported the clip failed: nothing is left to stop', () => {
    const h = setup();
    handedOver(h);
    h.controller.handlePlayback('failed', 'speech-1');
    expect(h.notices()).toHaveLength(1); // the ordinary failure note, unrelated to interruption

    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(0);
    expect(h.notices()).toHaveLength(1);
  });

  it('still stops a clip whose deadline already passed, because the panel may yet play it', () => {
    const h = setup();
    handedOver(h);
    h.scheduler.advance(PLAYBACK_START_TIMEOUT_MS);
    expect(h.notices()).toHaveLength(1);

    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(1);
    expect(h.notices()).toHaveLength(1); // no second note
  });

  it('does not stop a clip the panel never received', () => {
    const h = setup();
    handedOver(h);
    h.panel.undelivered[0]?.(); // the webview rejected the message

    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(0);
  });
});

describe('stopSpeaking: repeated and later work', () => {
  it('a repeated interruption does nothing more', () => {
    const h = setup();
    handedOver(h);

    expect(h.controller.stopSpeaking()).toBe(true);
    expect(h.controller.stopSpeaking()).toBe(false);
    expect(h.controller.stopSpeaking()).toBe(false);

    expect(h.panel.stops).toBe(1);
    expect(h.client.cancelled).toEqual([]);
  });

  it('a request made after the interruption is current: it is sent, its audio plays, the old audio does not', () => {
    const h = setup();
    h.respond('first answer');
    h.controller.stopSpeaking();

    h.respond('second answer');
    expect(h.client.sent.map((s) => s.id)).toEqual(['speech-1', 'speech-2']);
    h.client.audio('speech-1'); // late, from before the interruption
    h.client.audio('speech-2');

    expect(h.panel.played.map((p) => p.id)).toEqual(['speech-2']);
    h.controller.handlePlayback('started', 'speech-2');
    h.controller.handlePlayback('ended', 'speech-2');
    expect(h.notices()).toEqual([]);
  });

  it('keeps an interrupted response from being spoken again', () => {
    const h = setup();
    const entry = h.respond('first answer');
    h.controller.stopSpeaking();

    h.controller.speakResponse(entry);

    expect(h.client.sent).toHaveLength(1);
  });

  it('is safe when nothing was ever spoken', () => {
    const h = setup();
    expect(h.controller.stopSpeaking()).toBe(false);
    expect(h.panel.stops).toBe(0);
    expect(h.client.cancelled).toEqual([]);
  });
});

describe('stopSpeaking: the Transcript and confirmations', () => {
  it('leaves every Transcript entry exactly as it was and adds none', () => {
    const h = setup();
    h.respond('A long answer that is already complete in the Transcript.');
    h.respond('Another complete answer.');
    handedOver(h);
    const before = JSON.stringify(h.transcript.getEntries());

    h.controller.stopSpeaking();
    h.client.audio('speech-2');
    h.controller.handlePlayback('failed', 'speech-1');

    expect(JSON.stringify(h.transcript.getEntries())).toBe(before);
  });

  it('does not resolve a pending confirmation, and the prompt can still be repeated afterwards', () => {
    const h = setup();
    const prompt = 'Run tests using "npm test"? Reply confirm, decline, cancel, or repeat.';
    h.state.pending = { promptText: prompt, presentationKey: 'k1' };
    h.controller.speakPendingConfirmation();
    h.client.audio('speech-1');

    h.controller.stopSpeaking();

    expect(h.state.pending).toEqual({ promptText: prompt, presentationKey: 'k1' });
    expect(h.client.sent).toHaveLength(1); // not spoken again by itself

    h.controller.repeatConfirmation();
    expect(h.client.sent.map((s) => s.text)).toEqual([prompt, prompt]);
  });
});

describe('stopSpeaking: failures and disposal', () => {
  it('survives the backend being unavailable or refusing the cancel', () => {
    const h = setup();
    h.respond('first');
    h.client.state = 'disconnected';
    h.client.cancelResult = false;
    expect(() => h.controller.stopSpeaking()).not.toThrow();

    h.client.cancelResult = true;
    h.client.throwOnCancel = true;
    h.respond('second'); // not sent while disconnected: TTS is gated on a connected backend
    h.client.state = 'connected';
    h.respond('third');
    expect(() => h.controller.stopSpeaking()).not.toThrow();
    expect(h.notices()).toEqual([]);
  });

  it('survives the panel being closed, refusing, or throwing on stop_audio', () => {
    for (const mode of ['closed', 'throws']) {
      const h = setup();
      handedOver(h);
      h.panel.stopResult = mode !== 'closed';
      h.panel.throwOnStop = mode === 'throws';

      expect(() => h.controller.stopSpeaking()).not.toThrow();
      expect(h.notices()).toEqual([]);
      expect(h.controller.stopSpeaking()).toBe(false); // forgotten either way
    }
  });

  it('works with a panel that has no stop_audio support', () => {
    const noStop: SpeechPanelPort = { sendPlayAudio: () => true };
    const h = setup({ panel: noStop });
    h.respond('answer');
    h.client.audio('speech-1');

    expect(() => h.controller.stopSpeaking()).not.toThrow();
    expect(h.notices()).toEqual([]);
  });

  it('after dispose it does nothing, and dispose sends no stop_audio', () => {
    const h = setup();
    handedOver(h);

    h.controller.dispose();
    expect(h.controller.stopSpeaking()).toBe(false);

    expect(h.panel.stops).toBe(0);
    expect(h.scheduler.pendingCount).toBe(0);
  });

  it('leaves no timers behind after any mix of interruptions', () => {
    const h = setup();
    h.respond('a');
    h.respond('b');
    h.client.audio('speech-1');
    h.controller.stopSpeaking();
    h.respond('c');
    h.controller.stopSpeaking();
    h.controller.stopSpeaking();

    expect(h.scheduler.pendingCount).toBe(0);
  });
});
