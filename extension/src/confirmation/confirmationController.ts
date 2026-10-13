import type { ActionResult } from '../actions/actionResult';
import type { Action } from '../actions/actionTypes';
import type { ConfirmationController } from '../pipeline/inputPipeline';
import type { PendingConfirmationView } from '../webview/viewModel';
import { read as readTestCommand } from '../testing/testCommandConfig';
import { notConfiguredSummary } from '../pipeline/localIntentHandler';
import { formatActionResult, formatTestResult } from '../response/responseFormatter';
import type { ActionGate, GateReplyOutcome } from './actionGate';
import type { ConfirmationManager, ConfirmationOrigin, ConfirmationRequest } from './confirmationManager';
import { classifyReply } from './replyClassifier';

/**
 * The live-target resolver for ConfirmationManager: the current trusted test command for
 * RUN_TESTS, and no tracked target for other actions. Reads configuration only.
 */
export function currentTestTarget(action: Action): string | undefined {
  return action.type === 'RUN_TESTS' ? readTestCommand() : undefined;
}

/** How one confirmed, declined, cancelled or dropped request ended. */
export interface GateResolution {
  readonly origin: ConfirmationOrigin;
  /** The agent's `replyTo` / `action_request` id, or a local id. */
  readonly correlationId: string;
  readonly result: ActionResult;
}

export type GateResolutionObserver = (resolution: GateResolution) => void;

/** The result for a pending RUN_TESTS dropped because the trusted command is no longer set. */
function notConfiguredResult(): ActionResult {
  const summary = notConfiguredSummary();
  return {
    actionType: 'RUN_TESTS',
    status: 'not_configured',
    message: formatTestResult(summary),
    details: { kind: 'test_run', summary },
  };
}

/**
 * Adapts ActionGate + ConfirmationManager to the pipeline's confirmation seam. It owns no state:
 * pending status and prompts always come from the ConfirmationManager.
 */
export class GateConfirmationController implements ConfirmationController {
  public constructor(
    private readonly gate: Pick<ActionGate, 'reply' | 'confirm' | 'decline'>,
    private readonly confirmations: Pick<ConfirmationManager, 'pending'>,
    /**
     * Told, once per request, how a confirmation ended (ran, declined, cancelled or dropped). It is
     * how an agent-originated request reaches its `action_result`. Optional and observe-only: it
     * cannot change the outcome, and an error inside it is swallowed.
     */
    private readonly onResolved?: GateResolutionObserver,
  ) {}

  private notify(resolution: GateResolution): void {
    try {
      this.onResolved?.(resolution);
    } catch {
      // An observer must never break a confirmation.
    }
  }

  public isPending(): boolean {
    return this.confirmations.pending() !== null;
  }

  /**
   * What the webview shows for the pending request: its stored prompt and an opaque identity
   * (origin + correlation id). The identity stays the same for the same request across
   * republications and differs for a different request, even when the prompt text is identical.
   */
  public pendingConfirmation(): PendingConfirmationView | null {
    const request = this.confirmations.pending();
    return request === null
      ? null
      : {
          promptText: request.prompt,
          presentationKey: JSON.stringify([request.origin, request.correlationId]),
        };
  }

  /** While a confirmation is pending, text goes only to the gate; otherwise it is not claimed. */
  public async intercept(text: string): Promise<{ intercepted: false } | { intercepted: true; response?: string }> {
    if (!this.isPending()) return { intercepted: false };
    const invalidated = classifyReply(text) === 'confirm' ? await this.dropUnconfiguredTestRuns() : null;
    const response = invalidated ?? this.render(await this.gate.reply(text));
    return response === null ? { intercepted: true } : { intercepted: true, response };
  }

  public async confirm(): Promise<string | null> {
    if (!this.isPending()) return null;
    return (await this.dropUnconfiguredTestRuns()) ?? this.render(await this.gate.confirm());
  }

  /**
   * A confirm must never present or approve an empty test command. If the trusted command is now
   * empty, every pending RUN_TESTS request is invalid: each is resolved through the gate's decline
   * path (nothing runs), and the user gets the normal not-configured answer. A queued request that
   * is still valid is then presented through the usual FIFO promotion.
   */
  private async dropUnconfiguredTestRuns(): Promise<string | null> {
    if (readTestCommand() !== '' || this.confirmations.pending()?.action.type !== 'RUN_TESTS') return null;

    let next: ConfirmationRequest | null = null;
    while (this.confirmations.pending()?.action.type === 'RUN_TESTS') {
      const outcome = await this.gate.decline();
      next = outcome.kind === 'declined' ? outcome.next : null;
      // The request ended because the command is not configured, not because the user declined.
      if (outcome.kind === 'declined') {
        this.notify({
          origin: outcome.origin,
          correlationId: outcome.correlationId,
          result: notConfiguredResult(),
        });
      }
    }
    const message = formatTestResult(notConfiguredSummary());
    return next === null ? message : `${message} ${next.prompt}`;
  }

  public async decline(): Promise<string | null> {
    return this.isPending() ? this.render(await this.gate.decline()) : null;
  }

  private render(outcome: GateReplyOutcome): string | null {
    switch (outcome.kind) {
      case 'ignored':
        return null;
      case 'prompt':
        return outcome.text;
      case 'executed':
      case 'declined': {
        this.notify({ origin: outcome.origin, correlationId: outcome.correlationId, result: outcome.result });
        const result = formatActionResult(outcome.result);
        return outcome.next === null ? result : `${result} ${outcome.next.prompt}`;
      }
    }
  }
}
