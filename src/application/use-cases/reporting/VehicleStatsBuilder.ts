import { addDays } from "../../../domain/reporting/DateRange.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { ILogger } from "../../ports/ILogger.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IVehicleStatsStore } from "../../ports/IReporting.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";

/**
 * Keeps `daily_vehicle_stats` current (docs/14 §2): rebuilds every day from the earliest one a
 * write marked stale (a back-dated expense, a late odometer reading …) through today. Runs in the
 * tenant's daily job and before a dashboard reads the stats, so figures are never behind.
 */
export class VehicleStatsBuilder implements ITenantDailyTask {
  readonly name = "vehicle-stats";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      stats: IVehicleStatsStore;
      organisation: IOrganisationSettings;
      calendar: TenantCalendar;
      logger: ILogger;
    }>,
  ) {}

  run(localDate: string): Promise<void> {
    return this.refresh(localDate).then((rows) => {
      if (rows > 0) this.deps.logger.info("Vehicle stats rebuilt", { rows });
    });
  }

  /** Brings the stats up to `today` (default: the tenant's today); returns rows written. */
  async refresh(today?: string): Promise<number> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      await deps.stats.lock();
      const through = today ?? (await deps.calendar.today());
      const state = await deps.stats.state();
      const { timezone } = await deps.organisation.get();
      const next = state.builtThrough === null ? null : addDays(state.builtThrough, 1);
      const from = earliest(state.dirtyFrom, next ?? (await deps.stats.earliestActivity(timezone)));
      // A day is rebuilt only when something touched it or it has not been built yet.
      const stale = state.dirtyFrom !== null || state.builtThrough === null || next! <= through;
      if (!stale) return 0;
      const rows =
        from === null || from > through ? 0 : await deps.stats.rebuild(from, through, timezone);
      await deps.stats.built(
        state.builtThrough !== null && state.builtThrough > through ? state.builtThrough : through,
        state.lastMarkId,
      );
      return rows;
    });
  }
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}
