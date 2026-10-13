import { beforeEach, describe, expect, it } from 'vitest';

import type { ActionResult } from '../../src/actions/actionResult';
import type { Action } from '../../src/actions/actionTypes';
import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import { ActionGate } from '../../src/confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from '../../src/confirmation/confirmationController';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';
import { AgentActionHandler } from '../../src/pipeline/agentActionHandler';
import agentRequestFixture from '../../src/protocol/fixtures/messages/agent_request.json';
import type { AgentRequest } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { read as readTestCommand } from '../../src/testing/testCommandConfig';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory, type FakeWebSocket } from '../mocks/fakeWebSocket';
import { setMockConfiguration } from '../mocks/vscode';

/**
 * Task 7.12: agent-originated actions against a fake backend (Req 5.2, 5.3, 5.4, 5.5, 5.9, 5.10,
 * 5.11). The backend is a fake socket; everything on the extension side is the real thing: the
 * BackendClient (protocol validation included), AgentActionHandler, ActionGate, ConfirmationManager
 * and GateConfirmationController. Only the action executor is a recording double, so no editor,
 * process or network is touched. The wiring into extension.ts is Task 7.13; here the test plays the
 * part of that wiring by handing the client's agent_response / action_request to the handler.
 */

const COMMAND = 'npm test';
const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
};

interface ResultFrame {
  readonly replyTo: string;
  readonly result: { actionType: string; status: string; message: string };
}

function harness() {
  const factory = new FakeSocketFactory();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
  client.connect();
  const socket = factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  expect(client.state).toBe('connected');

  const executed: Action[] = [];
  const executor = {
    execute: async (action: Action): Promise<ActionResult> => {
      executed.push(action);
      return { actionType: action.type, status: 'ok', message: `Ran ${action.type}.` };
    },
  };
  const manager = new ConfirmationManager(currentTestTarget);
  const gate = new ActionGate({ confirmations: manager, executor });
  const handler = new AgentActionHandler({ gate, sender: client, readTestCommand });
  const controller = new GateConfirmationController(gate, manager, (resolution) => handler.onResolution(resolution));
  handler.listen(client);

  let counter = 0;
  /** The backend answers one agent_request with an agent_response that carries `action`. */
  const agentTurn = async (action: unknown, flag: boolean | undefined) => {
    counter += 1;
    const request: AgentRequest = { ...(agentRequestFixture as AgentRequest), id: `req-${counter}` };
    const pending = client.requestAgent(request);
    socket.triggerJson({
      version: 1,
      type: 'agent_response',
      replyTo: request.id,
      speech: 'Here you go.',
      action,
      ...(flag === undefined ? {} : { confirmationRequired: flag }),
    });
    const answer = await pending;
    if (!answer.ok) throw new Error(`the fake backend's answer was refused: ${answer.error.kind}`);
    return { id: request.id, outcome: await handler.handleAgentResponse(answer.value) };
  };

  const pushActionRequest = async (id: string, action: unknown) => {
    socket.triggerJson({ version: 1, type: 'action_request', id, action, reason: 'because' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { client, socket, executed, manager, controller, gate, handler, agentTurn, pushActionRequest };
}

/** Every action_result the backend has received, validated against the protocol on the way. */
function results(socket: FakeWebSocket): ResultFrame[] {
  const frames = socket.sentMessages.filter((message) => message.type === 'action_result');
  for (const frame of frames) expect(validateProtocolMessage(frame).ok).toBe(true);
  return frames as unknown as ResultFrame[];
}

beforeEach(() => {
  setMockConfiguration({ 'kirosight.testCommand': COMMAND });
});

describe('RUN_TESTS with confirmationRequired false still asks (Req 5.3, 5.9)', () => {
  it('asks for confirmation, runs nothing and sends nothing until the user answers', async () => {
    const { agentTurn, executed, manager, socket } = harness();

    const { outcome } = await agentTurn({ type: 'RUN_TESTS' }, false);

    expect(outcome.status).toBe('confirmation_pending');
    expect(outcome.text).toContain(COMMAND);
    expect(manager.pending()?.action).toEqual({ type: 'RUN_TESTS' });
    expect(executed).toEqual([]);
    expect(results(socket)).toEqual([]);
  });

  it('runs exactly once after CONFIRM and then sends one ok result for that request', async () => {
    const { agentTurn, controller, executed, socket } = harness();
    const { id } = await agentTurn({ type: 'RUN_TESTS' }, false);

    await controller.intercept('confirm');

    expect(executed).toEqual([{ type: 'RUN_TESTS' }]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { actionType: 'RUN_TESTS', status: 'ok' } });
  });

  it('also asks when the flag is true', async () => {
    const { agentTurn, executed, manager } = harness();
    const { outcome } = await agentTurn({ type: 'RUN_TESTS' }, true);
    expect(outcome.status).toBe('confirmation_pending');
    expect(manager.pending()).not.toBeNull();
    expect(executed).toEqual([]);
  });

  // On the wire an agent_response always carries the boolean (the client's validator drops one
  // that does not), so an absent flag reaches the handler only through an action_request or a
  // direct call. Both must behave like false.
  it('also asks when the flag is absent, for an action_request and for a direct call', async () => {
    const viaRequest = harness();
    await viaRequest.pushActionRequest('A1', { type: 'RUN_TESTS' });
    expect(viaRequest.manager.pending()?.correlationId).toBe('A1');
    expect(viaRequest.executed).toEqual([]);
    expect(results(viaRequest.socket)).toEqual([]);

    const direct = harness();
    const outcome = await direct.handler.handleAgentResponse({
      replyTo: 'R1', action: { type: 'RUN_TESTS' }, confirmationRequired: undefined as unknown as boolean,
    });
    expect(outcome.status).toBe('confirmation_pending');
    expect(direct.executed).toEqual([]);
  });
});

describe('a safe action and the confirmation flag (Req 5.2, 5.10)', () => {
  const safe = { type: 'GO_TO_LINE', line: 14 };

  it('asks when the flag is true, and runs only after CONFIRM', async () => {
    const { agentTurn, controller, executed, manager, socket } = harness();

    const { outcome, id } = await agentTurn(safe, true);

    expect(outcome.status).toBe('confirmation_pending');
    expect(manager.pending()?.action).toEqual(safe);
    expect(executed).toEqual([]);
    expect(results(socket)).toEqual([]);

    await controller.intercept('confirm');

    expect(executed).toEqual([safe]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { status: 'ok' } });
  });

  it('runs at once, without a prompt, when the flag is false', async () => {
    const { agentTurn, executed, manager, socket } = harness();

    const { outcome, id } = await agentTurn(safe, false);

    expect(outcome.status).toBe('executed');
    expect(manager.pending()).toBeNull();
    expect(executed).toEqual([safe]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { actionType: 'GO_TO_LINE', status: 'ok' } });
  });

  it('runs at once when the flag is absent on a direct call', async () => {
    const { handler, executed, manager } = harness();

    const outcome = await handler.handleAgentResponse({
      replyTo: 'R7', action: safe as never, confirmationRequired: undefined as unknown as boolean,
    });

    expect(outcome.status).toBe('executed');
    expect(manager.pending()).toBeNull();
    expect(executed).toEqual([safe]);
  });

  it('treats an action_request, which has no flag, as safe-and-run', async () => {
    const { pushActionRequest, executed, manager, socket } = harness();

    await pushActionRequest('A1', safe);

    expect(manager.pending()).toBeNull();
    expect(executed).toEqual([safe]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: 'A1', result: { status: 'ok' } });
  });
});

describe('declined, cancelled, unknown and unconfigured each send exactly one matching result (Req 5.4, 5.5, 5.11)', () => {
  it.each([
    ['decline', 'declined'],
    ['cancel', 'declined'],
  ])('a typed "%s" runs nothing and sends one %s result', async (reply, status) => {
    const { agentTurn, controller, executed, manager, socket } = harness();
    const { id } = await agentTurn({ type: 'RUN_TESTS' }, false);

    await controller.intercept(reply);
    await controller.intercept(reply); // nothing is pending any more: no second result

    expect(executed).toEqual([]);
    expect(manager.pending()).toBeNull();
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { actionType: 'RUN_TESTS', status } });
  });

  it('the Decline button sends the same single declined result', async () => {
    const { agentTurn, controller, executed, socket } = harness();
    const { id } = await agentTurn({ type: 'RUN_TESTS' }, false);

    await controller.decline();

    expect(executed).toEqual([]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { status: 'declined' } });
  });

  it('an unknown action name is not run and gets one not_permitted result', async () => {
    const { agentTurn, executed, manager, socket } = harness();

    const { outcome, id } = await agentTurn({ type: 'RUN_COMMAND', command: 'rm -rf /' }, true);

    expect(outcome.status).toBe('not_permitted');
    expect(manager.pending()).toBeNull();
    expect(executed).toEqual([]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { actionType: 'RUN_COMMAND', status: 'not_permitted' } });
    expect(JSON.stringify(socket.sentMessages)).not.toContain('rm -rf');
  });

  it.each(['go_to_line', 'GO_TO_SYMBOL', 'Run_Tests'])('the near-miss name %s is not permitted either', async (type) => {
    const { agentTurn, executed, socket } = harness();

    await agentTurn({ type, line: 3 }, false);

    expect(executed).toEqual([]);
    expect(results(socket).map(({ result }) => result.status)).toEqual(['not_permitted']);
  });

  it('an unknown action pushed as an action_request gets its one not_permitted result too', async () => {
    const { pushActionRequest, executed, socket } = harness();

    await pushActionRequest('A2', { type: 'GO_TO_SYMBOL', name: 'x' });

    expect(executed).toEqual([]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: 'A2', result: { status: 'not_permitted' } });
  });

  it.each(['', '   '])('an unconfigured test command (%j) asks nothing, runs nothing and sends one not_configured result', async (value) => {
    setMockConfiguration({ 'kirosight.testCommand': value });
    const { agentTurn, executed, manager, socket } = harness();

    const { outcome, id } = await agentTurn({ type: 'RUN_TESTS' }, true);

    expect(outcome.status).toBe('not_configured');
    expect(manager.pending()).toBeNull();
    expect(executed).toEqual([]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { actionType: 'RUN_TESTS', status: 'not_configured' } });
  });

  it('a command cleared while the prompt is pending is dropped with one not_configured result', async () => {
    const { agentTurn, controller, executed, socket } = harness();
    const { id } = await agentTurn({ type: 'RUN_TESTS' }, false);
    setMockConfiguration({ 'kirosight.testCommand': '' });

    await controller.intercept('confirm');

    expect(executed).toEqual([]);
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { status: 'not_configured' } });
  });
});

describe('a locally originated action sends no action_result', () => {
  it('neither a safe local action nor a confirmed local run reaches the backend as a result', async () => {
    const { gate, controller, executed, socket, manager } = harness();

    await gate.submit({ action: { type: 'GO_TO_LINE', line: 3 }, target: '', origin: 'local', correlationId: 'local-1' });
    await gate.submit({ action: { type: 'RUN_TESTS' }, target: COMMAND, origin: 'local', correlationId: 'local-2' });
    expect(manager.pending()?.origin).toBe('local');
    await controller.intercept('confirm');
    await gate.submit({ action: { type: 'RUN_TESTS' }, target: COMMAND, origin: 'local', correlationId: 'local-3' });
    await controller.intercept('decline');

    expect(executed).toEqual([{ type: 'GO_TO_LINE', line: 3 }, { type: 'RUN_TESTS' }]);
    expect(results(socket)).toEqual([]);
  });

  it('a local request and an agent request that share a queue each get the right treatment', async () => {
    const { agentTurn, gate, controller, socket } = harness();
    await gate.submit({ action: { type: 'RUN_TESTS' }, target: COMMAND, origin: 'local', correlationId: 'local-1' });
    const { id } = await agentTurn({ type: 'RUN_TESTS' }, false);
    expect(results(socket)).toEqual([]);

    await controller.intercept('decline'); // the local one
    expect(results(socket)).toEqual([]);

    await controller.intercept('decline'); // the agent's
    expect(results(socket)).toHaveLength(1);
    expect(results(socket)[0]).toMatchObject({ replyTo: id, result: { status: 'declined' } });
  });
});

describe('exactly one result per request across a whole conversation', () => {
  it('answers each agent request once, with its own correlation id, in the order they were decided', async () => {
    const { agentTurn, controller, socket, pushActionRequest } = harness();

    const first = await agentTurn({ type: 'FOCUS_EDITOR' }, false);
    const second = await agentTurn({ type: 'RUN_TESTS' }, false);
    const third = await agentTurn({ type: 'RUN_COMMAND' }, false);
    await pushActionRequest('A9', { type: 'GO_TO_LINE', line: 2 });
    await controller.intercept('cancel');

    expect(results(socket).map(({ replyTo, result }) => [replyTo, result.status])).toEqual([
      [first.id, 'ok'],
      [third.id, 'not_permitted'],
      ['A9', 'ok'],
      [second.id, 'declined'],
    ]);
    expect(new Set(results(socket).map(({ replyTo }) => replyTo)).size).toBe(4);
  });

  it('drops the result, without queueing it, when the backend has gone away', async () => {
    const { agentTurn, controller, client, socket } = harness();
    const { id } = await agentTurn({ type: 'RUN_TESTS' }, false);

    client.disconnect();
    await controller.intercept('decline');

    expect(results(socket).filter(({ replyTo }) => replyTo === id)).toEqual([]);
  });
});
