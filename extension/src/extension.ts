import * as vscode from 'vscode';

import { ActionExecutor } from './actions/actionExecutor';
import { registerCommands } from './commands/registerCommands';
import { ContextService } from './context/contextService';
import { DiagnosticsService } from './context/diagnosticsService';
import { formatWhereAmI } from './context/contextFormatter';
import { VscodeEditorAdapter } from './context/editorAdapter';
import { SymbolService } from './context/symbolService';
import { route } from './intent/localIntentRouter';
import { FileService } from './navigation/fileService';
import { NavigationService } from './navigation/navigationService';
import { LocalIntentHandler } from './pipeline/localIntentHandler';
import { VscodeResponseSink } from './response/responseSink';

const OUTPUT_CHANNEL_NAME = 'KiroSight';
const ACTIVATION_MESSAGE = 'KiroSight is active.';
const ASK_PROMPT = 'Ask KiroSight';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const responseSink = new VscodeResponseSink(outputChannel);
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

  const commandRegistrations = registerCommands({
    activate: () => {
      responseSink.send(ACTIVATION_MESSAGE);
    },
    whereAmI: async () => {
      const context = await contextService.getContext();
      responseSink.send(formatWhereAmI(context));
    },
    describeErrors: async () => {
      responseSink.send(
        await localIntentHandler.handleIntent({ kind: 'DESCRIBE_DIAGNOSTICS', scope: 'workspace' }),
      );
    },
    nextError: async () => {
      responseSink.send(
        await localIntentHandler.handleIntent({
          kind: 'ACTION',
          action: { type: 'NEXT_DIAGNOSTIC', severity: 'error' },
        }),
      );
    },
    previousError: async () => {
      responseSink.send(
        await localIntentHandler.handleIntent({
          kind: 'ACTION',
          action: { type: 'PREVIOUS_DIAGNOSTIC', severity: 'error' },
        }),
      );
    },
    ask: async () => {
      const text = await vscode.window.showInputBox({ prompt: ASK_PROMPT });
      if (text === undefined || text.trim() === '') {
        return;
      }
      responseSink.send(await localIntentHandler.handle(route(text)));
    },
  });

  context.subscriptions.push(outputChannel, commandRegistrations);
}
