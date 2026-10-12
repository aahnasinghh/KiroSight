import type { Action } from '../actions/actionTypes';
import { validateAction } from '../actions/actionValidator';
import { normalize } from './normalize';
import type { LocalIntent, RouteResult } from './intentTypes';

interface Rule {
  matches: (text: string) => boolean;
  intent: (text: string) => LocalIntent | undefined;
}

const exact = (phrases: readonly string[], intent: LocalIntent): Rule => ({
  matches: (text) => phrases.includes(text),
  intent: () => intent,
});

const rules: readonly Rule[] = [
  exact(['where am i', 'what file am i in', 'what file is this'], { kind: 'WHERE_AM_I' }),
  exact(['what function am i in', 'read the current function', 'current function'], { kind: 'CURRENT_SYMBOL' }),
  exact(['read the selection', 'read selection'], { kind: 'READ_SELECTION' }),
  exact(['what errors are there', 'list errors', 'what problems are there'], {
    kind: 'DESCRIBE_DIAGNOSTICS', scope: 'workspace',
  }),
  exact(['what errors are in this file', 'errors in this file'], {
    kind: 'DESCRIBE_DIAGNOSTICS', scope: 'file',
  }),
  exact(['next error', 'next problem'], {
    kind: 'ACTION', action: { type: 'NEXT_DIAGNOSTIC', severity: 'error' },
  }),
  exact(['previous error', 'previous problem'], {
    kind: 'ACTION', action: { type: 'PREVIOUS_DIAGNOSTIC', severity: 'error' },
  }),
  exact(['focus editor', 'back to editor'], {
    kind: 'ACTION', action: { type: 'FOCUS_EDITOR' },
  }),
  exact(['run my tests', 'run tests', 'run the tests'], {
    kind: 'ACTION', action: { type: 'RUN_TESTS' },
  }),
  exact(['summarize the test failures'], { kind: 'SUMMARIZE_LAST_TEST_RUN' }),
  exact(['list all failures'], { kind: 'LIST_TEST_FAILURES' }),
  exact(['help', 'what can you do'], { kind: 'HELP' }),
  {
    matches: (text) => /^go to (?:the )?[123] error$/.test(text),
    intent: (text) => {
      const match = /^go to (?:the )?([123]) error$/.exec(text);
      return match === null ? undefined : {
        kind: 'ACTION', action: {
          type: 'GO_TO_DIAGNOSTIC', index: Number(match[1]) - 1, severity: 'error',
        },
      };
    },
  },
  {
    matches: (text) => /^(?:go to line|line) \d+$/.test(text),
    intent: (text) => {
      const match = /^(?:go to line|line) (\d+)$/.exec(text);
      if (match === null) return undefined;
      const line = Number(match[1]);
      return Number.isSafeInteger(line) && line >= 1
        ? { kind: 'ACTION', action: { type: 'GO_TO_LINE', line } }
        : undefined;
    },
  },
  {
    matches: (text) => /^open [^ ]+$/.test(text),
    intent: (text) => {
      const path = /^open ([^ ]+)$/.exec(text)?.[1];
      if (path === undefined || /^(?:[A-Za-z]:[\\/]|[\\]{2}|\/)/.test(path)) return undefined;
      return { kind: 'ACTION', action: { type: 'OPEN_FILE', path } };
    },
  },
];

function agent(reason: 'semantic' | 'unrecognized' | 'ambiguous'): RouteResult {
  return { route: 'agent', reason };
}

function validateLocalAction(intent: LocalIntent): RouteResult {
  if (intent.kind !== 'ACTION') return { route: 'local', intent };
  const result = validateAction(intent.action, 'local');
  return result.ok ? { route: 'local', intent } : agent('unrecognized');
}

/** Applies the router's exactly-one-match policy to already matched local intents. */
export function applyExactlyOneMatchPolicy(matches: readonly LocalIntent[]): RouteResult {
  if (matches.length === 0) return agent('unrecognized');
  if (matches.length > 1) return agent('ambiguous');
  return validateLocalAction(matches[0]!);
}

export function route(utterance: string): RouteResult {
  const text = normalize(utterance);
  if (text === '') return agent('unrecognized');

  if (
    /^(?:explain|why|what does|how do|summarize)(?: |$)/.test(text)
    && text !== 'summarize the test failures'
  ) {
    return agent('semantic');
  }

  const matches = rules
    .filter((rule) => rule.matches(text))
    .map((rule) => rule.intent(text))
    .filter((intent): intent is LocalIntent => intent !== undefined);

  return applyExactlyOneMatchPolicy(matches);
}

export { normalize };
