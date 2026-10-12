import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  createViewModel,
  DEFAULT_VOICE,
  STATUS_LABELS,
  statusLabel,
  type StatusKind,
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

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('view model', () => {
  it('contains exactly the approved status kinds with non-empty labels', () => {
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...statusKinds].sort());

    for (const kind of statusKinds) {
      expect(statusLabel(kind).trim().length).toBeGreaterThan(0);
      const model = createViewModel({ statusKind: kind });
      expect(model).toMatchObject({ statusKind: kind, status: STATUS_LABELS[kind] });
      expect(model.status.trim().length).toBeGreaterThan(0);
      expect(model).not.toHaveProperty('statusLabel');
    }
  });

  it('defaults listening to false and true only for the listening status', () => {
    expect(createViewModel().listening).toBe(false);
    expect(createViewModel({ statusKind: 'listening' })).toMatchObject({
      status: 'Listening',
      listening: true,
    });
    for (const kind of statusKinds.filter((candidate) => candidate !== 'listening')) {
      expect(createViewModel({ statusKind: kind }).listening).toBe(false);
    }
    expect(createViewModel({ listening: true }).listening).toBe(true);
    expect(createViewModel({ statusKind: 'listening', listening: false }).listening).toBe(false);
  });

  it('creates the approved Milestone 4 initial defaults', () => {
    expect(createViewModel()).toEqual({
      status: 'Idle',
      statusKind: 'idle',
      transcript: [],
      latest: null,
      pendingConfirmation: null,
      voice: DEFAULT_VOICE,
      listening: false,
    });
    expect(DEFAULT_VOICE).toEqual({
      state: 'unavailable',
      reasonText: 'Voice is unavailable until voice support is implemented.',
    });
  });

  it('represents the existing TranscriptEntry type without mutating input data', () => {
    const entry: TranscriptEntry = {
      seq: 1,
      role: 'user',
      source: 'typed',
      text: 'Where am I?',
    };
    const transcript: readonly TranscriptEntry[] = [entry];
    const model = createViewModel({ transcript });

    expect(model.transcript).toEqual(transcript);
    expect(model.transcript).not.toBe(transcript);
    expect(model.transcript[0]).not.toBe(entry);

    const mutableInput = transcript as TranscriptEntry[];
    mutableInput[0] = { seq: 2, role: 'system', text: 'changed' };
    expect(model.transcript).toEqual([entry]);
  });

  it('preserves latest response and voice state data', () => {
    const model = createViewModel({
      statusKind: 'error',
      latest: 'The request failed.',
      voice: {
        state: 'initializing',
        reasonText: 'Checking voice availability.',
      },
    });

    expect(model.latest).toBe('The request failed.');
    expect(model.voice).toEqual({
      state: 'initializing',
      reasonText: 'Checking voice availability.',
    });
    expect(createViewModel({ latest: '' }).latest).toBe('');
  });

  it('carries only the exact prompt text for a pending confirmation, frozen, and null otherwise', () => {
    const input = {
      promptText: 'Run tests using "npm.cmd test"? Reply confirm, decline, cancel, or repeat.',
      presentationKey: '["local","local-1"]',
    };
    const pending = createViewModel({ statusKind: 'confirmation_pending', pendingConfirmation: input });

    expect(pending.pendingConfirmation).toEqual(input);
    expect(Object.isFrozen(pending.pendingConfirmation)).toBe(true);
    expect(Object.keys(pending.pendingConfirmation!)).toEqual(['promptText', 'presentationKey']);
    expect(createViewModel({ pendingConfirmation: null }).pendingConfirmation).toBeNull();
    expect(createViewModel({ statusKind: 'idle' }).pendingConfirmation).toBeNull();
  });

  it('is not changed by later mutation of the pending input', () => {
    const input = { promptText: 'original', presentationKey: 'key' };
    const model = createViewModel({ pendingConfirmation: input });

    input.promptText = 'changed';

    expect(model.pendingConfirmation).toEqual({ promptText: 'original', presentationKey: 'key' });
  });

  it('does not invent a prompt when none is supplied, whatever the status', () => {
    expect(createViewModel({ statusKind: 'confirmation_pending' }).pendingConfirmation).toBeNull();
  });

  it('does not expose draft, credential, token, or arbitrary backend fields', () => {
    const model = createViewModel();
    const forbiddenNames = [
      'input',
      'inputText',
      'draft',
      'queryDraft',
      'commandDraft',
      'textareaValue',
      'token',
      'apiKey',
      'api_key',
      'secret',
      'password',
      'credential',
      'authorization',
      'bearer',
    ];

    for (const name of forbiddenNames) {
      expect(model).not.toHaveProperty(name);
    }
  });

  it('has no VS Code dependency', () => {
    const sourcePath = resolve(testDirectory, '../../src/webview/viewModel.ts');
    const source = readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(/from ['"]vscode['"]/);
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('Math.random');
  });
});
