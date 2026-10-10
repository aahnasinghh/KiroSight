import { z } from 'zod';

import type { TranscriptEntry } from '../transcript/transcriptStore';
import type { StatusKind, ViewModel, VoiceViewModel } from '../webview/viewModel';
import { err, ok, type Result } from '../util/result';

/**
 * Webview <-> extension-host bridge messages.
 *
 * Definitions and validators only. This is not the backend WebSocket protocol.
 * Every object schema is strict, so unknown or extra properties are rejected
 * rather than stripped.
 */

/** Spec-defined: typed text is at most 4000 characters (design.md, bridge table). */
export const MAX_SUBMIT_TEXT_CHARS = 4000;

export const WEBVIEW_TO_HOST_TYPES = [
  'ready',
  'submit_text',
  'ptt_toggle',
  'audio_clip',
  'mic_state',
  'confirm',
  'decline',
  'interrupt',
  'playback',
] as const;

export const HOST_TO_WEBVIEW_TYPES = [
  'view_state',
  'submit_ack',
  'backend_unavailable',
  'transcript_append',
  'start_capture',
  'stop_capture',
  'play_audio',
  'stop_audio',
  'focus_input',
] as const;

// The design names these fields but specifies no length, emptiness, or syntax
// rules for them, so they are plain strings. Audio chunking is a later task.
const identifierSchema = z.string();
const base64Schema = z.string();

/** Reuses the TranscriptEntry contract; the satisfies clause keeps them in sync. */
export const transcriptEntrySchema = z.strictObject({
  seq: z.number().int(),
  role: z.enum(['user', 'kirosight', 'system']),
  text: z.string(),
  source: z.enum(['typed', 'voice']).optional(),
}) satisfies z.ZodType<TranscriptEntry>;

const statusKindSchema = z.enum([
  'idle',
  'listening',
  'processing',
  'speaking',
  'error',
  'confirmation_pending',
  'voice_unavailable',
] satisfies [StatusKind, ...StatusKind[]]);

const voiceSchema = z.strictObject({
  state: z.enum(['available', 'unavailable', 'initializing']),
  reasonText: z.string().nullable(),
}) satisfies z.ZodType<VoiceViewModel>;

// --- webview to host ---

export const readyMessageSchema = z.strictObject({ type: z.literal('ready') });

export const submitTextMessageSchema = z.strictObject({
  type: z.literal('submit_text'),
  submitId: identifierSchema,
  text: z.string().max(MAX_SUBMIT_TEXT_CHARS),
});

export const pttToggleMessageSchema = z.strictObject({ type: z.literal('ptt_toggle') });

export const audioClipMessageSchema = z.strictObject({
  type: z.literal('audio_clip'),
  clipId: identifierSchema,
  mimeType: identifierSchema,
  base64: base64Schema,
  seq: z.number().int().optional(),
  final: z.boolean().optional(),
});

export const micStateMessageSchema = z.strictObject({
  type: z.literal('mic_state'),
  state: z.enum(['granted', 'denied', 'unavailable', 'prompt']),
});

export const confirmMessageSchema = z.strictObject({ type: z.literal('confirm') });
export const declineMessageSchema = z.strictObject({ type: z.literal('decline') });
export const interruptMessageSchema = z.strictObject({ type: z.literal('interrupt') });

export const playbackMessageSchema = z.strictObject({
  type: z.literal('playback'),
  state: z.enum(['started', 'ended', 'failed']),
  id: identifierSchema,
});

export const webviewToHostMessageSchema = z.discriminatedUnion('type', [
  readyMessageSchema,
  submitTextMessageSchema,
  pttToggleMessageSchema,
  audioClipMessageSchema,
  micStateMessageSchema,
  confirmMessageSchema,
  declineMessageSchema,
  interruptMessageSchema,
  playbackMessageSchema,
]);

// --- host to webview ---

/** `view_state` is the full ViewModel plus the `type` discriminator, with no renaming. */
export const viewStateMessageSchema = z.strictObject({
  type: z.literal('view_state'),
  status: z.string().min(1),
  statusKind: statusKindSchema,
  transcript: z.array(transcriptEntrySchema),
  latest: z.string().nullable(),
  pendingConfirmation: z.null().optional(),
  voice: voiceSchema,
  listening: z.boolean(),
});

/** Compile-time guard: a ViewModel must always be a valid view_state body. */
type ViewStateBody = Omit<z.infer<typeof viewStateMessageSchema>, 'type' | 'transcript'> & {
  readonly transcript: readonly z.infer<typeof transcriptEntrySchema>[];
};
export type ViewModelIsViewState = ViewModel extends ViewStateBody ? true : never;
export const viewModelIsViewState: ViewModelIsViewState = true;

export const submitAckMessageSchema = z.strictObject({
  type: z.literal('submit_ack'),
  submitId: identifierSchema,
  status: z.enum(['handled', 'not_handled', 'discarded']),
});

export const backendUnavailableMessageSchema = z.strictObject({
  type: z.literal('backend_unavailable'),
  submitId: identifierSchema.optional(),
  kind: z.enum(['text', 'audio']),
  message: z.string(),
});

// The design says only "one entry"; `entry` is the minimal chosen field name.
export const transcriptAppendMessageSchema = z.strictObject({
  type: z.literal('transcript_append'),
  entry: transcriptEntrySchema,
});

export const startCaptureMessageSchema = z.strictObject({ type: z.literal('start_capture') });
export const stopCaptureMessageSchema = z.strictObject({ type: z.literal('stop_capture') });

export const playAudioMessageSchema = z.strictObject({
  type: z.literal('play_audio'),
  id: identifierSchema,
  mimeType: identifierSchema,
  base64: base64Schema,
});

export const stopAudioMessageSchema = z.strictObject({ type: z.literal('stop_audio') });

/** Explicit re-activation only: moves DOM focus to the command input. No payload. */
export const focusInputMessageSchema = z.strictObject({ type: z.literal('focus_input') });

export const hostToWebviewMessageSchema = z.discriminatedUnion('type', [
  viewStateMessageSchema,
  submitAckMessageSchema,
  backendUnavailableMessageSchema,
  transcriptAppendMessageSchema,
  startCaptureMessageSchema,
  stopCaptureMessageSchema,
  playAudioMessageSchema,
  stopAudioMessageSchema,
  focusInputMessageSchema,
]);

export type WebviewToHostMessage = z.infer<typeof webviewToHostMessageSchema>;
export type HostToWebviewMessage = z.infer<typeof hostToWebviewMessageSchema>;

export interface BridgeValidationError {
  readonly code: 'UNKNOWN_BRIDGE_TYPE' | 'INVALID_BRIDGE_MESSAGE';
  readonly message: string;
}

function hasKnownType(raw: unknown, types: readonly string[]): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return false;
  }
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' && types.includes(type);
}

function validate<T>(
  schema: z.ZodType<T>,
  types: readonly string[],
  raw: unknown,
): Result<T, BridgeValidationError> {
  if (!hasKnownType(raw, types)) {
    return err({ code: 'UNKNOWN_BRIDGE_TYPE', message: 'Unknown bridge message type.' });
  }

  const parsed = schema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err({ code: 'INVALID_BRIDGE_MESSAGE', message: 'Bridge message is invalid.' });
}

/** Never throws for malformed input and never echoes the offending payload. */
export function validateWebviewToHostMessage(
  raw: unknown,
): Result<WebviewToHostMessage, BridgeValidationError> {
  return validate(webviewToHostMessageSchema, WEBVIEW_TO_HOST_TYPES, raw);
}

export function validateHostToWebviewMessage(
  raw: unknown,
): Result<HostToWebviewMessage, BridgeValidationError> {
  return validate(hostToWebviewMessageSchema, HOST_TO_WEBVIEW_TYPES, raw);
}
