import type { IDEContext } from './editorAdapter';

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
