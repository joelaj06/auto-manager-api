import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import { RentalBookingError } from "../../../domain/rentals/RentalBooking.js";
import {
  averageDailyRate,
  percent,
  revenuePerAvailableVehicleDay,
  utilisation,
  type Utilisation,
} from "../../../domain/rentals/RentalMetrics.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type {
  FleetHoursRow,
  IRentalReporting,
  Period,
  RentalNoticeRow,
  RentalReportFilter,
} from "../../ports/IRentalReporting.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import { localDateTime, localMidnight } from "../../services/TenantLocalTime.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";

const REPORTS: PermissionKey = "dashboards.rentals.view";
const MAX_DAYS = 366;

export type PeriodQuery = Readonly<{ from?: string; to?: string; branchId?: string }>;

type Shown = Readonly<{ from: string; to: string }>;

export type UtilisationReport = Readonly<{
  period: Shown;
  fleet: Utilisation;
  byClass: readonly (Utilisation & Readonly<{ classId: string; className: string }>)[];
  byVehicle: readonly (Utilisation &
    Readonly<{
      vehicleId: string;
      code: string;
      plateNumber: string | null;
      classId: string;
      className: string;
    }>)[];
}>;

type RevenueLine = Readonly<{ revenue: MoneyJson; bookings: number; share: number | null }>;

export type RevenueReport = Readonly<{
  period: Shown;
  /** Booking charges of the period before tax, credits taken off. */
  revenue: MoneyJson;
  timeRevenue: MoneyJson;
  bookings: number;
  /** Time charges per day on rent. */
  averageDailyRate: MoneyJson | null;
  /** Revenue per vehicle-day the fleet could be rented. */
  revenuePerAvailableVehicle: MoneyJson | null;
  byClass: readonly (RevenueLine & Readonly<{ classId: string | null; className: string }>)[];
  byBranch: readonly (RevenueLine & Readonly<{ branchId: string; branchName: string }>)[];
  byCustomerType: readonly (RevenueLine & Readonly<{ customerType: string }>)[];
}>;

export type BalancesReport = Readonly<{
  outstanding: MoneyJson;
  bookings: readonly Readonly<{
    bookingId: string;
    number: string;
    status: string;
    branchId: string;
    customer: Readonly<{ id: string; name: string }>;
    invoicedOpen: MoneyJson;
    uninvoiced: MoneyJson;
    credit: MoneyJson;
    balance: MoneyJson;
    returnAt: Date;
  }>[];
  depositsHeld: MoneyJson;
  deposits: readonly Readonly<{
    bookingId: string;
    number: string;
    status: string;
    branchId: string;
    customerName: string;
    held: MoneyJson;
    heldAt: Date;
  }>[];
}>;

export type DamagesReport = Readonly<{
  period: Shown;
  damages: number;
  /** Final costs, or estimates while unknown. */
  cost: MoneyJson;
  /** Charged to the renters. */
  recovered: MoneyJson;
  recoveredPercent: number | null;
  byLiability: readonly Readonly<{
    liability: string;
    damages: number;
    cost: MoneyJson;
    recovered: MoneyJson;
  }>[];
  rows: readonly Readonly<{
    damageId: string;
    vehicleId: string;
    plateNumber: string | null;
    bookingNumber: string | null;
    severity: string;
    status: string;
    liability: string;
    cost: MoneyJson | null;
    recovered: MoneyJson;
    createdAt: Date;
  }>[];
}>;

type BoardRow = Readonly<{
  bookingId: string;
  number: string;
  status: string;
  branchId: string;
  customer: Readonly<{ id: string; name: string; phone: string | null }>;
  vehicle: Readonly<{ id: string; code: string; plateNumber: string | null; name: string }>;
  pickupAt: Date;
  returnAt: Date;
}>;

export type RentalBoard = Readonly<{
  date: string;
  pickups: readonly BoardRow[];
  returns: readonly BoardRow[];
  /** Out and past their return time. */
  overdue: readonly (BoardRow & Readonly<{ overdueMinutes: number }>)[];
  /** Reservations lapsing today unless confirmed. */
  expiring: readonly BoardRow[];
}>;

/**
 * Rental reports (docs/07 §11): utilisation by vehicle and class, revenue by class, branch and
 * customer type with the average daily rate and revenue per available vehicle, outstanding
 * balances and deposits held, damage costs against what the renters were charged, and the
 * operations board of the day's pickups and returns (decisions 371–375).
 */
export class RentalReports {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reporting: IRentalReporting;
      organisation: IOrganisationSettings;
      posting: LedgerPosting;
      calendar: TenantCalendar;
      scope: BranchScope;
      clock: { now(): Date };
    }>,
  ) {}

  utilisation(actor: Principal, query: PeriodQuery): Promise<UtilisationReport> {
    return this.within(actor, REPORTS, query, async ({ filter, period, shown, now }) => {
      const fleet = await this.deps.reporting.fleetHours(period, now, filter);
      const seconds = openSeconds(period, now);
      const classes = groupBy(fleet, (v) => v.classId);
      return {
        period: shown,
        fleet: utilisation(fleet, seconds),
        byClass: [...classes.values()].map((vehicles) => ({
          classId: vehicles[0]!.classId,
          className: vehicles[0]!.className,
          ...utilisation(vehicles, seconds),
        })),
        byVehicle: fleet.map((v) => ({
          vehicleId: v.vehicleId,
          code: v.code,
          plateNumber: v.plateNumber,
          classId: v.classId,
          className: v.className,
          ...utilisation([v], seconds),
        })),
      };
    });
  }

  revenue(actor: Principal, query: PeriodQuery): Promise<RevenueReport> {
    return this.within(actor, REPORTS, query, async ({ filter, period, shown, now, m }) => {
      const rows = await this.deps.reporting.revenue(period, filter);
      const fleet = await this.deps.reporting.fleetHours(period, now, filter);
      const total = rows.reduce((s, r) => s + r.netMinor, 0);
      const time = rows.reduce((s, r) => s + r.timeNetMinor, 0);
      const rented = fleet.reduce((s, v) => s + v.rentedSeconds, 0);
      const seconds = openSeconds(period, now);
      const available = fleet.reduce(
        (s, v) => s + Math.max(0, seconds - Math.min(seconds, v.unavailableSeconds)),
        0,
      );
      const line = (group: typeof rows): RevenueLine => {
        const revenue = group.reduce((s, r) => s + r.netMinor, 0);
        return {
          revenue: m(revenue),
          bookings: group.reduce((s, r) => s + r.bookings, 0),
          share: percent(revenue, total),
        };
      };
      const adr = averageDailyRate(time, rented);
      const revpav = revenuePerAvailableVehicleDay(total, available);
      return {
        period: shown,
        revenue: m(total),
        timeRevenue: m(time),
        bookings: sumBookings(rows),
        averageDailyRate: adr === null ? null : m(adr),
        revenuePerAvailableVehicle: revpav === null ? null : m(revpav),
        byClass: [...groupBy(rows, (r) => r.classId ?? "").values()].map((g) => ({
          classId: g[0]!.classId,
          className: g[0]!.className ?? "Vehicle bookings",
          ...line(g),
        })),
        byBranch: [...groupBy(rows, (r) => r.branchId).values()].map((g) => ({
          branchId: g[0]!.branchId,
          branchName: g[0]!.branchName,
          ...line(g),
        })),
        byCustomerType: [...groupBy(rows, (r) => r.customerType).values()].map((g) => ({
          customerType: g[0]!.customerType,
          ...line(g),
        })),
      };
    });
  }

  balances(actor: Principal, query: Readonly<{ branchId?: string }>): Promise<BalancesReport> {
    return this.within(actor, REPORTS, query, async ({ filter, m }) => {
      const owed = await this.deps.reporting.balances(filter);
      const deposits = await this.deps.reporting.depositsHeld(filter);
      const balance = (r: (typeof owed)[number]) =>
        r.invoicedOpenMinor + r.uninvoicedMinor - r.creditMinor;
      return {
        outstanding: m(owed.reduce((s, r) => s + balance(r), 0)),
        bookings: owed.map((r) => ({
          bookingId: r.bookingId,
          number: r.number,
          status: r.status,
          branchId: r.branchId,
          customer: { id: r.customerId, name: r.customerName },
          invoicedOpen: m(r.invoicedOpenMinor),
          uninvoiced: m(r.uninvoicedMinor),
          credit: m(r.creditMinor),
          balance: m(balance(r)),
          returnAt: r.returnAt,
        })),
        depositsHeld: m(deposits.reduce((s, d) => s + d.heldMinor, 0)),
        deposits: deposits.map((d) => ({
          bookingId: d.bookingId,
          number: d.number,
          status: d.status,
          branchId: d.branchId,
          customerName: d.customerName,
          held: m(d.heldMinor),
          heldAt: d.heldAt,
        })),
      };
    });
  }

  damages(actor: Principal, query: PeriodQuery): Promise<DamagesReport> {
    return this.within(actor, REPORTS, query, async ({ filter, period, shown, m }) => {
      const rows = await this.deps.reporting.damages(period, filter);
      const cost = rows.reduce((s, r) => s + (r.costMinor ?? 0), 0);
      const recovered = rows.reduce((s, r) => s + r.chargedMinor, 0);
      return {
        period: shown,
        damages: rows.length,
        cost: m(cost),
        recovered: m(recovered),
        recoveredPercent: percent(recovered, cost),
        byLiability: [...groupBy(rows, (r) => r.liability).values()].map((g) => ({
          liability: g[0]!.liability,
          damages: g.length,
          cost: m(g.reduce((s, r) => s + (r.costMinor ?? 0), 0)),
          recovered: m(g.reduce((s, r) => s + r.chargedMinor, 0)),
        })),
        rows: rows.map((r) => ({
          damageId: r.damageId,
          vehicleId: r.vehicleId,
          plateNumber: r.plateNumber,
          bookingNumber: r.bookingNumber,
          severity: r.severity,
          status: r.status,
          liability: r.liability,
          cost: r.costMinor === null ? null : m(r.costMinor),
          recovered: m(r.chargedMinor),
          createdAt: r.createdAt,
        })),
      };
    });
  }

  /** The day's pickups and returns, what is overdue and reservations lapsing (operations). */
  board(actor: Principal, query: Readonly<{ date?: string; branchId?: string }>) {
    return this.within(
      actor,
      "rentals.view",
      query,
      async ({ filter, timezone, today, now }): Promise<RentalBoard> => {
        const date = query.date ?? today;
        const start = localMidnight(date, timezone);
        const end = localMidnight(TenantCalendar.addDays(date, 1), timezone);
        const { reporting } = this.deps;
        return {
          date,
          pickups: (await reporting.pickupsBetween(start, end, filter)).map(boardRow),
          returns: (await reporting.returnsBetween(start, end, filter)).map(boardRow),
          overdue: (await reporting.overdue(now, filter)).map((r) => ({
            ...boardRow(r),
            overdueMinutes: Math.floor((now.getTime() - r.returnAt.getTime()) / 60_000),
          })),
          expiring: (await reporting.expiringBetween(start < now ? now : start, end, filter)).map(
            boardRow,
          ),
        };
      },
    );
  }

  // --- helpers ---

  private within<T>(
    actor: Principal,
    permission: PermissionKey,
    query: PeriodQuery & Readonly<{ date?: string }>,
    body: (
      ctx: Readonly<{
        filter: RentalReportFilter;
        period: Period;
        shown: Shown;
        today: string;
        timezone: string;
        now: Date;
        m: (minor: number) => MoneyJson;
      }>,
    ) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.branchId !== undefined) await deps.scope.branch(actor, permission, query.branchId);
      else if (!hasAny(deps.scope.branchesFor(actor, permission)))
        throw new RentalBookingError("You have no branch to report on");
      const { timezone } = await deps.organisation.get();
      const now = deps.clock.now();
      const today = localDateTime(now, timezone).date;
      const to = query.to ?? today;
      const from = query.from ?? TenantCalendar.addDays(to, -29);
      if (from > to) throw new RentalBookingError("The period starts before it ends");
      if (TenantCalendar.addDays(from, MAX_DAYS) <= to)
        throw new RentalBookingError(`A report covers at most ${MAX_DAYS} days`);
      const base = await deps.posting.baseCurrency();
      return body({
        filter: {
          branchIds: deps.scope.branchesFor(actor, permission),
          branchId: query.branchId ?? null,
        },
        period: {
          from: localMidnight(from, timezone),
          to: localMidnight(TenantCalendar.addDays(to, 1), timezone),
        },
        shown: { from, to },
        today,
        timezone,
        now,
        m: (minor) => Money.ofMinor(minor, base).toJSON(),
      });
    });
  }
}

/** The part of the period that has happened (a period running into the future counts to now). */
const openSeconds = (period: Period, now: Date) =>
  Math.max(0, (Math.min(period.to.getTime(), now.getTime()) - period.from.getTime()) / 1_000);

const hasAny = (branches: "all" | readonly string[]) => branches === "all" || branches.length > 0;

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
}

/** A booking can appear in several groups of a row set (one per class and customer type). */
const sumBookings = (rows: readonly Readonly<{ bookings: number }>[]) =>
  rows.reduce((s, r) => s + r.bookings, 0);

const boardRow = (r: RentalNoticeRow): BoardRow => ({
  bookingId: r.bookingId,
  number: r.number,
  status: r.status,
  branchId: r.branchId,
  customer: { id: r.customerId, name: r.customerName, phone: r.phone },
  vehicle: {
    id: r.vehicleId,
    code: r.vehicleCode,
    plateNumber: r.plateNumber,
    name: `${r.make} ${r.model}`,
  },
  pickupAt: r.pickupAt,
  returnAt: r.returnAt,
});

export type { FleetHoursRow };
