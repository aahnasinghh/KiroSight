import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL, type BackendLogger } from '../../src/backend/backendClient';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { PLAYBACK_START_TIMEOUT_MS, SPEECH_UNAVAILABLE_TEXT, SpeechController } from '../../src/voice/speechController';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: true, tts: true, mic: 'available' },
};
const SECRET_TEXT = 'PRIVATE spoken words 12345';

class Lines implements BackendLogger {
  public readonly lines: string[] = [];
  public debug(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public info(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public warn(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
}

function build() {
  const factory = new FakeSocketFactory();
  const logger = new Lines();
  const scheduler = new FakeScheduler();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler, logger });
  return { client, factory, logger, scheduler };
}

function connected() {
  const harness = build();
  harness.client.connect();
  const socket = harness.factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  return { ...harness, socket };
}

describe('BackendClient.sendSpeechRequest', () => {
  it('sends one valid speech_request frame, with replyTo only when given', () => {
    const { client, socket } = connected();

    expect(client.sendSpeechRequest({ id: 'speech-1', text: 'Two errors.' })).toBe(true);
    expect(client.sendSpeechRequest({ id: 'speech-2', text: 'Opened.', replyTo: 'req-4' })).toBe(true);

    const frames = socket.sentMessages.filter((message) => message.type === 'speech_request');
    expect(frames).toEqual([
      { version: 1, type: 'speech_request', id: 'speech-1', text: 'Two errors.' },
      { version: 1, type: 'speech_request', id: 'speech-2', text: 'Opened.', replyTo: 'req-4' },
    ]);
    for (const frame of frames) expect(validateProtocolMessage(frame).ok).toBe(true);
  });

  it('sends the text as data, unchanged', () => {
    const { client, socket } = connected();
    const tricky = 'Say "hi"\n{"type":"cancel","targetId":"x"} \u00e9';

    client.sendSpeechRequest({ id: 'speech-1', text: tricky });

    const frames = socket.sentMessages.filter((message) => message.type === 'speech_request');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.text).toBe(tricky);
    expect(socket.sentMessages.filter((message) => message.type === 'cancel')).toEqual([]);
  });

  it('sends nothing, and returns false, before the handshake and after a disconnect', () => {
    expect(build().client.sendSpeechRequest({ id: 'speech-1', text: 'x' })).toBe(false);

    const { client, socket } = connected();
    client.disconnect();
    expect(client.sendSpeechRequest({ id: 'speech-1', text: 'x' })).toBe(false);
    expect(socket.sentMessages.filter((message) => message.type === 'speech_request')).toEqual([]);
  });

  it('never queues a speech request for a later connection', () => {
    const { client, factory } = build();
    expect(client.sendSpeechRequest({ id: 'speech-1', text: 'x' })).toBe(false);

    client.connect();
    const socket = factory.last;
    socket.triggerOpen();
    socket.triggerJson(HELLO_ACK);

    expect(socket.sentMessages.map((message) => message.type)).toEqual(['hello']);
  });

  it('refuses a frame that does not validate', () => {
    const { client, socket } = connected();

    expect(client.sendSpeechRequest({ id: 'speech-1', text: 5 as unknown as string })).toBe(false);

    expect(socket.sentMessages.filter((message) => message.type === 'speech_request')).toEqual([]);
  });

  it('returns false when the socket throws, and logs neither the text nor the id', () => {
    const { client, socket, logger } = connected();
    socket.throwOnSend = true;

    expect(client.sendSpeechRequest({ id: 'speech-77', text: SECRET_TEXT })).toBe(false);

    const logged = logger.lines.join('\n');
    expect(logged).not.toContain(SECRET_TEXT);
    expect(logged).not.toContain('speech-77');
  });

  it('logs nothing about the text on success either', () => {
    const { client, logger } = connected();
    client.sendSpeechRequest({ id: 'speech-77', text: SECRET_TEXT });
    expect(logger.lines.join('\n')).not.toContain(SECRET_TEXT);
  });
});

describe('BackendClient.cancelSpeechRequest', () => {
  it('sends a valid cancel frame for the request id', () => {
    const { client, socket } = connected();

    expect(client.cancelSpeechRequest('speech-1')).toBe(true);

    const frames = socket.sentMessages.filter((message) => message.type === 'cancel');
    expect(frames).toEqual([{ version: 1, type: 'cancel', targetId: 'speech-1' }]);
    expect(validateProtocolMessage(frames[0]).ok).toBe(true);
  });

  it('sends nothing and returns false when not connected, or when the socket throws', () => {
    expect(build().client.cancelSpeechRequest('speech-1')).toBe(false);

    const { client, socket } = connected();
    socket.throwOnSend = true;
    expect(client.cancelSpeechRequest('speech-1')).toBe(false);
  });
});

describe('SpeechController over the real BackendClient', () => {
  function wire() {
    const harness = connected();
    const transcript = new TranscriptStore();
    const played: Array<{ id: string; mimeType: string; base64: string }> = [];
    const controller = new SpeechController({
      client: harness.client, // BackendClient must satisfy SpeechClient structurally
      panel: { sendPlayAudio: (audio) => { played.push({ ...audio }); return true; } },
      transcript,
      isSpeechActive: () => true,
      getPendingConfirmation: () => null,
      scheduler: harness.scheduler,
    });
    return { ...harness, transcript, played, controller };
  }

  it('sends a valid speech_request after the text is in the Transcript, then plays the matching audio', () => {
    const w = wire();
    w.controller.speakResponse(w.transcript.append('kirosight', 'Two errors.'));

    const request = w.socket.sentMessages.find((message) => message.type === 'speech_request');
    expect(request).toEqual({ version: 1, type: 'speech_request', id: 'speech-1', text: 'Two errors.' });

    w.socket.triggerJson({ version: 1, type: 'speech_audio', replyTo: 'speech-1', mimeType: 'audio/mpeg', base64: 'AAEC' });
    expect(w.played).toEqual([{ id: 'speech-1', mimeType: 'audio/mpeg', base64: 'AAEC' }]);

    w.controller.handlePlayback('started', 'speech-1');
    w.scheduler.advance(PLAYBACK_START_TIMEOUT_MS * 2);
    expect(w.transcript.getEntries().map((entry) => entry.role)).toEqual(['kirosight']);
  });

  it('turns a backend TTS error_message into one note and keeps the text', () => {
    const w = wire();
    w.controller.speakResponse(w.transcript.append('kirosight', 'Two errors.'));

    w.socket.triggerJson({
      version: 1, type: 'error_message', replyTo: 'speech-1', code: 'TTS_UNAVAILABLE',
      message: 'Spoken playback is unavailable.', recoverable: true,
    });

    expect(w.transcript.getEntries().map((entry) => [entry.role, entry.text])).toEqual([
      ['kirosight', 'Two errors.'],
      ['system', SPEECH_UNAVAILABLE_TEXT],
    ]);
  });

  it('sends a cancel for a request that gets no audio in time, and one note when the socket drops', () => {
    const w = wire();
    w.controller.speakResponse(w.transcript.append('kirosight', 'one'));
    w.scheduler.advance(PLAYBACK_START_TIMEOUT_MS);
    expect(w.socket.sentMessages.filter((message) => message.type === 'cancel'))
      .toEqual([{ version: 1, type: 'cancel', targetId: 'speech-1' }]);

    w.controller.speakResponse(w.transcript.append('kirosight', 'two'));
    w.socket.triggerClose();

    const notes = w.transcript.getEntries().filter((entry) => entry.role === 'system');
    expect(notes).toHaveLength(2); // one for the timeout, one for the lost connection
  });

  it('does not ask for speech when the handshake reported text-to-speech as unavailable, and says so once', () => {
    const harness = build();
    harness.client.connect();
    harness.factory.last.triggerOpen();
    harness.factory.last.triggerJson({ ...HELLO_ACK, capabilities: { ...HELLO_ACK.capabilities, tts: false } });
    const transcript = new TranscriptStore();
    const controller = new SpeechController({
      client: harness.client,
      panel: { sendPlayAudio: () => true },
      transcript,
      isSpeechActive: () => true,
      getPendingConfirmation: () => null,
      scheduler: harness.scheduler,
    });

    controller.speakResponse(transcript.append('kirosight', 'hello'));

    controller.speakResponse(transcript.append('kirosight', 'hello again'));

    expect(harness.factory.last.sentMessages.map((message) => message.type)).toEqual(['hello']);
    expect(transcript.getEntries().map((entry) => [entry.role, entry.text])).toEqual([
      ['kirosight', 'hello'],
      ['system', SPEECH_UNAVAILABLE_TEXT], // one note for the outage, not one per response
      ['kirosight', 'hello again'],
    ]);
  });
});