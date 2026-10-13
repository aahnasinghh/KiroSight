import type { InputBoxOptions } from 'vscode';

/**
 * The optional backend handshake token lives only in VS Code SecretStorage under this key. The key
 * is extension-host-only: it never appears in settings, the webview, the view model or the bridge.
 */
export const BACKEND_TOKEN_SECRET_KEY = 'kirosight.backendToken' as const;

export const BACKEND_TOKEN_SAVED_MESSAGE = 'KiroSight backend token saved.';
export const BACKEND_TOKEN_CLEARED_MESSAGE = 'KiroSight backend token cleared.';
export const BACKEND_TOKEN_FAILED_MESSAGE = 'The KiroSight backend token could not be saved.';

/** The subset of `vscode.SecretStorage` used here. */
export interface SecretsLike {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

export type SetBackendTokenOutcome = 'stored' | 'cleared' | 'cancelled' | 'failed';

export const BACKEND_TOKEN_INPUT_OPTIONS: InputBoxOptions = Object.freeze({
  title: 'KiroSight: Set Backend Token',
  prompt: 'Optional shared token for the local KiroSight backend. Leave empty to clear it.',
  password: true,
  ignoreFocusOut: true,
});

/**
 * Reads the stored token. A missing, empty or unreadable secret all mean "no token"; no token is
 * the normal case for a backend without authentication. Never throws and never reports the value.
 */
export async function readBackendToken(secrets: SecretsLike): Promise<string | undefined> {
  try {
    const value = await secrets.get(BACKEND_TOKEN_SECRET_KEY);
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Prompts for the token with a masked input box and updates SecretStorage only. Cancelling changes
 * nothing, an empty submission clears the token (an empty secret is never stored), and any other
 * value is stored exactly as typed. The result names the outcome and never contains the token.
 */
export async function promptForBackendToken(deps: {
  readonly secrets: SecretsLike;
  readonly showInputBox: (options: InputBoxOptions) => PromiseLike<string | undefined>;
}): Promise<SetBackendTokenOutcome> {
  try {
    const value = await deps.showInputBox(BACKEND_TOKEN_INPUT_OPTIONS);
    if (value === undefined) return 'cancelled';
    if (value === '') {
      await deps.secrets.delete(BACKEND_TOKEN_SECRET_KEY);
      return 'cleared';
    }
    await deps.secrets.store(BACKEND_TOKEN_SECRET_KEY, value);
    return 'stored';
  } catch {
    return 'failed';
  }
}
