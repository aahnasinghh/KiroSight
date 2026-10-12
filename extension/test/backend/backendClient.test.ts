import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_REQUEST_TIMEOUT_MS,
  BackendClient,
  DEFAULT_BACKEND_URL,
  HANDSHAKE_TIMEOUT_MS,
  validateBackendUrl,
  type BackendEvent,
  type BackendLogger,
} from '../../src/backend/backendClient';
import { PROTOCOL_VERSION } from '../../src/protocol/constants';
import type { AgentRequest } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import agentRequestFixture from '../../src/protocol/fixtures/messages/agent_request.json';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory, type FakeWebSocket } from '../mocks/fakeWebSocket';

const SECRET_TOKEN = 'tok-SECRET-9f3a';

const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
};

function agentRequest(id = 'req-1'): AgentRequest {
  return { ...(agentRequestFixture as AgentRequest), id };
}

function agentResponse(replyTo: string): Record<string, unknown> {
  return {
    version: 1,
    type: 'agent_response',
    replyTo,
    speech: 'There is one error.',
    action: { type: 'GO_TO_DIAGNOSTIC', index: 0 },
    confirmationRequired: false,
  };
}

function errorMessage(replyTo?: string): Record<string, unknown> {
  return {
    version: 1,
    type: 'error_message',
    ...(replyTo === undefined ? {} : { replyTo }),
    code: 'BEDROCK_UNAVAILABLE',
    message: 'The reasoning service failed.',
    recoverable: true,
  };
}

class RecordingLogger implements BackendLogger {
  public readonly lines: string[] = [];
  public debug(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public info(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public warn(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
}

function build(options: { token?: string; url?: string } = {}) {
  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const logger = new RecordingLogger();
  const client = new BackendClient({
    url: options.url ?? DEFAULT_BACKEND_URL,
    socketFactory: factory.create,
    scheduler,
    logger,
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  const states: string[] = [];
  client.onStateChange((state) => states.push(state));
  const events: BackendEvent[] = [];
  client.onEvent((event) => events.push(event));
  return { client, factory, scheduler, logger, states, events };
}

function connected(options: { token?: string } = {}) {
  const harness = build(options);
  expect(harness.client.connect().ok).toBe(true);
  const socket = harness.factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  expect(harness.client.state).toBe('connected');
  return { ...harness, socket };
}

function sentTypes(socket: FakeWebSocket): string[] {
  return socket.sentMessages.map((message) => String(message.type));
}

describe('validateBackendUrl (loopback only)', () => {
  it.each([
    'ws://127.0.0.1:8765/ws',
    'ws://localhost:8765/ws',
    'ws://[::1]:8765/ws',
    'wss://localhost:8765/ws',
  ])('accepts %s', (url) => {
    const result = validateBackendUrl(url);
    expect(result.ok).toBe(true);
  });

  it.each([
    'ws://0.0.0.0:8765/ws',
    'ws://192.168.1.5:8765/ws',
    'ws://10.0.0.5:8765/ws',
    'ws://example.com/ws',
    'ws://localhost.evil.com/ws',
    'ws://127.0.0.1.evil.com/ws',
    'http://localhost:8765/ws',
    'https://localhost:8765/ws',
    'not-a-url',
    '',
    '   ',
    'ws://user:pass@127.0.0.1:8765/ws',
    'ws://user@localhost:8765/ws',
  ])('rejects %s', (url) => {
    const result = validateBackendUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_url');
      expect(result.error.message).not.toContain('pass');
    }
  });

  it('returns the parsed form that was checked', () => {
    const result = validateBackendUrl('ws://127.0.0.1:8765/ws');
    expect(result).toEqual({ ok: true, value: 'ws://127.0.0.1:8765/ws' });
  });
});

describe('BackendClient lazy connect and handshake', () => {
  it('does not connect in the constructor', () => {
    const { factory, client } = build();
    expect(factory.sockets).toHaveLength(0);
    expect(client.state).toBe('disconnected');
  });

  it('connect creates exactly one socket for the validated URL', () => {
    const { client, factory, states } = build();
    client.connect();
    client.connect();
    expect(factory.sockets).toHaveLength(1);
    expect(factory.last.url).toBe('ws://127.0.0.1:8765/ws');
    expect(states).toEqual(['connecting']);
  });

  it('never calls the factory for an unsafe URL and stays disconnected', () => {
    const { client, factory, states } = build({ url: 'ws://192.168.1.5:8765/ws' });
    const result = client.connect();
    expect(result.ok).toBe(false);
    expect(factory.sockets).toHaveLength(0);
    expect(states).toEqual([]);
    expect(client.state).toBe('disconnected');
  });

  it('returns to disconnected when the factory throws', () => {
    const { client, factory, states } = build();
    factory.throwOnCreate = true;
    const result = client.connect();
    expect(result.ok).toBe(false);
    expect(states).toEqual(['connecting', 'disconnected']);
  });

  it('sends exactly one valid hello on socket open', () => {
    const { client, factory } = build();
    client.connect();
    expect(factory.last.sent).toHaveLength(0);
    factory.last.triggerOpen();
    expect(factory.last.sent).toHaveLength(1);

    const frame = JSON.parse(factory.last.sent[0] as string) as Record<string, unknown>;
    expect(frame).toEqual({ version: PROTOCOL_VERSION, type: 'hello', client: 'kirosight-extension' });
    expect(validateProtocolMessage(frame).ok).toBe(true);
  });

  it('includes the token in hello only when supplied', () => {
    const withToken = build({ token: SECRET_TOKEN });
    withToken.client.connect();
    withToken.factory.last.triggerOpen();
    const frame = withToken.factory.last.sentMessages[0] as Record<string, unknown>;
    expect(frame.token).toBe(SECRET_TOKEN);
    expect(validateProtocolMessage(frame).ok).toBe(true);

    const withoutToken = build({ token: '' });
    withoutToken.client.connect();
    withoutToken.factory.last.triggerOpen();
    expect('token' in (withoutToken.factory.last.sentMessages[0] as object)).toBe(false);
  });

  it('is not connected on transport open alone', () => {
    const { client, factory, states } = build();
    client.connect();
    factory.last.triggerOpen();
    expect(client.state).toBe('connecting');
    expect(states).toEqual(['connecting']);
  });

  it('becomes connected after a valid hello_ack and exposes capabilities', () => {
    const { client, states } = connected();
    expect(states).toEqual(['connecting', 'connected']);
    expect(client.capabilities).toEqual(HELLO_ACK.capabilities);
  });

  it('becomes incompatible, closes the socket and sends no requests when versions exclude 1', async () => {
    const { client, factory, states } = build();
    client.connect();
    const socket = factory.last;
    socket.triggerOpen();
    socket.triggerJson({ ...HELLO_ACK, supportedVersions: [2, 3] });

    expect(client.state).toBe('incompatible');
    expect(states).toEqual(['connecting', 'incompatible']);
    expect(socket.closeCalls).toHaveLength(1);

    const result = await client.requestAgent(agentRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('incompatible');
    expect(sentTypes(socket)).toEqual(['hello']);
  });

  it.each([
    ['invalid JSON', '{not json'],
    ['a binary frame', new Uint8Array([1, 2, 3])],
    ['a wrong-type message', JSON.stringify(agentResponse('x'))],
    ['a malformed hello_ack', JSON.stringify({ ...HELLO_ACK, capabilities: { bedrock: true } })],
    ['a protocol-invalid message', JSON.stringify({ version: 1, type: 'nonsense' })],
  ])('fails the connection safely on %s during the handshake', (_name, payload) => {
    const { client, factory, states } = build();
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerMessage(payload);

    expect(client.state).toBe('disconnected');
    expect(states).toEqual(['connecting', 'disconnected']);
    expect(factory.last.closeCalls).toHaveLength(1);
  });

  it('treats a hello_ack with an unsupported envelope version as an ordinary failure, not incompatible', () => {
    const { client, factory } = build();
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerJson({ ...HELLO_ACK, version: 2 });
    expect(client.state).toBe('disconnected');
  });

  it('surfaces a handshake error_message (for example UNAUTHORIZED) and then fails the connection', () => {
    const { client, factory, events } = build({ token: SECRET_TOKEN });
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerJson({ ...errorMessage(), code: 'UNAUTHORIZED', message: 'Unauthorized.', recoverable: false });

    expect(client.state).toBe('disconnected');
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(SECRET_TOKEN);
  });

  it('fails a connection that never answers hello after the handshake timeout', () => {
    const { client, factory, scheduler } = build();
    client.connect();
    factory.last.triggerOpen();
    scheduler.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(client.state).toBe('connecting');
    scheduler.advance(1);
    expect(client.state).toBe('disconnected');
    expect(factory.last.closeCalls).toHaveLength(1);
  });

  it('clears the handshake timer once connected', () => {
    const { scheduler } = connected();
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('BackendClient inbound validation', () => {
  it('never dispatches malformed JSON, protocol-invalid or binary messages once connected', () => {
    const { client, socket, events } = connected();

    socket.triggerMessage('{broken');
    socket.triggerMessage(JSON.stringify({ version: 1, type: 'unknown_type' }));
    socket.triggerMessage(JSON.stringify({ version: 2, type: 'error_message' }));
    socket.triggerMessage(JSON.stringify({ ...errorMessage(), extra: 'not allowed' }));
    socket.triggerMessage(new Uint8Array([0, 1, 2]));
    socket.triggerMessage(JSON.stringify([1, 2, 3]));
    socket.triggerMessage('null');

    expect(events).toEqual([]);
    expect(client.state).toBe('connected');
  });

  it('does not echo invalid payload content into logs', () => {
    const { socket, logger } = connected();
    socket.triggerMessage(JSON.stringify({ version: 1, type: 'error_message', code: 'LEAK-SENTINEL-77' }));
    expect(logger.lines.join('\n')).not.toContain('LEAK-SENTINEL-77');
  });

  it('delivers a valid unsolicited message that passed validateProtocolMessage', () => {
    const { socket, events } = connected();
    const message = errorMessage();
    expect(validateProtocolMessage(message).ok).toBe(true);
    socket.triggerJson(message);
    expect(events).toEqual([message]);
  });

  it('drops valid messages that only flow extension to backend', () => {
    const { socket, events, client } = connected();
    socket.triggerJson({ version: 1, type: 'hello', client: 'kirosight-extension' });
    socket.triggerJson({ version: 1, type: 'cancel', targetId: 'x' });
    socket.triggerJson(HELLO_ACK);
    expect(events).toEqual([]);
    expect(client.state).toBe('connected');
  });

  it('delivers action_request as data only and executes nothing', () => {
    const { socket, events } = connected();
    const message = {
      version: 1,
      type: 'action_request',
      id: 'act-1',
      action: { type: 'RUN_TESTS' },
      reason: 'Verify the fix.',
    };
    socket.triggerJson(message);

    expect(events).toEqual([message]);
    // No action_result or any other frame is produced by receiving it.
    expect(sentTypes(socket)).toEqual(['hello']);
  });
});

describe('BackendClient agent requests', () => {
  it('rejects a request while not connected', async () => {
    const { client, factory } = build();
    const result = await client.requestAgent(agentRequest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_connected');
    expect(factory.sockets).toHaveLength(0);
  });

  it('sends a valid agent_request and resolves with the matching agent_response', async () => {
    const { client, socket, events } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));

    const frame = socket.sentMessages[1];
    expect(frame).toBeDefined();
    const validated = validateProtocolMessage(frame);
    expect(validated.ok).toBe(true);
    expect(frame?.type).toBe('agent_request');

    const response = agentResponse('req-1');
    socket.triggerJson(response);
    const result = await pending;

    expect(result).toEqual({ ok: true, value: response });
    expect(events).toEqual([]);
  });

  it('settles only the request whose id matches replyTo', async () => {
    const { client, socket } = connected();
    const first = client.requestAgent(agentRequest('a'));
    const second = client.requestAgent(agentRequest('b'));

    socket.triggerJson(agentResponse('b'));
    const secondResult = await second;
    expect(secondResult.ok).toBe(true);

    socket.triggerJson(agentResponse('a'));
    const firstResult = await first;
    expect(firstResult.ok && firstResult.value.replyTo).toBe('a');
  });

  it('ignores a response with an unknown replyTo without crashing or emitting an event', () => {
    const { client, socket, events } = connected();
    socket.triggerJson(agentResponse('nobody'));
    expect(events).toEqual([]);
    expect(client.state).toBe('connected');
  });

  it('rejects a duplicate in-flight id and an invalid request without sending', async () => {
    const { client, socket } = connected();
    void client.requestAgent(agentRequest('dup'));
    const duplicate = await client.requestAgent(agentRequest('dup'));
    expect(duplicate.ok).toBe(false);

    const tooLong = agentRequest('long');
    const invalid = { ...tooLong, utterance: { text: 'x'.repeat(5000) } } as AgentRequest;
    const invalidResult = await client.requestAgent(invalid);
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) expect(invalidResult.error.kind).toBe('protocol_error');

    expect(sentTypes(socket)).toEqual(['hello', 'agent_request']);
  });

  it('fails a correlated error_message with a typed safe error and does not emit it', async () => {
    const { client, socket, events } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));
    socket.triggerJson(errorMessage('req-1'));
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('backend_error');
      expect(result.error.backendCode).toBe('BEDROCK_UNAVAILABLE');
      expect(result.error.recoverable).toBe(true);
    }
    expect(events).toEqual([]);
  });

  it('emits an error_message that matches no in-flight request as an event', () => {
    const { socket, events } = connected();
    socket.triggerJson(errorMessage('long-gone'));
    expect(events).toHaveLength(1);
  });

  it('returns not_connected when the socket send throws and leaves nothing in flight', async () => {
    const { client, socket, scheduler } = connected();
    socket.throwOnSend = true;
    const result = await client.requestAgent(agentRequest());
    expect(result.ok).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('BackendClient timeout', () => {
  it('uses a 25 second agent timeout', () => {
    expect(AGENT_REQUEST_TIMEOUT_MS).toBe(25_000);
  });

  it('times out at exactly 25 s, sends one cancel, and removes the request', async () => {
    const { client, socket, scheduler } = connected();
    const pending = client.requestAgent(agentRequest('slow'));

    expect(scheduler.pendingDelays).toEqual([AGENT_REQUEST_TIMEOUT_MS]);
    scheduler.advance(AGENT_REQUEST_TIMEOUT_MS - 1);
    expect(sentTypes(socket)).toEqual(['hello', 'agent_request']);

    scheduler.advance(1);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('timeout');
      expect(result.error.message).not.toContain('slow');
    }

    const cancel = socket.sentMessages[2];
    expect(cancel).toEqual({ version: 1, type: 'cancel', targetId: 'slow' });
    expect(validateProtocolMessage(cancel).ok).toBe(true);
    expect(sentTypes(socket)).toEqual(['hello', 'agent_request', 'cancel']);
    expect(scheduler.pendingCount).toBe(0);
    expect(client.state).toBe('connected');
  });

  it('ignores a late response after timeout', async () => {
    const { client, socket, scheduler, events } = connected();
    const pending = client.requestAgent(agentRequest('slow'));
    scheduler.advance(AGENT_REQUEST_TIMEOUT_MS);
    const result = await pending;
    expect(result.ok).toBe(false);

    socket.triggerJson(agentResponse('slow'));
    expect(events).toEqual([]);
    expect(client.state).toBe('connected');
  });

  it('clears the timer when a request settles', async () => {
    const { client, socket, scheduler } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));
    expect(scheduler.pendingCount).toBe(1);
    socket.triggerJson(agentResponse('req-1'));
    await pending;
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('BackendClient cancel', () => {
  it('fails the request once, clears its timer and sends cancel once', async () => {
    const { client, socket, scheduler } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));
    client.cancel('req-1');
    const result = await pending;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('cancelled');
    expect(socket.sentMessages[2]).toEqual({ version: 1, type: 'cancel', targetId: 'req-1' });
    expect(scheduler.pendingCount).toBe(0);
  });

  it('is idempotent: a second cancel sends nothing', async () => {
    const { client, socket } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));
    client.cancel('req-1');
    client.cancel('req-1');
    await pending;
    expect(sentTypes(socket).filter((type) => type === 'cancel')).toHaveLength(1);
  });

  it('ignores a cancel for an unknown id', () => {
    const { client, socket } = connected();
    client.cancel('never-sent');
    expect(sentTypes(socket)).toEqual(['hello']);
  });

  it('ignores a late response for a cancelled request', async () => {
    const { client, socket, events } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));
    client.cancel('req-1');
    await pending;
    socket.triggerJson(agentResponse('req-1'));
    expect(events).toEqual([]);
  });
});

describe('BackendClient disconnect', () => {
  it('fails every in-flight request when the socket closes unexpectedly', async () => {
    const { client, socket, scheduler, states } = connected();
    const a = client.requestAgent(agentRequest('a'));
    const b = client.requestAgent(agentRequest('b'));
    const c = client.requestAgent(agentRequest('c'));

    socket.triggerClose();
    const results = await Promise.all([a, b, c]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('disconnected');
    }
    expect(scheduler.pendingCount).toBe(0);
    expect(client.state).toBe('disconnected');
    expect(states.at(-1)).toBe('disconnected');
    expect(client.capabilities).toBeNull();
  });

  it('treats a socket error like a disconnect', async () => {
    const { client, socket } = connected();
    const pending = client.requestAgent(agentRequest());
    socket.triggerError();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(client.state).toBe('disconnected');
  });

  it('fails in-flight requests on an intentional disconnect and closes the socket', async () => {
    const { client, socket } = connected();
    const pending = client.requestAgent(agentRequest());
    client.disconnect();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(client.state).toBe('disconnected');
    expect(socket.closeCalls).toHaveLength(1);
  });

  it('does not replay failed requests after a reconnect', async () => {
    const { client, factory, socket } = connected();
    const pending = client.requestAgent(agentRequest('req-1'));
    socket.triggerClose();
    await pending;

    client.connect();
    const next = factory.last;
    next.triggerOpen();
    next.triggerJson(HELLO_ACK);
    expect(sentTypes(next)).toEqual(['hello']);
  });

  it('ignores events from a stale socket after reconnecting', () => {
    const { client, factory, socket: oldSocket, events } = connected();
    oldSocket.triggerClose();
    client.connect();
    const newSocket = factory.last;
    expect(newSocket).not.toBe(oldSocket);

    oldSocket.triggerJson(HELLO_ACK);
    expect(client.state).toBe('connecting');
    oldSocket.triggerClose();
    expect(client.state).toBe('connecting');

    newSocket.triggerOpen();
    newSocket.triggerJson(HELLO_ACK);
    expect(client.state).toBe('connected');
    oldSocket.triggerJson(errorMessage());
    expect(events).toEqual([]);
  });

  it('allows an explicit connect after incompatible', () => {
    const { client, factory } = build();
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerJson({ ...HELLO_ACK, supportedVersions: [9] });
    expect(client.state).toBe('incompatible');

    client.connect();
    expect(factory.sockets).toHaveLength(2);
    expect(client.state).toBe('connecting');
  });
});

describe('BackendClient events and subscriptions', () => {
  it('stops delivering to an unsubscribed listener', () => {
    const { client, socket } = connected();
    const received: BackendEvent[] = [];
    const subscription = client.onEvent((event) => received.push(event));
    socket.triggerJson(errorMessage());
    subscription.dispose();
    socket.triggerJson(errorMessage());
    expect(received).toHaveLength(1);
  });

  it('isolates a throwing listener from the others and from connection state', () => {
    const { client, socket } = connected();
    const received: BackendEvent[] = [];
    client.onEvent(() => { throw new Error('listener bug'); });
    client.onEvent((event) => received.push(event));

    socket.triggerJson(errorMessage());
    socket.triggerJson(errorMessage());

    expect(received).toHaveLength(2);
    expect(client.state).toBe('connected');
  });

  it('isolates a throwing state listener', () => {
    const { client, factory } = build();
    client.onStateChange(() => { throw new Error('state listener bug'); });
    const seen: string[] = [];
    client.onStateChange((state) => seen.push(state));
    client.connect();
    factory.last.triggerOpen();
    factory.last.triggerJson(HELLO_ACK);
    expect(seen).toEqual(['connecting', 'connected']);
  });
});

describe('BackendClient token handling', () => {
  it('never exposes the token through logs, events, errors or later frames', async () => {
    const { client, socket, logger, events, scheduler } = connected({ token: SECRET_TOKEN });
    const pending = client.requestAgent(agentRequest('req-1'));
    scheduler.advance(AGENT_REQUEST_TIMEOUT_MS);
    const timedOut = await pending;

    socket.triggerJson(errorMessage());
    socket.triggerClose();

    const frames = socket.sent.slice(1).join('\n');
    expect(frames).not.toContain(SECRET_TOKEN);
    expect(logger.lines.join('\n')).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(events)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(timedOut)).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(client.capabilities)).not.toContain(SECRET_TOKEN);
  });
});

describe('Task 6.14 boundaries', () => {
  const backendDir = resolve(__dirname, '../../src/backend');
  const files = ['backendClient.ts', 'connectionManager.ts'];

  it.each(files)('%s does not touch the webview, the vscode API or action execution', (file) => {
    const source = readFileSync(resolve(backendDir, file), 'utf8');
    const code = source
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
      .join('\n');
    expect(code).not.toMatch(/acquireVsCodeApi/);
    expect(code).not.toMatch(/from 'vscode'/);
    expect(code).not.toMatch(/ActionExecutor|ActionGate|ActionValidator/);
    expect(code).not.toMatch(/webview/i);
  });

  it('does not hard-code the 25 s timeout outside its named constant', () => {
    const source = readFileSync(resolve(backendDir, 'backendClient.ts'), 'utf8');
    expect(source.match(/25_?000/g)).toHaveLength(1);
  });
});
