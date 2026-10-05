const assert = require('node:assert/strict');
const vscode = require('vscode');

async function run() {
  const result = await vscode.commands.executeCommand('kirosight.activate');
  assert.equal(result, 'KiroSight activation spike works.');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('kirosight.activate'), 'kirosight.activate was not registered after activation');

  console.log('PASS: Kiro extension host registered and ran kirosight.activate with no keybinding.');
}

module.exports = { run };
