import type {
  DiagnosticInfo,
  EditorAdapter,
  RawDiagnostic,
} from './editorAdapter';
import { MAX_DIAGNOSTIC_MESSAGE_CHARS } from './contextWindow';

export type DiagnosticScope = 'workspace' | 'current_file';

export type DiagnosticsResult =
  | { status: 'ok'; diagnostics: DiagnosticInfo[] }
  | { status: 'no_file_open'; diagnostics: [] }
  | { status: 'no_diagnostics'; diagnostics: [] };

const SEVERITY_ORDER: Record<DiagnosticInfo['severity'], number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Orders diagnostics for reports by severity, workspace-relative path, then line. */
export function compareForReport(left: DiagnosticInfo, right: DiagnosticInfo): number {
  const severityDifference = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severityDifference !== 0) {
    return severityDifference;
  }

  const pathDifference = compareStrings(left.relativePath, right.relativePath);
  if (pathDifference !== 0) {
    return pathDifference;
  }

  return left.line - right.line;
}

/** Orders diagnostics for navigation by workspace-relative path, then line. */
export function compareForNavigation(left: DiagnosticInfo, right: DiagnosticInfo): number {
  const pathDifference = compareStrings(left.relativePath, right.relativePath);
  return pathDifference !== 0 ? pathDifference : left.line - right.line;
}

function stableSort<T>(values: readonly T[], comparator: (left: T, right: T) => number): T[] {
  return values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => comparator(left.value, right.value) || left.index - right.index)
    .map(({ value }) => value);
}

function mapDiagnostic(diagnostic: RawDiagnostic): DiagnosticInfo {
  return {
    severity: diagnostic.severity,
    relativePath: diagnostic.relativePath,
    line: diagnostic.range.start.line,
    column: diagnostic.range.start.column,
    message: diagnostic.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS),
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
    ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
  };
}

function noDiagnosticsResult(diagnostics: DiagnosticInfo[]): DiagnosticsResult {
  return diagnostics.length === 0
    ? { status: 'no_diagnostics', diagnostics: [] }
    : { status: 'ok', diagnostics };
}

export class DiagnosticsService {
  public constructor(private readonly adapter: EditorAdapter) {}

  /**
   * Workspace diagnostics in the same order as getDiagnostics('workspace'), plus an
   * identity map from each returned DiagnosticInfo to its trusted internal fsPath.
   * DiagnosticInfo itself stays free of absolute paths; the map is for navigation only.
   */
  public getWorkspaceNavigationTargets(): {
    diagnostics: DiagnosticInfo[];
    fsPaths: Map<DiagnosticInfo, string>;
  } {
    const entries = stableSort(
      this.adapter.allDiagnostics().map((raw) => ({ info: mapDiagnostic(raw), fsPath: raw.fsPath })),
      (left, right) => compareForReport(left.info, right.info),
    );
    return {
      diagnostics: entries.map(({ info }) => info),
      fsPaths: new Map(entries.map(({ info, fsPath }) => [info, fsPath])),
    };
  }

  public getDiagnostics(scope: DiagnosticScope): DiagnosticsResult {
    if (scope === 'current_file') {
      const snapshot = this.adapter.snapshot();
      if (snapshot === null || snapshot.file === null) {
        return { status: 'no_file_open', diagnostics: [] };
      }

      const diagnostics = stableSort(
        this.adapter
          .allDiagnostics()
          .filter((diagnostic) => diagnostic.fsPath === snapshot.file?.fsPath)
          .map(mapDiagnostic),
        compareForNavigation,
      );

      return noDiagnosticsResult(diagnostics);
    }

    const diagnostics = stableSort(
      this.adapter.allDiagnostics().map(mapDiagnostic),
      compareForReport,
    );

    return noDiagnosticsResult(diagnostics);
  }
}
