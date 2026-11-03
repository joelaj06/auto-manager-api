/** Connect links held for a phone that is installing the app (platform database). */
export interface IDeferredConnectLinks {
  /** Keeps the link and clears away holds long past their end. */
  hold(
    link: Readonly<{
      codeHash: string;
      sealedQuery: string;
      tenantSlug: string;
      expiresAt: Date;
      now: Date;
    }>,
  ): Promise<void>;
  /** Takes a live hold, once; null when unknown, used or expired. */
  claim(
    codeHash: string,
    now: Date,
  ): Promise<Readonly<{ sealedQuery: string; tenantSlug: string }> | null>;
}
