import { DomainError } from "../errors/DomainError.js";

export class InvalidReferralCodeError extends DomainError {
  readonly code = "INVALID_REFERRAL_CODE";
  constructor() {
    super("A referral code has 4 to 16 letters and digits");
  }
}

const PATTERN = /^[A-Z0-9]{4,16}$/;
/** No 0/O or 1/I, so codes survive being read aloud or copied from paper. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A partner's referral code (docs/29 §2.1), e.g. `KOFI7Q2M`: uppercase letters and digits. */
export class ReferralCode {
  private constructor(readonly value: string) {}

  /** Accepts any case and surrounding spaces. */
  static parse(input: string): ReferralCode {
    const value = input.trim().toUpperCase();
    if (!PATTERN.test(value)) throw new InvalidReferralCodeError();
    return new ReferralCode(value);
  }

  /** Like parse, but returns null for input that cannot be a code (e.g. from a signup form). */
  static tryParse(input: string | null | undefined): ReferralCode | null {
    if (input === null || input === undefined) return null;
    const value = input.trim().toUpperCase();
    return PATTERN.test(value) ? new ReferralCode(value) : null;
  }

  /**
   * A new code: up to 4 letters from the partner's name and 4 random characters.
   * `random` returns n random bytes (injected for tests).
   */
  static generate(name: string, random: (n: number) => Uint8Array): ReferralCode {
    const prefix = name
      .toUpperCase()
      .split("")
      .filter((c) => c >= "A" && c <= "Z")
      .join("")
      .slice(0, 4);
    const suffix = [...random(prefix.length >= 4 ? 4 : 8 - prefix.length)]
      .map((b) => ALPHABET[b % ALPHABET.length])
      .join("");
    return new ReferralCode(`${prefix}${suffix}`);
  }
}
