import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BACKEND_EMPTY_RESPONSE_TEXT,
  BACKEND_REQUEST_FAILED_TEXT,
  BACKEND_REQUEST_TIMED_OUT_TEXT,
  BackendAgentGateway,
  type AgentGatewayClient,
} from '../../src/backend/agentGateway';
import {
  BackendClient,
  DEFAULT_BACKEND_URL,
  type BackendClientError,
  type ConnectionState,
} from '../../src/backend/backendClient';
import { toWireContext } from '../../src/context/contextService';
import type { IDEContext } from '../../src/context/editorAdapter';
import { BACKEND_UNAVAILABLE_TEXT } from '../../src/pipeline/inputPipeline';
import type { AgentRequest, AgentResponse } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { err, ok, type Result } from '../../src/util/result';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const ABSOLUTE_PATH = '/abs/private/work/src/auth.ts';

function context(): IDEContext {
  return {
    workspace: { name: 'sample', rootCount: 1 },
    activeFile: ABSOLUTE_PATH,
    relativePath: 'src/auth.ts',
    languageId: 'typescript',
    cursor: { line: 3, column: 1 },
    selection: { isEmpty: true },
    nearbyCode: { source: 'cursor_window', startLine: 2, endLine: 4, text: 'return value;', truncated: false },
    currentSymbol: { name: 'validateToken', kind: 'Function', startLine: 1, endLine: 5 },
    symbolStatus: 'found',
    diagnostics: [{
      severity: 'error', relativePath: 'src/auth.ts', line: 3, column: 1, message: 'Type error.',
    }],
    diagnosticCounts: { error: 1, warning: 0, information: 0, hint: 0 },
  } as IDEContext;
}

function response(replyTo: string, speech = 'There is one error.', action: object = { type: 'RUN_TESTS' }): AgentResponse {
  return { version: 1, type: 'agent_response', replyTo, speech, action: action as AgentResponse['action'], confirmationRequired: false };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

class FakeClient implements AgentGatewayClient {
  public state: ConnectionState = 'connected';
  public readonly requests: AgentRequest[] = [];
  public answer: (request: AgentRequest) => Promise<Result<AgentResponse, BackendClientError>> =
    (request) => Promise.resolve(ok(response(request.id)));

  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>> {
    this.requests.push(request);
    return this.answer(request);
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
};

function build(getContext: () => Promise<IDEContext> = () => Promise.resolve(context())) {
  const client = new FakeClient();
  const contextCalls = { count: 0 };
  const gateway = new BackendAgentGateway({
    client,
    context: { getContext: () => { contextCalls.count += 1; return getContext(); } },
  });
  return { client, gateway, contextCalls };
}

describe('BackendAgentGateway availability', () => {
  it.each([
    ['connected', true],
    ['connecting', false],
    ['disconnected', false],
    ['incompatible', false],
  ] as const)('is available in state %s: %s', (state, expected) => {
    const { client, gateway } = build();
    client.state = state;
    expect(gateway.isAvailable()).toBe(expected);
  });

  it('does nothing in the constructor', () => {
    const { client, contextCalls } = build();
    expect(client.requests).toEqual([]);
    expect(contextCalls.count).toBe(0);
  });

  it('relays nothing when unavailable and never reads context or queues the request', async () => {
    const { client, gateway, contextCalls } = build();
    client.state = 'disconnected';

    const result = await gateway.respond('explain this error', { requestId: 1, source: 'typed' });

    expect(result).toEqual({ status: 'not_handled', text: BACKEND_UNAVAILABLE_TEXT, unavailable: true });
    expect(client.requests).toEqual([]);
    expect(contextCalls.count).toBe(0);

    client.state = 'connected';
    await flush();
    expect(client.requests).toEqual([]);
  });

  it('reports unavailable when the connection drops while context is being prepared', async () => {
    const gate = deferred<IDEContext>();
    const { client, gateway } = build(() => gate.promise);
    const pending = gateway.respond('explain', { requestId: 1, source: 'typed' });
    client.state = 'disconnected';
    gate.resolve(context());

    expect(await pending).toMatchObject({ status: 'not_handled', unavailable: true });
    expect(client.requests).toEqual([]);
  });
});

describe('BackendAgentGateway request construction', () => {
  it('builds one valid agent_request with the exact utterance and the wire context', async () => {
    const { client, gateway } = build();

    await gateway.respond('  explain this error  ', { requestId: 7, source: 'voice' });

    expect(client.requests).toHaveLength(1);
    const request = client.requests[0]!;
    expect(validateProtocolMessage(JSON.parse(JSON.stringify(request))).ok).toBe(true);
    expect(request).toEqual({
      version: 1,
      type: 'agent_request',
      id: 'req-7',
      kind: 'utterance',
      utterance: { text: '  explain this error  ', source: 'voice' },
      context: toWireContext(context()),
    });
  });

  it('sends no absolute path and no activeFile', async () => {
    const { client, gateway } = build();
    await gateway.respond('explain', { requestId: 1, source: 'typed' });

    const serialized = JSON.stringify(client.requests[0]);
    expect(serialized).not.toContain(ABSOLUTE_PATH);
    expect(serialized).not.toContain('/abs/private');
    expect(serialized).not.toContain('activeFile');
    expect(client.requests[0]!.context).not.toHaveProperty('activeFile');
  });

  it('uses a distinct fallback id and omits the source when no relay info is given', async () => {
    const { client, gateway } = build();
    await gateway.respond('one');
    await gateway.respond('two');

    expect(client.requests.map((request) => request.id)).toEqual(['gw-1', 'gw-2']);
    expect(client.requests[0]!.utterance).toEqual({ text: 'one' });
  });
});

describe('BackendAgentGateway order and concurrency', () => {
  it('hands requests over in call order even when an earlier context is slower', async () => {
    const slow = deferred<IDEContext>();
    let call = 0;
    const { client, gateway } = build(() => (call++ === 0 ? slow.promise : Promise.resolve(context())));
    const answers = new Map<string, Deferred<Result<AgentResponse, BackendClientError>>>();
    client.answer = (request) => {
      const gate = deferred<Result<AgentResponse, BackendClientError>>();
      answers.set(request.id, gate);
      return gate.promise;
    };

    const first = gateway.respond('A', { requestId: 1, source: 'typed' });
    const second = gateway.respond('B', { requestId: 2, source: 'typed' });
    await flush();
    expect(client.requests).toEqual([]);

    slow.resolve(context());
    await flush();

    expect(client.requests.map((request) => request.utterance?.text)).toEqual(['A', 'B']);
    // Both are in flight at once: the second was handed over before the first was answered.
    expect(answers.size).toBe(2);

    answers.get('req-2')!.resolve(ok(response('req-2', 'second')));
    answers.get('req-1')!.resolve(ok(response('req-1', 'first')));
    expect(await first).toMatchObject({ text: 'first' });
    expect(await second).toMatchObject({ text: 'second' });
  });

  it('does not wait for an earlier request to be answered before sending the next', async () => {
    const { client, gateway } = build();
    client.answer = () => new Promise(() => undefined);

    void gateway.respond('A', { requestId: 1, source: 'typed' });
    void gateway.respond('B', { requestId: 2, source: 'typed' });
    await flush();

    expect(client.requests).toHaveLength(2);
  });
});

describe('BackendAgentGateway results', () => {
  it('returns the agent speech as handled text and nothing else', async () => {
    const { gateway } = build();
    const result = await gateway.respond('explain', { requestId: 1, source: 'typed' });

    expect(result).toEqual({ status: 'handled', text: 'There is one error.' });
  });

  it('drops the action: a RUN_TESTS response is never carried or executed', async () => {
    const { client, gateway } = build();
    client.answer = (request) => Promise.resolve(ok(response(request.id, 'Running your tests.', { type: 'RUN_TESTS' })));

    const result = await gateway.respond('run the tests please', { requestId: 1, source: 'typed' });

    expect(Object.keys(result).sort()).toEqual(['status', 'text']);
    expect(JSON.stringify(result)).not.toContain('RUN_TESTS');
  });

  it('replaces an empty speech with a stated fallback', async () => {
    const { client, gateway } = build();
    client.answer = (request) => Promise.resolve(ok(response(request.id, '   ')));
    expect(await gateway.respond('x', { requestId: 1, source: 'typed' }))
      .toEqual({ status: 'handled', text: BACKEND_EMPTY_RESPONSE_TEXT });
  });

  it.each([
    ['not_connected', { status: 'not_handled', text: BACKEND_UNAVAILABLE_TEXT, unavailable: true }],
    ['incompatible', { status: 'not_handled', text: BACKEND_UNAVAILABLE_TEXT, unavailable: true }],
    ['timeout', { status: 'not_handled', text: BACKEND_REQUEST_TIMED_OUT_TEXT }],
    ['disconnected', { status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT }],
    ['protocol_error', { status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT }],
    ['cancelled', { status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT }],
    ['backend_error', { status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT }],
  ] as const)('maps a %s failure to safe text', async (kind, expected) => {
    const { client, gateway } = build();
    client.answer = () => Promise.resolve(err({ kind, message: 'SECRET-RAW-DETAIL ws://127.0.0.1:8765/ws' }));

    const result = await gateway.respond('explain', { requestId: 1, source: 'typed' });

    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain('SECRET-RAW-DETAIL');
    expect(JSON.stringify(result)).not.toContain('8765');
  });

  it('fails safely, sends nothing, and keeps working when context gathering throws', async () => {
    let fail = true;
    const { client, gateway } = build(() => (fail ? Promise.reject(new Error('SECRET stack')) : Promise.resolve(context())));

    const first = await gateway.respond('one', { requestId: 1, source: 'typed' });
    expect(first).toEqual({ status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT });
    expect(client.requests).toEqual([]);

    fail = false;
    expect(await gateway.respond('two', { requestId: 2, source: 'typed' })).toMatchObject({ status: 'handled' });
  });

  it('fails safely when the client throws synchronously', async () => {
    const { client, gateway } = build();
    client.answer = () => { throw new Error('SECRET'); };
    const result = await gateway.respond('x', { requestId: 1, source: 'typed' });
    expect(result).toEqual({ status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT });
  });
});

describe('BackendAgentGateway with the real BackendClient', () => {
  it('sends a validated agent_request frame and resolves with the matching response', async () => {
    const factory = new FakeSocketFactory();
    const client = new BackendClient({
      url: DEFAULT_BACKEND_URL,
      socketFactory: factory.create,
      scheduler: new FakeScheduler(),
    });
    const gateway = new BackendAgentGateway({ client, context: { getContext: () => Promise.resolve(context()) } });

    expect(gateway.isAvailable()).toBe(false);
    client.connect();
    factory.last.triggerOpen();
    expect(gateway.isAvailable()).toBe(false);
    factory.last.triggerJson({
      version: 1,
      type: 'hello_ack',
      supportedVersions: [1],
      capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
    });
    expect(gateway.isAvailable()).toBe(true);

    const pending = gateway.respond('explain this error', { requestId: 3, source: 'typed' });
    await flush();

    const frames = factory.last.sentMessages;
    expect(frames.map((frame) => frame.type)).toEqual(['hello', 'agent_request']);
    expect(validateProtocolMessage(frames[1]).ok).toBe(true);
    expect(frames[1]!.id).toBe('req-3');

    factory.last.triggerJson({
      version: 1,
      type: 'agent_response',
      replyTo: 'req-3',
      speech: 'Canned answer.',
      action: { type: 'NO_ACTION' },
      confirmationRequired: false,
    });
    expect(await pending).toEqual({ status: 'handled', text: 'Canned answer.' });
  });
});

describe('BackendAgentGateway boundaries', () => {
  const source = readFileSync(resolve(__dirname, '../../src/backend/agentGateway.ts'), 'utf8');
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');

  it('never connects, uses raw sockets, schedules delays, or touches actions and the webview', () => {
    expect(code).not.toMatch(/\.connect\(|setTimeout|setInterval|readyState|\.send\(/);
    expect(code).not.toMatch(/ActionExecutor|ActionGate|ActionValidator|validateAction|TestRunner/);
    expect(code).not.toMatch(/acquireVsCodeApi|from 'vscode'|webview/i);
  });
});
