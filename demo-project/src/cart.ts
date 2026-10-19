export interface CartItem {
  readonly name: string;
  readonly priceCents: number;
  readonly quantity: number;
}

/** The total of every item in the cart, in cents. */
export function calculateTotal(items: readonly CartItem[]): number {
  return items.reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
}

/** One receipt line, for example "Notebook x2: 598 cents". */
export function formatReceiptLine(item: CartItem): string {
  const lineTotal: number = item.priceCents * item.quantity;
  const label: string = lineTotal;
  return `${item.name} x${item.quantity}: ${label} cents`;
}
