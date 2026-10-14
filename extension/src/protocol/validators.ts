import { z } from 'zod';

import { MAX_DIAGNOSTICS_SENT, MAX_DIAGNOSTIC_MESSAGE_CHARS, MAX_EXCERPT_CHARS as MAX_CONTEXT_EXCERPT_CHARS } from '../context/contextWindow';
import { MAX_FAILING_TESTS } from '../testing/testOutputParser';
import { err, ok, type Result } from '../util/result';
import {
  BACKEND_MESSAGE_TYPES,
  ERROR_CODES,
  MAX_AMBIGUOUS_MATCHES,
  MAX_SPEECH_CHARS,
  MAX_UTTERANCE_CHARS,
  PROTOCOL_VERSION,
} from './constants';
import type { ErrorCode, ProtocolMessage } from './messages';

/**
 * Runtime Zod schemas for the extension host <-> backend protocol. messages.ts owns the types;
 * the compile-time checks below keep the two descriptions identical.
 *
 * Every message schema is strict (extra properties are rejected, never stripped) and requires
 * `version` to be exactly 1. The one deliberate exception is the action envelope: the protocol
 * layer only requires an object with a string `type` and keeps all other properties, because
 * strict allow-list checking belongs to ActionValidator, not to this file.
 */

const version = z.literal(PROTOCOL_VERSION);
const text = z.string();
const id = z.string();

// --- shared payloads ---

/** Absolute POSIX, Windows-drive and UNC paths never belong on the wire. */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/;
const relativePath = z.string().refine((value) => !ABSOLUTE_PATH.test(value), {
  message: 'must be a workspace-relative path',
});

const pos = z.strictObject({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
});

const codeExcerpt = z.strictObject({
  source: z.enum(['selection', 'symbol', 'cursor_window']),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  text: z.string().max(MAX_CONTEXT_EXCERPT_CHARS),
  truncated: z.boolean(),
});

const diagnosticInfo = z.strictObject({
  severity: z.enum(['error', 'warning', 'information', 'hint']),
  relativePath,
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  message: z.string().max(MAX_DIAGNOSTIC_MESSAGE_CHARS),
  source: z.string().optional(),
  code: z.string().optional(),
  symbolName: z.string().nullable().optional(),
});

const count = z.number().int().min(0);

/** The wire form of IDEContext: no `activeFile`, and strict, so one cannot be smuggled in. */
export const wireContextSchema = z.strictObject({
  workspace: z.strictObject({ name: z.string().nullable(), rootCount: count }),
  relativePath: relativePath.nullable(),
  languageId: z.string().nullable(),
  cursor: pos.nullable(),
  selection: z.union([
    z.strictObject({ isEmpty: z.literal(true) }),
    z.strictObject({ isEmpty: z.literal(false), start: pos, end: pos }),
  ]).nullable(),
  nearbyCode: codeExcerpt.nullable(),
  currentSymbol: z.strictObject({
    name: z.string(),
    kind: z.string(),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  }).nullable(),
  symbolStatus: z.enum(['found', 'none_enclosing', 'provider_unavailable', 'no_editor']),
  diagnostics: z.array(diagnosticInfo).max(MAX_DIAGNOSTICS_SENT),
  diagnosticCounts: z.strictObject({
    error: count,
    warning: count,
    information: count,
    hint: count,
  }),
});

const userUtterance = z.strictObject({
  text: z.string().max(MAX_UTTERANCE_CHARS),
  source: z.enum(['typed', 'voice']).optional(),
});

const testRunSummary = z.strictObject({
  outcome: z.enum([
    'passed',
    'failed',
    'completed_unparsed',
    'did_not_execute',
    'timed_out',
    'cancelled',
    'not_configured',
  ]),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  passed: count.nullable(),
  failed: count.nullable(),
  totalFailedNames: count,
  failingTests: z.array(z.strictObject({
    name: z.string(),
    messageExcerpt: z.string().optional(),
  })).max(MAX_FAILING_TESTS),
  outputTruncated: z.boolean(),
  durationMs: z.number().min(0),
});

const actionResultDetails = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file_opened'), relativePath }),
  z.strictObject({
    kind: z.literal('diagnostic_reached'),
    relativePath,
    line: z.number().int().min(1),
    severity: z.string(),
    message: z.string(),
    symbol: z.string().optional(),
    wrapped: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal('location_reached'),
    relativePath,
    line: z.number().int().min(1),
  }),
  z.strictObject({
    kind: z.literal('ambiguous_files'),
    matches: z.array(relativePath).max(MAX_AMBIGUOUS_MATCHES),
    totalMatches: count,
  }),
  z.strictObject({ kind: z.literal('test_run'), summary: testRunSummary }),
]);

const actionResult = z.strictObject({
  actionType: z.string(),
  status: z.enum([
    'ok',
    'failed',
    'declined',
    'not_permitted',
    'needs_clarification',
    'not_configured',
  ]),
  message: z.string(),
  details: actionResultDetails.optional(),
});

/** Object with a string `type`; every other property is kept for ActionValidator. */
const actionEnvelope = z.looseObject({ type: z.string() });

const capabilities = z.strictObject({
  bedrock: z.boolean(),
  stt: z.boolean(),
  tts: z.boolean(),
  mic: z.enum(['available', 'unavailable', 'denied', 'not_applicable']),
});

const errorCode = z.enum(ERROR_CODES);

// --- messages ---

export const helloSchema = z.strictObject({
  version,
  type: z.literal('hello'),
  token: z.string().optional(),
  client: z.literal('kirosight-extension'),
});

export const agentRequestSchema = z.strictObject({
  version,
  type: z.literal('agent_request'),
  id,
  kind: z.enum(['utterance', 'summarize_test_run']),
  utterance: userUtterance.optional(),
  context: wireContextSchema,
  testRun: testRunSummary.optional(),
});

export const actionResultMessageSchema = z.strictObject({
  version,
  type: z.literal('action_result'),
  replyTo: id,
  result: actionResult,
});

export const recordStartSchema = z.strictObject({ version, type: z.literal('record_start'), id });
export const recordStopSchema = z.strictObject({ version, type: z.literal('record_stop'), id });

/**
 * One audio frame. A whole recording may be one frame without `seq`/`final`, or an ordered series
 * of frames that share `id`: `seq` counts from 0 and `final: true` ends the recording. The two
 * fields travel together, so a frame never carries one without the other.
 */
export const audioClipSchema = z
  .strictObject({
    version,
    type: z.literal('audio_clip'),
    id,
    mimeType: text,
    base64: text,
    seq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    final: z.boolean().optional(),
  })
  .refine((clip) => (clip.seq === undefined) === (clip.final === undefined), {
    message: 'seq and final must be given together',
    path: ['seq'],
  });

export const speechRequestSchema = z.strictObject({
  version,
  type: z.literal('speech_request'),
  id,
  replyTo: id.optional(),
  text,
});

export const cancelSchema = z.strictObject({
  version,
  type: z.literal('cancel'),
  targetId: id,
});

export const helloAckSchema = z.strictObject({
  version,
  type: z.literal('hello_ack'),
  supportedVersions: z.array(z.number().int()),
  capabilities,
});

export const agentResponseSchema = z.strictObject({
  version,
  type: z.literal('agent_response'),
  replyTo: id,
  speech: z.string().max(MAX_SPEECH_CHARS),
  action: actionEnvelope,
  confirmationRequired: z.boolean(),
});

export const actionRequestSchema = z.strictObject({
  version,
  type: z.literal('action_request'),
  id,
  action: actionEnvelope,
  reason: text,
});

export const transcriptionResultSchema = z.strictObject({
  version,
  type: z.literal('transcription_result'),
  replyTo: id,
  text,
});

export const speechAudioSchema = z.strictObject({
  version,
  type: z.literal('speech_audio'),
  replyTo: id,
  mimeType: text,
  base64: text,
});

export const errorMessageSchema = z.strictObject({
  version,
  type: z.literal('error_message'),
  replyTo: id.optional(),
  code: errorCode,
  message: text,
  recoverable: z.boolean(),
});

export const protocolMessageSchema = z.discriminatedUnion('type', [
  helloSchema,
  agentRequestSchema,
  actionResultMessageSchema,
  recordStartSchema,
  recordStopSchema,
  audioClipSchema,
  speechRequestSchema,
  cancelSchema,
  helloAckSchema,
  agentResponseSchema,
  actionRequestSchema,
  transcriptionResultSchema,
  speechAudioSchema,
  errorMessageSchema,
]);

/** Compile-time guard: schema output and the messages.ts types are mutually assignable. */
type Parsed = z.infer<typeof protocolMessageSchema>;
type SameShape = [Parsed] extends [ProtocolMessage]
  ? [ProtocolMessage] extends [Parsed] ? true : never
  : never;
export const protocolTypesMatchSchemas: SameShape = true;

// --- public validation API ---

/** Stable, safe failure categories. They reuse the design's ErrorCode names. */
export interface ProtocolValidationError {
  readonly code: Extract<ErrorCode, 'VALIDATION_FAILED' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_TYPE'>;
  readonly message: string;
  /** Schema paths of the first few problems. Never payload values or unknown property names. */
  readonly paths: readonly string[];
}

const MAX_REPORTED_PATHS = 5;
const MAX_PATH_CHARS = 100;
const KNOWN_TYPES: readonly string[] = BACKEND_MESSAGE_TYPES;

function fail(
  code: ProtocolValidationError['code'],
  message: string,
  paths: readonly string[] = [],
): Result<never, ProtocolValidationError> {
  return err({ code, message, paths });
}

function summarizePaths(issues: readonly z.core.$ZodIssue[]): string[] {
  const paths: string[] = [];
  for (const issue of issues) {
    const path = issue.path.map((segment) => String(segment)).join('.').slice(0, MAX_PATH_CHARS);
    if (!paths.includes(path)) {
      paths.push(path === '' ? '(message)' : path);
    }
    if (paths.length >= MAX_REPORTED_PATHS) break;
  }
  return paths;
}

/**
 * Validates one decoded backend-protocol message. Never throws for any input and never echoes
 * the offending payload. Strict action validation is NOT performed here: `action` objects only
 * need a string `type`, and ActionValidator must still check them before anything runs.
 */
export function validateProtocolMessage(raw: unknown): Result<ProtocolMessage, ProtocolValidationError> {
  try {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return fail('VALIDATION_FAILED', 'Message must be an object.');
    }

    const candidate = raw as { version?: unknown; type?: unknown };
    if (!('version' in candidate) || candidate.version === undefined) {
      return fail('VALIDATION_FAILED', 'Message is missing a version.', ['version']);
    }
    if (candidate.version !== PROTOCOL_VERSION) {
      return fail('UNSUPPORTED_VERSION', 'Unsupported protocol version.', ['version']);
    }
    if (typeof candidate.type !== 'string') {
      return fail('VALIDATION_FAILED', 'Message is missing a string type.', ['type']);
    }
    if (!KNOWN_TYPES.includes(candidate.type)) {
      return fail('UNKNOWN_TYPE', 'Unknown message type.', ['type']);
    }

    const parsed = protocolMessageSchema.safeParse(raw);
    return parsed.success
      ? ok(parsed.data)
      : fail('VALIDATION_FAILED', 'Message does not match its schema.', summarizePaths(parsed.error.issues));
  } catch {
    return fail('VALIDATION_FAILED', 'Message could not be validated.');
  }
}
