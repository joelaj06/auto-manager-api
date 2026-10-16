import type {
  ITenantRetention,
  RetentionPolicy,
  RetentionResult,
} from "../../../application/ports/ITenantRetention.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

const DAY_MS = 86_400_000;

export class PostgresTenantRetention implements ITenantRetention {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async purge(policy: RetentionPolicy, now: Date): Promise<RetentionResult> {
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    const tx = this.transactions.current();
    const count = async (sql: string, cutoff: Date) =>
      (await tx.query(sql, [cutoff])).rowCount ?? 0;

    return {
      sessionsAfterDays: await count(
        "delete from auth_sessions where coalesce(revoked_at, expires_at) < $1",
        before(policy.sessionsAfterDays),
      ),
      otpChallengesAfterDays: await count(
        "delete from otp_challenges where expires_at < $1",
        before(policy.otpChallengesAfterDays),
      ),
      processedMessagesAfterDays: await count(
        "delete from processed_messages where processed_at < $1",
        before(policy.processedMessagesAfterDays),
      ),
      publishedEventsAfterDays: await count(
        "delete from outbox where published_at < $1",
        before(policy.publishedEventsAfterDays),
      ),
    };
  }
}
