import { parseExplainIntent, type ExplainTarget } from '../intent/explainIntent';
import type { LocalIntent, RouteResult } from '../intent/intentTypes';
import { route as defaultRoute } from '../intent/localIntentRouter';
import type { HostToWebviewMessage } from '../protocol/bridgeMessages';
import type { AgentRequest } from '../protocol/messages';
import type { TranscriptSource, TranscriptStore } from '../transcript/transcriptStore';
import {
  createViewModel,
  type PendingConfirmationView,
  type StatusKind,
  type ViewModel,
} from '../webview/viewModel';
import { REASONING_NOT_CONNECTED } from './localIntentHandler';
import { RequestTracker } from './requestTracker';

/** The approved submit_ack domain: handled, not_handled, discarded. */
export type SubmitAckStatus = Extract<HostToWebviewMessage, { type: 'submit_ack' }>['status'];

/** Shown instead of internal error details when handling a request fails. */
export const PIPELINE_FAILURE_TEXT = 'The request could not be completed.';

/** Runs a routed local intent and returns display text; LocalIntentHandler satisfies this. */
export interface LocalIntentRunner {
  handleIntent(intent: LocalIntent): Promise<string>;
}

/**
 * Shown, in the transcript and in the webview status, when agent-routed text cannot be relayed
 * because the backend connection is not open (design.md F1; Req 19.9). It names only features
 * that really are local: context, diagnostics, navigation and trusted test runs.
 */
export const BACKEND_UNAVAILABLE_TEXT =
  "I can't reach the KiroSight backend, so I can't explain that. "
  + 'Local commands like where am I, errors, go to line and run tests still work.';

export interface AgentGatewayResult {
  /**
   * 'handled' once the request has been answered; 'not_handled' leaves the typed text in the
   * input so it can be resubmitted.
   */
  readonly status: 'handled' | 'not_handled';
  readonly text: string;
  /** True when the backend could not be reached, so the webview is also sent backend_unavailable. */
  readonly unavailable?: boolean;
}

/** What the pipeline already knows about one agent-routed submission. */
export interface AgentRelayInfo {
  /** The RequestTracker id of this submission; unique and increasing in arrival order. */
  readonly requestId: number;
  readonly source: TranscriptSource;
  /**
   * For an explanation request (Task 7.10): the request the pipeline already built from the IDE
   * state, with a placeholder id. The gateway sends it as is, with its own id. Absent otherwise.
   */
  readonly prepared?: AgentRequest;
  /**
   * False once the user has interrupted or superseded this submission. The gateway checks it
   * before acting on an answer, so an interrupted request can never run or queue an action.
   */
  readonly isCurrent?: () => boolean;
}

/** The placeholder id on a prepared request; the gateway replaces it with the relay's own id. */
const PREPARED_REQUEST_ID = 'prepared';

export type PreparedExplanation =
  | { readonly status: 'ready'; readonly request: AgentRequest }
  | { readonly status: 'not_available'; readonly message: string };

/**
 * Builds explanation requests from the IDE state (ExplanationRequestBuilder satisfies this). It is
 * asked only for the three explanation phrases, and reports locally, with no backend involved, when
 * there is nothing to explain.
 */
export interface ExplanationPreparer {
  build(input: {
    readonly target: ExplainTarget;
    readonly id: string;
    readonly utterance: string;
    readonly source: TranscriptSource;
  }): Promise<PreparedExplanation>;
}

/**
 * The agent seam. `respond` is called at most once per agent-routed submission, and only after
 * the local router and the confirmation interceptor declined the text. Calls are made in arrival
 * order. The gateway never receives locally handled text.
 */
export interface AgentGateway {
  respond(text: string, info?: AgentRelayInfo): Promise<AgentGatewayResult>;
  /**
   * Whether a request can be relayed right now. When this returns false the pipeline does not call
   * `respond` at all. A gateway without this method is treated as available.
   */
  isAvailable?(): boolean;
}

/** The webview notice sent when agent-routed text cannot be relayed (host to webview bridge). */
export interface BackendUnavailableNotice {
  readonly kind: 'text';
  readonly message: string;
}

export const reasoningNotConnectedGateway: AgentGateway = {
  respond: async () => ({ status: 'not_handled', text: REASONING_NOT_CONNECTED }),
};

export type InterceptResult =
  | { readonly intercepted: false }
  | { readonly intercepted: true; readonly response?: string };

/** Lets Milestone 5 claim pending-confirmation replies before normal routing. */
export interface PendingConfirmationInterceptor {
  intercept(text: string): Promise<InterceptResult>;
}

export const inertInterceptor: PendingConfirmationInterceptor = {
  intercept: async () => ({ intercepted: false }),
};

/**
 * The confirmation seam. While `isPending()` is true, `intercept` claims every input, so it never
 * reaches the router, the agent, the backend or Bedrock. confirm/decline serve the panel buttons.
 */
export interface ConfirmationController extends PendingConfirmationInterceptor {
  isPending(): boolean;
  /** The pending request's stored prompt plus its presentation identity, or null. */
  pendingConfirmation(): PendingConfirmationView | null;
  confirm(): Promise<string | null>;
  decline(): Promise<string | null>;
}

export interface InputPipelineDeps {
  readonly transcript: TranscriptStore;
  readonly localIntents: LocalIntentRunner;
  readonly agent?: AgentGateway;
  /** Builds the request for "explain this error / function / selection". Optional. */
  readonly explainer?: ExplanationPreparer;
  readonly interceptor?: PendingConfirmationInterceptor;
  /** Pending-confirmation handling; when present it also serves as the interceptor. */
  readonly confirmation?: ConfirmationController;
  readonly route?: (text: string) => RouteResult;
  readonly tracker?: RequestTracker;
  /** Receives a fresh immutable ViewModel whenever status, latest or transcript change. */
  readonly onViewModel?: (model: ViewModel) => void;
  /** Called immediately (never after a delay) when agent-routed text cannot be relayed. */
  readonly onBackendUnavailable?: (notice: BackendUnavailableNotice) => void;
}

interface ArrivalTicket {
  /** Settles once every earlier ticket has been released. */
  readonly previous: Promise<void>;
  readonly release: () => void;
}

export class InputPipeline {
  private readonly agent: AgentGateway;
  private readonly interceptor: PendingConfirmationInterceptor;
  private readonly route: (text: string) => RouteResult;
  private readonly tracker: RequestTracker;
  private latest: string | null = null;
  /** Tail of the arrival line: each submission waits only for the ones that arrived before it. */
  private arrivalTail: Promise<void> = Promise.resolve();

  public constructor(private readonly deps: InputPipelineDeps) {
    this.agent = deps.agent ?? reasoningNotConnectedGateway;
    this.interceptor = deps.interceptor ?? deps.confirmation ?? inertInterceptor;
    this.route = deps.route ?? defaultRoute;
    this.tracker = deps.tracker ?? new RequestTracker();
  }

  /** `source` is recorded on the user entry only and never affects routing. */
  public async handle(text: string, source: TranscriptSource): Promise<SubmitAckStatus> {
    if (text.trim().length === 0) {
      return 'discarded';
    }

    this.deps.transcript.append('user', text, source);
    this.publish('processing');

    // Take a place in the arrival line before any await, so agent relay order is the order in
    // which submissions reached the pipeline. While a confirmation is pending every input is
    // claimed by it and can never be relayed, so it must not queue behind (or hold up) others.
    const ticket = this.deps.confirmation?.isPending() === true ? undefined : this.takeTicket();

    try {
      const intercepted = await this.interceptor.intercept(text);
      if (intercepted.intercepted) {
        ticket?.release();
        if (intercepted.response !== undefined) {
          this.respond(intercepted.response);
        }
        this.publish(this.restingStatus());
        return 'handled';
      }

      // The single routing decision. Only an 'agent' route can ever reach the gateway.
      const routed = this.route(text);
      if (routed.route === 'local') {
        ticket?.release();
        const response = await this.deps.localIntents.handleIntent(routed.intent);
        this.respond(response);
        this.publish(this.restingStatus());
        return 'handled';
      }

      return await this.relayToAgent(text, source, ticket);
    } catch {
      this.respond(PIPELINE_FAILURE_TEXT);
      this.publish('error');
      return 'not_handled';
    } finally {
      ticket?.release();
    }
  }

  /**
   * Relays one agent-routed submission. Nothing is sent when the gateway reports it is
   * unavailable, nothing is queued for later, and no connection is attempted from here.
   */
  private async relayToAgent(
    text: string,
    source: TranscriptSource,
    ticket: ArrivalTicket | undefined,
  ): Promise<SubmitAckStatus> {
    if (ticket !== undefined) await ticket.previous;

    // "Explain this error / function / selection" is prepared from the IDE state first. When there
    // is nothing to explain, that is reported here, with or without a backend (Req 12.4, 12.5).
    let prepared: AgentRequest | undefined;
    const target = this.deps.explainer === undefined ? null : parseExplainIntent(text);
    if (target !== null && this.deps.explainer !== undefined) {
      const built = await this.deps.explainer.build({ target, id: PREPARED_REQUEST_ID, utterance: text, source });
      if (built.status === 'not_available') {
        ticket?.release();
        this.respond(built.message);
        this.publish(this.restingStatus());
        return 'handled';
      }
      prepared = built.request;
    }

    if (this.agent.isAvailable?.() === false) {
      ticket?.release();
      this.reportUnavailable(BACKEND_UNAVAILABLE_TEXT);
      return 'not_handled';
    }

    const requestId = this.tracker.begin();
    // respond() is invoked synchronously here, so the gateway sees calls in arrival order. The
    // line is released as soon as the request has been handed over, not when it is answered.
    const pending = this.agent.respond(text, {
      requestId,
      source,
      isCurrent: () => this.tracker.isCurrent(requestId),
      ...(prepared === undefined ? {} : { prepared }),
    });
    ticket?.release();

    const result = await pending;
    if (!this.tracker.isCurrent(requestId)) {
      return 'handled';
    }
    if (result.unavailable === true) {
      this.reportUnavailable(result.text);
      return 'not_handled';
    }
    this.respond(result.text);
    // A proposed action may have left a confirmation pending, and the status must say so.
    this.publish(result.status === 'handled' ? this.restingStatus() : 'error');
    return result.status;
  }

  /**
   * Adds a response that no submission is waiting for (an action the backend pushed, or a test
   * summary that arrives later) to the transcript, and refreshes the view. It is the same
   * transcript entry and the same view update every other response uses.
   */
  public announce(text: string): void {
    if (text.trim() === '') return;
    this.respond(text);
    this.publish(this.restingStatus());
  }

  private reportUnavailable(message: string): void {
    this.deps.onBackendUnavailable?.({ kind: 'text', message });
    this.respond(message);
    this.publish('error');
  }

  private takeTicket(): ArrivalTicket {
    const previous = this.arrivalTail;
    let release: () => void = () => undefined;
    this.arrivalTail = new Promise<void>((resolve) => { release = resolve; });
    return { previous, release };
  }

  /** Confirm control: the same transition as a typed CONFIRM. A safe no-op with nothing pending. */
  public async confirm(): Promise<void> {
    await this.resolveControl((controller) => controller.confirm());
  }

  /** Decline control: the same transition as a typed DECLINE. A safe no-op with nothing pending. */
  public async decline(): Promise<void> {
    await this.resolveControl((controller) => controller.decline());
  }

  private async resolveControl(
    action: (controller: ConfirmationController) => Promise<string | null>,
  ): Promise<void> {
    const controller = this.deps.confirmation;
    if (controller === undefined) return;
    this.publish('processing');
    try {
      const response = await action(controller);
      if (response !== null) this.respond(response);
      this.publish(this.restingStatus());
    } catch {
      this.respond(PIPELINE_FAILURE_TEXT);
      this.publish('error');
    }
  }

  private restingStatus(): StatusKind {
    return this.deps.confirmation?.isPending() === true ? 'confirmation_pending' : 'idle';
  }

  /** Makes in-flight agent replies stale so they are dropped, and returns status to idle. */
  public interrupt(): void {
    this.tracker.supersede();
    this.publish('idle');
  }

  private respond(text: string): void {
    this.deps.transcript.append('kirosight', text);
    this.latest = text;
  }

  private publish(statusKind: StatusKind): void {
    this.deps.onViewModel?.(createViewModel({
      statusKind,
      latest: this.latest,
      pendingConfirmation: this.deps.confirmation?.pendingConfirmation() ?? null,
      transcript: this.deps.transcript.getEntries(),
    }));
  }
}
