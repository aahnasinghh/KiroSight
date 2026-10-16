import { describe, expect, it } from 'vitest';

import { InputPipeline } from '../../src/pipeline/inputPipeline';
import { RequestTracker } from '../../src/pipeline/requestTracker';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { VoiceController } from '../../src/voice/voiceController';
import {
  MAX_VOICE_DURATION_MS,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import { VoiceSession } from '../../src/voice/voiceSession';
import { FakeScheduler } from '../mocks/fakeScheduler';

/**
 * Task 9.5 safety review: the wiring Task 9.7 will use, built only from injected dependencies.
 *
 *   VoiceSession.onBeforeListening  ->  pipeline.interrupt()
 *   pipeline interruption port      ->  { stopSpeaking, cancelVoiceInput: session.cancel }
 *
 * `cancelVoiceInput` is reachable only from a TYPED utterance reaching `handle()`. `interrupt()`
 * never calls it, so starting push-to-talk cannot cancel the recording it is about to start.
 */
const CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

class FakeInput implements VoiceInput {
  public readonly kind: VoiceKind = 'backend_local';
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;
  public availability: VoiceAvailability = { ok: true };
  public startCalls = 0;
  public stopCalls = 0;
  public cancelCalls = 0;

  public async available(): Promise<VoiceAvailability> { return this.availability; }
  public async start(): Promise<void> { this.startCalls += 1; }
  public async stop(): Promise<{ backendClipId: string }> {
    this.stopCalls += 1;
    return { backendClipId: `clip-${this.stopCalls}` };
  }
  public cancel(): void { this.cancelCalls += 1; }
}

class FakeTranscriber implements VoiceTranscriber {
  public calls = 0;
  public transcribe(): Promise<TranscriptionOutcome> {
    this.calls += 1;
    return Promise.resolve({ ok: true, text: 'where am I' });
  }
  public cancel(): void { /* nothing is ever waiting */ }
}

async function build() {
  const input = new FakeInput();
  const transcriber = new FakeTranscriber();
  const transcript = new TranscriptStore();
  const events: string[] = [];
  const counts = { speechStops: 0, voiceCancels: 0, interrupts: 0, local: [] as string[] };
  const ref: { session?: VoiceSession } = {};
  const tracker = new RequestTracker();

  const pipeline = new InputPipeline({
    transcript,
    tracker,
    localIntents: { handleIntent: async (intent) => { counts.local.push(intent.kind); return `did ${intent.kind}`; } },
    interruption: {
      stopSpeaking: () => { counts.speechStops += 1; events.push('stopSpeaking'); },
      cancelVoiceInput: () => { counts.voiceCancels += 1; events.push('cancelVoiceInput'); ref.session?.cancel(); },
    },
  });
  const controller = new VoiceController({
    inputs: { backend_local: input },
    transcriber,
    pipeline: { handle: (text, source) => pipeline.handle(text, source) },
    scheduler: new FakeScheduler(),
  });
  const session = new VoiceSession({
    controller,
    transcript,
    getCapabilities: () => CAPS,
    scheduler: new FakeScheduler(),
    // Exactly what Task 9.7 will pass: push-to-talk start is the pipeline's interruption.
    onBeforeListening: () => { counts.interrupts += 1; events.push('interrupt'); pipeline.interrupt(); },
  });
  ref.session = session;
  await session.initialize();
  return { input, transcriber, transcript, session, controller, pipeline, tracker, counts, events };
}

const answers = (transcript: TranscriptStore): string[] =>
  transcript.getEntries().filter((e) => e.role === 'kirosight').map((e) => e.text);

describe('push-to-talk start, wired to the pipeline interruption', () => {
  it('interrupts previous speech and starts a recording that is not cancelled', async () => {
    const h = await build();

    await h.session.togglePushToTalk();
    await flush();

    expect(h.events).toEqual(['interrupt', 'stopSpeaking']); // speech stopped before listening
    expect(h.counts.voiceCancels).toBe(0); // the voice-cancel path was never reached
    expect(h.input.startCalls).toBe(1);
    expect(h.input.cancelCalls).toBe(0);
    expect(h.controller.status.phase).toBe('listening');
    expect(h.session.view.listening).toBe(true);
  });

  it('the recording finishes normally and its text is handled as a spoken utterance', async () => {
    const h = await build();
    await h.session.togglePushToTalk();

    await h.session.togglePushToTalk(); // stop
    await flush();

    expect(h.transcriber.calls).toBe(1);
    expect(answers(h.transcript)).toEqual(['did WHERE_AM_I']);
    expect(h.transcript.getEntries().find((e) => e.role === 'user')).toMatchObject({ text: 'where am I', source: 'voice' });
    expect(h.counts.voiceCancels).toBe(0); // a spoken utterance never cancels its own recording
    expect(h.controller.status.phase).toBe('idle');
  });

  it('repeated push-to-talk interactions each interrupt, start and finish cleanly', async () => {
    const h = await build();

    for (let round = 1; round <= 3; round += 1) {
      await h.session.togglePushToTalk();
      expect(h.controller.status.phase).toBe('listening');
      expect(h.counts.voiceCancels).toBe(0);
      await h.session.togglePushToTalk();
      await flush();
      expect(h.controller.status.phase).toBe('idle');
      expect(h.input.startCalls).toBe(round);
    }

    expect(h.counts.interrupts).toBe(3);
    expect(h.counts.voiceCancels).toBe(0);
    expect(answers(h.transcript)).toHaveLength(3);
  });

  it('bumps the request lane, so earlier work is superseded, without cancelling the recording', async () => {
    const h = await build();
    const lane = h.tracker.current();

    await h.session.togglePushToTalk();

    expect(h.tracker.current()).toBeGreaterThan(lane);
    expect(h.controller.status.phase).toBe('listening');
    expect(h.input.cancelCalls).toBe(0);
  });
});

describe('typed input with the same wiring', () => {
  it('works while idle, and stops speech', async () => {
    const h = await build();

    await expect(h.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');

    expect(answers(h.transcript)).toEqual(['did WHERE_AM_I']);
    expect(h.counts.speechStops).toBe(1);
  });

  it('a typed utterance during a recording deliberately cancels it (a new utterance), and push-to-talk still works after', async () => {
    const h = await build();
    await h.session.togglePushToTalk();
    expect(h.controller.status.phase).toBe('listening');

    await h.pipeline.handle('where am I', 'typed');
    await flush();

    expect(h.counts.voiceCancels).toBe(1);
    expect(h.input.cancelCalls).toBeGreaterThan(0);
    expect(h.controller.status.phase).toBe('idle');
    expect(h.transcriber.calls).toBe(0); // the cancelled recording was never transcribed

    await h.session.togglePushToTalk(); // a fresh recording starts normally
    expect(h.controller.status.phase).toBe('listening');
    expect(h.input.startCalls).toBe(2);
  });
});
