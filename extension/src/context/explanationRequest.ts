import type { ExplainTarget } from '../intent/explainIntent';
import { MAX_UTTERANCE_CHARS, PROTOCOL_VERSION } from '../protocol/constants';
import type { AgentRequest } from '../protocol/messages';
import { noFunctionOrSelectionText, noMatchingDiagnosticText } from '../response/explanationMessages';
import { diagnosticCounts, toWireContext } from './contextService';
import { selectExcerpt } from './contextWindow';
import type { DiagnosticEntry, DiagnosticsService } from './diagnosticsService';
import type { EditorAdapter, EditorSnapshot, IDEContext, Pos, SymbolNode } from './editorAdapter';
import type { SymbolLookupResult, SymbolService } from './symbolService';

/**
 * Builds the `agent_request` for "explain this error", "explain this function" and "explain the
 * selection" (Task 7.10; Req 12.1, 12.2, 12.4, 12.5).
 *
 * Grounding rules, from the specification:
 * - diagnostic: the focus is the diagnostic whose range contains the cursor, otherwise the first
 *   diagnostic in the file. The code is the diagnostic line's enclosing symbol when one resolves,
 *   otherwise `DIAGNOSTIC_WINDOW_RADIUS` (5) lines on each side of the diagnostic line;
 * - function: the symbol around the cursor;
 * - selection: the current non-empty selection.
 *
 * When there is nothing to explain the result is `not_available` with the message to report. This
 * class has no backend, Bedrock or action dependency, so a local report can never reach the
 * backend and nothing here can produce or execute an action. Only the minimum context is sent: one
 * bounded code excerpt and, for a diagnostic, that one diagnostic. Absolute paths never leave the
 * extension (`toWireContext`).
 */

export type ExplanationUnavailableReason = 'no_matching_diagnostic' | 'no_function_or_selection';

export type ExplanationBuild =
  | { readonly status: 'ready'; readonly request: AgentRequest }
  | {
    readonly status: 'not_available';
    readonly reason: ExplanationUnavailableReason;
    /** The text to report locally, in the transcript. */
    readonly message: string;
  };

export interface ExplanationRequestInput {
  readonly target: ExplainTarget;
  /** The protocol request id, supplied by the caller (the relay's own id scheme). */
  readonly id: string;
  /** What the user said or typed; sent as the utterance so the answer addresses their words. */
  readonly utterance: string;
  readonly source?: 'typed' | 'voice';
}

type FileSnapshot = EditorSnapshot & { readonly file: NonNullable<EditorSnapshot['file']> };

function hasFile(snapshot: EditorSnapshot | null): snapshot is FileSnapshot {
  return snapshot !== null && snapshot.file !== null;
}

function comparePos(left: Pos, right: Pos): number {
  return left.line !== right.line ? left.line - right.line : left.column - right.column;
}

const SEVERITY_RANK: Record<DiagnosticEntry['diagnostic']['severity'], number> = {
  error: 0, warning: 1, information: 2, hint: 3,
};

/** Number of lines, then columns, a range spans; smaller is more specific. */
function span(range: DiagnosticEntry['range']): number {
  return (range.end.line - range.start.line) * 1_000_000 + (range.end.column - range.start.column);
}

/**
 * The focus diagnostic: one whose range contains the cursor (end inclusive, so an empty range and
 * a cursor at the end of the range both count). With several, the most severe, then the most
 * specific (smallest range), then the earliest. With none at the cursor, or with no cursor, the
 * first diagnostic in the file. `entries` must be ordered by position, as `getFileEntries` does.
 */
export function chooseFocusEntry(
  entries: readonly DiagnosticEntry[],
  cursor: Pos | null,
): DiagnosticEntry | undefined {
  if (cursor !== null) {
    let best: DiagnosticEntry | undefined;
    for (const entry of entries) {
      const containsCursor =
        comparePos(entry.range.start, cursor) <= 0 && comparePos(cursor, entry.range.end) <= 0;
      if (!containsCursor) continue;
      if (
        best === undefined
        || SEVERITY_RANK[entry.diagnostic.severity] < SEVERITY_RANK[best.diagnostic.severity]
        || (SEVERITY_RANK[entry.diagnostic.severity] === SEVERITY_RANK[best.diagnostic.severity]
          && span(entry.range) < span(best.range))
      ) {
        best = entry;
      }
    }
    if (best !== undefined) return best;
  }
  return entries[0];
}

function symbolRange(symbol: SymbolNode): { startLine: number; endLine: number } {
  return { startLine: symbol.range.start.line, endLine: symbol.range.end.line };
}

function currentSymbolOf(symbol: SymbolNode): NonNullable<IDEContext['currentSymbol']> {
  return {
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.range.start.line,
    endLine: symbol.range.end.line,
  };
}

export class ExplanationRequestBuilder {
  public constructor(
    private readonly adapter: EditorAdapter,
    private readonly symbols: Pick<SymbolService, 'lookup'>,
    private readonly diagnostics: Pick<DiagnosticsService, 'getFileEntries' | 'getDiagnostics'>,
  ) {}

  public async build(input: ExplanationRequestInput): Promise<ExplanationBuild> {
    // One snapshot per request, so the file, cursor, selection and excerpt always agree.
    const snapshot = this.adapter.snapshot();
    switch (input.target) {
      case 'diagnostic':
        return this.buildDiagnostic(input, snapshot);
      case 'function':
      case 'selection':
        return this.buildCode(input, snapshot, input.target);
    }
  }

  private async buildDiagnostic(
    input: ExplanationRequestInput,
    snapshot: EditorSnapshot | null,
  ): Promise<ExplanationBuild> {
    if (!hasFile(snapshot)) {
      return notAvailable('no_matching_diagnostic', noMatchingDiagnosticText(null));
    }

    const focus = chooseFocusEntry(this.diagnostics.getFileEntries(snapshot.file.fsPath), snapshot.cursor);
    if (focus === undefined) {
      return notAvailable('no_matching_diagnostic', noMatchingDiagnosticText(snapshot.file.relativePath));
    }

    const lookup = await this.symbols.lookup(snapshot.file.fsPath, focus.range.start);
    const symbol = lookup.status === 'found' ? lookup.symbol : null;
    // The editor selection must not replace the diagnostic's own code (Req 12.1), so it is
    // hidden from the excerpt choice only. The wire context still reports the real selection.
    const nearbyCode = selectExcerpt(
      { ...snapshot, selection: null },
      symbol === null ? null : symbolRange(symbol),
      focus.diagnostic.line,
    );

    return this.ready(input, snapshot, {
      nearbyCode,
      currentSymbol: symbol === null ? null : currentSymbolOf(symbol),
      symbolStatus: lookup.status,
      diagnostics: [{
        ...focus.diagnostic,
        ...(symbol === null ? {} : { symbolName: symbol.name }),
      }],
    });
  }

  private async buildCode(
    input: ExplanationRequestInput,
    snapshot: EditorSnapshot | null,
    target: 'function' | 'selection',
  ): Promise<ExplanationBuild> {
    if (!hasFile(snapshot)) {
      return notAvailable('no_function_or_selection', noFunctionOrSelectionText({
        target, relativePath: null, line: null, symbolStatus: 'none_enclosing', hasSelection: false,
      }));
    }

    const lookup: SymbolLookupResult = snapshot.cursor === null
      ? { status: 'none_enclosing' }
      : await this.symbols.lookup(snapshot.file.fsPath, snapshot.cursor);
    const symbol = lookup.status === 'found' ? lookup.symbol : null;
    const hasSelection = snapshot.selection !== null;

    if ((target === 'function' && symbol === null) || (target === 'selection' && !hasSelection)) {
      return notAvailable('no_function_or_selection', noFunctionOrSelectionText({
        target,
        relativePath: snapshot.file.relativePath,
        line: snapshot.cursor?.line ?? null,
        symbolStatus: lookup.status,
        hasSelection,
      }));
    }

    // 'function' hides the selection so the symbol is the excerpt; 'selection' passes no symbol,
    // and a selection always takes precedence in selectExcerpt.
    const nearbyCode = target === 'function'
      ? selectExcerpt({ ...snapshot, selection: null }, symbol === null ? null : symbolRange(symbol))
      : selectExcerpt(snapshot, null);

    return this.ready(input, snapshot, {
      nearbyCode,
      currentSymbol: symbol === null ? null : currentSymbolOf(symbol),
      symbolStatus: lookup.status,
      diagnostics: [],
    });
  }

  private ready(
    input: ExplanationRequestInput,
    snapshot: FileSnapshot,
    parts: Pick<IDEContext, 'nearbyCode' | 'currentSymbol' | 'symbolStatus' | 'diagnostics'>,
  ): ExplanationBuild {
    const context: IDEContext = {
      workspace: { name: snapshot.workspaceName, rootCount: snapshot.rootCount },
      activeFile: snapshot.file.fsPath,
      relativePath: snapshot.file.relativePath,
      languageId: snapshot.file.languageId,
      cursor: snapshot.cursor === null ? null : { ...snapshot.cursor },
      selection: snapshot.selection === null
        ? { isEmpty: true }
        : { isEmpty: false, start: { ...snapshot.selection.start }, end: { ...snapshot.selection.end } },
      diagnosticCounts: diagnosticCounts(this.diagnostics.getDiagnostics('workspace').diagnostics),
      ...parts,
    };

    const text = input.utterance.slice(0, MAX_UTTERANCE_CHARS);
    return {
      status: 'ready',
      request: {
        version: PROTOCOL_VERSION,
        type: 'agent_request',
        id: input.id,
        kind: 'utterance',
        utterance: input.source === undefined ? { text } : { text, source: input.source },
        context: toWireContext(context),
      },
    };
  }
}

function notAvailable(reason: ExplanationUnavailableReason, message: string): ExplanationBuild {
  return { status: 'not_available', reason, message };
}
