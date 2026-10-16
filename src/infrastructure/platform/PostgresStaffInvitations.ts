import type {
  IStaffInvitations,
  StaffInvitation,
} from "../../application/ports/IStaffInvitations.js";
import type { PlatformDb } from "./PlatformDb.js";

export class PostgresStaffInvitations implements IStaffInvitations {
  constructor(private readonly db: PlatformDb) {}

  async create(params: {
    id: string;
    userId: string;
    tokenHash: string;
    invitedBy: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await this.db.query(
      `insert into platform_invitations (id, user_id, token_hash, invited_by, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [params.id, params.userId, params.tokenHash, params.invitedBy, params.expiresAt],
    );
  }

  async lockValid(tokenHash: string, now: Date): Promise<StaffInvitation | null> {
    const { rows } = await this.db.query<{ id: string; user_id: string; expires_at: Date }>(
      `select id, user_id, expires_at from platform_invitations
        where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > $2
        for update`,
      [tokenHash, now],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : { id: row.id, userId: row.user_id, expiresAt: row.expires_at };
  }

  async markAccepted(id: string, now: Date): Promise<void> {
    await this.db.query("update platform_invitations set accepted_at = $2 where id = $1", [
      id,
      now,
    ]);
  }

  async revokeOpen(userId: string, now: Date): Promise<void> {
    await this.db.query(
      `update platform_invitations set revoked_at = $2
        where user_id = $1 and accepted_at is null and revoked_at is null`,
      [userId, now],
    );
  }
}
