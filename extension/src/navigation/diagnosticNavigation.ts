import type { Severity } from '../actions/actionTypes';
import { compareForNavigation } from '../context/diagnosticsService';
import type { DiagnosticInfo } from '../context/editorAdapter';

export interface DiagnosticLocation {
  relativePath: string;
  line: number;
}

export type DiagnosticNavigationResult =
  | { status: 'ok'; diagnostic: DiagnosticInfo; wrapped: boolean }
  | { status: 'failed'; message: 'No matching diagnostic was found' };

const NO_MATCH: DiagnosticNavigationResult = {
  status: 'failed',
  message: 'No matching diagnostic was found',
};

function filterBySeverity(
  diagnostics: readonly DiagnosticInfo[],
  severity: Severity | undefined,
): DiagnosticInfo[] {
  if (severity === undefined || severity === 'any') {
    return [...diagnostics];
  }

  return diagnostics.filter((diagnostic) => diagnostic.severity === severity);
}

function stableNavigationSort(diagnostics: readonly DiagnosticInfo[]): DiagnosticInfo[] {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort(({ diagnostic: left, index: leftIndex }, { diagnostic: right, index: rightIndex }) =>
      compareForNavigation(left, right) || leftIndex - rightIndex,
    )
    .map(({ diagnostic }) => diagnostic);
}

function candidates(
  diagnostics: readonly DiagnosticInfo[],
  severity: Severity | undefined,
): DiagnosticInfo[] {
  return stableNavigationSort(filterBySeverity(diagnostics, severity));
}

function compareToLocation(diagnostic: DiagnosticInfo, location: DiagnosticLocation): number {
  return compareForNavigation(diagnostic, {
    ...diagnostic,
    relativePath: location.relativePath,
    line: location.line,
  });
}

export function resolve(
  diagnostics: readonly DiagnosticInfo[],
  index: number,
  severity?: Severity,
): DiagnosticNavigationResult {
  const matching = candidates(diagnostics, severity);
  const diagnostic = matching[index];
  return diagnostic === undefined
    ? NO_MATCH
    : { status: 'ok', diagnostic, wrapped: false };
}

export function next(
  diagnostics: readonly DiagnosticInfo[],
  current: DiagnosticLocation,
  severity?: Severity,
): DiagnosticNavigationResult {
  const matching = candidates(diagnostics, severity);
  const diagnostic = matching.find((candidate) => compareToLocation(candidate, current) > 0);

  if (diagnostic !== undefined) {
    return { status: 'ok', diagnostic, wrapped: false };
  }

  return matching.length === 0
    ? NO_MATCH
    : { status: 'ok', diagnostic: matching[0]!, wrapped: true };
}

export function previous(
  diagnostics: readonly DiagnosticInfo[],
  current: DiagnosticLocation,
  severity?: Severity,
): DiagnosticNavigationResult {
  const matching = candidates(diagnostics, severity);
  let diagnostic: DiagnosticInfo | undefined;

  for (const candidate of matching) {
    if (compareToLocation(candidate, current) < 0) {
      diagnostic = candidate;
    } else {
      break;
    }
  }

  if (diagnostic !== undefined) {
    return { status: 'ok', diagnostic, wrapped: false };
  }

  return matching.length === 0
    ? NO_MATCH
    : { status: 'ok', diagnostic: matching[matching.length - 1]!, wrapped: true };
}
