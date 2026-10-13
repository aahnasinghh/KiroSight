import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKEND_REQUEST_FAILED_TEXT,
  BackendAgentGateway,
} from '../../src/backend/agentGateway';
import type { ConnectionState } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import {
  BACKEND_UNAVAILABLE_TEXT,
  InputPipeline,
  type AgentGateway,
  type AgentGatewayResult,
  type AgentRelayInfo,
  type BackendUnavailableNotice,
  type ConfirmationController,
  type SubmitAckStatus,
} from '../../src/pipeline/inputPipeline';
import type { AgentRequest, AgentResponse } from '../../src/protocol/messages';
import { err, ok } from '../../src/util/result';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ViewModel } from '../../src/webview/viewModel';
import { WebviewProvider } from '../../src/webview/webviewProvider';
import { Uri, resetVscodeMock, vscodeMockState } from '../mocks/vscode';

/** Real router decisions: these are the actual local and agent utterances of the product. */
const LOCAL_UTTERANCES = ['where am I', 'next error', 'previous error', 'run my tests', 'list all failures'];
const AGENT_UTTERANCES = ['explain this error', 'why is this function slow', 'summarize what changed'];

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => { resolveFn = r; });
  return { promise, resolve: resolveFn };
}

class FakeGateway implements AgentGateway {
  public available = true;
  public readonly calls: Array<{ text: string; info: AgentRelayInfo | undefined }> = [];
  public reply: (text: string) => Promise<AgentGatewayResult> =
    (text) => Promise.resolve({ status: 'handled', text: `agent: ${text}` });

  public isAvailable(): boolean {
    return this.available;
  }

  public respond(text: string, info?: AgentRelayInfo): Promise<AgentGatewayResult> {
    this.calls.push({ text, info });
    return this.reply(text);
  }
}

function build(options: {
  gateway?: AgentGateway;
  confirmation?: ConfirmationController;
  interceptor?: { intercept(text: string): Promise<{ intercepted: false } | { intercepted: true; response?: string }> };
} = {}) {
  const gateway = (options.gateway ?? new FakeGateway()) as FakeGateway;
  const transcript = new TranscriptStore();
  const local: string[] = [];
  const notices: BackendUnavailableNotice[] = [];
  const models: ViewModel[] = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async (intent) => { local.push(intent.kind); return `local: ${intent.kind}`; } },
    agent: gateway,
    ...(options.confirmation === undefined ? {} : { confirmation: options.confirmation }),
    ...(options.interceptor === undefined ? {} : { interceptor: options.interceptor }),
    onBackendUnavailable: (notice) => notices.push(notice),
    onViewModel: (model) => models.push(model),
  });
  return { pipeline, gateway, transcript, local, notices, models };
}

const kirosightTexts = (transcript: TranscriptStore): string[] =>
  transcript.getEntries().filter((entry) => entry.role === 'kirosight').map((entry) => entry.text);

describe('local-first relay: locally handled text is never relayed', () => {
  it.each(LOCAL_UTTERANCES)('does not relay "%s", online or offline', async (utterance) => {
    for (const available of [true, false]) {
      const { pipeline, gateway, local, notices } = build();
      gateway.available = available;

      await expect(pipeline.handle(utterance, 'typed')).resolves.toBe('handled');

      expect(gateway.calls).toEqual([]);
      expect(local).toHaveLength(1);
      expect(notices).toEqual([]);
    }
  });

  it('still answers local commands with the backend offline and shows no backend notice', async () => {
    const { pipeline, gateway, transcript, notices } = build();
    gateway.available = false;

    for (const utterance of LOCAL_UTTERANCES) {
      await expect(pipeline.handle(utterance, 'typed')).resolves.toBe('handled');
    }

    expect(gateway.calls).toEqual([]);
    expect(notices).toEqual([]);
    expect(kirosightTexts(transcript)).toHaveLength(LOCAL_UTTERANCES.length);
    expect(kirosightTexts(transcript).join('\n')).not.toContain('backend');
  });

  it('relays only the agent-routed texts when local and agent submissions interleave', async () => {
    const { pipeline, gateway, local } = build();

    const results = await Promise.all([
      pipeline.handle('where am I', 'typed'),
      pipeline.handle(AGENT_UTTERANCES[0]!, 'typed'),
      pipeline.handle('next error', 'typed'),
      pipeline.handle(AGENT_UTTERANCES[1]!, 'typed'),
    ]);

    expect(results).toEqual(['handled', 'handled', 'handled', 'handled']);
    expect(gateway.calls.map((call) => call.text)).toEqual([AGENT_UTTERANCES[0], AGENT_UTTERANCES[1]]);
    expect(local).toHaveLength(2);
  });
});

describe('local-first relay: online agent-routed text', () => {
  it('relays exactly once with the exact text, source and a tracker id, then shows the speech', async () => {
    const { pipeline, gateway, transcript } = build();

    await expect(pipeline.handle('explain this error', 'voice')).resolves.toBe('handled');

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]!.text).toBe('explain this error');
    expect(gateway.calls[0]!.info).toEqual({ requestId: 1, source: 'voice' });
    expect(transcript.getEntries().map(({ role, text }) => [role, text])).toEqual([
      ['user', 'explain this error'],
      ['kirosight', 'agent: explain this error'],
    ]);
  });

  it('gives each submission a unique, increasing request id in arrival order', async () => {
    const { pipeline, gateway } = build();

    await Promise.all(AGENT_UTTERANCES.map((text) => pipeline.handle(text, 'typed')));

    expect(gateway.calls.map((call) => call.text)).toEqual(AGENT_UTTERANCES);
    const ids = gateway.calls.map((call) => call.info!.requestId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hands requests over in arrival order even when an earlier one is slow to be classified', async () => {
    const slowFirst = deferred<void>();
    let intercepts = 0;
    const { pipeline, gateway } = build({
      interceptor: {
        intercept: async () => {
          if (intercepts++ === 0) await slowFirst.promise;
          return { intercepted: false };
        },
      },
    });

    const first = pipeline.handle(AGENT_UTTERANCES[0]!, 'typed');
    const second = pipeline.handle(AGENT_UTTERANCES[1]!, 'typed');
    await flush();
    expect(gateway.calls).toEqual([]);

    slowFirst.resolve();
    await Promise.all([first, second]);

    expect(gateway.calls.map((call) => call.text)).toEqual([AGENT_UTTERANCES[0], AGENT_UTTERANCES[1]]);
  });

  it('does not make the second request wait for the first answer', async () => {
    const { pipeline, gateway } = build();
    const answers: Array<Deferred<AgentGatewayResult>> = [];
    gateway.reply = () => {
      const gate = deferred<AgentGatewayResult>();
      answers.push(gate);
      return gate.promise;
    };

    const first = pipeline.handle(AGENT_UTTERANCES[0]!, 'typed');
    const second = pipeline.handle(AGENT_UTTERANCES[1]!, 'typed');
    await flush();

    expect(gateway.calls).toHaveLength(2);
    answers[1]!.resolve({ status: 'handled', text: 'second answer' });
    answers[0]!.resolve({ status: 'handled', text: 'first answer' });
    await Promise.all([first, second]);
  });

  it('drops a superseded answer so only the latest utterance is shown (latest wins)', async () => {
    const { pipeline, gateway, transcript } = build();
    const answers: Array<Deferred<AgentGatewayResult>> = [];
    gateway.reply = () => {
      const gate = deferred<AgentGatewayResult>();
      answers.push(gate);
      return gate.promise;
    };

    const first = pipeline.handle(AGENT_UTTERANCES[0]!, 'typed');
    const second = pipeline.handle(AGENT_UTTERANCES[1]!, 'typed');
    await flush();
    answers[0]!.resolve({ status: 'handled', text: 'stale answer' });
    answers[1]!.resolve({ status: 'handled', text: 'fresh answer' });
    await Promise.all([first, second]);

    expect(kirosightTexts(transcript)).toEqual(['fresh answer']);
  });

  it('does not hold up a later agent request behind a long-running confirmed action', async () => {
    let pending = true;
    const longConfirm = deferred<{ intercepted: true; response: string }>();
    const confirmation = {
      isPending: () => pending,
      pendingConfirmation: () => null,
      confirm: async () => null,
      decline: async () => null,
      intercept: async (text: string) => {
        if (text === 'confirm') return longConfirm.promise;
        return { intercepted: false as const };
      },
    } satisfies ConfirmationController;
    const { pipeline, gateway } = build({ confirmation });

    const confirming = pipeline.handle('confirm', 'typed');
    pending = false;
    const asking = pipeline.handle('explain this error', 'typed');
    await flush();

    expect(gateway.calls.map((call) => call.text)).toEqual(['explain this error']);
    longConfirm.resolve({ intercepted: true, response: 'Ran the tests.' });
    await Promise.all([confirming, asking]);
    expect(gateway.calls).toHaveLength(1);
  });

  it('relays at most once per submission and never replays after a reconnect', async () => {
    const { pipeline, gateway, notices } = build();
    gateway.available = false;

    await pipeline.handle('explain this error', 'typed');
    gateway.available = true;
    await flush();

    expect(gateway.calls).toEqual([]);
    expect(notices).toHaveLength(1);

    await pipeline.handle('explain this error', 'typed');
    expect(gateway.calls).toHaveLength(1);
  });
});

describe('local-first relay: backend unavailable', () => {
  it('relays nothing, acknowledges not_handled and states which local features still work', async () => {
    const { pipeline, gateway, transcript, notices, models } = build();
    gateway.available = false;

    const status: SubmitAckStatus = await pipeline.handle('explain this error', 'typed');

    expect(status).toBe('not_handled');
    expect(gateway.calls).toEqual([]);
    expect(notices).toEqual([{ kind: 'text', message: BACKEND_UNAVAILABLE_TEXT }]);
    expect(BACKEND_UNAVAILABLE_TEXT).toContain('Local commands');
    for (const feature of ['where am I', 'errors', 'go to line', 'run tests']) {
      expect(BACKEND_UNAVAILABLE_TEXT).toContain(feature);
    }
    expect(transcript.getEntries().map(({ role, text }) => [role, text])).toEqual([
      ['user', 'explain this error'],
      ['kirosight', BACKEND_UNAVAILABLE_TEXT],
    ]);
    expect(models.at(-1)?.statusKind).toBe('error');
  });

  it('reports unavailability immediately, without any timer', async () => {
    vi.useFakeTimers();
    try {
      const { pipeline, gateway, notices } = build();
      gateway.available = false;

      await pipeline.handle('explain this error', 'typed');

      expect(notices).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('relays and forwards the response without any timer delay', async () => {
    vi.useFakeTimers();
    try {
      const { pipeline, gateway, transcript } = build();
      const pending = pipeline.handle('explain this error', 'typed');
      await flush();

      expect(gateway.calls).toHaveLength(1);
      await pending;
      expect(kirosightTexts(transcript)).toEqual(['agent: explain this error']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses stable text with no backend URL, token or raw error detail', () => {
    expect(BACKEND_UNAVAILABLE_TEXT).not.toMatch(/ws:|wss:|127\.0\.0\.1|token|stack|\/|\\/);
  });

  it('also reports unavailable when the gateway itself discovers the loss while relaying', async () => {
    const { pipeline, gateway, notices, transcript } = build();
    gateway.reply = () => Promise.resolve({ status: 'not_handled', text: BACKEND_UNAVAILABLE_TEXT, unavailable: true });

    await expect(pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');

    expect(gateway.calls).toHaveLength(1);
    expect(notices).toEqual([{ kind: 'text', message: BACKEND_UNAVAILABLE_TEXT }]);
    expect(kirosightTexts(transcript)).toEqual([BACKEND_UNAVAILABLE_TEXT]);
  });
});

describe('local-first relay: backend request failure after relay', () => {
  it('shows safe text, keeps the draft (not_handled) and sends no unavailable notice', async () => {
    const { pipeline, gateway, transcript, notices } = build();
    gateway.reply = () => Promise.resolve({ status: 'not_handled', text: BACKEND_REQUEST_FAILED_TEXT });

    await expect(pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');

    expect(notices).toEqual([]);
    expect(kirosightTexts(transcript)).toEqual([BACKEND_REQUEST_FAILED_TEXT]);
  });

  it('treats a gateway that rejects as a generic pipeline failure without leaking detail', async () => {
    const { pipeline, gateway, transcript } = build();
    gateway.reply = () => Promise.reject(new Error('SECRET stack detail'));

    await expect(pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');

    expect(JSON.stringify(transcript.getEntries())).not.toContain('SECRET');
  });
});

describe('local-first relay with the real BackendAgentGateway', () => {
  function wired(state: ConnectionState, answer: () => Promise<unknown>) {
    const requests: AgentRequest[] = [];
    const executed: string[] = [];
    const gateway = new BackendAgentGateway({
      client: {
        get state() { return state; },
        requestAgent: (request) => {
          requests.push(request);
          return answer() as never;
        },
      },
      context: {
        getContext: async () => ({
          workspace: { name: 'sample', rootCount: 1 },
          activeFile: '/abs/private/src/auth.ts',
          relativePath: 'src/auth.ts',
          languageId: 'typescript',
          cursor: null,
          selection: null,
          nearbyCode: null,
          currentSymbol: null,
          symbolStatus: 'none_enclosing',
          diagnostics: [],
          diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
        }) as IDEContext,
      },
    });
    const transcript = new TranscriptStore();
    const notices: BackendUnavailableNotice[] = [];
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async (intent) => { executed.push(intent.kind); return 'local'; } },
      agent: gateway,
      onBackendUnavailable: (notice) => notices.push(notice),
    });
    return { pipeline, requests, executed, transcript, notices };
  }

  const answerWith = (speech: string, action: object) => () => Promise.resolve(ok({
    version: 1, type: 'agent_response', replyTo: 'req-1', speech, action, confirmationRequired: false,
  } as AgentResponse));

  it('appends only the speech and executes nothing when the response carries RUN_TESTS', async () => {
    const { pipeline, requests, executed, transcript } = wired(
      'connected', answerWith('I will run your tests.', { type: 'RUN_TESTS' }),
    );

    await expect(pipeline.handle('explain this error', 'typed')).resolves.toBe('handled');

    expect(requests).toHaveLength(1);
    expect(requests[0]!.utterance).toEqual({ text: 'explain this error', source: 'typed' });
    expect(JSON.stringify(requests[0])).not.toContain('/abs/private');
    expect(executed).toEqual([]);
    expect(kirosightTexts(transcript)).toEqual(['I will run your tests.']);
  });

  it.each(['connecting', 'disconnected', 'incompatible'] as const)(
    'sends nothing and reports unavailable while %s',
    async (state) => {
      const { pipeline, requests, notices } = wired(state, answerWith('x', { type: 'NO_ACTION' }));

      await expect(pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');

      expect(requests).toEqual([]);
      expect(notices).toHaveLength(1);
    },
  );

  it('shows safe failure text when the relayed request later fails', async () => {
    const { pipeline, transcript } = wired(
      'connected', () => Promise.resolve(err({ kind: 'disconnected', message: 'SECRET-RAW ws://127.0.0.1:8765/ws' })),
    );

    await expect(pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');

    expect(kirosightTexts(transcript)).toEqual([BACKEND_REQUEST_FAILED_TEXT]);
    expect(JSON.stringify(transcript.getEntries())).not.toContain('SECRET-RAW');
  });
});

describe('local-first relay through the webview provider', () => {
  beforeEach(() => resetVscodeMock());

  it('posts backend_unavailable, then submit_ack not_handled so the draft stays, and relays nothing', async () => {
    const gateway = new FakeGateway();
    gateway.available = false;
    const transcript = new TranscriptStore();
    let provider: WebviewProvider | undefined;
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async () => 'local' },
      agent: gateway,
      onBackendUnavailable: (notice) => provider?.notifyBackendUnavailable(notice.kind, notice.message),
    });
    provider = new WebviewProvider({
      extensionUri: Uri.file('/ext') as never,
      pipeline,
      transcript,
      getViewModel: () => ({}) as ViewModel,
    });
    provider.openOrFocus();
    const panel = vscodeMockState.webviewPanels[0]!;

    await panel.receive({ type: 'submit_text', submitId: 's1', text: 'explain this error' });

    const posted = panel.webview.posted as Array<{ type: string }>;
    expect(posted).toEqual([
      { type: 'backend_unavailable', kind: 'text', message: BACKEND_UNAVAILABLE_TEXT },
      { type: 'submit_ack', submitId: 's1', status: 'not_handled' },
    ]);
    expect(gateway.calls).toEqual([]);
  });

  it('acknowledges a local command handled and posts no backend notice while offline', async () => {
    const gateway = new FakeGateway();
    gateway.available = false;
    const transcript = new TranscriptStore();
    let provider: WebviewProvider | undefined;
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async () => 'local' },
      agent: gateway,
      onBackendUnavailable: (notice) => provider?.notifyBackendUnavailable(notice.kind, notice.message),
    });
    provider = new WebviewProvider({
      extensionUri: Uri.file('/ext') as never,
      pipeline,
      transcript,
      getViewModel: () => ({}) as ViewModel,
    });
    provider.openOrFocus();
    const panel = vscodeMockState.webviewPanels[0]!;

    await panel.receive({ type: 'submit_text', submitId: 's1', text: 'where am I' });

    expect(panel.webview.posted).toEqual([{ type: 'submit_ack', submitId: 's1', status: 'handled' }]);
    expect(gateway.calls).toEqual([]);
  });
});

describe('local-first relay boundaries', () => {
  const read = (file: string): string => readFileSync(resolve(__dirname, '../../src', file), 'utf8');
  const stripComments = (source: string): string => source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*'))
    .join('\n');

  it('keeps raw sockets, delays and action execution out of the pipeline', () => {
    const code = stripComments(read('pipeline/inputPipeline.ts'));
    expect(code).not.toMatch(/readyState|WebSocket|\.send\(|setTimeout|setInterval/);
    expect(code).not.toMatch(/ActionGate|ActionExecutor|ActionValidator|validateAction/);
    expect(code).not.toMatch(/ConnectionManager|BackendClient|setPanelOpen|\.connect\(/);
  });

  it('leaves the real backend wiring to the composition root (Task 6.19), not the pipeline', () => {
    // Task 6.16 forbade extension.ts from naming these; Task 6.19 owns that wiring now.
    const extension = read('extension.ts');
    expect(extension).toContain('new BackendAgentGateway(');
    expect(stripComments(read('pipeline/inputPipeline.ts'))).not.toMatch(
      /BackendClient|ConnectionManager|BackendAgentGateway/,
    );
  });
});
