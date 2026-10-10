import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  HOST_TO_WEBVIEW_TYPES,
  validateHostToWebviewMessage,
  type HostToWebviewMessage,
} from '../../src/protocol/bridgeMessages';
import { createViewModel, type StatusKind, type VoiceState } from '../../src/webview/viewModel';
import type { TranscriptEntry } from '../../src/transcript/transcriptStore';

const credentialKeys = [
  'token',
  'accessToken',
  'authToken',
  'apiKey',
  'api_key',
  'secret',
  'password',
  'credential',
  'credentials',
  'authorization',
  'bearer',
] as const;

const credentialKeyArb = fc.constantFrom(...credentialKeys);
const displayTextArb = fc.constantFrom(
  'Do not commit your API token.',
  'The password belongs in the secret store.',
  'Authorization failed for this request.',
  'This is ordinary apiKey documentation text.',
  'A credential warning is only display text.',
);
const idArb = fc.string({ maxLength: 24 });
const base64Arb = fc.string({ maxLength: 48 });
const statusKindArb = fc.constantFrom<StatusKind>(
  'idle',
  'listening',
  'processing',
  'speaking',
  'error',
  'confirmation_pending',
  'voice_unavailable',
);
const voiceStateArb = fc.constantFrom<VoiceState>('available', 'unavailable', 'initializing');
const transcriptEntryArb: fc.Arbitrary<TranscriptEntry> = fc.record({
  seq: fc.integer({ min: -100, max: 100 }),
  role: fc.constantFrom<'user' | 'kirosight' | 'system'>('user', 'kirosight', 'system'),
  text: fc.oneof(fc.string({ maxLength: 60 }), displayTextArb),
  source: fc.option(fc.constantFrom<'typed' | 'voice'>('typed', 'voice'), { nil: undefined }),
});
const transcriptArb = fc.array(transcriptEntryArb, { maxLength: 8 });

const viewStateArb: fc.Arbitrary<HostToWebviewMessage> = fc.record({
  statusKind: statusKindArb,
  transcript: transcriptArb,
  latest: fc.option(fc.oneof(fc.string({ maxLength: 60 }), displayTextArb), { nil: null }),
  voiceState: voiceStateArb,
  voiceReason: fc.option(fc.oneof(fc.string({ maxLength: 60 }), displayTextArb), { nil: null }),
  listening: fc.boolean(),
}).map(({ statusKind, transcript, latest, voiceState, voiceReason, listening }) => ({
  type: 'view_state',
  ...createViewModel({
    statusKind,
    transcript,
    latest,
    voice: { state: voiceState, reasonText: voiceReason },
    listening,
  }),
}));

const hostMessageArb: fc.Arbitrary<HostToWebviewMessage> = fc.oneof(
  viewStateArb,
  fc.record({
    type: fc.constant('submit_ack' as const),
    submitId: idArb,
    status: fc.constantFrom<'handled' | 'not_handled' | 'discarded'>('handled', 'not_handled', 'discarded'),
  }),
  fc.record({
    type: fc.constant('backend_unavailable' as const),
    submitId: fc.option(idArb, { nil: undefined }),
    kind: fc.constantFrom<'text' | 'audio'>('text', 'audio'),
    message: fc.oneof(fc.string({ maxLength: 60 }), displayTextArb),
  }),
  transcriptEntryArb.map((entry) => ({ type: 'transcript_append' as const, entry })),
  fc.constant({ type: 'start_capture' as const }),
  fc.constant({ type: 'stop_capture' as const }),
  fc.record({
    type: fc.constant('play_audio' as const),
    id: idArb,
    mimeType: idArb,
    base64: base64Arb,
  }),
  fc.constant({ type: 'stop_audio' as const }),
  fc.constant({ type: 'focus_input' as const }),
);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isCredentialKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return new Set(credentialKeys.map(normalizedKey)).has(normalized);
}

function credentialKeysIn(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) credentialKeysIn(item, found);
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (isCredentialKey(key)) found.push(key);
      credentialKeysIn(child, found);
    }
  }
  return found;
}

function injectTopLevel(message: HostToWebviewMessage, key: string): Record<string, unknown> {
  return { ...(message as unknown as Record<string, unknown>), [key]: 'property-secret-123' };
}

describe('Host-to-webview credential safety Property 30', () => {
  it('covers exactly the nine approved host message types', () => {
    expect([...HOST_TO_WEBVIEW_TYPES]).toEqual([
      'view_state',
      'submit_ack',
      'backend_unavailable',
      'transcript_append',
      'start_capture',
      'stop_capture',
      'play_audio',
      'stop_audio',
      'focus_input',
    ]);
  });

  it('accepts every generated valid host message and finds no credential keys', () => {
    fc.assert(
      fc.property(hostMessageArb, (message) => {
        expect(validateHostToWebviewMessage(message)).toMatchObject({ ok: true });
        expect(credentialKeysIn(message)).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects every generated top-level credential-field injection', () => {
    fc.assert(
      fc.property(hostMessageArb, credentialKeyArb, (message, key) => {
        const injected = injectTopLevel(message, key);
        const result = validateHostToWebviewMessage(injected);

        expect(result.ok).toBe(false);
        expect(credentialKeysIn(injected)).toContain(key);
        if (!result.ok) {
          expect(result.error.message).not.toContain('property-secret-123');
        }
      }),
      { numRuns: 100 },
    );
  });

  it('rejects nested credential fields in voice and transcript entry objects', () => {
    fc.assert(
      fc.property(viewStateArb, credentialKeyArb, (message, key) => {
        if (message.type !== 'view_state') {
          throw new Error('viewStateArb produced an unexpected type');
        }
        const nestedVoice = { ...message.voice, [key]: 'fake-token' };
        const nestedTranscript = message.transcript.length === 0
          ? [{ seq: 1, role: 'system' as const, text: 'safe', [key]: 'fake-token' }]
          : message.transcript.map((entry, index) =>
            index === 0 ? { ...entry, [key]: 'fake-token' } : entry,
          );

        expect(validateHostToWebviewMessage({ ...message, voice: nestedVoice }).ok).toBe(false);
        expect(validateHostToWebviewMessage({ ...message, transcript: nestedTranscript }).ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('allows credential words in ordinary display text', () => {
    fc.assert(
      fc.property(displayTextArb, (text) => {
        const messages: HostToWebviewMessage[] = [
          {
            type: 'backend_unavailable',
            kind: 'text',
            message: text,
          },
          {
            type: 'view_state',
            ...createViewModel({
              latest: text,
              transcript: [{ seq: 1, role: 'system', text }],
              voice: { state: 'unavailable', reasonText: text },
            }),
          },
        ];

        for (const message of messages) {
          expect(validateHostToWebviewMessage(message)).toMatchObject({ ok: true });
          expect(credentialKeysIn(message)).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });
});
