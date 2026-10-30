import type {
  ChurnRow,
  CohortRow,
  CostRow,
  FunnelCounts,
  IPlatformAnalytics,
  PartnerRow,
  TenantActivity,
  TenantSummary,
} from "../../application/ports/IPlatformAnalytics.js";
import type {
  BusinessType,
  CostRates,
  OnboardingFacts,
} from "../../domain/console/TenantAnalytics.js";
import type { PlatformDb } from "../platform/PlatformDb.js";

const LIVE = `('trialing', 'active', 'past_due', 'read_only')`;

/** The recurring licence fee of a subscription `s` on plan `p` (standard or enterprise). */
const MRR = `coalesce(case when s.status in ('active', 'past_due') then
    case when p.pricing = 'flat_per_branch' then s.branch_count * p.branch_price_minor
         else (select sum(i.quantity * i.unit_minor) from subscription_price_items i
                where i.subscription_id = s.id and i.recurrence = 'monthly' and i.ended_at is null)
    end end, 0)`;

type SummaryRow = {
  tenant_id: string;
  name: string;
  slug: string;
  status: string;
  business_type: BusinessType | null;
  provisioned_at: Date | null;
};

const SUMMARY = `t.id as tenant_id, t.name, t.slug, t.status, a.business_type, t.provisioned_at`;

const summary = (r: SummaryRow): TenantSummary => ({
  tenantId: r.tenant_id,
  name: r.name,
  slug: r.slug,
  status: r.status,
  businessType: r.business_type,
  provisionedAt: r.provisioned_at,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresPlatformAnalytics implements IPlatformAnalytics {
  constructor(private readonly db: PlatformDb) {}

  async funnel(from: Date, until: Date): Promise<FunnelCounts> {
    const { rows } = await this.db.query<Record<keyof FunnelCounts, string>>(
      `select count(*) as signups,
              count(a.email_verified_at) as verified,
              count(*) filter (where a.status = 'approved') as approved,
              count(t.provisioned_at) as provisioned,
              count(*) filter (where o.steps ? 'vehicle_added') as "firstVehicle",
              count(*) filter (where o.steps ? 'first_transaction') as "firstTransaction",
              count(*) filter (where exists (select 1 from billing_invoices i
                                 where i.tenant_id = t.id and i.status = 'paid')) as paying
         from tenant_applications a
         left join tenants t on t.application_id = a.id
         left join tenant_onboarding o on o.tenant_id = t.id
        where a.created_at >= $1 and a.created_at < $2`,
      [from, until],
    );
    const r = rows[0]!;
    return {
      signups: Number(r.signups),
      verified: Number(r.verified),
      approved: Number(r.approved),
      provisioned: Number(r.provisioned),
      firstVehicle: Number(r.firstVehicle),
      firstTransaction: Number(r.firstTransaction),
      paying: Number(r.paying),
    };
  }

  async activity(day: string, now: Date): Promise<TenantActivity[]> {
    const { rows } = await this.db.query<
      SummaryRow & {
        login_days: number;
        average_active: string | null;
        records: string;
        users: number | null;
        vehicles: number | null;
        vehicles_before: number | null;
        billing: "trialing" | "paid_up" | "overdue";
        support: number;
        jobs: string;
        failed_jobs: string;
        api_calls: string;
        api_errors: string;
        mrr: string;
        partner_id: string | null;
      }
    >(
      `with recent as (
         select tenant_id, count(*) filter (where active_users > 0)::int as login_days,
                avg(active_users) as average_active, sum(records_created) as records,
                sum(jobs) as jobs, sum(failed_jobs) as failed_jobs, sum(api_calls) as api_calls,
                sum(api_errors) as api_errors
           from usage_daily where day between $1::date - 13 and $1::date group by tenant_id
       ), latest as (
         select distinct on (tenant_id) tenant_id, users, vehicles
           from usage_daily where day <= $1::date order by tenant_id, day desc
       ), before as (
         select tenant_id, vehicles from usage_daily where day = $1::date - 30
       )
       select ${SUMMARY},
              coalesce(r.login_days, 0) as login_days, r.average_active,
              coalesce(r.records, 0) as records, l.users, l.vehicles, b.vehicles as vehicles_before,
              case when t.status = 'trialing' then 'trialing'
                   when exists (select 1 from billing_invoices i where i.tenant_id = t.id
                                  and i.status = 'open' and i.due_at < $2) then 'overdue'
                   else 'paid_up' end as billing,
              (select count(*)::int from support_sessions ss where ss.tenant_id = t.id
                 and ss.requested_at >= $1::date - 29) as support,
              coalesce(r.jobs, 0) as jobs, coalesce(r.failed_jobs, 0) as failed_jobs,
              coalesce(r.api_calls, 0) as api_calls, coalesce(r.api_errors, 0) as api_errors,
              ${MRR} as mrr, pa.partner_id
         from tenants t
         left join tenant_applications a on a.id = t.application_id
         left join subscriptions s on s.tenant_id = t.id
         left join plans p on p.id = s.plan_id
         left join partner_tenant_attributions pa on pa.tenant_id = t.id
         left join recent r on r.tenant_id = t.id
         left join latest l on l.tenant_id = t.id
         left join before b on b.tenant_id = t.id
        where t.status in ${LIVE}
        order by t.name, t.id`,
      [day, now],
    );
    const entities = await this.db.query<{ tenant_id: string; entity: string; n: string }>(
      `select u.tenant_id, m.key as entity, sum(m.value::int) as n
         from usage_daily u, jsonb_each_text(u.modules) m
        where u.day between $1::date - 29 and $1::date
        group by 1, 2`,
      [day],
    );
    const byTenant = new Map<string, Record<string, number>>();
    for (const e of entities.rows) {
      const map = byTenant.get(e.tenant_id) ?? {};
      map[e.entity] = Number(e.n);
      byTenant.set(e.tenant_id, map);
    }
    return rows.map((r) => ({
      ...summary(r),
      loginDays: r.login_days,
      averageActiveUsers: Number(r.average_active ?? 0),
      users: r.users ?? 0,
      recordsCreated: Number(r.records),
      vehicles: r.vehicles ?? 0,
      vehiclesBefore: r.vehicles_before,
      entities: byTenant.get(r.tenant_id) ?? {},
      billing: r.billing,
      supportSessions: r.support,
      jobs: Number(r.jobs),
      failedJobs: Number(r.failed_jobs),
      apiCalls: Number(r.api_calls),
      apiErrors: Number(r.api_errors),
      mrrMinor: Number(r.mrr),
      partnerId: r.partner_id,
    }));
  }

  async cohorts(fromMonth: string): Promise<CohortRow[]> {
    const { rows } = await this.db.query<{
      tenant_id: string;
      cohort: string;
      active_months: string[];
      paying_from: string | null;
      mrr: string;
    }>(
      `select t.id as tenant_id, to_char(t.provisioned_at, 'YYYY-MM') as cohort,
              array(select distinct to_char(u.day, 'YYYY-MM') from usage_daily u
                     where u.tenant_id = t.id and u.active_users > 0 order by 1) as active_months,
              (select to_char(min(i.paid_at), 'YYYY-MM') from billing_invoices i
                where i.tenant_id = t.id and i.status = 'paid') as paying_from,
              ${MRR} as mrr
         from tenants t
         left join subscriptions s on s.tenant_id = t.id
         left join plans p on p.id = s.plan_id
        where t.provisioned_at >= ($1 || '-01')::date
        order by t.provisioned_at`,
      [fromMonth],
    );
    return rows.map((r) => ({
      tenantId: r.tenant_id,
      cohort: r.cohort,
      activeMonths: r.active_months,
      payingFrom: r.paying_from,
      mrrMinor: Number(r.mrr),
    }));
  }

  async costs(day: string): Promise<CostRow[]> {
    const { rows } = await this.db.query<
      SummaryRow & {
        database_bytes: string | null;
        storage_bytes: string | null;
        api_calls: string;
        jobs: string;
        mrr: string;
      }
    >(
      `with month as (
         select tenant_id, sum(api_calls) as api_calls, sum(jobs) as jobs
           from usage_daily where day between $1::date - 29 and $1::date group by tenant_id
       ), latest as (
         select distinct on (tenant_id) tenant_id, database_bytes, storage_bytes
           from usage_daily where day <= $1::date order by tenant_id, day desc
       )
       select ${SUMMARY}, l.database_bytes, l.storage_bytes,
              coalesce(m.api_calls, 0) as api_calls, coalesce(m.jobs, 0) as jobs, ${MRR} as mrr
         from tenants t
         left join tenant_applications a on a.id = t.application_id
         left join subscriptions s on s.tenant_id = t.id
         left join plans p on p.id = s.plan_id
         left join month m on m.tenant_id = t.id
         left join latest l on l.tenant_id = t.id
        where t.status in ${LIVE}
        order by t.name, t.id`,
      [day],
    );
    return rows.map((r) => ({
      ...summary(r),
      databaseBytes: Number(r.database_bytes ?? 0),
      storageBytes: Number(r.storage_bytes ?? 0),
      apiCalls: Number(r.api_calls),
      jobs: Number(r.jobs),
      mrrMinor: Number(r.mrr),
    }));
  }

  async partners(from: Date, until: Date): Promise<PartnerRow[]> {
    const { rows } = await this.db.query<{
      partner_id: string;
      name: string;
      status: string;
      tenant_ids: string[];
      new_tenants: number;
      churned: number;
      earned: string;
      paid: string;
      outstanding: string;
      currency: string | null;
    }>(
      `select pr.id as partner_id, pr.name, pr.status,
              array(select pa.tenant_id from partner_tenant_attributions pa
                     where pa.partner_id = pr.id order by pa.attributed_at) as tenant_ids,
              (select count(*)::int from partner_tenant_attributions pa
                where pa.partner_id = pr.id and pa.attributed_at >= $1
                  and pa.attributed_at < $2) as new_tenants,
              (select count(distinct h.tenant_id)::int from tenant_status_history h
                 join partner_tenant_attributions pa on pa.tenant_id = h.tenant_id
                where pa.partner_id = pr.id and h.to_status = 'deactivated'
                  and h.created_at >= $1 and h.created_at < $2) as churned,
              coalesce((select sum(e.amount_minor) from partner_commission_entries e
                where e.partner_id = pr.id and e.created_at >= $1 and e.created_at < $2), 0)
                as earned,
              coalesce((select sum(e.amount_minor) from partner_commission_entries e
                where e.partner_id = pr.id and e.status = 'paid'), 0) as paid,
              coalesce((select sum(e.amount_minor) from partner_commission_entries e
                where e.partner_id = pr.id and e.status in ('accrued', 'payable')), 0)
                as outstanding,
              (select min(e.currency) from partner_commission_entries e
                where e.partner_id = pr.id) as currency
         from partners pr
        order by pr.name, pr.id`,
      [from, until],
    );
    return rows.map((r) => ({
      partnerId: r.partner_id,
      name: r.name,
      status: r.status,
      tenantIds: r.tenant_ids,
      newTenants: r.new_tenants,
      churned: r.churned,
      earnedMinor: Number(r.earned),
      paidMinor: Number(r.paid),
      outstandingMinor: Number(r.outstanding),
      currency: r.currency ?? "GHS",
    }));
  }

  async churn(
    from: Date,
    until: Date,
  ): Promise<Readonly<{ deactivated: ChurnRow[]; restored: number }>> {
    const [deactivated, restored] = await Promise.all([
      this.db.query<{ reason: string; n: string }>(
        `select coalesce(reason_category, 'other') as reason, count(*) as n
           from tenant_status_history
          where to_status = 'deactivated' and created_at >= $1 and created_at < $2
          group by 1 order by 2 desc, 1`,
        [from, until],
      ),
      this.db.query<{ n: string }>(
        `select count(*) as n from tenant_status_history
          where from_status = 'deactivated' and to_status <> 'archived'
            and created_at >= $1 and created_at < $2`,
        [from, until],
      ),
    ]);
    return {
      deactivated: deactivated.rows.map((r) => ({ reason: r.reason, count: Number(r.n) })),
      restored: Number(restored.rows[0]?.n ?? 0),
    };
  }

  async tenant(tenantId: string): Promise<TenantSummary | null> {
    if (!UUID.test(tenantId)) return null;
    const { rows } = await this.db.query<SummaryRow>(
      `select ${SUMMARY} from tenants t
         left join tenant_applications a on a.id = t.application_id
        where t.id = $1`,
      [tenantId],
    );
    return rows[0] === undefined ? null : summary(rows[0]);
  }

  async onboarding(tenantId: string): Promise<OnboardingFacts> {
    const { rows } = await this.db.query<{ steps: OnboardingFacts }>(
      "select steps from tenant_onboarding where tenant_id = $1",
      [tenantId],
    );
    return rows[0]?.steps ?? {};
  }

  async rates(): Promise<CostRates> {
    const { rows } = await this.db.query<{
      currency: string;
      tenant_month_minor: string;
      database_gb_month_minor: string;
      storage_gb_month_minor: string;
      api_calls_thousand_minor: string;
      jobs_thousand_minor: string;
    }>("select * from analytics_settings where id");
    const r = rows[0]!;
    return {
      currency: r.currency,
      tenantMonthMinor: Number(r.tenant_month_minor),
      databaseGbMonthMinor: Number(r.database_gb_month_minor),
      storageGbMonthMinor: Number(r.storage_gb_month_minor),
      apiCallsThousandMinor: Number(r.api_calls_thousand_minor),
      jobsThousandMinor: Number(r.jobs_thousand_minor),
    };
  }

  async saveRates(rates: CostRates, by: string): Promise<void> {
    await this.db.query(
      `update analytics_settings
          set currency = $1, tenant_month_minor = $2, database_gb_month_minor = $3,
              storage_gb_month_minor = $4, api_calls_thousand_minor = $5,
              jobs_thousand_minor = $6, updated_at = now(), updated_by = $7
        where id`,
      [
        rates.currency,
        rates.tenantMonthMinor,
        rates.databaseGbMonthMinor,
        rates.storageGbMonthMinor,
        rates.apiCallsThousandMinor,
        rates.jobsThousandMinor,
        by,
      ],
    );
  }
}
