import { describe, expect, it } from 'vitest';

import { calculateTotal, formatReceiptLine } from '../src/cart';

describe('calculateTotal', () => {
  it('adds up price times quantity for every item', () => {
    const items = [
      { name: 'Notebook', priceCents: 299, quantity: 2 },
      { name: 'Pen', priceCents: 150, quantity: 1 },
    ];
    expect(calculateTotal(items)).toBe(748);
  });

  it('returns zero for an empty cart', () => {
    expect(calculateTotal([])).toBe(0);
  });
});

describe('formatReceiptLine', () => {
  it('shows the name, the quantity and the line total in cents', () => {
    expect(formatReceiptLine({ name: 'Notebook', priceCents: 299, quantity: 2 })).toBe('Notebook x2: 598 cents');
  });
});
