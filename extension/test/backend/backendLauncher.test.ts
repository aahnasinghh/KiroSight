import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  BackendLauncher,
  START_BACKEND_ALREADY_RUNNING_MESSAGE,
  START_BACKEND_FAILED_MESSAGE,
  START_BACKEND_NOT_CONFIGURED_MESSAGE,
  readBackendCommand,
  type BackendProcess,
  type BackendSpawnOptions,
} from '../../src/backend/backendLauncher';
import {
  resetVscodeMock,
  setMockScopedConfiguration,
  setMockWorkspace,
} from '../mocks/vscode';

class FakeBackendProcess extends EventEmitter implements BackendProcess {
  public exit(code: number | null = 0): void {
    this.emit('exit', code, null);
  }
}

interface Harness {
  launcher: BackendLauncher;
  processes: FakeBackendProcess[];
  spawnCalls: Array<{ command: string; options: BackendSpawnOptions }>;
  notifications: string[];
}

function harness(configuration: {
  global?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  workspaceFolder?: Record<string, unknown>;
} = {}): Harness {
  resetVscodeMock();
  setMockWorkspace(['/workspace/root']);
  setMockScopedConfiguration(configuration);
  const processes: FakeBackendProcess[] = [];
  const spawnCalls: Harness['spawnCalls'] = [];
  const notifications: string[] = [];
  const launcher = new BackendLauncher({
    spawner: (command, options) => {
      spawnCalls.push({ command, options });
      const process = new FakeBackendProcess();
      processes.push(process);
      return process;
    },
    notify: (message) => notifications.push(message),
  });
  return { launcher, processes, spawnCalls, notifications };
}

describe('readBackendCommand', () => {
  beforeEach(() => resetVscodeMock());

  it('takes no parameters and accepts only the trimmed global value', () => {
    expect(readBackendCommand.length).toBe(0);
    setMockScopedConfiguration({
      global: { 'kirosight.backendCommand': '  python -m uvicorn app.main:app  ' },
      workspace: { 'kirosight.backendCommand': 'evil-workspace-command' },
      workspaceFolder: { 'kirosight.backendCommand': 'evil-folder-command' },
    });

    expect(readBackendCommand()).toBe('python -m uvicorn app.main:app');
  });

  it.each([
    {},
    { global: { 'kirosight.backendCommand': '' } },
    { global: { 'kirosight.backendCommand': '  \t\r\n ' } },
    { workspace: { 'kirosight.backendCommand': 'workspace-only-command' } },
    { workspaceFolder: { 'kirosight.backendCommand': 'folder-only-command' } },
    {
      global: { 'kirosight.backendCommand': undefined },
      workspace: { 'kirosight.backendCommand': 'workspace-command' },
      workspaceFolder: { 'kirosight.backendCommand': 'folder-command' },
    },
  ])('returns empty when no usable global value exists: %j', (configuration) => {
    setMockScopedConfiguration(configuration);
    expect(readBackendCommand()).toBe('');
  });

  it('lets the global value win over different workspace values', () => {
    setMockScopedConfiguration({
      global: { 'kirosight.backendCommand': '  trusted command --flag  ' },
      workspace: { 'kirosight.backendCommand': 'workspace override' },
      workspaceFolder: { 'kirosight.backendCommand': 'folder override' },
    });

    expect(readBackendCommand()).toBe('trusted command --flag');
  });
});

describe('BackendLauncher', () => {
  it('has a zero-parameter start API and does not auto-start in the constructor', () => {
    const h = harness({ global: { 'kirosight.backendCommand': 'python -m uvicorn app.main:app' } });
    expect(BackendLauncher.prototype.start.length).toBe(0);
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('does not spawn when the global command is missing or blank', () => {
    for (const global of [undefined, '', '   ']) {
      const h = harness(global === undefined ? {} : { global: { 'kirosight.backendCommand': global } });
      const result = h.launcher.start();
      expect(result).toEqual({ status: 'not_configured', message: START_BACKEND_NOT_CONFIGURED_MESSAGE });
      expect(h.spawnCalls).toHaveLength(0);
    }
  });

  it('ignores workspace and workspace-folder commands when the global value is absent', () => {
    const h = harness({
      workspace: { 'kirosight.backendCommand': 'workspace-command' },
      workspaceFolder: { 'kirosight.backendCommand': 'folder-command' },
    });
    expect(h.launcher.start().status).toBe('not_configured');
    expect(h.spawnCalls).toEqual([]);
  });

  it('spawns exactly the trimmed global command with the established trusted options', () => {
    const h = harness({ global: { 'kirosight.backendCommand': '  python -m uvicorn app.main:app --port 8765  ' } });
    const result = h.launcher.start();

    expect(result.status).toBe('started');
    expect(h.spawnCalls).toEqual([{
      command: 'python -m uvicorn app.main:app --port 8765',
      options: { shell: true, cwd: '/workspace/root', windowsHide: true },
    }]);
  });

  it('does not invent a fallback command', () => {
    const h = harness();
    const result = h.launcher.start();
    expect(result.message).toContain('manually');
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('fails closed when there is no workspace', () => {
    resetVscodeMock();
    setMockWorkspace(undefined);
    setMockScopedConfiguration({ global: { 'kirosight.backendCommand': 'configured command' } });
    const calls: string[] = [];
    const launcher = new BackendLauncher({
      spawner: (command) => {
        calls.push(command);
        return new FakeBackendProcess();
      },
    });

    expect(launcher.start().status).toBe('no_workspace');
    expect(calls).toEqual([]);
  });

  it('does not spawn a duplicate while the tracked process is running', () => {
    const h = harness({ global: { 'kirosight.backendCommand': 'configured command' } });
    expect(h.launcher.start().status).toBe('started');
    expect(h.launcher.start()).toEqual({
      status: 'already_running',
      message: START_BACKEND_ALREADY_RUNNING_MESSAGE,
    });
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('clears running state on exit so a later explicit start can spawn again', () => {
    const h = harness({ global: { 'kirosight.backendCommand': 'configured command' } });
    h.launcher.start();
    h.processes[0]!.exit(0);

    expect(h.launcher.start().status).toBe('started');
    expect(h.spawnCalls).toHaveLength(2);
  });

  it('handles a process error without throwing or exposing the configured command', () => {
    const secretCommand = 'SECRET_BACKEND_COMMAND --token SECRET_TOKEN';
    const h = harness({ global: { 'kirosight.backendCommand': secretCommand } });
    expect(h.launcher.start().status).toBe('started');

    expect(() => h.processes[0]!.emit('error', new Error(secretCommand))).not.toThrow();
    expect(h.notifications).toEqual([START_BACKEND_FAILED_MESSAGE]);
    expect(h.notifications.join('\n')).not.toContain(secretCommand);
    expect(h.notifications.join('\n')).not.toContain('SECRET_TOKEN');
    expect(h.launcher.start().status).toBe('started');
  });

  it('handles a synchronous spawner error safely without exposing command text', () => {
    const h = harness({ global: { 'kirosight.backendCommand': 'SECRET_COMMAND' } });
    const launcher = new BackendLauncher({
      spawner: () => { throw new Error('SECRET_COMMAND'); },
    });
    const result = launcher.start();
    expect(result).toEqual({ status: 'failed', message: START_BACKEND_FAILED_MESSAGE });
    expect(JSON.stringify(result)).not.toContain('SECRET_COMMAND');
  });

  it('does not kill the process on dispose', () => {
    const h = harness({ global: { 'kirosight.backendCommand': 'configured command' } });
    h.launcher.start();
    h.launcher.dispose();
    expect(h.processes).toHaveLength(1);
    expect(h.launcher.start().status).toBe('already_running');
  });

  it('contains no webview, agent, utterance, or arbitrary caller command path', () => {
    const source = readFileSync(resolve(__dirname, '../../src/backend/backendLauncher.ts'), 'utf8');
    expect(source).not.toMatch(/acquireVsCodeApi|webview|AgentResponse|utterance/i);
    expect(source).not.toMatch(/start\(command/);
    expect(source).not.toMatch(/executeCommand|eval\(|exec\(/);
  });
});
