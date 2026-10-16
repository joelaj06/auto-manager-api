import type {
  Attribution,
  AttributionSource,
  IPartnerAttributions,
  IPartnerQueries,
  PartnerApplicationMessage,
  PartnerApplicationRow,
  PartnerDashboardCounts,
  PartnerListItem,
  PartnerTenantFilter,
  PartnerTenantRow,
  PartnerTenantStatusChange,
} from "../../application/ports/IPartnerQueries.js";
import type { TenantStatus } from "../../application/ports/ITenantDirectory.js";
import type { PartnerStatus } from "../../domain/entities/Partner.js";
import type { ApplicationStatus } from "../../domain/entities/TenantApplication.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

type TenantRow = {
  tenant_id: string;
  name: string;
  slug: string;
  status: TenantStatus;
  deactivation_reason: string | null;
  source: AttributionSource;
  attributed_at: Date;
  signed_up_at: Date | null;
  activated_at: Date | null;
  trial_ends_at: Date | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
};

const TENANTS = `select t.id as tenant_id, t.name, t.slug::text as slug, t.status, t.deactivation_reason,
       pa.source, pa.attributed_at, a.created_at as signed_up_at, t.provisioned_at as activated_at,
       t.trial_ends_at, a.contact_name, a.contact_email::text as contact_email, a.contact_phone
  from partner_tenant_attributions pa
  join tenants t on t.id = pa.tenant_id
  left join tenant_applications a on a.tenant_id = t.id`;

const toTenant = (r: TenantRow): PartnerTenantRow => ({
  tenantId: r.tenant_id,
  name: r.name,
  slug: r.slug,
  status: r.status,
  deactivationReason: r.deactivation_reason,
  source: r.source,
  attributedAt: r.attributed_at,
  signedUpAt: r.signed_up_at,
  activatedAt: r.activated_at,
  trialEndsAt: r.trial_ends_at,
  owner:
    r.contact_name === null
      ? null
      : { name: r.contact_name, email: r.contact_email!, phone: r.contact_phone! },
});

type ApplicationRow = {
  id: string;
  status: ApplicationStatus;
  business_name: string;
  desired_slug: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  source: "self" | "assisted";
  submitted_at: Date | null;
  created_at: Date;
  email_verified: boolean;
  phone_verified: boolean;
  tenant_id: string | null;
};

const APPLICATIONS = `select id, status, business_name, desired_slug::text as desired_slug, contact_name,
       contact_email::text as contact_email, contact_phone, source, submitted_at, created_at,
       email_verified_at is not null as email_verified, phone_verified_at is not null as phone_verified,
       tenant_id
  from tenant_applications`;

const toApplication = (r: ApplicationRow): PartnerApplicationRow => ({
  id: r.id,
  status: r.status,
  businessName: r.business_name,
  desiredSlug: r.desired_slug,
  contactName: r.contact_name,
  contactEmail: r.contact_email,
  contactPhone: r.contact_phone,
  source: r.source,
  submittedAt: r.submitted_at,
  createdAt: r.created_at,
  emailVerified: r.email_verified,
  phoneVerified: r.phone_verified,
  tenantId: r.tenant_id,
});

const counts = (rows: readonly { key: string; n: string }[]) =>
  Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));

/** Reseller read models. Partner-scoped queries always filter on the partner id. */
export class PostgresPartnerQueries implements IPartnerQueries {
  constructor(private readonly db: PlatformDb) {}

  async list(
    filter: Readonly<{ status?: PartnerStatus; q?: string; limit: number; before?: string }>,
  ): Promise<PartnerListItem[]> {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      kind: "individual" | "company";
      contact_name: string;
      email: string;
      phone: string;
      region: string | null;
      status: PartnerStatus;
      trusted: boolean;
      referral_code: string;
      users: string;
      tenants: string;
      open_applications: string;
      created_at: Date;
    }>(
      `select p.id, p.name, p.kind, p.contact_name, p.email::text as email, p.phone, p.region,
              p.status, p.trusted, p.referral_code, p.created_at,
              (select count(*) from platform_users u where u.partner_id = p.id) as users,
              (select count(*) from partner_tenant_attributions pa where pa.partner_id = p.id) as tenants,
              (select count(*) from tenant_applications a
                where a.partner_id = p.id
                  and a.status in ('pending_verification', 'pending_review', 'needs_info')) as open_applications
         from partners p
        where ($1::text is null or p.status = $1)
          and ($2::text is null
               or strpos(lower(p.name), lower($2)) > 0
               or p.email = $2::citext
               or p.referral_code = upper($2))
          and ($3::uuid is null or p.id < $3)
        order by p.id desc
        limit $4`,
      [filter.status ?? null, filter.q ?? null, filter.before ?? null, filter.limit],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      contactName: r.contact_name,
      email: r.email,
      phone: r.phone,
      region: r.region,
      status: r.status,
      trusted: r.trusted,
      referralCode: r.referral_code,
      users: Number(r.users),
      tenants: Number(r.tenants),
      openApplications: Number(r.open_applications),
      createdAt: r.created_at,
    }));
  }

  async tenants(partnerId: string, filter: PartnerTenantFilter): Promise<PartnerTenantRow[]> {
    const { rows } = await this.db.query<TenantRow>(
      `${TENANTS}
        where pa.partner_id = $1
          and ($2::text[] is null or t.status = any($2))
          and ($3::text is null
               or strpos(lower(t.name), lower($3)) > 0
               or strpos(lower(t.slug::text), lower($3)) > 0)
          and ($4::uuid is null or t.id < $4)
        order by t.id desc
        limit $5`,
      [
        partnerId,
        filter.status === undefined || filter.status.length === 0 ? null : filter.status,
        filter.q ?? null,
        filter.before ?? null,
        filter.limit,
      ],
    );
    return rows.map(toTenant);
  }

  async tenant(partnerId: string, tenantId: string): Promise<PartnerTenantRow | null> {
    const { rows } = await this.db.query<TenantRow>(
      `${TENANTS} where pa.partner_id = $1 and pa.tenant_id = $2`,
      [partnerId, tenantId],
    );
    return rows[0] === undefined ? null : toTenant(rows[0]);
  }

  async statusHistory(partnerId: string, tenantId: string): Promise<PartnerTenantStatusChange[]> {
    const { rows } = await this.db.query<{
      from_status: string;
      to_status: string;
      reason_category: string | null;
      created_at: Date;
    }>(
      `select h.from_status, h.to_status, h.reason_category, h.created_at
         from tenant_status_history h
         join partner_tenant_attributions pa on pa.tenant_id = h.tenant_id and pa.partner_id = $1
        where h.tenant_id = $2
        order by h.created_at desc
        limit 100`,
      [partnerId, tenantId],
    );
    return rows.map((r) => ({
      from: r.from_status,
      to: r.to_status,
      reasonCategory: r.reason_category,
      at: r.created_at,
    }));
  }

  async applications(
    partnerId: string,
    filter: Readonly<{ status?: ApplicationStatus; limit: number; before?: string }>,
  ): Promise<PartnerApplicationRow[]> {
    const { rows } = await this.db.query<ApplicationRow>(
      `${APPLICATIONS}
        where partner_id = $1
          and ($2::text is null or status = $2)
          and ($3::uuid is null or id < $3)
        order by id desc
        limit $4`,
      [partnerId, filter.status ?? null, filter.before ?? null, filter.limit],
    );
    return rows.map(toApplication);
  }

  async application(
    partnerId: string,
    applicationId: string,
  ): Promise<PartnerApplicationRow | null> {
    const { rows } = await this.db.query<ApplicationRow>(
      `${APPLICATIONS} where partner_id = $1 and id = $2`,
      [partnerId, applicationId],
    );
    return rows[0] === undefined ? null : toApplication(rows[0]);
  }

  async applicationMessages(applicationId: string): Promise<PartnerApplicationMessage[]> {
    const { rows } = await this.db.query<{
      type: string;
      actor_type: string;
      message: string | null;
      created_at: Date;
    }>(
      `select type, actor_type, message, created_at from tenant_application_events
        where application_id = $1 and not internal
        order by created_at`,
      [applicationId],
    );
    return rows.map((r) => ({
      type: r.type,
      from: r.actor_type === "applicant" ? "applicant" : "us",
      message: r.message,
      at: r.created_at,
    }));
  }

  async dashboard(partnerId: string, now: Date): Promise<PartnerDashboardCounts> {
    const [tenants, applications, recent] = await Promise.all([
      this.db.query<{ key: string; n: string }>(
        `select t.status as key, count(*) as n
           from partner_tenant_attributions pa join tenants t on t.id = pa.tenant_id
          where pa.partner_id = $1 group by t.status`,
        [partnerId],
      ),
      this.db.query<{ key: string; n: string }>(
        `select status as key, count(*) as n from tenant_applications
          where partner_id = $1 group by status`,
        [partnerId],
      ),
      this.db.query<{ n: string }>(
        `select count(*) as n from partner_tenant_attributions
          where partner_id = $1 and attributed_at >= $2::timestamptz - interval '30 days'`,
        [partnerId, now],
      ),
    ]);
    return {
      tenantsByStatus: counts(tenants.rows),
      applicationsByStatus: counts(applications.rows),
      tenantsAddedLast30Days: Number(recent.rows[0]?.n ?? 0),
    };
  }
}

export class PostgresPartnerAttributions implements IPartnerAttributions {
  constructor(private readonly db: PlatformDb) {}

  async find(tenantId: string): Promise<Attribution | null> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      partner_id: string;
      source: AttributionSource;
      attributed_at: Date;
    }>(
      "select tenant_id, partner_id, source, attributed_at from partner_tenant_attributions where tenant_id = $1",
      [tenantId],
    );
    const r = rows[0];
    return r === undefined
      ? null
      : {
          tenantId: r.tenant_id,
          partnerId: r.partner_id,
          source: r.source,
          attributedAt: r.attributed_at,
        };
  }

  async attribute(params: {
    tenantId: string;
    partnerId: string;
    source: AttributionSource;
    applicationId: string | null;
    actorId: string | null;
    reason: string | null;
  }): Promise<void> {
    await this.db.query(
      `insert into partner_tenant_attributions
         (tenant_id, partner_id, source, application_id, attributed_by, reason)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (tenant_id) do update set
         partner_id = excluded.partner_id, source = excluded.source,
         application_id = coalesce(excluded.application_id, partner_tenant_attributions.application_id),
         attributed_by = excluded.attributed_by, reason = excluded.reason, attributed_at = now()`,
      [
        params.tenantId,
        params.partnerId,
        params.source,
        params.applicationId,
        params.actorId,
        params.reason,
      ],
    );
  }

  async remove(tenantId: string): Promise<void> {
    await this.db.query("delete from partner_tenant_attributions where tenant_id = $1", [tenantId]);
  }
}
