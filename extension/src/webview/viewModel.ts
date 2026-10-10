import type { TranscriptEntry } from '../transcript/transcriptStore';

export type StatusKind =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error'
  | 'confirmation_pending'
  | 'voice_unavailable';

export type VoiceState = 'available' | 'unavailable' | 'initializing';

export interface VoiceViewModel {
  readonly state: VoiceState;
  readonly reasonText: string | null;
}

/**
 * The full view model. Its fields match the design's `view_state` bridge message
 * (minus the `type` discriminator), so it can be sent without renaming or mapping.
 */
export interface ViewModel {
  /** Non-empty human-readable status label. */
  readonly status: string;
  readonly statusKind: StatusKind;
  readonly transcript: readonly TranscriptEntry[];
  readonly latest: string | null;
  readonly pendingConfirmation: null;
  readonly voice: VoiceViewModel;
  readonly listening: boolean;
}

export interface ViewModelInput {
  readonly statusKind?: StatusKind;
  readonly voice?: VoiceViewModel;
  readonly latest?: string | null;
  readonly transcript?: readonly TranscriptEntry[];
  /** Defaults to true only for the 'listening' status kind. */
  readonly listening?: boolean;
}

export const STATUS_LABELS: Readonly<Record<StatusKind, string>> = {
  idle: 'Idle',
  listening: 'Listening',
  processing: 'Processing',
  speaking: 'Speaking',
  error: 'Error',
  confirmation_pending: 'Confirmation pending',
  voice_unavailable: 'Voice unavailable',
};

export const DEFAULT_VOICE: VoiceViewModel = Object.freeze({
  state: 'unavailable',
  reasonText: 'Voice is unavailable until voice support is implemented.',
});

export function statusLabel(statusKind: StatusKind): string {
  return STATUS_LABELS[statusKind];
}

function copyTranscript(transcript: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  return Object.freeze(
    transcript.map((entry) => Object.freeze({ ...entry })),
  );
}

export function createViewModel(input: ViewModelInput = {}): ViewModel {
  const statusKind = input.statusKind ?? 'idle';
  const voice = input.voice === undefined
    ? DEFAULT_VOICE
    : Object.freeze({ ...input.voice });

  return Object.freeze({
    status: statusLabel(statusKind),
    statusKind,
    transcript: copyTranscript(input.transcript ?? []),
    latest: input.latest ?? null,
    pendingConfirmation: null,
    voice,
    listening: input.listening ?? statusKind === 'listening',
  });
}
