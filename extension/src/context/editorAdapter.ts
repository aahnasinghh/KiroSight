import * as vscode from 'vscode';

export interface Pos {
  line: number;
  column: number;
}

export interface CodeExcerpt {
  source: 'selection' | 'symbol' | 'cursor_window';
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface DiagnosticInfo {
  severity: 'error' | 'warning' | 'information' | 'hint';
  relativePath: string;
  line: number;
  column: number;
  message: string;
  source?: string;
  code?: string;
  symbolName?: string | null;
}

export interface RawDiagnostic {
  fsPath: string;
  relativePath: string;
  severity: DiagnosticInfo['severity'];
  range: { start: Pos; end: Pos };
  message: string;
  source?: string;
  code?: string;
}

export interface SymbolNode {
  name: string;
  kind: string;
  range: { start: Pos; end: Pos };
  selectionRange?: { start: Pos; end: Pos };
  children: SymbolNode[];
}

export type SymbolQueryResult =
  | { status: 'found'; nodes: SymbolNode[] }
  | { status: 'none_enclosing' }
  | { status: 'provider_unavailable' };

export interface IDEContext {
  workspace: { name: string | null; rootCount: number };
  activeFile: string | null;
  relativePath: string | null;
  languageId: string | null;
  cursor: Pos | null;
  selection:
    | { isEmpty: true }
    | { isEmpty: false; start: Pos; end: Pos }
    | null;
  nearbyCode: CodeExcerpt | null;
  currentSymbol: {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
  } | null;
  symbolStatus: 'found' | 'none_enclosing' | 'provider_unavailable' | 'no_editor';
  diagnostics: DiagnosticInfo[];
  diagnosticCounts: {
    error: number;
    warning: number;
    information: number;
    hint: number;
  };
}

export interface EditorSnapshot {
  workspaceName: string | null;
  rootCount: number;
  file: {
    fsPath: string;
    relativePath: string;
    languageId: string;
    lineCount: number;
  } | null;
  cursor: Pos | null;
  selection: { start: Pos; end: Pos } | null;
  getLines(startLine: number, endLine: number): string[];
}

export interface FileMatch {
  fsPath: string;
  relativePath: string;
}

export interface EditorAdapter {
  snapshot(): EditorSnapshot | null;
  allDiagnostics(): RawDiagnostic[];
  documentSymbols(fsPath: string): Promise<SymbolQueryResult>;
  reveal(fsPath: string, pos: Pos): Promise<void>;
  openFile(fsPath: string): Promise<void>;
  findFiles(name: string): Promise<FileMatch[]>;
  focusEditor(): Promise<void>;
}

function toPos(position: vscode.Position): Pos {
  return { line: position.line + 1, column: position.character + 1 };
}

function toRange(range: vscode.Range): { start: Pos; end: Pos } {
  return { start: toPos(range.start), end: toPos(range.end) };
}

function toSeverity(severity: vscode.DiagnosticSeverity): DiagnosticInfo['severity'] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'information';
    default:
      return 'hint';
  }
}

function toSymbolNode(
  symbol: vscode.DocumentSymbol | vscode.SymbolInformation,
): SymbolNode {
  const range = 'location' in symbol ? symbol.location.range : symbol.range;
  const children = 'children' in symbol ? symbol.children.map(toSymbolNode) : [];

  return {
    name: symbol.name,
    kind: vscode.SymbolKind[symbol.kind] ?? String(symbol.kind),
    range: toRange(range),
    ...('selectionRange' in symbol ? { selectionRange: toRange(symbol.selectionRange) } : {}),
    children,
  };
}

function toRelativePath(uri: vscode.Uri): string {
  return vscode.workspace.asRelativePath(uri, false);
}

function toFileMatch(uri: vscode.Uri): FileMatch {
  return { fsPath: uri.fsPath, relativePath: toRelativePath(uri) };
}

export class VscodeEditorAdapter implements EditorAdapter {
  public snapshot(): EditorSnapshot | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.isUntitled && !editor.document.uri.fsPath) {
      return null;
    }

    const { document, selection } = editor;
    return {
      workspaceName: vscode.workspace.name ?? null,
      rootCount: vscode.workspace.workspaceFolders?.length ?? 0,
      file: {
        fsPath: document.uri.fsPath,
        relativePath: toRelativePath(document.uri),
        languageId: document.languageId,
        lineCount: document.lineCount,
      },
      cursor: toPos(selection.active),
      selection: selection.isEmpty ? null : toRange(selection),
      getLines: (startLine, endLine) => {
        const first = Math.max(1, startLine);
        const last = Math.min(document.lineCount, endLine);
        if (first > last) {
          return [];
        }
        return Array.from(
          { length: last - first + 1 },
          (_, index) => document.lineAt(first - 1 + index).text,
        );
      },
    };
  }

  public allDiagnostics(): RawDiagnostic[] {
    return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
      diagnostics.map((diagnostic) => ({
        fsPath: uri.fsPath,
        relativePath: toRelativePath(uri),
        severity: toSeverity(diagnostic.severity),
        range: toRange(diagnostic.range),
        message: diagnostic.message,
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
        ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
      })),
    );
  }

  public async documentSymbols(fsPath: string): Promise<SymbolQueryResult> {
    try {
      const symbols = await vscode.commands.executeCommand<
        vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined
      >(
        'vscode.executeDocumentSymbolProvider',
        vscode.Uri.file(fsPath),
      );

      if (symbols === undefined) {
        return { status: 'provider_unavailable' };
      }

      return { status: 'found', nodes: symbols.map(toSymbolNode) };
    } catch {
      return { status: 'provider_unavailable' };
    }
  }

  public async reveal(fsPath: string, pos: Pos): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(Math.max(0, pos.line - 1), Math.max(0, pos.column - 1));
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }

  public async openFile(fsPath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    await vscode.window.showTextDocument(document);
  }

  public async findFiles(name: string): Promise<FileMatch[]> {
    const files = await vscode.workspace.findFiles(name);
    return files.map(toFileMatch);
  }

  public async focusEditor(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
  }
}
