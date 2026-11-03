import { createHash, randomBytes } from "node:crypto";
import type { DemoPurpose, SampleDataStatus } from "../../domain/console/DemoTenants.js";
import type {
  BusinessType,
  DemoChanges,
  DemoTenant,
  IDemoTenants,
  NewDemo,
} from "../../application/ports/IDemoTenants.js";
import type { Queryable } from "../database/postgres/Queryable.js";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown) => (typeof v === "string" ? v : null);
const date = (v: unknown) => (v instanceof Date ? v : null);

const DEMOS = `
  select d.*, t.slug::text as slug, t.name, t.status as tenant_status, t.cluster_id,
         t.database_name is not null as has_database, p.status as provisioning,
         a.business_type, a.contact_name, a.contact_email::text as contact_email
    from demo_tenants d
    join tenants t on t.id = d.tenant_id
    join tenant_applications a on a.id = t.application_id
    left join tenant_provisioning p on p.tenant_id = d.tenant_id`;

const toDemo = (r: Row): DemoTenant => ({
  tenantId: String(r.tenant_id),
  slug: String(r.slug),
  name: String(r.name),
  tenantStatus: String(r.tenant_status),
  businessType: r.business_type as BusinessType,
  clusterId: String(r.cluster_id),
  hasDatabase: r.has_database === true,
  provisioning: text(r.provisioning),
  purpose: r.purpose as DemoPurpose,
  prospect: text(r.prospect),
  contactName: String(r.contact_name),
  contactEmail: String(r.contact_email),
  sampleData: r.sample_data as SampleDataStatus,
  sampleReport: r.sample_report as Readonly<Record<string, unknown>>,
  sampleError: text(r.sample_error),
  expiresAt: r.expires_at as Date,
  extensions: Number(r.extensions),
  expiredAt: date(r.expired_at),
  purgedAt: date(r.purged_at),
  createdBy: String(r.created_by),
  createdAt: r.created_at as Date,
});

const COLUMNS: Readonly<Record<keyof DemoChanges, string>> = {
  sampleData: "sample_data",
  sampleReport: "sample_report",
  sampleError: "sample_error",
  expiresAt: "expires_at",
  extensions: "extensions",
  expiredAt: "expired_at",
  purgedAt: "purged_at",
};

/** Demo tenants in the platform database (platform migration 0026). */
export class PostgresDemoTenants implements IDemoTenants {
  constructor(private readonly db: Queryable) {}

  async slugTaken(slug: string): Promise<boolean> {
    const { rows } = await this.db.query<{ taken: boolean }>(
      `select exists (select 1 from tenants where slug = $1)
           or exists (select 1 from tenant_applications
                       where desired_slug = $1 and status <> 'rejected') as taken`,
      [slug],
    );
    return rows[0]?.taken === true;
  }

  async liveCount(): Promise<number> {
    const { rows } = await this.db.query<{ n: number }>(
      "select count(*)::int as n from demo_tenants where purged_at is null",
    );
    return rows[0]!.n;
  }

  async createApplication(demo: NewDemo): Promise<string> {
    const { rows } = await this.db.query<{ id: string }>(
      `insert into tenant_applications
         (status, source, business_name, business_type, desired_slug, contact_name, contact_email,
          contact_phone, expected_branches, expected_vehicles, heard_about, created_by_staff_id,
          access_token_hash, email_verified_at, phone_verified_at, submitted_at, reviewed_by,
          reviewed_at, decision_reason, approval_options, terms_accepted_at)
       values ('approved', 'assisted', $1, $2, $3, $4, $5, $6, 1, 12, 'Demo tenant', $7, $8,
               now(), now(), now(), $7, now(), 'Demo tenant', $9::jsonb, now())
       returning id`,
      [
        demo.name,
        demo.businessType,
        demo.slug,
        demo.contactName,
        demo.contactEmail,
        demo.contactPhone,
        demo.createdBy,
        // Nobody follows a demo's application: a random link that is never sent.
        createHash("sha256").update(randomBytes(32)).digest("hex"),
        JSON.stringify({ plan: "standard", trialDays: demo.trialDays, demo: true }),
      ],
    );
    return rows[0]!.id;
  }

  async markDemo(demo: NewDemo): Promise<void> {
    await this.db.query("update tenants set demo = true where id = $1", [demo.tenantId]);
    await this.db.query(
      `update tenant_applications set tenant_id = $1
        where id = (select application_id from tenants where id = $1)`,
      [demo.tenantId],
    );
    await this.db.query(
      `insert into demo_tenants (tenant_id, purpose, prospect, sample_data, expires_at, created_by)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        demo.tenantId,
        demo.purpose,
        demo.prospect,
        demo.sampleData ? "pending" : "none",
        demo.expiresAt,
        demo.createdBy,
      ],
    );
  }

  async find(tenantId: string): Promise<DemoTenant | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<Row>(`${DEMOS} where d.tenant_id = $1`, [tenantId]);
    return rows[0] === undefined ? null : toDemo(rows[0]);
  }

  async list(filter: Readonly<{ live?: boolean; limit: number }>): Promise<DemoTenant[]> {
    const { rows } = await this.db.query<Row>(
      `${DEMOS} ${filter.live === true ? "where d.purged_at is null" : ""}
        order by d.created_at desc limit $1`,
      [filter.limit],
    );
    return rows.map(toDemo);
  }

  async update(tenantId: string, changes: DemoChanges): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [tenantId];
    for (const [key, value] of Object.entries(changes) as [keyof DemoChanges, unknown][]) {
      if (value === undefined) continue;
      params.push(key === "sampleReport" ? JSON.stringify(value) : value);
      sets.push(`${COLUMNS[key]} = $${params.length}${key === "sampleReport" ? "::jsonb" : ""}`);
    }
    if (sets.length === 0) return;
    await this.db.query(
      `update demo_tenants set ${sets.join(", ")}, updated_at = now() where tenant_id = $1`,
      params,
    );
  }

  async due(
    now: Date,
    purgeBefore: Date,
  ): Promise<Readonly<{ expire: string[]; purge: string[]; seed: string[] }>> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      action: "expire" | "purge" | "seed";
    }>(
      `select d.tenant_id,
              case when d.expired_at is null and d.expires_at <= $1 then 'expire'
                   when d.expired_at is not null then 'purge'
                   else 'seed' end as action
         from demo_tenants d
         join tenant_provisioning p on p.tenant_id = d.tenant_id and p.status = 'completed'
        where d.purged_at is null
          and ((d.expired_at is null and d.expires_at <= $1)
               or (d.expired_at is not null and d.expired_at <= $2)
               or (d.expired_at is null and d.sample_data in ('pending', 'seeding')
                   and d.updated_at < $1 - interval '30 minutes'))
        order by d.expires_at`,
      [now, purgeBefore],
    );
    const of = (action: string) => rows.filter((r) => r.action === action).map((r) => r.tenant_id);
    return { expire: of("expire"), purge: of("purge"), seed: of("seed") };
  }

  async forgetDatabase(tenantId: string): Promise<void> {
    await this.db.query("update tenants set database_name = null where id = $1 and demo", [
      tenantId,
    ]);
  }
}
