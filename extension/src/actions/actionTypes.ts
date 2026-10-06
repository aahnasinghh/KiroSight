export type Severity = 'error' | 'warning' | 'any';

export type Action =
  | { type: 'NO_ACTION' }
  | { type: 'GO_TO_DIAGNOSTIC'; index: number; severity?: Severity }
  | { type: 'NEXT_DIAGNOSTIC'; severity?: Severity }
  | { type: 'PREVIOUS_DIAGNOSTIC'; severity?: Severity }
  | { type: 'OPEN_FILE'; path: string }
  | { type: 'GO_TO_LINE'; line: number }
  | { type: 'FOCUS_EDITOR' }
  | { type: 'RUN_TESTS' };
