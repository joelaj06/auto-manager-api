import { Money } from "../../../domain/money/Money.js";
import { addDays, DateRange } from "../../../domain/reporting/DateRange.js";
import type { ParamValues } from "../../../domain/reporting/Report.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IReportQueries } from "../../ports/IReportQueries.js";
import type { BranchFilter } from "../../ports/IReporting.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import { localDateTime, localMidnight } from "../../services/TenantLocalTime.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";

export type ReportScope = Readonly<{
  range: DateRange;
  /** The period's local days as instants: midnight of `from` up to midnight after `to`. */
  fromAt: Date;
  untilAt: Date;
  today: string;
  filter: BranchFilter;
  base: string;
  queries: IReportQueries;
  /** A local date of an instant, in the tenant's timezone. */
  dateOf(instant: Date): string;
  /** A local date and time, "2026-10-30 14:05". */
  timeOf(instant: Date): string;
  formatted(minor: number): string;
}>;

/**
 * What a catalogue report reads with (docs/14 §3): the period (the month so far by default, at
 * most 731 days), the caller's branches for the report's permission with the branch asked for
 * checked, the base currency and the catalogue queries, in one tenant unit of work.
 */
export class ReportContext {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      queries: IReportQueries;
      organisation: IOrganisationSettings;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      scope: BranchScope;
    }>,
  ) {}

  baseCurrency(): Promise<string> {
    return this.deps.unitOfWork.run(() => this.deps.posting.baseCurrency());
  }

  /** Branch names by id (for reports grouped by branch). */
  branchNames(): Promise<Readonly<Record<string, string>>> {
    return this.deps.unitOfWork.run(() => this.deps.queries.branchNames());
  }

  userNames(ids: readonly string[]): Promise<Readonly<Record<string, string>>> {
    return this.deps.unitOfWork.run(() => this.deps.queries.userNames(ids));
  }

  within<T>(
    actor: Principal,
    permission: PermissionKey,
    params: ParamValues,
    body: (scope: ReportScope) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const today = await deps.calendar.today();
      const range = DateRange.of(params.from, params.to, today);
      if (params.branchId !== undefined)
        await deps.scope.branch(actor, permission, params.branchId);
      const { timezone } = await deps.organisation.get();
      const base = await deps.posting.baseCurrency();
      return body({
        range,
        fromAt: localMidnight(range.from, timezone),
        untilAt: localMidnight(addDays(range.to, 1), timezone),
        today,
        filter: {
          branchIds: deps.scope.branchesFor(actor, permission),
          branchId: params.branchId ?? null,
        },
        base,
        queries: deps.queries,
        dateOf: (instant) => localDateTime(instant, timezone).date,
        timeOf: (instant) => {
          const t = localDateTime(instant, timezone);
          return `${t.date} ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
        },
        formatted: (minor) => Money.ofMinor(minor, base).toJSON().formatted,
      });
    });
  }
}
