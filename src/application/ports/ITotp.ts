/** Time-based one-time passwords (RFC 6238; authenticator apps). */
export interface ITotp {
  /** A new random secret, base32-encoded. */
  generateSecret(): string;
  /** otpauth:// URI for QR codes. */
  provisioningUri(secret: string, accountName: string): string;
  /**
   * The time step the code is valid for (current ±1 step for clock drift), or null. Steps at or
   * before `lastUsedStep` are refused, so a code can never be replayed.
   */
  verify(secret: string, code: string, lastUsedStep: number | null, now: Date): number | null;
}
