import type { ActionResult } from '../actions/actionResult';
import { validateAction } from '../actions/actionValidator';
import type { BackendEvent, Disposable } from '../backend/backendClient';
import type { ActionGate } from '../confirmation/actionGate';
import type { GateResolution } from '../confirmation/confirmationController';
import type { ActionRequest, AgentResponse, WireActionResult } from '../protocol/messages';
import { formatActionResult, formatTestResult } from '../response/responseFormatter';
import { notConfiguredSummary } from './localIntentHandler';

/**
 * Handles an action that the backend's agent proposed (Task 7.11; Req 5.2 to 5.5, 5.9 to 5.11,
 * design Sequences 4 and 5, failures F7 and F8).
 *
 * Every proposed action takes the one path that local commands also take:
 *
 *   validateAction(..., 'agent')  ->  ActionGate (registry risk decides)  ->  ActionExecutor
 *
 * and ends in exactly one `action_result` sent back to the backend, whatever happened: it ran
 * (`ok` or `failed`, or `needs_clarification`), was declined or cancelled (`declined`), was not on
 * the allow-list or had parameters that are not allowed (`not_permitted`), or the trusted test
 * command is not set (`not_configured`). Actions that start locally produce none, because this
 * class is never given them.
 *
 * Safety properties, all enforced by the pieces it delegates to:
 * - nothing is ever run from model text: only a validated `Action` reaches the gate, and the test
 *   command is read from trusted configuration, never from the payload;
 * - the agent's `confirmationRequired` flag is passed through as advisory only: the gate can add a
 *   confirmation for a `safe` action but can never remove one for a `needs-confirmation` action;
 * - the action_request `reason` is model text and is never shown, spoken or acted on.
 */

export interface ActionResultSender {
  /** Returns false, having sent nothing, when the backend cannot be reached. Never queues. */
  sendActionResult(replyTo: string, result: WireActionResult): boolean;
}

export interface AgentActionHandlerDeps {
  readonly gate: Pick<ActionGate, 'submit'>;
  readonly sender: ActionResultSender;
  /** The trusted `kirosight.testCommand`, trimmed; '' when unset. Never taken from a payload. */
  readonly readTestCommand: () => string;
  /** Shows text produced for an `action_request`, which arrives with no caller waiting for it. */
  readonly present?: (text: string) => void;
}

export type AgentActionStatus =
  /** The action ran (or was a no-op). A result was sent. */
  | 'executed'
  | 'not_permitted'
  | 'not_configured'
  /** A confirmation prompt is now pending; the result is sent when the user answers. */
  | 'confirmation_pending'
  | 'confirmation_queued'
  /** The same correlation id is already being handled. Nothing was run and nothing was sent. */
  | 'duplicate';

export interface AgentActionOutcome {
  readonly status: AgentActionStatus;
  /**
   * What to add to the transcript. Empty when there is nothing to add (a plain answer's NO_ACTION),
   * so a caller appends only non-empty text.
   */
  readonly text: string;
}

export const ACTION_NOT_PERMITTED_TEXT = "That action isn't permitted, so I didn't do anything.";
export const ACTION_PARAMETERS_NOT_PERMITTED_TEXT =
  "That action came with parameters that aren't permitted, so I didn't do anything.";
export const ACTION_FAILED_TEXT = 'The action could not be completed.';
const MAX_REMEMBERED_ANSWERS = 500;
export const ACTION_INTERRUPTED_TEXT = 'The request was interrupted before the action was considered.';
const DUPLICATE_TEXT = 'That action request was already being handled, so I ignored the repeat.';

/** Only a plain identifier is echoed back as an action name; anything else is reported as UNKNOWN. */
const ACTION_NAME = /^[A-Za-z0-9_]{1,64}$/;

function reportedActionType(raw: unknown): string {
  const type = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  return typeof type === 'string' && ACTION_NAME.test(type) ? type : 'UNKNOWN';
}

function notConfiguredResult(): ActionResult {
  const summary = notConfiguredSummary();
  return {
    actionType: 'RUN_TESTS',
    status: 'not_configured',
    message: formatTestResult(summary),
    details: { kind: 'test_run', summary },
  };
}

export class AgentActionHandler {
  /**
   * Correlation ids that have been accepted and not yet answered. An id leaves this set exactly when
   * its one `action_result` is sent, which is what makes "exactly one" hold.
   */
  private readonly outstanding = new Set<string>();

  /**
   * The most recent correlation ids that have been answered, so a late repeat of one (a replayed
   * action_request, a second interruption notice) can neither run again nor be answered twice.
   * Bounded: the oldest id is forgotten first.
   */
  private readonly answered = new Set<string>();

  public constructor(private readonly deps: AgentActionHandlerDeps) {}

  private isKnown(correlationId: string): boolean {
    return this.outstanding.has(correlationId) || this.answered.has(correlationId);
  }

  /** The action carried by an `agent_response`. The correlation id is its `replyTo`. */
  public handleAgentResponse(
    response: Pick<AgentResponse, 'replyTo' | 'action' | 'confirmationRequired'>,
  ): Promise<AgentActionOutcome> {
    return this.process(response.replyTo, response.action, response.confirmationRequired);
  }

  /** The action carried by an unsolicited `action_request`. The correlation id is its `id`. */
  public handleActionRequest(request: Pick<ActionRequest, 'id' | 'action'>): Promise<AgentActionOutcome> {
    return this.process(request.id, request.action, undefined);
  }

  /**
   * Handles every `action_request` the backend pushes. Text for the transcript goes to `present`.
   * Subscribing is wiring (Task 7.13); this method has no effect until something calls it.
   */
  public listen(events: { onEvent(listener: (event: BackendEvent) => void): Disposable }): Disposable {
    return events.onEvent((event) => {
      if (event.type !== 'action_request') return;
      void this.handleActionRequest(event)
        .then((outcome) => {
          if (outcome.text !== '') this.deps.present?.(outcome.text);
        })
        .catch(() => undefined);
    });
  }

  /**
   * The user interrupted the request before its answer arrived. The proposed action is not
   * considered (nothing runs and nothing is queued), and the backend is told it was declined so it
   * still gets its one answer.
   */
  public interrupted(response: Pick<AgentResponse, 'replyTo' | 'action'>): void {
    if (this.isKnown(response.replyTo)) return;
    this.outstanding.add(response.replyTo);
    this.send(response.replyTo, {
      actionType: reportedActionType(response.action),
      status: 'declined',
      message: ACTION_INTERRUPTED_TEXT,
    });
  }

  /**
   * Called when a confirmation ends. For an agent-originated request this is where its single
   * `action_result` is sent. Local resolutions, and ids this handler never accepted, are ignored.
   */
  public onResolution(resolution: GateResolution): void {
    if (resolution.origin !== 'agent') return;
    this.send(resolution.correlationId, resolution.result);
  }

  private async process(
    correlationId: string,
    raw: unknown,
    confirmationRequired: boolean | undefined,
  ): Promise<AgentActionOutcome> {
    if (this.isKnown(correlationId)) {
      return { status: 'duplicate', text: DUPLICATE_TEXT };
    }
    this.outstanding.add(correlationId);

    const validated = validateAction(raw, 'agent');
    if (!validated.ok) {
      const text = validated.code === 'UNKNOWN_ACTION'
        ? ACTION_NOT_PERMITTED_TEXT
        : ACTION_PARAMETERS_NOT_PERMITTED_TEXT;
      this.send(correlationId, { actionType: reportedActionType(raw), status: 'not_permitted', message: text });
      return { status: 'not_permitted', text };
    }

    const action = validated.action;
    let target = '';
    if (action.type === 'RUN_TESTS') {
      // Before any prompt and before anything can spawn (Req 5.11, 7.6). The value is trusted
      // configuration; nothing in the agent's payload is consulted.
      target = this.deps.readTestCommand();
      if (target === '') {
        const result = notConfiguredResult();
        this.send(correlationId, result);
        return { status: 'not_configured', text: result.message };
      }
    }

    try {
      const outcome = await this.deps.gate.submit({
        action,
        target,
        origin: 'agent',
        correlationId,
        // A no-op has nothing to confirm; for every other action the flag stays advisory.
        confirmationRequired: action.type === 'NO_ACTION' ? false : confirmationRequired,
      });

      if (outcome.kind === 'confirmation') {
        // The result is sent from onResolution, once the user answers. Nothing has run.
        return outcome.state === 'queued'
          ? { status: 'confirmation_queued', text: `Waiting for the pending confirmation first. ${outcome.request.prompt}` }
          : { status: 'confirmation_pending', text: outcome.request.prompt };
      }

      this.send(correlationId, outcome.result);
      return {
        status: outcome.kind === 'not_permitted' ? 'not_permitted' : 'executed',
        // A plain answer's NO_ACTION adds nothing: its speech was already shown.
        text: action.type === 'NO_ACTION' ? '' : formatActionResult(outcome.result),
      };
    } catch {
      // A handler failure still owes the backend its one answer, and must not leak error detail.
      this.send(correlationId, { actionType: action.type, status: 'failed', message: ACTION_FAILED_TEXT });
      return { status: 'executed', text: ACTION_FAILED_TEXT };
    }
  }

  /** Sends the one result for `correlationId`, if it is still owed. */
  private send(correlationId: string, result: ActionResult | WireActionResult): void {
    if (!this.outstanding.delete(correlationId)) return;
    this.answered.add(correlationId);
    if (this.answered.size > MAX_REMEMBERED_ANSWERS) {
      const oldest = this.answered.values().next().value;
      if (oldest !== undefined) this.answered.delete(oldest);
    }
    try {
      this.deps.sender.sendActionResult(correlationId, result);
    } catch {
      // An unreachable backend is not an error here: the result is never queued or replayed.
    }
  }
}
