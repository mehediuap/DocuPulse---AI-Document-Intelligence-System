/**
 * Decimal-Safe Financial Utilities
 * Prevents IEEE-754 floating-point inaccuracies in invoice reconciliation.
 */

const CENTS_FACTOR = 100;

/**
 * Converts a floating-point dollar amount to an integer cent representation.
 */
export function toCents(amount: number): number {
  if (isNaN(amount) || !isFinite(amount)) return 0;
  return Math.round(amount * CENTS_FACTOR);
}

/**
 * Converts integer cents back to standard two-decimal dollar float.
 */
export function fromCents(cents: number): number {
  return cents / CENTS_FACTOR;
}

/**
 * Adds two decimal amounts safely using integer arithmetic.
 */
export function addDecimals(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

/**
 * Subtracts b from a safely using integer arithmetic.
 */
export function subtractDecimals(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}

/**
 * Multiplies quantity and unit price safely, rounding to two decimal places.
 */
export function multiplyDecimals(quantity: number, unitPrice: number): number {
  if (isNaN(quantity) || isNaN(unitPrice)) return 0;
  return Math.round(quantity * unitPrice * 100) / 100;
}

/**
 * Rounds a number to exactly two decimal places.
 */
export function roundToTwoDecimals(val: number): number {
  return Math.round(val * 100) / 100;
}

/**
 * Checks whether two decimal amounts are within a specified tolerance.
 */
export function isWithinTolerance(val1: number, val2: number, tolerance = 0.05): boolean {
  const diff = Math.abs(toCents(val1) - toCents(val2));
  const maxDiff = toCents(tolerance);
  return diff <= maxDiff;
}

/**
 * Calculates absolute delta between two values rounded to 2 decimal places.
 */
export function getAbsoluteDelta(val1: number, val2: number): number {
  return fromCents(Math.abs(toCents(val1) - toCents(val2)));
}
