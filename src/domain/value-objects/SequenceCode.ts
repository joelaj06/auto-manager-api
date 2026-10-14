import { InvalidSequenceCodeError } from "../errors/SequenceErrors.js";

const PREFIX = /^[A-Z][A-Z0-9]{0,9}$/;

/**
 * Human-readable document number such as RT-000123 or RT-2026-000123.
 * The numeric part comes from a gap-free counter (ISequenceGenerator).
 */
export class SequenceCode {
  private constructor(
    readonly prefix: string,
    readonly number: number,
    readonly year: number | undefined,
    private readonly padding: number,
  ) {}

  static create(params: {
    prefix: string;
    number: number;
    year?: number;
    /** Minimum digits, zero-padded. Defaults to 6. */
    padding?: number;
  }): SequenceCode {
    const { prefix, number, year, padding = 6 } = params;
    if (!PREFIX.test(prefix)) throw new InvalidSequenceCodeError(`prefix "${prefix}"`);
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new InvalidSequenceCodeError(`number ${number}`);
    }
    if (year !== undefined && (!Number.isInteger(year) || year < 2000 || year > 9999)) {
      throw new InvalidSequenceCodeError(`year ${year}`);
    }
    if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
      throw new InvalidSequenceCodeError(`padding ${padding}`);
    }
    return new SequenceCode(prefix, number, year, padding);
  }

  toString(): string {
    const digits = String(this.number).padStart(this.padding, "0");
    return this.year === undefined
      ? `${this.prefix}-${digits}`
      : `${this.prefix}-${this.year}-${digits}`;
  }
}
