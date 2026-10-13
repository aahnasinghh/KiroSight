import { describe, expect, it } from 'vitest';

import type { ConnectionState } from '../../src/backend/backendClient';
import { BACKEND_URL_INVALID_STATUS, formatBackendStatus } from '../../src/backend/backendStatus';
import type { Capabilities } from '../../src/protocol/messages';
import { createViewModel } from '../../src/webview/viewModel';

const STUB_CAPABILITIES: Capabilities = { bedrock: false, stt: false, tts: false, mic: 'not_applicable' };

describe('formatBackendStatus', () => {
  it.each([
    ['disconnected', 'Backend: disconnected'],
    ['connecting', 'Backend: connecting'],
    ['incompatible', 'Backend: incompatible protocol version'],
  ] as const)('shows %s as plain text without capabilities', (state: ConnectionState, expected: string) => {
    expect(formatBackendStatus({ state, capabilities: null, urlValid: true })).toBe(expected);
    // Even a stale capability object is never shown unless the state is connected.
    expect(formatBackendStatus({ state, capabilities: STUB_CAPABILITIES, urlValid: true })).toBe(expected);
  });

  it('shows the validated stub capabilities in a stable representation', () => {
    expect(formatBackendStatus({ state: 'connected', capabilities: STUB_CAPABILITIES, urlValid: true })).toBe(
      'Backend: connected · Bedrock unavailable · STT unavailable · TTS unavailable · Mic not applicable',
    );
  });

  it('shows available capabilities and every microphone state', () => {
    const base = { bedrock: true, stt: true, tts: true } as const;
    expect(formatBackendStatus({
      state: 'connected', capabilities: { ...base, mic: 'available' }, urlValid: true,
    })).toBe('Backend: connected · Bedrock available · STT available · TTS available · Mic available');
    expect(formatBackendStatus({
      state: 'connected', capabilities: { ...base, mic: 'unavailable' }, urlValid: true,
    })).toContain('Mic unavailable');
    expect(formatBackendStatus({
      state: 'connected', capabilities: { ...base, mic: 'denied' }, urlValid: true,
    })).toContain('Mic denied');
  });

  it('reports a connected state without capabilities as only connected', () => {
    expect(formatBackendStatus({ state: 'connected', capabilities: null, urlValid: true }))
      .toBe('Backend: connected');
  });

  it('states an invalid URL setting in text, whatever the connection state', () => {
    for (const state of ['disconnected', 'connecting', 'connected', 'incompatible'] as const) {
      expect(formatBackendStatus({ state, capabilities: STUB_CAPABILITIES, urlValid: false }))
        .toBe(BACKEND_URL_INVALID_STATUS);
    }
    expect(BACKEND_URL_INVALID_STATUS).not.toMatch(/ws:|wss:|127\.0\.0\.1|token/i);
  });
});

describe('view model backend status', () => {
  it('leaves the label unchanged without a backend status', () => {
    expect(createViewModel({ statusKind: 'idle' }).status).toBe('Idle');
  });

  it('appends the backend status to the status text of every status kind', () => {
    const model = createViewModel({ statusKind: 'processing', backendStatus: 'Backend: connecting' });
    expect(model.status).toBe('Processing. Backend: connecting');
    expect(model.statusKind).toBe('processing');
    expect(createViewModel({ backendStatus: '   ' }).status).toBe('Idle');
  });
});
