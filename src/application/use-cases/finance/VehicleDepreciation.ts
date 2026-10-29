import { credit, debit } from "../../../domain/finance/Journal.js";
import { accumulatedDepreciation } from "../../../domain/vehicles/Vehicle.js";
import type { ITenantDailyTask } from "../../jobs/ITenantDailyTask.js";
import type { DepreciatingVehicle, IDepreciationLedger } from "../../ports/IDealerCommissions.js";
import type { ILedger } from "../../ports/IFinanceRecords.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "./LedgerPosting.js";

export const DEPRECIATION_SOURCE = "vehicle_depreciation";

/** The last day of the month before `date`'s. */
export function previousMonthEnd(date: string): string {
  return TenantCalendar.addDays(`${date.slice(0, 7)}-01`, -1);
}

/**
 * Depreciation in the books (docs/13, decision 455): straight-line vehicles are charged Dr 6000
 * Depreciation, Cr 1510 Accumulated depreciation up to the end of each month that ended, by the
 * daily job, and up to the day they are sold, before their cost leaves the books. What is charged
 * is what the vehicle's figures say is due less what was already posted, so a change of useful
 * life or cost is taken up in the next posting; a locked period moves the date to the first open
 * day.
 */
export class VehicleDepreciation implements ITenantDailyTask {
  readonly name = "vehicle_depreciation";

  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      depreciation: IDepreciationLedger;
      ledger: ILedger;
      posting: LedgerPosting;
    }>,
  ) {}

  run(localDate: string): Promise<void> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const asOf = previousMonthEnd(localDate);
      for (const vehicle of await deps.depreciation.vehicles())
        await this.post(vehicle, asOf, null);
    });
  }

  /** Charges one vehicle up to `asOf` (inside the caller's unit of work); returns what was posted. */
  async catchUp(vehicleId: string, asOf: string, userId: string | null): Promise<number> {
    const [vehicle] = await this.deps.depreciation.vehicles(vehicleId);
    return vehicle === undefined ? 0 : this.post(vehicle, asOf, userId);
  }

  private async post(v: DepreciatingVehicle, asOf: string, userId: string | null): Promise<number> {
    const { deps } = this;
    const due =
      accumulatedDepreciation(
        {
          acquisitionCostMinor: v.acquisitionCostMinor,
          residualValueMinor: v.residualValueMinor,
          depreciationMethod: "straight_line",
          acquisitionDate: v.acquisitionDate,
          usefulLifeMonths: v.usefulLifeMonths,
        },
        asOf,
      ) - v.postedMinor;
    if (due <= 0) return 0;
    const locked = await deps.ledger.booksLockedUntil();
    const date = locked !== null && asOf <= locked ? TenantCalendar.addDays(locked, 1) : asOf;
    const accounts = await deps.posting.accounts();
    const tags = { branchId: v.branchId, vehicleId: v.id };
    const journalId = await deps.posting.post(
      {
        date,
        description: `Depreciation to ${asOf}`,
        source: { type: DEPRECIATION_SOURCE, id: v.id },
        lines: [
          debit(due, { accountId: accounts("depreciation"), ...tags }),
          credit(due, { accountId: accounts("accumulated_depreciation"), ...tags }),
        ],
        reversesId: null,
      },
      userId,
    );
    await deps.depreciation.record({
      vehicleId: v.id,
      period: asOf.slice(0, 7),
      amountMinor: due,
      journalId,
    });
    return due;
  }
}
