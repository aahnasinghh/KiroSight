type CommandHandler = (...args: unknown[]) => unknown;

interface DisposableLike {
  dispose(): void;
}

export interface MockOutputChannel extends DisposableLike {
  readonly name: string;
  readonly lines: string[];
  readonly showCalls: Array<boolean | undefined>;
  disposed: boolean;
  appendLine(line: string): void;
  show(preserveFocus?: boolean): void;
}

class MockDisposable implements DisposableLike {
  private disposed = false;

  public constructor(private readonly onDispose: () => void = () => undefined) {}

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.onDispose();
  }
}

export class Uri {
  public constructor(public readonly path: string) {}

  public get fsPath(): string {
    return this.path;
  }

  public static file(path: string): Uri {
    return new Uri(path);
  }

  public static joinPath(base: { path: string }, ...segments: string[]): Uri {
    return new Uri([base.path, ...segments].join('/'));
  }

  public toString(): string {
    return `mock-uri:${this.path}`;
  }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1 } as const;

export interface MockWebviewPanel extends DisposableLike {
  readonly viewType: string;
  readonly title: string;
  readonly showOptions: unknown;
  readonly options: {
    enableScripts?: boolean;
    enableCommandUris?: boolean;
    retainContextWhenHidden?: boolean;
    localResourceRoots?: Uri[];
  };
  readonly webview: {
    html: string;
    readonly cspSource: string;
    readonly posted: unknown[];
    asWebviewUri(uri: Uri): Uri;
    postMessage(message: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown): DisposableLike;
  };
  readonly revealCalls: Array<[number | undefined, boolean | undefined]>;
  disposed: boolean;
  reveal(viewColumn?: number, preserveFocus?: boolean): void;
  onDidDispose(listener: () => void): DisposableLike;
  /** Test helper: deliver a raw webview message to every registered listener. */
  receive(raw: unknown): Promise<void>;
}

export const vscodeMockState = {
  webviewPanels: [] as MockWebviewPanel[],
  executedCommands: [] as string[],
  outputChannels: [] as MockOutputChannel[],
  registeredCommands: new Map<string, CommandHandler>(),
  notifications: [] as string[],
  inputBoxResponses: [] as Array<string | undefined>,
  inputBoxCalls: [] as unknown[],
};

export function resetVscodeMock(): void {
  vscodeMockState.webviewPanels.length = 0;
  vscodeMockState.executedCommands.length = 0;
  vscodeMockState.outputChannels.length = 0;
  vscodeMockState.registeredCommands.clear();
  vscodeMockState.notifications.length = 0;
  vscodeMockState.inputBoxResponses.length = 0;
  vscodeMockState.inputBoxCalls.length = 0;
}

export const languages = {
  getDiagnostics(): never[] {
    return [];
  },
};

export const window = {
  createOutputChannel(name: string): MockOutputChannel {
    const channel: MockOutputChannel = {
      name,
      lines: [],
      showCalls: [],
      disposed: false,
      appendLine(line) {
        this.lines.push(line);
      },
      show(preserveFocus) {
        this.showCalls.push(preserveFocus);
      },
      dispose() {
        this.disposed = true;
      },
    };

    vscodeMockState.outputChannels.push(channel);
    return channel;
  },
  showInformationMessage(message: string): Promise<string> {
    vscodeMockState.notifications.push(message);
    return Promise.resolve(message);
  },
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions: unknown,
    options: MockWebviewPanel['options'],
  ): MockWebviewPanel {
    const receivers: Array<(message: unknown) => unknown> = [];
    const disposeListeners: Array<() => void> = [];
    const panel: MockWebviewPanel = {
      viewType,
      title,
      showOptions,
      options,
      webview: {
        html: '',
        cspSource: 'mock-csp-source',
        posted: [],
        asWebviewUri: (uri) => new Uri(`webview:${uri.path}`),
        postMessage(message) {
          this.posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage(listener) {
          receivers.push(listener);
          return new MockDisposable(() => {
            receivers.splice(receivers.indexOf(listener), 1);
          });
        },
      },
      revealCalls: [],
      disposed: false,
      reveal(viewColumn, preserveFocus) {
        this.revealCalls.push([viewColumn, preserveFocus]);
      },
      onDidDispose(listener) {
        disposeListeners.push(listener);
        return new MockDisposable();
      },
      dispose() {
        if (this.disposed) {
          return;
        }
        this.disposed = true;
        for (const listener of disposeListeners) {
          listener();
        }
      },
      async receive(raw) {
        await Promise.all(receivers.map((listener) => listener(raw)));
      },
    };

    vscodeMockState.webviewPanels.push(panel);
    return panel;
  },
  showInputBox(options?: unknown): Promise<string | undefined> {
    vscodeMockState.inputBoxCalls.push(options);
    return Promise.resolve(vscodeMockState.inputBoxResponses.shift());
  },
};

export const commands = {
  executeCommand(command: string): Promise<undefined> {
    vscodeMockState.executedCommands.push(command);
    return Promise.resolve(undefined);
  },
  registerCommand(command: string, handler: CommandHandler): DisposableLike {
    vscodeMockState.registeredCommands.set(command, handler);
    return new MockDisposable(() => vscodeMockState.registeredCommands.delete(command));
  },
};

export class Disposable {
  public static from(...disposables: DisposableLike[]): DisposableLike {
    return new MockDisposable(() => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    });
  }
}
