import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { describeReasoningFailure } from '../../src/response/explanationMessages';
import { SPEECH_UNAVAILABLE_TEXT } from '../../src/voice/speechController';
import { buildStack, flush, watchUnhandledRejections } from './ttsHarness';

/**
 * Task 9.6, group 1: TEXT FIRST (Req 6.3, 9.4).
 *
 * Real pipeline, Transcript, SpeechController, BackendClient (over a fake socket) and WebviewProvider
 * (over the mock webview), joined through their own seams. The event log records, in one sequence,
 * every Transcript append, every `speech_request` the client is asked to send and every
 * `play_audio` posted to the webview, so the order is observed rather than assumed.
 *
 * Defects these would catch: speech requested before the answer is in the Transcript; an answer
 * shortened, delayed or replaced because of speech; a failure that rewrites the answer instead of
 * adding a separate notice; audio handed over under a different id than the request.
 */
const unhandled = watchUnhandledRejections();
beforeEach(() => unhandled.start());
afterEach(() => expect(unhandled.finish()).toEqual([]));

const before = (events: string[], first: string, second: string): boolean => {
  const a = events.indexOf(first);
  const b = events.indexOf(second);
  return a !== -1 && b !== -1 && a < b;
};

describe('the answer is in the Transcript before any speech is requested or played', () => {
  it('local answer: append(kirosight) < speech_request < play_audio, with one id throughout', async () => {
    const s = await buildStack();

    await s.pipeline.handle('where am I', 'typed');
    s.speakLatest();
    s.audio('speech-1');

    expect(s.events).toEqual([
      'append:user', 'append:kirosight', 'speech_request:speech-1', 'play_audio:speech-1',
    ]);
    const request = s.frames('speech_request')[0]!;
    expect(request.id).toBe('speech-1');
    expect(request.text).toBe(s.kirosight()[0]!.text); // the whole answer, as shown
    expect(s.posted().filter((m) => m.type === 'play_audio').map((m) => m.id)).toEqual(['speech-1']);
  });

  it('a long answer is spoken complete and shown complete (nothing is shortened for speech)', async () => {
    const s = await buildStack();
    const long = `${'Line of a long answer. '.repeat(70)}End.`; // about 1,600 characters, under the 2,000 limit

    s.pipeline.announce(long);
    s.speakLatest();

    expect(s.kirosight().map((e) => e.text)).toEqual([long]);
    expect(s.frames('speech_request')[0]!.text).toBe(long);
    expect(before(s.events, 'append:kirosight', 'speech_request:speech-1')).toBe(true);
  });

  it('a backend reasoning error is an ordinary answer: shown first, then spoken', async () => {
    const s = await buildStack();
    const pending = s.pipeline.handle('explain this error', 'typed');
    await flush();
    const agentRequestId = s.frames('agent_request')[0]!.id as string;
    s.backendError(agentRequestId, 'BEDROCK_UNAVAILABLE');
    await pending;
    s.speakLatest();

    const expected = describeReasoningFailure('BEDROCK_UNAVAILABLE', true)!;
    expect(s.kirosight().map((e) => e.text)).toEqual([expected]);
    expect(s.frames('speech_request')[0]!.text).toBe(expected);
    expect(before(s.events, 'append:kirosight', 'speech_request:speech-1')).toBe(true);
    expect(JSON.stringify(s.transcript.getEntries())).not.toContain('PROVIDER-DETAIL'); // backend text is never shown
  });

  it('speech failure: the answer is untouched and the notice is a separate, later entry', async () => {
    const s = await buildStack();
    s.pipeline.announce('There are two errors in auth.ts.');
    const answer = s.kirosight()[0]!;
    s.speakLatest();

    s.backendError('speech-1', 'TTS_UNAVAILABLE');

    const entries = s.transcript.getEntries();
    expect(entries[0]).toEqual(answer);
    expect(entries[1]).toMatchObject({ role: 'system', text: SPEECH_UNAVAILABLE_TEXT });
    expect(entries).toHaveLength(2);
    expect(s.events).toEqual(['append:kirosight', 'speech_request:speech-1', 'append:system']);
  });

  it('speech that never answers does not delay the answer, and typed requests keep working', async () => {
    const s = await buildStack();

    await s.pipeline.handle('where am I', 'typed');
    expect(s.kirosight()).toHaveLength(1); // visible at once; nothing is waiting for audio
    s.speakLatest();

    await expect(s.pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    expect(s.kirosight()).toHaveLength(2);
  });
});

describe('property: whatever happens to the speech, the answer text is exact and comes first', () => {
  it('holds for arbitrary answers and for audio, error and silence', async () => {
    const answerArb = fc.string({ minLength: 1, maxLength: 1500 }).filter((text) => text.trim() !== '');
    const modeArb = fc.constantFrom('audio_then_play', 'backend_error', 'silence');

    await fc.assert(
      fc.asyncProperty(answerArb, modeArb, async (answer, mode) => {
        const s = await buildStack();
        s.pipeline.announce(answer);
        s.speakLatest();

        if (mode === 'audio_then_play') {
          s.audio('speech-1');
          s.speech.handlePlayback('started', 'speech-1');
          s.speech.handlePlayback('ended', 'speech-1');
        } else if (mode === 'backend_error') {
          s.backendError('speech-1', 'TTS_UNAVAILABLE');
        } else {
          s.scheduler.advance(10_000);
        }

        expect(s.kirosight().map((e) => e.text)).toEqual([answer]);
        expect(s.frames('speech_request').map((f) => f.text)).toEqual([answer]);
        expect(before(s.events, 'append:kirosight', 'speech_request:speech-1')).toBe(true);
        const failureNotices = s.notices();
        expect(failureNotices).toHaveLength(mode === 'audio_then_play' ? 0 : 1);
        if (mode === 'audio_then_play') expect(before(s.events, 'speech_request:speech-1', 'play_audio:speech-1')).toBe(true);
      }),
      { numRuns: 30 },
    );
  });
});
