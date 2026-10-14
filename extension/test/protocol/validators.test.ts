import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { IDEContext } from '../../src/context/editorAdapter';
import { toWireContext } from '../../src/context/contextService';
import { ERROR_CODES } from '../../src/protocol/constants';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { validateAction } from '../../src/actions/actionValidator';

const noEditorContext = {
  workspace: { name: null, rootCount: 0 },
  relativePath: null,
  languageId: null,
  cursor: null,
  selection: null,
  nearbyCode: null,
  currentSymbol: null,
  symbolStatus: 'no_editor',
  diagnostics: [],
  diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
};

const activeContext = {
  workspace: { name: 'demo', rootCount: 1 },
  relativePath: 'src/auth.ts',
  languageId: 'typescript',
  cursor: { line: 42, column: 7 },
  selection: { isEmpty: false, start: { line: 40, column: 1 }, end: { line: 42, column: 7 } },
  nearbyCode: {
    source: 'symbol',
    startLine: 38,
    endLine: 45,
    text: 'function validateToken() {}',
    truncated: false,
  },
  currentSymbol: { name: 'validateToken', kind: 'Function', startLine: 38, endLine: 45 },
  symbolStatus: 'found',
  diagnostics: [
    {
      severity: 'error',
      relativePath: 'src/auth.ts',
      line: 42,
      column: 7,
      message: 'Type string is not assignable to type number.',
      source: 'ts',
      code: '2322',
      symbolName: 'validateToken',
    },
  ],
  diagnosticCounts: { error: 1, warning: 0, information: 0, hint: 0 },
};

const testRun = {
  outcome: 'failed',
  command: 'npm test',
  exitCode: 1,
  passed: 3,
  failed: 1,
  totalFailedNames: 1,
  failingTests: [{ name: 'auth validates tokens', messageExcerpt: 'expected 1 to be 2' }],
  outputTruncated: false,
  durationMs: 1200,
};

const withBase = <T extends object>(type: string, fields: T) => ({ version: 1, type, ...fields });

const validMessages: Record<string, Record<string, unknown>> = {
  hello: withBase('hello', { client: 'kirosight-extension' }),
  hello_ack: withBase('hello_ack', {
    supportedVersions: [1],
    capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
  }),
  agent_request: withBase('agent_request', {
    id: 'r1',
    kind: 'utterance',
    utterance: { text: 'explain this error', source: 'typed' },
    context: activeContext,
  }),
  agent_response: withBase('agent_response', {
    replyTo: 'r1',
    speech: 'There is one type error on line 42 in auth.ts.',
    action: { type: 'GO_TO_DIAGNOSTIC', index: 0 },
    confirmationRequired: false,
  }),
  action_request: withBase('action_request', {
    id: 'a1',
    action: { type: 'GO_TO_LINE', line: 10 },
    reason: 'Show the failing line.',
  }),
  action_result: withBase('action_result', {
    replyTo: 'r1',
    result: { actionType: 'GO_TO_LINE', status: 'ok', message: 'Moved to line 10.' },
  }),
  record_start: withBase('record_start', { id: 'rec1' }),
  record_stop: withBase('record_stop', { id: 'rec1' }),
  audio_clip: withBase('audio_clip', { id: 'rec1', mimeType: 'audio/webm', base64: 'AAEC' }),
  transcription_result: withBase('transcription_result', { replyTo: 'rec1', text: 'what errors are there' }),
  speech_request: withBase('speech_request', { id: 's1', replyTo: 'r1', text: 'Two errors.' }),
  speech_audio: withBase('speech_audio', { replyTo: 's1', mimeType: 'audio/mpeg', base64: 'AAEC' }),
  cancel: withBase('cancel', { targetId: 'r1' }),
  error_message: withBase('error_message', {
    replyTo: 'r1',
    code: 'BEDROCK_UNAVAILABLE',
    message: 'The explanation could not be generated.',
    recoverable: true,
  }),
};

describe('validateProtocolMessage: valid messages', () => {
  it.each(Object.entries(validMessages))('accepts a valid %s message unchanged', (type, message) => {
    const result = validateProtocolMessage(message);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe(type);
      expect(result.value.version).toBe(1);
      expect(result.value).toEqual(message);
    }
  });

  it('covers all fourteen message types', () => {
    expect(Object.keys(validMessages)).toHaveLength(14);
  });

  it('accepts the optional fields of hello, speech_request, error_message and agent_request', () => {
    expect(validateProtocolMessage({ ...validMessages.hello, token: 't' }).ok).toBe(true);
    expect(validateProtocolMessage({ ...validMessages.speech_request, replyTo: undefined }).ok).toBe(true);
    expect(validateProtocolMessage({ ...validMessages.error_message, replyTo: undefined }).ok).toBe(true);
    expect(validateProtocolMessage({
      ...validMessages.agent_request,
      kind: 'summarize_test_run',
      utterance: undefined,
      testRun,
    }).ok).toBe(true);
  });

  it.each(ERROR_CODES)('accepts error code %s', (code) => {
    expect(validateProtocolMessage({ ...validMessages.error_message, code }).ok).toBe(true);
  });

  it.each(['available', 'unavailable', 'denied', 'not_applicable'])('accepts mic capability %s', (mic) => {
    const message = {
      ...validMessages.hello_ack,
      capabilities: { bedrock: true, stt: true, tts: true, mic },
    };
    expect(validateProtocolMessage(message).ok).toBe(true);
  });

  it.each(['ok', 'failed', 'declined', 'not_permitted', 'needs_clarification', 'not_configured'])(
    'accepts action_result status %s',
    (status) => {
      const message = {
        ...validMessages.action_result,
        result: { actionType: 'RUN_TESTS', status, message: 'x' },
      };
      expect(validateProtocolMessage(message).ok).toBe(true);
    },
  );

  it('accepts every ActionResult details variant', () => {
    const detailsList = [
      { kind: 'file_opened', relativePath: 'src/a.ts' },
      { kind: 'diagnostic_reached', relativePath: 'src/a.ts', line: 3, severity: 'error', message: 'm', symbol: 's', wrapped: true },
      { kind: 'location_reached', relativePath: 'src/a.ts', line: 3 },
      { kind: 'ambiguous_files', matches: ['a/x.ts', 'b/x.ts'], totalMatches: 2 },
      { kind: 'test_run', summary: testRun },
    ];
    for (const details of detailsList) {
      const message = {
        ...validMessages.action_result,
        result: { actionType: 'RUN_TESTS', status: 'ok', message: 'x', details },
      };
      expect(validateProtocolMessage(message).ok, details.kind).toBe(true);
    }
  });
});

describe('validateProtocolMessage: invalid messages', () => {
  const valid = validMessages.cancel;

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['number', 1],
    ['string', 'hello'],
    ['boolean', true],
    ['array', [valid]],
    ['empty object', {}],
  ])('rejects %s without throwing', (_label, raw) => {
    expect(() => validateProtocolMessage(raw)).not.toThrow();
    expect(validateProtocolMessage(raw).ok).toBe(false);
  });

  it('rejects a missing version as VALIDATION_FAILED', () => {
    const { version: _version, ...rest } = valid;
    const result = validateProtocolMessage(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
  });

  it.each([0, 2, '1', 1.5, null, true])('rejects version %j as unsupported', (version) => {
    const result = validateProtocolMessage({ ...valid, version });
    expect(result.ok).toBe(false);
    if (!result.ok && version !== null) expect(result.error.code).toBe('UNSUPPORTED_VERSION');
  });

  it('rejects a missing or non-string type', () => {
    for (const type of [undefined, 5, null, {}]) {
      const result = validateProtocolMessage({ ...valid, type });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects an unknown type as UNKNOWN_TYPE', () => {
    for (const type of ['run_command', 'ping', 'HELLO', 'cancel ', '']) {
      const result = validateProtocolMessage({ ...valid, type });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNKNOWN_TYPE');
    }
  });

  it.each(Object.entries(validMessages))('rejects %s with an unexpected top-level field', (_type, message) => {
    expect(validateProtocolMessage({ ...message, extra: 1 }).ok).toBe(false);
    expect(validateProtocolMessage({ ...message, command: 'rm -rf /' }).ok).toBe(false);
  });

  it('rejects a missing required field for each message type', () => {
    const required: Record<string, string> = {
      hello: 'client',
      hello_ack: 'capabilities',
      agent_request: 'context',
      agent_response: 'replyTo',
      action_request: 'reason',
      action_result: 'result',
      record_start: 'id',
      record_stop: 'id',
      audio_clip: 'base64',
      transcription_result: 'text',
      speech_request: 'text',
      speech_audio: 'mimeType',
      cancel: 'targetId',
      error_message: 'recoverable',
    };
    for (const [type, field] of Object.entries(required)) {
      const { [field]: _removed, ...rest } = validMessages[type];
      expect(validateProtocolMessage(rest).ok, `${type} without ${field}`).toBe(false);
    }
  });

  it('rejects wrong field types', () => {
    const cases: Record<string, unknown>[] = [
      { ...validMessages.cancel, targetId: 5 },
      { ...validMessages.hello, client: 'other' },
      { ...validMessages.hello, token: 5 },
      { ...validMessages.agent_response, confirmationRequired: 'false' },
      { ...validMessages.agent_response, speech: 5 },
      { ...validMessages.agent_response, speech: 'x'.repeat(601) },
      { ...validMessages.agent_request, kind: 'other' },
      { ...validMessages.agent_request, utterance: { text: 'x'.repeat(4001) } },
      { ...validMessages.error_message, recoverable: 'yes' },
      { ...validMessages.hello_ack, supportedVersions: ['1'] },
      { ...validMessages.record_start, id: 1 },
    ];
    for (const message of cases) {
      expect(validateProtocolMessage(message).ok).toBe(false);
    }
  });

  it('rejects unknown error codes', () => {
    for (const code of ['NOPE', 'validation_failed', '', 5, undefined]) {
      expect(validateProtocolMessage({ ...validMessages.error_message, code }).ok).toBe(false);
    }
  });

  it('rejects malformed capabilities', () => {
    const good = { bedrock: true, stt: true, tts: true, mic: 'available' };
    const bad: unknown[] = [
      { ...good, mic: 'granted' },
      { ...good, bedrock: 'yes' },
      { ...good, extra: true },
      { bedrock: true, stt: true, tts: true },
      null,
      [],
    ];
    for (const capabilities of bad) {
      expect(validateProtocolMessage({ ...validMessages.hello_ack, capabilities }).ok).toBe(false);
    }
  });

  it('rejects malformed audio messages', () => {
    const bad = [
      { ...validMessages.audio_clip, base64: 5 },
      { ...validMessages.audio_clip, mimeType: undefined },
      { ...validMessages.audio_clip, seq: 0 },
      { ...validMessages.audio_clip, final: true },
      { ...validMessages.speech_audio, replyTo: undefined },
      { ...validMessages.transcription_result, text: null },
    ];
    for (const message of bad) {
      expect(validateProtocolMessage(message).ok).toBe(false);
    }
  });

  it('accepts chunked audio frames: seq and final together, including an empty final marker', () => {
    const good = [
      { ...validMessages.audio_clip, seq: 0, final: false },
      { ...validMessages.audio_clip, seq: 7, final: true },
      { ...validMessages.audio_clip, seq: 3, final: true, base64: '' },
      { ...validMessages.audio_clip, seq: 0, final: true },
    ];
    for (const message of good) {
      expect(validateProtocolMessage(message).ok).toBe(true);
    }
  });

  it('rejects malformed chunked audio frames', () => {
    const bad = [
      { ...validMessages.audio_clip, seq: -1, final: false },
      { ...validMessages.audio_clip, seq: 1.5, final: false },
      { ...validMessages.audio_clip, seq: '0', final: false },
      { ...validMessages.audio_clip, seq: Number.MAX_SAFE_INTEGER + 2, final: false },
      { ...validMessages.audio_clip, seq: 0, final: 'yes' },
      { ...validMessages.audio_clip, seq: null, final: false },
      { ...validMessages.audio_clip, seq: 0, final: null },
      { ...validMessages.audio_clip, seq: 0, final: false, extra: 1 },
    ];
    for (const message of bad) {
      expect(validateProtocolMessage(message).ok).toBe(false);
    }
  });

  it('rejects malformed action_result payloads', () => {
    const bad: unknown[] = [
      { actionType: 'GO_TO_LINE', status: 'unknown', message: 'x' },
      { actionType: 'GO_TO_LINE', status: 'ok' },
      { actionType: 'GO_TO_LINE', status: 'ok', message: 'x', extra: 1 },
      { actionType: 'GO_TO_LINE', status: 'ok', message: 'x', details: { kind: 'unknown' } },
      { actionType: 'GO_TO_LINE', status: 'ok', message: 'x', details: { kind: 'file_opened', relativePath: '/abs/a.ts' } },
      {
        actionType: 'GO_TO_LINE',
        status: 'ok',
        message: 'x',
        details: { kind: 'ambiguous_files', matches: Array.from({ length: 11 }, (_, i) => `f${i}.ts`), totalMatches: 11 },
      },
    ];
    for (const result of bad) {
      expect(validateProtocolMessage({ ...validMessages.action_result, result }).ok).toBe(false);
    }
  });

  it('never echoes the payload in failures', () => {
    const secret = 'sk-DISTINCTIVE-SECRET-VALUE-1234567890';
    const results = [
      validateProtocolMessage({ ...validMessages.cancel, targetId: 5, [secret]: secret }),
      validateProtocolMessage({ ...validMessages.agent_request, context: { ...activeContext, nearbyCode: { ...activeContext.nearbyCode, text: 5 }, [secret]: 1 } }),
      validateProtocolMessage({ ...validMessages.cancel, type: secret }),
      validateProtocolMessage({ ...validMessages.cancel, version: secret }),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('validateToken');
    }
  });

  it('does not throw for hostile objects', () => {
    const throwing = new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); } });
    expect(() => validateProtocolMessage(throwing)).not.toThrow();
    expect(validateProtocolMessage(throwing).ok).toBe(false);
    const cyclic: Record<string, unknown> = { version: 1, type: 'cancel' };
    cyclic.targetId = cyclic;
    expect(validateProtocolMessage(cyclic).ok).toBe(false);
  });
});

describe('agent_response.action envelope (ActionValidator owns the allow-list)', () => {
  const responseWith = (action: unknown) => ({ ...validMessages.agent_response, action });

  it('accepts an approved action object', () => {
    expect(validateProtocolMessage(responseWith({ type: 'RUN_TESTS' })).ok).toBe(true);
    expect(validateProtocolMessage(responseWith({ type: 'NO_ACTION' })).ok).toBe(true);
  });

  it('accepts an unknown action name, leaving rejection to ActionValidator', () => {
    for (const type of ['UNKNOWN_ACTION_FROM_MODEL', 'RUN_COMMAND', 'GO_TO_SYMBOL', 'go_to_line']) {
      const action = { type, anything: 'x' };
      const result = validateProtocolMessage(responseWith(action));
      expect(result.ok, type).toBe(true);
      expect(validateAction(action, 'agent')).toMatchObject({ ok: false, code: 'UNKNOWN_ACTION' });
    }
  });

  it('preserves action parameters so ActionValidator can check them', () => {
    const actions = [
      { type: 'GO_TO_DIAGNOSTIC', index: 2, severity: 'warning' },
      { type: 'OPEN_FILE', path: 'src/auth.ts' },
      { type: 'GO_TO_LINE', line: 12 },
      { type: 'RUN_TESTS', command: 'rm -rf /' },
    ];
    for (const action of actions) {
      const result = validateProtocolMessage(responseWith(action));
      expect(result.ok).toBe(true);
      if (result.ok && result.value.type === 'agent_response') {
        expect(result.value.action).toEqual(action);
      }
    }
    // The protocol layer lets the extra command through; ActionValidator still rejects it.
    expect(validateAction({ type: 'RUN_TESTS', command: 'rm -rf /' }, 'agent')).toMatchObject({ ok: false });
  });

  it('rejects an action that is not an object or lacks a string type', () => {
    for (const action of [undefined, null, 'RUN_TESTS', 5, [], {}, { type: 5 }, { type: null }, { kind: 'RUN_TESTS' }]) {
      expect(validateProtocolMessage(responseWith(action)).ok).toBe(false);
    }
  });

  it('applies the same envelope rule to action_request', () => {
    const requestWith = (action: unknown) => ({ ...validMessages.action_request, action });
    expect(validateProtocolMessage(requestWith({ type: 'UNKNOWN_ACTION_FROM_MODEL', x: 1 })).ok).toBe(true);
    expect(validateProtocolMessage(requestWith({ type: 'GO_TO_LINE', line: 3 })).ok).toBe(true);
    expect(validateProtocolMessage(requestWith({ type: 5 })).ok).toBe(false);
    expect(validateProtocolMessage(requestWith({})).ok).toBe(false);
    expect(validateProtocolMessage(requestWith(null)).ok).toBe(false);
  });
});

describe('agent_request context (IDEContext wire form)', () => {
  const requestWith = (context: unknown) => ({ ...validMessages.agent_request, context });

  it('accepts an active-file context with selection, symbol, excerpt and diagnostics', () => {
    expect(validateProtocolMessage(requestWith(activeContext)).ok).toBe(true);
  });

  it('accepts the explicit no-editor state', () => {
    expect(validateProtocolMessage(requestWith(noEditorContext)).ok).toBe(true);
  });

  it('accepts an empty selection and every excerpt source and symbol status', () => {
    expect(validateProtocolMessage(requestWith({ ...activeContext, selection: { isEmpty: true } })).ok).toBe(true);
    for (const source of ['selection', 'symbol', 'cursor_window']) {
      expect(validateProtocolMessage(requestWith({
        ...activeContext,
        nearbyCode: { ...activeContext.nearbyCode, source },
      })).ok).toBe(true);
    }
    for (const symbolStatus of ['found', 'none_enclosing', 'provider_unavailable', 'no_editor']) {
      expect(validateProtocolMessage(requestWith({ ...activeContext, symbolStatus })).ok).toBe(true);
    }
  });

  it('accepts the output of toWireContext and rejects an absolute activeFile', () => {
    const local: IDEContext = {
      ...(activeContext as unknown as Omit<IDEContext, 'activeFile'>),
      activeFile: 'C:\\Users\\someone\\project\\src\\auth.ts',
    };
    const wire = toWireContext(local);
    expect('activeFile' in wire).toBe(false);
    expect(JSON.stringify(wire)).not.toContain('Users');
    expect(validateProtocolMessage(requestWith(wire)).ok).toBe(true);
    expect(validateProtocolMessage(requestWith(local)).ok).toBe(false);
    expect(validateProtocolMessage(requestWith({ ...activeContext, activeFile: '/home/x/a.ts' })).ok).toBe(false);
  });

  it('rejects absolute relative paths', () => {
    for (const path of ['/home/user/a.ts', 'C:\\work\\a.ts', 'c:/work/a.ts', '\\\\server\\share\\a.ts']) {
      expect(validateProtocolMessage(requestWith({ ...activeContext, relativePath: path })).ok, path).toBe(false);
    }
  });

  it('rejects malformed contexts', () => {
    const bad: unknown[] = [
      null,
      'ctx',
      {},
      { ...activeContext, cursor: { line: 0, column: 1 } },
      { ...activeContext, cursor: { line: 1.5, column: 1 } },
      { ...activeContext, cursor: { line: 1 } },
      { ...activeContext, selection: { isEmpty: false } },
      { ...activeContext, selection: { isEmpty: true, start: { line: 1, column: 1 } } },
      { ...activeContext, symbolStatus: 'unknown' },
      { ...activeContext, workspace: { name: 'x' } },
      { ...activeContext, diagnosticCounts: { error: -1, warning: 0, information: 0, hint: 0 } },
      { ...activeContext, diagnosticCounts: { error: 0, warning: 0, information: 0 } },
      { ...activeContext, nearbyCode: { ...activeContext.nearbyCode, source: 'file' } },
      { ...activeContext, nearbyCode: { ...activeContext.nearbyCode, text: 'x'.repeat(6001) } },
      { ...activeContext, nearbyCode: { ...activeContext.nearbyCode, extra: 1 } },
      { ...activeContext, currentSymbol: { name: 'f' } },
      { ...activeContext, diagnostics: [{ ...activeContext.diagnostics[0], severity: 'fatal' }] },
      { ...activeContext, diagnostics: [{ ...activeContext.diagnostics[0], message: 'x'.repeat(501) }] },
      { ...activeContext, diagnostics: Array.from({ length: 26 }, () => activeContext.diagnostics[0]) },
    ];
    for (const context of bad) {
      expect(validateProtocolMessage(requestWith(context)).ok).toBe(false);
    }
  });

  it('rejects malformed testRun and utterance payloads', () => {
    const bad = [
      { ...validMessages.agent_request, testRun: { ...testRun, outcome: 'unknown' } },
      { ...validMessages.agent_request, testRun: { ...testRun, extra: 1 } },
      { ...validMessages.agent_request, testRun: { ...testRun, failingTests: Array.from({ length: 21 }, () => ({ name: 'n' })) } },
      { ...validMessages.agent_request, utterance: { source: 'typed' } },
      { ...validMessages.agent_request, utterance: { text: 'x', source: 'telepathy' } },
    ];
    for (const message of bad) {
      expect(validateProtocolMessage(message).ok).toBe(false);
    }
  });
});

describe('protocol version: JSON numeric semantics (parity with the Python backend)', () => {
  const helloJson = (spelling: string): string =>
    `{"version": ${spelling}, "type": "hello", "client": "kirosight-extension"}`;

  // JavaScript has one Number type, so every spelling of the number 1 decodes to 1. The Python
  // side decodes 1.0 as a float and must treat it identically. No TypeScript change was needed.
  it.each(['1', '1.0', '1.00', '1e0', '1E0', '10e-1'])('accepts the JSON spelling %s as version 1', (spelling) => {
    const decoded: unknown = JSON.parse(helloJson(spelling));
    const result = validateProtocolMessage(decoded);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.version).toBe(1);
  });

  it.each(['"1"', '"1.0"', 'true', 'false', 'null', '0', '2', '-1', '1.5', '0.999', '2.0', '[1]', '{}'])(
    'rejects the JSON value %s as an unsupported version',
    (spelling) => {
      const result = validateProtocolMessage(JSON.parse(helloJson(spelling)));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('UNSUPPORTED_VERSION');
    },
  );
});

describe('integer fields: JSON numeric semantics (parity with the Python backend)', () => {
  type IntegerField = { base: string; path: (string | number)[]; minimum: number | null; nullable?: boolean };

  const validTestRun = {
    outcome: 'failed', command: 'npm test', exitCode: 1, passed: 3, failed: 1, totalFailedNames: 1,
    failingTests: [{ name: 'sample test' }], outputTruncated: false, durationMs: 1200,
  }; // prettier-ignore

  const fixtureOf = (name: string): Record<string, any> =>
    JSON.parse(readFileSync(resolve(__dirname, '../../src/protocol/fixtures/messages', `${name}.json`), 'utf8'));
  // `makeDetails` is a FACTORY: each call must return a fresh object. A shared details object would
  // be mutated by `decode` (it overwrites the field under test with a placeholder), so earlier
  // fields would stay corrupted for later cases (the test_run summary has several integer fields).
  const withDetails = (makeDetails: () => unknown) => () => {
    const message = fixtureOf('action_result');
    message.result.details = makeDetails();
    return message;
  };
  const bases: Record<string, () => Record<string, any>> = {
    hello_ack: () => fixtureOf('hello_ack'),
    agent_request: () => fixtureOf('agent_request'),
    agent_request_test_run: () => ({
      ...fixtureOf('agent_request'),
      kind: 'summarize_test_run',
      testRun: structuredClone(validTestRun),
    }),
    action_result_diagnostic: () => fixtureOf('action_result'),
    action_result_location: withDetails(() => ({ kind: 'location_reached', relativePath: 'src/a.ts', line: 3 })),
    action_result_ambiguous: withDetails(() => ({ kind: 'ambiguous_files', matches: ['a/x.ts'], totalMatches: 1 })),
    action_result_test_run: withDetails(() => ({ kind: 'test_run', summary: structuredClone(validTestRun) })),
  };

  const ctx = ['context'];
  const fields: IntegerField[] = [
    { base: 'hello_ack', path: ['supportedVersions', 0], minimum: null },
    { base: 'agent_request', path: [...ctx, 'workspace', 'rootCount'], minimum: 0 },
    ...['line', 'column'].map((axis) => ({ base: 'agent_request', path: [...ctx, 'cursor', axis], minimum: 1 })),
    ...['startLine', 'endLine'].map((key) => ({ base: 'agent_request', path: [...ctx, 'nearbyCode', key], minimum: 1 })),
    ...['startLine', 'endLine'].map((key) => ({ base: 'agent_request', path: [...ctx, 'currentSymbol', key], minimum: 1 })),
    ...['line', 'column'].map((key) => ({ base: 'agent_request', path: [...ctx, 'diagnostics', 0, key], minimum: 1 })),
    ...['start', 'end'].flatMap((edge) =>
      ['line', 'column'].map((axis) => ({ base: 'agent_request', path: [...ctx, 'selection', edge, axis], minimum: 1 })),
    ),
    ...['error', 'warning', 'information', 'hint'].map((key) => ({
      base: 'agent_request', path: [...ctx, 'diagnosticCounts', key], minimum: 0,
    })), // prettier-ignore
    { base: 'agent_request_test_run', path: ['testRun', 'exitCode'], minimum: null, nullable: true },
    { base: 'agent_request_test_run', path: ['testRun', 'passed'], minimum: 0, nullable: true },
    { base: 'agent_request_test_run', path: ['testRun', 'failed'], minimum: 0, nullable: true },
    { base: 'agent_request_test_run', path: ['testRun', 'totalFailedNames'], minimum: 0 },
    { base: 'action_result_diagnostic', path: ['result', 'details', 'line'], minimum: 1 },
    { base: 'action_result_location', path: ['result', 'details', 'line'], minimum: 1 },
    { base: 'action_result_ambiguous', path: ['result', 'details', 'totalMatches'], minimum: 0 },
    { base: 'action_result_test_run', path: ['result', 'details', 'summary', 'exitCode'], minimum: null, nullable: true },
    { base: 'action_result_test_run', path: ['result', 'details', 'summary', 'passed'], minimum: 0, nullable: true },
    { base: 'action_result_test_run', path: ['result', 'details', 'summary', 'failed'], minimum: 0, nullable: true },
    { base: 'action_result_test_run', path: ['result', 'details', 'summary', 'totalFailedNames'], minimum: 0 },
  ]; // prettier-ignore

  const SENTINEL = '__INT__';
  const label = (field: IntegerField): string => `${field.base}:${field.path.join('.')}`;
  const getAt = (value: any, path: (string | number)[]): unknown => path.reduce((node, part) => node[part], value);
  function decode(field: IntegerField, spelling: string): unknown {
    const message = bases[field.base]();
    const parent = getAt(message, field.path.slice(0, -1)) as Record<string | number, unknown>;
    parent[field.path[field.path.length - 1]] = SENTINEL;
    return JSON.parse(JSON.stringify(message).replace(`"${SENTINEL}"`, spelling));
  }

  it('builds an independent, valid base on every call (decoding one field never affects another)', () => {
    for (const field of fields) {
      decode(field, '5'); // would corrupt a shared base
      const again = bases[field.base]();
      expect(again).toEqual(bases[field.base]());
      expect(validateProtocolMessage(again).ok, field.base).toBe(true);
    }
  });

  it('direct Zod regression: z.number().int() accepts MAX_SAFE_INTEGER and rejects MAX_SAFE_INTEGER + 1', () => {
    expect(z.number().int().safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(z.number().int().safeParse(Number.MIN_SAFE_INTEGER).success).toBe(true);
    expect(z.number().int().safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
    expect(z.number().int().safeParse(Number.MIN_SAFE_INTEGER - 1).success).toBe(false);
  });

  it('covers every integer-bearing base', () => {
    expect(new Set(fields.map((field) => field.base))).toEqual(new Set(Object.keys(bases)));
    expect(new Set(fields.map(label)).size).toBe(fields.length);
  });

  // Zod's .int() sees one JavaScript Number, so every spelling of 5 is the same accepted value.
  it.each(fields.map((field) => [label(field), field] as const))('%s accepts any integral JSON number', (_name, field) => {
    for (const spelling of ['5', '5.0', '5.00', '5e0', '50e-1']) {
      const result = validateProtocolMessage(decode(field, spelling));
      expect(result.ok, `${label(field)} ${spelling}`).toBe(true);
      if (result.ok) expect(getAt(result.value, field.path)).toBe(5);
    }
  });

  it.each(fields.map((field) => [label(field), field] as const))('%s rejects fractions, booleans, strings and out-of-range values', (_name, field) => {
    const spellings = ['5.5', '0.999', 'true', 'false', '"5"', '"5.0"'];
    if (!field.nullable) spellings.push('null');
    if (field.minimum !== null) spellings.push(String(field.minimum - 1), `${field.minimum - 1}.0`, `${field.minimum - 1}e0`);
    for (const spelling of spellings) {
      const result = validateProtocolMessage(decode(field, spelling));
      expect(result.ok, `${label(field)} ${spelling}`).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('VALIDATION_FAILED');
    }
  });

  // Zod 4's .int() accepts safe integers only: -(2**53 - 1) to 2**53 - 1.
  it.each(fields.map((field) => [label(field), field] as const))('%s enforces the safe-integer range', (_name, field) => {
    for (const spelling of ['9007199254740991', '9007199254740991.0']) {
      const result = validateProtocolMessage(decode(field, spelling));
      expect(result.ok, `${label(field)} ${spelling}`).toBe(true);
      if (result.ok) expect(getAt(result.value, field.path)).toBe(Number.MAX_SAFE_INTEGER);
    }
    if (field.minimum === null) {
      expect(validateProtocolMessage(decode(field, '-9007199254740991')).ok).toBe(true);
    }
    for (const spelling of ['9007199254740992', '9007199254740992.0', '1e20', '1e300', '-1e20', '-1e300']) {
      expect(validateProtocolMessage(decode(field, spelling)).ok, `${label(field)} ${spelling}`).toBe(false);
    }
    if (field.minimum === null) {
      expect(validateProtocolMessage(decode(field, '-9007199254740992')).ok).toBe(false);
    }
  });

  it('accepts supportedVersions [1.0] and still rejects [true], ["1"] and [1.5]', () => {
    const helloAck = (versions: string): string =>
      JSON.stringify(fixtureOf('hello_ack')).replace('"supportedVersions":[1]', `"supportedVersions":${versions}`);
    expect(validateProtocolMessage(JSON.parse(helloAck('[1.0]'))).ok).toBe(true);
    for (const rejected of ['[true]', '["1"]', '[1.5]']) {
      expect(validateProtocolMessage(JSON.parse(helloAck(rejected))).ok, rejected).toBe(false);
    }
  });
});
