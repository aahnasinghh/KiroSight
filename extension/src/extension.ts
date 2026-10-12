import * as vscode from 'vscode';

import { ActionExecutor } from './actions/actionExecutor';
import { registerCommands } from './commands/registerCommands';
import { ContextService } from './context/contextService';
import { DiagnosticsService } from './context/diagnosticsService';
import { VscodeEditorAdapter } from './context/editorAdapter';
import { SymbolService } from './context/symbolService';
import { FileService } from './navigation/fileService';
import { NavigationService } from './navigation/navigationService';
import { InputPipeline } from './pipeline/inputPipeline';
import { LocalIntentHandler } from './pipeline/localIntentHandler';
import { TranscriptStore } from './transcript/transcriptStore';
import { createViewModel, type ViewModel } from './webview/viewModel';
import { WebviewProvider } from './webview/webviewProvider';

/** Canonical utterances the existing LocalIntentRouter recognizes for the direct commands. */
const WHERE_AM_I_UTTERANCE = 'where am I';
const DESCRIBE_ERRORS_UTTERANCE = 'what errors are there';
const NEXT_ERROR_UTTERANCE = 'next error';
const PREVIOUS_ERROR_UTTERANCE = 'previous error';

export function activate(context: vscode.ExtensionContext): void {
  const editorAdapter = new VscodeEditorAdapter();
  const symbolService = new SymbolService(editorAdapter);
  const diagnosticsService = new DiagnosticsService(editorAdapter);
  const contextService = new ContextService(editorAdapter, symbolService, diagnosticsService);
  const actionExecutor = new ActionExecutor({
    adapter: editorAdapter,
    diagnostics: diagnosticsService,
    files: new FileService(editorAdapter),
    navigation: new NavigationService(editorAdapter),
  });
  const localIntentHandler = new LocalIntentHandler({
    context: contextService,
    diagnostics: diagnosticsService,
    symbols: symbolService,
    actions: actionExecutor,
  });

  // One transcript and one pipeline serve the webview and every direct command.
  const transcript = new TranscriptStore();
  let currentViewModel: ViewModel = createViewModel({ transcript: transcript.getEntries() });
  let webviewProvider: WebviewProvider | undefined;

  const inputPipeline = new InputPipeline({
    transcript,
    localIntents: localIntentHandler,
    // State changes reach an open panel immediately; a closed panel just keeps the state.
    onViewModel: (model) => {
      currentViewModel = model;
      webviewProvider?.updateViewModel(model);
    },
  });

  webviewProvider = new WebviewProvider({
    extensionUri: context.extensionUri,
    pipeline: inputPipeline,
    transcript,
    // The transcript store is authoritative, so entries added outside the pipeline
    // (such as the voice-unavailable notice) are never missing from a snapshot.
    getViewModel: () => createViewModel({
      statusKind: currentViewModel.statusKind,
      latest: currentViewModel.latest,
      voice: currentViewModel.voice,
      listening: currentViewModel.listening,
      transcript: transcript.getEntries(),
    }),
  });
  const panel = webviewProvider;

  const commandRegistrations = registerCommands({
    activate: () => panel.openOrFocus(),
    ask: () => panel.openOrFocus(),
    whereAmI: async () => { await inputPipeline.handle(WHERE_AM_I_UTTERANCE, 'typed'); },
    describeErrors: async () => { await inputPipeline.handle(DESCRIBE_ERRORS_UTTERANCE, 'typed'); },
    nextError: async () => { await inputPipeline.handle(NEXT_ERROR_UTTERANCE, 'typed'); },
    previousError: async () => { await inputPipeline.handle(PREVIOUS_ERROR_UTTERANCE, 'typed'); },
  });

  context.subscriptions.push(commandRegistrations, panel, editorAdapter);
}
