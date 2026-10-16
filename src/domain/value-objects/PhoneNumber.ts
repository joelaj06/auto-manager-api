import { DomainError } from "../errors/DomainError.js";

export class InvalidPhoneNumberError extends DomainError {
  readonly code = "INVALID_PHONE";
  constructor() {
    super("Enter a valid phone number, e.g. 024 123 4567 or +233 24 123 4567");
  }
}

/** National number lengths after the country code, for countries we parse local formats of. */
const NATIONAL = { GH: { code: "233", length: 9 } } as const;

/**
 * A phone number in E.164 form (+233241234567). Accepts international input (+…, 00…) and, for
 * known countries, local input with a trunk 0 (024 123 4567 in Ghana).
 */
export class PhoneNumber {
  private constructor(readonly value: string) {}

  static parse(input: string, defaultCountry: string = "GH"): PhoneNumber {
    const compact = input.replace(/[\s().-]/g, "");
    let digits: string;
    if (compact.startsWith("+")) digits = compact.slice(1);
    else if (compact.startsWith("00")) digits = compact.slice(2);
    else {
      const country = NATIONAL[defaultCountry as keyof typeof NATIONAL];
      if (country === undefined) throw new InvalidPhoneNumberError();
      if (compact.startsWith(country.code)) digits = compact;
      else if (compact.startsWith("0")) digits = country.code + compact.slice(1);
      else digits = country.code + compact;
    }
    if (!/^[1-9]\d{7,14}$/.test(digits)) throw new InvalidPhoneNumberError();
    for (const country of Object.values(NATIONAL)) {
      if (
        digits.startsWith(country.code) &&
        digits.length !== country.code.length + country.length
      ) {
        throw new InvalidPhoneNumberError();
      }
    }
    return new PhoneNumber(`+${digits}`);
  }

  /** +233 24 *** 4567 — for messages and logs. */
  masked(): string {
    return `${this.value.slice(0, 6)}***${this.value.slice(-4)}`;
  }
}
