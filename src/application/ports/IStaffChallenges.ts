/**
 * Short-lived tokens that carry a staff sign-in between its steps: after the password
 * (`mfa`: enter a code; `enrol`: set up an authenticator first). Signed, not stored.
 */
export type StaffChallengePurpose = "mfa" | "enrol";

export interface IStaffChallenges {
  issue(
    userId: string,
    purpose: StaffChallengePurpose,
  ): Promise<Readonly<{ token: string; expiresAt: Date }>>;
  /** The user id; throws InvalidChallengeError when invalid, expired or for another purpose. */
  verify(token: string, purpose: StaffChallengePurpose): Promise<string>;
}
