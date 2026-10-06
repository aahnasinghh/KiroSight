import * as vscode from 'vscode';

export const ACTIVATE_COMMAND = 'kirosight.activate' as const;
export const WHERE_AM_I_COMMAND = 'kirosight.whereAmI' as const;

export interface CommandHandlers {
  readonly activate: () => void | Promise<void>;
  readonly whereAmI: () => void | Promise<void>;
}

export function registerCommands(handlers: CommandHandlers): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(ACTIVATE_COMMAND, handlers.activate),
    vscode.commands.registerCommand(WHERE_AM_I_COMMAND, handlers.whereAmI),
  );
}
