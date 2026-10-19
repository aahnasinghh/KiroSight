export const LOYALTY_DISCOUNT_PERCENT = 10;

/** Takes `percent` off a total in cents, rounded down to a whole cent. */
export function applyDiscount(totalCents: number, percent: number): number {
  return Math.floor((totalCents * (100 - percent)) / 100);
}

/** The price a loyalty member pays for a cart total in cents. */
export function loyaltyPrice(totalCents: number): number {
  return applyDiscount(totalCents, LOYALTY_DISCOUNT_PERCENT);
}
