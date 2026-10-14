import { PROTOCOL_VERSION } from '../protocol/constants';
import type {
  ActionRequest,
  ActionResultMessage,
  AgentRequest,
  AudioClip,
  AgentResponse,
  Cancel,
  Capabilities,
  ErrorCode,
  ErrorMessage,
  Hello,
  ProtocolMessage,
  SpeechAudio,
  TranscriptionResult,
  WireActionResult,
} from '../protocol/messages';
import { validateProtocolMessage } from '../protocol/validators';
import { err, ok, type Result } from '../util/result';

/**
 * The single extension-host <-> backend WebSocket (design.md, "Backend client and connection
 * management"; Req 19.2). The extension host owns this socket. The webview never sees it, and no
 * backend URL or token is ever placed on the webview bridge.
 *
 * This class transports validated protocol messages only. It never executes an action: an
 * `agent_response` or `action_request` is handed to the caller untouched, and ActionValidator /
 * the confirmation gate decide what happens next.
 */

/** Design: "Agent request 25 s". Named once; never repeated as a literal. */
export const AGENT_REQUEST_TIMEOUT_MS = 25_000;

/**
 * Req 10.3 gives the voice layer 10 s for handshake and capability checks. A socket that opens
 * but never answers `hello` must not leave the client in `connecting` forever.
 */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/** Matches the documented manual start: `uvicorn app.main:app --host 127.0.0.1 --port 8765`. */
export const DEFAULT_BACKEND_URL = 'ws://127.0.0.1:8765/ws';

/** `WebSocket.OPEN`, spelled out so this module needs no DOM or Node WebSocket global. */
export const WEBSOCKET_OPEN = 1;

const NORMAL_CLOSURE = 1000;
const MAX_BACKEND_MESSAGE_CHARS = 200;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'incompatible';

// --- socket abstraction ---

/**
 * The minimum a WebSocket must offer. It is deliberately compatible with the standard
 * `WebSocket` (Node 22+ global, `ws`) and trivial to fake in tests. Inbound `data` is `unknown`
 * because this milestone accepts text frames only.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Creates a socket for an already validated, loopback-only URL. */
export type WebSocketFactory = (url: string) => WebSocketLike;

// --- timers ---

export type TimerHandle = unknown;

/** Injectable so tests never wait in real time. Production uses real milliseconds. */
export interface Scheduler {
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const realScheduler: Scheduler = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

// --- shared small types ---

export interface Disposable {
  dispose(): void;
}

/** Metadata-only logging. Implemented by KiroSightLogger. */
export interface BackendLogger {
  debug(message: string, metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
  info(message: string, metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
  warn(message: string, metadata?: Readonly<Record<string, string | number | boolean | null | undefined>>): void;
}

/** Messages the backend may push to the host outside a direct request/response pair. */
export type BackendEvent = ActionRequest | TranscriptionResult | SpeechAudio | ErrorMessage;

export type BackendClientErrorKind =
  | 'not_connected'
  | 'timeout'
  | 'disconnected'
  | 'incompatible'
  | 'protocol_error'
  | 'cancelled'
  | 'backend_error'
  | 'invalid_url';

/** Client-local errors. These are NOT wire ErrorCodes, and the message is always generic. */
export interface BackendClientError {
  readonly kind: BackendClientErrorKind;
  readonly message: string;
  /** Only for `backend_error`: the backend's own ErrorCode. */
  readonly backendCode?: ErrorCode;
  readonly recoverable?: boolean;
}

function clientError(kind: BackendClientErrorKind, message: string): BackendClientError {
  return { kind, message };
}

// --- loopback URL validation ---

const LOOPBACK_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/**
 * Accepts `kirosight.backendUrl` only when it is a `ws:` / `wss:` URL with a loopback host
 * (design.md: `127.0.0.1`, `::1` or `localhost`) and no userinfo. The host is compared after URL
 * parsing, so `localhost.evil.com`, `0.0.0.0` and private ranges are rejected. No DNS lookup is
 * made and an unsafe URL is never rewritten. On success the returned string is the parsed form
 * that was checked, which is what the socket factory receives.
 */
export function validateBackendUrl(raw: string): Result<string, BackendClientError> {
  const invalid = (message: string): Result<never, BackendClientError> =>
    err(clientError('invalid_url', message));

  if (typeof raw !== 'string' || raw.trim() === '') {
    return invalid('The backend URL is empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return invalid('The backend URL is not a valid URL.');
  }

  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return invalid('The backend URL must use ws: or wss:.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return invalid('The backend URL must not contain credentials.');
  }
  if (!LOOPBACK_HOSTNAMES.includes(parsed.hostname)) {
    return invalid('The backend URL must point to a loopback host.');
  }

  return ok(parsed.href);
}

// --- client ---

export interface BackendClientOptions {
  /** Raw `kirosight.backendUrl` value. Validated on every connect(), never silently rewritten. */
  readonly url: string;
  readonly socketFactory: WebSocketFactory;
  /** Opaque secret. Sent only inside `hello`; never logged, emitted or retained in request state. */
  readonly token?: string;
  readonly scheduler?: Scheduler;
  readonly logger?: BackendLogger;
}

interface InFlight {
  readonly timer: TimerHandle;
  readonly settle: (result: Result<AgentResponse, BackendClientError>) => void;
}

export class BackendClient {
  private readonly url: string;
  private readonly socketFactory: WebSocketFactory;
  private token: string | undefined;
  private readonly scheduler: Scheduler;
  private readonly logger: BackendLogger | undefined;

  private currentState: ConnectionState = 'disconnected';
  private currentCapabilities: Capabilities | null = null;
  private socket: WebSocketLike | null = null;
  private handshakeTimer: TimerHandle | undefined;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly eventListeners = new Set<(event: BackendEvent) => void>();
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  /** Construction has no side effects: no socket is created until connect(). */
  public constructor(options: BackendClientOptions) {
    this.url = options.url;
    this.socketFactory = options.socketFactory;
    this.token = options.token !== undefined && options.token !== '' ? options.token : undefined;
    this.scheduler = options.scheduler ?? realScheduler;
    this.logger = options.logger;
  }

  public get state(): ConnectionState {
    return this.currentState;
  }

  public get capabilities(): Capabilities | null {
    return this.currentCapabilities;
  }

  /**
   * Replaces the optional handshake token. It is read only when the next `hello` is built, so a
   * live connection is never affected and no already-sent frame is changed. An empty value clears
   * it. The token is never logged, emitted or exposed through any getter.
   */
  public setToken(token: string | undefined): void {
    this.token = token !== undefined && token !== '' ? token : undefined;
  }

  /**
   * Starts one connection attempt. A no-op while already `connecting` or `connected`. Allowed from
   * `disconnected` and from `incompatible` (an explicit retry). Returns before the handshake
   * completes: watch onStateChange for `connected`.
   */
  public connect(): Result<void, BackendClientError> {
    if (this.currentState === 'connecting' || this.currentState === 'connected') {
      return ok(undefined);
    }

    const url = validateBackendUrl(this.url);
    if (!url.ok) {
      this.logger?.warn('Backend URL rejected', { kind: url.error.kind });
      return err(url.error);
    }

    this.setState('connecting');

    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(url.value);
    } catch {
      this.logger?.warn('Backend socket could not be created');
      this.setState('disconnected');
      return err(clientError('not_connected', 'The backend connection could not be started.'));
    }

    this.socket = socket;
    socket.onopen = () => this.onSocketOpen(socket);
    socket.onmessage = (event) => this.onSocketMessage(socket, event.data);
    socket.onclose = () => this.onSocketGone(socket, 'closed');
    socket.onerror = () => this.onSocketGone(socket, 'error');

    this.handshakeTimer = this.scheduler.setTimeout(() => {
      this.handshakeTimer = undefined;
      if (this.socket === socket && this.currentState === 'connecting') {
        this.logger?.warn('Backend handshake timed out');
        this.onSocketGone(socket, 'handshake_timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);

    return ok(undefined);
  }

  /** Intentional shutdown. Fails in-flight requests and never triggers a reconnect by itself. */
  public disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.clearHandshakeTimer();
    this.currentCapabilities = null;
    this.failAll(clientError('disconnected', 'The backend connection was closed.'));
    this.setState('disconnected');
    this.closeQuietly(socket, 'client disconnect');
  }

  /**
   * Sends one agent request and resolves exactly once: with the matching `agent_response`, or
   * with a safe client error (timeout, cancel, disconnect, backend error). Failed requests are
   * never replayed after a reconnect.
   */
  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>> {
    if (this.currentState === 'incompatible') {
      return Promise.resolve(err(clientError('incompatible', 'The backend uses an incompatible protocol version.')));
    }
    if (!this.isUsable()) {
      return Promise.resolve(err(clientError('not_connected', 'The backend is not connected.')));
    }
    if (this.inFlight.has(request.id)) {
      return Promise.resolve(err(clientError('protocol_error', 'A request with this id is already in flight.')));
    }

    const serialized = this.serialize(request);
    if (serialized === undefined) {
      return Promise.resolve(err(clientError('protocol_error', 'The request is not a valid protocol message.')));
    }

    return new Promise((resolve) => {
      const id = request.id;
      let settled = false;
      const settle = (result: Result<AgentResponse, BackendClientError>): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // Register before sending so a synchronous reply can always be correlated.
      const timer = this.scheduler.setTimeout(() => {
        if (!this.inFlight.delete(id)) return;
        this.logger?.warn('Agent request timed out', { id });
        this.sendCancel(id);
        settle(err(clientError('timeout', 'The backend did not answer in time.')));
      }, AGENT_REQUEST_TIMEOUT_MS);
      this.inFlight.set(id, { timer, settle });

      try {
        this.requireSocket().send(serialized);
      } catch {
        this.inFlight.delete(id);
        this.scheduler.clearTimeout(timer);
        settle(err(clientError('not_connected', 'The request could not be sent.')));
      }
    });
  }

  /**
   * Tells the backend what the extension did with an action it proposed (Req 5.4, 5.5, 5.11).
   * Returns false, having sent nothing, when the connection is not usable or the message does not
   * validate. An action_result is never queued and never replayed after a reconnect: it describes
   * one decision about one live request.
   */
  public sendActionResult(replyTo: string, result: WireActionResult): boolean {
    if (!this.isUsable()) return false;
    const message: ActionResultMessage = {
      version: PROTOCOL_VERSION,
      type: 'action_result',
      replyTo,
      result,
    };
    const serialized = this.serialize(message);
    if (serialized === undefined) return false;
    try {
      this.requireSocket().send(serialized);
      return true;
    } catch {
      this.logger?.warn('Action result could not be sent');
      return false;
    }
  }

  /**
   * Sends one finished recording to the backend for speech-to-text. Returns false, having sent
   * nothing, when the connection is not usable or the frame does not validate. A recording is
   * never queued and never replayed after a reconnect: it belongs to one capture the user made.
   * The frame content is never logged.
   */
  public sendAudioClip(clip: {
    readonly id: string;
    readonly mimeType: string;
    readonly base64: string;
    readonly seq?: number;
    readonly final?: boolean;
  }): boolean {
    if (!this.isUsable()) return false;
    const message: AudioClip = {
      version: PROTOCOL_VERSION,
      type: 'audio_clip',
      id: clip.id,
      mimeType: clip.mimeType,
      base64: clip.base64,
      ...(clip.seq !== undefined ? { seq: clip.seq } : {}),
      ...(clip.final !== undefined ? { final: clip.final } : {}),
    };
    const serialized = this.serialize(message);
    if (serialized === undefined) return false;
    try {
      this.requireSocket().send(serialized);
      return true;
    } catch {
      this.logger?.warn('Audio clip could not be sent');
      return false;
    }
  }

  /**
   * Tells the backend to discard a partly sent recording. Returns false, having sent nothing, when
   * the connection is not usable. (`cancel` only acts on in-flight agent requests.)
   */
  public cancelAudioClip(id: string): boolean {
    if (!this.isUsable()) return false;
    const cancel: Cancel = { version: PROTOCOL_VERSION, type: 'cancel', targetId: id };
    const serialized = this.serialize(cancel);
    if (serialized === undefined) return false;
    try {
      this.requireSocket().send(serialized);
      return true;
    } catch {
      this.logger?.warn('Audio cancel could not be sent');
      return false;
    }
  }

  /**
   * Cancels an in-flight request: fails it locally once, clears its timer and tells the backend.
   * Idempotent. A request that is not in flight (already settled, timed out or cancelled) is
   * ignored, so no second `cancel` is sent.
   */
  public cancel(targetId: string): void {
    const entry = this.inFlight.get(targetId);
    if (entry === undefined) return;

    this.inFlight.delete(targetId);
    this.scheduler.clearTimeout(entry.timer);
    this.sendCancel(targetId);
    entry.settle(err(clientError('cancelled', 'The request was cancelled.')));
  }

  /** Validated, unsolicited backend messages only. A throwing listener never affects the others. */
  public onEvent(listener: (event: BackendEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return { dispose: () => void this.eventListeners.delete(listener) };
  }

  public onStateChange(listener: (state: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => void this.stateListeners.delete(listener) };
  }

  // --- socket events (each guarded against stale sockets) ---

  private onSocketOpen(socket: WebSocketLike): void {
    if (this.socket !== socket || this.currentState !== 'connecting') return;

    const hello: Hello = {
      version: PROTOCOL_VERSION,
      type: 'hello',
      client: 'kirosight-extension',
      ...(this.token !== undefined ? { token: this.token } : {}),
    };
    const serialized = this.serialize(hello);
    if (serialized === undefined) {
      this.onSocketGone(socket, 'hello_invalid');
      return;
    }
    try {
      socket.send(serialized);
    } catch {
      this.onSocketGone(socket, 'hello_send_failed');
    }
  }

  private onSocketMessage(socket: WebSocketLike, data: unknown): void {
    if (this.socket !== socket) return;

    // Milestone 6 is text-only JSON. Binary frames are never parsed.
    if (typeof data !== 'string') {
      this.protocolFault(socket, 'binary_frame');
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(data);
    } catch {
      this.protocolFault(socket, 'invalid_json');
      return;
    }

    const validated = validateProtocolMessage(decoded);
    if (!validated.ok) {
      this.protocolFault(socket, validated.error.code);
      return;
    }

    this.dispatch(socket, validated.value);
  }

  /** The socket closed, errored or timed out. Handles unexpected loss. */
  private onSocketGone(socket: WebSocketLike, reason: string): void {
    if (this.socket !== socket) return;

    this.socket = null;
    this.clearHandshakeTimer();
    this.currentCapabilities = null;
    this.logger?.info('Backend connection lost', { reason });
    this.closeQuietly(socket, 'connection lost');
    this.failAll(clientError('disconnected', 'The backend connection was lost.'));
    this.setState('disconnected');
  }

  /** An undecodable or invalid inbound frame: never dispatched. Fatal only during the handshake. */
  private protocolFault(socket: WebSocketLike, reason: string): void {
    this.logger?.warn('Backend message rejected', { reason });
    if (this.currentState === 'connecting') {
      this.onSocketGone(socket, 'handshake_protocol_fault');
    }
  }

  private dispatch(socket: WebSocketLike, message: ProtocolMessage): void {
    if (this.currentState === 'connecting') {
      this.completeHandshake(socket, message);
      return;
    }
    if (this.currentState !== 'connected') return;

    switch (message.type) {
      case 'agent_response':
        this.settleResponse(message);
        return;
      case 'error_message':
        this.handleErrorMessage(message);
        return;
      case 'action_request':
      case 'transcription_result':
      case 'speech_audio':
        this.logger?.debug('Backend event', { type: message.type });
        this.emit(message);
        return;
      default:
        // A second hello_ack, or a message type that only flows extension to backend.
        this.logger?.warn('Unexpected backend message type dropped', { type: message.type });
    }
  }

  private completeHandshake(socket: WebSocketLike, message: ProtocolMessage): void {
    if (message.type === 'error_message') {
      // e.g. UNAUTHORIZED. Surface it (the backend never echoes credentials), then fail safely.
      this.emit(message);
      this.onSocketGone(socket, 'handshake_error_message');
      return;
    }
    if (message.type !== 'hello_ack') {
      this.protocolFault(socket, 'unexpected_handshake_type');
      return;
    }

    this.clearHandshakeTimer();

    if (!message.supportedVersions.includes(PROTOCOL_VERSION)) {
      // A valid hello_ack that excludes our version is permanent, not a transient outage.
      this.socket = null;
      this.currentCapabilities = null;
      this.logger?.warn('Backend protocol version incompatible');
      this.closeQuietly(socket, 'incompatible protocol');
      this.setState('incompatible');
      return;
    }

    this.currentCapabilities = message.capabilities;
    this.setState('connected');
  }

  private settleResponse(message: AgentResponse): void {
    const entry = this.inFlight.get(message.replyTo);
    if (entry === undefined) {
      // Late, cancelled, timed-out or unknown: never settles anything and is not surfaced.
      this.logger?.debug('Uncorrelated agent_response dropped');
      return;
    }
    this.inFlight.delete(message.replyTo);
    this.scheduler.clearTimeout(entry.timer);
    entry.settle(ok(message));
  }

  private handleErrorMessage(message: ErrorMessage): void {
    const entry = message.replyTo === undefined ? undefined : this.inFlight.get(message.replyTo);
    if (message.replyTo === undefined || entry === undefined) {
      this.emit(message);
      return;
    }
    this.inFlight.delete(message.replyTo);
    this.scheduler.clearTimeout(entry.timer);
    entry.settle(err({
      kind: 'backend_error',
      message: message.message.slice(0, MAX_BACKEND_MESSAGE_CHARS),
      backendCode: message.code,
      recoverable: message.recoverable,
    }));
  }

  // --- helpers ---

  private isUsable(): boolean {
    return this.currentState === 'connected'
      && this.socket !== null
      && this.socket.readyState === WEBSOCKET_OPEN;
  }

  private requireSocket(): WebSocketLike {
    if (this.socket === null) throw new Error('no socket');
    return this.socket;
  }

  /** Every outbound message is checked by the same validators the backend contract uses. */
  private serialize(message: ProtocolMessage): string | undefined {
    if (!validateProtocolMessage(message).ok) return undefined;
    return JSON.stringify(message);
  }

  private sendCancel(targetId: string): void {
    if (!this.isUsable()) return;
    const cancel: Cancel = { version: PROTOCOL_VERSION, type: 'cancel', targetId };
    const serialized = this.serialize(cancel);
    if (serialized === undefined) return;
    try {
      this.requireSocket().send(serialized);
    } catch {
      this.logger?.warn('Cancel could not be sent');
    }
  }

  private failAll(error: BackendClientError): void {
    const entries = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const entry of entries) {
      this.scheduler.clearTimeout(entry.timer);
      entry.settle(err(error));
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== undefined) {
      this.scheduler.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private closeQuietly(socket: WebSocketLike | null, reason: string): void {
    if (socket === null) return;
    try {
      socket.close(NORMAL_CLOSURE, reason);
    } catch {
      // Already closed or closing.
    }
  }

  private setState(next: ConnectionState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.logger?.info('Backend connection state', { state: next });
    for (const listener of [...this.stateListeners]) {
      try {
        listener(next);
      } catch {
        this.logger?.warn('State listener failed');
      }
    }
  }

  private emit(event: BackendEvent): void {
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch {
        this.logger?.warn('Event listener failed');
      }
    }
  }
}
