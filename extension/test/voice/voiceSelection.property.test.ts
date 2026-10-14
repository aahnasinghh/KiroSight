import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Capabilities } from '../../src/protocol/messages';
import { selectVoiceInput } from '../../src/voice/voiceController';
import type { VoiceKind } from '../../src/voice/voiceInput';

const MIC = ['available', 'unavailable', 'denied', 'not_applicable'] as const;
const KINDS: readonly VoiceKind[] = ['webview', 'backend_local'];

const capabilities = fc.record({
  bedrock: fc.boolean(),
  stt: fc.boolean(),
  tts: fc.boolean(),
  mic: fc.constantFrom(...MIC),
}) as fc.Arbitrary<Capabilities>;

const scenario = fc.record({
  capabilities: fc.option(capabilities, { nil: null }),
  provided: fc.subarray([...KINDS]),
  preferred: fc.constantFrom(...KINDS),
  webviewUnreliable: fc.boolean(),
});

/** An independent statement of when an implementation can be used at all. */
function usable(kind: VoiceKind, s: { capabilities: Capabilities | null; webviewUnreliable: boolean }): boolean {
  if (s.capabilities === null || !s.capabilities.stt) return false;
  return kind === 'webview' ? !s.webviewUnreliable : s.capabilities.mic === 'available';
}

describe('selectVoiceInput (property)', () => {
  it('only ever picks an implementation that exists and can be used', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const picked = selectVoiceInput(s);
        if (picked.kind !== null) {
          expect(s.provided).toContain(picked.kind);
          expect(usable(picked.kind, s)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('finds an implementation whenever one is usable, and prefers the preferred one', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const candidates = s.provided.filter((kind) => usable(kind, s));
        const picked = selectVoiceInput(s);
        expect(picked.kind === null).toBe(candidates.length === 0);
        if (candidates.includes(s.preferred)) expect(picked.kind).toBe(s.preferred);
      }),
      { numRuns: 500 },
    );
  });

  it('never picks anything without a backend that has speech recognition', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const noBackend = selectVoiceInput({ ...s, capabilities: null });
        expect(noBackend).toEqual({ kind: null, cause: 'no_backend' });
        if (s.capabilities !== null) {
          expect(selectVoiceInput({ ...s, capabilities: { ...s.capabilities, stt: false } }))
            .toEqual({ kind: null, cause: 'stt_unavailable' });
        }
      }),
      { numRuns: 300 },
    );
  });

  it('never picks a webview that has proved unreliable', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        expect(selectVoiceInput({ ...s, webviewUnreliable: true }).kind).not.toBe('webview');
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        expect(selectVoiceInput(s)).toEqual(selectVoiceInput(s));
      }),
      { numRuns: 200 },
    );
  });

  it('positive controls: the selection is not simply always null', () => {
    const base = { capabilities: { bedrock: false, stt: true, tts: false, mic: 'available' } as Capabilities, provided: [...KINDS], preferred: 'backend_local' as const, webviewUnreliable: false };
    expect(selectVoiceInput(base)).toEqual({ kind: 'backend_local' });
    expect(selectVoiceInput({ ...base, preferred: 'webview' })).toEqual({ kind: 'webview' });
    expect(selectVoiceInput({ ...base, provided: ['webview'] })).toEqual({ kind: 'webview' });
    expect(selectVoiceInput({ ...base, webviewUnreliable: true, preferred: 'webview' })).toEqual({ kind: 'backend_local' });
  });

  it('names the reason when nothing is usable', () => {
    const base = { capabilities: { bedrock: false, stt: true, tts: false, mic: 'available' } as Capabilities, provided: ['backend_local'] as VoiceKind[], preferred: 'backend_local' as const, webviewUnreliable: false };
    expect(selectVoiceInput({ ...base, capabilities: { ...base.capabilities, mic: 'denied' } })).toEqual({ kind: null, cause: 'mic_denied' });
    expect(selectVoiceInput({ ...base, capabilities: { ...base.capabilities, mic: 'unavailable' } })).toEqual({ kind: null, cause: 'mic_unavailable' });
    expect(selectVoiceInput({ ...base, capabilities: { ...base.capabilities, mic: 'not_applicable' } })).toEqual({ kind: null, cause: 'unsupported' });
    expect(selectVoiceInput({ ...base, provided: [] })).toEqual({ kind: null, cause: 'no_input' });
    expect(selectVoiceInput({ ...base, provided: ['webview'], webviewUnreliable: true })).toEqual({ kind: null, cause: 'webview_unreliable' });
  });
});
