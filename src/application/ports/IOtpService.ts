import type { OtpPurpose } from "../../domain/enums/OtpPurpose.js";

/** Six-digit one-time codes, stored only as keyed hashes bound to subject and purpose. */
export interface IOtpService {
  generateCode(): string;
  hash(subject: string, purpose: OtpPurpose, code: string): string;
  /** Constant-time comparison of a presented code with a stored hash. */
  matches(hash: string, subject: string, purpose: OtpPurpose, code: string): boolean;
}
