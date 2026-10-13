import { normalize } from './normalize';

/**
 * What an explanation request is about (Task 7.10, Req 12.1 and 12.2):
 * - `diagnostic`: the diagnostic at the cursor, otherwise the first one in the file;
 * - `function`: the function (symbol) around the cursor;
 * - `selection`: the current non-empty selection.
 */
export type ExplainTarget = 'diagnostic' | 'function' | 'selection';

/**
 * Anchored patterns over the whole normalized utterance, like the local router's rule table. A
 * partial match does not count, so "explain this error and fix it" is not an explanation request
 * (it stays an ordinary agent-routed utterance and can never carry a hidden second request).
 */
const PATTERNS: ReadonlyArray<readonly [ExplainTarget, RegExp]> = [
  ['diagnostic', /^explain (?:this|the|that|current) (?:error|problem|diagnostic|warning)$/],
  ['diagnostic', /^explain (?:error|problem|diagnostic|warning)$/],
  ['diagnostic', /^what does (?:this|the|that) (?:error|problem|diagnostic|warning) (?:mean|say)$/],
  ['function', /^explain (?:this|the|that|current|the current) (?:function|method)$/],
  ['function', /^explain (?:function|method)$/],
  ['function', /^explain what (?:this|the|that) (?:function|method) does$/],
  ['function', /^what does (?:this|the|that) (?:function|method) do$/],
  ['selection', /^explain (?:this|the|that|current|the current) (?:selection|selected code|selected text)$/],
  ['selection', /^explain selection$/],
  ['selection', /^explain what (?:is|s) selected$/],
];

/**
 * Pure and synchronous: reads nothing from the IDE. Returns the explanation target for an exact
 * explanation phrase, or `null` for anything else. It never produces an action.
 */
export function parseExplainIntent(utterance: string): ExplainTarget | null {
  // normalize() keeps '.' (file names need it), but a sentence-ending period is not part of the phrase.
  const text = normalize(utterance).replace(/\.+$/, '').trim();
  if (text === '') return null;
  const targets = new Set(PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([target]) => target));
  // The patterns are disjoint; refusing a double match keeps the "exactly one" policy explicit.
  return targets.size === 1 ? [...targets][0]! : null;
}
