import { describe, expect, it } from 'vitest';

import { BackendAgentGateway, BACKEND_REQUEST_TIMED_OUT_TEXT } from '../../src/backend/agentGateway';
import { AGENT_REQUEST_TIMEOUT_MS, BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import { validateProtocolMessage } from '../../src/protocol/validators';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

/** Task 9.5: BackendClient.cancelAgentRequest sends one `cancel` and keeps the request registered. */
const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: true, stt: true, tts: true, mic: 'available' },
};

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

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

function connected() {
  const factory = new FakeSocketFactory();
  const scheduler = new FakeScheduler();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler });
  client.connect();
  const socket = factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  const gateway = new BackendAgentGateway({ client, context: { getContext: () => Promise.resolve(context()) } });
  const cancels = () => socket.sentMessages.filter((message) => message.type === 'cancel');
  return { client, socket, scheduler, gateway, cancels };
}

describe('BackendClient.cancelAgentRequest', () => {
  it('sends one valid cancel frame for the in-flight request, and not a second', async () => {
    const { client, gateway, cancels } = connected();
    void gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();

    expect(client.cancelAgentRequest('req-1')).toBe(true);
    expect(client.cancelAgentRequest('req-1')).toBe(false);

    expect(cancels()).toEqual([{ version: 1, type: 'cancel', targetId: 'req-1' }]);
    expect(validateProtocolMessage(cancels()[0]).ok).toBe(true);
  });

  it('keeps the request registered: an answer already on its way still reaches the caller', async () => {
    const { client, socket, gateway } = connected();
    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();
    client.cancelAgentRequest('req-1');

    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: 'req-1', speech: 'There is one error.',
      action: { type: 'RUN_TESTS' }, confirmationRequired: false,
    });

    await expect(pending).resolves.toMatchObject({ status: 'handled', text: 'There is one error.' });
  });

  it('a request that then times out does not send a second cancel', async () => {
    const { client, scheduler, gateway, cancels } = connected();
    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();
    client.cancelAgentRequest('req-1');

    scheduler.advance(AGENT_REQUEST_TIMEOUT_MS);

    await expect(pending).resolves.toMatchObject({ text: BACKEND_REQUEST_TIMED_OUT_TEXT });
    expect(cancels()).toHaveLength(1);
  });

  it('an ordinary timeout still sends its own cancel', async () => {
    const { scheduler, gateway, cancels } = connected();
    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();

    scheduler.advance(AGENT_REQUEST_TIMEOUT_MS);
    await pending;

    expect(cancels()).toEqual([{ version: 1, type: 'cancel', targetId: 'req-1' }]);
  });

  it('only cancels the named request: another in flight is untouched', async () => {
    const { client, gateway, cancels } = connected();
    void gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    void gateway.respond('why is this slow', { requestId: 2, source: 'typed' });
    await flush();

    client.cancelAgentRequest('req-1');

    expect(cancels().map((frame) => frame.targetId)).toEqual(['req-1']);
  });

  it('sends nothing for an unknown or finished request, when disconnected, or when the socket throws', async () => {
    const { client, socket, gateway, cancels } = connected();
    expect(client.cancelAgentRequest('req-99')).toBe(false);

    const pending = gateway.respond('explain this error', { requestId: 1, source: 'typed' });
    await flush();
    socket.throwOnSend = true;
    expect(client.cancelAgentRequest('req-1')).toBe(false); // the frame could not be sent
    socket.throwOnSend = false;
    expect(client.cancelAgentRequest('req-1')).toBe(true); // so a retry is still possible

    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: 'req-1', speech: 'done', action: { type: 'RUN_TESTS' }, confirmationRequired: false,
    });
    await pending;
    expect(client.cancelAgentRequest('req-1')).toBe(false); // finished
    expect(cancels()).toHaveLength(1);

    client.disconnect();
    expect(client.cancelAgentRequest('req-1')).toBe(false);
  });
});
