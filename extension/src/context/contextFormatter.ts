import type { DiagnosticsResult } from './diagnosticsService';
import type { IDEContext } from './editorAdapter';
import { SymbolService } from './symbolService';

const NO_FILE_OPEN = 'No file is open.';

function symbolKind(kind: string): string {
  return kind.length === 0 ? 'symbol' : kind.toLowerCase();
}

function formatSymbolState(context: IDEContext): string {
  if (context.symbolStatus === 'found' && context.currentSymbol !== null) {
    return `You are in ${symbolKind(context.currentSymbol.kind)} ${context.currentSymbol.name}.`;
  }

  if (context.symbolStatus === 'provider_unavailable') {
    return 'No enclosing symbol found because symbol information is unavailable.';
  }

  return 'No enclosing symbol found.';
}

function hasEditor(context: IDEContext): boolean {
  return context.activeFile !== null && context.relativePath !== null && context.cursor !== null;
}

export function formatWhereAmI(context: IDEContext): string {
  if (!hasEditor(context)) {
    return NO_FILE_OPEN;
  }

  const cursor = context.cursor!;
  const selection = context.selection?.isEmpty === false
    ? `Selection from line ${context.selection.start.line}, column ${context.selection.start.column} to line ${context.selection.end.line}, column ${context.selection.end.column}.`
    : 'Nothing is selected.';

  return [
    `You're editing ${context.relativePath} at line ${cursor.line}, column ${cursor.column}.`,
    selection,
    formatSymbolState(context),
  ].join(' ');
}

export function formatCurrentSymbol(context: IDEContext): string {
  if (!hasEditor(context)) {
    return NO_FILE_OPEN;
  }

  if (context.symbolStatus === 'found' && context.currentSymbol !== null) {
    return `Current symbol: ${symbolKind(context.currentSymbol.kind)} ${context.currentSymbol.name}.`;
  }

  return formatSymbolState(context);
}

export function formatSelection(context: IDEContext): string {
  if (!hasEditor(context)) {
    return NO_FILE_OPEN;
  }

  if (context.selection?.isEmpty !== false) {
    return 'Nothing is selected.';
  }

  if (context.nearbyCode === null || context.nearbyCode.text.length === 0) {
    return 'A selection is present, but its text is unavailable.';
  }

  const truncated = context.nearbyCode.truncated ? ' The selected text was truncated.' : '';
  return `Selected text from line ${context.selection.start.line}, column ${context.selection.start.column} to line ${context.selection.end.line}, column ${context.selection.end.column}:${truncated}\n${context.nearbyCode.text}`;
}

export type DiagnosticPathResolver = (relativePath: string) => string | null;

function diagnosticSeverity(severity: IDEContext['diagnostics'][number]['severity']): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

async function formatDiagnostic(
  diagnostic: IDEContext['diagnostics'][number],
  symbolService: SymbolService,
  resolvePath: DiagnosticPathResolver,
): Promise<string> {
  const fsPath = resolvePath(diagnostic.relativePath);
  let symbolText = '';

  if (fsPath !== null) {
    const symbolResult = await symbolService.lookup(fsPath, {
      line: diagnostic.line,
      column: diagnostic.column,
    });
    if (symbolResult.status === 'found') {
      symbolText = `, in ${symbolKind(symbolResult.symbol.kind)} ${symbolResult.symbol.name}`;
    }
  }

  return `${diagnosticSeverity(diagnostic.severity)} in ${diagnostic.relativePath} at line ${diagnostic.line}${symbolText}: ${diagnostic.message}`;
}

export async function formatDiagnostics(
  result: DiagnosticsResult,
  symbolService: SymbolService,
  resolvePath: DiagnosticPathResolver,
): Promise<string> {
  if (result.status === 'no_file_open') {
    return NO_FILE_OPEN;
  }

  if (result.status === 'no_diagnostics') {
    return 'No diagnostics found.';
  }

  const lines = await Promise.all(
    result.diagnostics.map((diagnostic) =>
      formatDiagnostic(diagnostic, symbolService, resolvePath),
    ),
  );

  return lines.length === 1
    ? lines[0]
    : `Diagnostics:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}
