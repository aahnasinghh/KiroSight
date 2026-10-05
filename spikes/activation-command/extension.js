const vscode = require('vscode');

const ACTIVATION_MESSAGE = 'KiroSight activation spike works.';

function activate(context) {
  const disposable = vscode.commands.registerCommand('kirosight.activate', () => {
    void vscode.window.showInformationMessage(ACTIVATION_MESSAGE);
    return ACTIVATION_MESSAGE;
  });

  context.subscriptions.push(disposable);
}

function deactivate() {}

module.exports = { activate, deactivate, ACTIVATION_MESSAGE };
