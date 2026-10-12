import {
  realScheduler,
  type BackendClientError,
  type BackendLogger,
  type ConnectionState,
  type Disposable,
  type Scheduler,
  type TimerHandle,
} from './backendClient';
import type { Result } from '../util/result';

/**
 * Owns the desired connection lifecycle for one BackendClient (design.md, "Reconnect"): connect
 * lazily when the panel opens, retry with bounded exponential backoff only while the panel stays
 * open, and stop for good when the panel closes or the protocol is incompatible.
 *
 * The socket, handshake and request handling stay in BackendClient. Nothing here touches the
 * webview or VS Code; Task 6.19 wires panel visibility and settings into this class.
 */

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 15_000;

/**
 * Delay before retry number `attempt` (0-based): 1 s, 2 s, 4 s, 8 s, then capped at 15 s.
 * The cap is applied to the computed value, so 16 s never occurs.
 */
export function reconnectDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(0, Math.floor(attempt)), 30);
  return Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exponent);
}

/** The slice of BackendClient this manager needs. BackendClient satisfies it structurally. */
export interface ManagedBackendClient {
  readonly state: ConnectionState;
  connect(): Result<void, BackendClientError>;
  disconnect(): void;
  onStateChange(listener: (state: ConnectionState) => void): Disposable;
}

export interface ConnectionManagerOptions {
  readonly client: ManagedBackendClient;
  readonly scheduler?: Scheduler;
  readonly logger?: BackendLogger;
}

export class ConnectionManager implements Disposable {
  private readonly client: ManagedBackendClient;
  private readonly scheduler: Scheduler;
  private readonly logger: BackendLogger | undefined;
  private readonly subscription: Disposable;
  private readonly stateListeners = new Set<(state: ConnectionState) => void>();

  private panelOpen = false;
  private retryTimer: TimerHandle | undefined;
  private retryAttempt = 0;
  private disposed = false;

  /** Construction opens nothing. The first connection happens in setPanelOpen(true). */
  public constructor(options: ConnectionManagerOptions) {
    this.client = options.client;
    this.scheduler = options.scheduler ?? realScheduler;
    this.logger = options.logger;
    this.subscription = this.client.onStateChange((state) => this.onClientState(state));
  }

  public get state(): ConnectionState {
    return this.client.state;
  }

  /** Mirrors the client's state for observers; the webview is not told here (Task 6.19). */
  public onStateChange(listener: (state: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener);
    return { dispose: () => void this.stateListeners.delete(listener) };
  }

  /**
   * Panel visibility is the only reconnect intent. Opening starts a clean lifecycle (backoff
   * reset, one connection attempt). Closing cancels any pending retry, closes the socket on
   * purpose and never reconnects. Repeating the current value does nothing.
   */
  public setPanelOpen(open: boolean): void {
    if (this.disposed || open === this.panelOpen) return;
    this.panelOpen = open;

    if (open) {
      this.retryAttempt = 0;
      this.connectNow();
      return;
    }

    this.clearRetryTimer();
    this.retryAttempt = 0;
    // panelOpen is already false, so the resulting 'disconnected' schedules nothing.
    this.client.disconnect();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.setPanelOpen(false);
    this.disposed = true;
    this.subscription.dispose();
    this.stateListeners.clear();
  }

  // --- internals ---

  private connectNow(): void {
    const result = this.client.connect();
    if (!result.ok && result.error.kind === 'invalid_url') {
      // A bad configuration will not fix itself; retrying would only spin.
      this.logger?.warn('Backend connection not attempted', { kind: result.error.kind });
    }
  }

  private onClientState(state: ConnectionState): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch {
        this.logger?.warn('Connection state listener failed');
      }
    }

    switch (state) {
      case 'connected':
        // Only a completed hello_ack resets the backoff, never a bare transport open.
        this.retryAttempt = 0;
        this.clearRetryTimer();
        return;
      case 'incompatible':
        this.clearRetryTimer();
        return;
      case 'disconnected':
        this.scheduleRetry();
        return;
      case 'connecting':
        return;
    }
  }

  private scheduleRetry(): void {
    if (this.disposed || !this.panelOpen || this.retryTimer !== undefined) return;

    const delayMs = reconnectDelayMs(this.retryAttempt);
    this.retryAttempt += 1;
    this.logger?.info('Backend reconnect scheduled', { attempt: this.retryAttempt, delayMs });

    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = undefined;
      // Re-check intent: the panel may have closed or the protocol turned incompatible meanwhile.
      if (this.disposed || !this.panelOpen) return;
      if (this.client.state !== 'disconnected') return;
      this.connectNow();
    }, delayMs);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      this.scheduler.clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }
}
