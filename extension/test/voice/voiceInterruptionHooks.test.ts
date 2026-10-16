import { describe, expect, it } from 'vitest';

import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { StartOutcome, VoiceOutcome, VoiceStatus } from '../../src/voice/voiceController';
import { VoiceSession, type VoiceControllerPort } from '../../src/voice/voiceSession';
import { FakeScheduler } from '../mocks/fakeScheduler';

/**
 * Task 9.5: starting push-to-talk is an interruption. VoiceSession calls `onBeforeListening` just
 * before a recording starts, so spoken output stops before the microphone opens.
 */
const CAPS: Capabilities = { bedrock: true, stt: true, tts: true, mic: 'available' };

function status(phase: VoiceStatus['phase'], extra: Partial<VoiceStatus> = {}): VoiceStatus {
  return {
    phase, kind: null, micState: 'granted', cause: null, webviewUnreliable: false, text: phase, ...extra,
  } as VoiceStatus;
}

function build(options: { hook?: () => void; start?: StartOutcome } = {}) {
  const calls: string[] = [];
  const state = { current: status('idle') };
  const controller: VoiceControllerPort = {
    get status() { return state.current; },
    initialize: async () => state.current,
    startListening: async (): Promise<StartOutcome> => {
      calls.push('startListening');
      const outcome = options.start ?? { status: 'listening' };
      if (outcome.status === 'listening') state.current = status('listening');
      return outcome;
    },
    stopListening: async (): Promise<VoiceOutcome> => {
      calls.push('stopListening');
      state.current = status('idle');
      return { status: 'routed' } as VoiceOutcome;
    },
    cancel: () => { calls.push('cancel'); },
    onStatus: () => ({ dispose: () => undefined }),
    onCapReached: () => ({ dispose: () => undefined }),
  };
  const session = new VoiceSession({
    controller,
    transcript: new TranscriptStore(),
    getCapabilities: () => CAPS,
    scheduler: new FakeScheduler(),
    onBeforeListening: () => { calls.push('interrupt'); options.hook?.(); },
  });
  return { session, calls, state };
}

describe('push-to-talk start interrupts first', () => {
  it('interrupts before the recording starts, and not when the recording stops', async () => {
    const { session, calls } = build();

    await session.togglePushToTalk(); // start
    await session.togglePushToTalk(); // stop

    expect(calls).toEqual(['interrupt', 'startListening', 'stopListening']);
  });

  it('interrupts again on every new start', async () => {
    const { session, calls } = build();

    for (let press = 0; press < 2; press += 1) {
      await session.togglePushToTalk();
      await session.togglePushToTalk();
    }

    expect(calls.filter((c) => c === 'interrupt')).toHaveLength(2);
  });

  it('a hook that throws never keeps the user from speaking', async () => {
    const { session, calls } = build({ hook: () => { throw new Error('interrupt failed'); } });

    await expect(session.togglePushToTalk()).resolves.toBeUndefined();

    expect(calls).toEqual(['interrupt', 'startListening']);
  });

  it('interrupts when activation starts listening, but not when voice is unavailable', async () => {
    const started = build();
    await started.session.activate(() => undefined);
    expect(started.calls).toEqual(['interrupt', 'startListening']);

    const unavailable = build();
    unavailable.state.current = status('unavailable', { cause: 'no_input' as never });
    await unavailable.session.togglePushToTalk();
    expect(unavailable.calls.filter((c) => c === 'interrupt' || c === 'startListening')).toEqual([]);
  });

  it('works without any hook', async () => {
    const calls: string[] = [];
    const state = { current: status('idle') };
    const session = new VoiceSession({
      controller: {
        get status() { return state.current; },
        initialize: async () => state.current,
        startListening: async () => { calls.push('startListening'); return { status: 'listening' } as StartOutcome; },
        stopListening: async () => ({ status: 'routed' } as VoiceOutcome),
        cancel: () => undefined,
        onStatus: () => ({ dispose: () => undefined }),
        onCapReached: () => ({ dispose: () => undefined }),
      },
      transcript: new TranscriptStore(),
      getCapabilities: () => CAPS,
      scheduler: new FakeScheduler(),
    });

    await session.togglePushToTalk();

    expect(calls).toEqual(['startListening']);
  });
});
