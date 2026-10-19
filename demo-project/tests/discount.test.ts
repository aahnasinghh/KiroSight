import { describe, expect, it } from 'vitest';

import { applyDiscount, loyaltyPrice } from '../src/discount';

describe('applyDiscount', () => {
  it('takes ten percent off a round total', () => {
    expect(applyDiscount(1000, 10)).toBe(900);
  });

  it('rounds down to a whole cent', () => {
    expect(applyDiscount(999, 10)).toBe(899);
  });
});

describe('loyaltyPrice', () => {
  it('gives loyalty members ten percent off the cart total', () => {
    expect(loyaltyPrice(2000)).toBe(1800);
  });

  it('rounds the loyalty price to the nearest cent (deliberately failing demo test)', () => {
    // 995 cents less ten percent is 895.5. applyDiscount rounds down to 895, so this expectation fails.
    expect(loyaltyPrice(995)).toBe(896);
  });
});
