import type { ActionResult } from '../actions/actionResult';
import type { BackendClientError, ConnectionState } from '../backend/backendClient';
import type { AgentContextSource } from '../backend/agentGateway';
import type { GateResolution } from '../confirmation/confirmationController';
import { toWireContext } from '../context/contextService';
import { PROTOCOL_VERSION } from '../protocol/constants';
import type { AgentRequest, AgentResponse } from '../protocol/messages';
import { MAX_FAILING_TESTS, type TestRunSummary } from '../testing/testOutputParser';
import type { Result } from '../util/result';

/**
 * After a test run that really failed, asks the backend for a short spoken-style summary of the
 * failures and hands it to the transcript (Task 7.11; Req 7.5, design Sequence 4).
 *
 * The deterministic result text is always shown first, by the normal path. This only ever adds to
 * it, so it can fall back to nothing:
 * - the backend is not connected: no request is made;
 * - the request fails, times out, or the answer is empty: nothing is added;
 * - the answer carries an action: it is ignored. A summary is text, and nothing here can run an
 *   action, so a hostile or mistaken `action` cannot do anything.
 *
 * What is sent is bounded: at most `MAX_FAILING_TESTS` failing tests, no command line, and a
 * context with no code excerpt and no diagnostics list.
 */

/** The slice of BackendClient this class uses. BackendClient satisfies it structurally. */
export interface SummaryClient {
  readonly state: ConnectionState;
  requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>>;
}

export interface TestRunSummarizerDeps {
  readonly client: SummaryClient;
  readonly context: AgentContextSource;
  /** Appends the summary to the transcript (and so to the live region and, later, speech). */
  readonly present: (text: string) => void;
}

/** Clip for one failing test's name or excerpt on the wire; the backend clips again in its prompt. */
const MAX_FIELD_CHARS = 500;

/** The parsed run to summarize, or null when this result is not a run that failed. */
export function failedRunOf(result: ActionResult): TestRunSummary | null {
  return result.details?.kind === 'test_run' && result.details.summary.outcome === 'failed'
    ? result.details.summary
    : null;
}

function bounded(summary: TestRunSummary): TestRunSummary {
  return {
    ...summary,
    command: '', // the backend never needs the command line
    failingTests: summary.failingTests.slice(0, MAX_FAILING_TESTS).map((test) => ({
      name: test.name.slice(0, MAX_FIELD_CHARS),
      ...(test.messageExcerpt === undefined ? {} : { messageExcerpt: test.messageExcerpt.slice(0, MAX_FIELD_CHARS) }),
    })),
  };
}

export class TestRunSummarizer {
  private counter = 0;

  public constructor(private readonly deps: TestRunSummarizerDeps) {}

  /** Observes how a confirmation ended, for local and agent requests alike. */
  public onResolution(resolution: GateResolution): void {
    const run = failedRunOf(resolution.result);
    if (run !== null) void this.summarizeAndPresent(run);
  }

  /** Requests a summary and presents it. Resolves when finished; never rejects. */
  public async summarizeAndPresent(summary: TestRunSummary): Promise<void> {
    const text = await this.summarize(summary);
    if (text !== null) this.deps.present(text);
  }

  /** The summary text, or null when there is none and the deterministic text should stand alone. */
  public async summarize(summary: TestRunSummary): Promise<string | null> {
    if (summary.outcome !== 'failed' || this.deps.client.state !== 'connected') return null;
    try {
      const context = await this.deps.context.getContext();
      // Only the counts and the current location travel: no code excerpt, no diagnostic messages.
      const wireContext = toWireContext({ ...context, nearbyCode: null, diagnostics: [] });
      this.counter += 1;
      const result = await this.deps.client.requestAgent({
        version: PROTOCOL_VERSION,
        type: 'agent_request',
        id: `sum-${this.counter}`,
        kind: 'summarize_test_run',
        context: wireContext,
        testRun: bounded(summary),
      });
      if (!result.ok) return null;
      const speech = result.value.speech.trim();
      return speech === '' ? null : speech;
    } catch {
      return null;
    }
  }
}
