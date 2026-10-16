import { ActionExecutor } from '../../src/actions/actionExecutor';
import type { Action } from '../../src/actions/actionTypes';
import { BackendAgentGateway } from '../../src/backend/agentGateway';
import { BackendClient, DEFAULT_BACKEND_URL, type BackendLogger } from '../../src/backend/backendClient';
import { ActionGate } from '../../src/confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from '../../src/confirmation/confirmationController';
import { ConfirmationManager } from '../../src/confirmation/confirmationManager';
import { ContextService } from '../../src/context/contextService';
import { DiagnosticsService } from '../../src/context/diagnosticsService';
import type { IDEContext } from '../../src/context/editorAdapter';
import { SymbolService } from '../../src/context/symbolService';
import { FileService } from '../../src/navigation/fileService';
import { NavigationService } from '../../src/navigation/navigationService';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import { LocalIntentHandler } from '../../src/pipeline/localIntentHandler';
import { RequestTracker } from '../../src/pipeline/requestTracker';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { TestRunStore } from '../../src/testing/testRunStore';
import { TranscriptStore, type TranscriptRole, type TranscriptSource } from '../../src/transcript/transcriptStore';
import { SpeechController } from '../../src/voice/speechController';
import { VoiceWiring } from '../../src/voice/voiceWiring';
import { createViewModel, type ViewModel } from '../../src/webview/viewModel';
import { WebviewProvider } from '../../src/webview/webviewProvider';
import { FakeEditorAdapter } from '../context/fakeEditorAdapter';
import { FakeScheduler } from '../mocks/fakeScheduler';
import { FakeSocketFactory } from '../mocks/fakeWebSocket';
import { Uri, resetVscodeMock, setMockConfiguration, setMockWorkspace, vscodeMockState } from '../mocks/vscode';

/**
 * Task 9.6 test harness: the REAL production modules, joined only through their own dependency
 * seams, with fakes at the edges (fake socket, fake clock, mock VS Code webview, fake editor).
 *
 *   InputPipeline -> BackendAgentGateway -> BackendClient -> FakeWebSocket
 *   SpeechController -> BackendClient / WebviewProvider (mock webview)
 *   VoiceWiring -> BackendClient            ConfirmationManager + ActionGate + ActionExecutor
 *
 * What it is NOT: `extension.ts`. Task 9.7 has not connected the controller to the pipeline's
 * response path, so `speakLatest()` below plays that one role in the test, and playback
 * acknowledgments are given to `speech.handlePlayback` directly (the provider still ignores them).
 * Nothing here proves the running extension; it proves the components do the right thing when
 * they are connected this way. No network, microphone, credential or provider is touched.
 */
export const COMMAND = 'npm.cmd test -- --runInBand';
export const RUN_TESTS: Action = { type: 'RUN_TESTS' };
export const AUDIO_BASE64 = 'U0VDUkVUQVVESU9CWVRFUw==';
const TTS_ON = { bedrock: true, stt: true, tts: true, mic: 'available' } as const;

export const flush = async (): Promise<void> => {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
};

/** A Transcript that also writes every append into the shared event log, for order assertions. */
class OrderedTranscript extends TranscriptStore {
  public constructor(private readonly log: string[]) { super(); }

  public override append(role: TranscriptRole, text: string, source?: TranscriptSource) {
    this.log.push(`append:${role}`);
    return super.append(role, text, source);
  }
}

class RecordingLogger implements BackendLogger {
  public readonly lines: string[] = [];
  public debug(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public info(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
  public warn(message: string, metadata?: object): void { this.lines.push(`${message} ${JSON.stringify(metadata ?? {})}`); }
}

function ideContext(): IDEContext {
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

function passedSummary(): TestRunSummary {
  return {
    outcome: 'passed', command: COMMAND, exitCode: 0, passed: 3, failed: 0, totalFailedNames: 0,
    failingTests: [], outputTruncated: false, durationMs: 1,
  };
}

export interface StackOptions {
  readonly tts?: boolean;
  readonly speechOn?: boolean;
}

export async function buildStack(options: StackOptions = {}) {
  resetVscodeMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration({ 'kirosight.testCommand': COMMAND, 'kirosight.testTimeoutSeconds': 5 });

  const events: string[] = [];
  const state = { speechOn: options.speechOn ?? true, testRuns: 0 };
  const transcript = new OrderedTranscript(events);
  const scheduler = new FakeScheduler();
  const logger = new RecordingLogger();
  const tracker = new RequestTracker();
  const models: ViewModel[] = [];

  // --- the backend side: real client over a fake socket ---
  const factory = new FakeSocketFactory();
  const client = new BackendClient({ url: DEFAULT_BACKEND_URL, socketFactory: factory.create, scheduler, logger });
  const sendSpeechRequest = client.sendSpeechRequest.bind(client);
  client.sendSpeechRequest = (request) => { events.push(`speech_request:${request.id}`); return sendSpeechRequest(request); };
  client.connect();
  const socket = factory.last;
  socket.triggerOpen();
  socket.triggerJson({
    version: 1, type: 'hello_ack', supportedVersions: [1],
    capabilities: { ...TTS_ON, tts: options.tts ?? true },
  });

  // --- confirmation and actions: real manager, gate and executor; only the test runner is a double ---
  const adapter = new FakeEditorAdapter({});
  const diagnostics = new DiagnosticsService(adapter);
  const store = new TestRunStore();
  const real = new ActionExecutor({
    adapter, diagnostics, files: new FileService(adapter), navigation: new NavigationService(adapter),
    testRunner: { run: async () => { state.testRuns += 1; return passedSummary(); } },
    testRunStore: store,
  });
  const executed: Action[] = [];
  const executor = { execute: async (action: Action) => { executed.push(action); return real.execute(action); } };
  const manager = new ConfirmationManager(currentTestTarget);
  const gate = new ActionGate({ confirmations: manager, executor });
  const confirmation = new GateConfirmationController(gate, manager);
  const symbols = new SymbolService(adapter);
  const handler = new LocalIntentHandler({
    context: new ContextService(adapter, symbols, diagnostics), diagnostics, symbols,
    actions: executor, gate, testRuns: store,
  });
  const gateway = new BackendAgentGateway({ client, context: { getContext: () => Promise.resolve(ideContext()) } });

  // --- the three components that need each other are closed over lazily ---
  const ref: { speech?: SpeechController; wiring?: VoiceWiring; provider?: WebviewProvider } = {};
  const pipeline = new InputPipeline({
    transcript,
    localIntents: handler,
    agent: gateway,
    confirmation,
    tracker,
    interruption: {
      stopSpeaking: () => ref.speech?.stopSpeaking(),
      cancelVoiceInput: () => ref.wiring?.session.cancel(),
    },
    onViewModel: (model) => { models.push(model); ref.provider?.updateViewModel(model); },
  });
  const provider = new WebviewProvider({
    extensionUri: Uri.file('/ext') as never,
    pipeline,
    transcript,
    getViewModel: () => createViewModel({ transcript: transcript.getEntries() }),
    voice: {
      onMicState: (s) => ref.wiring?.hooks.onMicState(s),
      onAudioClip: (c) => ref.wiring?.hooks.onAudioClip(c),
      onPushToTalkToggle: () => ref.wiring?.hooks.onPushToTalkToggle(),
      onInterrupt: () => ref.wiring?.hooks.onInterrupt(),
    },
    voiceNotice: null,
  });
  ref.provider = provider;
  provider.openOrFocus();
  const panel = vscodeMockState.webviewPanels[0]!;
  const webview = panel.webview as unknown as { postMessage: (message: unknown) => Promise<boolean> };
  const postMessage = webview.postMessage.bind(webview);
  webview.postMessage = (message) => {
    const type = (message as { type?: string }).type;
    if (type === 'play_audio') events.push(`play_audio:${(message as { id: string }).id}`);
    if (type === 'stop_audio') events.push('stop_audio');
    return postMessage(message);
  };

  const speech = new SpeechController({
    client,
    panel: provider,
    transcript,
    isSpeechActive: () => state.speechOn,
    getPendingConfirmation: () => confirmation.pendingConfirmation(),
    onTranscriptChanged: () => provider.updateViewModel(createViewModel({ transcript: transcript.getEntries() })),
    scheduler,
  });
  ref.speech = speech;

  const wiring = new VoiceWiring({
    client,
    transcript,
    pipeline: { handle: (text, source) => pipeline.handle(text, source) },
    panel: {
      get isOpen() { return provider.isOpen; },
      sendCaptureCommand: (type) => provider.sendCaptureCommand(type),
      notifyBackendUnavailable: (kind, message) => provider.notifyBackendUnavailable(kind, message),
    },
    onChange: () => undefined,
    scheduler,
    onBeforeListening: () => pipeline.interrupt(), // exactly what Task 9.7 will pass
  });
  ref.wiring = wiring;
  wiring.panelOpened();
  await flush();

  const frames = (type: string) => socket.sentMessages.filter((m) => m.type === type);
  const kirosight = () => transcript.getEntries().filter((e) => e.role === 'kirosight');
  const notices = () => transcript.getEntries().filter((e) => e.role === 'system' && e.text.startsWith('Spoken playback is unavailable'));
  const posted = () => (panel.webview.posted as Array<{ type: string; id?: string }>);

  return {
    events, state, transcript, scheduler, logger, tracker, models, client, socket, factory,
    confirmation, manager, executed, pipeline, provider, panel, speech, wiring, gateway,
    frames, kirosight, notices, posted,
    /** What Task 9.7's response path will do: hand the newest KiroSight entry to the controller. */
    speakLatest: () => { const entry = kirosight().at(-1); if (entry !== undefined) speech.speakResponse(entry); },
    /** The backend answers speech request `id` with audio. */
    audio: (id: string) => socket.triggerJson({
      version: 1, type: 'speech_audio', replyTo: id, mimeType: 'audio/mpeg', base64: AUDIO_BASE64,
    }),
    /** The backend reports a failure for the request `id`. */
    backendError: (id: string, code: string) => socket.triggerJson({
      version: 1, type: 'error_message', replyTo: id, code, message: 'PROVIDER-DETAIL', recoverable: true,
    }),
    /** The backend answers agent request `id`. */
    agentAnswer: (id: string, speechText: string) => socket.triggerJson({
      version: 1, type: 'agent_response', replyTo: id, speech: speechText, action: { type: 'RUN_TESTS' }, confirmationRequired: false,
    }),
    escape: () => panel.receive({ type: 'interrupt' }),
    submitTyped: (text: string, submitId = 'submit-1') => panel.receive({ type: 'submit_text', submitId, text }),
  };
}

export type Stack = Awaited<ReturnType<typeof buildStack>>;

/** Records unhandled promise rejections between `start()` and `finish()`. */
export function watchUnhandledRejections() {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => { seen.push(reason); };
  return {
    start: () => { seen.length = 0; process.on('unhandledRejection', listener); },
    finish: () => { process.off('unhandledRejection', listener); return seen.slice(); },
  };
}
