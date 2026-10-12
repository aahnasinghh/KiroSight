import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ActionResult } from '../../src/actions/actionResult';
import type { Action } from '../../src/actions/actionTypes';
import { ALLOWLIST } from '../../src/actions/allowlist';
import { ActionGate, type GateRequest, type RiskRegistry } from '../../src/confirmation/actionGate';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';

const ACTION_TYPES = Object.keys(ALLOWLIST) as Action['type'][];
const SAFE_ACTION_TYPES = ACTION_TYPES.filter((type) => ALLOWLIST[type].risk === 'safe');
const NEEDS_CONFIRMATION_ACTION_TYPES = ACTION_TYPES.filter((type) => ALLOWLIST[type].risk === 'needs-confirmation');

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  fc.constant({ type: 'NO_ACTION' as const }),
  fc.record({
    type: fc.constant('GO_TO_DIAGNOSTIC' as const),
    index: fc.integer({ min: 0, max: 100 }),
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
  fc.string({ minLength: 1, maxLength: 80 }).map((path) => ({ type: 'OPEN_FILE' as const, path })),
  fc.integer({ min: 1, max: 1000 }).map((line) => ({ type: 'GO_TO_LINE' as const, line })),
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
  fc.string({ minLength: 1, maxLength: 100 }).filter((target) => /\S/.test(target)),
);
const originArb = fc.constantFrom<'local' | 'agent'>('local', 'agent');
const correlationIdArb = fc.constantFrom('', 'safe', 'confirmed', 'agent', 'local', 'request-1');
const confirmationFlagArb = fc.option(fc.boolean(), { nil: undefined });
const spoofFieldsArb = fc.record({
  risk: fc.constantFrom('safe', 'needs-confirmation', 'unknown'),
  safe: fc.boolean(),
  confirmed: fc.boolean(),
  requiresConfirmation: fc.boolean(),
  confirmationRequired: fc.boolean(),
});

function recordingExecutor() {
  const calls: Action[] = [];
  return {
    calls,
    executor: {
      execute: async (action: Action): Promise<ActionResult> => {
        calls.push(action);
        return { actionType: action.type, status: 'ok', message: `executed ${action.type}` };
      },
    },
  };
}

function makeRequest(
  action: Action,
  target: string,
  origin: 'local' | 'agent',
  correlationId: string,
  confirmationRequired: boolean | undefined,
  extras: Record<string, unknown> = {},
): GateRequest {
  return {
    action,
    target,
    origin,
    correlationId,
    ...(confirmationRequired === undefined ? {} : { confirmationRequired }),
    ...extras,
  } as GateRequest;
}

function gateWithResolver(liveTarget?: { value: string }, registry?: RiskRegistry) {
  const recording = recordingExecutor();
  const confirmations = new ConfirmationManager(liveTarget ? () => liveTarget.value : undefined);
  const gate = new ActionGate({
    confirmations,
    executor: recording.executor,
    ...(registry === undefined ? {} : { registry }),
  });
  return { ...recording, confirmations, gate };
}

async function submitGenerated(
  action: Action,
  target: string,
  origin: 'local' | 'agent',
  correlationId: string,
  confirmationRequired: boolean | undefined,
  spoof: Record<string, unknown> = {},
) {
  const { gate, confirmations, calls } = gateWithResolver();
  const { confirmationRequired: _requestFlag, ...requestSpoof } = spoof;
  const taintedAction = { ...action, ...spoof } as Action;
  const request = makeRequest(taintedAction, target, origin, correlationId, confirmationRequired, requestSpoof);
  const outcome = await gate.submit(request);
  return { gate, confirmations, calls, request, outcome };
}

describe('Property 2: execution is gated by registry risk', () => {
  it('uses the trusted registry risk for every valid action and metadata combination', async () => {
    await fc.assert(
      fc.asyncProperty(
        actionArb,
        targetArb,
        originArb,
        correlationIdArb,
        confirmationFlagArb,
        spoofFieldsArb,
        async (action, target, origin, correlationId, confirmationRequired, spoof) => {
          const { gate, confirmations, calls, request, outcome } = await submitGenerated(
            action, target, origin, correlationId, confirmationRequired, spoof,
          );
          const risk = ALLOWLIST[action.type].risk;
          const needsConfirmation = risk === 'needs-confirmation' || confirmationRequired === true;

          if (needsConfirmation) {
            expect(outcome).toMatchObject({ kind: 'confirmation', state: 'pending' });
            expect(calls).toEqual([]);
            expect(confirmations.pending()).toMatchObject({
              target, origin, correlationId, action: request.action,
            });
          } else {
            expect(outcome).toMatchObject({
              kind: 'executed', origin, correlationId, result: { actionType: action.type, status: 'ok' },
            });
            expect(calls).toEqual([request.action]);
            expect(confirmations.pending()).toBeNull();
            expect(confirmations.queued()).toEqual([]);
          }
          void gate;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never lets spoofed fields bypass a needs-confirmation action', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...NEEDS_CONFIRMATION_ACTION_TYPES),
        targetArb,
        originArb,
        correlationIdArb,
        confirmationFlagArb,
        spoofFieldsArb,
        async (actionType, target, origin, correlationId, confirmationRequired, spoof) => {
          const action = actionType === 'RUN_TESTS' ? { type: 'RUN_TESTS' as const } : { type: actionType } as Action;
          const { calls, confirmations, outcome } = await submitGenerated(
            action, target, origin, correlationId, confirmationRequired, spoof,
          );

          expect(outcome).toMatchObject({ kind: 'confirmation', state: 'pending' });
          expect(calls).toEqual([]);
          expect(confirmations.pending()?.correlationId).toBe(correlationId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('executes safe actions immediately only when confirmation is not explicitly required', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SAFE_ACTION_TYPES),
        targetArb,
        originArb,
        correlationIdArb,
        spoofFieldsArb,
        async (actionType, target, origin, correlationId, spoof) => {
          const action = actionType === 'NO_ACTION'
            ? { type: 'NO_ACTION' as const }
            : actionType === 'OPEN_FILE'
              ? { type: 'OPEN_FILE' as const, path: 'src/file.ts' }
              : actionType === 'GO_TO_LINE'
                ? { type: 'GO_TO_LINE' as const, line: 10 }
                : actionType === 'GO_TO_DIAGNOSTIC'
                  ? { type: 'GO_TO_DIAGNOSTIC' as const, index: 0 }
                  : actionType === 'NEXT_DIAGNOSTIC'
                    ? { type: 'NEXT_DIAGNOSTIC' as const }
                    : actionType === 'PREVIOUS_DIAGNOSTIC'
                      ? { type: 'PREVIOUS_DIAGNOSTIC' as const }
                      : { type: 'FOCUS_EDITOR' as const };
          const absent = await submitGenerated(action, target, origin, correlationId, undefined, spoof);
          const falseFlag = await submitGenerated(action, target, origin, correlationId, false, spoof);
          const trueFlag = await submitGenerated(action, target, origin, correlationId, true, spoof);

          for (const immediate of [absent, falseFlag]) {
            expect(immediate.outcome.kind).toBe('executed');
            expect(immediate.calls).toHaveLength(1);
            expect(immediate.confirmations.pending()).toBeNull();
          }
          expect(trueFlag.outcome).toMatchObject({ kind: 'confirmation', state: 'pending' });
          expect(trueFlag.calls).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('executes a confirmation-required safe action exactly once and preserves metadata', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...SAFE_ACTION_TYPES),
        targetArb,
        originArb,
        correlationIdArb,
        async (actionType, target, origin, correlationId) => {
          const action = actionType === 'NO_ACTION'
            ? { type: 'NO_ACTION' as const }
            : actionType === 'GO_TO_LINE'
              ? { type: 'GO_TO_LINE' as const, line: 10 }
              : { type: actionType } as Action;
          const run = await submitGenerated(action, target, origin, correlationId, true);

          expect(run.calls).toEqual([]);
          const first = await run.gate.reply('confirm');
          expect(first).toMatchObject({ kind: 'executed', origin, correlationId });
          expect(run.calls).toEqual([action]);
          expect(await run.gate.reply('confirm')).toEqual({ kind: 'ignored' });
          expect(await run.gate.confirm()).toEqual({ kind: 'ignored' });
          expect(run.calls).toHaveLength(1);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('never executes on decline, cancel, repeat or unrecognized confirmation input', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('decline', 'cancel', 'repeat', 'what errors are there'),
        async (reply) => {
          const run = await submitGenerated({ type: 'RUN_TESTS' }, 'npm.cmd test', 'agent', 'R', true);
          const before = run.confirmations.pending();
          const outcome = await run.gate.reply(reply);

          expect(run.calls).toEqual([]);
          if (reply === 'decline' || reply === 'cancel') {
            expect(outcome).toMatchObject({ kind: 'declined', result: { status: 'declined' } });
            expect(run.confirmations.pending()).toBeNull();
          } else {
            expect(outcome).toMatchObject({ kind: 'prompt' });
            expect(run.confirmations.pending()).toBe(before);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('isolates queued requests so one confirmation cannot execute two actions', async () => {
    await fc.assert(
      fc.asyncProperty(targetArb, targetArb, originArb, originArb, async (targetA, targetB, originA, originB) => {
        const run = gateWithResolver();
        await run.gate.submit(makeRequest({ type: 'RUN_TESTS' }, targetA, originA, 'A', false));
        await run.gate.submit(makeRequest({ type: 'RUN_TESTS' }, targetB, originB, 'B', false));

        const first = await run.gate.reply('confirm');
        expect(first).toMatchObject({ kind: 'executed', correlationId: 'A' });
        expect(run.calls).toHaveLength(1);
        expect(run.confirmations.pending()?.correlationId).toBe('B');

        expect(await run.gate.reply('repeat')).toMatchObject({ kind: 'prompt' });
        expect(run.calls).toHaveLength(1);
        const second = await run.gate.reply('confirm');
        expect(second).toMatchObject({ kind: 'executed', correlationId: 'B' });
        expect(run.calls).toHaveLength(2);
      }),
      { numRuns: 100 },
    );
  });

  it('requires re-confirmation when a live target changes', async () => {
    await fc.assert(
      fc.asyncProperty(targetArb, targetArb, fc.constantFrom('local', 'agent'), async (initial, changed, origin) => {
        fc.pre(initial !== changed);
        const liveTarget = { value: initial };
        const run = gateWithResolver(liveTarget);
        await run.gate.submit(makeRequest({ type: 'RUN_TESTS' }, initial, origin, 'target', false));
        liveTarget.value = changed;

        const stale = await run.gate.reply('confirm');
        expect(stale).toMatchObject({ kind: 'prompt', reason: 'retargeted' });
        expect(run.calls).toEqual([]);
        expect(run.confirmations.pending()).toMatchObject({ target: changed, origin, correlationId: 'target' });

        const confirmed = await run.gate.reply('confirm');
        expect(confirmed).toMatchObject({ kind: 'executed', origin, correlationId: 'target' });
        expect(run.calls).toHaveLength(1);
      }),
      { numRuns: 100 },
    );
  });

  it('never executes when the trusted registry has no entry', async () => {
    await fc.assert(
      fc.asyncProperty(actionArb, targetArb, originArb, correlationIdArb, async (action, target, origin, correlationId) => {
        const registry = Object.fromEntries(
          ACTION_TYPES.filter((type) => type !== action.type).map((type) => [type, ALLOWLIST[type]]),
        ) as RiskRegistry;
        const run = gateWithResolver(undefined, registry);
        const outcome = await run.gate.submit(makeRequest(action, target, origin, correlationId, false));

        expect(outcome).toMatchObject({ kind: 'not_permitted', result: { status: 'not_permitted' } });
        expect(run.calls).toEqual([]);
        expect(run.confirmations.pending()).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
