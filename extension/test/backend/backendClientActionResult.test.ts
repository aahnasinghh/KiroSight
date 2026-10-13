import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import type { WireActionResult } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
};

function build() {
  const factory = new FakeSocketFactory();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
  return { client, factory };
}

function connected() {
  const harness = build();
  harness.client.connect();
  const socket = harness.factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  return { ...harness, socket };
}

const result = (changes: Partial<WireActionResult> = {}): WireActionResult =>
  ({ actionType: 'RUN_TESTS', status: 'declined', message: 'you declined', ...changes });

describe('BackendClient.sendActionResult', () => {
  it('sends one valid action_result frame correlated by replyTo', () => {
    const { client, socket } = connected();

    expect(client.sendActionResult('R1', result())).toBe(true);

    const frames = socket.sentMessages.filter((message) => message.type === 'action_result');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({ version: 1, type: 'action_result', replyTo: 'R1', result: result() });
    expect(validateProtocolMessage(frames[0]).ok).toBe(true);
  });

  it('carries every status the protocol defines', () => {
    const { client, socket } = connected();
    for (const status of ['ok', 'failed', 'declined', 'not_permitted', 'needs_clarification', 'not_configured'] as const) {
      expect(client.sendActionResult('R1', result({ status }))).toBe(true);
    }
    expect(socket.sentMessages.filter((message) => message.type === 'action_result')).toHaveLength(6);
  });

  it('sends nothing, and reports false, before the handshake and after a disconnect', () => {
    const idle = build();
    expect(idle.client.sendActionResult('R1', result())).toBe(false);

    const { client, socket } = connected();
    client.disconnect();
    expect(client.sendActionResult('R1', result())).toBe(false);
    expect(socket.sentMessages.filter((message) => message.type === 'action_result')).toEqual([]);
  });

  it('does not queue a result for a later connection', () => {
    const { client, factory } = build();
    expect(client.sendActionResult('R1', result())).toBe(false);

    client.connect();
    const socket = factory.last;
    socket.triggerOpen();
    socket.triggerJson(HELLO_ACK);

    expect(socket.sentMessages.map((message) => message.type)).toEqual(['hello']);
  });

  it('refuses a result that does not validate, such as one with an absolute path', () => {
    const { client, socket } = connected();
    const bad = result({
      status: 'ok',
      details: { kind: 'file_opened', relativePath: 'C:/private/secret.ts' },
    });

    expect(client.sendActionResult('R1', bad)).toBe(false);
    expect(socket.sentMessages.filter((message) => message.type === 'action_result')).toEqual([]);
  });
});
