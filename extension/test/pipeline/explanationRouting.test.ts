import { describe, expect, it } from 'vitest';

import type { AgentRequest } from '../../src/protocol/messages';
import {
  BACKEND_UNAVAILABLE_TEXT,
  InputPipeline,
  type AgentGateway,
  type AgentGatewayResult,
  type AgentRelayInfo,
  type ExplanationPreparer,
  type PreparedExplanation,
} from '../../src/pipeline/inputPipeline';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ViewModel } from '../../src/webview/viewModel';

const REQUEST: AgentRequest = {
  version: 1, type: 'agent_request', id: 'prepared', kind: 'utterance', utterance: { text: 'explain this error' },
  context: {
    workspace: { name: 'w', rootCount: 1 }, relativePath: 'a.ts', languageId: 'typescript', cursor: null, selection: null,
    nearbyCode: null, currentSymbol: null, symbolStatus: 'none_enclosing', diagnostics: [],
    diagnosticCounts: { error: 0, warning: 0, information: 0, hint: 0 },
  },
};

class FakeGateway implements AgentGateway {
  public readonly calls: Array<{ text: string; info: AgentRelayInfo | undefined }> = [];
  public available = true;
  public reply: AgentGatewayResult = { status: 'handled', text: 'agent answer' };

  public isAvailable(): boolean {
    return this.available;
  }

  public respond(text: string, info?: AgentRelayInfo): Promise<AgentGatewayResult> {
    this.calls.push({ text, info });
    return Promise.resolve(this.reply);
  }
}

class FakeExplainer implements ExplanationPreparer {
  public readonly inputs: Array<Parameters<ExplanationPreparer['build']>[0]> = [];
  public result: PreparedExplanation = { status: 'ready', request: REQUEST };

  public build(input: Parameters<ExplanationPreparer['build']>[0]): Promise<PreparedExplanation> {
    this.inputs.push(input);
    return Promise.resolve(this.result);
  }
}

function build(options: { withExplainer?: boolean } = {}) {
  const gateway = new FakeGateway();
  const explainer = new FakeExplainer();
  const transcript = new TranscriptStore();
  const models: ViewModel[] = [];
  const notices: string[] = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async () => 'local' },
    agent: gateway,
    ...(options.withExplainer === false ? {} : { explainer }),
    onViewModel: (model) => models.push(model),
    onBackendUnavailable: (notice) => notices.push(notice.message),
  });
  const replies = () => transcript.getEntries().filter((entry) => entry.role === 'kirosight').map((entry) => entry.text);
  return { gateway, explainer, transcript, models, notices, pipeline, replies };
}

describe('explanation phrases', () => {
  it.each([
    ['explain this error', 'diagnostic'],
    ['explain this function', 'function'],
    ['explain the selection', 'selection'],
  ] as const)('%s is prepared for the %s target and relayed with the prepared request', async (text, target) => {
    const h = build();

    await expect(h.pipeline.handle(text, 'voice')).resolves.toBe('handled');

    expect(h.explainer.inputs).toEqual([{ target, id: 'prepared', utterance: text, source: 'voice' }]);
    expect(h.gateway.calls).toHaveLength(1);
    expect(h.gateway.calls[0]!.info).toMatchObject({ requestId: 1, source: 'voice', prepared: REQUEST });
    expect(h.replies()).toEqual(['agent answer']);
  });

  it('reports nothing-to-explain locally: no relay, no unavailable notice, answered as handled', async () => {
    const h = build();
    h.explainer.result = { status: 'not_available', message: 'No matching diagnostic was found because no file is open.' };

    await expect(h.pipeline.handle('explain this error', 'typed')).resolves.toBe('handled');

    expect(h.gateway.calls).toEqual([]);
    expect(h.notices).toEqual([]);
    expect(h.replies()).toEqual(['No matching diagnostic was found because no file is open.']);
    expect(h.models.at(-1)).toMatchObject({ latest: 'No matching diagnostic was found because no file is open.', statusKind: 'idle' });
  });

  it('reports nothing-to-explain locally even while the backend is unavailable', async () => {
    const h = build();
    h.gateway.available = false;
    h.explainer.result = { status: 'not_available', message: 'No function or selection is available to explain. No file is open.' };

    await expect(h.pipeline.handle('explain this function', 'typed')).resolves.toBe('handled');

    expect(h.notices).toEqual([]);
    expect(h.replies()).toEqual(['No function or selection is available to explain. No file is open.']);
  });

  it('says the backend cannot be reached when there is something to explain but no backend', async () => {
    const h = build();
    h.gateway.available = false;

    await expect(h.pipeline.handle('explain this error', 'typed')).resolves.toBe('not_handled');

    expect(h.gateway.calls).toEqual([]);
    expect(h.notices).toEqual([BACKEND_UNAVAILABLE_TEXT]);
  });

  it('leaves every other agent-routed text to the gateway, unprepared', async () => {
    const h = build();

    await h.pipeline.handle('tell me about this project', 'typed');
    await h.pipeline.handle('explain this error and fix it', 'typed');

    expect(h.explainer.inputs).toEqual([]);
    expect(h.gateway.calls.map((call) => call.info?.prepared)).toEqual([undefined, undefined]);
  });

  it('behaves as before when no explainer is configured', async () => {
    const h = build({ withExplainer: false });

    await h.pipeline.handle('explain this error', 'typed');

    expect(h.gateway.calls).toHaveLength(1);
    expect(h.gateway.calls[0]!.info).not.toHaveProperty('prepared');
  });

  it('never asks the explainer while a confirmation is pending: the reply is claimed first', async () => {
    const gateway = new FakeGateway();
    const explainer = new FakeExplainer();
    const pipeline = new InputPipeline({
      transcript: new TranscriptStore(),
      localIntents: { handleIntent: async () => 'local' },
      agent: gateway,
      explainer,
      confirmation: {
        isPending: () => true,
        pendingConfirmation: () => ({ promptText: 'Run tests using "npm test"?', presentationKey: 'k' }),
        intercept: async () => ({ intercepted: true, response: 'Run tests is waiting for confirmation.' }),
        confirm: async () => null,
        decline: async () => null,
      },
    });

    await pipeline.handle('explain this error', 'typed');

    expect(explainer.inputs).toEqual([]);
    expect(gateway.calls).toEqual([]);
  });
});

describe('the relay says whether it is still current', () => {
  it('is current until the user interrupts', async () => {
    const h = build();
    let isCurrent: (() => boolean) | undefined;
    h.gateway.respond = (text, info) => {
      isCurrent = info?.isCurrent;
      return Promise.resolve({ status: 'handled', text: 'late answer' });
    };

    const handled = h.pipeline.handle('tell me about this project', 'typed');
    await handled;
    expect(isCurrent?.()).toBe(true);

    h.pipeline.interrupt();
    expect(isCurrent?.()).toBe(false);
  });
});

describe('announce', () => {
  it('adds a response nobody was waiting for to the transcript and refreshes the view', () => {
    const h = build();

    h.pipeline.announce('Focused the editor.');

    expect(h.replies()).toEqual(['Focused the editor.']);
    expect(h.models.at(-1)).toMatchObject({ latest: 'Focused the editor.', statusKind: 'idle' });
  });

  it('ignores blank text', () => {
    const h = build();
    h.pipeline.announce('   ');
    expect(h.replies()).toEqual([]);
    expect(h.models).toEqual([]);
  });

  it('reports a pending confirmation in the status, so it is never announced as idle', () => {
    const transcript = new TranscriptStore();
    const models: ViewModel[] = [];
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async () => 'local' },
      confirmation: {
        isPending: () => true,
        pendingConfirmation: () => ({ promptText: 'Run tests using "npm test"?', presentationKey: 'k' }),
        intercept: async () => ({ intercepted: false }),
        confirm: async () => null,
        decline: async () => null,
      },
      onViewModel: (model) => models.push(model),
    });

    pipeline.announce('Run tests using "npm test"? Reply confirm, decline, cancel, or repeat.');

    expect(models.at(-1)).toMatchObject({ statusKind: 'confirmation_pending' });
    expect(models.at(-1)!.pendingConfirmation?.promptText).toContain('npm test');
  });
});
