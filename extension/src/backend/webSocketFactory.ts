import type { WebSocketFactory, WebSocketLike } from './backendClient';

type WebSocketConstructor = new (url: string) => WebSocketLike;

/**
 * Production socket factory for the extension host. It uses the standard `WebSocket` global that
 * Node 22+ provides (the extension declares `engines.node >= 22.12.0`), so no extra dependency is
 * needed. Only a URL that BackendClient already validated as loopback ever reaches this factory.
 *
 * If the runtime has no WebSocket, the factory throws; BackendClient turns that into a safe
 * `disconnected` state and local features keep working.
 */
export function createGlobalWebSocketFactory(globalObject: object = globalThis): WebSocketFactory {
  return (url) => {
    const constructor = (globalObject as { WebSocket?: unknown }).WebSocket;
    if (typeof constructor !== 'function') {
      throw new Error('WebSocket is not available in this runtime.');
    }
    return new (constructor as WebSocketConstructor)(url);
  };
}
