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

export const vscodeMockState = {
  outputChannels: [] as MockOutputChannel[],
  registeredCommands: new Map<string, CommandHandler>(),
  notifications: [] as string[],
  inputBoxResponses: [] as Array<string | undefined>,
  inputBoxCalls: [] as unknown[],
};

export function resetVscodeMock(): void {
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
  showInputBox(options?: unknown): Promise<string | undefined> {
    vscodeMockState.inputBoxCalls.push(options);
    return Promise.resolve(vscodeMockState.inputBoxResponses.shift());
  },
};

export const commands = {
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
