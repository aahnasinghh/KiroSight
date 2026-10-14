import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AudioRelay, type AudioChunk, type AudioClipSender, type AudioFrame } from '../../src/voice/audioRelay';
import { VoiceController } from '../../src/voice/voiceController';
import { MAX_VOICE_DURATION_MS, type TranscriptionOutcome, type VoiceClip, type VoiceTranscriber } from '../../src/voice/voiceInput';
import {
  START_ANSWER_TIMEOUT_MS,
  STOP_ANSWER_TIMEOUT_MS,
  WebviewVoiceInput,
  type WebviewCaptureBridge,
} from '../../src/voice/webviewVoiceInput';
import { FakeScheduler } from '../mocks/fakeScheduler';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeBridge implements WebviewCaptureBridge {
  public open = true;
  public readonly commands: string[] = [];
  public isOpen(): boolean { return this.open; }
  public command(type: 'start_capture' | 'stop_capture'): void { this.commands.push(type); }
  public count(type: string): number { return this.commands.filter((command) => command === type).length; }
}

class FakeSender implements AudioClipSender {
  public readonly frames: AudioFrame[] = [];
  public readonly cancels: string[] = [];
  public reachable = true;
  public sendAudioClip(frame: AudioFrame): boolean {
    if (!this.reachable) return false;
    this.frames.push(frame);
    return true;
  }
  public cancelAudioClip(id: string): boolean {
    if (!this.reachable) return false;
    this.cancels.push(id);
    return true;
  }
}

const part = (bytes: number[], seq: number, final: boolean): AudioChunk =>
  ({ clipId: 'clip-1', mimeType: 'audio/webm', base64: Buffer.from(bytes).toString('base64'), seq, final });
const marker = (seq: number): AudioChunk => ({ clipId: 'clip-1', mimeType: 'audio/webm', base64: '', seq, final: true });

function build() {
  const bridge = new FakeBridge();
  const sender = new FakeSender();
  const scheduler = new FakeScheduler();
  const notices: string[] = [];
  const firstSamples: number[] = [];
  const relay = new AudioRelay(sender, (message) => notices.push(message));
  const input = new WebviewVoiceInput({ bridge, relay, scheduler, onFirstSample: () => firstSamples.push(1) });
  return { bridge, sender, scheduler, notices, firstSamples, input };
}

/** start() answered by a granted microphone. */
async function started() {
  const harness = build();
  const starting = harness.input.start();
  harness.input.handleMicState('granted');
  await starting;
  return harness;
}

describe('WebviewVoiceInput basics', () => {
  it('is the webview kind with the 60 s cap', () => {
    const { input } = build();
    expect(input.kind).toBe('webview');
    expect(input.maxDurationMs).toBe(MAX_VOICE_DURATION_MS);
  });

  it('knows nothing about the microphone until the webview has answered an attempt', async () => {
    const { input } = build();
    expect(await input.available()).toEqual({ ok: false, reason: 'undetermined' });

    input.handleMicState('granted');
    expect(await input.available()).toEqual({ ok: true });
    input.handleMicState('denied');
    expect(await input.available()).toEqual({ ok: false, reason: 'denied' });
    input.handleMicState('unavailable');
    expect(await input.available()).toEqual({ ok: false, reason: 'unavailable' });
    input.handleMicState('prompt');
    expect(await input.available()).toEqual({ ok: false, reason: 'undetermined' });
  });

  it('is unavailable when no panel is open, and asks the panel for nothing', async () => {
    const { input, bridge } = build();
    bridge.open = false;
    input.handleMicState('granted');

    expect(await input.available()).toEqual({ ok: false, reason: 'unavailable' });
    await expect(input.start()).rejects.toThrow('panel is not open');
    expect(bridge.commands).toEqual([]);
  });

  it('records nothing on its own: constructing and asking availability send no command', async () => {
    const { input, bridge } = build();
    await input.available();
    expect(bridge.commands).toEqual([]);
  });
});

describe('start', () => {
  it('asks the panel to record once, and resolves when the panel reports a granted microphone', async () => {
    const { input, bridge } = build();

    const starting = input.start();
    expect(bridge.commands).toEqual(['start_capture']);
    input.handleMicState('granted');

    await expect(starting).resolves.toBeUndefined();
    await expect(input.start()).rejects.toThrow('already in progress');
    expect(bridge.count('start_capture')).toBe(1);
  });

  it.each(['denied', 'unavailable'] as const)('rejects when the panel reports %s, and remembers it', async (state) => {
    const { input, bridge } = build();
    const starting = input.start();

    input.handleMicState(state);

    await expect(starting).rejects.toThrow(state);
    expect(bridge.count('start_capture')).toBe(1);
    expect(await input.available()).toEqual({ ok: false, reason: state === 'denied' ? 'denied' : 'unavailable' });
    // Back to idle: a later attempt (permission granted since) can start again.
    const again = input.start();
    input.handleMicState('granted');
    await expect(again).resolves.toBeUndefined();
  });

  it('keeps waiting while the permission prompt is open', async () => {
    const { input, scheduler } = build();
    let settled = false;
    const starting = input.start().then(() => { settled = true; });

    input.handleMicState('prompt');
    scheduler.advance(START_ANSWER_TIMEOUT_MS - 1);
    await flush();
    expect(settled).toBe(false);

    input.handleMicState('granted');
    await starting;
    expect(settled).toBe(true);
  });

  it('gives up after the answer timeout, tells the panel to stop, and is usable again', async () => {
    const { input, bridge, scheduler } = build();
    const starting = input.start();
    const rejection = expect(starting).rejects.toThrow('did not answer');

    scheduler.advance(START_ANSWER_TIMEOUT_MS);
    await rejection;

    expect(bridge.commands).toEqual(['start_capture', 'stop_capture']);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('audio is accepted only during a capture', () => {
  it('drops chunks that arrive before start, so unrequested audio never reaches the backend', () => {
    const { input, sender, firstSamples } = build();
    input.handleAudioClip(part([1, 2, 3], 0, true));
    expect(sender.frames).toEqual([]);
    expect(firstSamples).toEqual([]);
  });

  it('reports the first non-empty sample exactly once per capture, and not for an empty marker', async () => {
    const { input, firstSamples } = await started();

    input.handleAudioClip({ ...part([], 0, false), base64: '' });
    expect(firstSamples).toEqual([]);
    input.handleAudioClip(part([1, 2, 3], 1, false));
    input.handleAudioClip(part([4, 5, 6], 2, false));

    expect(firstSamples).toEqual([1]);
  });

  it('reports the first sample again for the next capture', async () => {
    const { input, firstSamples } = await started();
    input.handleAudioClip(part([1], 0, false));
    const stopping = input.stop();
    input.handleAudioClip(marker(1));
    await stopping;

    const again = input.start();
    input.handleMicState('granted');
    await again;
    input.handleAudioClip(part([2], 0, false));

    expect(firstSamples).toEqual([1, 1]);
  });
});

describe('stop', () => {
  it('asks the panel to stop and resolves with the id of the clip the relay sent', async () => {
    const { input, bridge, sender } = await started();
    input.handleAudioClip(part([1, 2, 3, 4], 0, false));

    const stopping = input.stop();
    expect(bridge.commands).toEqual(['start_capture', 'stop_capture']);
    input.handleAudioClip(marker(1));

    await expect(stopping).resolves.toEqual({ backendClipId: 'voice-1' });
    expect(sender.frames.map((frame) => [frame.seq, frame.final])).toEqual([[0, false], [1, true]]);
  });

  it('forwards each chunk to the backend while recording, before stop() is called', async () => {
    const { input, sender } = await started();

    input.handleAudioClip(part([1, 2, 3], 0, false));
    expect(sender.frames).toHaveLength(1);
    input.handleAudioClip(part([4, 5], 1, false));
    expect(sender.frames).toHaveLength(2);
    expect(sender.frames.every((frame) => !frame.final)).toBe(true);
  });

  it('a single-chunk recording forwards one final frame and resolves stop()', async () => {
    const { input, sender } = await started();
    const stopping = input.stop();

    input.handleAudioClip(part([7, 7, 7], 0, true));

    await expect(stopping).resolves.toEqual({ backendClipId: 'voice-1' });
    expect(sender.frames).toHaveLength(1);
    expect(sender.frames[0]).toMatchObject({ seq: 0, final: true });
  });

  it('reports a recording whose final chunk arrived before stop() was called', async () => {
    const { input, sender } = await started();
    input.handleAudioClip(part([1, 2], 0, false));
    input.handleAudioClip(marker(1));

    await expect(input.stop()).resolves.toEqual({ backendClipId: 'voice-1' });
    expect(sender.frames).toHaveLength(2);
    await expect(input.stop()).rejects.toThrow('No capture');
  });

  it('cannot stop a capture that was not started', async () => {
    const { input, bridge } = build();
    await expect(input.stop()).rejects.toThrow('No capture');
    expect(bridge.commands).toEqual([]);
  });

  it('times out waiting for the last chunk, tells the panel to stop, and sends nothing', async () => {
    const { input, scheduler, sender, bridge } = await started();
    input.handleAudioClip(part([1], 0, false));
    const stopping = input.stop();
    const rejection = expect(stopping).rejects.toThrow('did not finish');

    scheduler.advance(STOP_ANSWER_TIMEOUT_MS);
    await rejection;

    // The first chunk already went out; the incomplete recording is cancelled at the backend.
    expect(sender.frames).toHaveLength(1);
    expect(sender.cancels).toEqual(['voice-1']);
    expect(bridge.count('stop_capture')).toBe(2);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('rejects when the backend becomes unreachable at the last chunk, and says so once', async () => {
    const { input, sender, notices } = await started();
    input.handleAudioClip(part([1, 2], 0, false));
    const stopping = input.stop();
    const rejection = expect(stopping).rejects.toThrow('unavailable');

    sender.reachable = false;
    input.handleAudioClip(marker(1));
    await rejection;

    expect(notices).toHaveLength(1);
    sender.reachable = true;
    input.handleAudioClip(part([9], 0, true)); // idle again: stray audio is dropped
    expect(sender.frames).toHaveLength(1);
  });

  it('on a backend disconnect mid-capture releases the microphone, drops later audio and fails stop()', async () => {
    const { input, sender, notices, bridge } = await started();
    input.handleAudioClip(part([1, 2], 0, false));
    sender.reachable = false;

    input.handleAudioClip(part([3, 4], 1, false)); // cannot be sent

    expect(notices).toHaveLength(1);
    expect(bridge.count('stop_capture')).toBe(1); // the microphone is released at once
    sender.reachable = true;
    input.handleAudioClip(part([5, 6], 2, false)); // dropped: the capture has failed
    expect(sender.frames).toHaveLength(1);
    await expect(input.stop()).rejects.toThrow('unavailable');
    await expect(input.stop()).rejects.toThrow('No capture'); // idle again
  });

  it('on an oversized chunk mid-capture cancels at the backend, releases the microphone and fails stop()', async () => {
    const { input, sender, bridge } = await started();
    input.handleAudioClip(part([1, 2], 0, false));

    input.handleAudioClip({ ...part([3], 1, false), base64: 'A'.repeat(1_000_004) });

    expect(sender.cancels).toEqual(['voice-1']);
    expect(bridge.count('stop_capture')).toBe(1);
    await expect(input.stop()).rejects.toThrow('not usable');
  });

  it('can start a new capture after a failed one', async () => {
    const { input, sender } = await started();
    sender.reachable = false;
    input.handleAudioClip(part([1], 0, false));
    sender.reachable = true;

    const again = input.start();
    input.handleMicState('granted');
    await again;
    input.handleAudioClip({ ...part([2], 0, false), clipId: 'clip-2' });

    expect(sender.frames).toHaveLength(1);
  });

  it('rejects a recording with no audio', async () => {
    const { input } = await started();
    const stopping = input.stop();
    const rejection = expect(stopping).rejects.toThrow('not usable');
    input.handleAudioClip(marker(0));
    await rejection;
  });

  it('prevents a duplicate submission: the same chunks sent again after the clip went out are dropped', async () => {
    const { input, sender } = await started();
    input.handleAudioClip(part([1, 2, 3], 0, false));
    const stopping = input.stop();
    input.handleAudioClip(marker(1));
    await stopping;

    input.handleAudioClip(part([1, 2, 3], 0, false));
    input.handleAudioClip(marker(1));

    expect(sender.frames).toHaveLength(2); // the original data frame and final marker only
  });
});

describe('cancel and shutdown', () => {
  it('tells the panel to stop recording, discards audio that was in flight, and ignores late chunks', async () => {
    const { input, bridge, sender } = await started();
    input.handleAudioClip(part([1, 2, 3], 0, false));

    input.cancel();
    input.handleAudioClip(marker(1));

    expect(bridge.commands).toEqual(['start_capture', 'stop_capture']);
    expect(sender.frames).toHaveLength(1); // only what was forwarded before the cancel
    expect(sender.cancels).toEqual(['voice-1']); // and the backend is told to discard it
  });

  it('cancel prevents any further forwarding', async () => {
    const { input, sender } = await started();
    input.handleAudioClip(part([1], 0, false));
    input.cancel();

    input.handleAudioClip(part([2], 1, false));
    input.handleAudioClip(part([3], 2, true));

    expect(sender.frames).toHaveLength(1);
  });

  it('is a no-op when idle, and safe to repeat', () => {
    const { input, bridge } = build();
    input.cancel();
    input.cancel();
    expect(bridge.commands).toEqual([]);
  });

  it('rejects a start that is still waiting', async () => {
    const { input } = build();
    const starting = input.start();
    const rejection = expect(starting).rejects.toThrow('cancelled');
    input.cancel();
    await rejection;
  });

  it('rejects a stop that is still waiting, and clears its timer', async () => {
    const { input, scheduler } = await started();
    const stopping = input.stop();
    const rejection = expect(stopping).rejects.toThrow('cancelled');
    input.cancel();
    await rejection;
    expect(scheduler.pendingCount).toBe(0);
  });

  it('a capture after a cancel starts clean and cannot inherit the old audio', async () => {
    const { input, sender } = await started();
    input.handleAudioClip(part([1, 1, 1], 0, false));
    input.cancel();

    const again = input.start();
    input.handleMicState('granted');
    await again;
    input.handleAudioClip(part([2, 2], 0, false));
    const stopping = input.stop();
    input.handleAudioClip(marker(1));
    await stopping;

    // [1,1,1] went out before the cancel (and was cancelled); the new capture is a separate recording.
    expect(sender.cancels).toEqual(['voice-1']);
    expect(sender.frames.map((frame) => frame.id)).toEqual(['voice-1', 'voice-2', 'voice-2']);
    expect([...Buffer.from(sender.frames[1]!.base64, 'base64')]).toEqual([2, 2]);
  });
});

describe('WebviewVoiceInput with the VoiceController', () => {
  class FakeTranscriber implements VoiceTranscriber {
    public readonly clips: VoiceClip[] = [];
    public async transcribe(clip: VoiceClip): Promise<TranscriptionOutcome> {
      this.clips.push(clip);
      return { ok: true, text: 'what errors are there' };
    }
  }

  function wired() {
    const bridge = new FakeBridge();
    const sender = new FakeSender();
    const scheduler = new FakeScheduler();
    const relay = new AudioRelay(sender);
    let controller: VoiceController | null = null;
    const input = new WebviewVoiceInput({ bridge, relay, scheduler, onFirstSample: () => controller?.notifyFirstSample() });
    const transcriber = new FakeTranscriber();
    const handled: Array<[string, string]> = [];
    controller = new VoiceController({
      inputs: { webview: input },
      transcriber,
      pipeline: { handle: async (text, source) => { handled.push([text, source]); } },
      scheduler,
      preferred: 'webview',
    });
    return { bridge, sender, scheduler, input, controller, transcriber, handled };
  }
  const capabilities = { bedrock: false, stt: true, tts: false, mic: 'not_applicable' } as const;

  it('goes from push-to-talk to text through the same pipeline call, with the relayed clip id', async () => {
    const { input, controller, transcriber, handled, sender } = wired();
    await controller.initialize(capabilities);

    const listening = controller.startListening();
    await flush();
    input.handleMicState('granted');
    expect(await listening).toEqual({ status: 'listening' });
    input.handleAudioClip(part([1, 2, 3], 0, false));

    const stopping = controller.stopListening();
    await flush();
    input.handleAudioClip(marker(1));

    expect(await stopping).toEqual({ status: 'routed' });
    expect(sender.frames).toHaveLength(2);
    expect(transcriber.clips).toEqual([{ backendClipId: 'voice-1' }]);
    expect(handled).toEqual([['what errors are there', 'voice']]);
  });

  it('a first chunk inside 5 s satisfies the watchdog, so the capture is not abandoned', async () => {
    const { input, controller, scheduler, bridge } = wired();
    await controller.initialize(capabilities);
    const listening = controller.startListening();
    await flush();
    input.handleMicState('granted');
    await listening;

    scheduler.advance(4_000);
    input.handleAudioClip(part([1], 0, false));
    scheduler.advance(10_000);

    expect(controller.status).toMatchObject({ phase: 'listening', kind: 'webview', webviewUnreliable: false });
    expect(bridge.count('stop_capture')).toBe(0);
  });

  it('no chunk within 5 s marks the webview unreliable and tells the panel to stop recording', async () => {
    const { input, controller, scheduler, bridge } = wired();
    await controller.initialize(capabilities);
    const listening = controller.startListening();
    await flush();
    input.handleMicState('granted');
    await listening;

    scheduler.advance(5_000);

    expect(controller.status.webviewUnreliable).toBe(true);
    expect(bridge.count('stop_capture')).toBe(1);
  });
});

describe('WebviewVoiceInput source', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/voice/webviewVoiceInput.ts'), 'utf8');

  it('holds no credential, makes no network call and logs nothing', () => {
    expect(source).not.toMatch(/api[_-]?key|token|secret|password|Bearer|process\.env|console\.|logger|fetch\(|WebSocket/i);
  });

  it('asks the panel to record in exactly one place: start()', () => {
    expect(source.match(/command\('start_capture'\)/g)).toHaveLength(1);
  });
});
