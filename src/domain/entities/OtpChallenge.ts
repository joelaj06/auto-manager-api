import type { OtpPurpose } from "../enums/OtpPurpose.js";
import { OtpChallengeClosedError } from "../errors/AuthErrors.js";

export type OtpChallengeProps = Readonly<{
  id: string;
  /** Who the code was sent to: a user id, or a normalised email/phone before an account exists. */
  subject: string;
  purpose: OtpPurpose;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  invalidatedAt: Date | null;
}>;

export type OtpVerificationOutcome = "verified" | "invalid" | "expired" | "locked";

/**
 * One issued one-time code. Only its hash is kept. Each wrong guess counts; after
 * `maxAttempts` the challenge locks. A code works once, and issuing a new code for the same
 * subject and purpose invalidates the previous one.
 */
export class OtpChallenge {
  private constructor(private props: OtpChallengeProps) {}

  static issue(params: {
    id: string;
    subject: string;
    purpose: OtpPurpose;
    codeHash: string;
    now: Date;
    ttlMs: number;
    maxAttempts: number;
  }): OtpChallenge {
    return new OtpChallenge({
      id: params.id,
      subject: params.subject,
      purpose: params.purpose,
      codeHash: params.codeHash,
      attempts: 0,
      maxAttempts: params.maxAttempts,
      createdAt: params.now,
      expiresAt: new Date(params.now.getTime() + params.ttlMs),
      consumedAt: null,
      invalidatedAt: null,
    });
  }

  static restore(props: OtpChallengeProps): OtpChallenge {
    return new OtpChallenge(props);
  }

  get id(): string {
    return this.props.id;
  }

  get codeHash(): string {
    return this.props.codeHash;
  }

  get expiresAt(): Date {
    return this.props.expiresAt;
  }

  get remainingAttempts(): number {
    return Math.max(this.props.maxAttempts - this.props.attempts, 0);
  }

  /**
   * Records one verification attempt. `codeMatches` is computed by the caller (the code is
   * compared against the hash in constant time by the OTP service).
   */
  attempt(codeMatches: boolean, now: Date): OtpVerificationOutcome {
    if (this.props.consumedAt !== null || this.props.invalidatedAt !== null) {
      throw new OtpChallengeClosedError();
    }
    if (now >= this.props.expiresAt) return "expired";
    if (this.props.attempts >= this.props.maxAttempts) return "locked";

    if (codeMatches) {
      this.props = { ...this.props, consumedAt: now };
      return "verified";
    }
    const attempts = this.props.attempts + 1;
    this.props = { ...this.props, attempts };
    return attempts >= this.props.maxAttempts ? "locked" : "invalid";
  }

  invalidate(now: Date): void {
    if (this.props.consumedAt === null && this.props.invalidatedAt === null) {
      this.props = { ...this.props, invalidatedAt: now };
    }
  }

  snapshot(): OtpChallengeProps {
    return this.props;
  }
}
