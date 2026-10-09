import { describe, expect, it } from 'vitest';

import { normalize } from '../../src/intent/normalize';

describe('normalize', () => {
  it('normalizes case, punctuation, and whitespace', () => {
    expect(normalize('  PLEASE,   WHERE AM I?!  ')).toBe('where am i');
  });

  it('removes only approved leading fillers', () => {
    expect(normalize('KiroSight can you please go to line five')).toBe('go to line 5');
    expect(normalize('please open src/please.ts')).toBe('open src/please.ts');
  });

  it('maps approved cardinal and ordinal number words', () => {
    expect(normalize('go to line twenty')).toBe('go to line 20');
    expect(normalize('go to the third error')).toBe('go to the 3 error');
  });

  it('is idempotent and does not mutate the input', () => {
    const input = '  Can You  OPEN src/Auth.ts? ';
    const normalized = normalize(input);
    expect(normalize(normalized)).toBe(normalized);
    expect(input).toBe('  Can You  OPEN src/Auth.ts? ');
  });
});
