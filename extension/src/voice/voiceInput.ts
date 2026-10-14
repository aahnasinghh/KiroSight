/**
 * The microphone seam (Task 8.2; design D11, Req 9.1, 19.6, 19.7). Everything that records audio
 * sits behind `VoiceInput`; `VoiceController` depends only on this interface, so which
 * implementation is active never reaches routing, confirmation or accessibility logic.
 *
 * Two implementations are planned: `WebviewVoiceInput` (Task 8.3) and `BackendLocalVoiceInput`
 * (Task 8.6). This file defines the contract only. It records nothing.
 */

/** Req 9.1: a capture ends when the user ends it, or at this many milliseconds. */
export const MAX_VOICE_DURATION_MS = 60_000 as const;

export type VoiceKind = 'webview' | 'backend_local';

/**
 * Which implementation to prefer when nothing contradicts it. Spike D (docs/spike-results.md) ran
 * in the real Kiro Extension Development Host: the webview answered `NotAllowedError` with Windows
 * microphone permission enabled, so webview capture is unreliable in Kiro and the backend-local
 * implementation is the selected architecture. Typed input remains the contingency if backend
 * capture also fails. Change this constant only with a new Spike D result.
 */
export const DEFAULT_VOICE_KIND: VoiceKind = 'backend_local';

/** Why a microphone cannot be used right now. */
export type VoiceUnavailableReason = 'denied' | 'unavailable' | 'unsupported' | 'undetermined';

export type VoiceAvailability =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VoiceUnavailableReason };

/**
 * A finished recording: the bytes themselves (webview capture, which the host relays to the
 * backend), or the id of a clip the backend already holds (backend-local capture).
 */
export type VoiceClip = Uint8Array | { readonly backendClipId: string };

export interface VoiceInput {
  readonly kind: VoiceKind;
  readonly maxDurationMs: typeof MAX_VOICE_DURATION_MS;
  /**
   * Whether capture could start now. It must not record, and it must be cheap enough to ask again
   * later: a microphone that is granted afterwards works without a restart (Req 18.6).
   */
  available(): Promise<VoiceAvailability>;
  /** Begins recording. Called only after an explicit user action. */
  start(): Promise<void>;
  /** Ends recording, at the user's request or at `maxDurationMs`, and returns what was captured. */
  stop(): Promise<VoiceClip>;
  /** Abandons the recording and releases the microphone. Safe to call at any time, repeatedly. */
  cancel(): void;
}

/**
 * Turns a finished clip into text (the backend's speech-to-text, reached by Tasks 8.3, 8.4, 8.6
 * and 8.9). The controller applies the 10 s response limit itself.
 */
export type TranscriptionFailure =
  | 'stt_unavailable'
  | 'no_speech'
  | 'mic_unavailable'
  | 'mic_denied'
  | 'backend_unavailable'
  | 'timeout';

export type TranscriptionOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: TranscriptionFailure };

export interface VoiceTranscriber {
  transcribe(clip: VoiceClip): Promise<TranscriptionOutcome>;
  /** The controller gave up (limit, cancel or dispose); stop waiting for this clip. Optional. */
  cancel?(): void;
}
