import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import {
  ConnectionManager,
  RECONNECT_MAX_DELAY_MS,
  reconnectDelayMs,
} from '../../src/backend/connectionManager';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
};

/** A scheduler whose clearTimeout does nothing, to prove callbacks re-check intent themselves. */
class LeakyScheduler extends FakeScheduler {
  public override clearTimeout(): void {
    // Intentionally leaves the timer scheduled.
  }
}

function build(options: { url?: string; managerScheduler?: FakeScheduler } = {}) {
  const factory = new FakeSocketFactory();
  const clientScheduler = new FakeScheduler();
  const managerScheduler = options.managerScheduler ?? new FakeScheduler();
  const client = new BackendClient({
    url: options.url ?? DEFAULT_BACKEND_URL,
    socketFactory: factory.create,
    scheduler: clientScheduler,
  });
  const manager = new ConnectionManager({ client, scheduler: managerScheduler });
  const states: string[] = [];
  manager.onStateChange((state) => states.push(state));
  return { client, manager, factory, clientScheduler, managerScheduler, states };
}

type Harness = ReturnType<typeof build>;

function handshake(harness: Harness): void {
  harness.factory.last.triggerOpen();
  harness.factory.last.triggerJson(HELLO_ACK);
}

/** The newest socket fails before the handshake finishes; the pending retry then fires. */
function failAndRetry(harness: Harness, expectedDelay: number): void {
  const before = harness.factory.sockets.length;
  harness.factory.last.triggerClose();
  expect(harness.managerScheduler.pendingDelays).toEqual([expectedDelay]);
  harness.managerScheduler.advance(expectedDelay);
  expect(harness.factory.sockets).toHaveLength(before + 1);
}

describe('reconnectDelayMs', () => {
  it('follows 1, 2, 4, 8 and then caps at 15 seconds', () => {
    const delays = Array.from({ length: 9 }, (_unused, attempt) => reconnectDelayMs(attempt));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000, 15000]);
  });

  it('never exceeds the cap, even for absurd attempt counts, and never yields 16 s', () => {
    for (const attempt of [4, 5, 10, 100, 10_000, Number.MAX_SAFE_INTEGER]) {
      expect(reconnectDelayMs(attempt)).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
    }
    expect(reconnectDelayMs(4)).not.toBe(16_000);
  });

  it('treats a negative attempt as the first retry', () => {
    expect(reconnectDelayMs(-3)).toBe(1000);
  });
});

describe('ConnectionManager lifecycle', () => {
  it('starts disconnected and opens nothing on construction', () => {
    const { manager, factory } = build();
    expect(manager.state).toBe('disconnected');
    expect(factory.sockets).toHaveLength(0);
  });

  it('starts one connection when the panel opens', () => {
    const { manager, factory, client } = build();
    manager.setPanelOpen(true);
    expect(factory.sockets).toHaveLength(1);
    expect(client.state).toBe('connecting');
  });

  it('does not duplicate a connection on repeated open while connecting or connected', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.manager.setPanelOpen(true);
    expect(harness.factory.sockets).toHaveLength(1);

    handshake(harness);
    harness.manager.setPanelOpen(true);
    expect(harness.factory.sockets).toHaveLength(1);
  });

  it('reports connected only after a valid hello_ack', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerOpen();
    expect(harness.manager.state).toBe('connecting');

    harness.factory.last.triggerJson(HELLO_ACK);
    expect(harness.manager.state).toBe('connected');
    expect(harness.states).toEqual(['connecting', 'connected']);
  });
});

describe('ConnectionManager backoff', () => {
  it('schedules a 1 s retry after an unexpected disconnect while the panel is open', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    handshake(harness);

    harness.factory.last.triggerClose();
    expect(harness.manager.state).toBe('disconnected');
    expect(harness.managerScheduler.pendingDelays).toEqual([1000]);

    harness.managerScheduler.advance(999);
    expect(harness.factory.sockets).toHaveLength(1);
    harness.managerScheduler.advance(1);
    expect(harness.factory.sockets).toHaveLength(2);
    expect(harness.manager.state).toBe('connecting');
  });

  it('retries after 1 s, 2 s, 4 s, 8 s, then 15 s and keeps 15 s', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);

    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000, 15000]) {
      failAndRetry(harness, delay);
    }
    expect(harness.managerScheduler.registeredDelays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    expect(Math.max(...harness.managerScheduler.registeredDelays)).toBe(15000);
  });

  it('resets the backoff after a completed handshake', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    failAndRetry(harness, 1000);
    failAndRetry(harness, 2000);

    handshake(harness);
    expect(harness.manager.state).toBe('connected');

    harness.factory.last.triggerClose();
    expect(harness.managerScheduler.pendingDelays).toEqual([1000]);
  });

  it('does not reset the backoff on a bare transport open', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);

    harness.factory.last.triggerOpen();
    failAndRetry(harness, 1000);
    harness.factory.last.triggerOpen();
    failAndRetry(harness, 2000);
    harness.factory.last.triggerOpen();
    failAndRetry(harness, 4000);
  });

  it('retries after the handshake times out', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerOpen();
    harness.clientScheduler.advance(10_000);
    expect(harness.manager.state).toBe('disconnected');
    expect(harness.managerScheduler.pendingDelays).toEqual([1000]);
  });

  it('retries when the socket factory throws', () => {
    const harness = build();
    harness.factory.throwOnCreate = true;
    harness.manager.setPanelOpen(true);
    expect(harness.managerScheduler.pendingDelays).toEqual([1000]);

    harness.factory.throwOnCreate = false;
    harness.managerScheduler.advance(1000);
    expect(harness.manager.state).toBe('connecting');
  });

  it('does not retry an invalid backend URL', () => {
    const harness = build({ url: 'ws://192.168.1.5:8765/ws' });
    harness.manager.setPanelOpen(true);
    expect(harness.factory.sockets).toHaveLength(0);
    expect(harness.managerScheduler.pendingCount).toBe(0);
    expect(harness.manager.state).toBe('disconnected');
  });
});

describe('ConnectionManager panel intent', () => {
  it('cancels a pending retry when the panel closes', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerClose();
    expect(harness.managerScheduler.pendingCount).toBe(1);

    harness.manager.setPanelOpen(false);
    expect(harness.managerScheduler.pendingCount).toBe(0);
    harness.managerScheduler.advance(60_000);
    expect(harness.factory.sockets).toHaveLength(1);
  });

  it('closes the socket on purpose and never reconnects after the panel closes', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    handshake(harness);
    const socket = harness.factory.last;

    harness.manager.setPanelOpen(false);
    expect(socket.closeCalls).toHaveLength(1);
    expect(harness.manager.state).toBe('disconnected');
    expect(harness.managerScheduler.pendingCount).toBe(0);

    socket.triggerClose();
    harness.managerScheduler.advance(60_000);
    expect(harness.factory.sockets).toHaveLength(1);
  });

  it('does not reconnect from a retry callback that fires after the panel closed', () => {
    const managerScheduler = new LeakyScheduler();
    const harness = build({ managerScheduler });
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerClose();
    expect(managerScheduler.pendingCount).toBe(1);

    harness.manager.setPanelOpen(false);
    managerScheduler.advance(1000);
    expect(harness.factory.sockets).toHaveLength(1);
    expect(harness.manager.state).toBe('disconnected');
  });

  it('starts a clean lifecycle when the panel reopens after an intentional close', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    failAndRetry(harness, 1000);
    failAndRetry(harness, 2000);

    harness.manager.setPanelOpen(false);
    expect(harness.managerScheduler.pendingCount).toBe(0);
    harness.manager.setPanelOpen(true);
    expect(harness.manager.state).toBe('connecting');

    harness.factory.last.triggerClose();
    expect(harness.managerScheduler.pendingDelays).toEqual([1000]);
  });

  it('does not connect again when the panel is closed twice', () => {
    const harness = build();
    harness.manager.setPanelOpen(false);
    harness.manager.setPanelOpen(true);
    harness.manager.setPanelOpen(false);
    harness.manager.setPanelOpen(false);
    expect(harness.factory.sockets).toHaveLength(1);
  });
});

describe('ConnectionManager incompatible protocol', () => {
  function makeIncompatible(harness: Harness): void {
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerOpen();
    harness.factory.last.triggerJson({ ...HELLO_ACK, supportedVersions: [2] });
  }

  it('never schedules a reconnect', () => {
    const harness = build();
    makeIncompatible(harness);

    expect(harness.manager.state).toBe('incompatible');
    expect(harness.managerScheduler.pendingCount).toBe(0);
    harness.managerScheduler.advance(120_000);
    expect(harness.factory.sockets).toHaveLength(1);
    expect(harness.factory.last.closeCalls).toHaveLength(1);
  });

  it('cancels a pending retry when the state turns incompatible', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerClose();
    harness.managerScheduler.advance(1000);

    harness.factory.last.triggerOpen();
    harness.factory.last.triggerJson({ ...HELLO_ACK, supportedVersions: [2] });
    expect(harness.managerScheduler.pendingCount).toBe(0);
    expect(harness.manager.state).toBe('incompatible');
  });

  it('allows a fresh attempt only after the panel is closed and reopened', () => {
    const harness = build();
    makeIncompatible(harness);

    harness.manager.setPanelOpen(true);
    expect(harness.factory.sockets).toHaveLength(1);

    harness.manager.setPanelOpen(false);
    harness.manager.setPanelOpen(true);
    expect(harness.factory.sockets).toHaveLength(2);
    expect(harness.manager.state).toBe('connecting');
  });
});

describe('ConnectionManager races', () => {
  it('schedules only one retry when the same socket reports error and close', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerError();
    harness.factory.last.triggerClose();
    harness.factory.last.triggerError();
    expect(harness.managerScheduler.registeredDelays).toEqual([1000]);
  });

  it('lets a stale socket neither corrupt a newer connection nor schedule another retry', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    const oldSocket = harness.factory.last;
    oldSocket.triggerClose();
    harness.managerScheduler.advance(1000);
    const newSocket = harness.factory.last;
    expect(newSocket).not.toBe(oldSocket);

    oldSocket.triggerClose();
    oldSocket.triggerJson(HELLO_ACK);
    expect(harness.manager.state).toBe('connecting');
    expect(harness.managerScheduler.pendingCount).toBe(0);

    newSocket.triggerOpen();
    newSocket.triggerJson(HELLO_ACK);
    expect(harness.manager.state).toBe('connected');
  });

  it('does not fire the retry when the client is no longer disconnected', () => {
    const managerScheduler = new LeakyScheduler();
    const harness = build({ managerScheduler });
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerClose();

    // The client is connected by another path before the stale retry fires.
    harness.client.connect();
    handshake(harness);
    expect(harness.manager.state).toBe('connected');

    managerScheduler.advance(1000);
    expect(harness.factory.sockets).toHaveLength(2);
  });

  it('stops everything after dispose', () => {
    const harness = build();
    harness.manager.setPanelOpen(true);
    harness.factory.last.triggerClose();

    harness.manager.dispose();
    harness.manager.setPanelOpen(true);
    harness.managerScheduler.advance(60_000);

    expect(harness.factory.sockets).toHaveLength(1);
    expect(harness.managerScheduler.pendingCount).toBe(0);
  });

  it('keeps notifying other state listeners when one throws', () => {
    const harness = build();
    harness.manager.onStateChange(() => { throw new Error('listener bug'); });
    harness.manager.setPanelOpen(true);
    expect(harness.states).toEqual(['connecting']);
  });
});

describe('ConnectionManager boundaries', () => {
  it('uses the injected scheduler rather than real timers', () => {
    const source = readFileSync(resolve(__dirname, '../../src/backend/connectionManager.ts'), 'utf8');
    expect(source).not.toMatch(/(^|[^.\w])setTimeout\(/m);
    expect(source).not.toMatch(/(^|[^.\w])setInterval\(/m);
  });
});
