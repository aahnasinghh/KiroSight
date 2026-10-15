/**
 * Task 8.10, Property 11: Typed and voice input take the same path.
 *
 * Validates Requirements 8.1, 8.2, 9.2 and 19.7.
 *
 * For any non-empty text, handling it with source `typed` and with source `voice` (using a fake
 * backend and a fake IDE) yields the same route, the same action or agent request, and the same
 * response text. The two differ only in the `source` tag, which is what tells later stages whether
 * speech output is wanted. The same holds when the voice text comes from the backend-local
 * `VoiceInput` instead of the webview one.
 *
 * Everything between the text and the response is real: `route`, `InputPipeline`,
 * `BackendAgentGateway`, `VoiceController`, `BackendLocalVoiceInput`, `BackendClient` and
 * `BackendClipTranscriber`. Only the edges are fake: the IDE context, the backend's WebSocket, the
 * action handler and the local-intent handler. No microphone, network or provider is involved.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { BackendAgentGateway } from '../../src/backend/agentGateway';
import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import type { LocalIntent, RouteResult } from '../../src/intent/intentTypes';
import { route as defaultRoute } from '../../src/intent/localIntentRouter';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import type { AgentRequest, AgentResponse, Capabilities } from '../../src/protocol/messages';
import { TranscriptStore, type TranscriptSource } from '../../src/transcript/transcriptStore';
import { ok } from '../../src/util/result';
import type { ViewModel } from '../../src/webview/viewModel';
import { BackendClipTranscriber, routeTranscriptions } from '../../src/voice/backendClipTranscriber';
import { BackendLocalVoiceInput } from '../../src/voice/backendLocalVoiceInput';
import { VoiceController } from '../../src/voice/voiceController';
import {
  MAX_VOICE_DURATION_MS,
  type VoiceAvailability,
  type VoiceClip,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const NUM_RUNS = 120;

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
};

// --- the fake IDE and backend ----------------------------------------------------------------------------

const CONTEXT = {
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
} as IDEContext;

/** The backend's answer depends only on the request text, never on how the text arrived. */
function answerFor(request: AgentRequest): AgentResponse {
  const text = request.utterance?.text ?? '';
  return {
    version: 1,
    type: 'agent_response',
    replyTo: request.id,
    speech: `Answer about ${text.length} characters.`,
    action: { type: text.length % 2 === 0 ? 'NO_ACTION' : 'RUN_TESTS' },
    confirmationRequired: false,
  };
}

interface Stack {
  readonly pipeline: InputPipeline;
  /** The source the next `handle` call is about to use; only a deliberately broken router reads it. */
  setSource(source: TranscriptSource): void;
  observe(): Observation;
}

interface Observation {
  readonly localIntents: readonly LocalIntent[];
  /** Requests as the backend saw them, without the `source` tag. */
  readonly agentRequests: readonly unknown[];
  readonly agentSources: readonly (string | undefined)[];
  /** Action types handed to the (fake) action handler: never executed here. */
  readonly actions: readonly string[];
  readonly transcript: ReadonlyArray<readonly [string, string]>;
  readonly userSources: readonly (string | undefined)[];
  readonly statuses: readonly string[];
  readonly latest: string | null;
}

function buildStack(route?: (text: string, source: TranscriptSource) => RouteResult): Stack {
  const transcript = new TranscriptStore();
  const localIntents: LocalIntent[] = [];
  const agentRequests: AgentRequest[] = [];
  const actions: string[] = [];
  const models: ViewModel[] = [];
  let currentSource: TranscriptSource = 'typed';

  const gateway = new BackendAgentGateway({
    client: {
      state: 'connected',
      requestAgent: async (request) => {
        agentRequests.push(request);
        return ok(answerFor(request));
      },
    },
    context: { getContext: async () => CONTEXT },
    actions: {
      handleAgentResponse: async (response) => {
        actions.push(response.action.type);
        return { text: '' };
      },
      interrupted: () => undefined,
    },
  });
  const pipeline = new InputPipeline({
    transcript,
    localIntents: {
      handleIntent: async (intent) => {
        localIntents.push(intent);
        return `Local: ${intent.kind}`;
      },
    },
    agent: gateway,
    ...(route === undefined ? {} : { route: (text: string) => route(text, currentSource) }),
    onViewModel: (model) => models.push(model),
  });

  return {
    pipeline,
    setSource: (source) => { currentSource = source; },
    observe: () => ({
      localIntents,
      agentRequests: agentRequests.map((request) => ({
        ...request,
        utterance: request.utterance === undefined ? undefined : { text: request.utterance.text },
      })),
      agentSources: agentRequests.map((request) => request.utterance?.source),
      actions,
      transcript: transcript.getEntries().map((entry) => [entry.role, entry.text] as const),
      userSources: transcript.getEntries().filter((entry) => entry.role === 'user').map((entry) => entry.source),
      statuses: models.map((model) => model.statusKind),
      latest: models.at(-1)?.latest ?? null,
    }),
  };
}

// --- the ways text can arrive ----------------------------------------------------------------------------------

type Delivery = 'typed' | 'voice_direct' | 'voice_webview' | 'voice_backend_local';

class FakeVoiceInput implements VoiceInput {
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;

  public constructor(public readonly kind: VoiceKind) {}

  public async available(): Promise<VoiceAvailability> {
    return { ok: true };
  }

  public async start(): Promise<void> {}

  public async stop(): Promise<VoiceClip> {
    return new Uint8Array([1, 2, 3]);
  }

  public cancel(): void {}
}

class SpokenText implements VoiceTranscriber {
  public constructor(private readonly text: string) {}

  public async transcribe(): Promise<{ ok: true; text: string }> {
    return { ok: true, text: this.text };
  }
}

const WEBVIEW_CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'not_applicable' };
const LOCAL_CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };

async function viaController(pipeline: InputPipeline, kind: VoiceKind, text: string): Promise<void> {
  if (kind === 'webview') {
    const controller = new VoiceController({
      inputs: { webview: new FakeVoiceInput('webview') },
      transcriber: new SpokenText(text),
      pipeline,
      scheduler: new FakeScheduler(),
      preferred: 'webview',
    });
    await controller.initialize(WEBVIEW_CAPS);
    expect(controller.status.kind).toBe('webview');
    expect(await controller.startListening()).toEqual({ status: 'listening' });
    expect(await controller.stopListening()).toEqual({ status: 'routed' });
    controller.dispose();
    return;
  }

  // The backend-local input over a fake socket: the transcript arrives as a `transcription_result`.
  const factory = new FakeSocketFactory();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
  client.connect();
  factory.last.triggerOpen();
  factory.last.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities: LOCAL_CAPS });
  const input = new BackendLocalVoiceInput({ client, scheduler: new FakeScheduler() });
  const clips = new BackendClipTranscriber(client);
  const controller = new VoiceController({
    inputs: { backend_local: input },
    transcriber: routeTranscriptions(input, clips),
    pipeline,
    scheduler: new FakeScheduler(),
  });
  await controller.initialize(client.capabilities);
  expect(controller.status.kind).toBe('backend_local');
  expect(await controller.startListening()).toEqual({ status: 'listening' });
  const stopping = controller.stopListening();
  await flush();
  factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text });
  expect(await stopping).toEqual({ status: 'routed' });
  controller.dispose();
  input.dispose();
  clips.dispose();
  client.disconnect();
}

async function run(
  delivery: Delivery,
  text: string,
  route?: (text: string, source: TranscriptSource) => RouteResult,
): Promise<Observation> {
  const stack = buildStack(route);
  switch (delivery) {
    case 'typed':
      stack.setSource('typed');
      await stack.pipeline.handle(text, 'typed');
      break;
    case 'voice_direct':
      stack.setSource('voice');
      await stack.pipeline.handle(text, 'voice');
      break;
    case 'voice_webview':
      stack.setSource('voice');
      await viaController(stack.pipeline, 'webview', text);
      break;
    case 'voice_backend_local':
      stack.setSource('voice');
      await viaController(stack.pipeline, 'backend_local', text);
      break;
  }
  return stack.observe();
}

/** The part of an observation that must not depend on how the text arrived. */
function withoutSourceTags(observation: Observation): Omit<Observation, 'userSources' | 'agentSources'> {
  const { userSources: _users, agentSources: _agents, ...rest } = observation;
  void _users;
  void _agents;
  return rest;
}

/** True when `voice` followed the same path as `typed`, differing only in the source tags. */
function samePath(typed: Observation, voice: Observation): boolean {
  return JSON.stringify(withoutSourceTags(typed)) === JSON.stringify(withoutSourceTags(voice))
    && typed.userSources.every((source) => source === 'typed')
    && voice.userSources.every((source) => source === 'voice')
    && typed.agentSources.every((source) => source === 'typed')
    && voice.agentSources.every((source) => source === 'voice')
    && typed.userSources.length === voice.userSources.length
    && typed.agentSources.length === voice.agentSources.length;
}

// --- generators ---------------------------------------------------------------------------------------------------------

/** Real utterances the product handles locally, plus ones that go to the backend. */
const PHRASES = [
  'where am I',
  'what file am I in',
  'what errors are there',
  'next error',
  'previous error',
  'run my tests',
  'list all failures',
  'help',
  'explain this error',
  'why is this function slow',
  'summarize what changed',
  'open auth.ts',
  'confirm',
  'cancel',
] as const;
const LOCAL_COMMANDS = ['where am I', 'what errors are there', 'next error', 'previous error', 'run my tests'] as const;

const textArb: fc.Arbitrary<string> = fc
  .oneof(
    fc.constantFrom(...PHRASES),
    fc.integer({ min: 1, max: 5000 }).map((line) => `go to line ${line}`),
    fc
      .tuple(fc.constantFrom(...PHRASES), fc.constantFrom('', '.', '?', ' please', ' now'), fc.boolean())
      .map(([phrase, suffix, upper]) => (upper ? phrase.toUpperCase() : phrase) + suffix),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 60 }),
    fc.string({ unit: 'binary', minLength: 1, maxLength: 30 }).map((value) => value.replace(/[\ud800-\udfff]/g, '?')),
  )
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

// --- the property ---------------------------------------------------------------------------------------------------------

describe('Property 11: typed and voice input take the same path', () => {
  it('typed and voice text, handled directly, give the same route, request, action and response', async () => {
    const seen = { local: 0, agent: 0, withAction: 0 };
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const typed = await run('typed', text);
        const voice = await run('voice_direct', text);

        expect(samePath(typed, voice)).toBe(true);
        expect(typed.userSources).toEqual(['typed']);
        expect(voice.userSources).toEqual(['voice']);
        expect(voice.agentSources).toEqual(typed.agentSources.map(() => 'voice'));

        // Exactly one route was taken, and it is the router's own decision for this text.
        const decision = defaultRoute(text);
        if (decision.route === 'local') {
          seen.local += 1;
          expect(voice.localIntents).toEqual([decision.intent]);
          expect(voice.agentRequests).toEqual([]);
        } else {
          seen.agent += 1;
          expect(voice.localIntents).toEqual([]);
          expect(voice.agentRequests).toHaveLength(1);
          if (voice.actions.length > 0) seen.withAction += 1;
        }
      }),
      { numRuns: NUM_RUNS },
    );
    // The generator really exercised both routes, and an agent answer that proposes an action.
    expect(seen.local).toBeGreaterThan(0);
    expect(seen.agent).toBeGreaterThan(0);
    expect(seen.withAction).toBeGreaterThan(0);
  });

  it('text from the webview VoiceInput follows the typed path through the VoiceController', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const typed = await run('typed', text);
        const voice = await run('voice_webview', text);

        expect(samePath(typed, voice)).toBe(true);
        expect(voice.userSources).toEqual(['voice']);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('text from the backend-local VoiceInput follows the typed path, and equals the webview result', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, async (text) => {
        const typed = await run('typed', text);
        const webview = await run('voice_webview', text);
        const backendLocal = await run('voice_backend_local', text);

        expect(samePath(typed, backendLocal)).toBe(true);
        // Req 19.7: for identical text, both implementations produce identical results, tags included.
        expect(backendLocal).toEqual(webview);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('spoken text is trimmed once at the edge and then takes the typed path unchanged', async () => {
    const paddingArb = fc.array(fc.constantFrom(' ', '\t', '\n', '\u00a0'), { maxLength: 4 }).map((chars) => chars.join(''));
    await fc.assert(
      fc.asyncProperty(textArb, paddingArb, paddingArb, fc.constantFrom<VoiceKind>('webview', 'backend_local'),
        async (text, before, after, kind) => {
          const typed = await run('typed', text);
          const voice = await run(kind === 'webview' ? 'voice_webview' : 'voice_backend_local', `${before}${text}${after}`);

          expect(samePath(typed, voice)).toBe(true);
        }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is not vacuous: different texts give different observations, and the same text gives the same one', async () => {
    await fc.assert(
      fc.asyncProperty(textArb, textArb, async (first, second) => {
        const a1 = await run('typed', first);
        const a2 = await run('typed', first);
        expect(a2).toEqual(a1); // deterministic

        if (first !== second) {
          const b = await run('typed', second);
          expect(b.transcript).not.toEqual(a1.transcript); // the observation reflects the text
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Property 11: negative controls (the comparison can fail)', () => {
  /** A deliberately broken router: voice never matches a local command, so it goes to the backend. */
  const voiceAlwaysAsksTheAgent = (text: string, source: TranscriptSource): RouteResult =>
    source === 'voice' ? { route: 'agent', reason: 'unrecognized' } : defaultRoute(text);

  it.each(LOCAL_COMMANDS)('detects a router that treats voice differently for "%s"', async (command) => {
    const typed = await run('typed', command, voiceAlwaysAsksTheAgent);
    const voice = await run('voice_direct', command, voiceAlwaysAsksTheAgent);

    expect(typed.localIntents).toHaveLength(1);
    expect(voice.localIntents).toHaveLength(0);
    expect(samePath(typed, voice)).toBe(false);
  });

  it('detects a voice path that alters the text on the way', async () => {
    for (const command of LOCAL_COMMANDS) {
      const typed = await run('typed', command);
      const altered = await run('voice_direct', `zz ${command}`);

      expect(samePath(typed, altered)).toBe(false);
    }
  });

  it('detects a source tag that leaks into the wrong place', async () => {
    const typed = await run('typed', 'explain this error');
    const voice = await run('voice_direct', 'explain this error');
    const mislabelled: Observation = { ...voice, userSources: ['typed'] };

    expect(samePath(typed, voice)).toBe(true);
    expect(samePath(typed, mislabelled)).toBe(false); // a voice entry must be tagged voice
    expect(samePath(typed, typed)).toBe(false); // and two typed runs are not a typed/voice pair
  });

  it('detects a different response, action or request', async () => {
    const typed = await run('typed', 'explain this error');
    const voice = await run('voice_direct', 'explain this error');

    expect(samePath(typed, { ...voice, latest: 'something else' })).toBe(false);
    expect(samePath(typed, { ...voice, actions: [...voice.actions, 'RUN_TESTS'] })).toBe(false);
    expect(samePath(typed, { ...voice, agentRequests: [] })).toBe(false);
  });
});

describe('Property 11: spoken text is only ever data for the pipeline', () => {
  it('a spoken command takes the router, not a direct call: a local phrase reaches the local handler once', async () => {
    const voice = await run('voice_backend_local', 'run my tests');

    // The router's own decision, handed to the (fake) local handler; in real use it asks for confirmation.
    expect(voice.localIntents).toEqual([{ kind: 'ACTION', action: { type: 'RUN_TESTS' } }]);
    expect(voice.agentRequests).toEqual([]);
    expect(voice.actions).toEqual([]);
  });

  it('shell-like speech is never run: it is an ordinary backend request', async () => {
    const text = 'open /etc/passwd && rm -rf /';
    const voice = await run('voice_backend_local', text);

    expect(voice.localIntents).toEqual([]);
    expect(voice.agentRequests).toHaveLength(1);
    expect(voice.transcript[0]).toEqual(['user', text]);
  });
});
