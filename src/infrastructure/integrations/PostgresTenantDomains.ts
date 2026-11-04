import type { ITenantDomains, TenantDomainRecord } from "../../application/ports/ITenantDomains.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));

function toDomain(r: Row): TenantDomainRecord {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    domain: String(r.domain),
    status: r.status as TenantDomainRecord["status"],
    verificationToken: String(r.verification_token),
    verifiedAt: date(r.verified_at),
    lastCheckedAt: date(r.last_checked_at),
    lastError: (r.last_error as string | null) ?? null,
    failedChecks: Number(r.failed_checks),
    createdAt: r.created_at as Date,
  };
}

export class PostgresTenantDomains implements ITenantDomains {
  constructor(private readonly db: Queryable) {}

  async create(domain: Parameters<ITenantDomains["create"]>[0]): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into tenant_domains (tenant_id, domain, verification_token, created_by)
       values ($1, $2, $3, $4) returning id`,
      [domain.tenantId, domain.domain, domain.verificationToken, domain.createdBy],
    );
    return rows[0]!.id;
  }

  async find(id: string): Promise<TenantDomainRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<Row>("select * from tenant_domains where id = $1", [id]);
    return rows[0] === undefined ? null : toDomain(rows[0]);
  }

  async findByDomain(domain: string): Promise<TenantDomainRecord | null> {
    const { rows } = await this.db.query<Row>("select * from tenant_domains where domain = $1", [
      domain,
    ]);
    return rows[0] === undefined ? null : toDomain(rows[0]);
  }

  async ofTenant(tenantId: string): Promise<TenantDomainRecord[]> {
    const { rows } = await this.db.query<Row>(
      "select * from tenant_domains where tenant_id = $1 order by created_at",
      [tenantId],
    );
    return rows.map(toDomain);
  }

  async verified(): Promise<TenantDomainRecord[]> {
    const { rows } = await this.db.query<Row>(
      "select * from tenant_domains where status <> 'pending' order by domain",
    );
    return rows.map(toDomain);
  }

  async active() {
    const { rows } = await this.db.query<{ domain: string; slug: string }>(
      `select d.domain, t.slug::text as slug
         from tenant_domains d join tenants t on t.id = d.tenant_id
        where d.status = 'active'`,
    );
    return rows;
  }

  async update(id: string, changes: Parameters<ITenantDomains["update"]>[1]): Promise<void> {
    await this.db.query(
      `update tenant_domains
          set status = $2, verified_at = coalesce($3, verified_at), last_checked_at = $4,
              last_error = $5, failed_checks = $6
        where id = $1`,
      [
        id,
        changes.status,
        changes.verifiedAt ?? null,
        changes.lastCheckedAt,
        changes.lastError === null ? null : changes.lastError.slice(0, 300),
        changes.failedChecks,
      ],
    );
  }

  async remove(id: string): Promise<void> {
    await this.db.query("delete from tenant_domains where id = $1", [id]);
  }
}
