import type {
  DashboardCounts,
  IConsoleTenantQueries,
  TenantListFilter,
  TenantListItem,
  TenantOverview,
  TimelineEntry,
} from "../../application/ports/IConsoleTenantQueries.js";
import type { TenantStatus } from "../../application/ports/ITenantDirectory.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type ListRow = {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  created_at: Date;
  trial_ends_at: Date | null;
  status_changed_at: Date | null;
  contact_name: string | null;
  contact_email: string | null;
  source: "self" | "assisted" | null;
  tags: string[];
};

const counts = (rows: readonly { key: string | null; n: string }[]): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [r.key ?? "unknown", Number(r.n)]));

/** Console read models over the platform database. */
export class PostgresConsoleTenantQueries implements IConsoleTenantQueries {
  constructor(private readonly db: PlatformDb) {}

  async list(filter: TenantListFilter): Promise<TenantListItem[]> {
    const { rows } = await this.db.query<ListRow>(
      `select t.id, t.slug, t.name, t.status, t.created_at, t.trial_ends_at, t.status_changed_at,
              a.contact_name, a.contact_email::text as contact_email, a.source,
              coalesce((select array_agg(tg.tag order by tg.tag) from tenant_tags tg
                         where tg.tenant_id = t.id), '{}') as tags
         from tenants t
         left join tenant_applications a on a.tenant_id = t.id
        where ($1::text[] is null or t.status = any($1))
          and ($2::text is null
               or strpos(lower(t.name), lower($2)) > 0
               or strpos(lower(t.slug::text), lower($2)) > 0
               or a.contact_email = $2::citext
               or a.contact_phone = $2)
          and ($3::text is null
               or exists (select 1 from tenant_tags tg where tg.tenant_id = t.id and tg.tag = $3))
          and ($4::timestamptz is null or t.created_at >= $4)
          and ($5::timestamptz is null or t.created_at < $5)
          and ($6::uuid is null or t.id < $6)
        order by t.id desc
        limit $7`,
      [
        filter.status === undefined || filter.status.length === 0 ? null : filter.status,
        filter.q ?? null,
        filter.tag ?? null,
        filter.createdFrom ?? null,
        filter.createdTo ?? null,
        filter.before ?? null,
        filter.limit,
      ],
    );
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      createdAt: r.created_at,
      trialEndsAt: r.trial_ends_at,
      statusChangedAt: r.status_changed_at,
      ownerName: r.contact_name,
      ownerEmail: r.contact_email,
      source: r.source,
      tags: r.tags,
    }));
  }

  async overview(tenantId: string): Promise<TenantOverview | null> {
    const { rows } = await this.db.query<{
      id: string;
      slug: string;
      name: string;
      status: TenantStatus;
      previous_status: string | null;
      deactivation_reason: string | null;
      status_message: string | null;
      status_changed_at: Date | null;
      created_at: Date;
      provisioned_at: Date | null;
      trial_ends_at: Date | null;
      catalogue_version: number | null;
      database_name: string | null;
      application: {
        id: string;
        source: "self" | "assisted";
        business_type: string;
        country: string;
        contact_name: string;
        contact_email: string;
        contact_phone: string;
        expected_branches: number;
        expected_vehicles: number;
        referral_code: string | null;
        partner_id: string | null;
        submitted_at: string | null;
        reviewed_at: string | null;
      } | null;
      prov_status: "running" | "failed" | "completed" | null;
      prov_step: string | null;
      prov_attempts: number | null;
      prov_error: string | null;
      schema_version: string | null;
      schema_status: "ok" | "failed" | null;
      schema_error: string | null;
      schema_updated_at: Date | null;
      backup_succeeded_at: Date | null;
      backup_size: string | null;
      backup_verified_at: Date | null;
      backup_failed_at: Date | null;
      tags: string[];
      notes: string;
      pinned_notes: string;
      pending_approvals: string;
    }>(
      `select t.id, t.slug, t.name, t.status, t.previous_status, t.deactivation_reason,
              t.status_message, t.status_changed_at, t.created_at, t.provisioned_at,
              t.trial_ends_at, t.catalogue_version, t.database_name,
              (select to_jsonb(a) from (
                 select id, source, business_type, country, contact_name, contact_email,
                        contact_phone, expected_branches, expected_vehicles, referral_code,
                        partner_id, submitted_at, reviewed_at
                   from tenant_applications where tenant_id = t.id limit 1) a) as application,
              p.status as prov_status, p.step as prov_step, p.attempts as prov_attempts,
              p.last_error as prov_error,
              s.schema_version, s.status as schema_status, s.error as schema_error,
              s.updated_at as schema_updated_at,
              ok.finished_at as backup_succeeded_at, ok.size_bytes as backup_size,
              (select max(verified_at) from backups where tenant_id = t.id) as backup_verified_at,
              (select max(started_at) from backups
                where tenant_id = t.id and status = 'failed') as backup_failed_at,
              coalesce((select array_agg(tag order by tag) from tenant_tags
                         where tenant_id = t.id), '{}') as tags,
              (select count(*) from tenant_notes
                where tenant_id = t.id and deleted_at is null) as notes,
              (select count(*) from tenant_notes
                where tenant_id = t.id and deleted_at is null and pinned) as pinned_notes,
              (select count(*) from platform_approval_requests
                where target_tenant_id = t.id and status = 'pending') as pending_approvals
         from tenants t
         left join tenant_provisioning p on p.tenant_id = t.id
         left join tenant_schema_status s on s.tenant_id = t.id
         left join lateral (
           select finished_at, size_bytes from backups
            where tenant_id = t.id and status = 'succeeded'
            order by started_at desc limit 1) ok on true
        where t.id = $1`,
      [tenantId],
    );
    const r = rows[0];
    if (r === undefined) return null;
    const a = r.application;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      status: r.status,
      previousStatus: r.previous_status,
      deactivationReason: r.deactivation_reason,
      statusMessage: r.status_message,
      statusChangedAt: r.status_changed_at,
      createdAt: r.created_at,
      provisionedAt: r.provisioned_at,
      trialEndsAt: r.trial_ends_at,
      catalogueVersion: r.catalogue_version,
      databaseName: r.database_name,
      application:
        a === null
          ? null
          : {
              id: a.id,
              source: a.source,
              businessType: a.business_type,
              country: a.country,
              contactName: a.contact_name,
              contactEmail: a.contact_email,
              contactPhone: a.contact_phone,
              expectedBranches: a.expected_branches,
              expectedVehicles: a.expected_vehicles,
              referralCode: a.referral_code,
              partnerId: a.partner_id,
              submittedAt: a.submitted_at === null ? null : new Date(a.submitted_at),
              reviewedAt: a.reviewed_at === null ? null : new Date(a.reviewed_at),
            },
      provisioning:
        r.prov_status === null
          ? null
          : {
              status: r.prov_status,
              step: r.prov_step!,
              attempts: r.prov_attempts!,
              lastError: r.prov_error,
            },
      schema:
        r.schema_status === null
          ? null
          : {
              version: r.schema_version,
              status: r.schema_status,
              error: r.schema_error,
              updatedAt: r.schema_updated_at!,
            },
      backups: {
        lastSucceededAt: r.backup_succeeded_at,
        lastSizeBytes: r.backup_size === null ? null : Number(r.backup_size),
        lastVerifiedAt: r.backup_verified_at,
        lastFailedAt: r.backup_failed_at,
      },
      tags: r.tags,
      notes: { count: Number(r.notes), pinned: Number(r.pinned_notes) },
      pendingApprovals: Number(r.pending_approvals),
    };
  }

  async timeline(
    tenantId: string,
    options: Readonly<{ limit: number; before?: Date }>,
  ): Promise<TimelineEntry[]> {
    const { rows } = await this.db.query<{
      at: Date;
      source: "application" | "audit";
      type: string;
      actor_type: string;
      actor_id: string | null;
      summary: string | null;
      details: unknown;
    }>(
      `select * from (
         select e.created_at as at, 'application' as source, e.type, e.actor_type, e.actor_id,
                e.message as summary, e.details
           from tenant_application_events e
           join tenant_applications a on a.id = e.application_id
          where a.tenant_id = $1
         union all
         select l.occurred_at, 'audit', l.action, l.actor_type, l.actor_id, l.reason,
                jsonb_strip_nulls(jsonb_build_object('before', l.before, 'after', l.after,
                                                     'entityType', l.entity_type,
                                                     'entityId', l.entity_id))
           from platform_audit_logs l
          where l.target_tenant_id = $1
       ) entries
       where ($2::timestamptz is null or at < $2)
       order by at desc
       limit $3`,
      [tenantId, options.before ?? null, options.limit],
    );
    return rows.map((r) => ({
      at: r.at,
      source: r.source,
      type: r.type,
      actorType: r.actor_type,
      actorId: r.actor_id,
      summary: r.summary,
      details: r.details,
    }));
  }

  async dashboard(now: Date): Promise<DashboardCounts> {
    type KeyCount = { key: string | null; n: string };
    const [byStatus, byReason, applications, recent, other] = await Promise.all([
      this.db.query<KeyCount>("select status as key, count(*) as n from tenants group by status"),
      this.db.query<KeyCount>(
        `select deactivation_reason as key, count(*) as n from tenants
          where status = 'deactivated' group by deactivation_reason`,
      ),
      this.db.query<KeyCount>(
        `select status as key, count(*) as n from tenant_applications
          where status in ('pending_verification', 'pending_review', 'needs_info')
          group by status`,
      ),
      this.db.query<{ apps7: string; apps30: string; tenants7: string; tenants30: string }>(
        `select
           (select count(*) from tenant_applications
             where created_at >= $1::timestamptz - interval '7 days')  as apps7,
           (select count(*) from tenant_applications
             where created_at >= $1::timestamptz - interval '30 days') as apps30,
           (select count(*) from tenants
             where created_at >= $1::timestamptz - interval '7 days'
               and status not in ('provisioning', 'provisioning_failed')) as tenants7,
           (select count(*) from tenants
             where created_at >= $1::timestamptz - interval '30 days'
               and status not in ('provisioning', 'provisioning_failed')) as tenants30`,
        [now],
      ),
      this.db.query<{
        trials: string;
        oldest_review: Date | null;
        prov_failed: string;
        schema_failed: string;
        approvals: string;
      }>(
        `select
           (select count(*) from tenants
             where status = 'trialing'
               and trial_ends_at between $1 and $1::timestamptz + interval '7 days') as trials,
           (select min(submitted_at) from tenant_applications
             where status = 'pending_review')                                      as oldest_review,
           (select count(*) from tenant_provisioning where status = 'failed')     as prov_failed,
           (select count(*) from tenant_schema_status where status = 'failed')    as schema_failed,
           (select count(*) from platform_approval_requests
             where status = 'pending' and expires_at > $1)                         as approvals`,
        [now],
      ),
    ]);
    const r = recent.rows[0]!;
    const o = other.rows[0]!;
    return {
      tenantsByStatus: counts(byStatus.rows),
      deactivatedByReason: counts(byReason.rows),
      applicationsByStatus: counts(applications.rows),
      newApplications: { last7Days: Number(r.apps7), last30Days: Number(r.apps30) },
      newTenants: { last7Days: Number(r.tenants7), last30Days: Number(r.tenants30) },
      trialsEndingWithin7Days: Number(o.trials),
      oldestPendingReviewAt: o.oldest_review,
      provisioningFailed: Number(o.prov_failed),
      schemaFailures: Number(o.schema_failed),
      pendingApprovals: Number(o.approvals),
    };
  }
}
