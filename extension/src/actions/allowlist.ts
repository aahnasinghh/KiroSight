import type { Action } from './actionTypes';

export type Risk = 'safe' | 'needs-confirmation';

export const ALLOWLIST: Readonly<Record<Action['type'], { risk: Risk }>> = {
  NO_ACTION: { risk: 'safe' },
  GO_TO_DIAGNOSTIC: { risk: 'safe' },
  NEXT_DIAGNOSTIC: { risk: 'safe' },
  PREVIOUS_DIAGNOSTIC: { risk: 'safe' },
  OPEN_FILE: { risk: 'safe' },
  GO_TO_LINE: { risk: 'safe' },
  FOCUS_EDITOR: { risk: 'safe' },
  RUN_TESTS: { risk: 'needs-confirmation' },
};
