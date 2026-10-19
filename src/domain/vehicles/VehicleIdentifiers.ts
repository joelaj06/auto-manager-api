import { DomainError } from "../errors/DomainError.js";

export class InvalidVehicleError extends DomainError {
  readonly code = "INVALID_VEHICLE";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A registration plate as shown ("GR 1234-21", "GT-4567-19", "AS 123 X"): upper case with single
 * spaces. Its key (letters and digits only) decides uniqueness, so "gr1234-21" and "GR 1234 21"
 * are the same plate.
 */
export class PlateNumber {
  private constructor(
    readonly value: string,
    readonly key: string,
  ) {}

  static parse(input: string): PlateNumber {
    const value = input
      .trim()
      .toUpperCase()
      .replace(/\s+/g, " ")
      .replace(/\s*-\s*/g, "-");
    const key = value.replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9][A-Z0-9 -]{1,18}[A-Z0-9]$/.test(value) || key.length < 2)
      throw new InvalidVehicleError("A plate number has letters and digits, e.g. GR 1234-21");
    return new PlateNumber(value, key);
  }

  /** The search key of any text (for "find by plate" with partial input). */
  static keyOf(input: string): string {
    return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
}

/**
 * A 17-character VIN (ISO 3779: no I, O or Q). The check digit is not enforced: it is only
 * mandatory in North America, and most vehicles in the market come from elsewhere.
 */
export function parseVin(input: string): string {
  const vin = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))
    throw new InvalidVehicleError("A VIN has 17 letters and digits (no I, O or Q)");
  return vin;
}
