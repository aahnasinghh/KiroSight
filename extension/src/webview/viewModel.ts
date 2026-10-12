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

/** Only what the webview needs to show: the prompt written by the ConfirmationManager. */
export interface PendingConfirmationView {
  readonly promptText: string;
  /** Opaque identity of the pending request; the same request keeps it, a different one differs. */
  readonly presentationKey: string;
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
  /** The exact stored confirmation prompt while one is pending, otherwise null. */
  readonly pendingConfirmation: PendingConfirmationView | null;
  readonly voice: VoiceViewModel;
  readonly listening: boolean;
}

export interface ViewModelInput {
  readonly statusKind?: StatusKind;
  readonly voice?: VoiceViewModel;
  readonly latest?: string | null;
  readonly pendingConfirmation?: PendingConfirmationView | null;
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
    pendingConfirmation: input.pendingConfirmation
      ? Object.freeze({
        promptText: input.pendingConfirmation.promptText,
        presentationKey: input.pendingConfirmation.presentationKey,
      })
      : null,
    voice,
    listening: input.listening ?? statusKind === 'listening',
  });
}
