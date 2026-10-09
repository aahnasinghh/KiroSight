import type { DiagnosticsService } from '../context/diagnosticsService';
import type { DiagnosticInfo, EditorAdapter } from '../context/editorAdapter';
import { next, previous, resolve } from '../navigation/diagnosticNavigation';
import type { DiagnosticNavigationResult } from '../navigation/diagnosticNavigation';
import type { FileService } from '../navigation/fileService';
import type { NavigationService } from '../navigation/navigationService';
import type { ActionResult } from './actionResult';
import type { Action } from './actionTypes';

export interface ActionExecutorDeps {
  adapter: EditorAdapter;
  diagnostics: DiagnosticsService;
  files: FileService;
  navigation: NavigationService;
}

type ActionHandlers = {
  [K in Action['type']]: (action: Extract<Action, { type: K }>) => Promise<ActionResult>;
};

const NO_FILE_OPEN = 'No file is open.';

function diagnosticMessage(diagnostic: DiagnosticInfo, wrapped: boolean): string {
  const place = `line ${diagnostic.line} in ${diagnostic.relativePath}`;
  const prefix = wrapped ? 'Wrapped around to' : 'Moved to';
  return `${prefix} ${diagnostic.severity} at ${place}: ${diagnostic.message}`;
}

/** Coordinates existing services. Input must already be validated by ActionValidator. */
export class ActionExecutor {
  private readonly handlers: ActionHandlers;

  public constructor(private readonly deps: ActionExecutorDeps) {
    this.handlers = {
      NO_ACTION: () => this.noAction(),
      GO_TO_DIAGNOSTIC: (action) => this.goToDiagnostic(action),
      NEXT_DIAGNOSTIC: (action) => this.stepDiagnostic('NEXT_DIAGNOSTIC', action.severity, next),
      PREVIOUS_DIAGNOSTIC: (action) =>
        this.stepDiagnostic('PREVIOUS_DIAGNOSTIC', action.severity, previous),
      OPEN_FILE: (action) => this.openFile(action),
      GO_TO_LINE: (action) => this.goToLine(action),
      FOCUS_EDITOR: () => this.focusEditor(),
      RUN_TESTS: () => this.runTests(),
    };
  }

  public execute(action: Action): Promise<ActionResult> {
    const handler = this.handlers[action.type] as (a: Action) => Promise<ActionResult>;
    return handler(action);
  }

  private async noAction(): Promise<ActionResult> {
    return { actionType: 'NO_ACTION', status: 'ok', message: 'No action was taken.' };
  }

  private async goToDiagnostic(
    action: Extract<Action, { type: 'GO_TO_DIAGNOSTIC' }>,
  ): Promise<ActionResult> {
    const { diagnostics, fsPaths } = this.deps.diagnostics.getWorkspaceNavigationTargets();
    const result = resolve(diagnostics, action.index, action.severity);
    return this.revealDiagnostic('GO_TO_DIAGNOSTIC', result, fsPaths);
  }

  private async stepDiagnostic(
    actionType: 'NEXT_DIAGNOSTIC' | 'PREVIOUS_DIAGNOSTIC',
    severity: Extract<Action, { type: 'NEXT_DIAGNOSTIC' }>['severity'],
    select: typeof next,
  ): Promise<ActionResult> {
    const snapshot = this.deps.adapter.snapshot();
    if (snapshot === null || snapshot.file === null || snapshot.cursor === null) {
      return { actionType, status: 'failed', message: NO_FILE_OPEN };
    }

    const { diagnostics, fsPaths } = this.deps.diagnostics.getWorkspaceNavigationTargets();
    const result = select(
      diagnostics,
      { relativePath: snapshot.file.relativePath, line: snapshot.cursor.line },
      severity,
    );
    return this.revealDiagnostic(actionType, result, fsPaths);
  }

  private async revealDiagnostic(
    actionType: 'GO_TO_DIAGNOSTIC' | 'NEXT_DIAGNOSTIC' | 'PREVIOUS_DIAGNOSTIC',
    result: DiagnosticNavigationResult,
    fsPaths: Map<DiagnosticInfo, string>,
  ): Promise<ActionResult> {
    if (result.status === 'failed') {
      return { actionType, status: 'failed', message: result.message };
    }

    const { diagnostic, wrapped } = result;
    const fsPath = fsPaths.get(diagnostic);
    if (fsPath === undefined) {
      return { actionType, status: 'failed', message: 'The requested location could not be found' };
    }

    await this.deps.navigation.reveal(fsPath, { line: diagnostic.line, column: 1 });
    return {
      actionType,
      status: 'ok',
      message: diagnosticMessage(diagnostic, wrapped),
      details: {
        kind: 'diagnostic_reached',
        relativePath: diagnostic.relativePath,
        line: diagnostic.line,
        severity: diagnostic.severity,
        message: diagnostic.message,
        ...(diagnostic.symbolName ? { symbol: diagnostic.symbolName } : {}),
        ...(actionType === 'GO_TO_DIAGNOSTIC' ? {} : { wrapped }),
      },
    };
  }

  private async openFile(
    action: Extract<Action, { type: 'OPEN_FILE' }>,
  ): Promise<ActionResult> {
    const resolution = await this.deps.files.resolve(action.path);
    const result = await this.deps.navigation.openFile(resolution);

    if (result.status === 'ok' && resolution.status === 'found') {
      return {
        actionType: 'OPEN_FILE',
        status: 'ok',
        message: `Opened ${resolution.relativePath}`,
        details: { kind: 'file_opened', relativePath: resolution.relativePath },
      };
    }

    if (result.status === 'ambiguous') {
      return {
        actionType: 'OPEN_FILE',
        status: 'needs_clarification',
        message: `${result.totalCount} files match. Which one do you mean?`,
        details: {
          kind: 'ambiguous_files',
          matches: result.matches,
          totalMatches: result.totalCount,
        },
      };
    }

    return { actionType: 'OPEN_FILE', status: 'failed', message: 'File not found' };
  }

  private async goToLine(
    action: Extract<Action, { type: 'GO_TO_LINE' }>,
  ): Promise<ActionResult> {
    const result = await this.deps.navigation.goToLine(action.line);
    if (result.status === 'ok' && result.relativePath !== undefined && result.line !== undefined) {
      return {
        actionType: 'GO_TO_LINE',
        status: 'ok',
        message: `Moved to line ${result.line} in ${result.relativePath}`,
        details: {
          kind: 'location_reached',
          relativePath: result.relativePath,
          line: result.line,
        },
      };
    }

    return {
      actionType: 'GO_TO_LINE',
      status: 'failed',
      message: 'The requested location could not be found',
    };
  }

  private async focusEditor(): Promise<ActionResult> {
    await this.deps.navigation.focusEditor();
    return { actionType: 'FOCUS_EDITOR', status: 'ok', message: 'Focused the editor.' };
  }

  /** Placeholder until Task 5.14 replaces it with the real TestRunner delegate. */
  private async runTests(): Promise<ActionResult> {
    return {
      actionType: 'RUN_TESTS',
      status: 'failed',
      message: 'test running is not available yet',
    };
  }
}
