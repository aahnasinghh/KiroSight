import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  HOST_TO_WEBVIEW_TYPES,
  MAX_SUBMIT_TEXT_CHARS,
  WEBVIEW_TO_HOST_TYPES,
  hostToWebviewMessageSchema,
  validateHostToWebviewMessage,
  validateWebviewToHostMessage,
  webviewToHostMessageSchema,
} from '../../src/protocol/bridgeMessages';
import { createViewModel } from '../../src/webview/viewModel';

const testDirectory = dirname(fileURLToPath(import.meta.url));

const entry = { seq: 1, role: 'user', text: 'Where am I?', source: 'typed' } as const;

const webviewMessages = [
  { type: 'ready' },
  { type: 'submit_text', submitId: 's1', text: 'where am i' },
  { type: 'ptt_toggle' },
  { type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AAEC' },
  { type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AAEC', seq: 0, final: true },
  { type: 'mic_state', state: 'granted' },
  { type: 'confirm' },
  { type: 'decline' },
  { type: 'interrupt' },
  { type: 'playback', state: 'started', id: 'p1' },
] as const;

/** A view_state built directly from the ViewModel, with no field renaming. */
function viewState() {
  return {
    type: 'view_state' as const,
    ...createViewModel({ transcript: [entry], latest: 'Done.' }),
  };
}

const hostMessages = [
  viewState(),
  { type: 'submit_ack', submitId: 's1', status: 'handled' },
  { type: 'backend_unavailable', kind: 'text', message: 'Backend is not running.' },
  { type: 'backend_unavailable', submitId: 's1', kind: 'audio', message: 'Not connected.' },
  { type: 'transcript_append', entry },
  { type: 'start_capture' },
  { type: 'stop_capture' },
  { type: 'play_audio', id: 'p1', mimeType: 'audio/mpeg', base64: 'AAEC' },
  { type: 'stop_audio' },
  { type: 'focus_input' },
] as const;

function collectKeys(schema: z.ZodType, keys = new Set<string>()): Set<string> {
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape)) {
      keys.add(key);
      collectKeys(child as z.ZodType, keys);
    }
  } else if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    collectKeys(schema.unwrap() as z.ZodType, keys);
  } else if (schema instanceof z.ZodArray) {
    collectKeys(schema.element as z.ZodType, keys);
  }
  return keys;
}

describe('webview bridge messages', () => {
  it('accepts every valid webview-to-host message', () => {
    for (const message of webviewMessages) {
      expect(validateWebviewToHostMessage(message)).toEqual({ ok: true, value: message });
    }
  });

  it('accepts every valid host-to-webview message, including a view state built from the ViewModel', () => {
    for (const message of hostMessages) {
      expect(validateHostToWebviewMessage(message)).toEqual({ ok: true, value: message });
    }
  });

  it('has exactly the closed type sets at runtime and compile time', () => {
    expect([...WEBVIEW_TO_HOST_TYPES]).toEqual([
      'ready', 'submit_text', 'ptt_toggle', 'audio_clip', 'mic_state',
      'confirm', 'decline', 'interrupt', 'playback',
    ]);
    expect([...HOST_TO_WEBVIEW_TYPES]).toEqual([
      'view_state', 'submit_ack', 'backend_unavailable', 'transcript_append',
      'start_capture', 'stop_capture', 'play_audio', 'stop_audio', 'focus_input',
    ]);

    const schemaTypes = (union: typeof webviewToHostMessageSchema | typeof hostToWebviewMessageSchema) =>
      union.options.map((option) => option.shape.type.value);
    expect(schemaTypes(webviewToHostMessageSchema)).toEqual([...WEBVIEW_TO_HOST_TYPES]);
    expect(schemaTypes(hostToWebviewMessageSchema)).toEqual([...HOST_TO_WEBVIEW_TYPES]);
  });

  it('rejects unknown, missing, and cross-direction types', () => {
    expect(validateWebviewToHostMessage({ type: 'run_command', command: 'x' })).toMatchObject({
      ok: false, error: { code: 'UNKNOWN_BRIDGE_TYPE' },
    });
    expect(validateWebviewToHostMessage({ text: 'no type' })).toMatchObject({
      ok: false, error: { code: 'UNKNOWN_BRIDGE_TYPE' },
    });
    expect(validateWebviewToHostMessage({ type: 'view_state' }).ok).toBe(false);
    expect(validateHostToWebviewMessage({ type: 'submit_text', submitId: 's', text: 't' }).ok).toBe(false);
  });

  it('rejects missing fields, wrong types, bad enums, and bounds', () => {
    const invalidWebview: unknown[] = [
      { type: 'submit_text', text: 'no id' },
      { type: 'submit_text', submitId: 's1', text: 42 },
      { type: 'submit_text', submitId: 's1', text: 'x'.repeat(MAX_SUBMIT_TEXT_CHARS + 1) },
      { type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm' },
      { type: 'audio_clip', clipId: 7, mimeType: 'audio/webm', base64: 'AAEC' },
      { type: 'audio_clip', clipId: 'c1', mimeType: 'audio/webm', base64: 'AAEC', final: 'yes' },
      { type: 'mic_state', state: 'maybe' },
      { type: 'playback', state: 'started' },
    ];
    for (const message of invalidWebview) {
      expect(validateWebviewToHostMessage(message)).toMatchObject({
        ok: false, error: { code: 'INVALID_BRIDGE_MESSAGE' },
      });
    }

    expect(validateWebviewToHostMessage({
      type: 'submit_text', submitId: 's1', text: 'x'.repeat(MAX_SUBMIT_TEXT_CHARS),
    }).ok).toBe(true);
  });

  it('adds no undocumented identifier or base64 restrictions', () => {
    expect(MAX_SUBMIT_TEXT_CHARS).toBe(4000);
    const longId = 'i'.repeat(10_000);
    const largeBase64 = 'A'.repeat(2_000_000);

    expect(validateWebviewToHostMessage({ type: 'submit_text', submitId: longId, text: '' }).ok).toBe(true);
    expect(validateWebviewToHostMessage({
      type: 'audio_clip', clipId: longId, mimeType: longId, base64: largeBase64,
    }).ok).toBe(true);
    expect(validateHostToWebviewMessage({
      type: 'play_audio', id: longId, mimeType: longId, base64: largeBase64,
    }).ok).toBe(true);
  });

  it('accepts a ViewModel as a view_state with only the type added', () => {
    const model = createViewModel({ statusKind: 'listening', transcript: [entry] });
    const message = { type: 'view_state', ...model };

    expect(Object.keys(message).sort()).toEqual(
      ['latest', 'listening', 'pendingConfirmation', 'status', 'statusKind', 'transcript', 'type', 'voice'],
    );
    expect(validateHostToWebviewMessage(message)).toMatchObject({
      ok: true,
      value: { status: 'Listening', listening: true },
    });
  });

  it('rejects statusLabel and malformed status or listening in view_state', () => {
    const { status, ...withoutStatus } = viewState();
    void status;

    expect(validateHostToWebviewMessage({ ...viewState(), statusLabel: 'Idle' }).ok).toBe(false);
    expect(validateHostToWebviewMessage({ ...withoutStatus, statusLabel: 'Idle' }).ok).toBe(false);
    expect(validateHostToWebviewMessage(withoutStatus).ok).toBe(false);
    expect(validateHostToWebviewMessage({ ...viewState(), status: 5 }).ok).toBe(false);
    expect(validateHostToWebviewMessage({ ...viewState(), listening: 'true' }).ok).toBe(false);
    const { listening, ...withoutListening } = viewState();
    void listening;
    expect(validateHostToWebviewMessage(withoutListening).ok).toBe(false);
  });

  it('accepts only the approved submit_ack statuses', () => {
    for (const status of ['handled', 'not_handled', 'discarded']) {
      expect(validateHostToWebviewMessage({ type: 'submit_ack', submitId: 's1', status }).ok).toBe(true);
    }
    for (const status of ['ok', 'HANDLED', '', 'pending']) {
      expect(validateHostToWebviewMessage({ type: 'submit_ack', submitId: 's1', status }).ok).toBe(false);
    }
  });

  it('rejects extra top-level and nested properties instead of stripping them', () => {
    expect(validateWebviewToHostMessage({ type: 'ready', command: 'rm -rf' }).ok).toBe(false);
    expect(validateWebviewToHostMessage({ type: 'confirm', token: 'abc' }).ok).toBe(false);
    expect(validateHostToWebviewMessage({ type: 'stop_audio', apiKey: 'abc' }).ok).toBe(false);
    expect(validateHostToWebviewMessage({
      type: 'transcript_append', entry: { ...entry, metadata: {} },
    }).ok).toBe(false);
    expect(validateHostToWebviewMessage({
      ...viewState(), voice: { state: 'available', reasonText: null, token: 'abc' },
    }).ok).toBe(false);
    expect(validateHostToWebviewMessage({ ...viewState(), inputDraft: 'typing' }).ok).toBe(false);
  });

  it('accepts a payload-free focus_input and rejects any extra field', () => {
    expect(validateHostToWebviewMessage({ type: 'focus_input' })).toEqual({
      ok: true,
      value: { type: 'focus_input' },
    });
    expect(validateHostToWebviewMessage({ type: 'focus_input', select: true }).ok).toBe(false);
    expect(validateHostToWebviewMessage({ type: 'focus_input', token: 'abc' }).ok).toBe(false);
    expect(validateWebviewToHostMessage({ type: 'focus_input' }).ok).toBe(false);
  });

  it('rejects malformed view_state and transcript_append payloads', () => {
    const base = viewState();
    const invalid: unknown[] = [
      { ...base, statusKind: 'busy' },
      { ...base, status: '' },
      { ...base, listening: 'no' },
      { ...base, voice: { state: 'broken', reasonText: null } },
      { ...base, transcript: [{ seq: 1, role: 'admin', text: 'x' }] },
      { ...base, pendingConfirmation: { action: 'RUN_TESTS' } },
      { type: 'transcript_append' },
      { type: 'transcript_append', entry: { seq: 'one', role: 'user', text: 'x' } },
      { type: 'transcript_append', entry: { seq: 1, role: 'user', text: 'x', source: 'mic' } },
    ];
    for (const message of invalid) {
      expect(validateHostToWebviewMessage(message).ok).toBe(false);
    }
  });

  it('does not throw for malformed primitives', () => {
    for (const value of [null, undefined, 'ready', 42, true, [], [{ type: 'ready' }], {}]) {
      expect(validateWebviewToHostMessage(value).ok).toBe(false);
      expect(validateHostToWebviewMessage(value).ok).toBe(false);
    }
  });

  it('does not echo the offending payload in errors', () => {
    const result = validateWebviewToHostMessage({ type: 'submit_text', submitId: 's1', text: 99, secret: 'hunter2' });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('defines no credential or token fields in host-to-webview schemas', () => {
    const keys = collectKeys(hostToWebviewMessageSchema.options[0]);
    for (const option of hostToWebviewMessageSchema.options) {
      collectKeys(option, keys);
    }

    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/token|secret|password|credential|authorization|bearer|api[_-]?key/i);
    }
    expect(keys.has('draft')).toBe(false);
  });

  it('has no vscode dependency or side effects', () => {
    const source = readFileSync(resolve(testDirectory, '../../src/protocol/bridgeMessages.ts'), 'utf8');

    expect(source).not.toMatch(/from ['"]vscode['"]/);
    expect(source).not.toMatch(/postMessage|process\.env|Date\.now|Math\.random|console\./);
  });
});
