import type { OtpChallenge } from "../entities/OtpChallenge.js";
import type { OtpPurpose } from "../enums/OtpPurpose.js";

/** One-time-code challenges of the current tenant. Call inside a unit of work. */
export interface IOtpChallengeRepository {
  /** The newest challenge that is neither consumed nor invalidated, if any. */
  findOpen(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | null>;
  /**
   * Like findOpen, but locks the challenge until the unit of work ends, so parallel guesses are
   * counted one after another.
   */
  lockOpen(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | null>;
  /** Inserts or updates. */
  save(challenge: OtpChallenge): Promise<void>;
}
