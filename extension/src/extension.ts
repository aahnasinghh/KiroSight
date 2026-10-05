import * as vscode from 'vscode';

import { registerCommands } from './commands/registerCommands';

const OUTPUT_CHANNEL_NAME = 'KiroSight';
const ACTIVATION_MESSAGE = 'KiroSight is active.';

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  const commandRegistrations = registerCommands({
    activate: () => {
      outputChannel.appendLine(ACTIVATION_MESSAGE);
      outputChannel.show(true);
    },
  });

  context.subscriptions.push(outputChannel, commandRegistrations);
}
