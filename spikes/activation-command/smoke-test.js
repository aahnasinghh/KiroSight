const assert = require('node:assert/strict');
const Module = require('node:module');
const manifest = require('./package.json');

let registeredCommand;
let registeredHandler;
let shownMessage;
const disposable = { dispose() {} };

const vscodeStub = {
  commands: {
    registerCommand(command, handler) {
      registeredCommand = command;
      registeredHandler = handler;
      return disposable;
    },
  },
  window: {
    showInformationMessage(message) {
      shownMessage = message;
      return Promise.resolve(message);
    },
  },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  return request === 'vscode'
    ? vscodeStub
    : originalLoad.call(this, request, parent, isMain);
};

try {
  const extension = require('./extension');
  const context = { subscriptions: [] };

  assert.equal(manifest.contributes.commands[0].command, 'kirosight.activate');
  assert.equal(manifest.contributes.commands[0].title, 'KiroSight: Activate (Spike)');
  assert.equal(manifest.contributes.keybindings, undefined, 'Spike must first work with no keybinding');

  extension.activate(context);
  assert.equal(registeredCommand, 'kirosight.activate');
  assert.equal(typeof registeredHandler, 'function');
  assert.deepEqual(context.subscriptions, [disposable]);

  registeredHandler();
  assert.equal(shownMessage, 'KiroSight activation spike works.');

  console.log('PASS: kirosight.activate registered and ran with no keybinding.');
  console.log(`PASS: message shown: ${shownMessage}`);
} finally {
  Module._load = originalLoad;
}
