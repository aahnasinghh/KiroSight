import { randomBytes } from 'node:crypto';

import { DEFAULT_VOICE } from './viewModel';

/**
 * Builds the KiroSight webview document.
 *
 * Pure string building: no vscode import, no script behavior, no network. The
 * input draft belongs to the webview DOM only, so the input is never pre-filled.
 */

export interface WebviewHtmlOptions {
  /** `webview.cspSource` supplied by the provider. */
  readonly cspSource: string;
  /** Webview-safe URI of `media/styles.css`. */
  readonly styleUri: string;
  /** Webview-safe URI of `media/main.js` (created in a later task). */
  readonly scriptUri: string;
  /** Fresh per-load nonce; see generateNonce(). */
  readonly nonce: string;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,}={0,2}$/;

/** A fresh, cryptographically random nonce for each HTML load. */
export function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Escapes text for use in double-quoted attributes and element content. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * `webview.cspSource` is platform-provided and may be a source list such as
 * `'self' https://*.vscode-cdn.net`. Accept one or more tokens separated by
 * single spaces. Reject `;` (directive injection), `,` (policy separator),
 * `"`, `<`, `>`, and any whitespace or control character other than the
 * single separating space (tabs, CR, LF, etc.).
 */
// eslint-disable-next-line no-control-regex
const CSP_TOKEN = '[^\\s;,"<>\\x00-\\x1f\\x7f]+';
const CSP_SOURCE_PATTERN = new RegExp(`^${CSP_TOKEN}(?: ${CSP_TOKEN})*$`);

/** Keywords that must never appear in the final policy. */
const FORBIDDEN_CSP_TOKENS = new Set([
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'unsafe-hashes'",
  "'wasm-unsafe-eval'",
]);

function isValidCspSource(cspSource: string): boolean {
  if (!CSP_SOURCE_PATTERN.test(cspSource)) {
    return false;
  }
  return !cspSource
    .split(' ')
    .some((token) => FORBIDDEN_CSP_TOKENS.has(token.toLowerCase()));
}

/** CSP per the approved design. There is deliberately no connect-src. */
export function buildContentSecurityPolicy(cspSource: string, nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('Invalid webview nonce.');
  }
  if (!isValidCspSource(cspSource)) {
    throw new Error('Invalid webview CSP source.');
  }
  return [
    "default-src 'none'",
    `style-src ${cspSource}`,
    `script-src 'nonce-${nonce}'`,
    'media-src blob: data:',
  ].join('; ') + ';';
}

export function buildWebviewHtml(options: WebviewHtmlOptions): string {
  const csp = buildContentSecurityPolicy(options.cspSource, options.nonce);
  const voiceNote = escapeHtml(DEFAULT_VOICE.reasonText ?? '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KiroSight</title>
  <link rel="stylesheet" href="${escapeHtml(options.styleUri)}">
</head>
<body>
  <main>
    <h1>KiroSight</h1>
    <p id="status" role="status">Status: Idle</p>
    <section aria-labelledby="transcript-heading">
      <h2 id="transcript-heading">Transcript</h2>
      <div id="transcript" role="log" aria-live="polite" aria-labelledby="transcript-heading" tabindex="0"></div>
    </section>
    <section aria-labelledby="latest-heading">
      <h2 id="latest-heading">Latest response</h2>
      <p id="latest"></p>
    </section>
    <section id="confirm" hidden aria-labelledby="confirm-heading">
      <h2 id="confirm-heading">Confirmation required</h2>
      <p id="confirm-prompt" tabindex="-1"></p>
      <button type="button" id="confirm-yes">Confirm</button>
      <button type="button" id="confirm-no">Decline</button>
    </section>
    <form id="cmd">
      <label for="input">Command</label>
      <input id="input" name="command" type="text" autocomplete="off">
      <button type="submit" id="send">Send</button>
    </form>
    <button type="button" id="ptt" aria-pressed="false" aria-disabled="true" aria-describedby="ptt-note">Push to talk</button>
    <p id="ptt-note">${voiceNote}</p>
  </main>
  <script nonce="${options.nonce}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>
`;
}
