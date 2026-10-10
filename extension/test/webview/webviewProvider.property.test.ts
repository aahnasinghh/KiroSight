import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  HOST_TO_WEBVIEW_TYPES,
  WEBVIEW_TO_HOST_TYPES,
  validateWebviewToHostMessage,
} from '../../src/protocol/bridgeMessages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { Uri, resetVscodeMock, vscodeMockState } from '../mocks/vscode';
import { WebviewProvider, type PipelinePort } from '../../src/webview/webviewProvider';
import { createViewModel } from '../../src/webview/viewModel';

const unknownTypeArb = fc.string({ minLength: 1, maxLength: 32 })
  .filter((type) => !(WEBVIEW_TO_HOST_TYPES as readonly string[]).includes(type));

const smallGarbageArb = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.boolean(),
  fc.integer({ min: -10, max: 10 }),
  fc.string({ maxLength: 20 }),
  fc.array(fc.string({ maxLength: 10 }), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 12 }), { maxKeys: 3 }),
);

const unknownMessageArb = fc.record({
  type: unknownTypeArb,
  payload: fc.dictionary(fc.string({ maxLength: 8 }), fc.string({ maxLength: 12 }), { maxKeys: 3 }),
});

const hostTypeInputArb = fc.constantFrom(...HOST_TO_WEBVIEW_TYPES)
  .map((type) => ({ type }));

const malformedKnownArb = fc.oneof(
  fc.record({ type: fc.constant('ready' as const), unexpected: fc.string({ maxLength: 10 }) }),
  fc.record({ type: fc.constant('ptt_toggle' as const), extra: fc.boolean() }),
  fc.record({ type: fc.constant('submit_text' as const), text: fc.string({ maxLength: 10 }) }),
  fc.record({ type: fc.constant('submit_text' as const), submitId: fc.integer(), text: fc.string({ maxLength: 10 }) }),
  fc.record({ type: fc.constant('audio_clip' as const), clipId: fc.string(), mimeType: fc.string() }),
  fc.record({ type: fc.constant('audio_clip' as const), clipId: fc.string(), mimeType: fc.string(), base64: fc.string(), extra: fc.string() }),
  fc.record({ type: fc.constant('mic_state' as const), state: fc.constant('maybe') }),
  fc.record({ type: fc.constant('playback' as const), state: fc.constant('started') }),
  fc.record({ type: fc.constant('confirm' as const), extra: fc.string() }),
  fc.record({ type: fc.constant('decline' as const), extra: fc.string() }),
  fc.record({ type: fc.constant('interrupt' as const), extra: fc.string() }),
);

const validMessageArb = fc.oneof(
  fc.constant({ type: 'ready' as const }),
  fc.record({ type: fc.constant('submit_text' as const), submitId: fc.string({ maxLength: 16 }), text: fc.string({ maxLength: 30 }) }),
  fc.constant({ type: 'ptt_toggle' as const }),
  fc.record({ type: fc.constant('audio_clip' as const), clipId: fc.string({ maxLength: 16 }), mimeType: fc.string({ maxLength: 16 }), base64: fc.string({ maxLength: 30 }) }),
  fc.record({ type: fc.constant('mic_state' as const), state: fc.constantFrom('granted' as const, 'denied' as const, 'unavailable' as const, 'prompt' as const) }),
  fc.constant({ type: 'confirm' as const }),
  fc.constant({ type: 'decline' as const }),
  fc.constant({ type: 'interrupt' as const }),
  fc.record({ type: fc.constant('playback' as const), state: fc.constantFrom('started' as const, 'ended' as const, 'failed' as const), id: fc.string({ maxLength: 16 }) }),
);

function setupProvider() {
  resetVscodeMock();
  const transcript = new TranscriptStore();
  const calls = { handle: 0, confirm: 0, decline: 0, interrupt: 0 };
  const pipeline: PipelinePort = {
    handle: async () => { calls.handle += 1; return 'handled'; },
    confirm: async () => { calls.confirm += 1; },
    decline: async () => { calls.decline += 1; },
    interrupt: () => { calls.interrupt += 1; },
  };
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline,
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
  });
  provider.openOrFocus();

  return { provider, transcript, calls, panel: vscodeMockState.webviewPanels[0] };
}

function expectDiscardedWithoutEffects(raw: unknown): Promise<void> {
  const { transcript, calls, panel } = setupProvider();
  const beforeEntries = transcript.getEntries();
  const beforePosted = [...panel.webview.posted];
  const beforeCalls = { ...calls };

  return panel.receive(raw).then(() => {
    expect(transcript.getEntries()).toEqual(beforeEntries);
    expect(panel.webview.posted).toEqual(beforePosted);
    expect(calls).toEqual(beforeCalls);
    expect(vscodeMockState.executedCommands).toEqual([]);
  });
}

describe('WebviewProvider Property 31', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('discards generated unknown-type messages at the real provider boundary', async () => {
    await fc.assert(
      fc.asyncProperty(unknownMessageArb, async (message) => {
        expect(validateWebviewToHostMessage(message).ok).toBe(false);
        await expectDiscardedWithoutEffects(message);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects every host-to-webview type when received from the webview', async () => {
    await fc.assert(
      fc.asyncProperty(hostTypeInputArb, async (message) => {
        expect(validateWebviewToHostMessage(message).ok).toBe(false);
        await expectDiscardedWithoutEffects(message);
      }),
      { numRuns: 100 },
    );
  });

  it('discards generated malformed known-type messages', async () => {
    await fc.assert(
      fc.asyncProperty(malformedKnownArb, async (message) => {
        expect(validateWebviewToHostMessage(message).ok).toBe(false);
        await expectDiscardedWithoutEffects(message);
      }),
      { numRuns: 100 },
    );
  });

  it('discards primitive and structural garbage without throwing', async () => {
    await fc.assert(
      fc.asyncProperty(smallGarbageArb, async (message) => {
        expect(validateWebviewToHostMessage(message).ok).toBe(false);
        await expectDiscardedWithoutEffects(message);
      }),
      { numRuns: 100 },
    );
  });

  it('rejects an extra field on each generated valid webview message', async () => {
    await fc.assert(
      fc.asyncProperty(validMessageArb, async (message) => {
        const malformed = { ...message, unexpected: 'property' };
        expect(validateWebviewToHostMessage(malformed).ok).toBe(false);
        await expectDiscardedWithoutEffects(malformed);
      }),
      { numRuns: 100 },
    );
  });

  it('keeps valid submit_text as a non-vacuous dispatch control', async () => {
    const { panel, calls } = setupProvider();

    await panel.receive({ type: 'submit_text', submitId: 'control', text: 'where am I' });

    expect(calls.handle).toBe(1);
    expect(panel.webview.posted).toEqual([
      { type: 'submit_ack', submitId: 'control', status: 'handled' },
    ]);
  });
});
