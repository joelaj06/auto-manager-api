import type { IClock } from "../../ports/IClock.js";
import type { DashboardCounts, IConsoleTenantQueries } from "../../ports/IConsoleTenantQueries.js";

export type Dashboard = DashboardCounts &
  Readonly<{
    generatedAt: Date;
    /** Tenants that can use the system (trialing, active, past due, read-only). */
    liveTenants: number;
  }>;

const LIVE = ["trialing", "active", "past_due", "read_only"];

/**
 * Console dashboard business tiles (docs/27 §3.1). Billing tiles (MRR, due for automatic
 * deactivation) arrive with subscriptions (P1-10); system health has its own endpoint.
 */
export class ConsoleDashboard {
  constructor(private readonly deps: Readonly<{ queries: IConsoleTenantQueries; clock: IClock }>) {}

  async get(): Promise<Dashboard> {
    const now = this.deps.clock.now();
    const counts = await this.deps.queries.dashboard(now);
    return {
      ...counts,
      generatedAt: now,
      liveTenants: LIVE.reduce((n, status) => n + (counts.tenantsByStatus[status] ?? 0), 0),
    };
  }
}
