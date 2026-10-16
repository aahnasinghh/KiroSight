import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PLAYBACK_START_TIMEOUT_MS,
  SPEECH_UNAVAILABLE_TEXT,
} from '../../src/voice/speechController';
import { buildStack, watchUnhandledRejections } from './ttsHarness';

/**
 * Task 9.6, group 2: THE 10-SECOND PLAYBACK DEADLINE (Req 6.9, 9.5, 10.2, 15.3).
 *
 * Real SpeechController, BackendClient and WebviewProvider on a fake clock. The clock moves only
 * when a test moves it, so 9,999 ms and 10,000 ms are exact.
 *
 * Defects these would catch: audio arriving being mistaken for playback starting; a deadline that
 * is off by one; a late `started` bringing an expired request back (and its stale `ended` later
 * adding noise); two notices for one failure; a notice that never reaches the webview as text;
 * the answer being touched when the notice is added.
 */
const unhandled = watchUnhandledRejections();
beforeEach(() => unhandled.start());
afterEach(() => expect(unhandled.finish()).toEqual([]));

const ANSWER = 'There are two errors in auth.ts.';

async function spokenAnswer() {
  const s = await buildStack();
  s.pipeline.announce(ANSWER);
  s.speakLatest();
  return s;
}

describe('the deadline is exactly 10 s from the request', () => {
  it('registers one timer of 10,000 ms; nothing at 9,999 ms; one notice at 10,000 ms', async () => {
    const s = await spokenAnswer();
    expect(PLAYBACK_START_TIMEOUT_MS).toBe(10_000);
    expect(s.scheduler.pendingDelays).toEqual([10_000]);

    s.scheduler.advance(9_999);
    expect(s.notices()).toEqual([]);

    s.scheduler.advance(1);
    expect(s.notices()).toHaveLength(1);
    expect(s.scheduler.pendingCount).toBe(0);
  });

  it('the notice is a separate entry, added at the moment of detection, and the answer stays whole', async () => {
    const s = await spokenAnswer();
    const answer = s.kirosight()[0]!;

    s.scheduler.advance(10_000);

    const entries = s.transcript.getEntries();
    expect(entries[0]).toEqual(answer);
    expect(entries[0]!.text).toBe(ANSWER);
    expect(entries.at(-1)).toMatchObject({ role: 'system', text: SPEECH_UNAVAILABLE_TEXT });
    // Detection and notice are the same step of the clock (well inside the 1 s allowed).
    expect(s.scheduler.now).toBe(10_000);
  });

  it('the notice reaches the webview as plain text in the next view update', async () => {
    const s = await spokenAnswer();

    s.scheduler.advance(10_000);

    const views = s.posted().filter((m) => m.type === 'view_state') as unknown as Array<{ transcript: Array<{ text: string }> }>;
    const last = views.at(-1)!;
    expect(last.transcript.map((e) => e.text)).toEqual([ANSWER, SPEECH_UNAVAILABLE_TEXT]);
    expect(SPEECH_UNAVAILABLE_TEXT).toMatch(/response is in the transcript/i); // says where the answer is
  });
});

describe('only a real start counts', () => {
  it('receiving speech_audio is not playback starting: the deadline still fires', async () => {
    const s = await spokenAnswer();

    s.scheduler.advance(2_000);
    s.audio('speech-1');
    expect(s.posted().filter((m) => m.type === 'play_audio')).toHaveLength(1);
    s.scheduler.advance(7_999);
    expect(s.notices()).toEqual([]);
    s.scheduler.advance(1);

    expect(s.notices()).toHaveLength(1);
  });

  it('a started acknowledgment at 9,999 ms clears the deadline for good', async () => {
    const s = await spokenAnswer();
    s.audio('speech-1');
    s.scheduler.advance(9_999);

    s.speech.handlePlayback('started', 'speech-1');
    s.scheduler.advance(60_000);

    expect(s.notices()).toEqual([]);
    expect(s.scheduler.pendingCount).toBe(0);
  });

  it('a started acknowledgment for a different id does not clear this request', async () => {
    const s = await spokenAnswer();
    s.audio('speech-1');

    s.speech.handlePlayback('started', 'speech-2');
    s.speech.handlePlayback('started', 'speech-1 ');
    s.scheduler.advance(10_000);

    expect(s.notices()).toHaveLength(1);
  });

  it('a late started does not revive an expired request, and its later acknowledgments add nothing', async () => {
    const s = await spokenAnswer();
    s.audio('speech-1');
    s.scheduler.advance(10_000);
    expect(s.notices()).toHaveLength(1);

    s.speech.handlePlayback('started', 'speech-1');
    s.speech.handlePlayback('ended', 'speech-1');
    s.speech.handlePlayback('failed', 'speech-1');
    s.scheduler.advance(60_000);

    expect(s.notices()).toHaveLength(1);
    expect(s.kirosight().map((e) => e.text)).toEqual([ANSWER]);
  });
});

describe('one failure, one notice', () => {
  it('a backend error, a repeat of it, a playback failure and the deadline together add exactly one', async () => {
    const s = await spokenAnswer();

    s.backendError('speech-1', 'TTS_UNAVAILABLE');
    s.backendError('speech-1', 'TTS_UNAVAILABLE');
    s.speech.handlePlayback('failed', 'speech-1');
    s.speech.handlePlayback('failed', 'speech-1');
    s.scheduler.advance(30_000);

    expect(s.notices()).toHaveLength(1);
  });

  it('audio that arrives after the deadline is dropped and adds nothing', async () => {
    const s = await spokenAnswer();
    s.scheduler.advance(10_000);

    s.audio('speech-1');

    expect(s.posted().filter((m) => m.type === 'play_audio')).toEqual([]);
    expect(s.notices()).toHaveLength(1);
  });

  it('each request has its own deadline and its own single notice', async () => {
    const s = await buildStack();
    s.pipeline.announce('First answer.');
    s.speakLatest();
    s.scheduler.advance(5_000);
    s.pipeline.announce('Second answer.');
    s.speakLatest();

    s.scheduler.advance(5_000); // t = 10,000: only the first has expired
    expect(s.notices()).toHaveLength(1);
    s.scheduler.advance(4_999);
    expect(s.notices()).toHaveLength(1);
    s.scheduler.advance(1); // t = 15,000
    expect(s.notices()).toHaveLength(2);
    expect(s.kirosight().map((e) => e.text)).toEqual(['First answer.', 'Second answer.']);
  });
});

describe('property: the notice appears if and only if playback did not start before 10 s', () => {
  it('for any audio time and any start time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 14_000 }),
        fc.option(fc.integer({ min: 0, max: 14_000 }), { nil: undefined }),
        async (audioAt, startAt) => {
          const s = await spokenAnswer();
          const timeline: Array<{ at: number; run: () => void }> = [{ at: audioAt, run: () => s.audio('speech-1') }];
          if (startAt !== undefined) {
            timeline.push({ at: startAt, run: () => s.speech.handlePlayback('started', 'speech-1') });
          }
          timeline.sort((a, b) => a.at - b.at);

          let now = 0;
          for (const step of timeline) {
            s.scheduler.advance(step.at - now);
            now = step.at;
            step.run();
          }
          s.scheduler.advance(30_000);

          // "started" only counts if the clip had been handed over (audio first) and it came in time.
          const playableStart = startAt !== undefined && startAt >= audioAt && startAt < 10_000;
          expect(s.notices()).toHaveLength(playableStart ? 0 : 1);
          expect(s.kirosight().map((e) => e.text)).toEqual([ANSWER]);
        },
      ),
      { numRuns: 60 },
    );
  });
});
