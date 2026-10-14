import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL, type BackendLogger } from '../../src/backend/backendClient';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: true, tts: false, mic: 'available' },
};
const CLIP = { id: 'voice-1', mimeType: 'audio/webm', base64: 'AQIDBAU=' };

class Lines implements BackendLogger {
  public readonly lines: string[] = [];
  public debug(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public info(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public warn(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
}

function build() {
  const factory = new FakeSocketFactory();
  const logger = new Lines();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler(), logger });
  return { client, factory, logger };
}

function connected() {
  const harness = build();
  harness.client.connect();
  const socket = harness.factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  return { ...harness, socket };
}

describe('BackendClient chunked audio frames', () => {
  it('sends seq and final together as a valid frame', () => {
    const { client, socket } = connected();

    expect(client.sendAudioClip({ ...CLIP, seq: 2, final: false })).toBe(true);
    expect(client.sendAudioClip({ ...CLIP, base64: '', seq: 3, final: true })).toBe(true);

    const frames = socket.sentMessages.filter((message) => message.type === 'audio_clip');
    expect(frames).toEqual([
      { version: 1, type: 'audio_clip', ...CLIP, seq: 2, final: false },
      { version: 1, type: 'audio_clip', ...CLIP, base64: '', seq: 3, final: true },
    ]);
    for (const frame of frames) expect(validateProtocolMessage(frame).ok).toBe(true);
  });

  it('never sends an invalid frame: seq without final, or a negative seq, is refused', () => {
    const { client, socket } = connected();

    expect(client.sendAudioClip({ ...CLIP, seq: 1 })).toBe(false);
    expect(client.sendAudioClip({ ...CLIP, final: true })).toBe(false);
    expect(client.sendAudioClip({ ...CLIP, seq: -1, final: false })).toBe(false);

    expect(socket.sentMessages.filter((message) => message.type === 'audio_clip')).toEqual([]);
  });
});

describe('BackendClient.cancelAudioClip', () => {
  it('sends a valid cancel frame for the recording id when connected', () => {
    const { client, socket } = connected();

    expect(client.cancelAudioClip('voice-1')).toBe(true);

    const frames = socket.sentMessages.filter((message) => message.type === 'cancel');
    expect(frames).toEqual([{ version: 1, type: 'cancel', targetId: 'voice-1' }]);
    expect(validateProtocolMessage(frames[0]).ok).toBe(true);
  });

  it('sends nothing and returns false when not connected, or when the socket throws', () => {
    expect(build().client.cancelAudioClip('voice-1')).toBe(false);

    const { client, socket } = connected();
    socket.throwOnSend = true;
    expect(client.cancelAudioClip('voice-1')).toBe(false);
  });
});

describe('BackendClient.sendAudioClip', () => {
  it('sends one valid audio_clip frame when connected', () => {
    const { client, socket } = connected();

    expect(client.sendAudioClip(CLIP)).toBe(true);

    const frames = socket.sentMessages.filter((message) => message.type === 'audio_clip');
    expect(frames).toEqual([{ version: 1, type: 'audio_clip', ...CLIP }]);
    expect(validateProtocolMessage(frames[0]).ok).toBe(true);
  });

  it('sends nothing, and returns false, before the handshake and after a disconnect', () => {
    const idle = build();
    expect(idle.client.sendAudioClip(CLIP)).toBe(false);

    const { client, socket } = connected();
    client.disconnect();
    expect(client.sendAudioClip(CLIP)).toBe(false);
    expect(socket.sentMessages.filter((message) => message.type === 'audio_clip')).toEqual([]);
  });

  it('never queues a recording for a later connection', () => {
    const { client, factory } = build();
    expect(client.sendAudioClip(CLIP)).toBe(false);

    client.connect();
    const socket = factory.last;
    socket.triggerOpen();
    socket.triggerJson(HELLO_ACK);

    expect(socket.sentMessages.map((message) => message.type)).toEqual(['hello']);
  });

  it('returns false when the socket throws, and logs no audio', () => {
    const { client, socket, logger } = connected();
    socket.throwOnSend = true;

    expect(client.sendAudioClip({ ...CLIP, base64: 'U0VDUkVUQVVESU8=' })).toBe(false);

    expect(logger.lines.join('\n')).not.toContain('U0VDUkVUQVVESU8=');
    expect(logger.lines.join('\n')).not.toContain('voice-1');
  });
});
