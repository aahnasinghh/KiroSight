import type { Action } from '../actions/actionTypes';
import { formatConfirmation, formatConfirmationReprompt } from '../response/responseFormatter';
import { classifyReply } from './replyClassifier';

/** Who asked for the action. Recorded only; it is never used for a decision here. */
export type ConfirmationOrigin = 'local' | 'agent';

export interface ConfirmationRequestInput {
  readonly action: Action;
  /** The concrete, resolved target (for RUN_TESTS, the exact configured command). */
  readonly target: string;
  readonly origin: ConfirmationOrigin;
  /** Supplied by the caller (agent replyTo / action_request id, or a local id). Never replaced. */
  readonly correlationId: string;
}

/** A request as stored at request time. Immutable. */
export interface ConfirmationRequest {
  readonly action: Action;
  readonly target: string;
  /** The stored full prompt, built by formatConfirmation(action, target). */
  readonly prompt: string;
  readonly origin: ConfirmationOrigin;
  readonly correlationId: string;
}

export type RequestOutcome =
  | { readonly kind: 'pending'; readonly request: ConfirmationRequest }
  /** `position` is 1-based within the hold queue. */
  | { readonly kind: 'queued'; readonly request: ConfirmationRequest; readonly position: number };

export type ReplyOutcome =
  /** Nothing was pending: no effect, and nothing is remembered. */
  | { readonly kind: 'ignored' }
  /** REPEAT: the stored full prompt; no state changed. */
  | { readonly kind: 'repeated'; readonly request: ConfirmationRequest; readonly text: string }
  /** Any other text: the concise re-prompt; no state changed. */
  | { readonly kind: 'reprompt'; readonly request: ConfirmationRequest; readonly text: string }
  /** The target changed while pending: nothing is confirmed and the new target needs a fresh CONFIRM. */
  | { readonly kind: 'retargeted'; readonly request: ConfirmationRequest; readonly text: string }
  /** The request was confirmed. The caller executes it; this manager never does. */
  | { readonly kind: 'confirmed'; readonly request: ConfirmationRequest; readonly next: ConfirmationRequest | null }
  /** Declined or cancelled: identical transition, nothing runs. `reason` is presentation only. */
  | {
      readonly kind: 'declined';
      readonly reason: 'declined' | 'cancelled';
      readonly request: ConfirmationRequest;
      readonly next: ConfirmationRequest | null;
    };

/**
 * Supplies the current resolved target for an action, or undefined when the action has no
 * tracked target. Injected so this manager never reads configuration itself.
 */
export type CurrentTargetResolver = (action: Action) => string | undefined;

function freezeRequest(input: ConfirmationRequestInput, target: string): ConfirmationRequest {
  const action = Object.freeze({ ...input.action }) as Action;
  return Object.freeze({
    action,
    target,
    prompt: formatConfirmation(action, target),
    origin: input.origin,
    correlationId: input.correlationId,
  });
}

/**
 * Pure confirmation state: at most one pending request plus a FIFO hold queue.
 * It holds no timers and never expires, and it never executes anything.
 */
export class ConfirmationManager {
  private current: ConfirmationRequest | null = null;
  private readonly held: ConfirmationRequest[] = [];

  public constructor(private readonly currentTarget?: CurrentTargetResolver) {}

  /** The first request becomes pending; later ones wait in arrival order. */
  public request(input: ConfirmationRequestInput): RequestOutcome {
    const request = freezeRequest(input, input.target);
    if (this.current === null) {
      this.current = request;
      return { kind: 'pending', request };
    }
    this.held.push(request);
    return { kind: 'queued', request, position: this.held.length };
  }

  public handleReply(text: string): ReplyOutcome {
    const reply = classifyReply(text);
    if (this.current === null) {
      return { kind: 'ignored' };
    }
    switch (reply) {
      case 'confirm':
        return this.resolveConfirm();
      case 'decline':
        return this.resolveDecline('declined');
      case 'cancel':
        return this.resolveDecline('cancelled');
      case 'repeat':
        return this.repeat();
      case 'unrecognized':
        return {
          kind: 'reprompt',
          request: this.current,
          text: formatConfirmationReprompt(this.current.action),
        };
    }
  }

  /** Button entry point: the same transition as a typed CONFIRM. */
  public confirm(): ReplyOutcome {
    return this.current === null ? { kind: 'ignored' } : this.resolveConfirm();
  }

  /** Button entry point: the same transition as a typed DECLINE. */
  public decline(): ReplyOutcome {
    return this.current === null ? { kind: 'ignored' } : this.resolveDecline('declined');
  }

  public pending(): ConfirmationRequest | null {
    return this.current;
  }

  /** A copy of the hold queue in order; mutating it does not affect the manager. */
  public queued(): readonly ConfirmationRequest[] {
    return Object.freeze([...this.held]);
  }

  /** Pure with respect to state: re-reads the stored prompt and never consults the live target. */
  private repeat(): ReplyOutcome {
    const request = this.current!;
    return { kind: 'repeated', request, text: request.prompt };
  }

  private resolveConfirm(): ReplyOutcome {
    const changed = this.retargetIfChanged();
    if (changed !== null) {
      return changed;
    }
    const request = this.current!;
    return { kind: 'confirmed', request, next: this.promote() };
  }

  private resolveDecline(reason: 'declined' | 'cancelled'): ReplyOutcome {
    const request = this.current!;
    return { kind: 'declined', reason, request, next: this.promote() };
  }

  /**
   * If the live target differs from the stored one, replace the pending request in place
   * (same slot, origin and correlation id) and require a fresh CONFIRM. The queue is untouched.
   */
  private retargetIfChanged(): ReplyOutcome | null {
    const stored = this.current!;
    const live = this.currentTarget?.(stored.action);
    if (live === undefined || live === stored.target) {
      return null;
    }
    const request = freezeRequest(stored, live);
    this.current = request;
    return { kind: 'retargeted', request, text: request.prompt };
  }

  /** Removes the resolved request and makes the head of the queue (if any) pending. */
  private promote(): ConfirmationRequest | null {
    this.current = this.held.shift() ?? null;
    if (this.current === null) {
      return null;
    }
    const live = this.currentTarget?.(this.current.action);
    if (live !== undefined && live !== this.current.target) {
      this.current = freezeRequest(this.current, live);
    }
    return this.current;
  }
}
