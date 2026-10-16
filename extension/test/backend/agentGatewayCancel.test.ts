import { describe, expect, it } from 'vitest';

import {
  BackendAgentGateway,
  type AgentGatewayClient,
} from '../../src/backend/agentGateway';
import type { BackendClientError, ConnectionState } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import type { AgentRequest, AgentResponse } from '../../src/protocol/messages';
import { ok, type Result } from '../../src/util/result';

/** Task 9.5: BackendAgentGateway.cancel(requestId) cancels exactly one agent_request, by its id. */
function context(): IDEContext {
  return {
    workspace: { name: 'sample', rootCount: 1 },
    activeFile: '/abs/private/work/src/auth.ts',
    relativePath: 'src/auth.ts',
    languageId: 'typescript',
    cursor: { line: 3, column: 1 },
    selection: { isEmpty: true },
    nearbyCode: { source: 'cursor_window', startLine: 2, endLine: 4, text: 'return value;', truncated: false },
    currentSymbol: { name: 'validateToken', kind: 'Function', startLine: 1, endLine: 5 },
    symbolStatus: 'found',
    diagnostics: [],
    diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
  } as IDEContext;
}

function reply(request: AgentRequest): Result<AgentResponse, BackendClientError> {
  return ok({
    version: 1, type: 'agent_response', replyTo: request.id, speech: 'There is one error.',
    action: null, confirmationRequired: false,
  } as unknown as AgentResponse);
}

interface Deferred<T> { readonly promise: Promise<T>; resolve(value: T): void }

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

class FakeClient implements AgentGatewayClient {
  public state: ConnectionState = 'connected';
  public readonly requests: AgentRequest[] = [];
  public readonly cancelled: string[] = [];
  public throwOnCancel = false;
  public readonly answers = new Map<string, Deferred<Result<AgentResponse, BackendClientError>>>();

  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>> {
    this.requests.push(request);
    const answer = deferred<Result<AgentResponse, BackendClientError>>();
    this.answers.set(request.id, answer);
    return answer.promise;
  }

  public cancelAgentRequest(targetId: string): boolean {
    if (this.throwOnCancel) throw new Error('cancel failed');
    this.cancelled.push(targetId);
    return true;
  }
}

function build(getContext: () => Promise<IDEContext> = () => Promise.resolve(context())) {
  const client = new FakeClient();
  const gateway = new BackendAgentGateway({ client, context: { getContext } });
  return { client, gateway };
}

describe('BackendAgentGateway.cancel', () => {
  it('cancels a sent agent_request by its own id, and the interrupted submission ends without an answer', async () => {
    const { client, gateway } = build();
    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();
    expect(client.requests.map((r) => r.id)).toEqual(['req-1']);

    gateway.cancel(1);

    expect(client.cancelled).toEqual(['req-1']);
    // The request stays registered, so an answer already on its way still comes back to the
    // gateway (and the pipeline, seeing it is no longer current, drops it).
    client.answers.get('req-1')!.resolve(reply(client.requests[0]!));
    await expect(pending).resolves.toMatchObject({ status: 'handled', text: 'There is one error.' });
  });

  it('never sends a request that was cancelled before it was sent', async () => {
    const gate = deferred<IDEContext>();
    const { client, gateway } = build(() => gate.promise);
    const pending = gateway.respond('explain this error', { requestId: 4, source: 'typed' });

    gateway.cancel(4);
    gate.resolve(context());
    const result = await pending;

    expect(client.requests).toEqual([]);
    expect(result.status).toBe('not_handled');
  });

  it('cancels only the named submission: a newer request is sent and answered normally', async () => {
    const { client, gateway } = build();
    const first = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();
    gateway.cancel(1);
    const second = gateway.respond('why is this slow', { requestId: 2, source: 'voice' });
    await flush();

    client.answers.get('req-1')!.resolve(reply(client.requests[0]!));
    client.answers.get('req-2')!.resolve(reply(client.requests[1]!));

    expect(client.cancelled).toEqual(['req-1']);
    expect(client.requests.map((r) => r.id)).toEqual(['req-1', 'req-2']);
    await expect(second).resolves.toMatchObject({ status: 'handled', text: 'There is one error.' });
    await first;
  });

  it('ignores a repeated cancel, an unknown id, and a submission that already finished', async () => {
    const { client, gateway } = build();
    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();

    gateway.cancel(99);
    gateway.cancel(1);
    gateway.cancel(1);
    expect(client.cancelled).toEqual(['req-1']);

    client.answers.get('req-1')!.resolve(reply(client.requests[0]!));
    await pending;
    gateway.cancel(1); // finished: nothing to cancel, nothing sent
    expect(client.cancelled).toEqual(['req-1']);
  });

  it('does not let a finished submission block or be cancelled by a later one with a new id', async () => {
    const { client, gateway } = build();
    const first = gateway.respond('one', { requestId: 1, source: 'typed' });
    await flush();
    client.answers.get('req-1')!.resolve(reply(client.requests[0]!));
    await first;

    const second = gateway.respond('two', { requestId: 2, source: 'typed' });
    await flush();
    gateway.cancel(1);

    expect(client.cancelled).toEqual([]);
    client.answers.get('req-2')!.resolve(reply(client.requests[1]!));
    await expect(second).resolves.toMatchObject({ status: 'handled' });
  });

  it('survives a client that cannot cancel, or that throws while cancelling', async () => {
    const { client, gateway } = build();
    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();

    client.throwOnCancel = true;
    expect(() => gateway.cancel(1)).not.toThrow();
    client.answers.get('req-1')!.resolve(reply(client.requests[0]!));
    await expect(pending).resolves.toMatchObject({ status: 'handled' });

    const bare = new BackendAgentGateway({
      client: { state: 'connected', requestAgent: (request) => Promise.resolve(reply(request)) },
      context: { getContext: () => Promise.resolve(context()) },
    });
    const bareRun = bare.respond('x', { requestId: 5, source: 'typed' });
    expect(() => bare.cancel(5)).not.toThrow();
    await bareRun;
  });
});
