import { OtpChallenge } from "../../../domain/entities/OtpChallenge.js";
import type { OtpPurpose } from "../../../domain/enums/OtpPurpose.js";
import type { IOtpChallengeRepository } from "../../../domain/repositories/IOtpChallengeRepository.js";
import type { Queryable } from "../postgres/Queryable.js";

/** Where the challenges live: the tenant `otp_challenges` (default) or `platform_otp_challenges`. */
export type OtpChallengeTable = "otp_challenges" | "platform_otp_challenges";

type ChallengeRow = {
  id: string;
  subject: string;
  purpose: OtpPurpose;
  code_hash: string;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  invalidated_at: Date | null;
};

export class PostgresOtpChallengeRepository implements IOtpChallengeRepository {
  constructor(
    /** The current transaction (tenant unit of work) or the platform database. */
    private readonly source: Readonly<{ current(): Queryable }>,
    private readonly table: OtpChallengeTable = "otp_challenges",
  ) {}

  findOpen(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    return this.loadOpen(subject, purpose, "");
  }

  lockOpen(subject: string, purpose: OtpPurpose): Promise<OtpChallenge | null> {
    return this.loadOpen(subject, purpose, " for update");
  }

  async save(challenge: OtpChallenge): Promise<void> {
    const c = challenge.snapshot();
    await this.source.current().query(
      `insert into ${this.table}
         (id, subject, purpose, code_hash, attempts, max_attempts, created_at, expires_at,
          consumed_at, invalidated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (id) do update set
         attempts       = excluded.attempts,
         consumed_at    = excluded.consumed_at,
         invalidated_at = excluded.invalidated_at`,
      [
        c.id,
        c.subject,
        c.purpose,
        c.codeHash,
        c.attempts,
        c.maxAttempts,
        c.createdAt,
        c.expiresAt,
        c.consumedAt,
        c.invalidatedAt,
      ],
    );
  }

  private async loadOpen(
    subject: string,
    purpose: OtpPurpose,
    lock: string,
  ): Promise<OtpChallenge | null> {
    const { rows } = await this.source.current().query<ChallengeRow>(
      `select id, subject, purpose, code_hash, attempts, max_attempts, created_at, expires_at,
              consumed_at, invalidated_at
         from ${this.table}
        where subject = $1 and purpose = $2 and consumed_at is null and invalidated_at is null
        order by created_at desc
        limit 1${lock}`,
      [subject, purpose],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return OtpChallenge.restore({
      id: row.id,
      subject: row.subject,
      purpose: row.purpose,
      codeHash: row.code_hash,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      invalidatedAt: row.invalidated_at,
    });
  }
}
