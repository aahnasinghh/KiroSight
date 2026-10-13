import { describe, expect, it } from 'vitest';

import {
  BACKEND_REQUEST_FAILED_TEXT,
  BackendAgentGateway,
  type AgentGatewayClient,
} from '../../src/backend/agentGateway';
import type { BackendClientError, ConnectionState } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import type { AgentRequest, AgentResponse, ErrorCode } from '../../src/protocol/messages';
import {
  INVALID_REASONING_RESPONSE_TEXT,
  REASONING_FAILED_TEXT,
} from '../../src/response/explanationMessages';
import { err, type Result } from '../../src/util/result';

const SECRET_DETAIL = 'RAW-BACKEND-DETAIL AWS_SECRET_ACCESS_KEY is not set';

const context = {
  workspace: { name: 'w', rootCount: 1 },
  activeFile: null,
  relativePath: null,
  languageId: null,
  cursor: null,
  selection: null,
  nearbyCode: null,
  currentSymbol: null,
  symbolStatus: 'no_editor',
  diagnostics: [],
  diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
} as IDEContext;

class FailingClient implements AgentGatewayClient {
  public readonly state: ConnectionState = 'connected';
  public readonly requests: AgentRequest[] = [];

  public constructor(private readonly error: BackendClientError) {}

  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>> {
    this.requests.push(request);
    return Promise.resolve(err(this.error));
  }
}

async function ask(error: BackendClientError) {
  const client = new FailingClient(error);
  const gateway = new BackendAgentGateway({ client, context: { getContext: () => Promise.resolve(context) } });
  const result = await gateway.respond('explain this error', { requestId: 1, source: 'typed' });
  return { result, client };
}

const backendError = (backendCode: ErrorCode, recoverable = true): BackendClientError =>
  ({ kind: 'backend_error', message: SECRET_DETAIL, backendCode, recoverable });

describe('a reasoning failure reported by the backend (Req 12.3, design F2 and F6)', () => {
  it.each([
    ['BEDROCK_UNAVAILABLE', REASONING_FAILED_TEXT],
    ['CREDENTIAL_MISSING', REASONING_FAILED_TEXT],
    ['BEDROCK_INVALID_RESPONSE', INVALID_REASONING_RESPONSE_TEXT],
  ] as const)('shows a stated error for %s without relaying the backend text', async (code, statement) => {
    const { result, client } = await ask(backendError(code));

    expect(result.status).toBe('not_handled');
    expect(result.text).toContain(statement);
    expect(result.unavailable).toBeUndefined(); // the backend is connected; only reasoning failed
    expect(result.text).not.toContain('RAW-BACKEND-DETAIL');
    expect(result.text).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(client.requests).toHaveLength(1); // no retry, on this or any other provider
  });

  it('does not retry a recoverable failure and stays in the not_handled state so the text can be resent', async () => {
    const { result, client } = await ask(backendError('BEDROCK_UNAVAILABLE', true));
    expect(result.status).toBe('not_handled');
    expect(client.requests).toHaveLength(1);
  });

  it.each(['INTERNAL', 'VALIDATION_FAILED', 'TIMEOUT', 'STT_UNAVAILABLE'] as const)(
    'keeps the generic text for the non-reasoning code %s',
    async (code) => {
      const { result } = await ask(backendError(code));
      expect(result).toEqual({ status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT });
    },
  );

  it('keeps the generic text for a backend_error with no code', async () => {
    const { result } = await ask({ kind: 'backend_error', message: SECRET_DETAIL });
    expect(result).toEqual({ status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT });
  });
});
