import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BACKEND_MESSAGE_TYPES } from '../../src/protocol/constants';
import { validateProtocolMessage, type ProtocolValidationError } from '../../src/protocol/validators';

/**
 * Task 6.11 / Property 8: invalid protocol messages are rejected without dispatch (TypeScript side).
 *
 * Every invalid input is a VALID shared fixture plus ONE controlled mutation that violates the
 * accepted schema by construction (replacement values come from pools that can never be valid for
 * the targeted field). Each property asserts that validation fails, that a test-only dispatch
 * sentinel was never called, and the stable error category where the validator defines one.
 * Nothing here imports or calls the allow-list or any action code.
 */

const NUM_RUNS = 100;
const FIXTURES = resolve(__dirname, '../../src/protocol/fixtures/messages');
const VF = 'VALIDATION_FAILED';
const UV = 'UNSUPPORTED_VERSION';
const UT = 'UNKNOWN_TYPE';

type Message = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Draw = <T>(arbitrary: fc.Arbitrary<T>) => T;
type Mutation = { name: string; apply: (message: Message, draw: Draw) => void; code: string };

/** `fc.gen()` hands out `g(builder, ...args)`; this adapts it to drawing from an arbitrary instance. */
function asDraw(g: (builder: () => fc.Arbitrary<unknown>) => unknown): Draw {
  return <T>(arbitrary: fc.Arbitrary<T>): T => g(() => arbitrary) as T;
}

// --- test-only dispatch sentinel ---

class Dispatcher {
  public count = 0;
  public dispatch(_message: unknown): void {
    this.count += 1;
  }
}

function validateThenDispatch(raw: unknown, dispatcher: Dispatcher) {
  const result = validateProtocolMessage(raw); // called directly: a throw fails the property
  if (result.ok) dispatcher.dispatch(result.value);
  return result;
}

function assertRejected(raw: unknown, expectedCode?: string): ProtocolValidationError {
  const dispatcher = new Dispatcher();
  const result = validateThenDispatch(raw, dispatcher);
  expect(result.ok, 'an invalid message was accepted').toBe(false);
  expect(dispatcher.count, 'an invalid message was dispatched').toBe(0);
  if (result.ok) throw new Error('unreachable: accepted an invalid message');
  if (expectedCode !== undefined) expect(result.error.code).toBe(expectedCode);
  return result.error;
}

// --- fixtures and value pools ---

const fixtureCache = new Map<string, Message>();
function fixture(name: string): Message {
  if (!fixtureCache.has(name)) {
    fixtureCache.set(name, JSON.parse(readFileSync(resolve(FIXTURES, `${name}.json`), 'utf8')));
  }
  return structuredClone(fixtureCache.get(name)!);
}

function textOf(alphabet: string, minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc.array(fc.constantFrom(...alphabet), { minLength, maxLength }).map((chars) => chars.join(''));
}

const word = textOf('abcdefghijklmnopqrstuvwxyz', 1, 8);
const number = fc.integer({ min: 1, max: 40 });
const unknownString = word.map((value) => `~${value}`); // '~' starts no valid enum or literal
const text = textOf('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.', 0, 12);
const finiteDouble = fc.double({ noNaN: true, noDefaultInfinity: true });
const smallInt = fc.integer({ min: -1000, max: 1000 });
const smallList = fc.array(smallInt, { maxLength: 2 });
const smallDict = fc.dictionary(word, smallInt, { maxKeys: 2 });
const nonStr = fc.oneof(fc.constant(null), fc.boolean(), smallInt, finiteDouble, smallList, smallDict);
const nonStrScalar = fc.oneof(fc.constant(null), fc.boolean(), smallInt, finiteDouble);
const nonBoolScalar = fc.oneof(fc.constant(null), text, smallInt, finiteDouble);
const nonObject = fc.oneof(fc.constant(null), fc.boolean(), smallInt, finiteDouble, text, smallList);
const nonList = fc.oneof(fc.constant(null), fc.boolean(), smallInt, finiteDouble, text, smallDict);
const absolutePath = fc
  .tuple(fc.constantFrom('/', 'C:\\', 'c:/', 'Z:\\', '\\\\'), word)
  .map(([prefix, value]) => prefix + value);
const fractional = number.map((value) => value + 0.5); // never an integer
const nonPositive = fc.integer({ min: -10_000, max: 0 });
const negative = fc.integer({ min: -10_000, max: -1 });

type FieldKind = 'str' | 'bool' | 'obj' | 'arr' | 'enum';
const WRONG_VALUE: Record<FieldKind, fc.Arbitrary<unknown>> = {
  str: nonStr,
  bool: fc.oneof(fc.constant(null), text, smallInt, finiteDouble, smallList, smallDict),
  obj: nonObject,
  arr: nonList,
  enum: fc.oneof(nonStr, unknownString),
};

const REQUIRED: Record<string, Record<string, FieldKind>> = {
  hello: { client: 'enum' },
  hello_ack: { supportedVersions: 'arr', capabilities: 'obj' },
  agent_request: { id: 'str', kind: 'enum', context: 'obj' },
  agent_response: { replyTo: 'str', speech: 'str', action: 'obj', confirmationRequired: 'bool' },
  action_request: { id: 'str', action: 'obj', reason: 'str' },
  action_result: { replyTo: 'str', result: 'obj' },
  record_start: { id: 'str' },
  record_stop: { id: 'str' },
  audio_clip: { id: 'str', mimeType: 'str', base64: 'str' },
  transcription_result: { replyTo: 'str', text: 'str' },
  speech_request: { id: 'str', text: 'str' },
  speech_audio: { replyTo: 'str', mimeType: 'str', base64: 'str' },
  cancel: { targetId: 'str' },
  error_message: { code: 'enum', message: 'str', recoverable: 'bool' },
};

const EXTRA_KEYS = ['command', 'shell', 'debug', 'unexpected', 'seq', 'final', 'activeFile'];
const KNOWN_TYPES: readonly string[] = BACKEND_MESSAGE_TYPES;

// The supported version is the JSON NUMBER 1 (1, 1.0, 1e0 all decode to 1). Every pool member below
// is invalid by construction: numbers are filtered to be !== 1, and booleans, strings, null and
// containers are never the number 1.
const wrongVersion = fc.oneof(
  smallInt.filter((value) => value !== 1),
  fc.integer({ min: 2 ** 40, max: Number.MAX_SAFE_INTEGER }),
  text,
  finiteDouble.filter((value) => value !== 1),
  fc.boolean(),
  fc.constant(null),
  smallList,
  smallDict,
);

// --- generic mutations, applicable to every message type ---

function genericMutations(messageType: string): Mutation[] {
  const required = REQUIRED[messageType];
  const names = Object.keys(required).sort();
  return [
    { name: 'remove_version', code: VF, apply: (m) => void delete m.version },
    { name: 'wrong_version', code: UV, apply: (m, g) => void (m.version = g(wrongVersion)) },
    { name: 'remove_type', code: VF, apply: (m) => void delete m.type },
    { name: 'non_string_type', code: VF, apply: (m, g) => void (m.type = g(nonStr)) },
    {
      name: 'unknown_type',
      code: UT,
      apply: (m, g) => void (m.type = g(word.filter((value) => !KNOWN_TYPES.includes(value)))),
    },
    {
      name: 'extra_top_level_field',
      code: VF,
      apply: (m, g) => {
        let key = g(fc.oneof(fc.constantFrom(...EXTRA_KEYS), word));
        if (key in m) key += '_x';
        m[key] = g(fc.oneof(nonStr, text));
      },
    },
    { name: 'remove_required_field', code: VF, apply: (m, g) => void delete m[g(fc.constantFrom(...names))] },
    {
      name: 'wrong_required_field_type',
      code: VF,
      apply: (m, g) => {
        const field = g(fc.constantFrom(...names));
        m[field] = g(WRONG_VALUE[required[field]]);
      },
    },
  ];
}

// --- malformed action envelopes (unknown action NAMES are not malformed) ---

const badAction = fc.oneof(
  fc.constant(null),
  text,
  smallInt,
  fc.boolean(),
  smallList,
  fc.constant({}),
  nonStr.map((value) => ({ type: value })),
  fc.dictionary(word.filter((key) => key !== 'type'), smallInt, { minKeys: 1, maxKeys: 2 }),
);

// --- test run summary ---

const VALID_TEST_RUN: Message = {
  outcome: 'failed',
  command: 'npm test',
  exitCode: 1,
  passed: 3,
  failed: 1,
  totalFailedNames: 1,
  failingTests: [{ name: 'sample test', messageExcerpt: 'expected 1' }],
  outputTruncated: false,
  durationMs: 1200,
};
const SUMMARY_REQUIRED = [
  'outcome', 'command', 'exitCode', 'passed', 'failed', 'totalFailedNames',
  'failingTests', 'outputTruncated', 'durationMs',
]; // prettier-ignore

type Local = (target: Message, draw: Draw) => void;

const COUNT_FIELDS = ['passed', 'failed', 'totalFailedNames'];
const SUMMARY_MUTATIONS: [string, Local][] = [
  ['unknown_outcome', (s, g) => void (s.outcome = g(fc.oneof(unknownString, nonStr)))],
  ['negative_count', (s, g) => void (s[g(fc.constantFrom(...COUNT_FIELDS))] = g(negative))],
  ['fractional_count', (s, g) => void (s[g(fc.constantFrom(...COUNT_FIELDS))] = g(fractional))],
  [
    'wrong_type_count',
    (s, g) => void (s[g(fc.constantFrom(...COUNT_FIELDS))] = g(fc.oneof(text, fc.boolean(), smallList))),
  ],
  [
    'too_many_failing_tests',
    (s, g) => void (s.failingTests = Array.from({ length: 20 + g(number) }, () => ({ name: 't' }))),
  ],
  ['failing_test_missing_name', (s) => void (s.failingTests = [{ messageExcerpt: 'x' }])],
  ['failing_test_name_wrong_type', (s, g) => void (s.failingTests = [{ name: g(nonStr) }])],
  ['failing_test_extra_field', (s, g) => void (s.failingTests = [{ name: 't', [`x${g(word)}`]: g(smallInt) }])],
  ['excerpt_wrong_type', (s, g) => void (s.failingTests = [{ name: 't', messageExcerpt: g(nonStr) }])],
  ['failing_tests_not_a_list', (s, g) => void (s.failingTests = g(nonList))],
  ['command_wrong_type', (s, g) => void (s.command = g(nonStr))],
  ['exit_code_wrong', (s, g) => void (s.exitCode = g(fc.oneof(text, fc.boolean(), fractional)))],
  [
    'duration_negative',
    (s, g) => void (s.durationMs = g(fc.double({ max: -0.5, noNaN: true, noDefaultInfinity: true }))),
  ],
  ['duration_wrong_type', (s, g) => void (s.durationMs = g(fc.oneof(text, fc.boolean(), fc.constant(null))))],
  ['truncated_wrong_type', (s, g) => void (s.outputTruncated = g(nonBoolScalar))],
  ['summary_extra_field', (s, g) => void (s[`x${g(word)}`] = g(smallInt))],
  ['summary_missing_field', (s, g) => void delete s[g(fc.constantFrom(...SUMMARY_REQUIRED))]],
];

function applySummaryMutation(summary: Message, g: Draw): void {
  const [, mutate] = g(fc.constantFrom(...SUMMARY_MUTATIONS));
  mutate(summary, g);
}

// --- IDEContext ---

const SEVERITY_COUNTS = ['error', 'warning', 'information', 'hint'];
const diag = (c: Message): Message => c.diagnostics[0];
const set =
  (getTarget: (c: Message) => Message, key: string, value: fc.Arbitrary<unknown>): Local =>
  (c, g) =>
    void (getTarget(c)[key] = g(value));
const same = (c: Message): Message => c;

const CONTEXT_MUTATIONS: [string, Local][] = [
  ['absolute_relative_path', set(same, 'relativePath', absolutePath)],
  ['absolute_diagnostic_path', set(diag, 'relativePath', absolutePath)],
  ['cursor_line_not_positive', set((c) => c.cursor, 'line', nonPositive)],
  ['cursor_column_not_positive', set((c) => c.cursor, 'column', nonPositive)],
  ['cursor_fractional', set((c) => c.cursor, 'line', fractional)],
  ['cursor_wrong_type', set((c) => c.cursor, 'column', fc.oneof(text, fc.boolean(), fc.constant(null)))],
  [
    'selection_bad_shape',
    (c, g) =>
      void (c.selection = g(
        fc.constantFrom<unknown>(
          { isEmpty: 'yes' },
          { isEmpty: false },
          { isEmpty: true, start: { line: 1, column: 1 } },
          { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } },
          5,
          'x',
          [],
        ),
      )),
  ],
  ['nearby_text_too_long', (c, g) => void (c.nearbyCode.text = 'x'.repeat(6000 + g(number)))],
  ['nearby_unknown_source', set((c) => c.nearbyCode, 'source', unknownString)],
  ['nearby_truncated_wrong_type', set((c) => c.nearbyCode, 'truncated', nonBoolScalar)],
  ['nearby_start_line_zero', set((c) => c.nearbyCode, 'startLine', nonPositive)],
  ['nearby_extra_field', (c, g) => void (c.nearbyCode[`x${g(word)}`] = g(smallInt))],
  ['symbol_missing_name', (c) => void delete c.currentSymbol.name],
  ['symbol_kind_wrong_type', set((c) => c.currentSymbol, 'kind', nonStr)],
  ['symbol_line_not_positive', set((c) => c.currentSymbol, 'startLine', nonPositive)],
  ['unknown_symbol_status', set(same, 'symbolStatus', fc.oneof(unknownString, nonStr))],
  [
    'too_many_diagnostics',
    (c, g) => void (c.diagnostics = Array.from({ length: 25 + g(number) }, () => structuredClone(diag(c)))),
  ],
  ['diagnostic_bad_severity', set(diag, 'severity', fc.oneof(unknownString, nonStr))],
  ['diagnostic_message_too_long', (c, g) => void (diag(c).message = 'x'.repeat(500 + g(number)))],
  ['diagnostic_line_not_positive', set(diag, 'line', nonPositive)],
  ['diagnostic_extra_field', (c, g) => void (diag(c)[`x${g(word)}`] = g(smallInt))],
  ['diagnostic_source_null', (c) => void (diag(c).source = null)],
  ['diagnostic_code_wrong_type', set(diag, 'code', nonStr)],
  [
    'counts_negative',
    (c, g) => void (c.diagnosticCounts[g(fc.constantFrom(...SEVERITY_COUNTS))] = g(negative)),
  ],
  ['counts_missing_key', (c, g) => void delete c.diagnosticCounts[g(fc.constantFrom(...SEVERITY_COUNTS))]],
  ['counts_extra_key', (c, g) => void (c.diagnosticCounts[`x${g(word)}`] = g(smallInt))],
  ['counts_fractional', set((c) => c.diagnosticCounts, 'error', fractional)],
  ['workspace_root_negative', set((c) => c.workspace, 'rootCount', negative)],
  ['workspace_name_wrong_type', set((c) => c.workspace, 'name', fc.oneof(smallInt, fc.boolean(), smallList))],
  ['workspace_extra_field', (c, g) => void (c.workspace[`x${g(word)}`] = g(smallInt))],
  [
    'absolute_path_field',
    (c, g) =>
      void (c[g(fc.constantFrom('activeFile', 'fsPath', 'absolutePath', 'workspaceRootPath'))] = g(text)),
  ],
  ['context_extra_field', (c, g) => void (c[`x${g(word)}`] = g(smallInt))],
  [
    'context_missing_field',
    (c, g) =>
      void delete c[
        g(
          fc.constantFrom(
            'workspace', 'relativePath', 'languageId', 'cursor', 'selection', 'nearbyCode',
            'currentSymbol', 'symbolStatus', 'diagnostics', 'diagnosticCounts',
          ), // prettier-ignore
        )
      ],
  ],
];

function contextMutation(message: Message, g: Draw): void {
  const [, mutate] = g(fc.constantFrom(...CONTEXT_MUTATIONS));
  mutate(message.context, g);
}

// --- action_result details ---

const DETAILS_BASES: Record<string, Message> = {
  file_opened: { kind: 'file_opened', relativePath: 'src/a.ts' },
  diagnostic_reached: {
    kind: 'diagnostic_reached',
    relativePath: 'src/a.ts',
    line: 3,
    severity: 'error',
    message: 'm',
    symbol: 's',
    wrapped: false,
  },
  location_reached: { kind: 'location_reached', relativePath: 'src/a.ts', line: 3 },
  ambiguous_files: { kind: 'ambiguous_files', matches: ['a/x.ts', 'b/x.ts'], totalMatches: 2 },
  test_run: { kind: 'test_run', summary: VALID_TEST_RUN },
};

function detailsMutation(message: Message, g: Draw): void {
  const kind = g(fc.constantFrom(...Object.keys(DETAILS_BASES).sort()));
  const x = structuredClone(DETAILS_BASES[kind]);
  const perKind: Record<string, (() => void)[]> = {
    file_opened: [
      () => void delete x.relativePath,
      () => void (x.relativePath = g(absolutePath)),
      () => void (x.relativePath = g(nonStr)),
    ],
    diagnostic_reached: [
      () => void (x.wrapped = g(nonBoolScalar)),
      () => void (x.symbol = g(nonStr)),
      () => void (x.line = g(nonPositive)),
      () => void (x.severity = g(nonStr)),
      () => void (x.message = g(nonStr)),
      () => void (x.relativePath = g(absolutePath)),
      () => void delete x.line,
    ],
    location_reached: [
      () => void (x.line = g(nonPositive)),
      () => void (x.line = g(fractional)),
      () => void (x.relativePath = g(absolutePath)),
    ],
    ambiguous_files: [
      () => void (x.matches = Array.from({ length: 10 + g(number) }, (_, i) => `f${i}.ts`)),
      () => void (x.matches = ['ok.ts', g(absolutePath)]),
      () => void (x.matches = g(nonList)),
      () => void (x.totalMatches = g(negative)),
      () => void (x.totalMatches = g(fractional)),
      () => void delete x.matches,
    ],
    test_run: [
      () => applySummaryMutation(x.summary, g),
      () => void delete x.summary,
      () => void (x.summary = g(nonObject)),
    ],
  };
  const choices = perKind[kind];
  message.result.details = x; // set first: the generic "not an object" case replaces it below
  const pick = g(fc.integer({ min: 0, max: choices.length + 2 }));
  if (pick < choices.length) {
    choices[pick]();
  } else if (pick === choices.length) {
    x[`x${g(word)}`] = g(smallInt);
  } else if (pick === choices.length + 1) {
    x.kind = g(fc.oneof(unknownString, nonStr));
  } else {
    message.result.details = g(nonObject);
  }
}

function resultMutation(message: Message, g: Draw): void {
  const result = message.result;
  switch (g(fc.integer({ min: 0, max: 9 }))) {
    case 0:
      message.result = g(nonObject);
      break;
    case 1:
      result.status = g(fc.oneof(unknownString, nonStr));
      break;
    case 2:
      delete result[g(fc.constantFrom('actionType', 'status', 'message'))];
      break;
    case 3:
      result.actionType = g(nonStr);
      break;
    case 4:
      result.message = g(nonStr);
      break;
    case 5:
      result[`x${g(word)}`] = g(smallInt);
      break;
    case 6:
      result.details = null; // optional but not nullable
      break;
    case 7:
      result.details = g(nonObject);
      break;
    default:
      detailsMutation(message, g);
  }
}

// --- per-type specific mutations ---

function agentRequestWithTestRun(): Message {
  const message = fixture('agent_request');
  message.kind = 'summarize_test_run';
  message.testRun = structuredClone(VALID_TEST_RUN);
  return message;
}

const ERROR_CODES = new Set([
  'VALIDATION_FAILED', 'UNSUPPORTED_VERSION', 'UNKNOWN_TYPE', 'UNAUTHORIZED', 'BEDROCK_UNAVAILABLE',
  'BEDROCK_INVALID_RESPONSE', 'STT_UNAVAILABLE', 'STT_NO_SPEECH', 'TTS_UNAVAILABLE', 'MIC_UNAVAILABLE',
  'MIC_DENIED', 'CREDENTIAL_MISSING', 'TIMEOUT', 'CANCELLED', 'INTERNAL',
]); // prettier-ignore

function specificMutations(messageType: string): Mutation[] {
  const m = (name: string, apply: Mutation['apply']): Mutation => ({ name, apply, code: VF });
  const actionMutation: Mutation['apply'] = (x, g) => void (x.action = g(badAction));
  switch (messageType) {
    case 'hello':
      return [
        m('client_not_the_literal', (x, g) => void (x.client = g(fc.oneof(unknownString, nonStr)))),
        m('token_wrong_type', (x, g) => void (x.token = g(nonStr))),
      ];
    case 'hello_ack':
      return [
        m('supported_versions_bad_elements', (x, g) =>
          void (x.supportedVersions = g(
            fc.constantFrom<unknown>(['1'], [true], [1.5], [null], [[1]], [1, '2'], '1', { 0: 1 }),
          ))),
        m('capability_flag_wrong_type', (x, g) =>
          void (x.capabilities[g(fc.constantFrom('bedrock', 'stt', 'tts'))] = g(WRONG_VALUE.bool))),
        m('mic_not_a_known_value', (x, g) => void (x.capabilities.mic = g(fc.oneof(unknownString, nonStr)))),
        m('capability_extra_field', (x, g) => void (x.capabilities[`x${g(word)}`] = g(smallInt))),
        m('capability_missing_field', (x, g) =>
          void delete x.capabilities[g(fc.constantFrom('bedrock', 'stt', 'tts', 'mic'))]),
      ];
    case 'agent_request':
      return [
        m('unknown_kind', (x, g) => void (x.kind = g(fc.oneof(unknownString, nonStr)))),
        m('utterance_text_wrong_type', (x, g) => void (x.utterance.text = g(nonStr))),
        m('utterance_text_too_long', (x, g) => void (x.utterance.text = 'x'.repeat(4000 + g(number)))),
        m('utterance_unknown_source', (x, g) => void (x.utterance.source = g(fc.oneof(unknownString, nonStr)))),
        m('utterance_missing_text', (x) => void delete x.utterance.text),
        m('utterance_extra_field', (x, g) => void (x.utterance[`x${g(word)}`] = g(smallInt))),
        m('utterance_null', (x) => void (x.utterance = null)),
        m('utterance_not_an_object', (x, g) => void (x.utterance = g(nonObject))),
        m('context_mutation', contextMutation),
        m('test_run_null', (x) => void (x.testRun = null)),
        m('test_run_not_an_object', (x, g) => void (x.testRun = g(nonObject))),
        m('test_run_mutation', (x, g) => {
          Object.assign(x, agentRequestWithTestRun());
          applySummaryMutation(x.testRun, g);
        }),
      ];
    case 'agent_response':
      return [
        m('speech_too_long', (x, g) => void (x.speech = 'x'.repeat(600 + g(number)))),
        m('action_envelope_malformed', actionMutation),
      ];
    case 'action_request':
      return [m('action_envelope_malformed', actionMutation)];
    case 'action_result':
      return [m('result_mutation', resultMutation)];
    case 'speech_request':
      return [m('reply_to_wrong_type', (x, g) => void (x.replyTo = g(nonStr)))];
    case 'error_message':
      return [
        m('unknown_error_code', (x, g) =>
          void (x.code = g(
            fc.oneof(unknownString, word.map((w) => w.toUpperCase()).filter((c) => !ERROR_CODES.has(c)), nonStr),
          ))),
        m('reply_to_wrong_type', (x, g) => void (x.replyTo = g(nonStr))),
      ];
    default:
      return [];
  }
}

const ALL_MUTATIONS: Record<string, Mutation[]> = Object.fromEntries(
  BACKEND_MESSAGE_TYPES.map((type) => [type, [...genericMutations(type), ...specificMutations(type)]]),
);

/** Replace every string value except top-level `type` with the marker. */
function taint(message: Message, marker: string): void {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return marker;
    if (Array.isArray(value)) return value.map(walk);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    }
    return value;
  };
  for (const key of Object.keys(message)) {
    if (key !== 'type' && key !== 'version') message[key] = walk(message[key]);
  }
}

const jsonLeaf = fc.oneof(fc.constant(null), fc.boolean(), smallInt, finiteDouble, text);
const jsonAny = fc.oneof(
  jsonLeaf,
  fc.array(jsonLeaf, { maxLength: 3 }),
  fc.dictionary(word, jsonLeaf, { maxKeys: 3 }),
  fc.tuple(fc.constantFrom(...BACKEND_MESSAGE_TYPES), fc.dictionary(word, jsonLeaf, { maxKeys: 4 })).map(
    ([type, rest]) => ({ version: 1, type, ...rest }),
  ),
);

// --- properties ---

describe('Property 8: invalid protocol messages are rejected without dispatch', () => {
  it('has a mutation catalog for each of the fourteen message types, built on valid bases', () => {
    expect(BACKEND_MESSAGE_TYPES).toHaveLength(14);
    expect(Object.keys(ALL_MUTATIONS).sort()).toEqual([...BACKEND_MESSAGE_TYPES].sort());
    expect(Object.keys(REQUIRED).sort()).toEqual([...BACKEND_MESSAGE_TYPES].sort());
    for (const type of BACKEND_MESSAGE_TYPES) {
      expect(ALL_MUTATIONS[type].length, type).toBeGreaterThanOrEqual(8);
      expect(validateProtocolMessage(fixture(type)).ok, type).toBe(true);
    }
    expect(validateProtocolMessage(agentRequestWithTestRun()).ok).toBe(true);
  });

  describe.each(BACKEND_MESSAGE_TYPES)('%s', (messageType) => {
    it('rejects one controlled mutation without dispatch', () => {
      fc.assert(
        fc.property(fc.gen(), (gen) => {
          const g = asDraw(gen);
          const mutation = g(fc.constantFrom(...ALL_MUTATIONS[messageType]));
          const message = fixture(messageType);
          mutation.apply(message, g);
          assertRejected(message, mutation.code);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('classifies version problems', () => {
      fc.assert(
        fc.property(fc.gen(), (gen) => {
          const g = asDraw(gen);
          const message = fixture(messageType);
          if (g(fc.boolean())) {
            delete message.version;
            assertRejected(message, VF);
          } else {
            message.version = g(wrongVersion);
            assertRejected(message, UV);
          }
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('classifies an unknown type', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            word.filter((value) => !KNOWN_TYPES.includes(value)),
            word.map((value) => value.toUpperCase()),
            fc.constantFrom('run_command', 'ping', 'ready', 'execute', '', ' hello', 'hello '),
            fc.constantFrom(...BACKEND_MESSAGE_TYPES).map((type) => `${type}_x`),
          ),
          (type) => {
            const message = fixture(messageType);
            message.type = type;
            assertRejected(message, UT);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });

    it('rejects a missing or non-string type', () => {
      fc.assert(
        fc.property(fc.gen(), (gen) => {
          const g = asDraw(gen);
          const message = fixture(messageType);
          if (g(fc.boolean())) delete message.type;
          else message.type = g(nonStr);
          assertRejected(message, VF);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('rejects any extra top-level field', () => {
      fc.assert(
        fc.property(fc.oneof(fc.constantFrom(...EXTRA_KEYS), word), fc.oneof(nonStr, text), (key, value) => {
          const message = fixture(messageType);
          message[key in message ? `${key}_x` : key] = value;
          assertRejected(message, VF);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('never echoes payload values or unknown property names in the error', () => {
      fc.assert(
        fc.property(fc.gen(), word, (gen, markerWord) => {
          const g = asDraw(gen);
          const marker = `ZQMK${markerWord}QZ`;
          const mutation = g(fc.constantFrom(...ALL_MUTATIONS[messageType]));
          const message = fixture(messageType);
          taint(message, marker);
          mutation.apply(message, g);
          message[`key_${marker}`] = marker; // an unexpected property: name and value are the marker
          const error = assertRejected(message);
          const shown = JSON.stringify(error);
          expect(shown).not.toContain(marker);
          expect(shown).not.toContain('ZQMK');
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  it('rejects non-object input', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(null), fc.boolean(), smallInt, finiteDouble, text, smallList),
        (raw) => void assertRejected(raw, VF),
      ),
      { numRuns: NUM_RUNS },
    );
  });

  describe.each(['agent_response', 'action_request'])('%s action envelope', (messageType) => {
    it('rejects malformed envelopes', () => {
      fc.assert(
        fc.property(badAction, (action) => {
          const message = fixture(messageType);
          message.action = action;
          assertRejected(message, VF);
        }),
        { numRuns: NUM_RUNS },
      );
    });

    it('does not treat unknown action names as protocol errors (positive control)', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constantFrom('RUN_COMMAND', 'GO_TO_SYMBOL', 'UNKNOWN_ACTION_FROM_MODEL'),
            word.map((value) => value.toUpperCase()),
          ),
          fc.dictionary(word.filter((key) => key !== 'type'), smallInt, { maxKeys: 2 }),
          text,
          (name, extras, command) => {
            const message = fixture(messageType);
            message.action = { ...extras, type: name };
            const dispatcher = new Dispatcher();
            expect(validateThenDispatch(message, dispatcher).ok).toBe(true);
            expect(dispatcher.count).toBe(1);

            message.action = { type: 'RUN_TESTS', command };
            expect(validateProtocolMessage(message).ok).toBe(true);
          },
        ),
        { numRuns: NUM_RUNS },
      );
    });
  });

  describe.each(BACKEND_MESSAGE_TYPES)('%s numeric-one version (positive control)', (messageType) => {
    it('is protocol-valid, so it WOULD reach the dispatch sentinel', () => {
      fc.assert(
        fc.property(fc.constantFrom('1', '1.0', '1.00', '1e0'), (spelling) => {
          const message = JSON.parse(JSON.stringify(fixture(messageType)).replace('"version":1', `"version":${spelling}`));
          const dispatcher = new Dispatcher();
          const result = validateThenDispatch(message, dispatcher);
          expect(result.ok).toBe(true);
          expect(dispatcher.count).toBe(1);
          if (result.ok) expect(result.value.version).toBe(1);
        }),
        { numRuns: NUM_RUNS },
      );
    });
  });

  it('never throws for arbitrary JSON and dispatches only what parsed', () => {
    // No invalidity assumption: this only proves the public validator returns and that nothing is
    // dispatched unless validation succeeded.
    fc.assert(
      fc.property(jsonAny, (raw) => {
        const dispatcher = new Dispatcher();
        const result = validateThenDispatch(raw, dispatcher);
        expect(dispatcher.count).toBe(result.ok ? 1 : 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
