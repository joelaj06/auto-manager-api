import type {
  ITenantDatabaseCredentials,
  ITenantLoginCache,
  TenantCredentialRecord,
} from "../../application/ports/ITenantDatabaseCredentials.js";
import type { ISecretBox } from "../../application/ports/ISecretBox.js";
import type { TenantId } from "../../domain/value-objects/TenantId.js";
import { TtlCache } from "../cache/TtlCache.js";
import type { Queryable } from "../database/postgres/Queryable.js";
import type { TenantLogin } from "../database/postgres/TenantConnectionPools.js";

type Row = Record<string, unknown>;

export class PostgresTenantDatabaseCredentials implements ITenantDatabaseCredentials {
  constructor(private readonly db: Queryable) {}

  async find(tenantId: string): Promise<TenantCredentialRecord | null> {
    const { rows } = await this.db.query<Row>(
      "select * from tenant_database_credentials where tenant_id = $1",
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      tenantId: String(r.tenant_id),
      roleName: String(r.role_name),
      sealedPassword: String(r.sealed_password),
      version: Number(r.version),
      status: r.status as TenantCredentialRecord["status"],
      rotatedAt: r.rotated_at as Date,
      createdAt: r.created_at as Date,
    };
  }

  async save(record: Parameters<ITenantDatabaseCredentials["save"]>[0], now: Date): Promise<void> {
    await this.db.query(
      `insert into tenant_database_credentials
         (tenant_id, role_name, sealed_password, status, rotated_at)
       values ($1, $2, $3, $4, $5)
       on conflict (tenant_id) do update
         set sealed_password = excluded.sealed_password, status = excluded.status,
             rotated_at = excluded.rotated_at,
             version = tenant_database_credentials.version + 1`,
      [record.tenantId, record.roleName, record.sealedPassword, record.status, now],
    );
  }

  async setStatus(tenantId: string, status: TenantCredentialRecord["status"]): Promise<void> {
    await this.db.query("update tenant_database_credentials set status = $2 where tenant_id = $1", [
      tenantId,
      status,
    ]);
  }

  async remove(tenantId: string): Promise<void> {
    await this.db.query("delete from tenant_database_credentials where tenant_id = $1", [tenantId]);
  }
}

/**
 * The login a tenant's pools use, for a few seconds at a time: every connection pool asks on every
 * transaction, and most tenants have none.
 */
export class TenantLogins implements ITenantLoginCache {
  private readonly cache = new TtlCache<TenantLogin | null>({ ttlMs: 5_000, maxEntries: 20_000 });

  constructor(
    private readonly credentials: Pick<ITenantDatabaseCredentials, "find">,
    private readonly secrets: ISecretBox,
  ) {}

  loginFor(tenantId: TenantId): Promise<TenantLogin | null> {
    return this.cache.getOrLoad(tenantId.value, async () => {
      const record = await this.credentials.find(tenantId.value);
      if (record === null || record.status === "enabling") return null;
      return {
        user: record.roleName,
        password: this.secrets.open(record.sealedPassword),
        version: record.version,
      };
    });
  }

  forget(tenantId: string): void {
    this.cache.delete(tenantId);
  }
}
