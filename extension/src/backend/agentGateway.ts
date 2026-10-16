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
import { describeReasoningFailure } from '../response/explanationMessages';
import type { Result } from '../util/result';
import type { BackendClientError, ConnectionState } from './backendClient';

/**
 * The real AgentGateway for the InputPipeline: it turns agent-routed text plus bounded IDE
 * context into one `agent_request` and hands it to the BackendClient.
 *
 * It only transports. It never looks at the `action` in an `agent_response`: with no `actions`
 * option the action is dropped (receiving a response can then cause no side effect), and with one
 * the answer is handed to the action handler, which validates it, applies the confirmation gate
 * and reports back (Task 7.11). It never opens a connection, never queues a request for later and
 * never touches the socket or its raw state.
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
  /**
   * Sends the backend one `cancel` for the in-flight request, leaving it registered so an answer
   * already on its way is still correlated (and any action it proposes is declined).
   */
  cancelAgentRequest?(targetId: string): boolean;
}

/** The slice of ContextService this gateway uses. */
export interface AgentContextSource {
  getContext(): Promise<IDEContext>;
}

/**
 * Receives the action an answer proposes (AgentActionHandler satisfies this). It validates the
 * action, applies the confirmation gate and sends the one `action_result`; the gateway only hands
 * the answer over and adds the returned text to the reply.
 */
export interface AgentResponseActions {
  handleAgentResponse(response: AgentResponse): Promise<{ readonly text: string }>;
  /** The request was interrupted before its answer arrived; the action is not considered. */
  interrupted(response: AgentResponse): void;
}

export interface BackendAgentGatewayOptions {
  readonly client: AgentGatewayClient;
  readonly context: AgentContextSource;
  /** Without it an answer's action is ignored, as in Milestone 6. */
  readonly actions?: AgentResponseActions;
}

export class BackendAgentGateway implements AgentGateway {
  private readonly client: AgentGatewayClient;
  private readonly context: AgentContextSource;
  private readonly actions: AgentResponseActions | undefined;
  /** Settles when the previous request has been handed to the client (not when it is answered). */
  private sendTail: Promise<void> = Promise.resolve();
  private fallbackIds = 0;
  /** Pipeline request ids being relayed right now; the value says the submission was cancelled. */
  private readonly relaying = new Map<number, { cancelled: boolean }>();

  /** Construction has no side effects. */
  public constructor(options: BackendAgentGatewayOptions) {
    this.client = options.client;
    this.context = options.context;
    this.actions = options.actions;
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
    if (info === undefined) return this.relay(text, info, prior, release);

    const requestId = info.requestId;
    const state = { cancelled: false };
    this.relaying.set(requestId, state);
    return this.relay(text, info, prior, release, state).finally(() => {
      if (this.relaying.get(requestId) === state) this.relaying.delete(requestId);
    });
  }

  /**
   * The pipeline interrupted or replaced the submission `requestId` (Task 9.5). Only that
   * submission is affected. If its `agent_request` was not sent yet it is never sent; if it was,
   * the client fails it locally and the backend is sent one `cancel` for its id. A submission this
   * gateway is not relaying (finished, unknown) is ignored, so a newer request is never cancelled.
   * Never throws.
   */
  public cancel(requestId: number): void {
    const state = this.relaying.get(requestId);
    if (state === undefined || state.cancelled) return;
    state.cancelled = true;
    try {
      this.client.cancelAgentRequest?.(`req-${requestId}`);
    } catch {
      // The answer is dropped by the pipeline regardless.
    }
  }

  private async relay(
    text: string,
    info: AgentRelayInfo | undefined,
    prior: Promise<void>,
    release: () => void,
    state?: { cancelled: boolean },
  ): Promise<AgentGatewayResult> {
    let answer: Promise<Result<AgentResponse, BackendClientError>>;
    try {
      const id = info === undefined ? `gw-${(this.fallbackIds += 1)}` : `req-${info.requestId}`;
      // An explanation arrives already built from the IDE state; anything else gathers its context.
      const context = info?.prepared === undefined ? await this.context.getContext() : undefined;
      await prior;
      // Interrupted before it was sent: nothing goes to the backend, and the pipeline drops this.
      if (state?.cancelled === true) return failed();
      if (!this.isAvailable()) return unavailable();

      const request: AgentRequest = info?.prepared !== undefined
        ? { ...info.prepared, id }
        : {
          version: PROTOCOL_VERSION,
          type: 'agent_request',
          id,
          kind: 'utterance',
          utterance: info === undefined ? { text } : { text, source: info.source },
          context: toWireContext(context!),
        };
      // The frame is written synchronously inside requestAgent, so the next request may be
      // handed over right away while this one is still waiting for its answer.
      answer = this.client.requestAgent(request);
    } catch {
      return failed();
    } finally {
      release();
    }

    const settled = await answer;
    const mapped = mapResult(settled);
    return settled.ok ? this.withAction(mapped, settled.value, info) : mapped;
  }

  /**
   * Hands the answer's action to the action handler and adds what it reports to the reply. The
   * action is never looked at here. If the user interrupted the request in the meantime the action
   * is not considered at all, so a late answer can never run or queue anything.
   */
  private async withAction(
    mapped: AgentGatewayResult,
    response: AgentResponse,
    info: AgentRelayInfo | undefined,
  ): Promise<AgentGatewayResult> {
    if (this.actions === undefined) return mapped;
    if (info?.isCurrent?.() === false) {
      this.actions.interrupted(response);
      return mapped;
    }
    try {
      const outcome = await this.actions.handleAgentResponse(response);
      if (outcome.text === '') return mapped;
      const spoke = response.speech.trim() !== '';
      return { ...mapped, text: spoke ? `${mapped.text} ${outcome.text}` : outcome.text };
    } catch {
      return mapped;
    }
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
  if (result.error.kind === 'backend_error' && result.error.backendCode !== undefined) {
    // A reasoning failure (Req 12.3, design F2 and F6) gets a stated error. The text is fixed:
    // the backend's own message is never copied, and other backend codes stay generic.
    const stated = describeReasoningFailure(result.error.backendCode, result.error.recoverable);
    if (stated !== null) return { status: 'not_handled', text: stated };
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
