import { spawn } from 'node:child_process';

import * as vscode from 'vscode';

/** The subset of a child process needed to track one optional backend process. */
export interface BackendProcess {
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
}

export interface BackendSpawnOptions {
  readonly shell: true;
  readonly cwd: string;
  readonly windowsHide: true;
}

export type BackendProcessSpawner = (
  command: string,
  options: BackendSpawnOptions,
) => BackendProcess;

export type BackendLaunchResult =
  | Readonly<{ status: 'started'; message: string }>
  | Readonly<{ status: 'already_running'; message: string }>
  | Readonly<{ status: 'not_configured'; message: string }>
  | Readonly<{ status: 'no_workspace'; message: string }>
  | Readonly<{ status: 'failed'; message: string }>;

export const BACKEND_COMMAND_SETTING = 'backendCommand' as const;
export const START_BACKEND_NOT_CONFIGURED_MESSAGE =
  'No backend start command is configured. Set kirosight.backendCommand in User Settings, or start the backend manually.';
export const START_BACKEND_STARTED_MESSAGE = 'Backend start requested.';
export const START_BACKEND_ALREADY_RUNNING_MESSAGE = 'The KiroSight backend is already running.';
export const START_BACKEND_NO_WORKSPACE_MESSAGE =
  'The backend could not be started because no workspace is open.';
export const START_BACKEND_FAILED_MESSAGE = 'The KiroSight backend could not be started.';

/**
 * Reads only the user/global value. Workspace and workspace-folder values are deliberately
 * ignored because they could make a repository supply executable content.
 */
export function readBackendCommand(): string {
  const inspected = vscode.workspace
    .getConfiguration('kirosight')
    .inspect<string>(BACKEND_COMMAND_SETTING);
  return typeof inspected?.globalValue === 'string' ? inspected.globalValue.trim() : '';
}

const defaultSpawner: BackendProcessSpawner = (command, options) =>
  spawn(command, options) as unknown as BackendProcess;

/**
 * Explicitly launches the configured local backend. `start()` has no command parameter: the only
 * executable text it can use comes from the trusted user/global `kirosight.backendCommand` value.
 * This class does not start automatically, connect a WebSocket, restart a process, or kill a
 * process on disposal. The working directory follows the existing TestRunner convention: the
 * first workspace folder, if any.
 */
export class BackendLauncher {
  private readonly spawner: BackendProcessSpawner;
  private readonly cwd: () => string | undefined;
  private readonly notify: (message: string) => void;
  private running: BackendProcess | undefined;

  public constructor(options: {
    readonly spawner?: BackendProcessSpawner;
    readonly cwd?: () => string | undefined;
    readonly notify?: (message: string) => void;
  } = {}) {
    this.spawner = options.spawner ?? defaultSpawner;
    this.cwd = options.cwd ?? (() => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
    this.notify = options.notify ?? ((message) => { void vscode.window.showInformationMessage(message); });
  }

  /** Starts the configured command, without accepting any caller-supplied command text. */
  public start(): BackendLaunchResult {
    if (this.running !== undefined) {
      return { status: 'already_running', message: START_BACKEND_ALREADY_RUNNING_MESSAGE };
    }

    const command = readBackendCommand();
    if (command === '') {
      return { status: 'not_configured', message: START_BACKEND_NOT_CONFIGURED_MESSAGE };
    }

    const workingDirectory = this.cwd();
    if (workingDirectory === undefined || workingDirectory.trim() === '') {
      return { status: 'no_workspace', message: START_BACKEND_NO_WORKSPACE_MESSAGE };
    }

    let process: BackendProcess;
    try {
      process = this.spawner(command, { shell: true, cwd: workingDirectory, windowsHide: true });
    } catch {
      return { status: 'failed', message: START_BACKEND_FAILED_MESSAGE };
    }

    this.running = process;
    process.on('error', () => {
      if (this.running !== process) return;
      this.running = undefined;
      this.notify(START_BACKEND_FAILED_MESSAGE);
    });
    process.on('exit', () => {
      if (this.running === process) this.running = undefined;
    });

    return { status: 'started', message: START_BACKEND_STARTED_MESSAGE };
  }

  /** Does not kill a backend process; the launcher does not claim process ownership. */
  public dispose(): void {
    // Intentionally empty: an explicitly started backend may outlive the extension host.
  }
}
