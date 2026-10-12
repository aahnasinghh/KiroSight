import * as vscode from 'vscode';

/**
 * Reads only the trusted VS Code setting for the configured test command.
 * Callers cannot supply a setting name, command, workspace or fallback.
 */
export function read(): string {
  const configured = vscode.workspace
    .getConfiguration('kirosight')
    .get<unknown>('testCommand');

  return typeof configured === 'string' ? configured.trim() : '';
}
