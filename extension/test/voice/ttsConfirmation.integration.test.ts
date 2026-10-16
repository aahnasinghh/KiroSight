import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatConfirmation } from '../../src/response/responseFormatter';
import { COMMAND, RUN_TESTS, buildStack, flush, watchUnhandledRejections, type Stack } from './ttsHarness';

/**
 * Task 9.6, group 4: CONFIRMATION SAFETY (Req 6.9, 9.4, 10.2, 15.3).
 *
 * The real ConfirmationManager, ActionGate, GateConfirmationController and ActionExecutor sit
 * behind the pipeline; only the test runner is a double, and it counts how often it is asked to
 * run. A pending RUN_TESTS confirmation is spoken, interrupted in every available way, repeated,
 * and then confirmed or declined.
 *
 * Defects these would catch: an interruption (or a spoken prompt) approving, declining, executing
 * or clearing a pending action; a prompt spoken without its action and target; REPEAT_CONFIRMATION
 * speaking something other than the stored prompt; Confirm or Decline not working afterwards.
 *
 * RUN_TESTS is the only action that needs confirmation today, and it changes nothing in the
 * workspace, so there is no "intended change" text to assert; the prompt names the action and the
 * exact configured command. There is no file-modifying action yet.
 */
const unhandled = watchUnhandledRejections();
beforeEach(() => unhandled.start());
afterEach(() => expect(unhandled.finish()).toEqual([]));

const PROMPT = formatConfirmation(RUN_TESTS, COMMAND);

async function pendingStack() {
  const s = await buildStack();
  await s.pipeline.handle('run my tests', 'typed');
  const pending = s.manager.pending();
  expect(pending).not.toBeNull();
  return { s, pending };
}

const lastStatus = (s: Stack): string => s.models.at(-1)!.statusKind;

describe('the spoken prompt', () => {
  it('is the stored prompt: it names the action and the exact target, and changes no state', async () => {
    const { s, pending } = await pendingStack();
    const stored = s.confirmation.pendingConfirmation()!.promptText;

    s.speech.speakPendingConfirmation();

    expect(stored).toBe(PROMPT);
    expect(s.frames('speech_request').map((f) => f.text)).toEqual([PROMPT]);
    expect(PROMPT).toContain(COMMAND);
    expect(PROMPT).toMatch(/run tests/i);
    expect(s.manager.pending()).toBe(pending);
    expect(s.executed).toEqual([]);
  });

  it('the prompt text is data to the TTS provider: speaking it executes nothing', async () => {
    const { s } = await pendingStack();
    s.speech.speakPendingConfirmation();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');
    s.speech.handlePlayback('ended', 'speech-1');

    expect(s.executed).toEqual([]);
    expect(s.state.testRuns).toBe(0);
  });
});

describe('an interruption leaves the pending confirmation exactly as it was', () => {
  it('Escape during the spoken prompt: stopped, still pending, nothing approved, declined or run', async () => {
    const { s, pending } = await pendingStack();
    s.speech.speakPendingConfirmation();
    s.audio('speech-1');
    s.speech.handlePlayback('started', 'speech-1');

    await s.escape();

    expect(s.posted().filter((m) => m.type === 'stop_audio')).toHaveLength(1);
    expect(s.manager.pending()).toBe(pending);
    expect(s.executed).toEqual([]);
    expect(s.state.testRuns).toBe(0);
    expect(lastStatus(s)).toBe('confirmation_pending');
    expect(s.models.at(-1)!.pendingConfirmation).not.toBeNull();
    expect(s.notices()).toEqual([]);
  });

  it('every kind of interruption, repeated: still the same pending request, nothing executed', async () => {
    const { s, pending } = await pendingStack();
    s.speech.speakPendingConfirmation();
    s.audio('speech-1');

    await s.escape();
    await s.escape();
    await s.submitTyped('go to line 10'); // a new utterance: answered with the re-prompt only
    s.pipeline.interrupt(); // the stop command's seam
    await s.panel.receive({ type: 'ptt_toggle' }); // push-to-talk start
    await flush();

    expect(s.manager.pending()).toBe(pending);
    expect(s.executed).toEqual([]);
    expect(s.state.testRuns).toBe(0);
    expect(s.confirmation.pendingConfirmation()!.promptText).toBe(PROMPT);
  });

  it('REPEAT_CONFIRMATION after an interruption speaks the actual pending prompt again, and approves nothing', async () => {
    const { s, pending } = await pendingStack();
    s.speech.speakPendingConfirmation();
    await s.escape();

    s.speech.repeatConfirmation();
    await s.pipeline.handle('repeat', 'typed'); // the typed REPEAT_CONFIRMATION reply
    s.speakLatest();

    expect(s.frames('speech_request').map((f) => f.text)).toEqual([PROMPT, PROMPT, PROMPT]);
    expect(s.manager.pending()).toBe(pending);
    expect(s.executed).toEqual([]);
  });
});

describe('Confirm and Decline keep working afterwards', () => {
  it('Confirm after an interruption runs the action exactly once', async () => {
    const { s } = await pendingStack();
    s.speech.speakPendingConfirmation();
    await s.escape();

    await s.panel.receive({ type: 'confirm' });
    await s.panel.receive({ type: 'confirm' }); // a repeat finds nothing pending

    expect(s.executed).toEqual([RUN_TESTS]);
    expect(s.state.testRuns).toBe(1);
    expect(s.manager.pending()).toBeNull();
  });

  it('Decline after an interruption runs nothing and clears the request', async () => {
    const { s } = await pendingStack();
    s.speech.speakPendingConfirmation();
    await s.escape();

    await s.panel.receive({ type: 'decline' });

    expect(s.executed).toEqual([]);
    expect(s.state.testRuns).toBe(0);
    expect(s.manager.pending()).toBeNull();
  });

  it('a typed "confirm" works after an interruption, with speech switched off', async () => {
    const { s } = await pendingStack();
    s.state.speechOn = false;
    await s.escape();

    await s.submitTyped('confirm');

    expect(s.frames('speech_request')).toEqual([]);
    expect(s.executed).toEqual([RUN_TESTS]);
  });
});

describe('property: no sequence of speech events and interruptions resolves a pending confirmation', () => {
  type Op = 'speak' | 'repeat' | 'audio' | 'started' | 'escape' | 'other' | 'stop' | 'tick';
  const opsArb = fc.array(
    fc.constantFrom<Op>('speak', 'repeat', 'audio', 'started', 'escape', 'other', 'stop', 'tick'),
    { maxLength: 24 },
  );

  it('holds for random sequences', async () => {
    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const { s, pending } = await pendingStack();
        const latestId = (): string | undefined => s.frames('speech_request').at(-1)?.id as string | undefined;

        for (const op of ops) {
          const id = latestId();
          if (op === 'speak') s.speech.speakPendingConfirmation();
          else if (op === 'repeat') s.speech.repeatConfirmation();
          else if (op === 'audio' && id !== undefined) s.audio(id);
          else if (op === 'started' && id !== undefined) s.speech.handlePlayback('started', id);
          else if (op === 'escape') await s.escape();
          else if (op === 'other') await s.submitTyped('go to line 10');
          else if (op === 'stop') s.pipeline.interrupt();
          else if (op === 'tick') s.scheduler.advance(4_000);
          await flush();

          expect(s.manager.pending()).toBe(pending);
          expect(s.executed).toEqual([]);
          expect(s.state.testRuns).toBe(0);
        }

        for (const frame of s.frames('speech_request')) expect(frame.text).toBe(PROMPT);
        expect(s.confirmation.pendingConfirmation()!.promptText).toBe(PROMPT);
      }),
      { numRuns: 40 },
    );
  });
});
