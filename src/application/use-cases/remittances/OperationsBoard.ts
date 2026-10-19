import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  IOperationsQueries,
  IRemittanceSettingsStore,
  ShortfallDriver,
} from "../../ports/IRemittanceRecords.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { DriverAdministration, DriverView } from "../parties/DriverAdministration.js";

export type OperationsBoardView = Readonly<{
  date: string;
  fleet: Readonly<{
    /** With a driver (assigned, on work and pay). */
    out: number;
    /** Ready but without a driver. */
    idle: number;
    inMaintenance: number;
    other: number;
  }>;
  remittances: Readonly<{
    due: number;
    expected: MoneyJson;
    received: MoneyJson;
    /** Rows due that day by status (pending, submitted, partially_paid, paid …). */
    byStatus: Readonly<Record<string, number>>;
  }>;
  /** Drivers with several short periods in the last 14 days. */
  driversShort: readonly (Omit<ShortfallDriver, "outstandingMinor"> &
    Readonly<{ outstanding: MoneyJson }>)[];
  /** Licences expiring within 7 days (or expired). */
  licencesExpiring: readonly Pick<
    DriverView,
    "id" | "code" | "firstName" | "lastName" | "licenceExpiresOn"
  >[];
}>;

/**
 * The daily operations board (docs/09 §5): who is out and who is idle, today's remittances
 * against what came in, drivers falling behind, licences about to expire — scoped to the
 * caller's branches.
 */
export class OperationsBoard {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      queries: IOperationsQueries;
      settings: IRemittanceSettingsStore;
      drivers: DriverAdministration;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
    }>,
  ) {}

  async board(
    actor: Principal,
    query: Readonly<{ date?: string; branchId?: string }>,
  ): Promise<OperationsBoardView> {
    const { deps } = this;
    const view = await deps.unitOfWork.run(async () => {
      const date = query.date ?? (await deps.calendar.today());
      const branchIds = deps.scope.branchesFor(actor, "operations.board.view");
      const branchId = query.branchId ?? null;
      const base = await deps.posting.baseCurrency();
      const m = (minor: number) => Money.ofMinor(minor, base).toJSON();
      const counts = await deps.queries.fleetCounts(branchIds, branchId);
      const out = (counts.assigned ?? 0) + (counts.on_workpay ?? 0);
      const idle = counts.available ?? 0;
      const inMaintenance = counts.in_maintenance ?? 0;
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      const due = await deps.queries.remittancesDue(date, branchIds, branchId);
      const { shortfallAlertPeriods } = await deps.settings.get();
      const short = await deps.queries.shortfallDrivers(
        TenantCalendar.addDays(date, -14),
        shortfallAlertPeriods,
        branchIds,
        branchId,
      );
      return {
        date,
        fleet: { out, idle, inMaintenance, other: total - out - idle - inMaintenance },
        remittances: {
          due: due.count,
          expected: m(due.expectedMinor),
          received: m(due.receivedMinor),
          byStatus: due.byStatus,
        },
        driversShort: short.map(({ outstandingMinor, ...d }) => ({
          ...d,
          outstanding: m(outstandingMinor),
        })),
      };
    });
    const licences = await deps.drivers.expiringLicences(actor, 7);
    return {
      ...view,
      licencesExpiring: licences
        .filter((d) => query.branchId === undefined || d.branchId === query.branchId)
        .map((d) => ({
          id: d.id,
          code: d.code,
          firstName: d.firstName,
          lastName: d.lastName,
          licenceExpiresOn: d.licenceExpiresOn,
        })),
    };
  }
}
