import { DomainError } from "../errors/DomainError.js";
import { currencyInfo, type CurrencyCode, type CurrencyInfo } from "./Currency.js";
import { divideHalfEven, InvalidDecimalError, parseDecimal, pow10 } from "./Decimal.js";

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";
  constructor(a: string, b: string) {
    super(`Cannot combine ${a} and ${b} amounts`);
  }
}

/** Largest amount accepted, in minor units (keeps every amount an exact JS integer). */
export const MAX_MINOR = 900_000_000_000_000;

export type MoneyJson = Readonly<{ amountMinor: number; currency: string; formatted: string }>;

/**
 * An amount of money in integer minor units of one currency (docs/05 §1.3, docs/20 §4–5):
 * pesewas for GHS, whole francs for XOF. Never a float; rounding is half to even.
 */
export class Money {
  private constructor(
    readonly amountMinor: number,
    readonly currency: CurrencyCode,
  ) {}

  static ofMinor(amountMinor: number, currency: string): Money {
    const info = currencyInfo(currency);
    if (!Number.isSafeInteger(amountMinor) || Math.abs(amountMinor) > MAX_MINOR)
      throw new InvalidDecimalError("An amount must be a whole number of minor units");
    return new Money(amountMinor === 0 ? 0 : amountMinor, info.code as CurrencyCode);
  }

  static zero(currency: string): Money {
    return Money.ofMinor(0, currency);
  }

  /**
   * From a decimal string as clients send it (`"1250.50"`); more decimals than the currency has
   * are refused, never rounded away (docs/20 §8).
   */
  static parse(amount: string, currency: string): Money {
    const info = currencyInfo(currency);
    const value = parseDecimal(amount);
    if (value.scale > info.minorUnits)
      throw new InvalidDecimalError(
        info.minorUnits === 0
          ? `${info.code} amounts have no decimals`
          : `${info.code} amounts have at most ${info.minorUnits} decimals`,
      );
    const minor = value.units * pow10(info.minorUnits - value.scale);
    if (minor > BigInt(MAX_MINOR) || minor < -BigInt(MAX_MINOR))
      throw new InvalidDecimalError("The amount is too large");
    return Money.ofMinor(Number(minor), info.code);
  }

  get info(): CurrencyInfo {
    return currencyInfo(this.currency);
  }

  isZero(): boolean {
    return this.amountMinor === 0;
  }
  isNegative(): boolean {
    return this.amountMinor < 0;
  }

  add(other: Money): Money {
    this.assertSame(other);
    return Money.ofMinor(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSame(other);
    return Money.ofMinor(this.amountMinor - other.amountMinor, this.currency);
  }

  negate(): Money {
    return Money.ofMinor(-this.amountMinor, this.currency);
  }

  times(quantity: number): Money {
    if (!Number.isSafeInteger(quantity))
      throw new InvalidDecimalError("Quantities are whole numbers");
    return Money.ofMinor(this.amountMinor * quantity, this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSame(other);
    return Math.sign(this.amountMinor - other.amountMinor) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amountMinor === other.amountMinor;
  }

  /** `percent` of this amount ("15" = 15 %, "2.5" = 2.5 %), half-even at minor units. */
  percent(percent: string): Money {
    const rate = parseDecimal(percent);
    const minor = divideHalfEven(BigInt(this.amountMinor) * rate.units, pow10(rate.scale + 2));
    return Money.ofMinor(Number(minor), this.currency);
  }

  /** This amount × `rate` in `target` currency (1 unit of this = rate units of target). */
  convert(rate: string, target: string): Money {
    const to = currencyInfo(target);
    const r = parseDecimal(rate);
    if (r.units <= 0n) throw new InvalidDecimalError("An exchange rate is positive");
    const minor = divideHalfEven(
      BigInt(this.amountMinor) * r.units * pow10(to.minorUnits),
      pow10(r.scale + this.info.minorUnits),
    );
    return Money.ofMinor(Number(minor), to.code);
  }

  /**
   * Splits into parts proportional to `weights` (largest remainder): the parts always add up to
   * exactly this amount (split expenses, instalments).
   */
  allocate(weights: readonly number[]): Money[] {
    if (weights.length === 0 || weights.some((w) => !Number.isSafeInteger(w) || w < 0))
      throw new InvalidDecimalError("Weights are whole, non-negative numbers");
    const total = weights.reduce((sum, w) => sum + w, 0);
    if (total === 0) throw new InvalidDecimalError("At least one weight must be positive");
    const amount = BigInt(this.amountMinor);
    const sign = amount < 0n ? -1n : 1n;
    const abs = amount * sign;
    const shares = weights.map((w) => (abs * BigInt(w)) / BigInt(total));
    let left = abs - shares.reduce((sum, s) => sum + s, 0n);
    const order = weights
      .map((w, i) => ({ i, remainder: (abs * BigInt(w)) % BigInt(total) }))
      .sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.i - b.i));
    for (const { i } of order) {
      if (left === 0n) break;
      shares[i] = shares[i]! + 1n;
      left -= 1n;
    }
    return shares.map((s) => Money.ofMinor(Number(s * sign), this.currency));
  }

  /** "1250.50" (no grouping, no symbol). */
  toDecimalString(): string {
    const units = this.info.minorUnits;
    const negative = this.amountMinor < 0;
    const digits = String(Math.abs(this.amountMinor)).padStart(units + 1, "0");
    const text = units === 0 ? digits : `${digits.slice(0, -units)}.${digits.slice(-units)}`;
    return negative ? `-${text}` : text;
  }

  /** "₵1,250.50" for screens. */
  format(): string {
    return this.withSign(`${this.info.symbol}${this.grouped()}`);
  }

  /** "GHS 1,250.50" for SMS, exports and PDFs (the ₵ sign may not render everywhere). */
  formatAscii(): string {
    return this.withSign(`${this.currency} ${this.grouped()}`);
  }

  toJSON(): MoneyJson {
    return { amountMinor: this.amountMinor, currency: this.currency, formatted: this.format() };
  }

  private grouped(): string {
    const [whole, fraction] = this.toDecimalString().replace("-", "").split(".") as [
      string,
      string?,
    ];
    const groups = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return fraction === undefined ? groups : `${groups}.${fraction}`;
  }

  private withSign(text: string): string {
    return this.amountMinor < 0 ? `-${text}` : text;
  }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency)
      throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
