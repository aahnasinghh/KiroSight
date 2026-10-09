import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import {
  HELP_TEXT,
  REASONING_NOT_CONNECTED,
  TEST_SUMMARY_UNAVAILABLE,
} from '../../src/pipeline/localIntentHandler';
import { resetVscodeMock, vscodeMockState } from '../mocks/vscode';

const COMMANDS = [
  'kirosight.activate',
  'kirosight.whereAmI',
  'kirosight.describeErrors',
  'kirosight.nextError',
  'kirosight.previousError',
  'kirosight.ask',
] as const;

function activateExtension(): Array<{ dispose(): void }> {
  const subscriptions: Array<{ dispose(): void }> = [];
  activate({ subscriptions } as unknown as Parameters<typeof activate>[0]);
  return subscriptions;
}

async function run(command: (typeof COMMANDS)[number]): Promise<void> {
  const handler = vscodeMockState.registeredCommands.get(command);
  expect(handler).toBeTypeOf('function');
  await handler?.();
}

function lines(): string[] {
  return vscodeMockState.outputChannels[0]!.lines;
}

async function ask(input: string | undefined): Promise<void> {
  vscodeMockState.inputBoxResponses.push(input);
  await run('kirosight.ask');
}

describe('Milestone 3 command wiring', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('registers every existing and new command and disposes them with the extension', () => {
    const subscriptions = activateExtension();

    for (const command of COMMANDS) {
      expect(vscodeMockState.registeredCommands.has(command)).toBe(true);
    }
    expect(subscriptions).toHaveLength(2);

    for (const subscription of subscriptions) subscription.dispose();
    for (const command of COMMANDS) {
      expect(vscodeMockState.registeredCommands.has(command)).toBe(false);
    }
    expect(vscodeMockState.outputChannels[0]!.disposed).toBe(true);
  });

  it('sends the describeErrors, nextError, and previousError handler results to the sink', async () => {
    activateExtension();

    await run('kirosight.describeErrors');
    await run('kirosight.nextError');
    await run('kirosight.previousError');

    expect(lines()).toEqual(['No diagnostics found.', 'No file is open.', 'No file is open.']);
    expect(vscodeMockState.notifications).toEqual(lines());
  });

  it('collects ask input with an input box and sends the handler result to the sink', async () => {
    activateExtension();

    await ask('help');

    expect(vscodeMockState.inputBoxCalls).toEqual([{ prompt: 'Ask KiroSight' }]);
    expect(lines()).toEqual([HELP_TEXT]);
  });

  it('routes ask input through the router and handler for local and placeholder paths', async () => {
    activateExtension();

    await ask('where am i');
    await ask('run tests');
    await ask('summarize the test failures');
    await ask('explain this');
    await ask('go to function foo');

    expect(lines()).toEqual([
      'No file is open.',
      'test running is not available yet',
      TEST_SUMMARY_UNAVAILABLE,
      REASONING_NOT_CONNECTED,
      REASONING_NOT_CONNECTED,
    ]);
  });

  it('does nothing when ask input is cancelled or only whitespace', async () => {
    activateExtension();

    await ask(undefined);
    await ask('');
    await ask('   \t ');

    expect(vscodeMockState.inputBoxCalls).toHaveLength(3);
    expect(lines()).toEqual([]);
    expect(vscodeMockState.notifications).toEqual([]);
  });

  it('constructs services once per activation, not once per command call', async () => {
    activateExtension();

    await run('kirosight.describeErrors');
    await run('kirosight.describeErrors');
    await ask('help');

    expect(vscodeMockState.outputChannels).toHaveLength(1);

    const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');
    for (const constructor of [
      'VscodeEditorAdapter', 'SymbolService', 'DiagnosticsService', 'ContextService',
      'ActionExecutor', 'LocalIntentHandler', 'VscodeResponseSink',
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
