import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { Uri, resetVscodeMock, vscodeMockState } from '../mocks/vscode';

const COMMANDS = [
  'kirosight.activate',
  'kirosight.whereAmI',
  'kirosight.describeErrors',
  'kirosight.nextError',
  'kirosight.previousError',
  'kirosight.ask',
  'kirosight.runTests',
  'kirosight.showTestOutput',
] as const;

function activateExtension(): Array<{ dispose(): void }> {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({ subscriptions, extensionUri: Uri.file('/ext') } as unknown as Parameters<typeof activate>[0]);
  return subscriptions;
}

// Command behavior now runs through the shared InputPipeline; see milestone4Wiring.test.ts.
describe('Milestone 3 command registration (post Milestone 4 wiring)', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('registers every command and disposes them with the extension', () => {
    const subscriptions = activateExtension();

    for (const command of COMMANDS) {
      expect(vscodeMockState.registeredCommands.has(command)).toBe(true);
    }
    expect(subscriptions).toHaveLength(4);

    for (const subscription of subscriptions) subscription.dispose();
    for (const command of COMMANDS) {
      expect(vscodeMockState.registeredCommands.has(command)).toBe(false);
    }
  });

  it('constructs each service once per activation, not once per command call', async () => {
    activateExtension();

    await vscodeMockState.registeredCommands.get('kirosight.describeErrors')?.();
    await vscodeMockState.registeredCommands.get('kirosight.describeErrors')?.();

    const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');
    for (const constructor of [
      'VscodeEditorAdapter', 'SymbolService', 'DiagnosticsService', 'ContextService',
      'ActionExecutor', 'LocalIntentHandler', 'TranscriptStore', 'InputPipeline', 'WebviewProvider',
    ]) {
      expect(source.match(new RegExp(`new ${constructor}\\(`, 'g'))).toHaveLength(1);
    }
  });

  it('introduces no executeCommand path or symbol/command actions in the wiring', () => {
    for (const file of ['extension.ts', 'commands/registerCommands.ts']) {
      const source = readFileSync(resolvePath(__dirname, '../../src', file), 'utf8');
      expect(source).not.toMatch(/executeCommand/);
      expect(source).not.toMatch(/GO_TO_SYMBOL|RUN_COMMAND/);
    }
  });
});
