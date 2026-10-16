import type {
  ITenantProvisioning,
  ProvisioningRecord,
  ProvisioningStep,
} from "../../application/ports/ITenantProvisioning.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type Row = {
  tenant_id: string;
  slug: string;
  name: string;
  timezone: string;
  tenant_status: string;
  status: ProvisioningRecord["status"];
  step: ProvisioningStep;
  attempts: number;
  last_error: string | null;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  application_id: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  country: string;
  tin: string | null;
  registration_number: string | null;
  trial_days: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** tenants + tenant_provisioning (+ the approved application) in the platform database. */
export class PostgresTenantProvisioning implements ITenantProvisioning {
  constructor(private readonly db: PlatformDb) {}

  async register(params: {
    tenantId: string;
    slug: string;
    name: string;
    timezone: string;
    applicationId: string;
  }): Promise<void> {
    await this.db.query(
      `insert into tenants (id, slug, name, status, timezone, application_id)
       values ($1, $2, $3, 'provisioning', $4, $5)`,
      [params.tenantId, params.slug, params.name, params.timezone, params.applicationId],
    );
    await this.db.query("insert into tenant_provisioning (tenant_id) values ($1)", [
      params.tenantId,
    ]);
  }

  async find(tenantId: string): Promise<ProvisioningRecord | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<Row>(
      `select p.tenant_id, t.slug::text as slug, t.name, t.timezone, t.status as tenant_status,
              p.status, p.step, p.attempts, p.last_error, p.started_at, p.updated_at, p.completed_at,
              a.id as application_id, a.contact_name, a.contact_email::text as contact_email,
              a.contact_phone, a.country, a.tin, a.registration_number,
              coalesce((a.approval_options->>'trialDays')::int, 14) as trial_days
         from tenant_provisioning p
         join tenants t on t.id = p.tenant_id
         join tenant_applications a on a.id = t.application_id
        where p.tenant_id = $1`,
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    return {
      tenantId: r.tenant_id,
      slug: r.slug,
      name: r.name,
      timezone: r.timezone,
      tenantStatus: r.tenant_status,
      status: r.status,
      step: r.step,
      attempts: r.attempts,
      lastError: r.last_error,
      startedAt: r.started_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
      application: {
        id: r.application_id,
        contactName: r.contact_name,
        contactEmail: r.contact_email,
        contactPhone: r.contact_phone,
        country: r.country,
        tin: r.tin,
        registrationNumber: r.registration_number,
        trialDays: r.trial_days,
      },
    };
  }

  async begin(tenantId: string): Promise<void> {
    await this.db.query(
      `update tenant_provisioning set status = 'running', attempts = attempts + 1, updated_at = now()
        where tenant_id = $1 and status <> 'completed'`,
      [tenantId],
    );
    await this.db.query(
      "update tenants set status = 'provisioning', updated_at = now() where id = $1 and status = 'provisioning_failed'",
      [tenantId],
    );
  }

  async advance(tenantId: string, step: ProvisioningStep): Promise<void> {
    await this.db.query(
      "update tenant_provisioning set step = $2, last_error = null, updated_at = now() where tenant_id = $1",
      [tenantId, step],
    );
  }

  async setDatabaseName(tenantId: string, databaseName: string): Promise<void> {
    await this.db.query("update tenants set database_name = $2, updated_at = now() where id = $1", [
      tenantId,
      databaseName,
    ]);
  }

  async recordSchemaVersion(tenantId: string, version: string | null): Promise<void> {
    await this.db.query(
      `insert into tenant_schema_status (tenant_id, schema_version, status, error, updated_at)
       values ($1, $2, 'ok', null, now())
       on conflict (tenant_id) do update
         set schema_version = excluded.schema_version, status = 'ok', error = null,
             updated_at = now()`,
      [tenantId, version],
    );
  }

  async fail(tenantId: string, error: string): Promise<void> {
    await this.db.query(
      "update tenant_provisioning set status = 'failed', last_error = $2, updated_at = now() where tenant_id = $1",
      [tenantId, error],
    );
    await this.db.query(
      "update tenants set status = 'provisioning_failed', updated_at = now() where id = $1 and status = 'provisioning'",
      [tenantId],
    );
  }

  async complete(
    tenantId: string,
    params: { trialEndsAt: Date; catalogueVersion: number },
  ): Promise<void> {
    await this.db.query(
      `update tenant_provisioning
          set status = 'completed', step = 'completed', last_error = null, updated_at = now(), completed_at = now()
        where tenant_id = $1`,
      [tenantId],
    );
    await this.db.query(
      `update tenants
          set status = 'trialing', trial_ends_at = $2, catalogue_version = $3, provisioned_at = now(),
              updated_at = now()
        where id = $1 and status in ('provisioning', 'provisioning_failed')`,
      [tenantId, params.trialEndsAt, params.catalogueVersion],
    );
  }

  async stalled(before: Date): Promise<string[]> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      "select tenant_id from tenant_provisioning where status = 'running' and updated_at < $1",
      [before],
    );
    return rows.map((r) => r.tenant_id);
  }

  async behindCatalogue(version: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `select id from tenants
        where provisioned_at is not null and coalesce(catalogue_version, 0) < $1
          and status not in ('provisioning', 'provisioning_failed', 'archived')
        order by id`,
      [version],
    );
    return rows.map((r) => r.id);
  }

  async setCatalogueVersion(tenantId: string, version: number): Promise<void> {
    await this.db.query(
      "update tenants set catalogue_version = greatest(coalesce(catalogue_version, 0), $2) where id = $1",
      [tenantId, version],
    );
  }
}
