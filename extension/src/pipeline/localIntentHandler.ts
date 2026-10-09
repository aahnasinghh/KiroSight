import type { ActionResult } from '../actions/actionResult';
import type { Action } from '../actions/actionTypes';
import { validateAction } from '../actions/actionValidator';
import type { ContextService } from '../context/contextService';
import {
  formatCurrentSymbol,
  formatDiagnostics,
  formatSelection,
  formatWhereAmI,
} from '../context/contextFormatter';
import type { DiagnosticScope, DiagnosticsService } from '../context/diagnosticsService';
import type { SymbolService } from '../context/symbolService';
import type { LocalIntent, RouteResult } from '../intent/intentTypes';
import { formatActionResult } from '../response/responseFormatter';

/** Anything that can execute a validated action; ActionExecutor satisfies this. */
export interface ActionRunner {
  execute(action: Action): Promise<ActionResult>;
}

export interface LocalIntentHandlerDeps {
  context: ContextService;
  diagnostics: DiagnosticsService;
  symbols: SymbolService;
  actions: ActionRunner;
}

export const REASONING_NOT_CONNECTED = 'Reasoning is not connected yet.';
export const TEST_SUMMARY_UNAVAILABLE = 'Test failure summaries are not available yet.';
export const HELP_TEXT = [
  'You can ask: where am I, current function, read selection,',
  'what errors are there, errors in this file, next error, previous error,',
  'go to the first, second or third error, go to line N, open a file name,',
  'focus editor, run tests, or help.',
].join(' ');

export class LocalIntentHandler {
  public constructor(private readonly deps: LocalIntentHandlerDeps) {}

  public async handle(result: RouteResult): Promise<string> {
    if (result.route === 'agent') {
      return REASONING_NOT_CONNECTED;
    }
    return this.handleIntent(result.intent);
  }

  public async handleIntent(intent: LocalIntent): Promise<string> {
    switch (intent.kind) {
      case 'WHERE_AM_I':
        return formatWhereAmI(await this.deps.context.getContext());
      case 'CURRENT_SYMBOL':
        return formatCurrentSymbol(await this.deps.context.getContext());
      case 'READ_SELECTION':
        return formatSelection(await this.deps.context.getContext());
      case 'DESCRIBE_DIAGNOSTICS':
        return this.describeDiagnostics(intent.scope === 'file' ? 'current_file' : 'workspace');
      case 'ACTION':
        return this.runAction(intent.action);
      case 'SUMMARIZE_LAST_TEST_RUN':
        return TEST_SUMMARY_UNAVAILABLE;
      case 'HELP':
        return HELP_TEXT;
    }
  }

  private async describeDiagnostics(scope: DiagnosticScope): Promise<string> {
    const result = this.deps.diagnostics.getDiagnostics(scope);
    // Trusted relative path -> fsPath mapping comes from the diagnostics service itself.
    const { fsPaths } = this.deps.diagnostics.getWorkspaceNavigationTargets();
    const byRelativePath = new Map<string, string>();
    for (const [diagnostic, fsPath] of fsPaths) {
      byRelativePath.set(diagnostic.relativePath, fsPath);
    }
    return formatDiagnostics(
      result,
      this.deps.symbols,
      (relativePath) => byRelativePath.get(relativePath) ?? null,
    );
  }

  private async runAction(action: Action): Promise<string> {
    const validated = validateAction(action, 'local');
    if (!validated.ok) {
      return `Action rejected: ${validated.message}`;
    }
    return formatActionResult(await this.deps.actions.execute(validated.action));
  }
}
