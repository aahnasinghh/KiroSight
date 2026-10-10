import type { LocalIntent, RouteResult } from '../intent/intentTypes';
import { route as defaultRoute } from '../intent/localIntentRouter';
import type { HostToWebviewMessage } from '../protocol/bridgeMessages';
import type { TranscriptSource, TranscriptStore } from '../transcript/transcriptStore';
import { createViewModel, type StatusKind, type ViewModel } from '../webview/viewModel';
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

export interface AgentGatewayResult {
  /** 'handled' once the request was accepted; 'not_handled' leaves the typed text in the input. */
  readonly status: 'handled' | 'not_handled';
  readonly text: string;
}

/** The agent seam. The real backend replaces the Milestone 4 stub in Milestone 6. */
export interface AgentGateway {
  respond(text: string): Promise<AgentGatewayResult>;
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

export interface InputPipelineDeps {
  readonly transcript: TranscriptStore;
  readonly localIntents: LocalIntentRunner;
  readonly agent?: AgentGateway;
  readonly interceptor?: PendingConfirmationInterceptor;
  readonly route?: (text: string) => RouteResult;
  readonly tracker?: RequestTracker;
  /** Receives a fresh immutable ViewModel whenever status, latest or transcript change. */
  readonly onViewModel?: (model: ViewModel) => void;
}

export class InputPipeline {
  private readonly agent: AgentGateway;
  private readonly interceptor: PendingConfirmationInterceptor;
  private readonly route: (text: string) => RouteResult;
  private readonly tracker: RequestTracker;
  private latest: string | null = null;

  public constructor(private readonly deps: InputPipelineDeps) {
    this.agent = deps.agent ?? reasoningNotConnectedGateway;
    this.interceptor = deps.interceptor ?? inertInterceptor;
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

    try {
      const intercepted = await this.interceptor.intercept(text);
      if (intercepted.intercepted) {
        if (intercepted.response !== undefined) {
          this.respond(intercepted.response);
        }
        this.publish('idle');
        return 'handled';
      }

      const routed = this.route(text);
      if (routed.route === 'local') {
        const response = await this.deps.localIntents.handleIntent(routed.intent);
        this.respond(response);
        this.publish('idle');
        return 'handled';
      }

      const requestId = this.tracker.begin();
      const result = await this.agent.respond(text);
      if (!this.tracker.isCurrent(requestId)) {
        return 'handled';
      }
      this.respond(result.text);
      this.publish(result.status === 'handled' ? 'idle' : 'error');
      return result.status;
    } catch {
      this.respond(PIPELINE_FAILURE_TEXT);
      this.publish('error');
      return 'not_handled';
    }
  }

  /** No pending confirmation exists before Milestone 5, so this is a safe no-op. */
  public async confirm(): Promise<void> {
    return;
  }

  /** No pending confirmation exists before Milestone 5, so this is a safe no-op. */
  public async decline(): Promise<void> {
    return;
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
      transcript: this.deps.transcript.getEntries(),
    }));
  }
}
