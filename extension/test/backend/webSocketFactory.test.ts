import { describe, expect, it } from 'vitest';

import { createGlobalWebSocketFactory } from '../../src/backend/webSocketFactory';

describe('createGlobalWebSocketFactory', () => {
  it('constructs the WebSocket global it is given with the validated URL, without connecting itself', () => {
    const created: string[] = [];
    class FakeGlobalWebSocket {
      public constructor(public readonly url: string) { created.push(url); }
    }
    const factory = createGlobalWebSocketFactory({ WebSocket: FakeGlobalWebSocket });

    const socket = factory('ws://127.0.0.1:8765/ws') as unknown as FakeGlobalWebSocket;

    expect(socket).toBeInstanceOf(FakeGlobalWebSocket);
    expect(created).toEqual(['ws://127.0.0.1:8765/ws']);
  });

  it('does nothing until the factory is called', () => {
    let constructed = 0;
    class Counting { public constructor() { constructed += 1; } }
    createGlobalWebSocketFactory({ WebSocket: Counting });
    expect(constructed).toBe(0);
  });

  it('throws a generic error when the runtime has no WebSocket, so the client fails safely', () => {
    const factory = createGlobalWebSocketFactory({});
    expect(() => factory('ws://127.0.0.1:8765/ws')).toThrow('WebSocket is not available in this runtime.');
  });
});
