import * as vscode from 'vscode';

import { ActionExecutor } from './actions/actionExecutor';
import { registerCommands } from './commands/registerCommands';
import { ActionGate } from './confirmation/actionGate';
import { GateConfirmationController, currentTestTarget } from './confirmation/confirmationController';
import { ConfirmationManager } from './confirmation/confirmationManager';
import { ContextService } from './context/contextService';
import { DiagnosticsService } from './context/diagnosticsService';
import { VscodeEditorAdapter } from './context/editorAdapter';
import { SymbolService } from './context/symbolService';
import { FileService } from './navigation/fileService';
import { NavigationService } from './navigation/navigationService';
import { InputPipeline } from './pipeline/inputPipeline';
import { LocalIntentHandler } from './pipeline/localIntentHandler';
import { TestRunStore } from './testing/testRunStore';
import { TestRunner } from './testing/testRunner';
import { TranscriptStore } from './transcript/transcriptStore';
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
}

export function activate(context: vscode.ExtensionContext, overrides: ActivationOverrides = {}): void {
  const editorAdapter = new VscodeEditorAdapter();
  const symbolService = new SymbolService(editorAdapter);
  const diagnosticsService = new DiagnosticsService(editorAdapter);
  const contextService = new ContextService(editorAdapter, symbolService, diagnosticsService);

  // One shared instance of each stateful Milestone 5 object.
  const testRunStore = new TestRunStore();
  const testRunner = overrides.testRunner ?? new TestRunner();
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
  const confirmationController = new GateConfirmationController(actionGate, confirmationManager);
  const localIntentHandler = new LocalIntentHandler({
    context: contextService,
    diagnostics: diagnosticsService,
    symbols: symbolService,
    actions: actionExecutor,
    gate: actionGate,
    testRuns: testRunStore,
  });

  // One transcript and one pipeline serve the webview and every direct command.
  const transcript = new TranscriptStore();
  let currentViewModel: ViewModel = createViewModel({ transcript: transcript.getEntries() });
  let webviewProvider: WebviewProvider | undefined;

  const inputPipeline = new InputPipeline({
    transcript,
    localIntents: localIntentHandler,
    confirmation: confirmationController,
    // State changes reach an open panel immediately; a closed panel just keeps the state.
    onViewModel: (model) => {
      currentViewModel = model;
      webviewProvider?.updateViewModel(model);
    },
  });

  /** Keeps the status label consistent with the live confirmation state. */
  const currentStatusKind = (): ViewModel['statusKind'] => {
    const pending = confirmationController.isPending();
    if (pending && currentViewModel.statusKind === 'idle') return 'confirmation_pending';
    if (!pending && currentViewModel.statusKind === 'confirmation_pending') return 'idle';
    return currentViewModel.statusKind;
  };

  webviewProvider = new WebviewProvider({
    extensionUri: context.extensionUri,
    pipeline: inputPipeline,
    transcript,
    // The transcript store and the ConfirmationManager are authoritative, so a snapshot (for
    // example on ready after the panel was reopened) always shows the live pending prompt.
    getViewModel: () => {
      return createViewModel({
        statusKind: currentStatusKind(),
        latest: currentViewModel.latest,
        pendingConfirmation: confirmationController.pendingConfirmation(),
        voice: currentViewModel.voice,
        listening: currentViewModel.listening,
        transcript: transcript.getEntries(),
      });
    },
  });
  const panel = webviewProvider;

  const commandRegistrations = registerCommands({
    activate: () => panel.openOrFocus(),
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
  });

  context.subscriptions.push(commandRegistrations, panel, editorAdapter, testRunner);
}
