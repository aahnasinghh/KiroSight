import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { BackendEvent, ConnectionState, Disposable } from '../../src/backend/backendClient';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import {
  MAX_TRACKED_SPEECH,
  SPEECH_UNAVAILABLE_TEXT,
  SpeechController,
  type SpeechClient,
  type SpeechPanelPort,
} from '../../src/voice/speechController';
import { FakeScheduler } from '../mocks/fakeScheduler';

/**
 * Task 9.5 safety review: SpeechController.makeRoom() may forget a clip that is still playing in
 * the panel (Task 9.3). Stopping speech must still send `stop_audio` for it.
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

class FakePanel implements SpeechPanelPort {
  public readonly played: string[] = [];
  public stops = 0;

  public sendPlayAudio(audio: { readonly id: string }): boolean {
    this.played.push(audio.id);
    return true;
  }

  public sendStopAudio(): boolean {
    this.stops += 1;
    return true;
  }
}

function setup() {
  const transcript = new TranscriptStore();
  const client = new FakeClient();
  const panel = new FakePanel();
  const scheduler = new FakeScheduler();
  const controller = new SpeechController({
    client, panel, transcript, isSpeechActive: () => true, getPendingConfirmation: () => null, scheduler,
  });
  const respond = (text: string): void => { controller.speakResponse(transcript.append('kirosight', text)); };
  const notices = () => transcript.getEntries().filter((e) => e.text === SPEECH_UNAVAILABLE_TEXT);
  /** speech-1 is playing in the panel; speech-2 to speech-N are all still waiting for audio. */
  const fillToTheLimit = (): void => {
    respond('first answer');
    client.audio('speech-1');
    controller.handlePlayback('started', 'speech-1');
    for (let n = 2; n <= MAX_TRACKED_SPEECH; n += 1) respond(`answer ${n}`);
  };
  return { transcript, client, panel, scheduler, controller, respond, notices, fillToTheLimit };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on('unhandledRejection', onUnhandled); });
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('stopSpeaking after makeRoom() forgot a playing clip', () => {
  it('still sends stop_audio for the evicted clip, and cancels the requests that are waiting', () => {
    const h = setup();
    h.fillToTheLimit();

    h.respond('one answer too many'); // the table is full: the started clip is forgotten to make room
    expect(h.client.sent).toContain(`speech-${MAX_TRACKED_SPEECH + 1}`);
    expect(h.notices()).toEqual([]); // eviction itself is not a failure
    expect(h.panel.stops).toBe(0);

    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(1);
    const waiting = Array.from({ length: MAX_TRACKED_SPEECH }, (_, i) => `speech-${i + 2}`);
    expect(h.client.cancelled).toEqual(waiting); // speech-1 already had its audio; nothing else is cancelled
    expect(h.notices()).toEqual([]);
  });

  it('a late acknowledgment for the evicted clip changes nothing; once it ended, there is nothing to stop', () => {
    const h = setup();
    h.fillToTheLimit();
    h.respond('one answer too many');

    h.controller.handlePlayback('ended', 'speech-1'); // the panel reports it finished
    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(0);
    expect(h.notices()).toEqual([]);
  });

  it('keeps sending exactly one stop after many clips were evicted without acknowledgments', () => {
    const h = setup();
    for (let n = 1; n <= MAX_TRACKED_SPEECH * 3; n += 1) {
      h.respond(`answer ${n}`);
      h.client.audio(`speech-${n}`);
      h.controller.handlePlayback('started', `speech-${n}`);
    }
    expect(h.notices()).toEqual([]);

    h.controller.stopSpeaking();
    h.controller.stopSpeaking();

    expect(h.panel.stops).toBe(1);
  });

  it('request correlation is unchanged: audio for an evicted clip id is still dropped', () => {
    const h = setup();
    h.fillToTheLimit();
    h.respond('one answer too many');
    const playedBefore = h.panel.played.length;

    h.client.audio('speech-1'); // duplicate audio for the evicted clip

    expect(h.panel.played).toHaveLength(playedBefore);
  });
});

describe('disposing a SpeechController', () => {
  it('sends no stop_audio by itself: the caller stops speech first, which then sends exactly one', () => {
    const h = setup();
    h.respond('answer');
    h.client.audio('speech-1');
    h.controller.handlePlayback('started', 'speech-1');

    h.controller.stopSpeaking();
    h.controller.dispose();

    expect(h.panel.stops).toBe(1);
    expect(h.scheduler.pendingCount).toBe(0);
  });

  it('a bare dispose leaves the panel alone (its contract: no notice, no audio traffic)', () => {
    const h = setup();
    h.respond('answer');
    h.client.audio('speech-1');
    h.controller.handlePlayback('started', 'speech-1');

    h.controller.dispose();

    expect(h.panel.stops).toBe(0);
    expect(h.notices()).toEqual([]);
  });
});
