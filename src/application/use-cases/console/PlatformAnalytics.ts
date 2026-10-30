import {
  AnalyticsRuleError,
  checkRates,
  expectedModules,
  healthScore,
  moduleCounts,
  MODULES,
  monthlyCost,
  onboardingProgress,
  type CostRates,
  type Health,
  type HealthFlag,
  type Module,
  type OnboardingFacts,
  type OnboardingProgress,
  type TenantCost,
} from "../../../domain/console/TenantAnalytics.js";
import type { PlatformPrincipal } from "../../authorization/PlatformPrincipal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  ChurnRow,
  FunnelCounts,
  IPlatformAnalytics,
  TenantActivity,
  TenantSummary,
} from "../../ports/IPlatformAnalytics.js";
import type { IPlatformAuditTrail } from "../../ports/IPlatformAuditTrail.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import { recordStaffAction } from "./consoleAudit.js";

export class AnalyticsTenantNotFoundError extends ApplicationError {
  readonly code = "TENANT_NOT_FOUND";
  constructor() {
    super("Tenant not found");
  }
}

const DAY_MS = 86_400_000;
/** At most this long a period (two years). */
const MAX_DAYS = 731;
const MAX_COHORT_MONTHS = 24;

export type Period = Readonly<{ from: string; to: string }>;

export type FunnelView = Readonly<{
  period: Period;
  /** Each step with its count and its share of the step before. */
  steps: readonly Readonly<{ key: keyof FunnelCounts; count: number; conversion: number | null }>[];
}>;

export type TenantHealthView = TenantSummary &
  Health &
  Readonly<{
    mrrMinor: number;
    modulesUsed: readonly Module[];
    onboarding: OnboardingProgress | null;
  }>;

export type AdoptionView = Readonly<{
  day: string;
  tenants: number;
  modules: readonly Readonly<{
    module: Module;
    /** Live tenants with records in it over 30 days. */
    tenants: number;
    percent: number;
    /** Tenants whose business expects it but did not use it (customer-success outreach). */
    unused: readonly Readonly<{ tenantId: string; name: string; slug: string }>[];
  }>[];
}>;

export type CohortView = Readonly<{
  cohort: string;
  tenants: number;
  paying: number;
  mrrMinor: number;
  /** Share of the cohort active in its month 0, 1, 2… up to this month. */
  retention: readonly number[];
}>;

export type CostView = TenantSummary &
  Readonly<{
    cost: TenantCost;
    mrrMinor: number;
    marginMinor: number;
    /** Margin as a share of MRR (null without MRR). */
    marginPercent: number | null;
    databaseBytes: number;
    storageBytes: number;
    apiCalls: number;
    jobs: number;
  }>;

export type ResellerView = Readonly<{
  partnerId: string;
  name: string;
  status: string;
  tenants: number;
  newTenants: number;
  live: number;
  paying: number;
  churned: number;
  mrrMinor: number;
  averageHealth: number | null;
  atRisk: number;
  commission: Readonly<{
    currency: string;
    earnedMinor: number;
    paidMinor: number;
    outstandingMinor: number;
  }>;
}>;

export type ChurnView = Readonly<{
  period: Period;
  deactivated: number;
  byReason: readonly ChurnRow[];
  restored: number;
}>;

/**
 * Platform analytics in the console (docs/27 §3.16, decisions 479–485): the growth funnel from
 * sign-up to paying, feature adoption by module, the health score of every live tenant with its
 * at-risk and expansion-ready flags and onboarding checklist, cohorts by the month provisioned,
 * cost to serve against MRR, reseller performance and churn reasons — read from the nightly
 * `usage_daily`, onboarding milestones and the platform's billing and partner records.
 */
export class PlatformAnalytics {
  constructor(
    private readonly deps: Readonly<{
      analytics: IPlatformAnalytics;
      audit: IPlatformAuditTrail;
      requestContext: IRequestContext;
      clock: IClock;
    }>,
  ) {}

  async funnel(query: Partial<Period>): Promise<FunnelView> {
    const period = this.period(query);
    const counts = await this.deps.analytics.funnel(...this.instants(period));
    const keys: (keyof FunnelCounts)[] = [
      "signups",
      "verified",
      "approved",
      "provisioned",
      "firstVehicle",
      "firstTransaction",
      "paying",
    ];
    return {
      period,
      steps: keys.map((key, i) => {
        const before = i === 0 ? null : counts[keys[i - 1]!];
        return {
          key,
          count: counts[key],
          conversion:
            before === null || before === 0 ? null : Math.round((counts[key] / before) * 1000) / 10,
        };
      }),
    };
  }

  /** Every live tenant's health, the weakest first; optionally only those with a flag. */
  async health(
    query: Readonly<{ flag?: HealthFlag; limit?: number }>,
  ): Promise<TenantHealthView[]> {
    const rows = (await this.activity()).map((a) => this.healthOf(a, null));
    return rows
      .filter((r) => query.flag === undefined || r.flags.includes(query.flag))
      .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
      .slice(0, query.limit ?? 200);
  }

  /** One tenant's health with its onboarding checklist. */
  async tenantHealth(tenantId: string): Promise<TenantHealthView> {
    const { analytics } = this.deps;
    const summary = await analytics.tenant(tenantId);
    if (summary === null) throw new AnalyticsTenantNotFoundError();
    const activity = (await this.activity()).find((a) => a.tenantId === tenantId);
    if (activity === undefined)
      throw new AnalyticsRuleError("The tenant is not live: it has no health score");
    return this.healthOf(activity, await analytics.onboarding(tenantId));
  }

  async adoption(): Promise<AdoptionView> {
    const activity = await this.activity();
    const used = new Map(activity.map((a) => [a.tenantId, moduleCounts(a.entities)] as const));
    return {
      day: this.yesterday(),
      tenants: activity.length,
      modules: MODULES.map((module) => {
        const using = activity.filter((a) => (used.get(a.tenantId)?.[module] ?? 0) > 0);
        return {
          module,
          tenants: using.length,
          percent:
            activity.length === 0 ? 0 : Math.round((using.length / activity.length) * 1000) / 10,
          unused: activity
            .filter(
              (a) =>
                expectedModules(a.businessType ?? "mixed").includes(module) &&
                (used.get(a.tenantId)?.[module] ?? 0) === 0 &&
                (a.provisionedAt === null || this.ageDays(a.provisionedAt) >= 14),
            )
            .map((a) => ({ tenantId: a.tenantId, name: a.name, slug: a.slug })),
        };
      }),
    };
  }

  /** Tenants by the month provisioned over the last `months` months, retained by activity. */
  async cohorts(months = 12): Promise<CohortView[]> {
    if (!Number.isInteger(months) || months < 1 || months > MAX_COHORT_MONTHS)
      throw new AnalyticsRuleError(`Cohorts cover 1 to ${MAX_COHORT_MONTHS} months`);
    const thisMonth = this.deps.clock.now().toISOString().slice(0, 7);
    const first = addMonths(thisMonth, -(months - 1));
    const rows = await this.deps.analytics.cohorts(first);
    const cohorts: CohortView[] = [];
    for (let i = 0; i < months; i++) {
      const cohort = addMonths(first, i);
      const members = rows.filter((r) => r.cohort === cohort);
      const span = monthsBetween(cohort, thisMonth) + 1;
      cohorts.push({
        cohort,
        tenants: members.length,
        paying: members.filter((m) => m.payingFrom !== null).length,
        mrrMinor: members.reduce((sum, m) => sum + m.mrrMinor, 0),
        retention: Array.from({ length: span }, (_, n) => {
          if (members.length === 0) return 0;
          const month = addMonths(cohort, n);
          const active = members.filter((m) => m.activeMonths.includes(month)).length;
          return Math.round((active / members.length) * 1000) / 10;
        }),
      });
    }
    return cohorts;
  }

  /** Each live tenant's monthly cost against its MRR, the thinnest margin first. */
  async costToServe(): Promise<
    Readonly<{ currency: string; rates: CostRates; tenants: CostView[] }>
  > {
    const { analytics } = this.deps;
    const [rates, rows] = await Promise.all([analytics.rates(), analytics.costs(this.yesterday())]);
    const tenants = rows
      .map((r) => {
        const cost = monthlyCost(r, rates);
        const marginMinor = r.mrrMinor - cost.totalMinor;
        return {
          tenantId: r.tenantId,
          name: r.name,
          slug: r.slug,
          status: r.status,
          businessType: r.businessType,
          provisionedAt: r.provisionedAt,
          cost,
          mrrMinor: r.mrrMinor,
          marginMinor,
          marginPercent:
            r.mrrMinor === 0 ? null : Math.round((marginMinor / r.mrrMinor) * 1000) / 10,
          databaseBytes: r.databaseBytes,
          storageBytes: r.storageBytes,
          apiCalls: r.apiCalls,
          jobs: r.jobs,
        };
      })
      .sort((a, b) => a.marginMinor - b.marginMinor || a.name.localeCompare(b.name));
    return { currency: rates.currency, rates, tenants };
  }

  async resellers(
    query: Partial<Period>,
  ): Promise<Readonly<{ period: Period; partners: ResellerView[] }>> {
    const period = this.period(query);
    const [partners, activity] = await Promise.all([
      this.deps.analytics.partners(...this.instants(period)),
      this.activity(),
    ]);
    const live = new Map(activity.map((a) => [a.tenantId, a] as const));
    return {
      period,
      partners: partners.map((p) => {
        const theirs = p.tenantIds.flatMap((id) => {
          const a = live.get(id);
          return a === undefined ? [] : [a];
        });
        const scores = theirs.map((a) => this.healthOf(a, null));
        return {
          partnerId: p.partnerId,
          name: p.name,
          status: p.status,
          tenants: p.tenantIds.length,
          newTenants: p.newTenants,
          live: theirs.length,
          paying: theirs.filter((a) => a.mrrMinor > 0).length,
          churned: p.churned,
          mrrMinor: theirs.reduce((sum, a) => sum + a.mrrMinor, 0),
          averageHealth:
            scores.length === 0
              ? null
              : Math.round(scores.reduce((sum, s) => sum + s.score, 0) / scores.length),
          atRisk: scores.filter((s) => s.flags.includes("at_risk")).length,
          commission: {
            currency: p.currency,
            earnedMinor: p.earnedMinor,
            paidMinor: p.paidMinor,
            outstandingMinor: p.outstandingMinor,
          },
        };
      }),
    };
  }

  async churn(query: Partial<Period>): Promise<ChurnView> {
    const period = this.period(query);
    const { deactivated, restored } = await this.deps.analytics.churn(...this.instants(period));
    return {
      period,
      deactivated: deactivated.reduce((sum, r) => sum + r.count, 0),
      byReason: deactivated,
      restored,
    };
  }

  rates(): Promise<CostRates> {
    return this.deps.analytics.rates();
  }

  async setRates(actor: PlatformPrincipal, rates: CostRates): Promise<CostRates> {
    const { deps } = this;
    const before = await deps.analytics.rates();
    const after = checkRates(rates);
    await deps.analytics.saveRates(after, actor.userId);
    await recordStaffAction(deps, actor, {
      action: "analytics.cost_rates_changed",
      entityType: "analytics_settings",
      before,
      after,
    });
    return after;
  }

  private activity(): Promise<TenantActivity[]> {
    return this.deps.analytics.activity(this.yesterday(), this.deps.clock.now());
  }

  private healthOf(a: TenantActivity, onboarding: OnboardingFacts | null): TenantHealthView {
    const type = a.businessType ?? "mixed";
    const counts = moduleCounts(a.entities);
    const used = MODULES.filter((m) => counts[m] > 0);
    const expected = expectedModules(type);
    const health = healthScore({
      loginDays: a.loginDays,
      averageActiveUsers: a.averageActiveUsers,
      users: a.users,
      recordsCreated: a.recordsCreated,
      vehicles: a.vehicles,
      vehiclesBefore: a.vehiclesBefore,
      modulesUsed: used.filter((m) => expected.includes(m)).length,
      modulesExpected: expected.length,
      billing: a.billing,
      supportSessions: a.supportSessions,
      jobs: a.jobs,
      failedJobs: a.failedJobs,
      apiCalls: a.apiCalls,
      apiErrors: a.apiErrors,
      ageDays: a.provisionedAt === null ? 0 : this.ageDays(a.provisionedAt),
    });
    return {
      tenantId: a.tenantId,
      name: a.name,
      slug: a.slug,
      status: a.status,
      businessType: a.businessType,
      provisionedAt: a.provisionedAt,
      ...health,
      mrrMinor: a.mrrMinor,
      modulesUsed: used,
      onboarding: onboarding === null ? null : onboardingProgress(onboarding, type),
    };
  }

  private ageDays(at: Date): number {
    return Math.floor((this.deps.clock.now().getTime() - at.getTime()) / DAY_MS);
  }

  /** Usage is collected nightly for the day before. */
  private yesterday(): string {
    return new Date(this.deps.clock.now().getTime() - DAY_MS).toISOString().slice(0, 10);
  }

  /** A period of UTC dates, the last 30 days by default. */
  private period(query: Partial<Period>): Period {
    const today = this.deps.clock.now().toISOString().slice(0, 10);
    const to = query.to ?? today;
    const from =
      query.from ??
      new Date(Date.parse(`${to}T00:00:00Z`) - 29 * DAY_MS).toISOString().slice(0, 10);
    const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;
    if (Number.isNaN(days) || days < 0)
      throw new AnalyticsRuleError("The period ends on or after it starts");
    if (days + 1 > MAX_DAYS) throw new AnalyticsRuleError(`A period is at most ${MAX_DAYS} days`);
    return { from, to };
  }

  private instants(period: Period): [Date, Date] {
    return [
      new Date(`${period.from}T00:00:00Z`),
      new Date(Date.parse(`${period.to}T00:00:00Z`) + DAY_MS),
    ];
  }
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}
