import { describe, expect, it } from 'vitest';

import type { TestRunSummary } from '../../src/testing/testOutputParser';
import { TestRunStore } from '../../src/testing/testRunStore';

function summary(overrides: Partial<TestRunSummary> = {}): TestRunSummary {
  return {
    outcome: 'failed', command: 'npm.cmd test', exitCode: 1, passed: 2, failed: 37, totalFailedNames: 37,
    failingTests: [{ name: 'a', messageExcerpt: 'x' }, { name: 'b' }],
    outputTruncated: false, durationMs: 5, ...overrides,
  };
}

describe('TestRunStore', () => {
  it('starts empty, stores the last run and replaces it with a later one', () => {
    const store = new TestRunStore();
    expect(store.get()).toBeNull();

    store.set(summary());
    expect(store.get()).toEqual(summary());
    store.set(summary({ outcome: 'passed', failed: 0, totalFailedNames: 0, failingTests: [] }));

    expect(store.get()).toMatchObject({ outcome: 'passed', failed: 0 });
  });

  it('keeps the true failed total and bounded details faithfully', () => {
    const store = new TestRunStore();
    store.set(summary());

    expect(store.get()).toMatchObject({ failed: 37, totalFailedNames: 37 });
    expect(store.get()!.failingTests.map(({ name }) => name)).toEqual(['a', 'b']);
  });

  it('is not corrupted by later mutation of the caller object or the returned snapshot', () => {
    const store = new TestRunStore();
    const input = summary();
    store.set(input);

    input.failed = 1;
    input.failingTests.reverse();
    expect(store.get()).toMatchObject({ failed: 37 });
    expect(store.get()!.failingTests.map(({ name }) => name)).toEqual(['a', 'b']);
    expect(() => { (store.get() as TestRunSummary).failed = 0; }).toThrow();
    expect(() => { (store.get()!.failingTests as unknown[]).push({}); }).toThrow();
  });
});
