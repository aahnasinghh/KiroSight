import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { activate } from '../../src/extension';
import { TestRunner, type TestProcess } from '../../src/testing/testRunner';
import { fakeBackendOverrides } from '../mocks/backendOverrides';
import {
  Uri, resetEditorMock, resetVscodeMock, setMockConfiguration, setMockWorkspace, vscodeMockState,
  type MockWebviewPanel,
} from '../mocks/vscode';

class Child extends EventEmitter {
  public readonly stdout = new EventEmitter();
  public readonly stderr = new EventEmitter();
  public constructor(public readonly pid = 4242) { super(); }
  public finish(code: number): void { this.emit('exit', code, null); this.emit('close', code, null); }
}

interface ViewState {
  type: string;
  statusKind: string;
  latest: string | null;
  pendingConfirmation?: { promptText: string; presentationKey: string } | null;
  transcript: Array<{ role: string; text: string }>;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const command = (name: string) => vscodeMockState.registeredCommands.get(name)!;
const panel = (): MockWebviewPanel => vscodeMockState.webviewPanels[0]!;
const viewStates = (): ViewState[] =>
  panel().webview.posted.filter((m) => (m as { type: string }).type === 'view_state') as ViewState[];

/** Real extension graph; only the process boundary is faked, so nothing real ever spawns. */
function boot(testCommand: string | undefined) {
  resetVscodeMock();
  resetEditorMock();
  setMockWorkspace(['/ws']);
  setMockConfiguration(testCommand === undefined ? {} : { 'kirosight.testCommand': testCommand });

  const spawned: string[] = [];
  const children: Child[] = [];
  const testRunner = new TestRunner({
    spawner: (spawnCommand) => {
      spawned.push(spawnCommand);
      const child = new Child();
      children.push(child);
      return child as unknown as TestProcess;
    },
    scheduler: { set: () => ({}) as object, clear: () => undefined },
  });
  const subscriptions: Array<{ dispose(): void }> = [];
  activate(
    { subscriptions, extensionUri: Uri.file('/ext') } as unknown as Parameters<typeof activate>[0],
    { testRunner, ...fakeBackendOverrides().overrides },
  );
  return { spawned, children, subscriptions };
}

describe('Milestone 5 wiring', () => {
  beforeEach(() => {
    resetVscodeMock();
  });

  it('opens the panel and answers not_configured with no confirmation or spawn when unset', async () => {
    const { spawned } = boot(undefined);

    await command('kirosight.runTests')();

    expect(vscodeMockState.webviewPanels).toHaveLength(1);
    expect(spawned).toEqual([]);
    const last = viewStates().at(-1)!;
    expect(last.statusKind).toBe('idle');
    expect(last.pendingConfirmation ?? null).toBeNull();
    await panel().receive({ type: 'ready' });
    const transcript = viewStates().at(-1)!.transcript.filter((e) => e.role !== 'system');
    expect(transcript.map(({ role, text }) => [role, text])).toEqual([
      ['user', 'run my tests'],
      ['kirosight', 'No test command is configured. Set `kirosight.testCommand` in your workspace settings.'],
    ]);
  });

  it('shows the real pending prompt in the view model, resends it on ready, and decline runs nothing', async () => {
    const { spawned } = boot('echo never-run');

    await command('kirosight.runTests')();

    const pending = viewStates().at(-1)!;
    expect(pending.statusKind).toBe('confirmation_pending');
    expect(pending.pendingConfirmation?.promptText).toBe(
      'Run tests using "echo never-run"? Reply confirm, decline, cancel, or repeat.',
    );
    expect(spawned).toEqual([]);

    expect(pending.pendingConfirmation?.presentationKey).toBe('["local","local-1"]');

    await panel().receive({ type: 'ready' });
    expect(viewStates().at(-1)!.pendingConfirmation).toEqual(pending.pendingConfirmation);
    expect(viewStates().at(-1)!.pendingConfirmation?.promptText).toBe(pending.pendingConfirmation?.promptText);
    expect(viewStates().at(-1)!.statusKind).toBe('confirmation_pending');

    await panel().receive({ type: 'decline' });
    const resolved = viewStates().at(-1)!;
    expect(resolved.statusKind).toBe('idle');
    expect(resolved.pendingConfirmation ?? null).toBeNull();
    expect(spawned).toEqual([]);
  });

  it('runs once through the Confirm button, then shares one store and one output channel', async () => {
    const { spawned, children } = boot('echo never-run');
    await command('kirosight.runTests')();

    const confirming = panel().receive({ type: 'confirm' });
    await flush();
    expect(spawned).toEqual(['echo never-run']);
    children[0]!.stdout.emit('data', 'Tests:       2 passed, 2 total\n');
    children[0]!.finish(0);
    await confirming;
    await flush();

    expect(viewStates().at(-1)).toMatchObject({ statusKind: 'idle', latest: '2 passed, 0 failed' });
    expect(viewStates().at(-1)!.pendingConfirmation ?? null).toBeNull();

    await panel().receive({ type: 'submit_text', submitId: 's1', text: 'list all failures' });
    expect(viewStates().at(-1)!.latest).toBe('The last test run has no failing tests.');

    await command('kirosight.showTestOutput')();
    const channels = vscodeMockState.outputChannels;
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ name: 'KiroSight Tests', text: 'Tests:       2 passed, 2 total\n' });
    expect(channels[0]!.showCalls).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });

  it('shows the same test output channel before any run without spawning', async () => {
    const { spawned } = boot('echo never-run');

    await command('kirosight.showTestOutput')();
    await command('kirosight.showTestOutput')();

    expect(vscodeMockState.outputChannels.map((channel) => channel.name)).toEqual(['KiroSight Tests']);
    expect(vscodeMockState.outputChannels[0]!.showCalls).toHaveLength(2);
    expect(spawned).toEqual([]);
    expect(vscodeMockState.webviewPanels).toHaveLength(0);
  });

  it('disposes the shared test runner channel with the extension', async () => {
    const { subscriptions } = boot('echo never-run');
    await command('kirosight.showTestOutput')();

    for (const subscription of subscriptions) subscription.dispose();

    expect(vscodeMockState.outputChannels[0]!.disposed).toBe(true);
  });

  it('constructs exactly one of each shared Milestone 5 object and keeps commands off the runner', () => {
    const source = readFileSync(resolvePath(__dirname, '../../src/extension.ts'), 'utf8');

    for (const constructor of [
      'TestRunner', 'TestRunStore', 'ConfirmationManager', 'ActionGate', 'GateConfirmationController',
    ]) {
      expect(source.match(new RegExp(`new ${constructor}\\(`, 'g'))).toHaveLength(1);
    }
    expect(source).toContain('confirmations: confirmationManager');
    expect(source).toContain('new GateConfirmationController(\n    actionGate,\n    confirmationManager,');
    expect(source).toContain('testRunner,\n    testRunStore,');
    expect(source).toContain('testRuns: testRunStore');
    expect(source).not.toMatch(/testRunner\.run\(|actionGate\.submit|actionExecutor\.execute/);

    const commands = readFileSync(resolvePath(__dirname, '../../src/commands/registerCommands.ts'), 'utf8');
    expect(commands).not.toMatch(/testRunner|TestRunner|ActionGate|ActionExecutor/);
  });
});
