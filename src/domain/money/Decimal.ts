import { DomainError } from "../errors/DomainError.js";

export class InvalidDecimalError extends DomainError {
  readonly code = "INVALID_AMOUNT";
  constructor(message: string) {
    super(message);
  }
}

/** A decimal number as an exact scaled integer: value = units / 10^scale. No floats. */
export type ScaledDecimal = Readonly<{ units: bigint; scale: number }>;

const DECIMAL = /^-?\d{1,18}(\.\d{1,18})?$/;

export function parseDecimal(input: string): ScaledDecimal {
  const text = input.trim();
  if (!DECIMAL.test(text)) throw new InvalidDecimalError(`"${input}" is not a decimal number`);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".") as [string, string?];
  const units = BigInt(`${whole}${fraction}`);
  return { units: negative ? -units : units, scale: fraction.length };
}

export function decimalToString(value: ScaledDecimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  const text =
    value.scale === 0 ? digits : `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
  return negative ? `-${text}` : text;
}

/** numerator / denominator rounded half to even (banker's rounding, docs/20 §12). */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new InvalidDecimalError("Division by zero");
  if (denominator < 0n) return divideHalfEven(-numerator, -denominator);
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const quotient = n / denominator;
  const remainder = n % denominator;
  const twice = remainder * 2n;
  const roundUp = twice > denominator || (twice === denominator && quotient % 2n === 1n);
  const result = roundUp ? quotient + 1n : quotient;
  return negative ? -result : result;
}

export const pow10 = (exponent: number): bigint => 10n ** BigInt(exponent);
