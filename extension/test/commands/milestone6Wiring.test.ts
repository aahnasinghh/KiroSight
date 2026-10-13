import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { BACKEND_URL_INVALID_STATUS } from '../../src/backend/backendStatus';
import { BACKEND_UNAVAILABLE_TEXT } from '../../src/pipeline/inputPipeline';
import { activate } from '../../src/extension';
import { TestRunner, type TestProcess } from '../../src/testing/testRunner';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSecrets } from '../mocks/fakeSecrets';
import { FakeSocketFactory, type FakeWebSocket } from '../mocks/fakeWebSocket';
import {
  Uri, resetEditorMock, resetVscodeMock, setMockConfiguration, setMockWorkspace, vscodeMockState,
  type MockWebviewPanel,
} from '../mocks/vscode';

const SENTINEL = 'SUPER_SECRET_BACKEND_TOKEN_123';
const SECOND_SENTINEL = 'SUPER_SECRET_BACKEND_TOKEN_456';
const TOKEN_KEY = 'kirosight.backendToken';
const STUB_STATUS =
  'Backend: connected · Bedrock unavailable · STT unavailable · TTS unavailable · Mic not applicable';

interface ViewState {
  type: string;
  status: string;
  statusKind: string;
  latest: string | null;
  pendingConfirmation?: unknown;
  transcript: Array<{ role: string; text: string }>;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0]!;
const posted = (): Array<Record<string, unknown>> => panel().webview.posted as Array<Record<string, unknown>>;
const viewStates = (): ViewState[] => posted().filter((m) => m.type === 'view_state') as unknown as ViewState[];

const HELLO_ACK = {
  version: 1,
  type: 'hello_ack',
  supportedVersions: [1],
  capabilities: { bedrock: false, stt: false, tts: false, mic: 'not_applicable' },
};

interface BootOptions {
  readonly config?: Record<string, unknown>;
  readonly secrets?: FakeSecrets;
  readonly throwOnCreate?: boolean;
}

/** Real extension graph with a fake socket factory, fake clock and fake secret store only. */
function boot(options: BootOptions = {}) {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration(options.config ?? {});

  const factory = new FakeSocketFactory();
  factory.throwOnCreate = options.throwOnCreate ?? false;
  const scheduler = new FakeScheduler();
  const secrets = options.secrets ?? new FakeSecrets();
  const spawned: string[] = [];
  const testRunner = new TestRunner({
    spawner: (spawnCommand) => {
      spawned.push(spawnCommand);
      throw new Error('no process may ever start in these tests');
    },
    scheduler: { set: () => ({}) as object, clear: () => undefined },
  });
  const subscriptions: Array<{ dispose(): void }> = [];
  activate(
    { subscriptions, extensionUri: Uri.file('/ext'), secrets } as unknown as Parameters<typeof activate>[0],
    { testRunner, socketFactory: factory.create, scheduler },
  );
  return { factory, scheduler, secrets, spawned, subscriptions };
}

/** Opens the panel and waits for the (token-first) connection attempt. */
async function openPanel(): Promise<void> {
  await command('kirosight.activate')();
  await flush();
}

async function connect(factory: FakeSocketFactory): Promise<FakeWebSocket> {
  const socket = factory.last;
  socket.triggerOpen();
  socket.triggerJson(HELLO_ACK);
  await flush();
  return socket;
}

const everythingShown = (): string => JSON.stringify({
  posted: vscodeMockState.webviewPanels.flatMap((p) => p.webview.posted),
  html: vscodeMockState.webviewPanels.map((p) => p.webview.html),
  notifications: vscodeMockState.notifications,
  channels: vscodeMockState.outputChannels.map((channel) => [channel.lines, channel.text]),
});

describe('Task 6.19 lazy backend connection', () => {
  beforeEach(() => resetVscodeMock());

  it('constructs the backend services on activation but opens no socket', async () => {
    const { factory, scheduler, secrets } = boot();
    await flush();

    expect(factory.sockets).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(vscodeMockState.webviewPanels).toHaveLength(0);
    // The optional token is read once at activation.
    expect(secrets.calls).toEqual([{ method: 'get', key: TOKEN_KEY }]);
  });

  it('opens exactly one connection when the panel opens and sends hello with no token by default', async () => {
    const { factory } = boot();

    await openPanel();

    expect(factory.sockets).toHaveLength(1);
    expect(factory.last.url).toBe('ws://127.0.0.1:8765/ws');
    factory.last.triggerOpen();
    expect(factory.last.sentMessages).toHaveLength(1);
    expect(factory.last.sentMessages[0]).toMatchObject({ type: 'hello', version: 1 });
    expect(factory.last.sentMessages[0]).not.toHaveProperty('token');
  });

  it('does not create a second connection when the panel is opened again', async () => {
    const { factory } = boot();

    await openPanel();
    await openPanel();
    await command('kirosight.runTests')();
    await flush();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(factory.sockets).toHaveLength(1);
  });

  it('closes the connection and stops reconnecting when the panel closes', async () => {
    const { factory, scheduler } = boot();
    await openPanel();
    await connect(factory);

    panel().dispose();
    await flush();

    expect(factory.sockets).toHaveLength(1);
    expect(factory.last.closeCalls).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(0);

    scheduler.advance(60_000);
    expect(factory.sockets).toHaveLength(1);

    await openPanel();
    expect(factory.sockets).toHaveLength(2);
  });

  it('closes the connection when the extension is disposed', async () => {
    const { factory, scheduler, subscriptions } = boot();
    await openPanel();
    await connect(factory);

    for (const subscription of subscriptions) subscription.dispose();
    await flush();

    expect(factory.last.closeCalls).toHaveLength(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('keeps local commands working without any panel or connection', async () => {
    const { factory } = boot();

    await command('kirosight.whereAmI')();
    await flush();

    expect(factory.sockets).toHaveLength(0);
  });
});

describe('Task 6.19 status text', () => {
  beforeEach(() => resetVscodeMock());

  it('shows disconnected, connecting and connected with capabilities, then removes stale capabilities', async () => {
    const { factory } = boot();
    await openPanel();
    await panel().receive({ type: 'ready' });
    expect(viewStates().at(-1)!.status).toBe('Idle. Backend: connecting');

    factory.last.triggerOpen();
    factory.last.triggerJson(HELLO_ACK);
    await flush();
    expect(viewStates().at(-1)!.status).toBe(`Idle. ${STUB_STATUS}`);

    factory.last.triggerClose();
    await flush();
    const afterLoss = viewStates().at(-1)!.status;
    expect(afterLoss).toBe('Idle. Backend: disconnected');
    expect(afterLoss).not.toMatch(/Bedrock|STT|TTS|Mic/);
  });

  it('shows incompatible and does not reconnect in a loop', async () => {
    const { factory, scheduler } = boot();
    await openPanel();
    factory.last.triggerOpen();
    factory.last.triggerJson({ ...HELLO_ACK, supportedVersions: [2] });
    await flush();

    expect(viewStates().at(-1)!.status).toBe('Idle. Backend: incompatible protocol version');
    expect(scheduler.pendingCount).toBe(0);
    expect(factory.sockets).toHaveLength(1);
  });

  it('keeps the plain-text status on the full snapshot sent when the panel reports ready', async () => {
    const { factory } = boot();
    await openPanel();
    await connect(factory);

    await panel().receive({ type: 'ready' });

    expect(viewStates().at(-1)!.status).toBe(`Idle. ${STUB_STATUS}`);
  });
});

describe('Task 6.19 backend URL setting', () => {
  beforeEach(() => resetVscodeMock());

  it('passes a valid configured loopback URL to the socket factory', async () => {
    const { factory } = boot({ config: { 'kirosight.backendUrl': 'ws://localhost:9000/ws' } });
    await openPanel();
    expect(factory.last.url).toBe('ws://localhost:9000/ws');
  });

  it.each([
    ['a public host', 'ws://example.com:8765/ws'],
    ['a private address', 'ws://192.168.1.10:8765/ws'],
    ['an unspecified address', 'ws://0.0.0.0:8765/ws'],
    ['a lookalike host', 'ws://localhost.evil.com/ws'],
    ['credentials in the URL', 'ws://user:pass@127.0.0.1:8765/ws'],
    ['a non-WebSocket scheme', 'http://127.0.0.1:8765/ws'],
    ['a malformed URL', 'not a url'],
    ['an empty value', ''],
    ['a non-string value', 8765],
  ])('opens no socket for %s, says so in text, and keeps local commands working', async (_label, value) => {
    const { factory, scheduler } = boot({ config: { 'kirosight.backendUrl': value } });

    await openPanel();
    await panel().receive({ type: 'ready' });

    expect(factory.sockets).toHaveLength(0);
    expect(scheduler.pendingCount).toBe(0);
    expect(viewStates().at(-1)!.status).toBe(`Idle. ${BACKEND_URL_INVALID_STATUS}`);
    expect(JSON.stringify(viewStates())).not.toContain('example.com');
    expect(JSON.stringify(viewStates())).not.toContain('pass');

    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'where am I' });
    expect(posted().at(-1)).toEqual({ type: 'submit_ack', submitId: 's1', status: 'handled' });
  });
});

describe('Task 6.19 real relay through the extension graph', () => {
  beforeEach(() => resetVscodeMock());

  it('relays an agent-routed utterance after the handshake and appends the speech, executing no action', async () => {
    const { factory, spawned } = boot();
    await openPanel();
    const socket = await connect(factory);

    const submitted = panel().receive({ type: 'submit_text', submitId: 's1', text: 'explain this error' });
    await flush();

    const requests = socket.sentMessages.filter((frame) => frame.type === 'agent_request');
    expect(socket.sentMessages.map((frame) => frame.type)).toEqual(['hello', 'agent_request']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      version: 1, kind: 'utterance', id: 'req-1', utterance: { text: 'explain this error', source: 'typed' },
    });

    socket.triggerJson({
      version: 1,
      type: 'agent_response',
      replyTo: requests[0]!.id,
      speech: 'Canned stub answer.',
      action: { type: 'RUN_TESTS' },
      confirmationRequired: false,
    });
    await submitted;
    await flush();

    expect(posted().filter((m) => m.type === 'submit_ack').at(-1))
      .toEqual({ type: 'submit_ack', submitId: 's1', status: 'handled' });
    const last = viewStates().at(-1)!;
    expect(last.latest).toBe('Canned stub answer.');
    expect(last.transcript.filter((entry) => entry.role === 'kirosight').map((entry) => entry.text))
      .toEqual(['Canned stub answer.']);
    // The proposed action is never validated, confirmed or executed in this task.
    expect(last.pendingConfirmation ?? null).toBeNull();
    expect(spawned).toEqual([]);
    expect(everythingShown()).not.toContain('RUN_TESTS');
  });

  it('relays nothing for a local command even when connected', async () => {
    const { factory } = boot();
    await openPanel();
    const socket = await connect(factory);

    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'where am I' });

    expect(socket.sentMessages.map((frame) => frame.type)).toEqual(['hello']);
    expect(posted().at(-1)).toEqual({ type: 'submit_ack', submitId: 's1', status: 'handled' });
  });

  it('reports backend_unavailable and not_handled for agent text while connecting, and still runs local commands', async () => {
    const { factory } = boot();
    await openPanel();

    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'explain this error' });
    await panel().receive({ type: 'submit_text', submitId: 's2', text: 'where am I' });

    const unavailable = posted().filter((m) => m.type === 'backend_unavailable');
    expect(unavailable).toEqual([{ type: 'backend_unavailable', kind: 'text', message: BACKEND_UNAVAILABLE_TEXT }]);
    expect(posted().filter((m) => m.type === 'submit_ack')).toEqual([
      { type: 'submit_ack', submitId: 's1', status: 'not_handled' },
      { type: 'submit_ack', submitId: 's2', status: 'handled' },
    ]);
    // The socket has not even opened yet, so nothing at all (and no agent_request) was sent.
    expect(factory.last.sentMessages).toEqual([]);
  });

  it('does not replay an offline request after the connection comes up', async () => {
    const { factory } = boot();
    await openPanel();
    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'explain this error' });

    const socket = await connect(factory);

    expect(socket.sentMessages.map((frame) => frame.type)).toEqual(['hello']);
  });

  it('survives an unreachable backend: activation, panel and local commands all work', async () => {
    const { factory, scheduler } = boot({ throwOnCreate: true });

    await openPanel();
    await panel().receive({ type: 'ready' });
    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'where am I' });

    expect(factory.sockets).toHaveLength(0);
    expect(viewStates().find((state) => state.status.startsWith('Idle.'))!.status)
      .toMatch(/^Idle\. Backend: (disconnected|connecting)$/);
    expect(posted().at(-1)).toEqual({ type: 'submit_ack', submitId: 's1', status: 'handled' });
    // Reconnect attempts follow the bounded backoff and never throw out of the extension.
    expect(() => scheduler.advance(1_000)).not.toThrow();
  });
});

describe('Task 6.19 backend token', () => {
  beforeEach(() => resetVscodeMock());

  it('sends a stored token only inside hello and nowhere else', async () => {
    const { factory } = boot({ secrets: new FakeSecrets({ [TOKEN_KEY]: SENTINEL }) });
    await openPanel();
    const socket = await connect(factory);
    await panel().receive({ type: 'ready' });
    const submitted = panel().receive({ type: 'submit_text', submitId: 's1', text: 'explain this error' });
    await flush();
    socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: 'req-1', speech: 'ok', action: { type: 'NO_ACTION' },
      confirmationRequired: false,
    });
    await submitted;
    await flush();

    expect(socket.sentMessages[0]).toMatchObject({ type: 'hello', token: SENTINEL });
    const otherFrames = socket.sent.slice(1).join('\n');
    expect(otherFrames).not.toContain(SENTINEL);
    expect(everythingShown()).not.toContain(SENTINEL);
    expect(everythingShown()).not.toContain(TOKEN_KEY);
  });

  it('keeps the token out of status, transcript, errors and notifications when the handshake fails', async () => {
    const { factory } = boot({ secrets: new FakeSecrets({ [TOKEN_KEY]: SENTINEL }) });
    await openPanel();
    factory.last.triggerOpen();
    factory.last.triggerJson({
      version: 1, type: 'error_message', code: 'UNAUTHORIZED', message: 'Not authorized.', recoverable: false,
    });
    await flush();
    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'explain this error' });

    expect(everythingShown()).not.toContain(SENTINEL);
  });

  it('keeps every token and secret-store reference out of the webview-facing sources', () => {
    const root = resolvePath(__dirname, '../..');
    for (const file of [
      'media/main.js', 'media/styles.css', 'src/webview/html.ts', 'src/webview/viewModel.ts',
      'src/webview/webviewProvider.ts', 'src/protocol/bridgeMessages.ts', 'src/transcript/transcriptStore.ts',
      'src/response/responseSink.ts',
    ]) {
      const source = readFileSync(resolvePath(root, file), 'utf8');
      expect(source, file).not.toMatch(/SecretStorage|secrets\.|backendToken|SECRET_KEY|setToken/);
    }
  });

  it('stores a token from the command through a masked input box and applies it on the next handshake', async () => {
    const { factory, secrets } = boot();
    vscodeMockState.inputBoxResponses.push(SECOND_SENTINEL);

    await command('kirosight.setBackendToken')();

    expect(secrets.values.get(TOKEN_KEY)).toBe(SECOND_SENTINEL);
    expect(vscodeMockState.inputBoxCalls).toHaveLength(1);
    expect(vscodeMockState.inputBoxCalls[0]).toMatchObject({ password: true });
    expect(vscodeMockState.inputBoxCalls[0]).not.toHaveProperty('value');
    expect(vscodeMockState.notifications).toEqual(['KiroSight backend token saved.']);
    expect(JSON.stringify(vscodeMockState.notifications)).not.toContain(SECOND_SENTINEL);
    // No panel was open, so there is nothing to reconnect and no socket exists yet.
    expect(factory.sockets).toHaveLength(0);

    await openPanel();
    factory.last.triggerOpen();
    expect(factory.last.sentMessages[0]).toMatchObject({ type: 'hello', token: SECOND_SENTINEL });
  });

  it('reconnects an open panel once so a changed token is used on a new handshake', async () => {
    const { factory } = boot({ secrets: new FakeSecrets({ [TOKEN_KEY]: SENTINEL }) });
    await openPanel();
    const first = await connect(factory);
    vscodeMockState.inputBoxResponses.push(SECOND_SENTINEL);

    await command('kirosight.setBackendToken')();
    await flush();

    expect(first.sentMessages[0]).toMatchObject({ token: SENTINEL });
    expect(first.sent.join('\n')).not.toContain(SECOND_SENTINEL);
    expect(first.closeCalls).toHaveLength(1);
    expect(factory.sockets).toHaveLength(2);
    factory.last.triggerOpen();
    expect(factory.last.sentMessages[0]).toMatchObject({ type: 'hello', token: SECOND_SENTINEL });
    expect(everythingShown()).not.toContain(SECOND_SENTINEL);
    expect(everythingShown()).not.toContain(SENTINEL);
  });

  it('changes nothing when the token prompt is cancelled', async () => {
    const { factory, secrets } = boot({ secrets: new FakeSecrets({ [TOKEN_KEY]: SENTINEL }) });
    await openPanel();
    await connect(factory);
    vscodeMockState.inputBoxResponses.push(undefined);
    const callsBefore = secrets.calls.length;

    await command('kirosight.setBackendToken')();
    await flush();

    expect(secrets.calls).toHaveLength(callsBefore);
    expect(secrets.values.get(TOKEN_KEY)).toBe(SENTINEL);
    expect(factory.sockets).toHaveLength(1);
    expect(factory.last.closeCalls).toHaveLength(0);
    expect(vscodeMockState.notifications).toEqual([]);
  });

  it('clears the token for an empty submission and omits it from the next hello', async () => {
    const { factory, secrets } = boot({ secrets: new FakeSecrets({ [TOKEN_KEY]: SENTINEL }) });
    await openPanel();
    await connect(factory);
    vscodeMockState.inputBoxResponses.push('');

    await command('kirosight.setBackendToken')();
    await flush();

    expect(secrets.values.has(TOKEN_KEY)).toBe(false);
    expect(vscodeMockState.notifications).toEqual(['KiroSight backend token cleared.']);
    expect(factory.sockets).toHaveLength(2);
    factory.last.triggerOpen();
    expect(factory.last.sentMessages[0]).not.toHaveProperty('token');
  });

  it('reports a storage failure without a secret and without reconnecting', async () => {
    const secrets = new FakeSecrets();
    secrets.failStore = true;
    const { factory } = boot({ secrets });
    await openPanel();
    await connect(factory);
    vscodeMockState.inputBoxResponses.push(SENTINEL);

    await command('kirosight.setBackendToken')();
    await flush();

    expect(vscodeMockState.notifications).toEqual(['The KiroSight backend token could not be saved.']);
    expect(everythingShown()).not.toContain(SENTINEL);
    expect(factory.sockets).toHaveLength(1);
  });
});

describe('Task 6.19 composition root', () => {
  const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');

  it('constructs exactly one shared client, manager and gateway and gives the gateway that same client', () => {
    for (const constructor of ['BackendClient', 'ConnectionManager', 'BackendAgentGateway']) {
      expect(source.match(new RegExp(`new ${constructor}\\(`, 'g'))).toHaveLength(1);
    }
    expect(source).toContain('new ConnectionManager({ client: backendClient');
    expect(source).toContain('new BackendAgentGateway({ client: backendClient, context: contextService })');
    expect(source).toContain('agent: agentGateway');
  });

  it('keeps launching a backend process separate from connecting and from the token command', () => {
    expect(source.match(/backendLauncher\.start\(/g)).toHaveLength(1);
    expect(source).toContain('setBackendToken: createSetBackendTokenHandler(');
    const tokenCommand = readFileSync(resolvePath(__dirname, '../../src/backend/backendTokenCommand.ts'), 'utf8');
    expect(tokenCommand).not.toMatch(/BackendLauncher|backendLauncher|spawn|child_process/);
  });

  it('never executes an agent action or touches the raw socket in the composition root', () => {
    expect(source).not.toMatch(/ActionValidator|validateAction|readyState|\.send\(/);
  });
});
