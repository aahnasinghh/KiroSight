import type { ErrorCode } from '../protocol/messages';

/**
 * Fixed user-facing text for explanation requests (Task 7.10; Req 12.3, 12.4, 12.5; design F2 and
 * F6). Every message names a concrete fact (a file, a line, a missing prerequisite) and none of
 * them copies backend, provider or model text. They are plain sentences, safe to speak aloud and to
 * read in the transcript.
 */

const LOCAL_STILL_WORKS =
  'Local commands like where am I, errors, go to line and run tests still work.';

// --- local reports: the backend is never called for these ----------------------------------------

/** Req 12.4. The first sentence is the required statement; the second says why. */
export function noMatchingDiagnosticText(relativePath: string | null): string {
  return relativePath === null
    ? 'No matching diagnostic was found because no file is open.'
    : `No matching diagnostic was found. There are no errors, warnings or hints in ${relativePath}.`;
}

export interface NothingToExplainFacts {
  /** Which request could not be served. */
  readonly target: 'function' | 'selection';
  /** The active file's workspace-relative path, or null when no file is open. */
  readonly relativePath: string | null;
  /** The cursor's 1-indexed line, when there is one. */
  readonly line: number | null;
  /** Result of the enclosing-symbol lookup at the cursor. */
  readonly symbolStatus: 'found' | 'none_enclosing' | 'provider_unavailable';
  readonly hasSelection: boolean;
}

/**
 * Req 12.5. States that no function or selection is available, then the specific reason, and, when
 * the other kind of target does exist, how to ask for it. Never produces an explanation.
 */
export function noFunctionOrSelectionText(facts: NothingToExplainFacts): string {
  const head = 'No function or selection is available to explain.';
  if (facts.relativePath === null) return `${head} No file is open.`;

  if (facts.target === 'function') {
    const reason = facts.symbolStatus === 'provider_unavailable'
      ? "The symbol provider is unavailable, so I can't find the enclosing function."
      : facts.line === null
        ? `There is no function at the cursor in ${facts.relativePath}.`
        : `The cursor at line ${facts.line} of ${facts.relativePath} is not inside a function.`;
    return facts.hasSelection
      ? `${head} ${reason} Text is selected, so you can ask me to explain the selection instead.`
      : `${head} ${reason} Nothing is selected either.`;
  }

  return facts.symbolStatus === 'found'
    ? `${head} Nothing is selected in ${facts.relativePath}. You can ask me to explain the function instead.`
    : `${head} Nothing is selected in ${facts.relativePath}, and the cursor is not inside a function.`;
}

// --- reasoning failures reported by the backend --------------------------------------------------

/** Req 12.3 and design F2: the exact statement that opens every reasoning-failure message. */
export const REASONING_FAILED_TEXT =
  "The explanation couldn't be generated because the reasoning service failed.";

/** Design F6, verbatim. */
export const INVALID_REASONING_RESPONSE_TEXT =
  "I couldn't understand the reasoning service's answer, so I did nothing. Please try rephrasing.";

/**
 * The stated error for a backend `error_message`, or null when `code` is not a reasoning failure
 * (the caller then keeps its generic text). Nothing is retried against another provider.
 *
 * It does not claim anything about Bedrock beyond the failure: configured credentials are not
 * availability, so `CREDENTIAL_MISSING` and `BEDROCK_UNAVAILABLE` get different, honest reasons.
 */
export function describeReasoningFailure(code: ErrorCode, recoverable: boolean | undefined): string | null {
  switch (code) {
    case 'BEDROCK_UNAVAILABLE':
      return `${REASONING_FAILED_TEXT} Amazon Bedrock did not complete the request. `
        + `${recoverable === false ? '' : 'You can try again. '}${LOCAL_STILL_WORKS}`;
    case 'CREDENTIAL_MISSING':
      return `${REASONING_FAILED_TEXT} The backend has no Amazon Bedrock credentials configured. `
        + LOCAL_STILL_WORKS;
    case 'BEDROCK_INVALID_RESPONSE':
      return `${INVALID_REASONING_RESPONSE_TEXT} ${LOCAL_STILL_WORKS}`;
    default:
      return null;
  }
}
