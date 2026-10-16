import { DomainError } from "../errors/DomainError.js";

export class InvalidTagError extends DomainError {
  readonly code = "INVALID_TAG";
  constructor(message: string) {
    super(message);
  }
}

const PATTERN = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;

/** At most this many tags per tenant. */
export const MAX_TAGS_PER_TENANT = 20;

/**
 * A console label on a tenant (e.g. `vip`, `at-risk`, `partner-managed`): lowercase letters,
 * digits and inner hyphens, 1–30 characters. Input is trimmed and lowercased; spaces become hyphens.
 */
export class TenantTag {
  private constructor(readonly value: string) {}

  static from(input: string): TenantTag {
    const value = input.trim().toLowerCase().split(" ").filter(Boolean).join("-");
    if (!PATTERN.test(value))
      throw new InvalidTagError(
        `"${input}" is not a valid tag (letters, digits and hyphens, up to 30 characters)`,
      );
    return new TenantTag(value);
  }

  /** Normalised, de-duplicated and sorted; refuses more than MAX_TAGS_PER_TENANT. */
  static set(inputs: readonly string[]): string[] {
    const values = [...new Set(inputs.map((input) => TenantTag.from(input).value))].sort();
    if (values.length > MAX_TAGS_PER_TENANT)
      throw new InvalidTagError(`A tenant can have at most ${MAX_TAGS_PER_TENANT} tags`);
    return values;
  }
}
