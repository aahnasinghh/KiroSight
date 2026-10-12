import type { TestRunSummary } from './testOutputParser';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Holds the most recent completed test run. It stores only the bounded TestRunSummary,
 * never raw process output. The stored value is a frozen deep copy, so callers cannot alter it.
 */
export class TestRunStore {
  private last: TestRunSummary | null = null;

  public get(): TestRunSummary | null {
    return this.last;
  }

  public set(summary: TestRunSummary): void {
    this.last = deepFreeze(structuredClone(summary));
  }
}
