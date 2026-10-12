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

export interface MockWorkspaceFolder {
  readonly uri: Uri;
  readonly name: string;
  readonly index: number;
}

export class RelativePattern {
  public readonly baseUri: Uri;

  public constructor(
    base: MockWorkspaceFolder | Uri,
    public readonly pattern: string,
  ) {
    this.baseUri = base instanceof Uri ? base : base.uri;
  }

  public get base(): string {
    return this.baseUri.path;
  }
}

/** Minimal VS Code glob emulation: `**`, `*`, `?`, `[x]` classes and `{a,b}`. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const rest = glob.slice(index);
    if (rest.startsWith('**/')) {
      source += '(?:.*/)?';
      index += 3;
    } else if (rest.startsWith('/**')) {
      source += '(?:/.*)?';
      index += 3;
    } else if (rest[0] === '*') {
      source += '[^/]*';
      index += 1;
    } else if (rest[0] === '?') {
      source += '[^/]';
      index += 1;
    } else if (rest[0] === '[') {
      const close = rest.indexOf(']', 2);
      source += `[${rest.slice(1, close).replace(/[\\\]^]/g, '\\$&')}]`;
      index += close + 1;
    } else if (rest[0] === '{') {
      const close = rest.indexOf('}');
      source += `(?:${rest.slice(1, close).split(',').map((p) => p.replace(/[.+^$()|\\]/g, '\\$&')).join('|')})`;
      index += close + 1;
    } else {
      source += rest[0]!.replace(/[.+^$()|\\\]]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

export const workspaceMockState = {
  folders: undefined as MockWorkspaceFolder[] | undefined,
  /** Absolute file paths (forward slashes) that exist in the fake workspace. */
  files: [] as string[],
  findFilesCalls: [] as Array<{ include: unknown; exclude: unknown }>,
};

export function setMockWorkspace(folderPaths: string[] | undefined, files: string[] = []): void {
  workspaceMockState.folders = folderPaths?.map((path, index) => ({
    uri: new Uri(path),
    name: path.split('/').pop() ?? path,
    index,
  }));
  workspaceMockState.files = files;
  workspaceMockState.findFilesCalls.length = 0;
}

export class Position {
  public constructor(
    public readonly line: number,
    public readonly character: number,
  ) {}
}

export class Range {
  public constructor(
    public readonly start: Position,
    public readonly end: Position,
  ) {}
}

export class Selection extends Range {
  public constructor(
    public readonly anchor: Position,
    public readonly active: Position,
  ) {
    super(anchor, active);
  }

  public get isEmpty(): boolean {
    return this.anchor.line === this.active.line && this.anchor.character === this.active.character;
  }
}

export interface MockTextDocument {
  readonly uri: Uri;
  readonly languageId: string;
  readonly isUntitled: boolean;
  isClosed: boolean;
  readonly lineCount: number;
  lineAt(line: number): { text: string };
}

export interface MockTextEditor {
  readonly document: MockTextDocument;
  selection: Selection;
  revealRange(range: Range): void;
}

export function createMockEditor(path: string, lines: string[] = ['one', 'two', 'three']): MockTextEditor {
  const document: MockTextDocument = {
    uri: new Uri(path),
    languageId: 'typescript',
    isUntitled: false,
    isClosed: false,
    lineCount: lines.length,
    lineAt: (line) => ({ text: lines[line] ?? '' }),
  };
  const origin = new Position(0, 0);
  return { document, selection: new Selection(origin, origin), revealRange: () => undefined };
}

export const editorMockState = {
  active: undefined as MockTextEditor | undefined,
  activeListeners: [] as Array<(editor: MockTextEditor | undefined) => void>,
  closeListeners: [] as Array<(document: MockTextDocument) => void>,
  /** Editors `showTextDocument` hands back, keyed by document path. */
  editorsByPath: new Map<string, MockTextEditor>(),
  documentsByPath: new Map<string, MockTextDocument>(),
  shown: [] as string[],
  /** When false, showTextDocument does not fire activation (models event-timing lag). */
  activateOnShow: true,
};

export function resetEditorMock(): void {
  editorMockState.active = undefined;
  editorMockState.activeListeners.length = 0;
  editorMockState.closeListeners.length = 0;
  editorMockState.editorsByPath.clear();
  editorMockState.documentsByPath.clear();
  editorMockState.shown.length = 0;
  editorMockState.activateOnShow = true;
  diagnosticsMockState.entries.length = 0;
}

/** Test helper: change the active editor and fire onDidChangeActiveTextEditor. */
export function setActiveEditor(editor: MockTextEditor | undefined): void {
  editorMockState.active = editor;
  for (const listener of [...editorMockState.activeListeners]) {
    listener(editor);
  }
}

/** Test helper: really close a document and fire onDidCloseTextDocument. */
export function closeDocument(document: MockTextDocument): void {
  document.isClosed = true;
  for (const listener of [...editorMockState.closeListeners]) {
    listener(document);
  }
}

function registerListener<T>(list: T[], listener: T): DisposableLike {
  list.push(listener);
  return new MockDisposable(() => {
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
  });
}

export const workspace = {
  openTextDocument(uri: Uri): Promise<MockTextDocument> {
    const existing = editorMockState.editorsByPath.get(uri.path)?.document
      ?? editorMockState.documentsByPath.get(uri.path);
    return Promise.resolve(existing ?? createMockEditor(uri.path).document);
  },
  onDidCloseTextDocument(listener: (document: MockTextDocument) => void): DisposableLike {
    return registerListener(editorMockState.closeListeners, listener);
  },
  get workspaceFolders(): MockWorkspaceFolder[] | undefined {
    return workspaceMockState.folders;
  },
  get name(): string | undefined {
    return workspaceMockState.folders?.[0]?.name;
  },
  asRelativePath(target: { path: string } | string, _includeWorkspaceFolder?: boolean): string {
    const path = typeof target === 'string' ? target : target.path;
    const folder = (workspaceMockState.folders ?? []).find((f) => path.startsWith(`${f.uri.path}/`));
    return folder === undefined ? path : path.slice(folder.uri.path.length + 1);
  },
  async findFiles(include: RelativePattern | string, exclude?: string): Promise<Uri[]> {
    workspaceMockState.findFilesCalls.push({ include, exclude });
    if (typeof include === 'string') {
      throw new Error('mock: findFiles requires a RelativePattern');
    }
    const includeRegExp = globToRegExp(include.pattern);
    const excludeRegExp = exclude === undefined ? undefined : globToRegExp(exclude);
    const prefix = `${include.base}/`;
    return workspaceMockState.files
      .filter((file) => file.startsWith(prefix))
      .map((file) => ({ file, relative: file.slice(prefix.length) }))
      .filter(({ relative }) => includeRegExp.test(relative) && !(excludeRegExp?.test(relative)))
      .map(({ file }) => new Uri(file));
  },
};

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

export const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 } as const;

export interface MockDiagnostic {
  severity: number;
  range: Range;
  message: string;
}

export const diagnosticsMockState = {
  entries: [] as Array<[Uri, MockDiagnostic[]]>,
};

export const languages = {
  getDiagnostics(): Array<[Uri, MockDiagnostic[]]> {
    return diagnosticsMockState.entries;
  },
};

export const window = {
  get activeTextEditor(): MockTextEditor | undefined {
    return editorMockState.active;
  },
  onDidChangeActiveTextEditor(listener: (editor: MockTextEditor | undefined) => void): DisposableLike {
    return registerListener(editorMockState.activeListeners, listener);
  },
  /** Shows a document; the editor it returns also becomes active, as in the real host. */
  showTextDocument(document: MockTextDocument): Promise<MockTextEditor> {
    editorMockState.shown.push(document.uri.path);
    const editor = editorMockState.editorsByPath.get(document.uri.path)
      ?? { document, selection: new Selection(new Position(0, 0), new Position(0, 0)), revealRange: () => undefined };
    editorMockState.editorsByPath.set(document.uri.path, editor);
    if (editorMockState.activateOnShow) {
      setActiveEditor(editor);
    }
    return Promise.resolve(editor);
  },
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
        cspSource: "'self' https://*.vscode-cdn.net",
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
