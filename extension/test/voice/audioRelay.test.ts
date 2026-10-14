import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import { validateProtocolMessage } from '../../src/protocol/validators';
import {
  AUDIO_BACKEND_UNAVAILABLE_TEXT,
  AudioRelay,
  MAX_CHUNK_BASE64_CHARS,
  MAX_CLIP_BYTES,
  RELAY_DEADLINE_MS,
  type AudioChunk,
  type AudioClipSender,
  type AudioFrame,
  type RelayOutcome,
} from '../../src/voice/audioRelay';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

/** A manual millisecond clock shared by the relay and the fake backend sender. */
class FakeClock {
  public current = 1_000;
  public readonly now = (): number => this.current;
  public advance(ms: number): void {
    this.current += ms;
  }
}

class FakeSender implements AudioClipSender {
  public readonly frames: AudioFrame[] = [];
  public readonly cancels: string[] = [];
  /** Wall time between each frame's send call, as the clock saw it. */
  public readonly sentAt: number[] = [];
  public reachable = true;
  /** How long a send takes on the fake clock. */
  public sendDelayMs = 0;

  public constructor(private readonly clock?: FakeClock) {}

  public sendAudioClip(frame: AudioFrame): boolean {
    if (!this.reachable) return false;
    this.clock?.advance(this.sendDelayMs);
    this.frames.push(frame);
    this.sentAt.push(this.clock?.current ?? 0);
    return true;
  }

  public cancelAudioClip(id: string): boolean {
    if (!this.reachable) return false;
    this.cancels.push(id);
    return true;
  }
}

const b64 = (bytes: Uint8Array | number[]) => Buffer.from(bytes).toString('base64');
const bytesOf = (frame: { base64: string }) => [...Buffer.from(frame.base64, 'base64')];
const chunk = (overrides: Partial<AudioChunk> & { bytes?: number[] } = {}): AudioChunk => {
  const { bytes, ...rest } = overrides;
  return { clipId: 'clip-1', mimeType: 'audio/webm;codecs=opus', base64: b64(bytes ?? [1, 2, 3]), ...rest };
};

function build() {
  const clock = new FakeClock();
  const sender = new FakeSender(clock);
  const notices: string[] = [];
  const relay = new AudioRelay(sender, (message) => notices.push(message), clock.now);
  return { clock, sender, notices, relay };
}

const relayed = (outcome: RelayOutcome) => {
  if (outcome.status !== 'relayed') throw new Error(`expected relayed, got ${outcome.status}`);
  return outcome;
};

describe('AudioRelay: each chunk is forwarded as it arrives', () => {
  it('forwards a single-shot clip, with no seq, as one final frame with a host-assigned id', () => {
    const { relay, sender } = build();

    const outcome = relayed(relay.accept(chunk({ bytes: [9, 8, 7, 6] })));

    expect(outcome).toMatchObject({ backendClipId: 'voice-1', seq: 0, final: true });
    expect(sender.frames).toHaveLength(1);
    expect(sender.frames[0]).toMatchObject({ id: 'voice-1', mimeType: 'audio/webm;codecs=opus', seq: 0, final: true });
    expect(bytesOf(sender.frames[0]!)).toEqual([9, 8, 7, 6]);
  });

  it('forwards the first chunk immediately, without waiting for the recording to end', () => {
    const { relay, sender } = build();

    const outcome = relayed(relay.accept(chunk({ bytes: [1, 2, 3], seq: 0, final: false })));

    expect(sender.frames).toHaveLength(1); // sent during this very call, before any later chunk exists
    expect(outcome).toMatchObject({ seq: 0, final: false });
    expect(sender.frames[0]).toMatchObject({ id: 'voice-1', seq: 0, final: false });
    expect(bytesOf(sender.frames[0]!)).toEqual([1, 2, 3]);
  });

  it('forwards every chunk of a multi-chunk recording in order, one frame per chunk, never combined', () => {
    const { relay, sender } = build();
    const parts = [[1, 2, 3, 4, 5], [6, 7], [8, 9, 10, 11]];

    parts.forEach((part, seq) => {
      relay.accept(chunk({ bytes: part, seq, final: seq === parts.length - 1 }));
      expect(sender.frames).toHaveLength(seq + 1); // each chunk went out as it arrived
    });

    expect(sender.frames.map((frame) => frame.seq)).toEqual([0, 1, 2]);
    expect(sender.frames.map((frame) => frame.final)).toEqual([false, false, true]);
    expect(new Set(sender.frames.map((frame) => frame.id)).size).toBe(1);
    expect(sender.frames.map(bytesOf)).toEqual(parts);
  });

  it('forwards an empty final marker as a final frame when audio was already sent', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ bytes: [1, 2, 3], seq: 0, final: false }));

    const outcome = relayed(relay.accept({ ...chunk({ seq: 1, final: true }), base64: '' }));

    expect(outcome).toMatchObject({ seq: 1, final: true });
    expect(sender.frames).toHaveLength(2);
    expect(sender.frames[1]).toMatchObject({ seq: 1, final: true, base64: '' });
  });

  it('numbers outbound frames contiguously even when empty non-final chunks are skipped', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ bytes: [1], seq: 0, final: false }));
    expect(relay.accept({ ...chunk({ seq: 1, final: false }), base64: '' })).toEqual({ status: 'skipped' });
    relay.accept(chunk({ bytes: [2], seq: 2, final: true }));

    expect(sender.frames.map((frame) => frame.seq)).toEqual([0, 1]);
    expect(sender.frames.map((frame) => frame.final)).toEqual([false, true]);
  });

  it('numbers recordings in the order they were received', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ clipId: 'a' }));
    relay.accept(chunk({ clipId: 'b' }));
    relay.accept(chunk({ clipId: 'c' }));
    expect(sender.frames.map((frame) => frame.id)).toEqual(['voice-1', 'voice-2', 'voice-3']);
    expect(sender.frames.every((frame) => frame.seq === 0 && frame.final)).toBe(true);
  });

  it('produces frames the backend protocol accepts, for chunked and single-chunk recordings', () => {
    const factory = new FakeSocketFactory();
    const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerJson({
      version: 1, type: 'hello_ack', supportedVersions: [1],
      capabilities: { bedrock: false, stt: true, tts: false, mic: 'available' },
    });
    const relay = new AudioRelay(client);

    relay.accept(chunk({ clipId: 'multi', bytes: [5, 5, 5, 5, 5], seq: 0, final: false }));
    relay.accept(chunk({ clipId: 'multi', bytes: [6, 6], seq: 1, final: false }));
    relay.accept({ ...chunk({ clipId: 'multi', seq: 2, final: true }), base64: '' });
    relay.accept(chunk({ clipId: 'single', bytes: [7, 7, 7] }));

    const frames = factory.last.sentMessages.filter((frame) => frame.type === 'audio_clip');
    expect(frames).toHaveLength(4);
    for (const frame of frames) expect(validateProtocolMessage(frame).ok).toBe(true);
    expect(frames.map((frame) => [frame.id, frame.seq, frame.final])).toEqual([
      ['voice-1', 0, false],
      ['voice-1', 1, false],
      ['voice-1', 2, true],
      ['voice-2', 0, true],
    ]);
  });
});

describe('AudioRelay: the 500 ms relay deadline (Req 19.5)', () => {
  it('exposes the deadline as 500 ms', () => {
    expect(RELAY_DEADLINE_MS).toBe(500);
  });

  it('reports zero latency when the send is instant', () => {
    const { relay } = build();
    expect(relayed(relay.accept(chunk()))).toMatchObject({ latencyMs: 0, late: false });
  });

  it('passes a send that takes exactly 500 ms from host receipt', () => {
    const { relay, sender } = build();
    sender.sendDelayMs = 500;
    expect(relayed(relay.accept(chunk()))).toMatchObject({ latencyMs: 500, late: false });
  });

  it('flags a send that takes more than 500 ms from host receipt', () => {
    const { relay, sender } = build();
    sender.sendDelayMs = 501;
    expect(relayed(relay.accept(chunk()))).toMatchObject({ latencyMs: 501, late: true });
  });

  it('measures every chunk on its own, from its own receipt, not from the start of the recording', () => {
    const { relay, sender, clock } = build();
    sender.sendDelayMs = 10;

    const first = relayed(relay.accept(chunk({ seq: 0, final: false })));
    clock.advance(5_000); // a long gap between chunks is the recorder's pace, not relay delay
    const second = relayed(relay.accept(chunk({ seq: 1, final: false })));
    sender.sendDelayMs = 600;
    clock.advance(1_000);
    const third = relayed(relay.accept(chunk({ seq: 2, final: true })));

    expect([first.latencyMs, first.late]).toEqual([10, false]);
    expect([second.latencyMs, second.late]).toEqual([10, false]);
    expect([third.latencyMs, third.late]).toEqual([600, true]);
  });

  it('sends each chunk at its own receipt time, not later', () => {
    const { relay, sender, clock } = build();
    const receivedAt: number[] = [];
    for (let seq = 0; seq < 4; seq += 1) {
      clock.advance(1_000);
      receivedAt.push(clock.current);
      relay.accept(chunk({ seq, final: seq === 3 }));
    }
    expect(sender.sentAt).toEqual(receivedAt); // zero delay: each frame left at the moment its chunk arrived
  });
});

describe('AudioRelay: order and duplicates', () => {
  it('ignores a repeated chunk: it is forwarded once', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ bytes: [1], seq: 0, final: false }));

    expect(relay.accept(chunk({ bytes: [1], seq: 0, final: false })).status).toBe('duplicate');
    relay.accept(chunk({ bytes: [2], seq: 1, final: true }));

    expect(sender.frames.map(bytesOf)).toEqual([[1], [2]]);
  });

  it('does not forward a finished recording again when its last chunk is repeated', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ seq: 0, final: false }));
    relay.accept(chunk({ seq: 1, final: true }));

    expect(relay.accept(chunk({ seq: 1, final: true }))).toEqual({ status: 'rejected', reason: 'out_of_order' });
    expect(sender.frames).toHaveLength(2);
    expect(sender.cancels).toEqual([]); // a finished recording is not cancelled
  });

  it('rejects a gap in the sequence, forwards nothing more and cancels what was sent', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ seq: 0, final: false }));

    expect(relay.accept(chunk({ seq: 2, final: false }))).toEqual({ status: 'rejected', reason: 'out_of_order' });

    expect(sender.frames).toHaveLength(1);
    expect(sender.cancels).toEqual(['voice-1']);
    expect(relay.accept(chunk({ seq: 1, final: true })).status).toBe('rejected');
    expect(sender.frames).toHaveLength(1);
  });

  it('rejects a recording that starts mid-sequence and sends nothing', () => {
    const { relay, sender } = build();
    expect(relay.accept(chunk({ seq: 3, final: false }))).toEqual({ status: 'rejected', reason: 'out_of_order' });
    expect(sender.frames).toEqual([]);
    expect(sender.cancels).toEqual([]); // nothing had been sent, so there is nothing to cancel
  });

  it('lets a new recording supersede a partial one, cancelling the old one at the backend', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ clipId: 'old', bytes: [1, 1], seq: 0, final: false }));

    relay.accept(chunk({ clipId: 'new', bytes: [2, 2], seq: 0, final: true }));

    expect(sender.cancels).toEqual(['voice-1']);
    expect(sender.frames.map((frame) => [frame.id, frame.final])).toEqual([['voice-1', false], ['voice-2', true]]);
  });
});

describe('AudioRelay: cancellation', () => {
  it('reset cancels a partly sent recording at the backend and forwards nothing further', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ bytes: [1], seq: 0, final: false }));

    relay.reset();

    expect(sender.cancels).toEqual(['voice-1']);
    expect(relay.accept(chunk({ bytes: [2], seq: 1, final: true })).status).toBe('rejected');
    expect(sender.frames).toHaveLength(1);
  });

  it('reset with nothing sent, or after a finished recording, sends no cancel', () => {
    const { relay, sender } = build();
    relay.reset();
    relay.accept(chunk({ seq: 0, final: false }));
    relay.accept(chunk({ seq: 1, final: true }));
    relay.reset();
    expect(sender.cancels).toEqual([]);
  });

  it('cancels only once per partial recording', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ seq: 0, final: false }));
    relay.reset();
    relay.reset();
    expect(sender.cancels).toEqual(['voice-1']);
  });

  it('survives a cancel that cannot be sent', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ seq: 0, final: false }));
    sender.reachable = false;
    expect(() => relay.reset()).not.toThrow();
  });
});

describe('AudioRelay: bounds and validation', () => {
  it('rejects a chunk above the 1 MB chunk limit without forwarding it', () => {
    const { relay, sender } = build();
    const huge = 'A'.repeat(MAX_CHUNK_BASE64_CHARS + 4);

    expect(relay.accept({ ...chunk({ seq: 0, final: true }), base64: huge })).toEqual({ status: 'rejected', reason: 'too_large' });
    expect(sender.frames).toEqual([]);
  });

  it('accepts and forwards a chunk exactly at the limit', () => {
    const { relay, sender } = build();
    const atLimit = 'A'.repeat(MAX_CHUNK_BASE64_CHARS);
    expect(relay.accept({ ...chunk({ seq: 0, final: false }), base64: atLimit }).status).toBe('relayed');
    expect(sender.frames[0]!.base64.length).toBe(MAX_CHUNK_BASE64_CHARS);
  });

  it('refuses audio past the per-recording byte cap, stops forwarding and cancels the recording', () => {
    const { relay, sender } = build();
    const slice = b64(new Uint8Array(600_000).fill(7));
    let seq = 0;
    let last: RelayOutcome = relay.accept(chunk({ seq, final: false }));
    while (last.status === 'relayed') {
      seq += 1;
      last = relay.accept({ ...chunk({ seq, final: false }), base64: slice });
    }

    expect(last).toEqual({ status: 'rejected', reason: 'too_large' });
    expect(sender.cancels).toEqual(['voice-1']);
    const forwarded = sender.frames.reduce((total, frame) => total + bytesOf(frame).length, 0);
    expect(forwarded).toBeLessThanOrEqual(MAX_CLIP_BYTES);
    // Every frame stays under the backend's 2 MiB inbound message cap.
    expect(Math.max(...sender.frames.map((frame) => frame.base64.length))).toBeLessThan(2 * 1024 * 1024);
  });

  it.each([
    ['text', 'text/plain'],
    ['markup', 'audio/webm"><script>'],
    ['an empty type', ''],
    ['a header-injection attempt', 'audio/webm\r\nX-Evil: 1'],
    ['an over-long type', `audio/${'a'.repeat(200)}`],
  ])('rejects %s as a mime type', (_label, mimeType) => {
    const { relay, sender } = build();
    expect(relay.accept({ ...chunk(), mimeType })).toEqual({ status: 'rejected', reason: 'bad_mime' });
    expect(sender.frames).toEqual([]);
  });

  it.each(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg; codecs=opus', 'audio/mp4', 'audio/x-wav'])(
    'accepts the recorder type %s',
    (mimeType) => {
      expect(build().relay.accept({ ...chunk(), mimeType }).status).toBe('relayed');
    },
  );

  it.each(['not base64!', 'abc', '===='])('rejects %j as base64 and sends nothing', (base64) => {
    const { relay, sender } = build();
    expect(relay.accept({ ...chunk({ seq: 0, final: true }), base64 }).status).toBe('rejected');
    expect(sender.frames).toEqual([]);
  });

  it('cancels a partial recording when a later chunk is malformed', () => {
    const { relay, sender } = build();
    relay.accept(chunk({ seq: 0, final: false }));
    expect(relay.accept({ ...chunk({ seq: 1, final: false }), base64: 'not base64!' }).status).toBe('rejected');
    expect(sender.cancels).toEqual(['voice-1']);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])('rejects the sequence number %s', (seq) => {
    const { relay, sender } = build();
    expect(relay.accept(chunk({ seq, final: false })).status).toBe('rejected');
    expect(sender.frames).toEqual([]);
  });

  it('sends nothing for a recording with no audio in it', () => {
    const { relay, sender } = build();
    expect(relay.accept({ ...chunk({ seq: 0, final: false }), base64: '' })).toEqual({ status: 'skipped' });
    expect(relay.accept({ ...chunk({ seq: 1, final: true }), base64: '' })).toEqual({ status: 'rejected', reason: 'empty' });
    expect(sender.frames).toEqual([]);
    expect(sender.cancels).toEqual([]);
  });
});

describe('AudioRelay: an unreachable backend', () => {
  it('forwards nothing, says so once in plain text, and drops the recording rather than queueing it', () => {
    const { relay, sender, notices } = build();
    sender.reachable = false;

    expect(relay.accept(chunk({ bytes: [1], seq: 0, final: false }))).toEqual({ status: 'unavailable' });

    expect(notices).toEqual([AUDIO_BACKEND_UNAVAILABLE_TEXT]);
    expect(AUDIO_BACKEND_UNAVAILABLE_TEXT).toContain('You can type the same request.');
    expect(sender.frames).toEqual([]);

    // Back online: the rest of the old recording is gone; only a new recording is sent.
    sender.reachable = true;
    expect(relay.accept(chunk({ bytes: [2], seq: 1, final: true })).status).toBe('rejected');
    relay.accept(chunk({ clipId: 'next', bytes: [3], seq: 0, final: true }));
    expect(sender.frames).toHaveLength(1);
    expect(bytesOf(sender.frames[0]!)).toEqual([3]);
  });

  it('handles a disconnect part-way: the first chunks went out, the next is dropped and reported once', () => {
    const { relay, sender, notices } = build();
    relay.accept(chunk({ bytes: [1], seq: 0, final: false }));
    sender.reachable = false;

    expect(relay.accept(chunk({ bytes: [2], seq: 1, final: false }))).toEqual({ status: 'unavailable' });
    expect(relay.accept(chunk({ bytes: [3], seq: 2, final: true })).status).toBe('rejected');

    expect(notices).toEqual([AUDIO_BACKEND_UNAVAILABLE_TEXT]);
    expect(sender.frames).toHaveLength(1);
  });

  it('survives a notice observer that throws', () => {
    const sender = new FakeSender();
    sender.reachable = false;
    const relay = new AudioRelay(sender, () => { throw new Error('ui bug'); });
    expect(relay.accept(chunk()).status).toBe('unavailable');
  });

  it('survives a sender that throws', () => {
    const sender: AudioClipSender = {
      sendAudioClip: () => { throw new Error('socket exploded'); },
      cancelAudioClip: () => { throw new Error('socket exploded'); },
    };
    const relay = new AudioRelay(sender);
    expect(relay.accept(chunk()).status).toBe('rejected');
    expect(() => relay.reset()).not.toThrow();
  });
});

describe('AudioRelay (property)', () => {
  const split = (bytes: number[], cuts: number[]): number[][] => {
    const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
    const parts: number[][] = [];
    let from = 0;
    for (const point of [...points, bytes.length]) {
      parts.push(bytes.slice(from, point));
      from = point;
    }
    return parts;
  };

  it('forwards any split of any recording in order, so the frames rejoin to exactly the original bytes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 400 }),
        fc.array(fc.nat({ max: 400 }), { maxLength: 8 }),
        (bytes, cuts) => {
          const { relay, sender } = build();
          const parts = split(bytes, cuts);
          parts.forEach((part, seq) => {
            relay.accept({ ...chunk({ seq, final: seq === parts.length - 1 }), base64: b64(part) });
            // Whatever has been received so far has already been forwarded.
            expect(sender.frames.flatMap(bytesOf)).toEqual(parts.slice(0, seq + 1).flat());
          });
          expect(sender.frames.flatMap(bytesOf)).toEqual(bytes);
          expect(sender.frames.map((frame) => frame.seq)).toEqual(sender.frames.map((_, index) => index));
          expect(sender.frames.map((frame) => frame.final)).toEqual(sender.frames.map((_, index) => index === sender.frames.length - 1));
          expect(new Set(sender.frames.map((frame) => frame.id)).size).toBe(1);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('negative control: chunks delivered in reverse order never reach the backend out of order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 4, maxLength: 100 }),
        (bytes) => {
          const { relay, sender } = build();
          const parts = split(bytes, [1, 2, 3]);
          const shuffled = [...parts.keys()].reverse();
          shuffled.forEach((seq) => {
            relay.accept({ ...chunk({ seq, final: seq === parts.length - 1 }), base64: b64(parts[seq]!) });
          });
          // Only chunk 0, which arrives last and legitimately starts a recording, may go out.
          expect(sender.frames.length).toBeLessThanOrEqual(1);
          if (sender.frames.length === 1) {
            expect(bytesOf(sender.frames[0]!)).toEqual(parts[0]);
            expect(sender.frames[0]).toMatchObject({ seq: 0, final: false });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never throws, and everything it forwards is well formed and in contiguous order', () => {
    const anyChunk = fc.record({
      clipId: fc.string({ maxLength: 8 }),
      mimeType: fc.oneof(fc.constant('audio/webm'), fc.string({ maxLength: 20 })),
      base64: fc.oneof(fc.string({ maxLength: 40 }), fc.uint8Array({ maxLength: 30 }).map((bytes) => b64(bytes))),
      seq: fc.option(fc.integer({ min: -2, max: 6 }), { nil: undefined }),
      final: fc.option(fc.boolean(), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(anyChunk, { maxLength: 20 }), (chunks) => {
        const { relay, sender } = build();
        let relayedCount = 0;
        for (const item of chunks) {
          if (relay.accept(item as AudioChunk).status === 'relayed') relayedCount += 1;
        }
        expect(sender.frames).toHaveLength(relayedCount);
        const expectedSeq = new Map<string, number>();
        for (const frame of sender.frames) {
          expect(frame.base64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
          expect(frame.mimeType).toMatch(/^audio\//);
          // Within one backend recording, seq is contiguous from 0; nothing follows a final frame.
          const next = expectedSeq.get(frame.id) ?? 0;
          expect(frame.seq).toBe(next);
          expectedSeq.set(frame.id, frame.final ? Number.POSITIVE_INFINITY : next + 1);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('AudioRelay source', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/voice/audioRelay.ts'), 'utf8');

  it('holds no credential and logs nothing', () => {
    expect(source).not.toMatch(/api[_-]?key|token|secret|password|Bearer|process\.env|console\.|logger/i);
  });

  it('has no timer, buffer or retry: a chunk is sent now or not at all', () => {
    expect(source).not.toMatch(/setTimeout|setInterval|scheduler|retry|queue\.push|Buffer\.concat|parts\.push/i);
  });
});
