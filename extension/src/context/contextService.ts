import type {
  EditorAdapter,
  IDEContext,
  Pos,
  SymbolNode,
} from './editorAdapter';
import { MAX_DIAGNOSTICS_SENT, selectExcerpt } from './contextWindow';
import { DiagnosticsService } from './diagnosticsService';
import { SymbolService } from './symbolService';

export type WireIDEContext = Omit<IDEContext, 'activeFile'>;

const EMPTY_DIAGNOSTIC_COUNTS = {
  error: 0,
  warning: 0,
  information: 0,
  hint: 0,
} as const;

function diagnosticCounts(diagnostics: IDEContext['diagnostics']): IDEContext['diagnosticCounts'] {
  return diagnostics.reduce(
    (counts, diagnostic) => ({
      ...counts,
      [diagnostic.severity]: counts[diagnostic.severity] + 1,
    }),
    { ...EMPTY_DIAGNOSTIC_COUNTS },
  );
}

function noEditorContext(): IDEContext {
  return {
    workspace: { name: null, rootCount: 0 },
    activeFile: null,
    relativePath: null,
    languageId: null,
    cursor: null,
    selection: null,
    nearbyCode: null,
    currentSymbol: null,
    symbolStatus: 'no_editor',
    diagnostics: [],
    diagnosticCounts: { ...EMPTY_DIAGNOSTIC_COUNTS },
  };
}

function copyPosition(position: Pos): Pos {
  return { line: position.line, column: position.column };
}

function copyContext(context: IDEContext): WireIDEContext {
  return {
    workspace: { ...context.workspace },
    relativePath: safeRelativePath(context.relativePath),
    languageId: context.languageId,
    cursor: context.cursor === null ? null : copyPosition(context.cursor),
    selection: context.selection === null
      ? null
      : context.selection.isEmpty
        ? { isEmpty: true }
        : {
            isEmpty: false,
            start: copyPosition(context.selection.start),
            end: copyPosition(context.selection.end),
          },
    nearbyCode: context.nearbyCode === null ? null : { ...context.nearbyCode },
    currentSymbol: context.currentSymbol === null ? null : { ...context.currentSymbol },
    symbolStatus: context.symbolStatus,
    diagnostics: context.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      relativePath: safeRelativePath(diagnostic.relativePath) ?? '',
    })),
    diagnosticCounts: { ...context.diagnosticCounts },
  };
}

function safeRelativePath(path: string | null): string | null {
  if (path === null || /^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/.test(path)) {
    return null;
  }
  return path;
}

function symbolRange(symbol: SymbolNode): { startLine: number; endLine: number } {
  return {
    startLine: symbol.range.start.line,
    endLine: symbol.range.end.line,
  };
}

export class ContextService {
  public constructor(
    private readonly adapter: EditorAdapter,
    private readonly symbolService: SymbolService,
    private readonly diagnosticsService = new DiagnosticsService(adapter),
  ) {}

  public async getContext(): Promise<IDEContext> {
    const snapshot = this.adapter.snapshot();
    if (snapshot === null || snapshot.file === null) {
      return noEditorContext();
    }

    const selection = snapshot.selection === null
      ? { isEmpty: true as const }
      : {
          isEmpty: false as const,
          start: copyPosition(snapshot.selection.start),
          end: copyPosition(snapshot.selection.end),
        };

    let currentSymbol: IDEContext['currentSymbol'] = null;
    let symbolStatus: IDEContext['symbolStatus'] = 'none_enclosing';
    let enclosingRange: { startLine: number; endLine: number } | null = null;

    if (snapshot.cursor !== null) {
      const symbolResult = await this.symbolService.lookup(
        snapshot.file.fsPath,
        snapshot.cursor,
      );
      if (symbolResult.status === 'found') {
        currentSymbol = {
          name: symbolResult.symbol.name,
          kind: symbolResult.symbol.kind,
          startLine: symbolResult.symbol.range.start.line,
          endLine: symbolResult.symbol.range.end.line,
        };
        symbolStatus = 'found';
        enclosingRange = symbolRange(symbolResult.symbol);
      } else {
        symbolStatus = symbolResult.status;
      }
    }

    const diagnosticsResult = this.diagnosticsService.getDiagnostics('workspace');
    const allDiagnostics = diagnosticsResult.diagnostics;

    return {
      workspace: {
        name: snapshot.workspaceName,
        rootCount: snapshot.rootCount,
      },
      activeFile: snapshot.file.fsPath,
      relativePath: snapshot.file.relativePath,
      languageId: snapshot.file.languageId,
      cursor: snapshot.cursor === null ? null : copyPosition(snapshot.cursor),
      selection,
      nearbyCode: selectExcerpt(snapshot, enclosingRange),
      currentSymbol,
      symbolStatus,
      diagnostics: allDiagnostics.slice(0, MAX_DIAGNOSTICS_SENT),
      diagnosticCounts: diagnosticCounts(allDiagnostics),
    };
  }
}

export function toWireContext(context: IDEContext): WireIDEContext {
  return copyContext(context);
}
