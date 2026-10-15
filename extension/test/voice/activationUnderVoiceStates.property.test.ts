/**
 * Task 8.11, Property 28: Activation never fails because of voice.
 *
 * Validates Requirements 18.1, 18.2, 18.3, 18.4, 18.5 and 18.6.
 *
 * For any combination of VoiceInput implementation (webview, backend-local), microphone state
 * (granted, denied, undetermined, unavailable), speech availability (available, unavailable) and
 * invocation path (command palette, default keybinding, user-assigned keybinding),
 * `kirosight.activate` resolves without error, opens or focuses the panel, leaves typed input
 * usable, and begins listening only when the microphone is known to be granted and speech is
 * available. When the state later becomes granted, the next invocation begins listening without a
 * reload or restart.
 *
 * The three invocation paths all run the same command handler (a keybinding is only a way to call
 * it), so the paths are modelled as the label of the call, and the property checks the outcome does
 * not depend on it. Everything between the command and the microphone is real: `VoiceSession`,
 * `VoiceController`, `InputPipeline` and `TranscriptStore`. Only the microphone (`VoiceInput`) and
 * the speech-to-text client are fakes. Nothing records, uploads or calls a provider.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { InputPipeline } from '../../src/pipeline/inputPipeline';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { VoiceController } from '../../src/voice/voiceController';
import {
  MAX_VOICE_DURATION_MS,
  type TranscriptionOutcome,
  type VoiceAvailability,
  type VoiceClip,
  type VoiceInput,
  type VoiceKind,
  type VoiceTranscriber,
} from '../../src/voice/voiceInput';
import { VoiceSession } from '../../src/voice/voiceSession';
import { FakeScheduler } from '../mocks/fakeScheduler';

const NUM_RUNS = 150;

type Microphone = 'granted' | 'denied' | 'undetermined' | 'unavailable';
type Path = 'command_palette' | 'default_keybinding' | 'user_keybinding';

const KINDS: readonly VoiceKind[] = ['webview', 'backend_local'];
const MICROPHONES: readonly Microphone[] = ['granted', 'denied', 'undetermined', 'unavailable'];
const PATHS: readonly Path[] = ['command_palette', 'default_keybinding', 'user_keybinding'];

interface Environment {
  kind: VoiceKind;
  microphone: Microphone;
  speech: boolean;
}

// --- fakes at the edges ---------------------------------------------------------------------------------------------

class FakeVoiceInput implements VoiceInput {
  public readonly maxDurationMs = MAX_VOICE_DURATION_MS;
  public availability: VoiceAvailability = { ok: true };
  public startCalls = 0;
  public cancelCalls = 0;

  public constructor(public readonly kind: VoiceKind) {}

  public async available(): Promise<VoiceAvailability> {
    return this.availability;
  }

  public async start(): Promise<void> {
    this.startCalls += 1;
  }

  public async stop(): Promise<VoiceClip> {
    return { backendClipId: `clip-${this.startCalls}` };
  }

  public cancel(): void {
    this.cancelCalls += 1;
  }
}

class FakeTranscriber implements VoiceTranscriber {
  public async transcribe(): Promise<TranscriptionOutcome> {
    return { ok: true, text: 'where am I' };
  }
}

/** What the microphone looks like to the implementation, for a given environment. */
function availabilityOf(microphone: Microphone): VoiceAvailability {
  switch (microphone) {
    case 'granted':
      return { ok: true };
    case 'denied':
      return { ok: false, reason: 'denied' };
    case 'undetermined':
      return { ok: false, reason: 'undetermined' };
    case 'unavailable':
      return { ok: false, reason: 'unavailable' };
  }
}

/**
 * The backend's `hello_ack` capabilities. The webview implementation has no backend microphone
 * (`not_applicable`); the backend-local one reports what its default microphone looks like. The
 * backend has no permission prompt, so for it "undetermined" is "not yet confirmed available".
 */
function capabilitiesOf(environment: Environment): Capabilities {
  if (environment.kind === 'webview') {
    return { bedrock: false, stt: environment.speech, tts: false, mic: 'not_applicable' };
  }
  const mic = environment.microphone === 'granted' || environment.microphone === 'undetermined'
    ? 'available'
    : environment.microphone;
  return { bedrock: false, stt: environment.speech, tts: false, mic };
}

/** The oracle: the microphone is known to be granted and speech is available. */
function shouldListen(environment: Environment): boolean {
  return environment.microphone === 'granted' && environment.speech;
}

// --- the stack under test ----------------------------------------------------------------------------------------------

function buildStack(environment: Environment) {
  const input = new FakeVoiceInput(environment.kind);
  input.availability = availabilityOf(environment.microphone);
  const transcript = new TranscriptStore();
  const caps: { value: Capabilities | null } = { value: capabilitiesOf(environment) };
  const handled: string[] = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async (intent) => { handled.push(intent.kind); return `did ${intent.kind}`; } },
  });
  const controller = new VoiceController({
    inputs: { [input.kind]: input },
    transcriber: new FakeTranscriber(),
    pipeline,
    scheduler: new FakeScheduler(),
    preferred: environment.kind,
  });
  const session = new VoiceSession({
    controller,
    transcript,
    getCapabilities: () => caps.value,
    scheduler: new FakeScheduler(),
  });
  return { input, transcript, caps, handled, pipeline, controller, session };
}

type Stack = ReturnType<typeof buildStack>;

/** One invocation of `kirosight.activate`, by whichever path. Returns how many times the panel was opened. */
async function invoke(stack: Stack, _path: Path): Promise<number> {
  let opened = 0;
  await stack.session.activate(() => { opened += 1; });
  return opened;
}

const systemTexts = (stack: Stack): string[] =>
  stack.transcript.getEntries().filter((entry) => entry.role === 'system').map((entry) => entry.text);

/** The user's way out of any state: typing works, and its result is a normal routed response. */
async function typedInputWorks(stack: Stack): Promise<boolean> {
  const before = stack.handled.length;
  const ack = await stack.pipeline.handle('where am I', 'typed');
  return ack === 'handled' && stack.handled.length === before + 1;
}

const environmentArb: fc.Arbitrary<Environment> = fc.record({
  kind: fc.constantFrom(...KINDS),
  microphone: fc.constantFrom(...MICROPHONES),
  speech: fc.boolean(),
});
const pathArb = fc.constantFrom(...PATHS);

// --- the property --------------------------------------------------------------------------------------------------------

describe('Property 28: activation never fails because of voice', () => {
  it('resolves, opens the panel, keeps typing usable, and listens only if the microphone is granted and speech is available', async () => {
    const tally = { listened: 0, notListened: 0 };
    await fc.assert(
      fc.asyncProperty(environmentArb, pathArb, async (environment, path) => {
        const stack = buildStack(environment);
        await stack.session.initialize();

        let opened = -1;
        await expect(
          (async () => { opened = await invoke(stack, path); })(),
        ).resolves.toBeUndefined(); // Req 18.5: no error

        expect(opened).toBe(1); // Req 18.1: the panel is opened or focused, exactly once
        expect(await typedInputWorks(stack)).toBe(true); // Req 18.3/18.4: typing stays usable

        const listening = stack.session.view.listening;
        expect(listening).toBe(shouldListen(environment)); // Req 18.2, and only then
        expect(stack.input.startCalls).toBe(listening ? 1 : 0);

        if (listening) {
          tally.listened += 1;
          // Nothing says voice is unavailable while it works.
          expect(systemTexts(stack)).toEqual([]);
        } else {
          tally.notListened += 1;
          // Never silent (the user story): the Transcript says why, and says typing still works or
          // how to grant permission, without any error being raised.
          const texts = systemTexts(stack);
          expect(texts.length).toBeGreaterThan(0);
          expect(texts.every((text) => text.trim() !== '')).toBe(true);
          const helpful = texts.every((text) => text.includes('keep typing') || text.includes('push-to-talk'));
          expect(helpful).toBe(true);
          expect(stack.session.view.voice.reasonText.trim()).not.toBe('');
        }
      }),
      { numRuns: NUM_RUNS },
    );
    expect(tally.listened).toBeGreaterThan(0);
    expect(tally.notListened).toBeGreaterThan(0);
  });

  it('gives the same outcome whichever way the command is invoked', async () => {
    await fc.assert(
      fc.asyncProperty(environmentArb, async (environment) => {
        const outcomes: unknown[] = [];
        for (const path of PATHS) {
          const stack = buildStack(environment);
          await stack.session.initialize();
          const opened = await invoke(stack, path);
          outcomes.push({
            opened,
            listening: stack.session.view.listening,
            startCalls: stack.input.startCalls,
            transcript: stack.transcript.getEntries().map((entry) => [entry.role, entry.text]),
            view: stack.session.view,
          });
        }

        expect(outcomes[1]).toEqual(outcomes[0]);
        expect(outcomes[2]).toEqual(outcomes[0]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('repeated invocations never fail, never open a second recording, and never drop the panel', async () => {
    await fc.assert(
      fc.asyncProperty(environmentArb, fc.array(pathArb, { minLength: 1, maxLength: 6 }), async (environment, paths) => {
        const stack = buildStack(environment);
        await stack.session.initialize();

        for (const path of paths) {
          expect(await invoke(stack, path)).toBe(1);
          expect(stack.input.startCalls).toBeLessThanOrEqual(1); // already listening: no second capture
        }
        expect(await typedInputWorks(stack)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('listens on the next invocation once the microphone and speech become available, without a restart', async () => {
    let recovered = 0;
    await fc.assert(
      fc.asyncProperty(environmentArb, pathArb, pathArb, async (environment, firstPath, laterPath) => {
        const stack = buildStack(environment);
        await stack.session.initialize();
        await invoke(stack, firstPath);
        const startsBefore = stack.input.startCalls;
        // Whatever happened first (including listening), the user ends it and then fixes the cause.
        stack.session.cancel();

        const granted: Environment = { ...environment, microphone: 'granted', speech: true };
        stack.input.availability = availabilityOf('granted');
        stack.caps.value = capabilitiesOf(granted);
        if (environment.kind === 'webview') {
          // The webview learns "granted" from an earlier capture attempt; the user's permission
          // request (push-to-talk) is that attempt, so a later activation starts from a known state.
          await stack.session.initialize();
        }

        // No reload and no restart: the same session, controller and input objects.
        await invoke(stack, laterPath);

        expect(stack.session.view.listening).toBe(true);
        expect(stack.input.startCalls).toBe(startsBefore + 1);
        recovered += 1;
        expect(await typedInputWorks(stack)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
    expect(recovered).toBeGreaterThan(0);
  });
});

describe('Property 28: negative controls', () => {
  it('a speech-less or microphone-less environment never listens, and the oracle is not vacuous', async () => {
    for (const kind of KINDS) {
      for (const microphone of MICROPHONES) {
        for (const speech of [true, false]) {
          const environment = { kind, microphone, speech };
          const stack = buildStack(environment);
          await stack.session.initialize();
          await invoke(stack, 'command_palette');

          expect(stack.session.view.listening).toBe(shouldListen(environment));
        }
      }
    }
    expect(shouldListen({ kind: 'webview', microphone: 'granted', speech: true })).toBe(true);
    expect(shouldListen({ kind: 'webview', microphone: 'granted', speech: false })).toBe(false);
    expect(shouldListen({ kind: 'webview', microphone: 'undetermined', speech: true })).toBe(false);
  });

  it('a broken voice layer is still not an activation failure, and a broken panel still lets voice run', async () => {
    const stack = buildStack({ kind: 'backend_local', microphone: 'granted', speech: true });
    await stack.session.initialize();
    stack.input.start = async () => { throw new Error('device exploded'); };

    await expect(stack.session.activate(() => undefined)).resolves.toBeUndefined();
    expect(await typedInputWorks(stack)).toBe(true);

    const other = buildStack({ kind: 'backend_local', microphone: 'granted', speech: true });
    await other.session.initialize();
    await expect(other.session.activate(() => { throw new Error('panel failed'); })).resolves.toBeUndefined();
  });

  it('detects an activation that waits for a hanging microphone check before it reports back', async () => {
    const stack = buildStack({ kind: 'backend_local', microphone: 'granted', speech: true });
    await stack.session.initialize();
    let opened = 0;

    const done = stack.session.activate(() => { opened += 1; });

    // The panel is opened synchronously, before any asynchronous voice work.
    expect(opened).toBe(1);
    await done;
  });
});
