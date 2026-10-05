import type {
  EditorAdapter,
  EditorSnapshot,
  Pos,
  RawDiagnostic,
  SymbolQueryResult,
} from '../../src/context/editorAdapter';

export interface FakeEditorAdapterOptions {
  snapshot?: EditorSnapshot | null;
  diagnostics?: RawDiagnostic[];
  symbolResult?: SymbolQueryResult;
  files?: string[];
}

export class FakeEditorAdapter implements EditorAdapter {
  public readonly revealed: Array<{ fsPath: string; position: Pos }> = [];
  public readonly opened: string[] = [];
  public focusCount = 0;

  private readonly editorSnapshot: EditorSnapshot | null;
  private readonly diagnostics: RawDiagnostic[];
  private readonly symbolResult: SymbolQueryResult;
  private readonly files: string[];

  public constructor(options: FakeEditorAdapterOptions = {}) {
    this.editorSnapshot = options.snapshot ?? null;
    this.diagnostics = [...(options.diagnostics ?? [])];
    this.symbolResult = options.symbolResult ?? { status: 'provider_unavailable' };
    this.files = [...(options.files ?? [])];
  }

  public snapshot(): EditorSnapshot | null {
    return this.editorSnapshot;
  }

  public allDiagnostics(): RawDiagnostic[] {
    return [...this.diagnostics];
  }

  public async documentSymbols(_fsPath: string): Promise<SymbolQueryResult> {
    return this.symbolResult;
  }

  public async reveal(fsPath: string, position: Pos): Promise<void> {
    this.revealed.push({ fsPath, position });
  }

  public async openFile(fsPath: string): Promise<void> {
    this.opened.push(fsPath);
  }

  public async findFiles(_name: string): Promise<string[]> {
    return [...this.files];
  }

  public async focusEditor(): Promise<void> {
    this.focusCount += 1;
  }
}
