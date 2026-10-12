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
import type { ActionGate, GateOutcome } from '../confirmation/actionGate';
import { formatActionResult, formatTestResult } from '../response/responseFormatter';
import { read as readTestCommand } from '../testing/testCommandConfig';
import type { TestRunSummary } from '../testing/testOutputParser';
import type { TestRunStore } from '../testing/testRunStore';

/** Anything that can execute a validated action; ActionExecutor satisfies this. */
export interface ActionRunner {
  execute(action: Action): Promise<ActionResult>;
}

export interface LocalIntentHandlerDeps {
  context: ContextService;
  diagnostics: DiagnosticsService;
  symbols: SymbolService;
  actions: ActionRunner;
  /** When present, every local action goes through the registry-based gate. */
  gate?: Pick<ActionGate, 'submit'>;
  testRuns?: TestRunStore;
}

export const REASONING_NOT_CONNECTED = 'Reasoning is not connected yet.';
export const TEST_SUMMARY_UNAVAILABLE = 'No test run is available yet. Say "run tests" first.';
const MAX_LISTED_FAILURES = 20;
const KIROSIGHT_TESTS_HINT = 'See the KiroSight Tests output for details.';

export function notConfiguredSummary(): TestRunSummary {
  return {
    outcome: 'not_configured', command: '', exitCode: null, passed: null, failed: null,
    totalFailedNames: 0, failingTests: [], outputTruncated: false, durationMs: 0,
  };
}
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
      case 'SUMMARIZE_LAST_TEST_RUN': {
        const run = this.deps.testRuns?.get() ?? null;
        return run === null ? TEST_SUMMARY_UNAVAILABLE : formatTestResult(run);
      }
      case 'LIST_TEST_FAILURES':
        return this.listFailures(this.deps.testRuns?.get() ?? null);
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
    if (this.deps.gate === undefined) {
      return formatActionResult(await this.deps.actions.execute(validated.action));
    }
    return this.runGated(this.deps.gate, validated.action);
  }

  private localCounter = 0;

  private async runGated(gate: Pick<ActionGate, 'submit'>, action: Action): Promise<string> {
    let target = '';
    if (action.type === 'RUN_TESTS') {
      // Non-executing check, before any confirmation prompt: an unset command never asks or spawns.
      target = readTestCommand();
      if (target === '') return formatTestResult(notConfiguredSummary());
    }

    this.localCounter += 1;
    const outcome = await gate.submit({
      action, target, origin: 'local', correlationId: `local-${this.localCounter}`,
    });
    return this.describeGateOutcome(outcome);
  }

  private describeGateOutcome(outcome: GateOutcome): string {
    if (outcome.kind === 'confirmation') {
      return outcome.state === 'queued'
        ? `Waiting for the pending confirmation first. ${outcome.request.prompt}`
        : outcome.request.prompt;
    }
    return formatActionResult(outcome.result);
  }

  private listFailures(run: TestRunSummary | null): string {
    if (run === null) return TEST_SUMMARY_UNAVAILABLE;
    if (run.outcome === 'passed' && (run.failed ?? 0) === 0) {
      return 'The last test run has no failing tests.';
    }
    if (run.outcome !== 'passed' && run.outcome !== 'failed') {
      return `No failure list is available for the last test run. ${formatTestResult(run)}`;
    }

    const failed = run.failed ?? 0;
    const names = run.failingTests.slice(0, MAX_LISTED_FAILURES).map(({ name }) => name);
    if (failed === 0) {
      return `The last test run failed, but no failing tests were reported. ${KIROSIGHT_TESTS_HINT}`;
    }
    if (names.length === 0) {
      return `${failed} failed. No failing test names were available. ${KIROSIGHT_TESTS_HINT}`;
    }
    const more = failed > names.length
      ? ` Showing ${names.length} of ${failed}. ${KIROSIGHT_TESTS_HINT}`
      : '';
    return `${failed} failed. Failing tests: ${names.join('; ')}.${more}`;
  }
}
