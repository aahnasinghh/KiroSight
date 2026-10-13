import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  BackendAgentGateway,
  type AgentGatewayClient,
} from '../../src/backend/agentGateway';
import type { ConnectionState } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import type { AgentRequest, AgentResponse } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { ok, type Result } from '../../src/util/result';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

function context(): IDEContext {
  return {
    workspace: { name: 'property-fixture', rootCount: 1 },
    activeFile: '/private/project/src/fixture.ts',
    relativePath: 'src/fixture.ts',
    languageId: 'typescript',
    cursor: null,
    selection: null,
    nearbyCode: null,
    currentSymbol: null,
    symbolStatus: 'none_enclosing',
    diagnostics: [],
    diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
  } as IDEContext;
}

function response(request: AgentRequest): AgentResponse {
  return {
    version: 1,
    type: 'agent_response',
    replyTo: request.id,
    speech: `answer for ${request.utterance?.text ?? ''}`,
    action: { type: 'NO_ACTION' },
    confirmationRequired: false,
  };
}

class PropertyClient implements AgentGatewayClient {
  public readonly state: ConnectionState = 'connected';
  public readonly sent: AgentRequest[] = [];
  public readonly responseGates: Array<Deferred<Result<AgentResponse, never>>> = [];

  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, never>> {
    this.sent.push(request);
    const gate = deferred<Result<AgentResponse, never>>();
    this.responseGates.push(gate);
    return gate.promise;
  }
}

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

const utterancesArb = fc.uniqueArray(
  fc.string({ minLength: 1, maxLength: 40 }).filter((text) => text.trim().length > 0),
  { minLength: 1, maxLength: 12 },
);

describe('Property 32: Relay preserves arrival order', () => {
  it('sends every generated agent request in exact arrival order under adversarial preparation timing', async () => {
    await fc.assert(
      fc.asyncProperty(utterancesArb, async (arrivals) => {
        const preparationGates = arrivals.map(() => deferred<IDEContext>());
        let preparationIndex = 0;
        const client = new PropertyClient();
        const gateway = new BackendAgentGateway({
          client,
          context: {
            getContext: () => preparationGates[preparationIndex++]!.promise,
          },
        });

        const pending = arrivals.map((text, index) => gateway.respond(text, {
          requestId: index + 1,
          source: 'typed',
        }));

        // Complete preparation in reverse order. A broken implementation that sends as soon as
        // context preparation finishes would therefore permute the outbound request sequence.
        for (let index = preparationGates.length - 1; index >= 0; index -= 1) {
          preparationGates[index]!.resolve(context());
        }
        await flush();

        expect(client.sent).toHaveLength(arrivals.length);
        expect(client.sent.map((request) => request.utterance?.text)).toEqual(arrivals);
        expect(client.sent.map((request) => request.id)).toEqual(
          arrivals.map((_, index) => `req-${index + 1}`),
        );
        expect(new Set(client.sent.map((request) => request.id)).size).toBe(arrivals.length);
        expect(client.sent.every((request) => validateProtocolMessage(request).ok)).toBe(true);

        // Complete responses in reverse order. This verifies the property concerns send order only;
        // the gateway is allowed to keep all requests in flight concurrently.
        for (let index = client.responseGates.length - 1; index >= 0; index -= 1) {
          client.responseGates[index]!.resolve(ok(response(client.sent[index]!)));
        }
        await expect(Promise.all(pending)).resolves.toHaveLength(arrivals.length);
      }),
      { numRuns: 100 },
    );
  });
});
