import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RouteResult } from '../../src/intent/intentTypes';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import { RequestTracker } from '../../src/pipeline/requestTracker';
import { TranscriptStore, type TranscriptSource } from '../../src/transcript/transcriptStore';

const whitespaceCharacters = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\v',
  '\f',
  '\u00a0',
  '\ufeff',
] as const;

const whitespaceTextArb = fc.array(
  fc.constantFrom(...whitespaceCharacters),
  { maxLength: 100 },
).map((characters) => characters.join(''));
const sourceArb = fc.constantFrom<TranscriptSource>('typed', 'voice');
const whitespaceSubmissionArb = fc.record({
  text: whitespaceTextArb,
  source: sourceArb,
});

function createPipeline(seed: boolean) {
  const transcript = new TranscriptStore();
  if (seed) {
    transcript.append('system', 'history before whitespace');
  }

  const tracker = new RequestTracker();
  const calls = {
    interceptor: 0,
    route: 0,
    localHandler: 0,
    agent: 0,
    viewModel: 0,
  };

  const pipeline = new InputPipeline({
    transcript,
    tracker,
    interceptor: {
      intercept: async () => {
        calls.interceptor += 1;
        return { intercepted: false };
      },
    },
    route: (_text): RouteResult => {
      calls.route += 1;
      return { route: 'agent', reason: 'unrecognized' };
    },
    localIntents: {
      handleIntent: async () => {
        calls.localHandler += 1;
        return 'unexpected local response';
      },
    },
    agent: {
      respond: async () => {
        calls.agent += 1;
        return { status: 'handled', text: 'unexpected agent response' };
      },
    },
    onViewModel: () => {
      calls.viewModel += 1;
    },
  });

  return { pipeline, transcript, tracker, calls };
}

function expectNoWhitespaceSideEffects(
  calls: ReturnType<typeof createPipeline>['calls'],
  tracker: RequestTracker,
): void {
  expect(calls).toEqual({
    interceptor: 0,
    route: 0,
    localHandler: 0,
    agent: 0,
    viewModel: 0,
  });
  expect(tracker.current()).toBe(0);
}

describe('InputPipeline Property 12', () => {
  it('discards every generated whitespace-only submission for both sources', async () => {
    await fc.assert(
      fc.asyncProperty(whitespaceSubmissionArb, async ({ text, source }) => {
        const { pipeline, transcript, tracker, calls } = createPipeline(false);
        const before = transcript.getEntries();

        await expect(pipeline.handle(text, source)).resolves.toBe('discarded');

        expect(transcript.getEntries()).toEqual(before);
        expectNoWhitespaceSideEffects(calls, tracker);
      }),
      { numRuns: 100 },
    );
  });

  it('preserves seeded transcript history across repeated whitespace submissions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(whitespaceSubmissionArb, { maxLength: 30 }),
        async (submissions) => {
          const { pipeline, transcript, tracker, calls } = createPipeline(true);
          const before = transcript.getEntries();

          for (const { text, source } of submissions) {
            await expect(pipeline.handle(text, source)).resolves.toBe('discarded');
          }

          expect(transcript.getEntries()).toEqual(before);
          expect(transcript.getEntries()).toHaveLength(1);
          expectNoWhitespaceSideEffects(calls, tracker);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('covers the runtime trim-whitespace boundary characters', async () => {
    for (const text of ['', ...whitespaceCharacters, whitespaceCharacters.join('')]) {
      const { pipeline, transcript, tracker, calls } = createPipeline(false);

      await expect(pipeline.handle(text, 'typed')).resolves.toBe('discarded');
      expect(transcript.getEntries()).toEqual([]);
      expectNoWhitespaceSideEffects(calls, tracker);
    }
  });
});
