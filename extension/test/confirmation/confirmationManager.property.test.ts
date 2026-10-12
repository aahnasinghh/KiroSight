import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Action } from '../../src/actions/actionTypes';
import {
  ConfirmationManager,
  type ConfirmationRequest,
  type ConfirmationRequestInput,
} from '../../src/confirmation/confirmationManager';
import { classifyReply } from '../../src/confirmation/replyClassifier';
import { formatConfirmation, formatConfirmationReprompt } from '../../src/response/responseFormatter';

type RequestOperation = { kind: 'request'; input: Omit<ConfirmationRequestInput, 'correlationId'>; id: string };
type ReplyOperation = { kind: 'reply'; text: string };
type ChangeTargetOperation = { kind: 'change_target'; actionType: Action['type']; target: string };
type Operation = RequestOperation | ReplyOperation | ChangeTargetOperation;

type ModelRequest = {
  action: Action;
  target: string;
  prompt: string;
  origin: 'local' | 'agent';
  correlationId: string;
};

const ACTION_TYPES: readonly Action['type'][] = [
  'NO_ACTION', 'GO_TO_DIAGNOSTIC', 'NEXT_DIAGNOSTIC', 'PREVIOUS_DIAGNOSTIC',
  'OPEN_FILE', 'GO_TO_LINE', 'FOCUS_EDITOR', 'RUN_TESTS',
];

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant({ type: 'NO_ACTION' as const }),
  fc.record({
    type: fc.constant('GO_TO_DIAGNOSTIC' as const),
    index: fc.integer({ min: 0, max: 10 }),
    severity: fc.option(fc.constantFrom('error', 'warning', 'any' as const), { nil: undefined }),
  }).map(({ type, index, severity }) => ({ type, index, ...(severity === undefined ? {} : { severity }) })),
  fc.record({
    type: fc.constant('NEXT_DIAGNOSTIC' as const),
    severity: fc.option(fc.constantFrom('error', 'warning', 'any' as const), { nil: undefined }),
  }).map(({ type, severity }) => ({ type, ...(severity === undefined ? {} : { severity }) })),
  fc.record({
    type: fc.constant('PREVIOUS_DIAGNOSTIC' as const),
    severity: fc.option(fc.constantFrom('error', 'warning', 'any' as const), { nil: undefined }),
  }).map(({ type, severity }) => ({ type, ...(severity === undefined ? {} : { severity }) })),
  fc.string({ minLength: 1, maxLength: 30 }).map((path) => ({ type: 'OPEN_FILE' as const, path })),
  fc.integer({ min: 1, max: 100 }).map((line) => ({ type: 'GO_TO_LINE' as const, line })),
  fc.constant({ type: 'FOCUS_EDITOR' as const }),
  fc.constant({ type: 'RUN_TESTS' as const }),
);

const targetArb = fc.oneof(
  fc.constantFrom(
    'npm.cmd test',
    'npm.cmd test -- --coverage',
    'extension/src/AuthService.ts',
    'C:\\fixture path\\tests',
    'pytest -q tests/test_auth.py',
  ),
  fc.string({ minLength: 1, maxLength: 80 }).filter((target) => /\S/.test(target)),
);

const idArb = fc.string({ minLength: 1, maxLength: 12 }).filter((id) => /\S/.test(id));
const originArb = fc.constantFrom<'local' | 'agent'>('local', 'agent');

const unrecognizedArb = fc.string({ minLength: 1, maxLength: 40 })
  .filter((text) => text.trim().length > 0 && classifyReply(text) === 'unrecognized');
const approvedReplyArb = fc.constantFrom(
  'confirm', 'yes', 'go ahead', 'approve',
  'decline', 'no', 'cancel', 'stop', 'never mind',
  'repeat', 'say that again', 'what is waiting',
);
const replyArb = fc.oneof(approvedReplyArb, unrecognizedArb);

const requestOperationArb: fc.Arbitrary<RequestOperation> = fc.record({
  input: fc.record({ action: actionArb, target: targetArb, origin: originArb }),
  id: idArb,
}).map(({ input, id }) => ({ kind: 'request' as const, input, id }));

const operationArb: fc.Arbitrary<Operation> = fc.oneof(
  requestOperationArb,
  replyArb.map((text) => ({ kind: 'reply' as const, text })),
  fc.record({ actionType: fc.constantFrom(...ACTION_TYPES), target: targetArb })
    .map(({ actionType, target }) => ({ kind: 'change_target' as const, actionType, target })),
);

function modelRequest(input: ConfirmationRequestInput): ModelRequest {
  return {
    action: input.action,
    target: input.target,
    prompt: formatConfirmation(input.action, input.target),
    origin: input.origin,
    correlationId: input.correlationId,
  };
}

function copyWithTarget(request: ModelRequest, target: string): ModelRequest {
  return { ...request, target, prompt: formatConfirmation(request.action, target) };
}

class ReferenceModel {
  public pendingRequest: ModelRequest | null = null;
  public readonly queue: ModelRequest[] = [];
  public readonly liveTargets = new Map<Action['type'], string>();

  public request(input: ConfirmationRequestInput): void {
    if (!this.liveTargets.has(input.action.type)) {
      this.liveTargets.set(input.action.type, input.target);
    }
    const request = modelRequest(input);
    if (this.pendingRequest === null) {
      this.pendingRequest = request;
    } else {
      this.queue.push(request);
    }
  }

  public changeTarget(actionType: Action['type'], target: string): void {
    this.liveTargets.set(actionType, target);
  }

  public reply(text: string): { kind: string; request?: ModelRequest; next?: ModelRequest | null; text?: string } {
    if (this.pendingRequest === null) return { kind: 'ignored' };
    const reply = classifyReply(text);
    const current = this.pendingRequest;
    if (reply === 'repeat') return { kind: 'repeated', request: current, text: current.prompt };
    if (reply === 'unrecognized') {
      return { kind: 'reprompt', request: current, text: formatConfirmationReprompt(current.action) };
    }
    if (reply === 'confirm') {
      const live = this.liveTargets.get(current.action.type);
      if (live !== undefined && live !== current.target) {
        this.pendingRequest = copyWithTarget(current, live);
        return { kind: 'retargeted', request: this.pendingRequest, text: this.pendingRequest.prompt };
      }
      return { kind: 'confirmed', request: this.resolveCurrent(), next: this.pendingRequest };
    }
    if (reply === 'decline' || reply === 'cancel') {
      const resolved = this.resolveCurrent();
      return { kind: 'declined', request: resolved, next: this.pendingRequest };
    }
    return { kind: 'ignored' };
  }

  private resolveCurrent(): ModelRequest {
    const resolved = this.pendingRequest!;
    this.pendingRequest = this.queue.shift() ?? null;
    if (this.pendingRequest !== null) {
      const live = this.liveTargets.get(this.pendingRequest.action.type);
      if (live !== undefined && live !== this.pendingRequest.target) {
        this.pendingRequest = copyWithTarget(this.pendingRequest, live);
      }
    }
    return resolved;
  }
}

function requestSnapshot(request: ConfirmationRequest | null): ModelRequest | null {
  return request === null ? null : {
    action: request.action,
    target: request.target,
    prompt: request.prompt,
    origin: request.origin,
    correlationId: request.correlationId,
  };
}

function snapshot(manager: ConfirmationManager, model: ReferenceModel): void {
  expect(requestSnapshot(manager.pending())).toEqual(model.pendingRequest);
  expect(manager.queued().map(requestSnapshot)).toEqual(model.queue);
  expect(manager.pending() === null || manager.pending()!.prompt === formatConfirmation(
    manager.pending()!.action,
    manager.pending()!.target,
  )).toBe(true);
}

function expectOutcome(
  actual: ReturnType<ConfirmationManager['handleReply']>,
  expected: ReturnType<ReferenceModel['reply']>,
): void {
  expect(actual.kind).toBe(expected.kind);
  if (expected.request !== undefined) {
    expect(requestSnapshot(actual.request)).toEqual(expected.request);
  }
  if (expected.next !== undefined) {
    const actualNext = actual.kind === 'confirmed' || actual.kind === 'declined' ? actual.next : null;
    expect(requestSnapshot(actualNext)).toEqual(expected.next);
  }
  if (expected.text !== undefined) {
    expect(actual.kind === 'repeated' || actual.kind === 'reprompt' || actual.kind === 'retargeted'
      ? actual.text : undefined).toBe(expected.text);
  }
}

describe('Property 3: confirmation state machine', () => {
  it('matches an independent FIFO reference model across generated operation sequences', () => {
    const randomOperationsArb = fc.array(operationArb, { minLength: 0, maxLength: 60 });
    fc.assert(
      fc.property(randomOperationsArb, (randomOperations) => {
        const operations: Operation[] = [
          {
            kind: 'request',
            id: 'seed-a',
            input: { action: { type: 'RUN_TESTS' }, target: 'npm.cmd test', origin: 'agent' },
          },
          {
            kind: 'request',
            id: 'seed-b',
            input: { action: { type: 'RUN_TESTS' }, target: 'npm.cmd test -- --coverage', origin: 'local' },
          },
          { kind: 'change_target', actionType: 'RUN_TESTS', target: 'npm.cmd test -- --coverage' },
          { kind: 'reply', text: 'repeat' },
          { kind: 'reply', text: 'confirm' },
          { kind: 'reply', text: 'confirm' },
          ...randomOperations,
        ];
        const liveTargets = new Map<Action['type'], string>();
        const manager = new ConfirmationManager((action) => liveTargets.get(action.type));
        const model = new ReferenceModel();
        let requestNumber = 0;

        for (const operation of operations) {
          if (operation.kind === 'request') {
            const correlationId = `${operation.id}-${requestNumber}`;
            requestNumber += 1;
            const input = { ...operation.input, correlationId };
            if (!liveTargets.has(input.action.type)) liveTargets.set(input.action.type, input.target);
            const expectedPending = model.pendingRequest === null;
            const actual = manager.request(input);
            model.request(input);
            expect(actual.kind).toBe(expectedPending ? 'pending' : 'queued');
          } else if (operation.kind === 'change_target') {
            liveTargets.set(operation.actionType, operation.target);
            model.changeTarget(operation.actionType, operation.target);
          } else {
            const expected = model.reply(operation.text);
            const actual = manager.handleReply(operation.text);
            expectOutcome(actual, expected);
          }
          snapshot(manager, model);
        }
      }),
      { numRuns: 100 },
    );
  });
});
