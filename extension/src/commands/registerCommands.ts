import * as vscode from 'vscode';

export const ACTIVATE_COMMAND = 'kirosight.activate' as const;

export interface CommandHandlers {
  readonly activate: () => void | Promise<void>;
}

export function registerCommands(handlers: CommandHandlers): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(ACTIVATE_COMMAND, handlers.activate),
  );
}
