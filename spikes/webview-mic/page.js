'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The Spike D webview page. No framework. The CSP allows only this page's one nonce'd script and
 * blob/data media for playback, and no network at all (no connect-src, no default-src).
 * THROWAWAY.
 */
function buildHtml(nonce) {
  const script = fs.readFileSync(path.join(__dirname, 'capture-script.js'), 'utf8');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; media-src blob: data:;">
<title>KiroSight Spike D: microphone capture</title>
</head>
<body>
<h1>KiroSight Spike D: microphone capture</h1>
<p>Press the button, allow the microphone if asked, and speak for four seconds.</p>
<button id="record" type="button">Record 4 seconds</button>
<p id="status" role="status" aria-live="polite">Not recording.</p>
<audio id="playback" controls hidden aria-label="Playback of the recorded clip"></audio>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

module.exports = { buildHtml };
