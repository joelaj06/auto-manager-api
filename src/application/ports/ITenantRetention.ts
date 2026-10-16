export type RetentionPolicy = Readonly<{
  /** Sessions are deleted this long after they expired or were revoked. */
  sessionsAfterDays: number;
  otpChallengesAfterDays: number;
  processedMessagesAfterDays: number;
  publishedEventsAfterDays: number;
}>;

export type RetentionResult = Readonly<Record<keyof RetentionPolicy, number>>;

/** Deletes expired technical rows in the current tenant database. Call inside a unit of work. */
export interface ITenantRetention {
  purge(policy: RetentionPolicy, now: Date): Promise<RetentionResult>;
}
