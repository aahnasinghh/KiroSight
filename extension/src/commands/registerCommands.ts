import * as vscode from 'vscode';

export const ACTIVATE_COMMAND = 'kirosight.activate' as const;
export const WHERE_AM_I_COMMAND = 'kirosight.whereAmI' as const;
export const DESCRIBE_ERRORS_COMMAND = 'kirosight.describeErrors' as const;
export const NEXT_ERROR_COMMAND = 'kirosight.nextError' as const;
export const PREVIOUS_ERROR_COMMAND = 'kirosight.previousError' as const;
export const ASK_COMMAND = 'kirosight.ask' as const;
export const RUN_TESTS_COMMAND = 'kirosight.runTests' as const;
export const SHOW_TEST_OUTPUT_COMMAND = 'kirosight.showTestOutput' as const;
export const START_BACKEND_COMMAND = 'kirosight.startBackend' as const;
export const SET_BACKEND_TOKEN_COMMAND = 'kirosight.setBackendToken' as const;
export const STOP_SPEAKING_COMMAND = 'kirosight.stopSpeaking' as const;

export interface CommandHandlers {
  readonly activate: () => void | Promise<void>;
  readonly whereAmI: () => void | Promise<void>;
  readonly describeErrors: () => void | Promise<void>;
  readonly nextError: () => void | Promise<void>;
  readonly previousError: () => void | Promise<void>;
  readonly ask: () => void | Promise<void>;
  readonly runTests: () => void | Promise<void>;
  readonly showTestOutput: () => void | Promise<void>;
  readonly startBackend: () => void | Promise<void>;
  readonly setBackendToken: () => void | Promise<void>;
  readonly stopSpeaking: () => void | Promise<void>;
}

export function registerCommands(handlers: CommandHandlers): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand(ACTIVATE_COMMAND, handlers.activate),
    vscode.commands.registerCommand(WHERE_AM_I_COMMAND, handlers.whereAmI),
    vscode.commands.registerCommand(DESCRIBE_ERRORS_COMMAND, handlers.describeErrors),
    vscode.commands.registerCommand(NEXT_ERROR_COMMAND, handlers.nextError),
    vscode.commands.registerCommand(PREVIOUS_ERROR_COMMAND, handlers.previousError),
    vscode.commands.registerCommand(ASK_COMMAND, handlers.ask),
    vscode.commands.registerCommand(RUN_TESTS_COMMAND, handlers.runTests),
    vscode.commands.registerCommand(SHOW_TEST_OUTPUT_COMMAND, handlers.showTestOutput),
    vscode.commands.registerCommand(START_BACKEND_COMMAND, handlers.startBackend),
    vscode.commands.registerCommand(SET_BACKEND_TOKEN_COMMAND, handlers.setBackendToken),
    vscode.commands.registerCommand(STOP_SPEAKING_COMMAND, handlers.stopSpeaking),
  );
}
