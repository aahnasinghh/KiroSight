import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  createViewModel,
  STATUS_LABELS,
  statusLabel,
  type StatusKind,
  type VoiceState,
  type ViewModelInput,
} from '../../src/webview/viewModel';
import type { TranscriptEntry } from '../../src/transcript/transcriptStore';

const statusKinds: readonly StatusKind[] = [
  'idle',
  'listening',
  'processing',
  'speaking',
  'error',
  'confirmation_pending',
  'voice_unavailable',
];

const statusKindArb = fc.constantFrom<StatusKind>(...statusKinds);
const voiceStateArb = fc.constantFrom<VoiceState>('available', 'unavailable', 'initializing');
const textArb = fc.string({ maxLength: 60 }).map((value) => `property-input-${value}`);
const sourceArb = fc.option(
  fc.constantFrom<'typed' | 'voice'>('typed', 'voice'),
  { nil: undefined },
);
const transcriptEntryArb = fc.record({
  seq: fc.integer({ min: 1, max: 100 }),
  role: fc.constantFrom<'user' | 'kirosight' | 'system'>('user', 'kirosight', 'system'),
  text: textArb,
  source: sourceArb,
});
const transcriptArb = fc.array(transcriptEntryArb, { maxLength: 8 });
const voiceArb = fc.record({
  state: voiceStateArb,
  reasonText: fc.option(textArb, { nil: null }),
});
const inputArb: fc.Arbitrary<Omit<ViewModelInput, 'statusKind'>> = fc.record({
  voice: voiceArb,
  latest: fc.option(textArb, { nil: null }),
  transcript: transcriptArb,
  listening: fc.boolean(),
});

function expectSafeLabel(label: string): void {
  expect(typeof label).toBe('string');
  expect(label.trim().length).toBeGreaterThan(0);
  expect(label).not.toMatch(/token|secret|password|api[_-]?key|bearer|authorization/i);
}

describe('view model Property 25', () => {
  it('gives every approved status a non-empty textual label', () => {
    fc.assert(
      fc.property(statusKindArb, (statusKind) => {
        const model = createViewModel({ statusKind });
        const label = statusLabel(statusKind);

        expect(model.statusKind).toBe(statusKind);
        expect(model.status).toBe(label);
        expect(model).not.toHaveProperty('statusLabel');
        expectSafeLabel(label);
        expectSafeLabel(model.status);
      }),
      { numRuns: 100 },
    );
  });

  it('covers exactly the closed approved status domain', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...statusKinds].sort());
  });

  it('produces deterministic labels for each generated status', () => {
    fc.assert(
      fc.property(statusKindArb, (statusKind) => {
        expect(createViewModel({ statusKind }).status).toBe(
          createViewModel({ statusKind }).status,
        );
      }),
      { numRuns: 100 },
    );
  });

  it('keeps labels independent from transcript, response, voice, and reason data', () => {
    fc.assert(
      fc.property(statusKindArb, inputArb, (statusKind, unrelatedInput) => {
        const inputBefore = JSON.stringify(unrelatedInput);
        const model = createViewModel({ statusKind, ...unrelatedInput });
        const baseline = createViewModel({ statusKind });

        expect(model.statusKind).toBe(statusKind);
        expect(model.status).toBe(baseline.status);
        expectSafeLabel(model.status);

        for (const value of [
          unrelatedInput.latest,
          unrelatedInput.voice.reasonText,
          ...unrelatedInput.transcript.map((entry) => entry.text),
        ]) {
          if (value !== null && value.length > 0) {
            expect(model.status).not.toContain(value);
          }
        }
        expect(JSON.stringify(unrelatedInput)).toBe(inputBefore);
      }),
      { numRuns: 100 },
    );
  });

  it('does not mutate generated transcript input while constructing labels', () => {
    fc.assert(
      fc.property(statusKindArb, transcriptArb, (statusKind, transcript) => {
        const before = JSON.stringify(transcript);
        const model = createViewModel({ statusKind, transcript });

        expect(model.status).toBe(STATUS_LABELS[statusKind]);
        expect(JSON.stringify(transcript)).toBe(before);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps labels free of generated transcript objects and credential-like text', () => {
    fc.assert(
      fc.property(statusKindArb, transcriptArb, (statusKind, transcript) => {
        const model = createViewModel({ statusKind, transcript });

        expectSafeLabel(model.status);
        expect(model.status).not.toContain(JSON.stringify(transcript));
      }),
      { numRuns: 100 },
    );
  });
});
