import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AgentGateway, AgentGatewayResult, AgentRelayInfo } from '../../src/pipeline/inputPipeline';
import { InputPipeline } from '../../src/pipeline/inputPipeline';
import { route } from '../../src/intent/localIntentRouter';
import { TranscriptStore } from '../../src/transcript/transcriptStore';
import type { ConnectionState } from '../../src/backend/backendClient';

const BACKEND_STATES: readonly ConnectionState[] = [
  'connected',
  'disconnected',
  'connecting',
  'incompatible',
];

class RecordingGateway implements AgentGateway {
  public readonly calls: Array<{ text: string; info: AgentRelayInfo | undefined }> = [];

  public constructor(public readonly state: ConnectionState) {}

  public isAvailable(): boolean {
    return this.state === 'connected';
  }

  public respond(text: string, info?: AgentRelayInfo): Promise<AgentGatewayResult> {
    this.calls.push({ text, info });
    return Promise.resolve({ status: 'handled', text: 'agent response' });
  }
}

const localCommandArb = fc.oneof(
  fc.constantFrom(
    'where am I',
    'what file am I in',
    'what file is this',
    'what function am I in',
    'read the current function',
    'current function',
    'read the selection',
    'read selection',
    'what errors are there',
    'list errors',
    'what problems are there',
    'what errors are in this file',
    'errors in this file',
    'next error',
    'next problem',
    'previous error',
    'previous problem',
    'focus editor',
    'back to editor',
    'run my tests',
    'run tests',
    'run the tests',
    'summarize the test failures',
    'list all failures',
    'help',
    'what can you do',
    'open auth.ts',
    'open src/fixture.ts',
  ),
  fc.integer({ min: 1, max: 100 }).chain((line) =>
    fc.constantFrom(`go to line ${line}`, `line ${line}`)),
  fc.integer({ min: 1, max: 3 }).chain((index) =>
    fc.constantFrom(`go to ${index} error`, `go to the ${index} error`)),
);

const decoratedLocalCommandArb = fc.record({
  command: localCommandArb,
  prefix: fc.constantFrom('', 'please ', 'can you ', 'could you ', 'kirosight '),
  leading: fc.constantFrom('', ' ', '  '),
  trailing: fc.constantFrom('', ' ', '  '),
  uppercase: fc.boolean(),
}).map(({ command, prefix, leading, trailing, uppercase }) => {
  const text = `${leading}${prefix}${command}${trailing}`;
  return uppercase ? text.toLocaleUpperCase() : text;
});

function runLocalCommand(text: string, state: ConnectionState) {
  const gateway = new RecordingGateway(state);
  const transcript = new TranscriptStore();
  const localKinds: string[] = [];
  const notices: string[] = [];
  const pipeline = new InputPipeline({
    transcript,
    localIntents: {
      handleIntent: async (intent) => {
        localKinds.push(intent.kind);
        return `local:${intent.kind}`;
      },
    },
    agent: gateway,
    onBackendUnavailable: (notice) => notices.push(notice.message),
  });
  return { gateway, transcript, localKinds, notices, pipeline };
}

describe('Property 33: Local commands never relay and never depend on the backend', () => {
  it('handles every generated local command locally across all backend states', async () => {
    await fc.assert(
      fc.asyncProperty(decoratedLocalCommandArb, async (text) => {
        const routed = route(text);
        expect(routed.route).toBe('local');

        const outcomes = await Promise.all(BACKEND_STATES.map(async (state) => {
          const run = runLocalCommand(text, state);
          const status = await run.pipeline.handle(text, 'typed');
          return { ...run, status };
        }));

        for (const outcome of outcomes) {
          expect(outcome.status).toBe('handled');
          expect(outcome.gateway.calls).toHaveLength(0);
          expect(outcome.localKinds).toHaveLength(1);
          expect(outcome.notices).toHaveLength(0);
          expect(outcome.transcript.getEntries().map(({ role, text: entryText }) => [role, entryText]))
            .toEqual([
              ['user', text],
              ['kirosight', `local:${outcome.localKinds[0]}`],
            ]);
        }

        const localKinds = outcomes.map((outcome) => outcome.localKinds[0]);
        expect(new Set(localKinds).size).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});
