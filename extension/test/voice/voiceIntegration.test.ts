import { describe, expect, it } from 'vitest';

import { BackendClient, DEFAULT_BACKEND_URL } from '../../src/backend/backendClient';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import type { Capabilities } from '../../src/protocol/messages';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import { BackendClipTranscriber, routeTranscriptions } from '../../src/voice/backendClipTranscriber';
import { BackendLocalVoiceInput } from '../../src/voice/backendLocalVoiceInput';
import { VoiceController } from '../../src/voice/voiceController';
import { VoiceSession } from '../../src/voice/voiceSession';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';

const CAPS: Capabilities = { bedrock: false, stt: true, tts: false, mic: 'available' };

const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/**
 * The whole voice stack of Task 8.9 on fakes: a real BackendClient over a fake socket, the real
 * backend-local input, controller, session and InputPipeline. Only the extension wiring (Task 8.13)
 * is missing, and this test does that wiring by hand.
 */
async function build() {
  const factory = new FakeSocketFactory();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler: new FakeScheduler() });
  client.connect();
  factory.last.triggerOpen();
  factory.last.triggerJson({ version: 1, type: 'hello_ack', supportedVersions: [1], capabilities: CAPS });

  const transcript = new TranscriptStore();
  const localIntents: string[] = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: { handleIntent: async (intent) => { localIntents.push(intent.kind); return `did ${intent.kind}`; } },
  });
  const input = new BackendLocalVoiceInput({ client, scheduler: new FakeScheduler() });
  const clips = new BackendClipTranscriber(client);
  const controllerClock = new FakeScheduler();
  const controller = new VoiceController({
    inputs: { backend_local: input },
    transcriber: routeTranscriptions(input, clips),
    pipeline,
    scheduler: controllerClock,
  });
  const session = new VoiceSession({
    controller,
    transcript,
    getCapabilities: () => client.capabilities,
    scheduler: new FakeScheduler(),
  });
  input.onRecordingEnded((end) => session.notifyRecordingEnded(end));
  await session.initialize();
  return { factory, client, transcript, pipeline, localIntents, input, controller, session, controllerClock };
}

const frameTypes = (factory: FakeSocketFactory): unknown[] => factory.last.sentMessages.map((frame) => frame.type);
const systemTexts = (transcript: TranscriptStore): string[] =>
  transcript.getEntries().filter((entry) => entry.role === 'system').map((entry) => entry.text);

describe('voice stack on fakes', () => {
  it('records nothing until the user acts: connecting and initializing never start a recording', async () => {
    const { factory, session } = await build();
    expect(frameTypes(factory)).toEqual(['hello']);
    expect(session.view.listening).toBe(false);
  });

  it('activation opens the panel, listens, and the spoken command takes the typed-command path', async () => {
    const { factory, session, transcript, localIntents } = await build();
    let opened = 0;

    await session.activate(() => { opened += 1; });
    expect(opened).toBe(1);
    expect(frameTypes(factory)).toEqual(['hello', 'record_start']);
    expect(session.view).toMatchObject({ listening: true, statusKind: 'listening' });

    const stopping = session.togglePushToTalk();
    await flush();
    expect(frameTypes(factory)).toEqual(['hello', 'record_start', 'record_stop']);
    factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'where am I' });
    await stopping;

    // The user's query is in the Transcript as spoken text, and it was routed by the ordinary pipeline.
    expect(transcript.getEntries().map((entry) => [entry.role, entry.text, entry.source])).toEqual([
      ['user', 'where am I', 'voice'],
      ['kirosight', 'did WHERE_AM_I', undefined],
    ]);
    expect(localIntents).toEqual(['WHERE_AM_I']);
    expect(session.view).toMatchObject({ listening: false, statusKind: null });
  });

  it('never executes a transcript directly: a spoken action goes through the pipeline like typing', async () => {
    const { factory, session, localIntents } = await build();
    await session.activate(() => undefined);
    const stopping = session.togglePushToTalk();
    await flush();

    factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'open /etc/passwd && rm -rf /' });
    await stopping;

    // The text is not a command the router recognizes, so it is not a local intent and is never run.
    expect(localIntents).toEqual([]);
  });

  it('states a denied microphone at once, keeps typing working, and offers a retry', async () => {
    const { factory, session, pipeline, transcript, localIntents } = await build();
    await session.activate(() => undefined);

    factory.last.triggerJson({
      version: 1, type: 'error_message', replyTo: 'rec-1', code: 'MIC_DENIED', message: 'x', recoverable: true,
    });

    expect(session.view.listening).toBe(false);
    expect(systemTexts(transcript)).toEqual([
      'Voice input could not be processed: microphone permission was denied. You can type the same request.',
    ]);
    await expect(pipeline.handle('where am I', 'typed')).resolves.toBe('handled');
    expect(localIntents).toEqual(['WHERE_AM_I']);

    await session.activate(() => undefined); // access granted later: the next activation tries again
    expect(frameTypes(factory).filter((type) => type === 'record_start')).toHaveLength(2);
    expect(session.view.listening).toBe(true);
  });

  it('routes nothing and says so when speech recognition has no credentials', async () => {
    const { factory, session, transcript, localIntents } = await build();
    await session.activate(() => undefined);

    const stopping = session.togglePushToTalk();
    await flush();
    factory.last.triggerJson({
      version: 1, type: 'error_message', replyTo: 'rec-1', code: 'CREDENTIAL_MISSING', message: 'DEEPGRAM_API_KEY is missing', recoverable: false,
    });
    await stopping;

    expect(localIntents).toEqual([]);
    expect(systemTexts(transcript)).toEqual([
      'Voice input could not be processed: speech recognition is unavailable. You can type the same request.',
    ]);
    expect(JSON.stringify(transcript.getEntries())).not.toContain('DEEPGRAM_API_KEY');
  });

  it('ignores a duplicate reply and a late reply after cancel', async () => {
    const { factory, session, localIntents, controllerClock } = await build();
    await session.activate(() => undefined);
    session.cancel();
    expect(frameTypes(factory).at(-1)).toBe('cancel');

    factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-1', text: 'where am I' });
    await flush();
    expect(localIntents).toEqual([]);

    await session.activate(() => undefined);
    const stopping = session.togglePushToTalk();
    await flush();
    factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-2', text: 'next error' });
    factory.last.triggerJson({ version: 1, type: 'transcription_result', replyTo: 'rec-2', text: 'previous error' });
    await stopping;

    expect(localIntents).toEqual(['ACTION']); // only the first reply for rec-2
    expect(controllerClock.pendingCount).toBe(0);
  });

  it('times out after 10 s with a stated error and recovers', async () => {
    const { factory, session, transcript, controllerClock } = await build();
    await session.activate(() => undefined);
    const stopping = session.togglePushToTalk();
    await flush();

    controllerClock.advance(10_000);
    await stopping;

    expect(systemTexts(transcript)).toEqual([
      'Voice input could not be processed: speech recognition did not answer in time. You can type the same request.',
    ]);
    expect(frameTypes(factory).at(-1)).toBe('cancel'); // the abandoned recording is cancelled at the backend
    expect(session.view.voice.state).toBe('available');
  });

  it('treats a lost backend as unavailable, then recovers when it returns', async () => {
    const { client, session, transcript } = await build();
    await session.activate(() => undefined);

    client.disconnect();
    expect(session.view.listening).toBe(false);
    await session.initialize();
    expect(session.view.voice.state).toBe('unavailable');
    expect(systemTexts(transcript).at(-1)).toContain('backend is not connected');
  });

  it('releases every listener on dispose', async () => {
    const { session, controller, input } = await build();
    await session.activate(() => undefined);

    session.dispose();
    controller.dispose();
    input.dispose();

    expect(session.view).toBeDefined();
  });
});
