import { TenantNotFoundForStaffError } from "../../errors/TenantErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type {
  IConsoleTenantQueries,
  TenantListFilter,
  TenantListItem,
  TenantOverview,
  TimelineEntry,
} from "../../ports/IConsoleTenantQueries.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { ITenantDirectory } from "../../ports/ITenantDirectory.js";
import type { ITenantUsage, TenantUsageSnapshot } from "../../ports/ITenantUsage.js";

/** Statuses whose tenant database does not exist (yet). */
const WITHOUT_DATABASE = new Set(["provisioning", "provisioning_failed"]);

export type TenantProfile = TenantOverview &
  Readonly<{
    usage: TenantUsageSnapshot | null;
    /** Why usage is missing: no database yet, or the database could not be read. */
    usageUnavailable: "no_database" | "unreachable" | null;
  }>;

/** Console tenant list, 360° profile and timeline (docs/27 §3.4). Operational data only. */
export class TenantAccounts {
  constructor(
    private readonly deps: Readonly<{
      queries: IConsoleTenantQueries;
      usage: ITenantUsage;
      directory: ITenantDirectory;
      clock: IClock;
      logger: ILogger;
    }>,
  ) {}

  list(filter: TenantListFilter): Promise<TenantListItem[]> {
    return this.deps.queries.list(filter);
  }

  async profile(tenantId: string): Promise<TenantProfile> {
    const overview = await this.deps.queries.overview(tenantId);
    if (overview === null) throw new TenantNotFoundForStaffError();
    if (overview.databaseName === null || WITHOUT_DATABASE.has(overview.status))
      return { ...overview, usage: null, usageUnavailable: "no_database" };
    try {
      const usage = await this.deps.usage.snapshot(tenantId, this.deps.clock.now());
      return { ...overview, usage, usageUnavailable: null };
    } catch (error) {
      this.deps.logger.warn("Tenant usage could not be read", {
        tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ...overview, usage: null, usageUnavailable: "unreachable" };
    }
  }

  async timeline(
    tenantId: string,
    options: Readonly<{ limit: number; before?: Date }>,
  ): Promise<TimelineEntry[]> {
    if ((await this.deps.directory.findById(tenantId)) === null)
      throw new TenantNotFoundForStaffError();
    return this.deps.queries.timeline(tenantId, options);
  }
}
