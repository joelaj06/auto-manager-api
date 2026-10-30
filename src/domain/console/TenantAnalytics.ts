import { DomainError } from "../errors/DomainError.js";

export class AnalyticsRuleError extends DomainError {
  readonly code = "ANALYTICS_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** The modules a business works in, as their audited records show (docs/27 §3.16). */
export const MODULES = [
  "fleet",
  "drivers",
  "workpay",
  "rentals",
  "maintenance",
  "expenses",
  "finance",
  "dealer",
  "documents",
  "reports",
] as const;
export type Module = (typeof MODULES)[number];

/** The business types a tenant applied as. */
export type BusinessType = "fleet" | "rental" | "dealer" | "mixed";

/** Entity type names (whole, or followed by `_`) and their module. */
const NAMES: readonly (readonly [string, Module])[] = [
  ["workpay", "workpay"],
  ["rental", "rentals"],
  ["dealer", "dealer"],
  ["purchase", "dealer"],
  ["appraisal", "dealer"],
  ["test_drive", "dealer"],
  ["sales_quote", "dealer"],
  ["commission", "dealer"],
  ["work_order", "maintenance"],
  ["service", "maintenance"],
  ["part", "maintenance"],
  ["expense", "expenses"],
  ["recurring_expense", "expenses"],
  ["budget", "expenses"],
  ["supplier", "expenses"],
  ["invoice", "finance"],
  ["payment", "finance"],
  ["cash_session", "finance"],
  ["ledger", "finance"],
  ["journal", "finance"],
  ["document", "documents"],
  ["report", "reports"],
  ["dashboard_layout", "reports"],
  ["driver", "drivers"],
  ["remittance", "drivers"],
  ["assignment", "drivers"],
  ["vehicle", "fleet"],
  ["fuel", "fleet"],
  ["incident", "fleet"],
  ["traffic_offence", "fleet"],
  ["insurance_claim", "fleet"],
];

/** The module an audited entity type belongs to (null: settings, users and the like). */
export function moduleOf(entityType: string): Module | null {
  for (const [name, module] of NAMES)
    if (entityType === name || entityType.startsWith(`${name}_`)) return module;
  return null;
}

/** Records per module from the audited entity types and their counts. */
export function moduleCounts(byEntity: Readonly<Record<string, number>>): Record<Module, number> {
  const counts = Object.fromEntries(MODULES.map((m) => [m, 0])) as Record<Module, number>;
  for (const [entity, n] of Object.entries(byEntity)) {
    const module = moduleOf(entity);
    if (module !== null) counts[module] += n;
  }
  return counts;
}

const COMMON: readonly Module[] = ["fleet", "expenses", "finance", "documents", "reports"];

/** The modules a business of a type is expected to use (every plan includes them all). */
export function expectedModules(type: BusinessType): readonly Module[] {
  switch (type) {
    case "fleet":
      return [...COMMON, "drivers", "workpay", "maintenance"];
    case "rental":
      return [...COMMON, "rentals", "maintenance"];
    case "dealer":
      return [...COMMON, "dealer"];
    case "mixed":
      return MODULES;
  }
}

/** The onboarding checklist (docs/27 §3.16), in order. */
export const ONBOARDING_STEPS = [
  { key: "branch_added", label: "Add a second branch" },
  { key: "vehicle_added", label: "Add a vehicle" },
  { key: "driver_added", label: "Add a driver" },
  { key: "user_invited", label: "Invite a colleague" },
  { key: "first_remittance", label: "Record a first remittance" },
  { key: "first_rental", label: "Make a first rental booking" },
  { key: "first_transaction", label: "Record a first payment" },
  { key: "app_installed", label: "Install the app" },
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]["key"];

/** When each step was first done (a date), for the steps done. */
export type OnboardingFacts = Readonly<Partial<Record<OnboardingStep, string>>>;

export type OnboardingProgress = Readonly<{
  done: number;
  total: number;
  percent: number;
  steps: readonly Readonly<{ key: OnboardingStep; label: string; doneOn: string | null }>[];
}>;

/** The checklist of a tenant; a remittance or a rental counts for a business that has them. */
export function onboardingProgress(facts: OnboardingFacts, type: BusinessType): OnboardingProgress {
  const relevant = ONBOARDING_STEPS.filter(
    (s) =>
      (s.key !== "first_remittance" || type === "fleet" || type === "mixed") &&
      (s.key !== "first_rental" || type === "rental" || type === "mixed") &&
      (s.key !== "driver_added" || type !== "dealer"),
  );
  const steps = relevant.map((s) => ({ key: s.key, label: s.label, doneOn: facts[s.key] ?? null }));
  const done = steps.filter((s) => s.doneOn !== null).length;
  return { done, total: steps.length, percent: Math.round((done / steps.length) * 100), steps };
}

/** A tenant's activity over the last 14 days (30 for modules, support and growth). */
export type HealthInput = Readonly<{
  /** Days with at least one user signed in, of the last 14. */
  loginDays: number;
  /** Users signed in per day, on average. */
  averageActiveUsers: number;
  users: number;
  recordsCreated: number;
  vehicles: number;
  /** Vehicles 30 days ago (null without usage that far back). */
  vehiclesBefore: number | null;
  modulesUsed: number;
  modulesExpected: number;
  /** Trialing; paid up; or with an invoice past its due date. */
  billing: "trialing" | "paid_up" | "overdue";
  supportSessions: number;
  jobs: number;
  failedJobs: number;
  apiCalls: number;
  apiErrors: number;
  /** Days since the tenant was provisioned. */
  ageDays: number;
}>;

export type HealthComponents = Readonly<{
  logins: number;
  activeUsers: number;
  records: number;
  breadth: number;
  payments: number;
  support: number;
  errors: number;
}>;

export type HealthFlag = "at_risk" | "expansion_ready" | "new";

export type Health = Readonly<{
  score: number;
  components: HealthComponents;
  flags: readonly HealthFlag[];
}>;

/** Points of each part of the score (they add up to 100). */
export const HEALTH_WEIGHTS: HealthComponents = {
  logins: 20,
  activeUsers: 15,
  records: 20,
  breadth: 15,
  payments: 15,
  support: 5,
  errors: 10,
};

const WINDOW_DAYS = 14;
const AT_RISK_BELOW = 40;
const EXPANSION_FROM = 75;
const NEW_FOR_DAYS = 14;

const share = (n: number, of: number) => (of <= 0 ? 0 : Math.max(0, Math.min(1, n / of)));
const points = (weight: number, part: number) => Math.round(weight * part * 10) / 10;

/**
 * The health score 0–100 (docs/27 §3.16, decision 481): sign-ins on the last 14 days, the share
 * of users active, records created against one a day per vehicle (at least five), the modules
 * used of those expected for the business, invoices paid on time, support sessions and the error
 * rate of its jobs and API calls. Below 40 a tenant is at risk; from 75 with vehicles grown by a
 * fifth in 30 days it is ready to expand; a tenant under 14 days old is new and not flagged.
 */
export function healthScore(input: HealthInput): Health {
  const w = HEALTH_WEIGHTS;
  const requests = input.jobs + input.apiCalls;
  const errorRate = requests === 0 ? 0 : (input.failedJobs + input.apiErrors) / requests;
  const components: HealthComponents = {
    logins: points(w.logins, share(input.loginDays, WINDOW_DAYS)),
    activeUsers: points(w.activeUsers, share(input.averageActiveUsers, input.users)),
    records: points(
      w.records,
      share(input.recordsCreated, WINDOW_DAYS * Math.max(5, input.vehicles)),
    ),
    breadth: points(w.breadth, share(input.modulesUsed, input.modulesExpected)),
    payments: input.billing === "overdue" ? 0 : input.billing === "trialing" ? 10 : w.payments,
    support: input.supportSessions === 0 ? w.support : input.supportSessions <= 2 ? 3 : 0,
    errors: points(w.errors, Math.max(0, 1 - errorRate * 20)),
  };
  const score = Math.round(Object.values(components).reduce((a, b) => a + b, 0));
  const flags: HealthFlag[] = [];
  if (input.ageDays < NEW_FOR_DAYS) flags.push("new");
  else {
    if (score < AT_RISK_BELOW) flags.push("at_risk");
    const grew =
      input.vehiclesBefore !== null &&
      input.vehiclesBefore > 0 &&
      input.vehicles >= input.vehiclesBefore * 1.2;
    if (score >= EXPANSION_FROM && grew) flags.push("expansion_ready");
  }
  return { score, components, flags };
}

/** What serving a tenant costs a month (minor units of `currency`). */
export type CostRates = Readonly<{
  currency: string;
  tenantMonthMinor: number;
  databaseGbMonthMinor: number;
  storageGbMonthMinor: number;
  apiCallsThousandMinor: number;
  jobsThousandMinor: number;
}>;

export function checkRates(rates: CostRates): CostRates {
  for (const [key, value] of Object.entries(rates))
    if (key !== "currency" && (!Number.isInteger(value) || (value as number) < 0))
      throw new AnalyticsRuleError("Cost rates are whole minor units, zero or more");
  if (!/^[A-Z]{3}$/.test(rates.currency))
    throw new AnalyticsRuleError("The currency is a three-letter code");
  return rates;
}

export type TenantCost = Readonly<{
  fixedMinor: number;
  databaseMinor: number;
  storageMinor: number;
  apiMinor: number;
  jobsMinor: number;
  totalMinor: number;
}>;

const GB = 1024 ** 3;

/** A month's cost of a tenant from its size and its last 30 days of calls and jobs. */
export function monthlyCost(
  usage: Readonly<{ databaseBytes: number; storageBytes: number; apiCalls: number; jobs: number }>,
  rates: CostRates,
): TenantCost {
  const databaseMinor = Math.round((usage.databaseBytes / GB) * rates.databaseGbMonthMinor);
  const storageMinor = Math.round((usage.storageBytes / GB) * rates.storageGbMonthMinor);
  const apiMinor = Math.round((usage.apiCalls / 1000) * rates.apiCallsThousandMinor);
  const jobsMinor = Math.round((usage.jobs / 1000) * rates.jobsThousandMinor);
  const fixedMinor = rates.tenantMonthMinor;
  return {
    fixedMinor,
    databaseMinor,
    storageMinor,
    apiMinor,
    jobsMinor,
    totalMinor: fixedMinor + databaseMinor + storageMinor + apiMinor + jobsMinor,
  };
}
