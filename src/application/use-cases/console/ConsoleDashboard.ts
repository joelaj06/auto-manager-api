import type {
  BillingSummary,
  IBillingRepository,
} from "../../../domain/repositories/IBillingRepository.js";
import type { IClock } from "../../ports/IClock.js";
import type { DashboardCounts, IConsoleTenantQueries } from "../../ports/IConsoleTenantQueries.js";

export type Dashboard = DashboardCounts &
  Readonly<{
    generatedAt: Date;
    /** Tenants that can use the system (trialing, active, past due, read-only). */
    liveTenants: number;
    /** Subscriptions, MRR (standard licences), billed branches, open and overdue invoices. */
    billing: BillingSummary | null;
  }>;

const LIVE = ["trialing", "active", "past_due", "read_only"];

/**
 * Console dashboard business tiles (docs/27 §3.1), including billing (MRR of standard licences,
 * billed branches, open and overdue invoices). "Due for automatic deactivation" arrives with
 * dunning (phase 2); system health has its own endpoint.
 */
export class ConsoleDashboard {
  constructor(
    private readonly deps: Readonly<{
      queries: IConsoleTenantQueries;
      clock: IClock;
      billing?: IBillingRepository;
    }>,
  ) {}

  async get(): Promise<Dashboard> {
    const now = this.deps.clock.now();
    const [counts, billing] = await Promise.all([
      this.deps.queries.dashboard(now),
      this.deps.billing?.summary(now) ?? Promise.resolve(null),
    ]);
    return {
      ...counts,
      generatedAt: now,
      billing,
      liveTenants: LIVE.reduce((n, status) => n + (counts.tenantsByStatus[status] ?? 0), 0),
    };
  }
}
