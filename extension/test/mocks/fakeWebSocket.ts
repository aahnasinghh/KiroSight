import type { WebSocketFactory, WebSocketLike } from '../../src/backend/backendClient';

/** Deterministic socket: tests trigger open/message/close/error by hand and inspect what was sent. */
export class FakeWebSocket implements WebSocketLike {
  public readyState = 0;
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;

  public readonly sent: string[] = [];
  public readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  public throwOnSend = false;

  public constructor(public readonly url: string) {}

  public send(data: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
  }

  /** Parsed frames the client sent, in order. */
  public get sentMessages(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(frame) as Record<string, unknown>);
  }

  public triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  public triggerMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  public triggerJson(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** The server closed the connection. */
  public triggerClose(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  public triggerError(): void {
    this.onerror?.({});
  }
}

/** A factory that records every socket it creates. */
export class FakeSocketFactory {
  public readonly sockets: FakeWebSocket[] = [];
  public throwOnCreate = false;

  public readonly create: WebSocketFactory = (url) => {
    if (this.throwOnCreate) throw new Error('create failed');
    const socket = new FakeWebSocket(url);
    this.sockets.push(socket);
    return socket;
  };

  public get last(): FakeWebSocket {
    const socket = this.sockets[this.sockets.length - 1];
    if (socket === undefined) throw new Error('no socket was created');
    return socket;
  }
}
