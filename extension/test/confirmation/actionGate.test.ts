import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { ActionResult } from '../../src/actions/actionResult';
import type { Action } from '../../src/actions/actionTypes';
import { ActionGate, type GateRequest } from '../../src/confirmation/actionGate';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';
import { formatConfirmation } from '../../src/response/responseFormatter';

const RUN_TESTS: Action = { type: 'RUN_TESTS' };
const GO_TO_LINE: Action = { type: 'GO_TO_LINE', line: 5 };

function setup(options: { liveTarget?: { value: string }; registry?: Record<string, { risk: 'safe' | 'needs-confirmation' }> } = {}) {
  const calls: Action[] = [];
  const executor = {
    execute: async (action: Action): Promise<ActionResult> => {
      calls.push(action);
      return { actionType: action.type, status: 'ok', message: `ran ${action.type}` };
    },
  };
  const live = options.liveTarget;
  const confirmations = new ConfirmationManager(live ? () => live.value : undefined);
  const gate = new ActionGate({ confirmations, executor, ...(options.registry ? { registry: options.registry } : {}) });
  return { gate, calls, confirmations };
}

function request(overrides: Partial<GateRequest> & Pick<GateRequest, 'action'>): GateRequest {
  return { target: 'npm.cmd test', origin: 'agent', correlationId: 'R1', ...overrides };
}

describe('ActionGate risk decisions', () => {
  it('runs a safe action immediately, exactly once, without touching confirmations', async () => {
    const { gate, calls, confirmations } = setup();

    const outcome = await gate.submit(request({ action: GO_TO_LINE, confirmationRequired: false }));

    expect(calls).toEqual([GO_TO_LINE]);
    expect(outcome).toMatchObject({
      kind: 'executed', origin: 'agent', correlationId: 'R1', result: { status: 'ok', message: 'ran GO_TO_LINE' },
    });
    expect(confirmations.pending()).toBeNull();
    expect(confirmations.queued()).toEqual([]);
  });

  it('runs a safe action immediately when the flag is absent', async () => {
    const { gate, calls } = setup();

    await gate.submit(request({ action: GO_TO_LINE }));

    expect(calls).toHaveLength(1);
  });

  it('asks for confirmation on a safe action when confirmationRequired is true', async () => {
    const { gate, calls, confirmations } = setup();

    const outcome = await gate.submit(request({ action: GO_TO_LINE, confirmationRequired: true, target: 'line 5' }));

    expect(outcome).toMatchObject({ kind: 'confirmation', state: 'pending' });
    expect(calls).toEqual([]);
    expect(confirmations.pending()).toMatchObject({ target: 'line 5', correlationId: 'R1', origin: 'agent' });
  });

  it.each([false, true, undefined])(
    'always asks for confirmation on a needs-confirmation action (flag %s)',
    async (flag) => {
      const { gate, calls, confirmations } = setup();

      const outcome = await gate.submit(request({ action: RUN_TESTS, ...(flag === undefined ? {} : { confirmationRequired: flag }) }));

      expect(outcome).toMatchObject({ kind: 'confirmation', state: 'pending' });
      expect(calls).toEqual([]);
      expect(confirmations.pending()?.prompt).toBe(formatConfirmation(RUN_TESTS, 'npm.cmd test'));
    },
  );

  it('cannot be overridden by risk-like fields smuggled onto the action or request', async () => {
    const { gate, calls } = setup();
    const sneaky = { type: 'RUN_TESTS', risk: 'safe', safe: true, confirmed: true, confirmationRequired: false } as unknown as Action;
    const sneakyRequest = { ...request({ action: sneaky }), risk: 'safe', confirmed: true } as GateRequest;

    const outcome = await gate.submit(sneakyRequest);

    expect(outcome.kind).toBe('confirmation');
    expect(calls).toEqual([]);
  });

  it('does not let origin or correlation id influence the decision', async () => {
    for (const origin of ['local', 'agent'] as const) {
      for (const correlationId of ['', 'x', 'safe', 'confirmed']) {
        const run = setup();
        const safe = await run.gate.submit(request({ action: GO_TO_LINE, origin, correlationId }));
        const risky = await setup().gate.submit(request({ action: RUN_TESTS, origin, correlationId }));

        expect(safe.kind).toBe('executed');
        expect(risky.kind).toBe('confirmation');
      }
    }
  });

  it('never executes an action with no registry entry', async () => {
    const { gate, calls, confirmations } = setup({ registry: { GO_TO_LINE: { risk: 'safe' } } });

    const outcome = await gate.submit(request({ action: RUN_TESTS, correlationId: 'N1' }));

    expect(outcome).toMatchObject({ kind: 'not_permitted', correlationId: 'N1', result: { status: 'not_permitted' } });
    expect(calls).toEqual([]);
    expect(confirmations.pending()).toBeNull();
  });

  it('treats inherited property names as missing registry entries', async () => {
    const { gate, calls } = setup();

    const outcome = await gate.submit(request({ action: { type: 'toString' } as unknown as Action }));

    expect(outcome.kind).toBe('not_permitted');
    expect(calls).toEqual([]);
  });
});

describe('ActionGate confirmation flow', () => {
  it('holds a queued request without executing and keeps it behind the pending one', async () => {
    const { gate, calls, confirmations } = setup();
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'A' }));

    const second = await gate.submit(request({ action: RUN_TESTS, correlationId: 'B' }));

    expect(second).toMatchObject({ kind: 'confirmation', state: 'queued' });
    expect(calls).toEqual([]);
    expect(confirmations.pending()?.correlationId).toBe('A');
    expect(confirmations.queued().map((r) => r.correlationId)).toEqual(['B']);
  });

  it('executes only the confirmed request, exactly once, and B needs its own confirm', async () => {
    const { gate, calls, confirmations } = setup();
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'A', origin: 'agent' }));
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'B', origin: 'local' }));

    const first = await gate.reply('confirm');

    expect(first).toMatchObject({ kind: 'executed', correlationId: 'A', origin: 'agent', result: { status: 'ok' } });
    expect(first.kind === 'executed' && first.next?.correlationId).toBe('B');
    expect(calls).toHaveLength(1);
    expect(confirmations.pending()?.correlationId).toBe('B');

    expect(await gate.reply('go to line 3')).toMatchObject({ kind: 'prompt', reason: 'reprompt' });
    expect(calls).toHaveLength(1);

    const second = await gate.reply('yes');
    expect(second).toMatchObject({ kind: 'executed', correlationId: 'B', origin: 'local' });
    expect(calls).toHaveLength(2);

    expect(await gate.reply('confirm')).toEqual({ kind: 'ignored' });
    expect(calls).toHaveLength(2);
  });

  it('does not rerun a resolved confirmation through the confirm control', async () => {
    const { gate, calls } = setup();
    await gate.submit(request({ action: RUN_TESTS }));

    await gate.confirm();
    await gate.confirm();
    await gate.reply('confirm');

    expect(calls).toHaveLength(1);
  });

  it('declines without executing and returns a declined ActionResult with a reason', async () => {
    const { gate, calls, confirmations } = setup();
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'A', origin: 'agent' }));
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'B' }));

    const outcome = await gate.reply('decline');

    expect(outcome).toMatchObject({
      kind: 'declined', reason: 'declined', origin: 'agent', correlationId: 'A',
      result: { actionType: 'RUN_TESTS', status: 'declined', message: 'you declined' },
    });
    expect(calls).toEqual([]);
    expect(confirmations.pending()?.correlationId).toBe('B');
  });

  it('cancel has decline-equivalent authorization behavior', async () => {
    const run = async (word: string) => {
      const { gate, calls, confirmations } = setup();
      await gate.submit(request({ action: RUN_TESTS, correlationId: 'A' }));
      await gate.submit(request({ action: RUN_TESTS, correlationId: 'B' }));
      const outcome = await gate.reply(word);
      return { outcome, calls: calls.length, pending: confirmations.pending()?.correlationId };
    };

    const declined = await run('decline');
    const cancelled = await run('cancel');

    expect(cancelled.calls).toBe(0);
    expect(cancelled.calls).toBe(declined.calls);
    expect(cancelled.pending).toBe(declined.pending);
    expect(cancelled.outcome).toMatchObject({
      kind: 'declined', reason: 'cancelled', result: { status: 'declined', message: 'you cancelled' },
    });
  });

  it('decline control dismisses without executing', async () => {
    const { gate, calls, confirmations } = setup();
    await gate.submit(request({ action: RUN_TESTS }));

    const outcome = await gate.decline();

    expect(outcome).toMatchObject({ kind: 'declined', result: { status: 'declined' } });
    expect(calls).toEqual([]);
    expect(confirmations.pending()).toBeNull();
  });

  it('repeat and unrecognized replies execute nothing and resolve nothing', async () => {
    const { gate, calls, confirmations } = setup();
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'A' }));
    const stored = confirmations.pending()!.prompt;

    expect(await gate.reply('repeat')).toMatchObject({ kind: 'prompt', reason: 'repeated', text: stored });
    expect(await gate.reply('what errors are there')).toMatchObject({ kind: 'prompt', reason: 'reprompt' });

    expect(calls).toEqual([]);
    expect(confirmations.pending()?.correlationId).toBe('A');
  });

  it('ignores idle replies and does not remember them for a later request', async () => {
    const { gate, calls } = setup();

    expect(await gate.reply('yes')).toEqual({ kind: 'ignored' });
    expect(await gate.confirm()).toEqual({ kind: 'ignored' });
    await gate.submit(request({ action: RUN_TESTS }));

    expect(calls).toEqual([]);
  });

  it('never executes a stale target: retarget first, then a second confirm runs once', async () => {
    const liveTarget = { value: 'npm.cmd test' };
    const { gate, calls, confirmations } = setup({ liveTarget });
    await gate.submit(request({ action: RUN_TESTS, correlationId: 'A', origin: 'agent' }));
    liveTarget.value = 'npm.cmd test -- --coverage';

    const first = await gate.reply('confirm');

    expect(first).toMatchObject({
      kind: 'prompt', reason: 'retargeted',
      text: formatConfirmation(RUN_TESTS, 'npm.cmd test -- --coverage'),
    });
    expect(calls).toEqual([]);
    expect(confirmations.pending()).toMatchObject({ target: 'npm.cmd test -- --coverage', correlationId: 'A' });

    const second = await gate.reply('confirm');

    expect(second).toMatchObject({ kind: 'executed', correlationId: 'A', origin: 'agent' });
    expect(calls).toHaveLength(1);
  });

  it('returns the executor result unchanged, including failures', async () => {
    const failing = { execute: async (): Promise<ActionResult> => ({ actionType: 'GO_TO_LINE', status: 'failed', message: 'No file is open.' }) };
    const gate = new ActionGate({ confirmations: new ConfirmationManager(), executor: failing });

    const outcome = await gate.submit(request({ action: GO_TO_LINE }));

    expect(outcome).toMatchObject({ kind: 'executed', result: { status: 'failed', message: 'No file is open.' } });
  });

  it('uses no timers or clocks', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../../src/confirmation/actionGate.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toMatch(/setTimeout|setInterval|Date\.now|new Date|performance\.now|\bexpir|\bttl\b/i);
  });
});
