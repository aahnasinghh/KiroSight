import type { Action } from '../actions/actionTypes';

export type LocalIntent =
  | { kind: 'WHERE_AM_I' }
  | { kind: 'CURRENT_SYMBOL' }
  | { kind: 'READ_SELECTION' }
  | { kind: 'DESCRIBE_DIAGNOSTICS'; scope: 'file' | 'workspace' }
  | { kind: 'ACTION'; action: Action }
  | { kind: 'SUMMARIZE_LAST_TEST_RUN' }
  | { kind: 'LIST_TEST_FAILURES' }
  | { kind: 'HELP' };

export type RouteResult =
  | { route: 'local'; intent: LocalIntent }
  | { route: 'agent'; reason: 'semantic' | 'unrecognized' | 'ambiguous' };
