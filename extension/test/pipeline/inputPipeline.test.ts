import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LocalIntent, RouteResult } from '../../src/intent/intentTypes';
import {
  InputPipeline,
  PIPELINE_FAILURE_TEXT,
  inertInterceptor,
  reasoningNotConnectedGateway,
  type AgentGateway,
  type PendingConfirmationInterceptor,
} from '../../src/pipeline/inputPipeline';
import { REASONING_NOT_CONNECTED } from '../../src/pipeline/localIntentHandler';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ViewModel } from '../../src/webview/viewModel';

const testDirectory = dirname(fileURLToPath(import.meta.url));

function setup(options: {
  agent?: AgentGateway;
  interceptor?: PendingConfirmationInterceptor;
  route?: (text: string) => RouteResult;
  localResponse?: string | Error;
} = {}) {
  const transcript = new TranscriptStore();
  const calls = { local: [] as LocalIntent[], agent: [] as string[], intercept: [] as string[], route: [] as string[] };
  const models: ViewModel[] = [];

  const pipeline = new InputPipeline({
    transcript,
    localIntents: {
      handleIntent: async (intent) => {
        calls.local.push(intent);
        if (options.localResponse instanceof Error) {
          throw options.localResponse;
        }
        return options.localResponse ?? 'local response';
      },
    },
    agent: options.agent ?? {
      respond: async (text) => {
        calls.agent.push(text);
        return { status: 'handled', text: 'agent response' };
      },
    },
    interceptor: options.interceptor ?? {
      intercept: async (text) => {
        calls.intercept.push(text);
        return { intercepted: false };
      },
    },
    route: (text) => {
      calls.route.push(text);
      return (options.route ?? ((value) => value.startsWith('local')
        ? { route: 'local', intent: { kind: 'HELP' } }
        : { route: 'agent', reason: 'unrecognized' }))(text);
    },
    onViewModel: (model) => models.push(model),
  });

  return { pipeline, transcript, calls, models };
}

describe('InputPipeline', () => {
  it('discards empty and whitespace-only text with no side effects', async () => {
    const { pipeline, transcript, calls, models } = setup();

    for (const text of ['', '   ', '\n\t ']) {
      await expect(pipeline.handle(text, 'typed')).resolves.toBe('discarded');
    }

    expect(transcript.getEntries()).toEqual([]);
    expect(calls).toEqual({ local: [], agent: [], intercept: [], route: [] });
    expect(models).toEqual([]);
  });

  it('appends the exact user text and source for typed and voice input', async () => {
    const { pipeline, transcript } = setup();

    await pipeline.handle('  local typed  ', 'typed');
    await pipeline.handle('local spoken', 'voice');

    const users = transcript.getEntries().filter((entry) => entry.role === 'user');
    expect(users).toEqual([
      { seq: 1, role: 'user', text: '  local typed  ', source: 'typed' },
      { seq: 3, role: 'user', text: 'local spoken', source: 'voice' },
    ]);
  });

  it('runs a local route through the local handler only, then appends the response', async () => {
    const { pipeline, transcript, calls } = setup();

    await expect(pipeline.handle('local please', 'typed')).resolves.toBe('handled');

    expect(calls.local).toEqual([{ kind: 'HELP' }]);
    expect(calls.agent).toEqual([]);
    expect(transcript.getEntries().map(({ role, text }) => [role, text])).toEqual([
      ['user', 'local please'],
      ['kirosight', 'local response'],
    ]);
  });

  it('sends an agent route to the gateway only, then appends the response', async () => {
    const { pipeline, transcript, calls } = setup();

    await expect(pipeline.handle('explain this', 'typed')).resolves.toBe('handled');

    expect(calls.agent).toEqual(['explain this']);
    expect(calls.local).toEqual([]);
    expect(transcript.getEntries().map(({ role, text }) => [role, text])).toEqual([
      ['user', 'explain this'],
      ['kirosight', 'agent response'],
    ]);
  });

  it('uses the offline stub that reports reasoning is not connected', async () => {
    const { pipeline, transcript } = setup({ agent: reasoningNotConnectedGateway });

    await expect(pipeline.handle('explain this', 'typed')).resolves.toBe('not_handled');

    expect(REASONING_NOT_CONNECTED).toBe('Reasoning is not connected yet.');
    expect(transcript.getEntries().at(-1)).toMatchObject({
      role: 'kirosight',
      text: REASONING_NOT_CONNECTED,
    });
  });

  it('acknowledges with the gateway status and never a fourth status', async () => {
    const notHandled = setup({ agent: { respond: async () => ({ status: 'not_handled', text: 'offline' }) } });

    await expect(notHandled.pipeline.handle('explain', 'typed')).resolves.toBe('not_handled');
    await expect(notHandled.pipeline.handle('local x', 'typed')).resolves.toBe('handled');
    await expect(notHandled.pipeline.handle('  ', 'typed')).resolves.toBe('discarded');
  });

  it('keeps routing identical for typed and voice input', async () => {
    const typed = setup();
    const voice = setup();

    await typed.pipeline.handle('local same', 'typed');
    await typed.pipeline.handle('other same', 'typed');
    await voice.pipeline.handle('local same', 'voice');
    await voice.pipeline.handle('other same', 'voice');

    expect(voice.calls).toEqual(typed.calls);
    expect(voice.transcript.getEntries().map(({ role, text }) => [role, text])).toEqual(
      typed.transcript.getEntries().map(({ role, text }) => [role, text]),
    );
  });

  it('progresses idle to processing to idle with the latest response in fresh view models', async () => {
    const { pipeline, models } = setup();

    await pipeline.handle('local go', 'typed');

    expect(models.map((model) => model.statusKind)).toEqual(['processing', 'idle']);
    expect(models[0].latest).toBeNull();
    expect(models[1]).toMatchObject({ status: 'Idle', latest: 'local response', listening: false });
    expect(models[1].transcript.map((entry) => entry.role)).toEqual(['user', 'kirosight']);
    expect(models[0]).not.toBe(models[1]);
    expect(Object.isFrozen(models[1])).toBe(true);
  });

  it('reports an error status for a not-handled agent result', async () => {
    const { pipeline, models } = setup({ agent: reasoningNotConnectedGateway });

    await pipeline.handle('explain', 'typed');

    expect(models.map((model) => model.statusKind)).toEqual(['processing', 'error']);
    expect(models[1].latest).toBe(REASONING_NOT_CONNECTED);
  });

  it('turns handler failures into bounded text without leaking the error', async () => {
    const { pipeline, transcript, models } = setup({ localResponse: new Error('secret stack detail') });

    await expect(pipeline.handle('local boom', 'typed')).resolves.toBe('not_handled');

    expect(transcript.getEntries().at(-1)).toMatchObject({ role: 'kirosight', text: PIPELINE_FAILURE_TEXT });
    expect(JSON.stringify(transcript.getEntries())).not.toContain('secret stack detail');
    expect(models.at(-1)?.statusKind).toBe('error');
  });

  it('turns gateway failures into bounded text', async () => {
    const { pipeline, transcript } = setup({
      agent: { respond: async () => { throw new Error('network detail'); } },
    });

    await expect(pipeline.handle('explain', 'typed')).resolves.toBe('not_handled');

    expect(transcript.getEntries().at(-1)?.text).toBe(PIPELINE_FAILURE_TEXT);
  });

  it('checks the interceptor after the user entry and before routing, inert by default', async () => {
    const order: string[] = [];
    const transcript = new TranscriptStore();
    const pipeline = new InputPipeline({
      transcript,
      localIntents: { handleIntent: async () => 'local response' },
      interceptor: {
        intercept: async () => {
          order.push(`intercept after ${transcript.getEntries().length} entries`);
          return { intercepted: false };
        },
      },
      route: (text) => {
        order.push('route');
        return { route: 'local', intent: { kind: 'HELP' } };
      },
    });

    await pipeline.handle('anything', 'typed');

    expect(order).toEqual(['intercept after 1 entries', 'route']);
    await expect(inertInterceptor.intercept('yes')).resolves.toEqual({ intercepted: false });
  });

  it('stops before routing when the interceptor claims the text', async () => {
    const { pipeline, transcript, calls } = setup({
      interceptor: { intercept: async () => ({ intercepted: true, response: 'waiting for confirmation' }) },
    });

    await expect(pipeline.handle('confirm', 'voice')).resolves.toBe('handled');

    expect(calls.route).toEqual([]);
    expect(calls.local).toEqual([]);
    expect(calls.agent).toEqual([]);
    expect(transcript.getEntries().map((entry) => entry.text)).toEqual(['confirm', 'waiting for confirmation']);
  });

  it('keeps confirm, decline and interrupt safe before any confirmation exists', async () => {
    const { pipeline, transcript, calls } = setup();

    await expect(pipeline.confirm()).resolves.toBeUndefined();
    await expect(pipeline.decline()).resolves.toBeUndefined();
    expect(() => pipeline.interrupt()).not.toThrow();

    expect(transcript.getEntries()).toEqual([]);
    expect(calls).toEqual({ local: [], agent: [], intercept: [], route: [] });
  });

  it('drops an agent reply that was interrupted while in flight', async () => {
    let release: (() => void) | undefined;
    const { pipeline, transcript, models } = setup({
      agent: {
        respond: () => new Promise((resolveResponse) => {
          release = () => resolveResponse({ status: 'handled', text: 'late reply' });
        }),
      },
    });

    const pending = pipeline.handle('explain', 'typed');
    await Promise.resolve();
    await Promise.resolve();
    pipeline.interrupt();
    release?.();
    await pending;

    expect(transcript.getEntries().map((entry) => entry.text)).toEqual(['explain']);
    expect(models.at(-1)?.statusKind).toBe('idle');
  });

  it('keeps user entries before their responses across sequential calls', async () => {
    const { pipeline, transcript } = setup();

    await pipeline.handle('local one', 'typed');
    await pipeline.handle('explain two', 'voice');

    expect(transcript.getEntries().map((entry) => [entry.seq, entry.role])).toEqual([
      [1, 'user'], [2, 'kirosight'], [3, 'user'], [4, 'kirosight'],
    ]);
  });

  it('routes real utterances with the default router, identically for both sources', async () => {
    const make = () => {
      const intents: LocalIntent[] = [];
      const agent: string[] = [];
      const pipeline = new InputPipeline({
        transcript: new TranscriptStore(),
        localIntents: { handleIntent: async (intent) => { intents.push(intent); return 'ok'; } },
        agent: { respond: async (text) => { agent.push(text); return { status: 'handled', text: 'ok' }; } },
      });
      return { pipeline, intents, agent };
    };
    const typed = make();
    const voice = make();

    for (const [pipeline, source] of [[typed.pipeline, 'typed'], [voice.pipeline, 'voice']] as const) {
      await pipeline.handle('where am I', source);
      await pipeline.handle('explain this error', source);
    }

    expect(typed.intents).toEqual([{ kind: 'WHERE_AM_I' }]);
    expect(voice.intents).toEqual(typed.intents);
    expect(voice.agent).toEqual(typed.agent);
    expect(typed.agent).toEqual(['explain this error']);
  });

  it('has no vscode, network, time, or randomness dependency', () => {
    for (const file of ['inputPipeline.ts', 'requestTracker.ts']) {
      const source = readFileSync(resolve(testDirectory, '../../src/pipeline', file), 'utf8');

      expect(source).not.toMatch(/from ['"]vscode['"]|WebSocket|fetch\(|process\.env|Date\.now|Math\.random|postMessage/);
    }
  });
});
