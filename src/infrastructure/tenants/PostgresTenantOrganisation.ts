import type { BranchView, IBranches } from "../../application/ports/IBranches.js";
import type { IOrganisationReader } from "../../application/ports/ITenantPublicProfiles.js";
import type { ITenantSessionRevoker } from "../../application/ports/ITenantSessionRevoker.js";
import type { PostgresTransactionContext } from "../database/postgres/PostgresTransactionContext.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BranchRow = {
  id: string;
  code: string;
  name: string;
  status: BranchView["status"];
  is_default: boolean;
  deactivated_at: Date | null;
  created_at: Date;
};

const toBranch = (r: BranchRow): BranchView => ({
  id: r.id,
  code: r.code,
  name: r.name,
  status: r.status,
  isDefault: r.is_default,
  deactivatedAt: r.deactivated_at,
  createdAt: r.created_at,
});

/** Branches of the current tenant (tenant unit of work). */
export class PostgresBranches implements IBranches {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async list(): Promise<BranchView[]> {
    const { rows } = await this.transactions
      .current()
      .query<BranchRow>(
        "select id, code, name, status, is_default, deactivated_at, created_at from branches order by is_default desc, name",
      );
    return rows.map(toBranch);
  }

  async lockById(id: string): Promise<BranchView | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.transactions
      .current()
      .query<BranchRow>(
        "select id, code, name, status, is_default, deactivated_at, created_at from branches where id = $1 for update",
        [id],
      );
    return rows[0] === undefined ? null : toBranch(rows[0]);
  }

  async setStatus(
    id: string,
    status: BranchView["status"],
    reason: string | null,
    now: Date,
  ): Promise<void> {
    await this.transactions.current().query(
      `update branches
          set status = $2,
              deactivated_at = case when $2 = 'inactive' then $4::timestamptz end,
              deactivated_reason = case when $2 = 'inactive' then $3::text end,
              updated_at = $4::timestamptz
        where id = $1`,
      [id, status, reason, now],
    );
  }

  async activeCount(): Promise<number> {
    const { rows } = await this.transactions
      .current()
      .query<{ n: string }>("select count(*) as n from branches where status = 'active'");
    return Number(rows[0]?.n ?? 0);
  }

  async invalidateMembers(branchId: string): Promise<number> {
    const { rowCount } = await this.transactions.current().query(
      `update users set permission_version = permission_version + 1, updated_at = now()
        where id in (select user_id from user_branches where branch_id = $1
                     union select user_id from user_roles where branch_id = $1)`,
      [branchId],
    );
    return rowCount ?? 0;
  }
}

/** Revokes every session of the current tenant (tenant unit of work). */
export class PostgresTenantSessionRevoker implements ITenantSessionRevoker {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async revokeAll(reason: "tenant_deactivated", now: Date): Promise<number> {
    const { rowCount } = await this.transactions
      .current()
      .query(
        "update auth_sessions set revoked_at = $1, revocation_reason = $2 where revoked_at is null",
        [now, reason],
      );
    return rowCount ?? 0;
  }
}

/** The organisation row of the current tenant (tenant unit of work). */
export class PostgresOrganisationReader implements IOrganisationReader {
  constructor(private readonly transactions: PostgresTransactionContext) {}

  async get() {
    const { rows } = await this.transactions
      .current()
      .query<{ name: string; base_currency: string; timezone: string }>(
        "select name, base_currency, timezone from organisation",
      );
    const r = rows[0];
    return r === undefined
      ? null
      : { name: r.name, baseCurrency: r.base_currency, timezone: r.timezone };
  }
}
