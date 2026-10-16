import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildStack, flush, watchUnhandledRejections, type Stack } from './ttsHarness';

/**
 * Task 9.6, group 3: INTERRUPTION AND CANCELLATION (Req 6.10, 9.4, 9.5, 15.3).
 *
 * The user interrupts through the real panel message (`interrupt`, what Escape posts), through
 * push-to-talk, or by submitting a new utterance. Everything downstream is production code: the
 * pipeline and its RequestTracker, the SpeechController, the gateway, the BackendClient and the
 * voice stack. What the backend receives is read from the fake socket's frames; what the webview
 * receives is read from the mock webview.
 *
 * Defects these would catch: a stop_audio sent when nothing plays (or not sent when something
 * does); a cancel aimed at the wrong id or at newer work; a late reply showing up as the current
 * answer or starting playback; an interruption reported as a speech failure; an interruption
 * touching the Transcript; push-to-talk cancelling its own recording; an unhandled rejection.
 */
const unhandled = watchUnhandledRejections();
beforeEach(() => unhandled.start());
afterEach(() => expect(unhandled.finish()).toEqual([]));

const ANSWER = 'There are two errors in auth.ts.';

const types = (s: Stack): string[] => s.posted().map((m) => m.type);
const count = (s: Stack, type: string): number => types(s).filter((t) => t === type).length;
const cancelTargets = (s: Stack): unknown[] => s.frames('cancel').map((f) => f.targetId);

async function speaking() {
  const s = await buildStack();
  s.pipeline.announce(ANSWER);
  s.speakLatest(); // speech-1 requested
  return s;
}

describe('each phase of a spoken answer', () => {
  it('before synthesis completes: cancels that speech request only, sends no stop, drops the late audio', async () => {
    const s = await speaking();
    const entries = JSON.stringify(s.transcript.getEntries());

    await s.escape();
    s.audio('speech-1'); // arrives after the interruption
    s.scheduler.advance(60_000);

    expect(cancelTargets(s)).toEqual(['speech-1']);
    expect(count(s, 'stop_audio')).toBe(0);
    expect(count(s, 'play_audio')).toBe(0);
    expect(s.notices()).toEqual([]);
    expect(JSON.stringify(s.transcript.getEntries())).toBe(entries);
    expect(s.scheduler.pendingCount).toBe(0);
  });

  it('after the audio was delivered, before it starts: one stop_audio, no backend cancel, no notice', async () => {
    const s = await speaking();
    s.audio('speech-1');
    expect(count(s, 'play_audio')).toBe(1);

    await s.escape();
    await s.escape(); // a held key repeats
    s.scheduler.advance(60_000);

    expect(count(s, 'stop_audio')).toBe(1);
    expect(cancelTargets(s)).toEqual([]);
    expect(s.notices()).toEqual([]);
  });

  it('during playback: one stop_audio, and the clip\'s late acknowledgments change nothing', async () => {
    const s = await speaking();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');

    await s.escape();
    s.speech.handlePlayback('started', 'speech-1');
    s.speech.handlePlayback('ended', 'speech-1');
    s.speech.handlePlayback('failed', 'speech-1');

    expect(count(s, 'stop_audio')).toBe(1);
    expect(s.notices()).toEqual([]);
    expect(s.kirosight().map((e) => e.text)).toEqual([ANSWER]);
  });

  it('after playback finished: nothing to stop and nothing to cancel', async () => {
    const s = await speaking();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');
    s.speech.handlePlayback('ended', 'speech-1');

    await s.escape();

    expect(count(s, 'stop_audio')).toBe(0);
    expect(cancelTargets(s)).toEqual([]);
    expect(s.notices()).toEqual([]);
  });

  it('with nothing spoken at all, Escape sends nothing to the backend or the webview', async () => {
    const s = await buildStack();
    const postedBefore = s.posted().length;

    await s.escape();

    expect(s.frames('cancel')).toEqual([]);
    expect(s.posted().slice(postedBefore).filter((m) => m.type === 'stop_audio' || m.type === 'play_audio')).toEqual([]);
  });

  it('stop_audio is the validated bridge message and nothing else is sent with it', async () => {
    const s = await speaking();
    s.audio('speech-1');
    const mark = s.posted().length;

    await s.escape();

    const sent = s.posted().slice(mark);
    expect(sent.filter((m) => m.type === 'stop_audio')).toEqual([{ type: 'stop_audio' }]);
    expect(sent.some((m) => m.type === 'focus_input')).toBe(false); // focus is never moved
  });
});

describe('races, decided deterministically', () => {
  it('audio then Escape in the same tick: played, then stopped', async () => {
    const s = await speaking();

    s.audio('speech-1');
    await s.escape();

    expect(s.events.filter((e) => e.startsWith('play_audio') || e === 'stop_audio')).toEqual(['play_audio:speech-1', 'stop_audio']);
  });

  it('Escape then audio in the same tick: the audio is dropped and never played', async () => {
    const s = await speaking();

    await s.escape();
    s.audio('speech-1');

    expect(s.events.filter((e) => e.startsWith('play_audio') || e === 'stop_audio')).toEqual([]);
    expect(cancelTargets(s)).toEqual(['speech-1']);
  });

  it('Escape at 9,999 ms means no notice; Escape after the deadline leaves the genuine notice alone', async () => {
    const early = await speaking();
    early.audio('speech-1');
    early.scheduler.advance(9_999);
    await early.escape();
    early.scheduler.advance(60_000);
    expect(early.notices()).toEqual([]);

    const late = await speaking();
    late.audio('speech-1');
    late.scheduler.advance(10_000);
    expect(late.notices()).toHaveLength(1);
    await late.escape();
    expect(late.notices()).toHaveLength(1); // the interruption neither adds nor removes it
    expect(count(late, 'stop_audio')).toBe(1); // the panel may still play it, so it is stopped
  });

  it('a started acknowledgment that loses the race with Escape does not restart the clip', async () => {
    const s = await speaking();
    s.audio('speech-1');

    await s.escape();
    s.speech.handlePlayback('started', 'speech-1');
    s.scheduler.advance(60_000);
    await s.escape();

    expect(count(s, 'stop_audio')).toBe(1);
    expect(s.notices()).toEqual([]);
  });

  it('an agent answer and Escape in the same tick: the answer is dropped and no stray cancel is sent', async () => {
    const s = await buildStack();
    const pending = s.pipeline.handle('explain this error', 'typed');
    await flush();
    const id = s.frames('agent_request')[0]!.id as string;

    s.agentAnswer(id, 'A late answer');
    await s.escape();
    await pending;

    expect(s.kirosight()).toEqual([]);
    expect(s.frames('speech_request')).toEqual([]);
    expect(cancelTargets(s)).toEqual([]); // the request had already been answered; there was nothing to cancel
  });
});

describe('agent requests, the RequestTracker lane and request ids', () => {
  it('Escape cancels the in-flight agent_request by its own id, bumps the lane, and drops the late answer', async () => {
    const s = await buildStack();
    const pending = s.pipeline.handle('explain this error', 'typed');
    await flush();
    const id = s.frames('agent_request')[0]!.id as string;
    const lane = s.tracker.current();
    expect(id).toBe(`req-${lane}`);

    await s.escape();

    expect(s.tracker.current()).toBeGreaterThan(lane);
    expect(s.tracker.isCurrent(lane)).toBe(false);
    expect(cancelTargets(s)).toEqual([id]);
    await expect(pending).resolves.toBe('handled'); // ends at once; does not wait for the backend

    s.agentAnswer(id, 'a late answer');
    await flush();
    expect(s.kirosight()).toEqual([]);
    expect(s.frames('speech_request')).toEqual([]);
  });

  it('requests made after the interruption are current and answered; the old id is never reused', async () => {
    const s = await buildStack();
    const first = s.pipeline.handle('explain this error', 'typed');
    await flush();
    const oldId = s.frames('agent_request')[0]!.id as string;
    await s.escape();
    await first;

    const second = s.pipeline.handle('why is this function slow', 'typed');
    await flush();
    const newId = s.frames('agent_request')[1]!.id as string;
    expect(newId).not.toBe(oldId);
    s.agentAnswer(oldId, 'stale');
    s.agentAnswer(newId, 'fresh');
    await second;

    expect(s.kirosight().map((e) => e.text)).toEqual(['fresh']);
    expect(cancelTargets(s)).toEqual([oldId]); // the newer request was never cancelled
  });

  it('a new utterance cancels only the older request and supersedes it; the newer one is answered', async () => {
    const s = await buildStack();
    const first = s.pipeline.handle('explain this error', 'typed');
    await flush();
    const second = s.pipeline.handle('why is this function slow', 'typed');
    await flush();
    const [a, b] = s.frames('agent_request').map((f) => f.id as string);

    expect(cancelTargets(s)).toEqual([a]);
    s.agentAnswer(a!, 'old');
    s.agentAnswer(b!, 'new');
    await Promise.all([first, second]);

    expect(s.kirosight().map((e) => e.text)).toEqual(['new']);
  });

  it('a new utterance also stops speech, and the answer to it can be spoken afterwards', async () => {
    const s = await speaking();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');

    await s.submitTyped('where am I');
    s.speakLatest();
    s.audio('speech-2');

    expect(count(s, 'stop_audio')).toBe(1);
    expect(s.frames('speech_request').map((f) => f.id)).toEqual(['speech-1', 'speech-2']);
    expect(s.posted().filter((m) => m.type === 'play_audio').map((m) => m.id)).toEqual(['speech-1', 'speech-2']);
    expect(s.notices()).toEqual([]);
  });
});

describe('push-to-talk and audio_clip', () => {
  const press = (s: Stack) => s.panel.receive({ type: 'ptt_toggle' });

  it('starting push-to-talk stops speech, starts a recording, and does not cancel it', async () => {
    const s = await speaking();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');

    await press(s);
    await flush();

    expect(count(s, 'stop_audio')).toBe(1);
    expect(s.frames('record_start').map((f) => f.id)).toEqual(['rec-1']);
    expect(cancelTargets(s)).toEqual([]); // the new recording was not cancelled
    expect(s.wiring.controller.status.phase).toBe('listening');
    expect(s.notices()).toEqual([]);
  });

  it('Escape while recording cancels that audio_clip by its id, and its late result is ignored', async () => {
    const s = await buildStack();
    await press(s);
    await flush();

    await s.escape();
    await flush();
    s.socket.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'where am I' });
    await flush();

    expect(cancelTargets(s)).toEqual(['rec-1']);
    expect(s.wiring.controller.status.phase).toBe('idle');
    expect(s.transcript.getEntries().filter((e) => e.source === 'voice')).toEqual([]);
  });

  it('repeated presses each start a fresh recording; a finished one is handled as a voice utterance', async () => {
    const s = await buildStack();

    await press(s); await flush(); // rec-1 starts
    const stopping = press(s); // rec-1 stops; this press waits for the transcription
    await flush();
    s.socket.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'where am I' });
    await stopping;
    await flush();
    await press(s); await flush(); // rec-2 starts

    expect(s.frames('record_start').map((f) => f.id)).toEqual(['rec-1', 'rec-2']);
    expect(s.frames('record_stop').map((f) => f.id)).toEqual(['rec-1']);
    expect(cancelTargets(s)).toEqual([]);
    expect(s.transcript.getEntries().find((e) => e.role === 'user')).toMatchObject({ text: 'where am I', source: 'voice' });
    expect(s.wiring.controller.status.phase).toBe('listening');
  });

  it('typed input still works while recording (and deliberately replaces the recording)', async () => {
    const s = await buildStack();
    await press(s);
    await flush();

    await expect(s.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');

    expect(s.kirosight()).toHaveLength(1);
    expect(cancelTargets(s)).toEqual(['rec-1']);
  });
});

describe('disconnections and a closed panel', () => {
  it('Escape with the backend gone is safe: no throw, no unhandled rejection, no notice', async () => {
    const s = await speaking();
    s.audio('speech-1');
    s.socket.triggerClose();

    await expect(s.escape()).resolves.toBeUndefined();
    s.scheduler.advance(60_000);

    expect(count(s, 'stop_audio')).toBe(1); // the panel is still there to be told
    expect(s.kirosight().map((e) => e.text)).toEqual([ANSWER]);
  });

  it('interrupting with the panel closed is safe, and the answer stays in the Transcript', async () => {
    const s = await speaking();
    s.audio('speech-1');
    s.panel.dispose();

    expect(() => s.pipeline.interrupt()).not.toThrow();
    expect(() => s.speech.stopSpeaking()).not.toThrow();
    s.scheduler.advance(60_000);

    expect(s.kirosight().map((e) => e.text)).toEqual([ANSWER]);
  });
});

describe('property: any mix of speech events and interruptions keeps the invariants', () => {
  type Op = 'answer' | 'audio' | 'started' | 'ended' | 'escape' | 'typed' | 'tick';
  const opsArb = fc.array(fc.constantFrom<Op>('answer', 'audio', 'started', 'ended', 'escape', 'typed', 'tick'), { maxLength: 24 });

  it('holds for random sequences', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const s = await buildStack();
        let previous = JSON.stringify([]);
        let answers = 0;
        const latestId = (): string | undefined => s.frames('speech_request').at(-1)?.id as string | undefined;

        for (const op of ops) {
          const noticesBefore = s.notices().length;
          const id = latestId();
          if (op === 'answer') { answers += 1; s.pipeline.announce(`Answer number ${answers}.`); s.speakLatest(); }
          else if (op === 'audio' && id !== undefined) s.audio(id);
          else if (op === 'started' && id !== undefined) s.speech.handlePlayback('started', id);
          else if (op === 'ended' && id !== undefined) s.speech.handlePlayback('ended', id);
          else if (op === 'escape') {
            await s.escape();
            expect(s.notices().length).toBe(noticesBefore); // an interruption is never a speech failure
          } else if (op === 'typed') await s.submitTyped('where am I');
          else if (op === 'tick') s.scheduler.advance(4_000);
          await flush();

          // The Transcript only ever grows: nothing earlier is changed, shortened or removed.
          const now = JSON.stringify(s.transcript.getEntries());
          expect(now.startsWith(previous.slice(0, -1))).toBe(true);
          previous = now;
        }

        expect(count(s, 'stop_audio')).toBeLessThanOrEqual(count(s, 'play_audio'));
        expect(s.notices().length).toBeLessThanOrEqual(s.frames('speech_request').length);
        expect(count(s, 'focus_input')).toBe(0);
        expect(s.executed).toEqual([]);
        const requested = new Set(s.frames('speech_request').map((f) => f.id));
        for (const target of cancelTargets(s)) expect(requested.has(target as string)).toBe(true);
        const answered = s.kirosight().map((e) => e.text).filter((t) => t.startsWith('Answer number'));
        expect(answered).toHaveLength(answers);
      }),
      { numRuns: 40 },
    );
  });
});
