import * as vscode from 'vscode';

/**
 * Reads `kirosight.voice.enabled` (default true). Voice is an additive layer: turning it off only
 * removes the microphone path. Typed text, keyboard control and every local feature work either way.
 * Read once when the extension starts, like the backend URL, so reload the window after changing it.
 */
export function readVoiceEnabled(): boolean {
  return vscode.workspace.getConfiguration('kirosight').get<boolean>('voice.enabled', true) !== false;
}
