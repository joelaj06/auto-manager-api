import { AuthSession, type SessionRevocationReason } from "../../../domain/entities/AuthSession.js";
import type { IAuthSessionRepository } from "../../../domain/repositories/IAuthSessionRepository.js";
import type { PostgresTransactionContext } from "../postgres/PostgresTransactionContext.js";

type SessionRow = {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  previous_refresh_token_hash: string | null;
  created_at: Date;
  last_rotated_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revocation_reason: SessionRevocationReason | null;
  user_agent: string | null;
  ip: string | null;
};

const COLUMNS = `id, user_id, refresh_token_hash, previous_refresh_token_hash, created_at,
  last_rotated_at, expires_at, revoked_at, revocation_reason, user_agent, ip::text as ip`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresAuthSessionRepository implements IAuthSessionRepository {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  findById(id: string): Promise<AuthSession | null> {
    return this.load(id, "");
  }

  lockById(id: string): Promise<AuthSession | null> {
    return this.load(id, " for update");
  }

  async save(session: AuthSession): Promise<void> {
    const s = session.snapshot();
    await this.transactions.current().query(
      `insert into auth_sessions
         (id, user_id, refresh_token_hash, previous_refresh_token_hash, created_at,
          last_rotated_at, expires_at, revoked_at, revocation_reason, user_agent, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (id) do update set
         refresh_token_hash          = excluded.refresh_token_hash,
         previous_refresh_token_hash = excluded.previous_refresh_token_hash,
         last_rotated_at             = excluded.last_rotated_at,
         revoked_at                  = excluded.revoked_at,
         revocation_reason           = excluded.revocation_reason`,
      [
        s.id,
        s.userId,
        s.refreshTokenHash,
        s.previousRefreshTokenHash,
        s.createdAt,
        s.lastRotatedAt,
        s.expiresAt,
        s.revokedAt,
        s.revocationReason,
        s.userAgent?.slice(0, 512) ?? null,
        s.ip,
      ],
    );
  }

  private async load(id: string, lock: string): Promise<AuthSession | null> {
    // Ids come from client tokens; a non-UUID would otherwise be a database error.
    if (!UUID.test(id)) return null;
    const { rows } = await this.transactions
      .current()
      .query<SessionRow>(`select ${COLUMNS} from auth_sessions where id = $1${lock}`, [id]);
    const row = rows[0];
    if (row === undefined) return null;
    return AuthSession.restore({
      id: row.id,
      userId: row.user_id,
      refreshTokenHash: row.refresh_token_hash,
      previousRefreshTokenHash: row.previous_refresh_token_hash,
      createdAt: row.created_at,
      lastRotatedAt: row.last_rotated_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revocationReason: row.revocation_reason,
      userAgent: row.user_agent,
      ip: row.ip,
    });
  }
}
