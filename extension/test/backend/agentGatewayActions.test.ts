import { describe, expect, it } from 'vitest';

import {
  BACKEND_EMPTY_RESPONSE_TEXT,
  BackendAgentGateway,
  type AgentGatewayClient,
  type AgentResponseActions,
} from '../../src/backend/agentGateway';
import type { BackendClientError, ConnectionState } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import type { AgentRequest, AgentResponse } from '../../src/protocol/messages';
import { ok, type Result } from '../../src/util/result';

const context = {
  workspace: { name: 'w', rootCount: 1 }, activeFile: '/abs/a.ts', relativePath: 'a.ts', languageId: 'typescript',
  cursor: null, selection: null, nearbyCode: null, currentSymbol: null, symbolStatus: 'none_enclosing',
  diagnostics: [], diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
} as IDEContext;

const PREPARED: AgentRequest = {
  version: 1, type: 'agent_request', id: 'prepared', kind: 'utterance', utterance: { text: 'explain this error' },
  context: {
    workspace: { name: 'w', rootCount: 1 }, relativePath: 'a.ts', languageId: 'typescript', cursor: null, selection: null,
    nearbyCode: { source: 'symbol', startLine: 1, endLine: 3, text: 'code', truncated: false }, currentSymbol: null,
    symbolStatus: 'none_enclosing', diagnostics: [], diagnosticCounts: { error: 1, warning: 0, information: 0, hint: 0 },
  },
};

class FakeClient implements AgentGatewayClient {
  public state: ConnectionState = 'connected';
  public readonly requests: AgentRequest[] = [];
  public speech = 'Here you go.';
  public action: unknown = { type: 'NO_ACTION' };

  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>> {
    this.requests.push(request);
    return Promise.resolve(ok({
      version: 1, type: 'agent_response', replyTo: request.id, speech: this.speech,
      action: this.action as AgentResponse['action'], confirmationRequired: false,
    }));
  }
}

class FakeActions implements AgentResponseActions {
  public readonly handled: AgentResponse[] = [];
  public readonly interruptedFor: AgentResponse[] = [];
  public text = '';
  public throws = false;

  public async handleAgentResponse(response: AgentResponse): Promise<{ text: string }> {
    this.handled.push(response);
    if (this.throws) throw new Error('boom');
    return { text: this.text };
  }

  public interrupted(response: AgentResponse): void {
    this.interruptedFor.push(response);
  }
}

function build(withActions = true) {
  const client = new FakeClient();
  const actions = new FakeActions();
  let contextCalls = 0;
  const gateway = new BackendAgentGateway({
    client,
    context: { getContext: () => { contextCalls += 1; return Promise.resolve(context); } },
    ...(withActions ? { actions } : {}),
  });
  return { client, actions, gateway, contextCalls: () => contextCalls };
}

describe('BackendAgentGateway with an action handler', () => {
  it('hands the answer to the handler and returns the speech unchanged when it adds nothing', async () => {
    const { gateway, actions, client } = build();
    client.action = { type: 'NO_ACTION' };

    const result = await gateway.respond('hello', { requestId: 1, source: 'typed' });

    expect(result).toEqual({ status: 'handled', text: 'Here you go.' });
    expect(actions.handled).toHaveLength(1);
    expect(actions.handled[0]).toMatchObject({ replyTo: 'req-1', action: { type: 'NO_ACTION' } });
  });

  it('adds what the handler reports after the speech', async () => {
    const { gateway, actions } = build();
    actions.text = 'Run tests using "npm test"? Reply confirm, decline, cancel, or repeat.';

    const result = await gateway.respond('hello', { requestId: 1, source: 'typed' });

    expect(result).toEqual({ status: 'handled', text: 'Here you go. Run tests using "npm test"? Reply confirm, decline, cancel, or repeat.' });
  });

  it('shows only the handler text when the answer had no speech, not the empty-answer notice', async () => {
    const { gateway, actions, client } = build();
    client.speech = '   ';
    actions.text = 'Focused the editor.';

    const result = await gateway.respond('hello', { requestId: 1, source: 'typed' });

    expect(result.text).toBe('Focused the editor.');
    expect(result.text).not.toContain(BACKEND_EMPTY_RESPONSE_TEXT);
  });

  it('does not consider the action of an interrupted request, and tells the handler', async () => {
    const { gateway, actions } = build();

    const result = await gateway.respond('hello', { requestId: 1, source: 'typed', isCurrent: () => false });

    expect(actions.handled).toEqual([]);
    expect(actions.interruptedFor).toHaveLength(1);
    expect(result).toEqual({ status: 'handled', text: 'Here you go.' });
  });

  it('keeps the speech when the handler fails', async () => {
    const { gateway, actions } = build();
    actions.throws = true;

    const result = await gateway.respond('hello', { requestId: 1, source: 'typed' });

    expect(result).toEqual({ status: 'handled', text: 'Here you go.' });
  });

  it('ignores the action entirely without a handler, as in Milestone 6', async () => {
    const { gateway, client } = build(false);
    client.action = { type: 'RUN_TESTS' };

    const result = await gateway.respond('hello', { requestId: 1, source: 'typed' });

    expect(Object.keys(result).sort()).toEqual(['status', 'text']);
  });
});

describe('BackendAgentGateway with a prepared request', () => {
  it('sends it with the relay id, gathers no second context, and keeps its grounded content', async () => {
    const { gateway, client, contextCalls } = build();

    await gateway.respond('explain this error', { requestId: 7, source: 'voice', prepared: PREPARED });

    expect(contextCalls()).toBe(0);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).toEqual({ ...PREPARED, id: 'req-7' });
  });

  it('still reports the backend unavailable, sending nothing, when the connection dropped', async () => {
    const { gateway, client } = build();
    client.state = 'disconnected';

    const result = await gateway.respond('explain this error', { requestId: 7, source: 'typed', prepared: PREPARED });

    expect(result.unavailable).toBe(true);
    expect(client.requests).toEqual([]);
  });
});
