import * as vscode from 'vscode';

import { BackendAgentGateway } from './backend/agentGateway';
import { BackendClient, validateBackendUrl, type Scheduler, type WebSocketFactory } from './backend/backendClient';
import { readBackendUrl } from './backend/backendConfig';
import { BackendLauncher } from './backend/backendLauncher';
import { formatBackendStatus } from './backend/backendStatus';
import { readBackendToken } from './backend/backendToken';
import { createSetBackendTokenHandler } from './backend/backendTokenCommand';
import { ConnectionManager } from './backend/connectionManager';
import { createGlobalWebSocketFactory } from './backend/webSocketFactory';
import { ActionExecutor } from './actions/actionExecutor';
import { registerCommands } from './commands/registerCommands';
import { ActionGate } from './confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from './confirmation/confirmationController';
import { ConfirmationManager } from './confirmation/confirmationManager';
import { ContextService } from './context/contextService';
import { DiagnosticsService } from './context/diagnosticsService';
import { VscodeEditorAdapter } from './context/editorAdapter';
import { ExplanationRequestBuilder } from './context/explanationRequest';
import { SymbolService } from './context/symbolService';
import { FileService } from './navigation/fileService';
import { NavigationService } from './navigation/navigationService';
import { AgentActionHandler } from './pipeline/agentActionHandler';
import { InputPipeline } from './pipeline/inputPipeline';
import { LocalIntentHandler } from './pipeline/localIntentHandler';
import { TestRunSummarizer } from './pipeline/testRunSummarizer';
import { read as readTestCommand } from './testing/testCommandConfig';
import { TestRunStore } from './testing/testRunStore';
import { TestRunner } from './testing/testRunner';
import { TranscriptStore } from './transcript/transcriptStore';
import { SpeechController } from './voice/speechController';
import { readVoiceEnabled } from './voice/voiceConfig';
import { resolveStatusKind, type VoiceSessionView } from './voice/voiceSession';
import { VOICE_DISABLED_TEXT, VOICE_DISABLED_VIEW, VoiceWiring } from './voice/voiceWiring';
import { createViewModel, type ViewModel } from './webview/viewModel';
import { WebviewProvider } from './webview/webviewProvider';

/** Canonical utterances the existing LocalIntentRouter recognizes for the direct commands. */
const WHERE_AM_I_UTTERANCE = 'where am I';
const DESCRIBE_ERRORS_UTTERANCE = 'what errors are there';
const NEXT_ERROR_UTTERANCE = 'next error';
const PREVIOUS_ERROR_UTTERANCE = 'previous error';
const RUN_TESTS_UTTERANCE = 'run my tests';

/** Test seam only: VS Code calls activate(context) with no second argument. */
export interface ActivationOverrides {
  readonly testRunner?: TestRunner;
  /** Lets tests supply fake sockets; production uses the standard WebSocket global. */
  readonly socketFactory?: WebSocketFactory;
  /** Lets tests drive reconnect and timeout timers without real time. */
  readonly scheduler?: Scheduler;
  /** Lets tests drive the voice timers (10 s start, 10 s speech, 60 s cap, 5 s watchdog) without real time. */
  readonly voiceScheduler?: Scheduler;
}

export function activate(context: vscode.ExtensionContext, overrides: ActivationOverrides = {}): void {
  const editorAdapter = new VscodeEditorAdapter();
  const symbolService = new SymbolService(editorAdapter);
  const diagnosticsService = new DiagnosticsService(editorAdapter);
  const contextService = new ContextService(editorAdapter, symbolService, diagnosticsService);

  // One shared instance of each stateful Milestone 5 object.
  const testRunStore = new TestRunStore();
  const testRunner = overrides.testRunner ?? new TestRunner();
  const backendLauncher = new BackendLauncher();
  const actionExecutor = new ActionExecutor({
    adapter: editorAdapter,
    diagnostics: diagnosticsService,
    files: new FileService(editorAdapter),
    navigation: new NavigationService(editorAdapter),
    testRunner,
    testRunStore,
  });
  const confirmationManager = new ConfirmationManager(currentTestTarget);
  const actionGate = new ActionGate({ confirmations: confirmationManager, executor: actionExecutor });
  // Told how every confirmation ends. An agent-originated one gets its single action_result from
  // the action handler; a failed test run, local or agent, gets its summary. Both are declared
  // below and only called later, when a confirmation actually resolves.
  const confirmationController = new GateConfirmationController(
    actionGate,
    confirmationManager,
    (resolution) => {
      agentActionHandler.onResolution(resolution);
      testRunSummarizer.onResolution(resolution);
    },
  );
  const localIntentHandler = new LocalIntentHandler({
    context: contextService,
    diagnostics: diagnosticsService,
    symbols: symbolService,
    actions: actionExecutor,
    gate: actionGate,
    testRuns: testRunStore,
  });

  // One shared backend stack. Nothing connects here: the socket opens only when the panel opens.
  const backendUrlSetting = readBackendUrl();
  const backendUrlValid = validateBackendUrl(backendUrlSetting).ok;
  const backendClient = new BackendClient({
    url: backendUrlSetting,
    socketFactory: overrides.socketFactory ?? createGlobalWebSocketFactory(),
    scheduler: overrides.scheduler,
  });
  const connectionManager = new ConnectionManager({ client: backendClient, scheduler: overrides.scheduler });
  // Responses nobody is waiting for (a pushed action, a later test summary) join the transcript
  // through the pipeline's own path. Nothing is added once the extension is disposed.
  let disposed = false;
  const pendingSummaryTimers = new Set<ReturnType<typeof setTimeout>>();
  const announce = (text: string): void => {
    if (!disposed) inputPipeline.announce(text);
  };

  // Every action an answer proposes is validated and gated in this handler, which also owns the
  // one action_result. The test command is read from trusted configuration only.
  const agentActionHandler = new AgentActionHandler({
    gate: actionGate,
    sender: backendClient,
    readTestCommand,
    present: announce,
  });
  const testRunSummarizer = new TestRunSummarizer({
    client: backendClient,
    context: contextService,
    // Deferred one turn so the deterministic result text is always shown first.
    present: (text) => {
      const timer = setTimeout(() => {
        pendingSummaryTimers.delete(timer);
        announce(text);
      }, 0);
      pendingSummaryTimers.add(timer);
    },
  });
  const explanationBuilder = new ExplanationRequestBuilder(editorAdapter, symbolService, diagnosticsService);
  const agentGateway = new BackendAgentGateway({
    client: backendClient,
    context: contextService,
    actions: agentActionHandler,
  });

  // The optional token is read from SecretStorage once; it reaches only the next `hello`.
  const tokenLoaded: Promise<void> = readBackendToken(context.secrets).then((token) => {
    backendClient.setToken(token);
  });

  // One transcript and one pipeline serve the webview and every direct command.
  const transcript = new TranscriptStore();
  let currentViewModel: ViewModel = createViewModel({ transcript: transcript.getEntries() });
  let webviewProvider: WebviewProvider | undefined;
  let panelOpen = false;

  // Voice is an additive layer (Req 9.7): when the setting is off nothing here is constructed, the
  // panel says so, and typed text and every local feature work exactly the same.
  const voiceEnabled = readVoiceEnabled();
  let voice: VoiceWiring | undefined;
  // Spoken output follows the same setting: with voice off it is never constructed, so a typed-only
  // session stays silent and sends no speech request at all.
  let speech: SpeechController | undefined;
  /** The voice part of what the panel shows. The pipeline's own view model knows nothing about voice. */
  const voiceView = (): VoiceSessionView => voice?.session.view ?? VOICE_DISABLED_VIEW;

  const backendStatusText = (): string => formatBackendStatus({
    state: connectionManager.state,
    capabilities: backendClient.capabilities,
    urlValid: backendUrlValid,
  });

  /** Adds the live backend connection summary and the voice state to a view model. */
  const withBackendStatus = (model: ViewModel): ViewModel => {
    const view = voiceView();
    return createViewModel({
      statusKind: resolveStatusKind(model.statusKind, view),
      latest: model.latest,
      pendingConfirmation: model.pendingConfirmation,
      voice: view.voice,
      listening: view.listening,
      transcript: model.transcript,
      backendStatus: backendStatusText(),
    });
  };

  const inputPipeline = new InputPipeline({
    transcript,
    localIntents: localIntentHandler,
    confirmation: confirmationController,
    agent: agentGateway,
    explainer: explanationBuilder,
    // Escape, push-to-talk, the stop command and a new utterance all stop spoken output here.
    interruption: {
      stopSpeaking: () => speech?.stopSpeaking(),
      cancelVoiceInput: () => {
        // A typed utterance replaces a recording in progress; an idle voice stack is left alone.
        const phase = voice?.controller.status.phase;
        if (phase === 'listening' || phase === 'processing') voice?.session.cancel();
      },
    },
    // Only an answer to a spoken query is spoken, and only after it is in the Transcript and its
    // view update is delivered. The origin travels with each response from the very submission it
    // answers, so overlapping requests cannot be mixed up. Typed queries, the Confirm and Decline
    // controls and pushed announcements stay text-only. Exactly ONE speech request is made per
    // spoken query: a confirmation prompt, a re-prompt, a repeat and a result all reach the user as
    // the text of the response itself (the confirmation controller and the agent action handler put
    // the stored prompt into that text), so no second request is made for the pending prompt. A
    // second request would be played as a second clip and cut the first one off.
    onResponse: (entry, origin) => {
      if (origin !== 'voice') return;
      speech?.speakResponse(entry);
    },
    // State changes reach an open panel immediately; a closed panel just keeps the state.
    onViewModel: (model) => {
      currentViewModel = model;
      webviewProvider?.updateViewModel(withBackendStatus(model));
    },
    onBackendUnavailable: (notice) => webviewProvider?.notifyBackendUnavailable(notice.kind, notice.message),
  });

  /** Keeps the status label consistent with the live confirmation state. */
  const currentStatusKind = (): ViewModel['statusKind'] => {
    const pending = confirmationController.isPending();
    if (pending && currentViewModel.statusKind === 'idle') return 'confirmation_pending';
    if (!pending && currentViewModel.statusKind === 'confirmation_pending') return 'idle';
    return currentViewModel.statusKind;
  };

  /**
   * The transcript store and the ConfirmationManager are authoritative, so a snapshot (for example
   * on ready after the panel was reopened) always shows the live pending prompt and backend state.
   */
  const currentSnapshot = (): ViewModel => {
    const view = voiceView();
    return createViewModel({
      statusKind: resolveStatusKind(currentStatusKind(), view),
      latest: currentViewModel.latest,
      pendingConfirmation: confirmationController.pendingConfirmation(),
      voice: view.voice,
      listening: view.listening,
      transcript: transcript.getEntries(),
      backendStatus: backendStatusText(),
    });
  };

  if (voiceEnabled) {
    voice = new VoiceWiring({
      client: backendClient,
      transcript,
      // Spoken text takes the same door as typed text: validated, routed and gated like any input.
      pipeline: inputPipeline,
      panel: {
        get isOpen() { return webviewProvider?.isOpen ?? false; },
        sendCaptureCommand: (type) => webviewProvider?.sendCaptureCommand(type) ?? false,
        notifyBackendUnavailable: (kind, message) => webviewProvider?.notifyBackendUnavailable(kind, message),
      },
      // A new Transcript entry, status or listening state reaches an open panel at once.
      onChange: () => webviewProvider?.updateViewModel(currentSnapshot()),
      scheduler: overrides.voiceScheduler,
      // Starting to listen is an interruption: speech stops and older work is superseded first.
      onBeforeListening: () => inputPipeline.interrupt(),
    });

    speech = new SpeechController({
      client: backendClient,
      // The panel is reached through the provider once it exists; until then nothing can be played.
      panel: {
        sendPlayAudio: (audio, onUndelivered) => webviewProvider?.sendPlayAudio(audio, onUndelivered) ?? false,
        sendStopAudio: () => webviewProvider?.sendStopAudio() ?? false,
      },
      transcript,
      isSpeechActive: () => voiceEnabled,
      getPendingConfirmation: () => confirmationController.pendingConfirmation(),
      // The separate "spoken playback is unavailable" entry reaches an open panel at once.
      onTranscriptChanged: () => webviewProvider?.updateViewModel(currentSnapshot()),
      scheduler: overrides.voiceScheduler,
    });
  }

  webviewProvider = new WebviewProvider({
    extensionUri: context.extensionUri,
    pipeline: inputPipeline,
    transcript,
    getViewModel: () => currentSnapshot(),
    ...(voice === undefined ? {} : { voice: voice.hooks }),
    // The panel's playback reports (started, ended, failed) settle the matching speech request.
    ...(speech === undefined ? {} : { speech }),
    voiceNotice: voice === undefined ? VOICE_DISABLED_TEXT : null,
    // The connection follows the panel: it opens with the panel and closes with it. The token is
    // loaded first so the very first handshake already carries it.
    onPanelOpenChange: (open) => {
      panelOpen = open;
      if (open) voice?.panelOpened();
      else {
        voice?.panelClosed(); // before the connection closes, so closing is not reported as a lost backend
        speech?.stopSpeaking(); // closing the panel ends speech quietly: no "unavailable" entry for it
      }
      void tokenLoaded.then(() => connectionManager.setPanelOpen(panelOpen));
    },
  });
  const panel = webviewProvider;

  // A connection state change refreshes the status text of an open panel at once.
  const backendStateSubscription = connectionManager.onStateChange(() => {
    webviewProvider?.updateViewModel(currentSnapshot());
  });

  /** Applies a changed token on the next handshake by intentionally reconnecting an open panel. */
  const applyTokenChange = async (): Promise<void> => {
    await tokenLoaded;
    backendClient.setToken(await readBackendToken(context.secrets));
    if (panelOpen) {
      connectionManager.setPanelOpen(false);
      connectionManager.setPanelOpen(true);
    }
  };

  const commandRegistrations = registerCommands({
    // Voice-aware (Req 18): the panel opens or takes focus first and always; listening begins only
    // when voice is known to be usable. Whatever happens with voice, this never fails.
    activate: () => (voice === undefined ? panel.openOrFocus() : voice.activate(() => panel.openOrFocus())),
    ask: () => panel.openOrFocus(),
    whereAmI: async () => { await inputPipeline.handle(WHERE_AM_I_UTTERANCE, 'typed'); },
    describeErrors: async () => { await inputPipeline.handle(DESCRIBE_ERRORS_UTTERANCE, 'typed'); },
    nextError: async () => { await inputPipeline.handle(NEXT_ERROR_UTTERANCE, 'typed'); },
    previousError: async () => { await inputPipeline.handle(PREVIOUS_ERROR_UTTERANCE, 'typed'); },
    // The panel must be visible so a confirmation prompt can be perceived and answered.
    runTests: async () => {
      panel.openOrFocus();
      await inputPipeline.handle(RUN_TESTS_UTTERANCE, 'typed');
    },
    showTestOutput: () => testRunner.showOutput(),
    startBackend: () => {
      const result = backendLauncher.start();
      void vscode.window.showInformationMessage(result.message);
    },
    // Separate from startBackend: this only updates SecretStorage and the next handshake.
    setBackendToken: createSetBackendTokenHandler({ secrets: context.secrets, applyTokenChange }),
    // The same interruption as Escape: speech stops, older work is superseded and cancelled, and
    // the Transcript and any pending confirmation are left exactly as they were.
    stopSpeaking: () => { inputPipeline.interrupt(); },
  });

  // One listener for actions the backend pushes, registered once for the life of the extension.
  const actionRequestSubscription = agentActionHandler.listen(backendClient);

  context.subscriptions.push(
    commandRegistrations,
    panel,
    editorAdapter,
    testRunner,
    vscode.Disposable.from(
      // First, so the microphone is released before anything else shuts down.
      { dispose: () => voice?.dispose() },
      // Stop whatever is playing before the controller is released; disposing alone sends nothing.
      { dispose: () => { speech?.stopSpeaking(); speech?.dispose(); } },
      connectionManager,
      backendStateSubscription,
      actionRequestSubscription,
      {
        dispose: () => {
          disposed = true;
          for (const timer of pendingSummaryTimers) clearTimeout(timer);
          pendingSummaryTimers.clear();
        },
      },
    ),
  );
}
