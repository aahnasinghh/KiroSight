import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BACKEND_MESSAGE_TYPES, ERROR_CODES } from '../../src/protocol/constants';
import { validateProtocolMessage } from '../../src/protocol/validators';

/**
 * Task 6.10 / Property 7: protocol messages round-trip (TypeScript side).
 *
 * For every generated VALID message of each of the 14 types:
 *   validate -> JSON.stringify -> JSON.parse -> validate
 * Both validations must succeed and the two validated values must be deeply equal. Only valid
 * messages are generated; malformed input belongs to Property 8 (Task 6.11).
 */

const NUM_RUNS = 100;

// --- building blocks (bounded, synthetic, no credential-shaped values) ---

const SAFE_ALPHABET = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.,:;!?()éß日'];

function textOf(alphabet: readonly string[], minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...alphabet), { minLength, maxLength }).map((chars) => chars.join(''));
}

const safeText = textOf(SAFE_ALPHABET, 0, 40);
const ident = textOf([...'abcdefghijklmnopqrstuvwxyz0123456789-_'], 1, 24);
const mime = fc.constantFrom('audio/webm', 'audio/mpeg', 'audio/wav', 'audio/ogg;codecs=opus');
const base64Like = textOf([...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='], 0, 24);

/** Record where `optional` keys are sometimes absent (never present as undefined). */
function withOptional(
  required: Record<string, fc.Arbitrary<unknown>>,
  optional: Record<string, fc.Arbitrary<unknown>> = {},
): fc.Arbitrary<Record<string, unknown>> {
  return fc.record({ ...required, ...optional }, { requiredKeys: Object.keys(required) }) as fc.Arbitrary<
    Record<string, unknown>
  >;
}

/** +0 and -0 are different to toEqual but identical after JSON, so never generate -0. */
const noNegativeZero = (value: number): number => (Object.is(value, -0) ? 0 : value);

const pathSegment = textOf([...'abcdefghijklmnopqrstuvwxyz0123456789_-.'], 1, 8);
const relativePath = fc.array(pathSegment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
const positive = fc.integer({ min: 1, max: 10_000 });
const count = fc.integer({ min: 0, max: 1_000 });
const pos = fc.record({ line: positive, column: positive });

// --- WireIDEContext ---

const diagnostic = withOptional(
  {
    severity: fc.constantFrom('error', 'warning', 'information', 'hint'),
    relativePath,
    line: positive,
    column: positive,
    message: textOf(SAFE_ALPHABET, 0, 60),
  },
  {
    source: safeText,
    code: safeText,
    symbolName: fc.oneof(fc.constant(null), safeText),
  },
);

const wireContext = fc.record({
  workspace: fc.record({ name: fc.oneof(fc.constant(null), safeText), rootCount: fc.integer({ min: 0, max: 5 }) }),
  relativePath: fc.oneof(fc.constant(null), relativePath),
  languageId: fc.oneof(fc.constant(null), fc.constantFrom('typescript', 'python', 'json')),
  cursor: fc.oneof(fc.constant(null), pos),
  selection: fc.oneof(
    fc.constant(null),
    fc.constant({ isEmpty: true }),
    fc.record({ isEmpty: fc.constant(false), start: pos, end: pos }),
  ),
  nearbyCode: fc.oneof(
    fc.constant(null),
    fc.record({
      source: fc.constantFrom('selection', 'symbol', 'cursor_window'),
      startLine: positive,
      endLine: positive,
      text: textOf([...SAFE_ALPHABET, '\n'], 0, 120),
      truncated: fc.boolean(),
    }),
  ),
  currentSymbol: fc.oneof(
    fc.constant(null),
    fc.record({ name: safeText, kind: safeText, startLine: positive, endLine: positive }),
  ),
  symbolStatus: fc.constantFrom('found', 'none_enclosing', 'provider_unavailable', 'no_editor'),
  diagnostics: fc.array(diagnostic, { maxLength: 4 }),
  diagnosticCounts: fc.record({ error: count, warning: count, information: count, hint: count }),
});

const utterance = withOptional({ text: safeText }, { source: fc.constantFrom('typed', 'voice') });

// --- TestRunSummary ---

const failingTest = withOptional({ name: safeText }, { messageExcerpt: safeText });
const testRunSummary = fc.record({
  outcome: fc.constantFrom(
    'passed',
    'failed',
    'completed_unparsed',
    'did_not_execute',
    'timed_out',
    'cancelled',
    'not_configured',
  ),
  command: safeText,
  exitCode: fc.oneof(fc.constant(null), fc.integer({ min: -255, max: 255 })),
  passed: fc.oneof(fc.constant(null), count),
  failed: fc.oneof(fc.constant(null), count),
  totalFailedNames: count,
  failingTests: fc.array(failingTest, { maxLength: 5 }),
  outputTruncated: fc.boolean(),
  durationMs: fc.oneof(
    fc.integer({ min: 0, max: 1_000_000 }),
    fc.double({ min: 0, max: 1_000_000, noNaN: true }).map(noNegativeZero),
  ),
});

// --- ActionResult ---

const details = fc.oneof(
  fc.record({ kind: fc.constant('file_opened'), relativePath }),
  withOptional(
    {
      kind: fc.constant('diagnostic_reached'),
      relativePath,
      line: positive,
      severity: safeText,
      message: safeText,
    },
    { symbol: safeText, wrapped: fc.boolean() },
  ),
  fc.record({ kind: fc.constant('location_reached'), relativePath, line: positive }),
  fc.record({
    kind: fc.constant('ambiguous_files'),
    matches: fc.array(relativePath, { maxLength: 10 }),
    totalMatches: count,
  }),
  fc.record({ kind: fc.constant('test_run'), summary: testRunSummary }),
);

const APPROVED_ACTIONS = [
  'NO_ACTION',
  'GO_TO_DIAGNOSTIC',
  'NEXT_DIAGNOSTIC',
  'PREVIOUS_DIAGNOSTIC',
  'OPEN_FILE',
  'GO_TO_LINE',
  'FOCUS_EDITOR',
  'RUN_TESTS',
] as const;

const upperName = textOf([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'], 1, 20);
const actionTypeString = fc.oneof(fc.constantFrom(...APPROVED_ACTIONS), upperName, safeText);

const actionResult = withOptional(
  {
    actionType: actionTypeString,
    status: fc.constantFrom('ok', 'failed', 'declined', 'not_permitted', 'needs_clarification', 'not_configured'),
    message: safeText,
  },
  { details },
);

// --- action envelope: an object with a string type; extra fields must survive untouched ---

const extraKey = textOf([...'abcdefghijklmnopqrstuvwxyz'], 1, 8).filter((key) => key !== 'type');
const jsonScalar = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -10_000, max: 10_000 }),
  fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }).map(noNegativeZero),
  safeText,
);
const jsonLevel1 = fc.oneof(
  jsonScalar,
  fc.array(jsonScalar, { maxLength: 3 }),
  fc.dictionary(extraKey, jsonScalar, { maxKeys: 3 }),
);
const jsonValue = fc.oneof(
  jsonLevel1,
  fc.array(jsonLevel1, { maxLength: 3 }),
  fc.dictionary(extraKey, jsonLevel1, { maxKeys: 3 }),
);
const extras = fc.dictionary(extraKey, jsonValue, { maxKeys: 3 });

const actionEnvelope = fc.oneof(
  fc.tuple(fc.constantFrom(...APPROVED_ACTIONS), extras).map(([type, more]) => ({ ...more, type })),
  fc.tuple(upperName, extras).map(([type, more]) => ({ ...more, type })),
  fc.tuple(safeText, extras).map(([command, more]) => ({ ...more, type: 'RUN_TESTS', command })),
  fc.constant({ type: 'NO_ACTION' }),
);

// --- one arbitrary per message type ---

function message(
  type: string,
  required: Record<string, fc.Arbitrary<unknown>>,
  optional: Record<string, fc.Arbitrary<unknown>> = {},
): fc.Arbitrary<Record<string, unknown>> {
  return withOptional({ version: fc.constant(1), type: fc.constant(type), ...required }, optional);
}

const MESSAGE_ARBITRARIES: Record<string, fc.Arbitrary<Record<string, unknown>>> = {
  hello: message('hello', { client: fc.constant('kirosight-extension') }, { token: safeText }),
  hello_ack: message('hello_ack', {
    supportedVersions: fc.array(fc.integer({ min: 1, max: 5 }), { maxLength: 4 }),
    capabilities: fc.record({
      bedrock: fc.boolean(),
      stt: fc.boolean(),
      tts: fc.boolean(),
      mic: fc.constantFrom('available', 'unavailable', 'denied', 'not_applicable'),
    }),
  }),
  agent_request: message(
    'agent_request',
    { id: ident, kind: fc.constantFrom('utterance', 'summarize_test_run'), context: wireContext },
    { utterance, testRun: testRunSummary },
  ),
  agent_response: message('agent_response', {
    replyTo: ident,
    speech: textOf(SAFE_ALPHABET, 0, 120),
    action: actionEnvelope,
    confirmationRequired: fc.boolean(),
  }),
  action_request: message('action_request', { id: ident, action: actionEnvelope, reason: safeText }),
  action_result: message('action_result', { replyTo: ident, result: actionResult }),
  record_start: message('record_start', { id: ident }),
  record_stop: message('record_stop', { id: ident }),
  audio_clip: message('audio_clip', { id: ident, mimeType: mime, base64: base64Like }),
  transcription_result: message('transcription_result', { replyTo: ident, text: safeText }),
  speech_request: message('speech_request', { id: ident, text: safeText }, { replyTo: ident }),
  speech_audio: message('speech_audio', { replyTo: ident, mimeType: mime, base64: base64Like }),
  cancel: message('cancel', { targetId: ident }),
  error_message: message(
    'error_message',
    { code: fc.constantFrom(...ERROR_CODES), message: safeText, recoverable: fc.boolean() },
    { replyTo: ident },
  ),
};

// --- the property ---

function roundTrip(raw: Record<string, unknown>): void {
  const rawSnapshot = structuredClone(raw);

  const first = validateProtocolMessage(raw);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(raw).toEqual(rawSnapshot);

  const firstValue = first.value;
  const firstSnapshot = structuredClone(firstValue);

  const second = validateProtocolMessage(JSON.parse(JSON.stringify(firstValue)));
  expect(second.ok).toBe(true);
  if (!second.ok) return;

  expect(firstValue).toEqual(firstSnapshot);
  expect(second.value.type).toBe(raw.type);
  expect(second.value.version).toBe(1);
  expect(second.value).toEqual(firstValue);
  expect(second.value).toEqual(raw);
}

describe('Property 7: protocol messages round-trip', () => {
  it('has a dedicated generator for each of the fourteen message types', () => {
    expect(BACKEND_MESSAGE_TYPES).toHaveLength(14);
    expect(Object.keys(MESSAGE_ARBITRARIES).sort()).toEqual([...BACKEND_MESSAGE_TYPES].sort());
  });

  describe.each(BACKEND_MESSAGE_TYPES)('%s', (messageType) => {
    it('round-trips through validate, JSON and validate again', () => {
      fc.assert(fc.property(MESSAGE_ARBITRARIES[messageType], (raw) => roundTrip(raw)), {
        numRuns: NUM_RUNS,
      });
    });
  });

  it('round-trips a message drawn from any of the types', () => {
    fc.assert(fc.property(fc.oneof(...Object.values(MESSAGE_ARBITRARIES)), (raw) => roundTrip(raw)), {
      numRuns: NUM_RUNS,
    });
  });

  it('keeps action envelope extras, including a RUN_TESTS command field', () => {
    fc.assert(
      fc.property(MESSAGE_ARBITRARIES.agent_response, (raw) => {
        const first = validateProtocolMessage(raw);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        const second = validateProtocolMessage(JSON.parse(JSON.stringify(first.value)));
        expect(second.ok).toBe(true);
        if (second.ok && second.value.type === 'agent_response') {
          expect(second.value.action).toEqual(raw.action);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
