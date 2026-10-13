import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const FIRST = 'SUPER_SECRET_BACKEND_TOKEN_123';
const SECOND = 'SUPER_SECRET_BACKEND_TOKEN_456';

function build(token?: string) {
  const factory = new FakeSocketFactory();
  const client = new BackendClient({
    url: DEFAULT_BACKEND_URL,
    socketFactory: factory.create,
    scheduler: new FakeScheduler(),
    ...(token === undefined ? {} : { token }),
  });
  return { client, factory };
}

function handshake(factory: FakeSocketFactory): Record<string, unknown> {
  factory.last.triggerOpen();
  return factory.last.sentMessages[0]!;
}

describe('BackendClient.setToken', () => {
  it('uses the new token only on the next hello and never changes a hello already sent', () => {
    const { client, factory } = build(FIRST);

    client.connect();
    const firstHello = handshake(factory);
    client.setToken(SECOND);

    expect(firstHello.token).toBe(FIRST);
    expect(factory.sockets[0]!.sent.join('\n')).not.toContain(SECOND);

    client.disconnect();
    client.connect();
    expect(handshake(factory).token).toBe(SECOND);
    expect(factory.sockets).toHaveLength(2);
  });

  it('clears the token for an empty or undefined value so no token field is sent', () => {
    const { client, factory } = build(FIRST);

    client.setToken('');
    client.connect();
    expect(handshake(factory)).not.toHaveProperty('token');

    client.disconnect();
    client.setToken(FIRST);
    client.setToken(undefined);
    client.connect();
    expect(handshake(factory)).not.toHaveProperty('token');
  });

  it('can set a token on a client constructed without one', () => {
    const { client, factory } = build();
    client.setToken(FIRST);
    client.connect();
    expect(handshake(factory).token).toBe(FIRST);
  });
});
