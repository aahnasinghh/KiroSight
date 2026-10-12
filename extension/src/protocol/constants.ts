/**
 * Extension host <-> Python backend protocol constants (design.md, "Protocol envelope").
 *
 * This is NOT the webview bridge (see bridgeMessages.ts).
 */

export const PROTOCOL_VERSION = 1 as const;

/** The exact backend message set. No other wire type exists. */
export const BACKEND_MESSAGE_TYPES = [
  // extension to backend
  'hello',
  'agent_request',
  'action_result',
  'record_start',
  'record_stop',
  'audio_clip',
  'speech_request',
  'cancel',
  // backend to extension
  'hello_ack',
  'agent_response',
  'action_request',
  'transcription_result',
  'speech_audio',
  'error_message',
] as const;

/** The authoritative ErrorCode set from design.md. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNSUPPORTED_VERSION',
  'UNKNOWN_TYPE',
  'UNAUTHORIZED',
  'BEDROCK_UNAVAILABLE',
  'BEDROCK_INVALID_RESPONSE',
  'STT_UNAVAILABLE',
  'STT_NO_SPEECH',
  'TTS_UNAVAILABLE',
  'MIC_UNAVAILABLE',
  'MIC_DENIED',
  'CREDENTIAL_MISSING',
  'TIMEOUT',
  'CANCELLED',
  'INTERNAL',
] as const;

/** design.md: "Text fields capped (utterance 4000 chars, speech 600 chars)". */
export const MAX_UTTERANCE_CHARS = 4000;
export const MAX_SPEECH_CHARS = 600;

/** design.md ActionResult: `ambiguous_files.matches` has at most 10 entries. */
export const MAX_AMBIGUOUS_MATCHES = 10;
