import { WeakPasswordError } from "../errors/StaffErrors.js";

const MIN_LENGTH = 12;
const MAX_LENGTH = 200;
/** A few of the most common passwords that meet the length rule. */
const COMMON = new Set([
  "password1234",
  "123456789012",
  "qwertyuiopas",
  "passwordpassword",
  "administrator",
  "autoforce123",
  "letmein12345",
  "welcome12345",
]);

/**
 * Password rules (NIST SP 800-63B style): long, not a well-known password, not the email.
 * No composition rules or forced rotation.
 */
export function assertAcceptablePassword(password: string, email: string): void {
  if (password.length < MIN_LENGTH) {
    throw new WeakPasswordError(`Use at least ${MIN_LENGTH} characters`);
  }
  if (password.length > MAX_LENGTH) {
    throw new WeakPasswordError(`Use at most ${MAX_LENGTH} characters`);
  }
  const lowered = password.toLowerCase();
  const localPart = email.toLowerCase().split("@")[0] ?? "";
  if (
    COMMON.has(lowered) ||
    lowered === email.toLowerCase() ||
    (localPart.length >= 4 && lowered.includes(localPart))
  ) {
    throw new WeakPasswordError("Choose a password that is harder to guess");
  }
  if (new Set(password).size < 5) {
    throw new WeakPasswordError("Choose a password that is harder to guess");
  }
}
