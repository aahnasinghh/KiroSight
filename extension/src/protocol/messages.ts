import type { ActionResult } from '../actions/actionResult';
import type { WireIDEContext } from '../context/contextService';
import type { TestRunSummary } from '../testing/testOutputParser';
import type { BACKEND_MESSAGE_TYPES, ERROR_CODES, PROTOCOL_VERSION } from './constants';

/**
 * Extension host <-> Python backend wire types (design.md, "Protocol envelope").
 *
 * Types only; runtime validation lives in validators.ts. This is separate from the
 * webview bridge in bridgeMessages.ts. Backend messages never carry executable commands.
 */

export type ProtocolVersion = typeof PROTOCOL_VERSION;
export type BackendMessageType = (typeof BACKEND_MESSAGE_TYPES)[number];
export type ErrorCode = (typeof ERROR_CODES)[number];

interface Base {
  version: ProtocolVersion;
  type: string;
}

/**
 * The protocol layer only requires an object with a string `type`. All other properties are
 * preserved untouched for ActionValidator, which owns the allow-list and parameter checks.
 */
export type ActionEnvelope = { type: string; [key: string]: unknown };

/**
 * design.md references `UserUtterance` without defining it. Minimal shape: the text (max 4000
 * characters) and, optionally, whether it was typed or spoken.
 */
export interface UserUtterance {
  text: string;
  source?: 'typed' | 'voice';
}

/** The wire context: IDEContext without the absolute `activeFile` (see toWireContext). */
export type WireContext = WireIDEContext;

/**
 * ActionResult on the wire. `actionType` is a plain string because an agent-proposed action that
 * is not on the allow-list still receives a `not_permitted` result (design.md, Req 5.5).
 */
export type WireActionResult = Omit<ActionResult, 'actionType'> & { actionType: string };

export type Capabilities = {
  bedrock: boolean;
  stt: boolean;
  tts: boolean;
  mic: 'available' | 'unavailable' | 'denied' | 'not_applicable';
};

// --- extension to backend ---

export interface Hello extends Base {
  type: 'hello';
  token?: string;
  client: 'kirosight-extension';
}

export interface AgentRequest extends Base {
  type: 'agent_request';
  id: string;
  kind: 'utterance' | 'summarize_test_run';
  utterance?: UserUtterance;
  context: WireContext;
  testRun?: TestRunSummary;
}

export interface ActionResultMessage extends Base {
  type: 'action_result';
  replyTo: string;
  result: WireActionResult;
}

export interface RecordStart extends Base {
  type: 'record_start';
  id: string;
}

export interface RecordStop extends Base {
  type: 'record_stop';
  id: string;
}

export interface AudioClip extends Base {
  type: 'audio_clip';
  id: string;
  mimeType: string;
  base64: string;
}

export interface SpeechRequest extends Base {
  type: 'speech_request';
  id: string;
  replyTo?: string;
  text: string;
}

export interface Cancel extends Base {
  type: 'cancel';
  targetId: string;
}

// --- backend to extension ---

export interface HelloAck extends Base {
  type: 'hello_ack';
  supportedVersions: number[];
  capabilities: Capabilities;
}

export interface AgentResponse extends Base {
  type: 'agent_response';
  replyTo: string;
  speech: string;
  action: ActionEnvelope;
  confirmationRequired: boolean;
}

export interface ActionRequest extends Base {
  type: 'action_request';
  id: string;
  action: ActionEnvelope;
  reason: string;
}

export interface TranscriptionResult extends Base {
  type: 'transcription_result';
  replyTo: string;
  text: string;
}

export interface SpeechAudio extends Base {
  type: 'speech_audio';
  replyTo: string;
  mimeType: string;
  base64: string;
}

export interface ErrorMessage extends Base {
  type: 'error_message';
  replyTo?: string;
  code: ErrorCode;
  message: string;
  recoverable: boolean;
}

export type ExtensionToBackendMessage =
  | Hello
  | AgentRequest
  | ActionResultMessage
  | RecordStart
  | RecordStop
  | AudioClip
  | SpeechRequest
  | Cancel;

export type BackendToExtensionMessage =
  | HelloAck
  | AgentResponse
  | ActionRequest
  | TranscriptionResult
  | SpeechAudio
  | ErrorMessage;

export type ProtocolMessage = ExtensionToBackendMessage | BackendToExtensionMessage;
