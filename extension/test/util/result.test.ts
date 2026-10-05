import { describe, expect, it } from 'vitest';

import { err, ok, type Result } from '../../src/util/result';

describe('Result', () => {
  it('represents success explicitly', () => {
    const result: Result<number, string> = ok(42);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
    }
  });

  it('represents failure explicitly', () => {
    const result: Result<number, string> = err('not available');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not available');
    }
  });
});
