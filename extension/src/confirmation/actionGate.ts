import type { Action } from '../actions/actionTypes';
import type { ActionResult } from '../actions/actionResult';
import { ALLOWLIST, type Risk } from '../actions/allowlist';
import type { ActionRunner } from '../pipeline/localIntentHandler';
import type {
  ConfirmationManager,
  ConfirmationOrigin,
  ConfirmationRequest,
  ReplyOutcome,
} from './confirmationManager';

/** The trusted registry: action type to risk class. Defaults to the extension allow-list. */
export type RiskRegistry = Readonly<Record<string, { readonly risk: Risk }>>;

export interface ActionGateDeps {
  readonly confirmations: ConfirmationManager;
  /** Executes an already validated action (ActionExecutor satisfies this). */
  readonly executor: ActionRunner;
  readonly registry?: RiskRegistry;
}

/**
 * A request to run an action. `action` must already have passed ActionValidator.
 * `confirmationRequired` is the agent's advisory flag: it can only add a confirmation.
 */
export interface GateRequest {
  readonly action: Action;
  /** The concrete target, resolved by the caller before gating. Never invented here. */
  readonly target: string;
  readonly origin: ConfirmationOrigin;
  readonly correlationId: string;
  readonly confirmationRequired?: boolean;
}

interface Metadata {
  readonly origin: ConfirmationOrigin;
  readonly correlationId: string;
}

export type GateOutcome =
  /** The action ran exactly once. `result` is the executor's own result. */
  | ({ readonly kind: 'executed'; readonly result: ActionResult } & Metadata)
  /** The action was not run because it is not in the trusted registry. */
  | ({ readonly kind: 'not_permitted'; readonly result: ActionResult } & Metadata)
  /** Confirmation is required. Nothing ran. `queued` means another request is pending first. */
  | { readonly kind: 'confirmation'; readonly state: 'pending' | 'queued'; readonly request: ConfirmationRequest };

export type GateReplyOutcome =
  /** Nothing was pending: no effect. */
  | { readonly kind: 'ignored' }
  /** Repeat, re-prompt or retarget: show `text`. Nothing ran and nothing was resolved. */
  | {
      readonly kind: 'prompt';
      readonly reason: 'repeated' | 'reprompt' | 'retargeted';
      readonly text: string;
      readonly request: ConfirmationRequest;
    }
  /** The confirmed request ran exactly once. `next` is the request now pending, if any. */
  | ({ readonly kind: 'executed'; readonly result: ActionResult; readonly next: ConfirmationRequest | null } & Metadata)
  /** Declined or cancelled: nothing ran. `result.status` is 'declined'. */
  | ({
      readonly kind: 'declined';
      readonly reason: 'declined' | 'cancelled';
      readonly result: ActionResult;
      readonly next: ConfirmationRequest | null;
    } & Metadata);

const REASON_TEXT = { declined: 'you declined', cancelled: 'you cancelled' } as const;

/**
 * Decides, from the trusted registry only, whether an action runs now or needs
 * confirmation, and runs a confirmed action exactly once. It implements no action
 * behavior itself and holds no timers.
 */
export class ActionGate {
  private readonly registry: RiskRegistry;

  public constructor(private readonly deps: ActionGateDeps) {
    this.registry = deps.registry ?? ALLOWLIST;
  }

  public async submit(request: GateRequest): Promise<GateOutcome> {
    const metadata: Metadata = { origin: request.origin, correlationId: request.correlationId };
    const risk = this.riskOf(request.action);
    if (risk === undefined) {
      return {
        kind: 'not_permitted',
        ...metadata,
        result: {
          actionType: request.action.type,
          status: 'not_permitted',
          message: 'The action is not in the allow-list',
        },
      };
    }

    // The registry decides. The flag can only add a confirmation to a safe action.
    const needsConfirmation = risk === 'needs-confirmation' || request.confirmationRequired === true;
    if (!needsConfirmation) {
      return { kind: 'executed', ...metadata, result: await this.deps.executor.execute(request.action) };
    }

    const outcome = this.deps.confirmations.request({
      action: request.action,
      target: request.target,
      origin: request.origin,
      correlationId: request.correlationId,
    });
    return { kind: 'confirmation', state: outcome.kind, request: outcome.request };
  }

  /** Typed or spoken reply while a confirmation may be pending. */
  public reply(text: string): Promise<GateReplyOutcome> {
    return this.settle(this.deps.confirmations.handleReply(text));
  }

  /** Confirm control: the same transition as a typed CONFIRM. */
  public confirm(): Promise<GateReplyOutcome> {
    return this.settle(this.deps.confirmations.confirm());
  }

  /** Decline control and dismissal route: the same transition as a typed DECLINE. */
  public decline(): Promise<GateReplyOutcome> {
    return this.settle(this.deps.confirmations.decline());
  }

  private riskOf(action: Action): Risk | undefined {
    return Object.hasOwn(this.registry, action.type) ? this.registry[action.type]?.risk : undefined;
  }

  private async settle(outcome: ReplyOutcome): Promise<GateReplyOutcome> {
    switch (outcome.kind) {
      case 'ignored':
        return { kind: 'ignored' };
      case 'repeated':
      case 'reprompt':
      case 'retargeted':
        return { kind: 'prompt', reason: outcome.kind, text: outcome.text, request: outcome.request };
      case 'confirmed': {
        // The manager resolves each request once, so this runs once per confirmed request.
        const result = await this.deps.executor.execute(outcome.request.action);
        return {
          kind: 'executed',
          result,
          next: outcome.next,
          origin: outcome.request.origin,
          correlationId: outcome.request.correlationId,
        };
      }
      case 'declined':
        return {
          kind: 'declined',
          reason: outcome.reason,
          next: outcome.next,
          origin: outcome.request.origin,
          correlationId: outcome.request.correlationId,
          result: {
            actionType: outcome.request.action.type,
            status: 'declined',
            message: REASON_TEXT[outcome.reason],
          },
        };
    }
  }
}
