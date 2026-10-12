import { redact } from '../util/redact';

/** The approved outcome set. This parser only ever produces the first three. */
export type TestRunOutcome =
  | 'passed' | 'failed'
  | 'completed_unparsed'
  | 'did_not_execute'
  | 'timed_out' | 'cancelled' | 'not_configured';

export interface FailingTest {
  name: string;
  /** At most MAX_EXCERPT_CHARS characters, after redaction. */
  messageExcerpt?: string;
}

export interface TestRunSummary {
  outcome: TestRunOutcome;
  command: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  /** The true failed count from the runner's own summary, even when the detail list is capped. */
  totalFailedNames: number;
  failingTests: FailingTest[];
  outputTruncated: boolean;
  durationMs: number;
}

/** The completed run, as supplied by the caller. The parser only reads `output` and `exitCode`. */
export interface TestOutputInput {
  readonly output: string;
  readonly exitCode: number | null;
  readonly command: string;
  readonly outputTruncated: boolean;
  readonly durationMs: number;
}

export const MAX_FAILING_TESTS = 20;
export const MAX_EXCERPT_CHARS = 300;
const MAX_NAME_CHARS = 300;
/** Raw context taken per failure before redaction; the final excerpt is cut after redaction. */
const MAX_RAW_CONTEXT_CHARS = 4000;

interface Parsed {
  readonly passed: number;
  readonly failed: number;
  readonly failingTests: FailingTest[];
}

/** Removes OSC, CSI and other two-character ANSI escape sequences, and normalizes line endings. */
export function stripAnsi(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/\r\n?/g, '\n');
}

function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/** Collapse whitespace, redact the whole context first, then cap the final public text. */
function publicText(raw: string, max: number): string {
  const collapsed = safeSlice(raw, MAX_RAW_CONTEXT_CHARS).replace(/\s+/g, ' ').trim();
  return safeSlice(redact(collapsed), max).trim();
}

function failingTest(name: string, context: readonly string[]): FailingTest | null {
  const safeName = publicText(name, MAX_NAME_CHARS);
  if (safeName === '') return null;
  const excerpt = publicText(context.join(' '), MAX_EXCERPT_CHARS);
  return excerpt === '' ? { name: safeName } : { name: safeName, messageExcerpt: excerpt };
}

/** First occurrence wins, source order is kept, and at most MAX_FAILING_TESTS are stored. */
function bounded(candidates: readonly (FailingTest | null)[]): FailingTest[] {
  const seen = new Set<string>();
  const result: FailingTest[] = [];
  for (const candidate of candidates) {
    if (candidate === null || seen.has(candidate.name)) continue;
    seen.add(candidate.name);
    result.push(candidate);
    if (result.length === MAX_FAILING_TESTS) break;
  }
  return result;
}

function lastMatch(lines: readonly string[], pattern: RegExp): RegExpMatchArray | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = pattern.exec(lines[index]!);
    if (match !== null) return match;
  }
  return null;
}

/** Counts from "N label" items. Only the listed labels are accepted. */
function countsOf(items: readonly string[], labels: readonly string[]): Map<string, number> | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const match = /^(\d+) (.+)$/.exec(item.trim());
    if (match === null || !labels.includes(match[2]!) || counts.has(match[2]!)) return null;
    counts.set(match[2]!, Number(match[1]));
  }
  return counts;
}

/** passed is the explicit count, or what the total leaves after the other counted categories. */
function passedFromTotal(counts: Map<string, number>, total: number): number | null {
  const explicit = counts.get('passed');
  if (explicit !== undefined) return explicit;
  let others = 0;
  for (const [label, value] of counts) if (label !== 'passed') others += value;
  return total >= others ? total - others : null;
}

function jest(lines: readonly string[]): Parsed | null {
  const match = lastMatch(lines, /^\s*Tests:\s+((?:\d+ (?:failed|skipped|todo|passed|total)(?:, )?)+)\s*$/);
  if (match === null) return null;
  const counts = countsOf(match[1]!.split(', '), ['failed', 'skipped', 'todo', 'passed', 'total']);
  const total = counts?.get('total');
  if (counts === null || total === undefined) return null;
  counts.delete('total');
  const passed = passedFromTotal(counts, total);
  if (passed === null) return null;
  const failed = counts.get('failed') ?? 0;
  return { passed, failed, failingTests: failed === 0 ? [] : jestFailures(lines) };
}

function jestFailures(lines: readonly string[]): FailingTest[] {
  const header = /^\s*●\s+(.+?)\s*$/;
  const stop = /^\s*(?:Test Suites:|Tests:|Snapshots:|Time:|Summary of all failing tests)/;
  const found: (FailingTest | null)[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index]!);
    if (match === null || /^(?:Console\b|Test suite failed to run)/.test(match[1]!)) continue;
    const context: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (header.test(lines[next]!) || stop.test(lines[next]!)) break;
      context.push(lines[next]!);
    }
    found.push(failingTest(match[1]!, context));
  }
  return bounded(found);
}

function vitest(lines: readonly string[]): Parsed | null {
  const match = lastMatch(lines, /^\s*Tests\s+(\d+ [a-z ]+(?: \| \d+ [a-z ]+)*) \((\d+)\)\s*$/);
  if (match === null) return null;
  const counts = countsOf(match[1]!.split(' | '), ['failed', 'passed', 'skipped', 'todo', 'expected fail']);
  if (counts === null) return null;
  const passed = passedFromTotal(counts, Number(match[2]));
  if (passed === null) return null;
  const failed = counts.get('failed') ?? 0;
  return { passed, failed, failingTests: failed === 0 ? [] : vitestFailures(lines) };
}

function vitestFailures(lines: readonly string[]): FailingTest[] {
  const header = /^\s*FAIL\s+(\S.* > .+?)\s*$/;
  const stop = /^\s*(?:FAIL\s|⎯|Test Files\s|Tests\s)/;
  const found: (FailingTest | null)[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = header.exec(lines[index]!);
    if (match === null) continue;
    const context: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (stop.test(lines[next]!)) break;
      context.push(lines[next]!);
    }
    found.push(failingTest(match[1]!, context));
  }
  return bounded(found);
}

function pytest(lines: readonly string[]): Parsed | null {
  const labels = ['failed', 'passed', 'skipped', 'xfailed', 'xpassed', 'warning', 'warnings', 'error', 'errors',
    'deselected', 'rerun'];
  const match = lastMatch(
    lines,
    /^(?:=+ )?(\d+ [a-z]+(?:, \d+ [a-z]+)*) in \d+(?:\.\d+)?s(?: \([^)]*\))?(?: =+)?\s*$/,
  );
  if (match === null) return null;
  const counts = countsOf(match[1]!.split(', '), labels);
  if (counts === null || (!counts.has('failed') && !counts.has('passed'))) return null;
  const failed = counts.get('failed') ?? 0;
  return {
    passed: counts.get('passed') ?? 0,
    failed,
    failingTests: failed === 0 ? [] : pytestFailures(lines),
  };
}

function pytestFailures(lines: readonly string[]): FailingTest[] {
  const found: (FailingTest | null)[] = [];
  for (const line of lines) {
    const match = /^FAILED\s+(.+?)(?:\s+-\s+(.*))?\s*$/.exec(line);
    if (match !== null) found.push(failingTest(match[1]!, match[2] === undefined ? [] : [match[2]]));
  }
  return bounded(found);
}

function mocha(lines: readonly string[]): Parsed | null {
  const passing = lastMatch(lines, /^\s*(\d+) passing(?: \([^)]*\))?\s*$/);
  const failing = lastMatch(lines, /^\s*(\d+) failing\s*$/);
  if (passing === null && failing === null) return null;
  const failed = failing === null ? 0 : Number(failing[1]);
  return {
    passed: passing === null ? 0 : Number(passing[1]),
    failed,
    failingTests: failed === 0 ? [] : mochaFailures(lines),
  };
}

function mochaFailures(lines: readonly string[]): FailingTest[] {
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*\d+ failing\s*$/.test(lines[index]!)) { start = index; break; }
  }
  const blocks: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\d+\) /.test(line)) blocks.push([line.replace(/^\s*\d+\) /, '')]);
    else if (blocks.length > 0) blocks[blocks.length - 1]!.push(line);
  }
  return bounded(blocks.map((block) => {
    const titleEnd = block.findIndex((line) => /:\s*$/.test(line));
    const count = titleEnd === -1 ? 1 : titleEnd + 1;
    const title = block.slice(0, count).map((line) => line.trim()).join(' ').replace(/:\s*$/, '');
    return failingTest(title, block.slice(count));
  }));
}

/** Tried in this fixed order; the first one that recognizes its own summary wins. */
const EXTRACTORS: ReadonlyArray<(lines: readonly string[]) => Parsed | null> = [jest, vitest, pytest, mocha];

/**
 * Generic fallback. The approved design defines no further summary convention, so it never
 * reports counts: unrecognized output stays unparsed.
 */
function generic(): Parsed | null {
  return null;
}

/** Pure: no I/O, no clocks, no environment. The input object is never mutated. */
export function parseTestOutput(input: TestOutputInput): TestRunSummary {
  const lines = stripAnsi(input.output).split('\n');
  let parsed: Parsed | null = null;
  for (const extractor of [...EXTRACTORS, generic]) {
    parsed = extractor(lines);
    if (parsed !== null) break;
  }

  const base = {
    command: input.command,
    exitCode: input.exitCode,
    outputTruncated: input.outputTruncated,
    durationMs: input.durationMs,
  };
  if (parsed === null) {
    return {
      outcome: 'completed_unparsed', ...base, passed: null, failed: null, totalFailedNames: 0, failingTests: [],
    };
  }
  // Counts come from the output. A non-zero exit with zero failed tests is still not "passed".
  const outcome: TestRunOutcome = parsed.failed > 0 || input.exitCode !== 0 ? 'failed' : 'passed';
  return {
    outcome, ...base, passed: parsed.passed, failed: parsed.failed,
    totalFailedNames: parsed.failed, failingTests: parsed.failingTests,
  };
}
