import type { Capabilities } from '../protocol/messages';
import type { ConnectionState } from './backendClient';

export interface BackendStatusInput {
  readonly state: ConnectionState;
  /** The validated hello_ack capabilities, or null when no handshake is active. */
  readonly capabilities: Capabilities | null;
  /** False when `kirosight.backendUrl` is not an accepted loopback WebSocket URL. */
  readonly urlValid: boolean;
}

export const BACKEND_URL_INVALID_STATUS =
  'Backend: not connected, the backend URL setting is not a valid loopback WebSocket URL';

const MIC_LABELS: Readonly<Record<Capabilities['mic'], string>> = {
  available: 'Mic available',
  unavailable: 'Mic unavailable',
  denied: 'Mic denied',
  not_applicable: 'Mic not applicable',
};

const availability = (name: string, available: boolean): string =>
  `${name} ${available ? 'available' : 'unavailable'}`;

/**
 * Plain, screen-reader-readable backend status text. It carries only the connection state and the
 * validated capability flags: no URL, token, raw frame or error text. Capabilities appear only
 * while connected, so a lost connection never claims stale capabilities.
 */
export function formatBackendStatus(input: BackendStatusInput): string {
  if (!input.urlValid) return BACKEND_URL_INVALID_STATUS;

  switch (input.state) {
    case 'disconnected':
      return 'Backend: disconnected';
    case 'connecting':
      return 'Backend: connecting';
    case 'incompatible':
      return 'Backend: incompatible protocol version';
    case 'connected': {
      const parts = ['Backend: connected'];
      const capabilities = input.capabilities;
      if (capabilities !== null) {
        parts.push(
          availability('Bedrock', capabilities.bedrock),
          availability('STT', capabilities.stt),
          availability('TTS', capabilities.tts),
          MIC_LABELS[capabilities.mic],
        );
      }
      return parts.join(' · ');
    }
  }
}
