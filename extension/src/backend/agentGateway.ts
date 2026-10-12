import { toWireContext } from '../context/contextService';
import type { IDEContext } from '../context/editorAdapter';
import {
  BACKEND_UNAVAILABLE_TEXT,
  type AgentGateway,
  type AgentGatewayResult,
  type AgentRelayInfo,
} from '../pipeline/inputPipeline';
import { PROTOCOL_VERSION } from '../protocol/constants';
import type { AgentRequest, AgentResponse } from '../protocol/messages';
import type { Result } from '../util/result';
import type { BackendClientError, ConnectionState } from './backendClient';

/**
 * The real AgentGateway for the InputPipeline: it turns agent-routed text plus bounded IDE
 * context into one `agent_request` and hands it to the BackendClient.
 *
 * It only transports. The `action` in an `agent_response` is deliberately dropped here: action
 * validation, confirmation and execution belong to Task 7.11, so receiving a response can never
 * cause a side effect. It never opens a connection, never queues a request for later and never
 * touches the socket or its raw state.
 */

export const BACKEND_REQUEST_FAILED_TEXT =
  'The KiroSight backend could not complete that request. You can try again. '
  + 'Local commands like where am I, errors, go to line and run tests still work.';
export const BACKEND_REQUEST_TIMED_OUT_TEXT =
  'The KiroSight backend did not answer in time. You can try again. '
  + 'Local commands like where am I, errors, go to line and run tests still work.';
export const BACKEND_EMPTY_RESPONSE_TEXT = 'The KiroSight backend returned no answer.';

/** The slice of BackendClient this gateway uses. BackendClient satisfies it structurally. */
export interface AgentGatewayClient {
  readonly state: ConnectionState;
  requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>>;
}

/** The slice of ContextService this gateway uses. */
export interface AgentContextSource {
  getContext(): Promise<IDEContext>;
}

export interface BackendAgentGatewayOptions {
  readonly client: AgentGatewayClient;
  readonly context: AgentContextSource;
}

export class BackendAgentGateway implements AgentGateway {
  private readonly client: AgentGatewayClient;
  private readonly context: AgentContextSource;
  /** Settles when the previous request has been handed to the client (not when it is answered). */
  private sendTail: Promise<void> = Promise.resolve();
  private fallbackIds = 0;

  /** Construction has no side effects. */
  public constructor(options: BackendAgentGatewayOptions) {
    this.client = options.client;
    this.context = options.context;
  }

  /** Only a completed handshake counts. `connecting`, `disconnected` and `incompatible` do not. */
  public isAvailable(): boolean {
    return this.client.state === 'connected';
  }

  public respond(text: string, info?: AgentRelayInfo): Promise<AgentGatewayResult> {
    if (!this.isAvailable()) return Promise.resolve(unavailable());

    // Reserve this request's place in the send order synchronously, in call order. Preparing the
    // context may take different times, but sends still happen in the order respond() was called.
    const prior = this.sendTail;
    let release: () => void = () => undefined;
    this.sendTail = new Promise<void>((resolve) => { release = resolve; });
    return this.relay(text, info, prior, release);
  }

  private async relay(
    text: string,
    info: AgentRelayInfo | undefined,
    prior: Promise<void>,
    release: () => void,
  ): Promise<AgentGatewayResult> {
    let answer: Promise<Result<AgentResponse, BackendClientError>>;
    try {
      const context = await this.context.getContext();
      await prior;
      if (!this.isAvailable()) return unavailable();

      const request: AgentRequest = {
        version: PROTOCOL_VERSION,
        type: 'agent_request',
        id: info === undefined ? `gw-${(this.fallbackIds += 1)}` : `req-${info.requestId}`,
        kind: 'utterance',
        utterance: info === undefined ? { text } : { text, source: info.source },
        context: toWireContext(context),
      };
      // The frame is written synchronously inside requestAgent, so the next request may be
      // handed over right away while this one is still waiting for its answer.
      answer = this.client.requestAgent(request);
    } catch {
      return failed();
    } finally {
      release();
    }

    return mapResult(await answer);
  }
}

function unavailable(): AgentGatewayResult {
  return { status: 'not_handled', text: BACKEND_UNAVAILABLE_TEXT, unavailable: true };
}

function failed(): AgentGatewayResult {
  return { status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT };
}

/** Maps a BackendClient outcome to safe user text. Raw error text and payloads never pass through. */
function mapResult(result: Result<AgentResponse, BackendClientError>): AgentGatewayResult {
  if (result.ok) {
    const speech = result.value.speech;
    return {
      status: 'handled',
      text: speech.trim() === '' ? BACKEND_EMPTY_RESPONSE_TEXT : speech,
    };
  }
  switch (result.error.kind) {
    case 'not_connected':
    case 'incompatible':
      return unavailable();
    case 'timeout':
      return { status: 'not_handled', text: BACKEND_REQUEST_TIMED_OUT_TEXT };
    default:
      return failed();
  }
}
