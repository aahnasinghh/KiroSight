import * as vscode from 'vscode';

import { registerCommands } from './commands/registerCommands';
import { ContextService } from './context/contextService';
import { DiagnosticsService } from './context/diagnosticsService';
import { formatWhereAmI } from './context/contextFormatter';
import { VscodeEditorAdapter } from './context/editorAdapter';
import { SymbolService } from './context/symbolService';
import { VscodeResponseSink } from './response/responseSink';

const OUTPUT_CHANNEL_NAME = 'KiroSight';
const ACTIVATION_MESSAGE = 'KiroSight is active.';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const responseSink = new VscodeResponseSink(outputChannel);
  const editorAdapter = new VscodeEditorAdapter();
  const symbolService = new SymbolService(editorAdapter);
  const diagnosticsService = new DiagnosticsService(editorAdapter);
  const contextService = new ContextService(editorAdapter, symbolService, diagnosticsService);

  const commandRegistrations = registerCommands({
    activate: () => {
      responseSink.send(ACTIVATION_MESSAGE);
    },
    whereAmI: async () => {
      const context = await contextService.getContext();
      responseSink.send(formatWhereAmI(context));
    },
  });

  context.subscriptions.push(outputChannel, commandRegistrations);
}
