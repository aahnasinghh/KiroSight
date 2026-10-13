import * as vscode from 'vscode';

import { DEFAULT_BACKEND_URL } from './backendClient';

export const BACKEND_URL_SETTING = 'backendUrl' as const;

/**
 * Reads the raw `kirosight.backendUrl` value. A missing setting yields the documented loopback
 * default. A value of the wrong type becomes an empty string so BackendClient rejects it instead
 * of silently replacing it with another host. The raw value is validated, never rewritten, and
 * never logged here.
 */
export function readBackendUrl(): string {
  const value = vscode.workspace
    .getConfiguration('kirosight')
    .get<unknown>(BACKEND_URL_SETTING, DEFAULT_BACKEND_URL);
  return typeof value === 'string' ? value : '';
}
