import { AuthSession, type SessionRevocationReason } from "../../domain/entities/AuthSession.js";
import type {
  IPlatformSessions,
  PlatformSessionState,
} from "../../application/ports/IPlatformSessions.js";
import type { PlatformDb } from "./PlatformDb.js";

type Row = {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  previous_refresh_token_hash: string | null;
  created_at: Date;
  last_rotated_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  step_up_at: Date | null;
  revoked_at: Date | null;
  revocation_reason: SessionRevocationReason | null;
  user_agent: string | null;
  ip: string | null;
};

const COLUMNS = `id, user_id, refresh_token_hash, previous_refresh_token_hash, created_at,
  last_rotated_at, last_seen_at, expires_at, step_up_at, revoked_at, revocation_reason, user_agent,
  ip::text as ip`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const toSession = (row: Row) =>
  AuthSession.restore({
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

export class PostgresPlatformSessions implements IPlatformSessions {
  constructor(private readonly db: PlatformDb) {}

  async find(id: string): Promise<PlatformSessionState | null> {
    const row = await this.load(id, "");
    return row === null
      ? null
      : { session: toSession(row), lastSeenAt: row.last_seen_at, stepUpAt: row.step_up_at };
  }

  async lockById(id: string): Promise<AuthSession | null> {
    const row = await this.load(id, " for update");
    return row === null ? null : toSession(row);
  }

  async save(session: AuthSession, now: Date): Promise<void> {
    const s = session.snapshot();
    await this.db.query(
      `insert into platform_sessions
         (id, user_id, refresh_token_hash, previous_refresh_token_hash, created_at, last_rotated_at,
          last_seen_at, expires_at, revoked_at, revocation_reason, user_agent, ip)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (id) do update set
         refresh_token_hash = excluded.refresh_token_hash,
         previous_refresh_token_hash = excluded.previous_refresh_token_hash,
         last_rotated_at = excluded.last_rotated_at,
         last_seen_at = greatest(platform_sessions.last_seen_at, excluded.last_seen_at),
         revoked_at = excluded.revoked_at,
         revocation_reason = excluded.revocation_reason`,
      [
        s.id,
        s.userId,
        s.refreshTokenHash,
        s.previousRefreshTokenHash,
        s.createdAt,
        s.lastRotatedAt,
        now,
        s.expiresAt,
        s.revokedAt,
        s.revocationReason,
        s.userAgent?.slice(0, 512) ?? null,
        s.ip,
      ],
    );
  }

  async touch(id: string, now: Date): Promise<void> {
    await this.db.query("update platform_sessions set last_seen_at = $2 where id = $1", [id, now]);
  }

  async markStepUp(id: string, now: Date): Promise<void> {
    await this.db.query(
      "update platform_sessions set step_up_at = $2, last_seen_at = $2 where id = $1",
      [id, now],
    );
  }

  async revokeAllForUser(
    userId: string,
    reason: "user_disabled" | "admin_revoked" | "password_changed",
    now: Date,
  ): Promise<number> {
    const { rowCount } = await this.db.query(
      `update platform_sessions set revoked_at = $2, revocation_reason = $3
        where user_id = $1 and revoked_at is null`,
      [userId, now, reason],
    );
    return rowCount ?? 0;
  }

  private async load(id: string, lock: string): Promise<Row | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>(
      `select ${COLUMNS} from platform_sessions where id = $1${lock}`,
      [id],
    );
    return rows[0] ?? null;
  }
}
