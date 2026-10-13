import * as vscode from 'vscode';

import {
  BACKEND_TOKEN_CLEARED_MESSAGE,
  BACKEND_TOKEN_FAILED_MESSAGE,
  BACKEND_TOKEN_SAVED_MESSAGE,
  promptForBackendToken,
  type SecretsLike,
} from './backendToken';

/**
 * Builds the handler for `kirosight.setBackendToken`. It only updates SecretStorage and asks the
 * caller to apply the change on the next handshake. It never launches a backend process, and no
 * message it shows contains the token.
 */
export function createSetBackendTokenHandler(deps: {
  readonly secrets: SecretsLike;
  /** Re-reads the stored token for the next handshake and reconnects an open panel. */
  readonly applyTokenChange: () => Promise<void>;
}): () => Promise<void> {
  return async () => {
    const outcome = await promptForBackendToken({
      secrets: deps.secrets,
      showInputBox: (options) => vscode.window.showInputBox(options),
    });

    if (outcome === 'cancelled') return;
    if (outcome === 'failed') {
      void vscode.window.showInformationMessage(BACKEND_TOKEN_FAILED_MESSAGE);
      return;
    }

    await deps.applyTokenChange();
    void vscode.window.showInformationMessage(
      outcome === 'stored' ? BACKEND_TOKEN_SAVED_MESSAGE : BACKEND_TOKEN_CLEARED_MESSAGE,
    );
  };
}
