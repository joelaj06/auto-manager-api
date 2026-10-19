export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The part of a phone number to look for in stored E.164 numbers, from what a user types:
 * "024 123 4567" → "241234567", "+233 24 123" → "23324123". Null when it holds too few digits
 * to be a phone search.
 */
export function phoneSearchKey(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length < 4) return null;
  return digits.startsWith("0") ? digits.slice(1) : digits;
}
