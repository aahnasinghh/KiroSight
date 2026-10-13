import { describe, expect, it } from 'vitest';

import type { ActionResult } from '../../src/actions/actionResult';
import type { BackendClientError, ConnectionState } from '../../src/backend/backendClient';
import type { IDEContext } from '../../src/context/editorAdapter';
import { TestRunSummarizer, failedRunOf, type SummaryClient } from '../../src/pipeline/testRunSummarizer';
import type { AgentRequest, AgentResponse } from '../../src/protocol/messages';
import { validateProtocolMessage } from '../../src/protocol/validators';
import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { err, ok, type Result } from '../../src/util/result';

const COMMAND = 'npm test -- --secret-flag';

function run(changes: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: 'failed', command: COMMAND, exitCode: 1, passed: 4, failed: 2, totalFailedNames: 2,
    failingTests: [{ name: 'a > b', messageExcerpt: 'expected 1 to be 2' }, { name: 'c > d' }],
    outputTruncated: false, durationMs: 120, ...changes,
  };
}

function result(summary: TestRunSummary, status: ActionResult['status'] = 'failed'): ActionResult {
  return { actionType: 'RUN_TESTS', status, message: 'x', details: { kind: 'test_run', summary } };
}

const context = {
  workspace: { name: 'w', rootCount: 1 },
  activeFile: 'C:/private/work/src/a.ts',
  relativePath: 'src/a.ts',
  languageId: 'typescript',
  cursor: { line: 3, column: 1 },
  selection: { isEmpty: true },
  nearbyCode: { source: 'symbol', startLine: 1, endLine: 5, text: 'PRIVATE_SOURCE_CODE', truncated: false },
  currentSymbol: null,
  symbolStatus: 'none_enclosing',
  diagnostics: [{ severity: 'error', relativePath: 'src/a.ts', line: 3, column: 1, message: 'PRIVATE_DIAGNOSTIC' }],
  diagnosticCounts: { error: 1, warning: 0, information: 0, hint: 0 },
} as IDEContext;

function response(replyTo: string, speech: string, action: object = { type: 'NO_ACTION' }): AgentResponse {
  return { version: 1, type: 'agent_response', replyTo, speech, action: action as never, confirmationRequired: false };
}

class FakeClient implements SummaryClient {
  public state: ConnectionState = 'connected';
  public readonly requests: AgentRequest[] = [];
  public answer: (request: AgentRequest) => Result<AgentResponse, BackendClientError> =
    (request) => ok(response(request.id, 'Two tests failed in the auth suite. Want the names?'));

  public requestAgent(request: AgentRequest): Promise<Result<AgentResponse, BackendClientError>> {
    this.requests.push(request);
    return Promise.resolve(this.answer(request));
  }
}

function build() {
  const client = new FakeClient();
  const presented: string[] = [];
  const summarizer = new TestRunSummarizer({
    client, context: { getContext: () => Promise.resolve(context) }, present: (text) => presented.push(text),
  });
  return { client, presented, summarizer };
}

describe('failedRunOf', () => {
  it('returns the run only for a test run that really failed', () => {
    expect(failedRunOf(result(run()))).not.toBeNull();
    for (const outcome of ['passed', 'completed_unparsed', 'did_not_execute', 'timed_out', 'cancelled', 'not_configured'] as const) {
      expect(failedRunOf(result(run({ outcome })))).toBeNull();
    }
    expect(failedRunOf({ actionType: 'GO_TO_LINE', status: 'failed', message: 'x' })).toBeNull();
  });
});

describe('TestRunSummarizer', () => {
  it('sends a valid, bounded summarize_test_run request and returns the summary', async () => {
    const { client, summarizer } = build();

    const text = await summarizer.summarize(run());

    expect(text).toBe('Two tests failed in the auth suite. Want the names?');
    expect(client.requests).toHaveLength(1);
    const request = client.requests[0]!;
    expect(request).toMatchObject({ version: 1, type: 'agent_request', kind: 'summarize_test_run' });
    expect(request).not.toHaveProperty('utterance');
    expect(request.testRun).toMatchObject({ outcome: 'failed', passed: 4, failed: 2 });
    expect(validateProtocolMessage(JSON.parse(JSON.stringify(request))).ok).toBe(true);
  });

  it('never sends the command line, a code excerpt, diagnostics or an absolute path', async () => {
    const { client, summarizer } = build();

    await summarizer.summarize(run());

    const wire = JSON.stringify(client.requests[0]);
    expect(wire).not.toContain('secret-flag');
    expect(wire).not.toContain('PRIVATE_SOURCE_CODE');
    expect(wire).not.toContain('PRIVATE_DIAGNOSTIC');
    expect(wire).not.toContain('C:/private');
    expect(client.requests[0]!.context.diagnosticCounts.error).toBe(1); // counts still travel
  });

  it('bounds the failing tests and their text', async () => {
    const { client, summarizer } = build();
    const many = Array.from({ length: 40 }, (_, index) => ({ name: `case_${index} ${'n'.repeat(900)}`, messageExcerpt: 'm'.repeat(900) }));

    await summarizer.summarize(run({ failed: 40, totalFailedNames: 40, failingTests: many }));

    const sent = client.requests[0]!.testRun!;
    expect(sent.failingTests).toHaveLength(20);
    expect(sent.failingTests.every((test) => test.name.length <= 500 && (test.messageExcerpt?.length ?? 0) <= 500)).toBe(true);
    expect(sent.totalFailedNames).toBe(40);
  });

  it.each(['disconnected', 'connecting', 'incompatible'] as const)('makes no request while the backend is %s', async (state) => {
    const { client, summarizer } = build();
    client.state = state;

    expect(await summarizer.summarize(run())).toBeNull();
    expect(client.requests).toEqual([]);
  });

  it('does not summarize a run that did not fail', async () => {
    const { client, summarizer } = build();
    expect(await summarizer.summarize(run({ outcome: 'passed', failed: 0 }))).toBeNull();
    expect(client.requests).toEqual([]);
  });

  it('falls back to nothing when the backend fails, times out or answers with nothing', async () => {
    const { client, summarizer } = build();

    client.answer = () => err({ kind: 'timeout', message: 'slow' });
    expect(await summarizer.summarize(run())).toBeNull();
    client.answer = () => err({ kind: 'backend_error', message: 'x', backendCode: 'BEDROCK_UNAVAILABLE', recoverable: true });
    expect(await summarizer.summarize(run())).toBeNull();
    client.answer = (request) => ok(response(request.id, '   '));
    expect(await summarizer.summarize(run())).toBeNull();
  });

  it('survives a client or context that throws', async () => {
    const { client, summarizer } = build();
    client.answer = () => { throw new Error('boom'); };
    expect(await summarizer.summarize(run())).toBeNull();

    const broken = new TestRunSummarizer({
      client: new FakeClient(),
      context: { getContext: () => Promise.reject(new Error('no context')) },
      present: () => undefined,
    });
    expect(await broken.summarize(run())).toBeNull();
  });

  it('ignores any action in the answer: a summary is text and can run nothing', async () => {
    const { client, summarizer, presented } = build();
    client.answer = (request) => ok(response(request.id, 'Two tests failed.', { type: 'RUN_TESTS' }));

    await summarizer.summarizeAndPresent(run());

    expect(presented).toEqual(['Two tests failed.']);
  });

  it('presents the summary only when a failed run is resolved, for local and agent origins alike', async () => {
    const { client, presented, summarizer } = build();

    summarizer.onResolution({ origin: 'local', correlationId: 'local-1', result: result(run()) });
    summarizer.onResolution({ origin: 'agent', correlationId: 'R1', result: result(run()) });
    summarizer.onResolution({ origin: 'agent', correlationId: 'R2', result: result(run({ outcome: 'passed', failed: 0 }), 'ok') });
    summarizer.onResolution({ origin: 'agent', correlationId: 'R3', result: { actionType: 'GO_TO_LINE', status: 'ok', message: 'x' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.requests.map((request) => request.id)).toEqual(['sum-1', 'sum-2']);
    expect(presented).toHaveLength(2);
  });
});
