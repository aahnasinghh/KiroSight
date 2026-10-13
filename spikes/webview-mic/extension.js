'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

const { buildHtml } = require('./page');
const { CaptureSession } = require('./session');

/**
 * Spike D (Task 8.1): can a Kiro webview capture microphone audio and hand it to the extension
 * host? THROWAWAY. Run "KiroSight: Microphone Capture (Spike D)" from the Command Palette, press
 * the button, allow the microphone, and read the verdict in the "KiroSight Spike D" output channel.
 *
 * The webview talks to the host only through postMessage and has no network access. Nothing is
 * sent anywhere: the recording is written to a temporary file for a person to play back.
 */
function activate(context) {
  const output = vscode.window.createOutputChannel('KiroSight Spike D');
  context.subscriptions.push(output);

  context.subscriptions.push(vscode.commands.registerCommand('kirosight.micSpike', () => {
    const panel = vscode.window.createWebviewPanel(
      'kirosightMicSpike',
      'KiroSight Spike D: microphone',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.webview.html = buildHtml(crypto.randomBytes(16).toString('base64'));

    const session = new CaptureSession();
    panel.webview.onDidReceiveMessage((message) => {
      const result = session.handle(message);
      if (result === null) return;

      let savedTo = null;
      if (result.clip !== null) {
        const directory = path.join(os.tmpdir(), 'kirosight-spike-d');
        fs.mkdirSync(directory, { recursive: true });
        const extension = result.container === 'ogg' ? 'ogg' : result.container === 'mp4' ? 'mp4' : result.container === 'wav' ? 'wav' : 'webm';
        savedTo = path.join(directory, `clip-${Date.now()}.${extension}`);
        fs.writeFileSync(savedTo, result.clip);
      }

      output.appendLine(`Spike D verdict: ${result.verdict}`);
      output.appendLine(`  microphone state: ${result.micState}`);
      output.appendLine(`  container: ${result.container} (${result.mimeType}), ${result.clipBytes} bytes`);
      for (const reason of result.reasons) output.appendLine(`  - ${reason}`);
      if (savedTo !== null) output.appendLine(`  saved to ${savedTo}: play it to confirm the audio is intact.`);
      output.show(true);
      void vscode.window.showInformationMessage(`Spike D: ${result.verdict}. See the KiroSight Spike D output.`);
    }, undefined, context.subscriptions);
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
