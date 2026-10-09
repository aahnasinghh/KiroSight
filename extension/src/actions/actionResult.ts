import type { Action } from './actionTypes';

export type ActionResultStatus =
  | 'ok'
  | 'failed'
  | 'declined'
  | 'not_permitted'
  | 'needs_clarification'
  | 'not_configured';

/** Display-oriented detail data. Only workspace-relative paths appear here. */
export type ActionResultDetails =
  | { kind: 'file_opened'; relativePath: string }
  | {
      kind: 'diagnostic_reached';
      relativePath: string;
      line: number;
      severity: string;
      message: string;
      symbol?: string;
      wrapped?: boolean;
    }
  | { kind: 'location_reached'; relativePath: string; line: number }
  | { kind: 'ambiguous_files'; matches: string[]; totalMatches: number };

export interface ActionResult {
  actionType: Action['type'];
  status: ActionResultStatus;
  /** Concrete outcome or reason (Req 16.5, 16.6). */
  message: string;
  details?: ActionResultDetails;
}
