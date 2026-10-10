import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { RequestTracker } from '../../src/pipeline/requestTracker';

const testDirectory = dirname(fileURLToPath(import.meta.url));

describe('RequestTracker', () => {
  it('starts deterministically with no current request', () => {
    const tracker = new RequestTracker();

    expect(tracker.current()).toBe(0);
    expect(tracker.isCurrent(0)).toBe(true);
  });

  it('issues strictly increasing ids', () => {
    const tracker = new RequestTracker();

    expect([tracker.begin(), tracker.begin(), tracker.begin()]).toEqual([1, 2, 3]);
    expect(tracker.current()).toBe(3);
  });

  it('treats only the latest id as current', () => {
    const tracker = new RequestTracker();
    const first = tracker.begin();
    const second = tracker.begin();

    expect(tracker.isCurrent(first)).toBe(false);
    expect(tracker.isCurrent(second)).toBe(true);
  });

  it('makes outstanding ids stale on supersede without issuing a request', () => {
    const tracker = new RequestTracker();
    const id = tracker.begin();

    tracker.supersede();

    expect(tracker.isCurrent(id)).toBe(false);
    expect(tracker.begin()).toBe(3);
  });

  it('keeps independent instances independent', () => {
    const first = new RequestTracker();
    const second = new RequestTracker();

    first.begin();
    first.begin();

    expect(second.current()).toBe(0);
    expect(second.begin()).toBe(1);
  });

  it('has no time, randomness, or vscode dependency', () => {
    const source = readFileSync(resolve(testDirectory, '../../src/pipeline/requestTracker.ts'), 'utf8');

    expect(source).not.toMatch(/Date\.now|new Date|Math\.random|randomUUID|from ['"]vscode['"]/);
  });
});
