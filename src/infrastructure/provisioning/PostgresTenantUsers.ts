import type {
  ITenantUserAccounts,
  TenantUserAccount,
} from "../../application/ports/ITenantUserAccounts.js";
import type { IUserInvitations } from "../../application/ports/IUserInvitations.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tenant user credentials, in the caller's tenant unit of work. */
export class PostgresTenantUserAccounts implements ITenantUserAccounts {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async lockById(id: string): Promise<TenantUserAccount | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.transactions.current().query<{
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      status: TenantUserAccount["status"];
      password_hash: string | null;
      permission_version: number;
    }>(
      `select id, name, email::text as email, phone, status, password_hash, permission_version
         from users where id = $1 for update`,
      [id],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          id: r.id,
          name: r.name,
          email: r.email,
          phone: r.phone,
          status: r.status,
          passwordHash: r.password_hash,
          permissionVersion: r.permission_version,
        };
  }

  async activate(id: string, passwordHash: string, now: Date): Promise<void> {
    await this.transactions.current().query(
      `update users set password_hash = $2, status = case when status = 'invited' then 'active' else status end,
              updated_at = $3
        where id = $1`,
      [id, passwordHash, now],
    );
  }

  async recordLogin(id: string, now: Date): Promise<void> {
    await this.transactions
      .current()
      .query("update users set last_login_at = $2 where id = $1", [id, now]);
  }
}

/** One-time "set your password" links, in the caller's tenant unit of work. */
export class PostgresUserInvitations implements IUserInvitations {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async create(params: { userId: string; tokenHash: string; expiresAt: Date }): Promise<string> {
    const tx = this.transactions.current();
    await tx.query(
      `update user_invitations set revoked_at = now()
        where user_id = $1 and accepted_at is null and revoked_at is null`,
      [params.userId],
    );
    const { rows } = await tx.query<{ id: string }>(
      "insert into user_invitations (user_id, token_hash, expires_at) values ($1, $2, $3) returning id",
      [params.userId, params.tokenHash, params.expiresAt],
    );
    return rows[0]!.id;
  }

  async lockValid(tokenHash: string, now: Date) {
    const { rows } = await this.transactions.current().query<{ id: string; user_id: string }>(
      `select id, user_id from user_invitations
        where token_hash = $1 and accepted_at is null and revoked_at is null and expires_at > $2
        for update`,
      [tokenHash, now],
    );
    return rows[0] === undefined ? null : { id: rows[0].id, userId: rows[0].user_id };
  }

  async markAccepted(id: string, now: Date): Promise<void> {
    await this.transactions
      .current()
      .query("update user_invitations set accepted_at = $2 where id = $1", [id, now]);
  }
}
