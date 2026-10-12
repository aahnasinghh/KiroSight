import type { Action } from '../actions/actionTypes';
import type { TestRunSummary } from '../testing/testOutputParser';
import type { ActionResult, ActionResultDetails } from '../actions/actionResult';

const ACTION_LABELS: { [K in Action['type']]: string } = {
  NO_ACTION: 'No action',
  GO_TO_DIAGNOSTIC: 'Go to diagnostic',
  NEXT_DIAGNOSTIC: 'Next diagnostic',
  PREVIOUS_DIAGNOSTIC: 'Previous diagnostic',
  OPEN_FILE: 'Open file',
  GO_TO_LINE: 'Go to line',
  FOCUS_EDITOR: 'Focus editor',
  RUN_TESTS: 'Run tests',
};

function actionLabel(action: Action): string {
  return ACTION_LABELS[action.type];
}

const ACCEPTED_CONFIRMATION_REPLIES = 'confirm, decline, cancel, or repeat';

function displayPath(path: string): string {
  return /^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/.test(path) ? 'the selected file' : path;
}

function formatDetails(details: ActionResultDetails): string {
  switch (details.kind) {
    case 'file_opened':
      return `Opened ${displayPath(details.relativePath)}.`;
    case 'diagnostic_reached': {
      const location = `${displayPath(details.relativePath)}, line ${details.line}`;
      const symbol = details.symbol === undefined ? '' : `, in ${details.symbol}`;
      const prefix = details.wrapped === true ? 'Wrapped to' : 'Moved to';
      return `${prefix} ${details.severity} diagnostic at ${location}${symbol}: ${details.message}`;
    }
    case 'location_reached':
      return `Moved to ${displayPath(details.relativePath)}, line ${details.line}.`;
    case 'ambiguous_files': {
      const paths = details.matches.map(displayPath).join('; ');
      const total = details.totalMatches > details.matches.length
        ? ` There are ${details.totalMatches} matches in total.`
        : '';
      return `The file request is ambiguous. Matches: ${paths}.${total}`;
    }
    case 'test_run':
      return formatTestResult(details.summary);
  }
}

function countText(summary: TestRunSummary): string {
  const counts: string[] = [];
  if (summary.passed !== null) counts.push(`${summary.passed} passed`);
  if (summary.failed !== null) counts.push(`${summary.failed} failed`);
  return counts.join(', ');
}

/** Purely formats a parsed test-run summary; it does not parse, execute or mutate it. */
export function formatTestResult(summary: TestRunSummary): string {
  switch (summary.outcome) {
    case 'did_not_execute':
      return 'The configured test command could not be executed.';
    case 'timed_out':
      return 'The test run timed out and was stopped.';
    case 'cancelled':
      return 'The test run was cancelled.';
    case 'not_configured':
      return 'No test command is configured. Set `kirosight.testCommand` in your workspace settings.';
    case 'completed_unparsed': {
      const exit = summary.exitCode === null ? '' : ` Exit code: ${summary.exitCode}.`;
      return `Tests completed, but KiroSight could not parse the test summary.${exit} See KiroSight Tests for the full output.`;
    }
    case 'passed': {
      const counts = countText(summary);
      const suffix = summary.outputTruncated ? ' The output was truncated.' : '';
      return `${counts || 'Tests passed.'}${suffix}`;
    }
    case 'failed': {
      const counts = countText(summary);
      const names = summary.failingTests.slice(0, 5).map(({ name }) => name);
      const nameText = names.length === 0
        ? ' No failing test names were available.'
        : ` Failing tests: ${names.join('; ')}.`;
      const moreText = summary.failed !== null && summary.failed > 5
        ? ' Say "list all failures" or open the KiroSight Tests output for the full stored failure list.'
        : '';
      const truncation = summary.outputTruncated ? ' The output was truncated.' : '';
      return `Tests failed${counts ? `: ${counts}` : '.'}${nameText}${moreText}${truncation}`;
    }
  }
}

/** Formats a concrete confirmation request without changing or interpreting its target. */
export function formatConfirmation(action: Action, target: string): string {
  return `${actionLabel(action)} using "${target}"? Reply ${ACCEPTED_CONFIRMATION_REPLIES}.`;
}

/** Formats the concise response to an unrecognized pending-confirmation reply. */
export function formatConfirmationReprompt(action: Action): string {
  return `${actionLabel(action)} is waiting for confirmation. Say ${ACCEPTED_CONFIRMATION_REPLIES}.`;
}

/** Purely formats an ActionResult; it performs no I/O or execution. */
export function formatActionResult(result: ActionResult): string {
  if (result.details?.kind === 'test_run') {
    return formatTestResult(result.details.summary);
  }

  if (result.status === 'ok' && result.details !== undefined) {
    return formatDetails(result.details);
  }

  if (result.status === 'ok') {
    return result.message;
  }

  if (result.status === 'needs_clarification' && result.details?.kind === 'ambiguous_files') {
    return formatDetails(result.details);
  }

  if (result.status === 'declined') {
    return `Action declined: ${result.message}`;
  }

  if (result.status === 'not_permitted') {
    return `Action not permitted: ${result.message}`;
  }

  if (result.status === 'not_configured') {
    return `Action is not configured: ${result.message}`;
  }

  return result.message;
}
