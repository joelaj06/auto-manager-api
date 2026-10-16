import type { ITenantSessions, SessionView } from "../../application/ports/ITenantSessions.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

export class PostgresTenantSessions implements ITenantSessions {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async listActive(userId: string, now: Date): Promise<SessionView[]> {
    const { rows } = await this.transactions.current().query<{
      id: string;
      created_at: Date;
      last_rotated_at: Date;
      expires_at: Date;
      user_agent: string | null;
      ip: string | null;
    }>(
      `select id, created_at, last_rotated_at, expires_at, user_agent, ip::text as ip
         from auth_sessions where user_id = $1 and revoked_at is null and expires_at > $2
        order by last_rotated_at desc`,
      [userId, now],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      lastRotatedAt: r.last_rotated_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent,
      ip: r.ip,
    }));
  }

  async revokeForUser(
    userId: string,
    reason: "logout" | "password_changed" | "user_disabled" | "admin_revoked",
    now: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    const { rowCount } = await this.transactions.current().query(
      `update auth_sessions set revoked_at = $2, revocation_reason = $3
        where user_id = $1 and revoked_at is null and ($4::uuid is null or id <> $4)`,
      [userId, now, reason, exceptSessionId ?? null],
    );
    return rowCount ?? 0;
  }
}
