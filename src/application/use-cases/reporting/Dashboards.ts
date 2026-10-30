import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import {
  DateRange,
  series,
  type Bucket,
  type Granularity,
} from "../../../domain/reporting/DateRange.js";
import {
  collectionRate,
  dayClass,
  vehicleProfit,
} from "../../../domain/reporting/VehicleProfit.js";
import { depreciationBetween } from "../../../domain/vehicles/Vehicle.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  BranchFilter,
  IDashboardQueries,
  IncomeSource,
  VehicleStatsRow,
} from "../../ports/IReporting.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import type { TenantCalendar } from "../../services/TenantCalendar.js";
import type { BudgetStatus, ExpenseAdministration } from "../expenses/ExpenseAdministration.js";
import type { LedgerPosting } from "../finance/LedgerPosting.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import type { VehicleStatsBuilder } from "./VehicleStatsBuilder.js";

export type DashboardQuery = Readonly<{
  from?: string;
  to?: string;
  branchId?: string;
  groupBy?: Granularity;
}>;

type Period = Readonly<{ from: string; to: string; groupBy: Granularity }>;
type Point<K extends string> = Bucket & Readonly<Record<K, MoneyJson>>;

export type OverviewView = Readonly<{
  period: Period;
  revenue: Readonly<{ total: MoneyJson; bySource: Readonly<Record<IncomeSource, MoneyJson>> }>;
  costs: Readonly<{
    total: MoneyJson;
    byAccount: readonly Readonly<{
      accountId: string;
      code: string;
      name: string;
      amount: MoneyJson;
    }>[];
  }>;
  net: MoneyJson;
  /** Money actually recorded in and out (payments), not revenue. */
  cash: Readonly<{ in: MoneyJson; out: MoneyJson; net: MoneyJson }>;
  previous: Readonly<{
    from: string;
    to: string;
    revenue: MoneyJson;
    costs: MoneyJson;
    net: MoneyJson;
  }>;
  series: readonly Point<"revenue" | "costs" | "net" | "cashIn" | "cashOut">[];
}>;

export type VehicleProfitView = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  income: Readonly<{
    total: MoneyJson;
    remittances: MoneyJson;
    rentals: MoneyJson;
    workpay: MoneyJson;
    /** The vehicle's sale and instalment charges on it. */
    sales: MoneyJson;
    other: MoneyJson;
  }>;
  /** Direct costs (depreciation and finance costs apart). */
  costs: MoneyJson;
  depreciation: MoneyJson;
  financeCosts: MoneyJson;
  profit: MoneyJson;
  /** What the vehicle cost (null when not recorded). */
  acquisitionCost: MoneyJson | null;
  /** The period's profit over a year against what the vehicle cost, in percent. */
  roiPercent: number | null;
  /** Months to earn back what the vehicle cost at the period's profit. */
  paybackMonths: number | null;
  distance: Readonly<{ value: number; unit: "km" | "mi" }>;
  costPerDistance: MoneyJson | null;
  fuel: Readonly<{ litres: number; cost: MoneyJson; distancePerLitre: number | null }>;
  days: VehicleStatsRow["days"];
  utilisationPercent: number | null;
}>;

export type FleetProfitView = Readonly<{
  period: Omit<Period, "groupBy">;
  totals: Readonly<{
    income: MoneyJson;
    costs: MoneyJson;
    depreciation: MoneyJson;
    financeCosts: MoneyJson;
    profit: MoneyJson;
    utilisationPercent: number | null;
  }>;
  /** Most profitable first. */
  vehicles: readonly VehicleProfitView[];
}>;

export type VehicleTrendView = Readonly<{
  period: Period;
  profit: VehicleProfitView | null;
  series: readonly (Point<"income" | "costs" | "net"> &
    Readonly<{ distance: number; workingDays: number }>)[];
}>;

export type RemittanceDashboardView = Readonly<{
  period: Period;
  expected: MoneyJson;
  received: MoneyJson;
  waived: MoneyJson;
  outstanding: MoneyJson;
  /** Received over expected for fixed targets (variable periods have no target). */
  collectionRatePercent: number | null;
  variableReceived: MoneyJson;
  periods: number;
  byStatus: Readonly<Record<string, number>>;
  series: readonly (Point<"expected" | "received" | "outstanding"> &
    Readonly<{ collectionRatePercent: number | null }>)[];
  driversShort: readonly Readonly<{
    driverId: string;
    code: string;
    name: string;
    periods: number;
    expected: MoneyJson;
    received: MoneyJson;
    outstanding: MoneyJson;
  }>[];
}>;

export type ExpenseDashboardView = Readonly<{
  period: Period;
  total: MoneyJson;
  net: MoneyJson;
  tax: MoneyJson;
  count: number;
  byCategory: readonly Readonly<{
    categoryId: string;
    name: string;
    count: number;
    amount: MoneyJson;
  }>[];
  topVehicles: readonly Readonly<{
    vehicleId: string;
    code: string;
    plateNumber: string | null;
    amount: MoneyJson;
  }>[];
  pendingApproval: Readonly<{ count: number; amount: MoneyJson }>;
  /** Budgets of the month the period ends in (with budget access). */
  budgets: readonly BudgetStatus[] | null;
  series: readonly Point<"amount">[];
}>;

const TOP = 10;

/**
 * Dashboards v1 (docs/14 §4–5, audit H12–H13): every figure on business dates (entry, payment,
 * period-end and expense dates) in the tenant's calendar, charts with one bucket per real day,
 * ISO week or month, revenue kept apart from cash collected, all scoped to the caller's branches.
 */
export class Dashboards {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      queries: IDashboardQueries;
      stats: VehicleStatsBuilder;
      expenses: ExpenseAdministration;
      vehicles: VehicleAccess;
      posting: LedgerPosting;
      scope: BranchScope;
      calendar: TenantCalendar;
    }>,
  ) {}

  async overview(actor: Principal, query: DashboardQuery): Promise<OverviewView> {
    return this.within(actor, "dashboards.overview.view", query, async (ctx) => {
      const { range, groupBy, filter, m } = ctx;
      const days = await this.deps.queries.ledgerDays(range.from, range.to, filter);
      const cash = await this.deps.queries.cashDays(range.from, range.to, filter);
      const accounts = await this.deps.queries.costsByAccount(range.from, range.to, filter);
      const previous = range.previous();
      const before = await this.deps.queries.ledgerDays(previous.from, previous.to, filter);
      const bySource: Record<IncomeSource, number> = {
        remittances: 0,
        rentals: 0,
        workpay: 0,
        sales: 0,
        other: 0,
      };
      for (const d of days) if (d.source !== null) bySource[d.source] += d.incomeMinor;
      const revenue = sum(days, (d) => d.incomeMinor);
      const costs = sum(days, (d) => d.costMinor);
      const cashIn = sum(cash, (d) => d.inMinor);
      const cashOut = sum(cash, (d) => d.outMinor);
      const lastRevenue = sum(before, (d) => d.incomeMinor);
      const lastCosts = sum(before, (d) => d.costMinor);
      const rows = [
        ...days.map((d) => ({
          date: d.date,
          revenue: d.incomeMinor,
          costs: d.costMinor,
          net: d.incomeMinor - d.costMinor,
          cashIn: 0,
          cashOut: 0,
        })),
        ...cash.map((d) => ({
          date: d.date,
          revenue: 0,
          costs: 0,
          net: 0,
          cashIn: d.inMinor,
          cashOut: d.outMinor,
        })),
      ];
      const fields = ["revenue", "costs", "net", "cashIn", "cashOut"] as const;
      return {
        period: { from: range.from, to: range.to, groupBy },
        revenue: {
          total: m(revenue),
          bySource: {
            remittances: m(bySource.remittances),
            rentals: m(bySource.rentals),
            workpay: m(bySource.workpay),
            sales: m(bySource.sales),
            other: m(bySource.other),
          },
        },
        costs: {
          total: m(costs),
          byAccount: accounts.map((a) => ({
            accountId: a.accountId,
            code: a.code,
            name: a.name,
            amount: m(a.amountMinor),
          })),
        },
        net: m(revenue - costs),
        cash: { in: m(cashIn), out: m(cashOut), net: m(cashIn - cashOut) },
        previous: {
          from: previous.from,
          to: previous.to,
          revenue: m(lastRevenue),
          costs: m(lastCosts),
          net: m(lastRevenue - lastCosts),
        },
        series: money(series(range, groupBy, rows, fields), fields, m),
      };
    });
  }

  /** The fleet's vehicle P&L ranking for a period. */
  async vehicleProfits(
    actor: Principal,
    query: DashboardQuery & Readonly<{ groupId?: string }>,
  ): Promise<FleetProfitView> {
    await this.deps.stats.refresh();
    return this.within(actor, "dashboards.vehicles.view", query, async (ctx) => {
      const { range, filter, m } = ctx;
      const rows = await this.deps.queries.vehicleTotals(range.from, range.to, {
        ...filter,
        ...(query.groupId === undefined ? {} : { groupId: query.groupId }),
      });
      const views = rows
        .map((row) => this.profitOf(row, range, m))
        .sort(
          (a, b) => b.profit.amountMinor - a.profit.amountMinor || a.code.localeCompare(b.code),
        );
      const total = (pick: (v: VehicleProfitView) => MoneyJson) =>
        m(sum(views, (v) => pick(v).amountMinor));
      const working = sum(rows, (r) => r.days.working);
      const fleetDays = sum(rows, (r) => r.days.working + r.days.idle + r.days.off_road);
      return {
        period: { from: range.from, to: range.to },
        totals: {
          income: total((v) => v.income.total),
          costs: total((v) => v.costs),
          depreciation: total((v) => v.depreciation),
          financeCosts: total((v) => v.financeCosts),
          profit: total((v) => v.profit),
          utilisationPercent: fleetDays > 0 ? Math.round((working / fleetDays) * 1000) / 10 : null,
        },
        vehicles: views,
      };
    });
  }

  /** One vehicle's P&L for a period with its trend. */
  async vehicleTrend(
    actor: Principal,
    vehicleId: string,
    query: Omit<DashboardQuery, "branchId">,
  ): Promise<VehicleTrendView> {
    await this.deps.stats.refresh();
    return this.within(actor, "dashboards.vehicles.view", query, async (ctx) => {
      const { range, groupBy, m } = ctx;
      await this.deps.vehicles.reach(actor, vehicleId, "dashboards.vehicles.view");
      const [row] = await this.deps.queries.vehicleTotals(range.from, range.to, {
        branchIds: "all",
        branchId: null,
        vehicleId,
      });
      const days = await this.deps.queries.vehicleDays(vehicleId, range.from, range.to);
      const fields = ["income", "costs", "net", "distance", "workingDays"] as const;
      const points = series(
        range,
        groupBy,
        days.map((d) => {
          const income =
            d.remittanceIncomeMinor +
            d.rentalIncomeMinor +
            d.workpayIncomeMinor +
            d.salesIncomeMinor +
            d.otherIncomeMinor;
          const costs = d.costMinor + d.financeCostMinor;
          return {
            date: d.date,
            income,
            costs,
            net: income - costs,
            distance: d.distance,
            workingDays: dayClass(d.status) === "working" ? 1 : 0,
          };
        }),
        fields,
      );
      return {
        period: { from: range.from, to: range.to, groupBy },
        profit: row === undefined ? null : this.profitOf(row, range, m),
        series: points.map((p) => ({
          key: p.key,
          from: p.from,
          to: p.to,
          income: m(p.income),
          costs: m(p.costs),
          net: m(p.net),
          distance: p.distance,
          workingDays: p.workingDays,
        })),
      };
    });
  }

  async remittances(actor: Principal, query: DashboardQuery): Promise<RemittanceDashboardView> {
    return this.within(actor, "dashboards.remittances.view", query, async (ctx) => {
      const { range, groupBy, filter, m } = ctx;
      const days = await this.deps.queries.remittanceDays(range.from, range.to, filter);
      const short = await this.deps.queries.driverShortfalls(range.from, range.to, filter, TOP);
      const fixed = days.filter((d) => d.mode === "fixed_target");
      const expected = sum(fixed, (d) => d.expectedMinor);
      const received = sum(fixed, (d) => d.receivedMinor);
      const byStatus: Record<string, number> = {};
      for (const d of days) byStatus[d.status] = (byStatus[d.status] ?? 0) + d.count;
      const fields = ["expected", "received", "outstanding"] as const;
      const points = series(
        range,
        groupBy,
        fixed.map((d) => ({
          date: d.date,
          expected: d.expectedMinor,
          received: d.receivedMinor,
          outstanding: d.outstandingMinor,
        })),
        fields,
      );
      return {
        period: { from: range.from, to: range.to, groupBy },
        expected: m(expected),
        received: m(received),
        waived: m(sum(fixed, (d) => d.waivedMinor)),
        outstanding: m(sum(fixed, (d) => d.outstandingMinor)),
        collectionRatePercent: collectionRate(received, expected),
        variableReceived: m(
          sum(
            days.filter((d) => d.mode === "variable"),
            (d) => d.receivedMinor,
          ),
        ),
        periods: sum(days, (d) => d.count),
        byStatus,
        series: points.map((p) => ({
          key: p.key,
          from: p.from,
          to: p.to,
          expected: m(p.expected),
          received: m(p.received),
          outstanding: m(p.outstanding),
          collectionRatePercent: collectionRate(p.received, p.expected),
        })),
        driversShort: short.map((d) => ({
          driverId: d.driverId,
          code: d.code,
          name: d.name,
          periods: d.periods,
          expected: m(d.expectedMinor),
          received: m(d.receivedMinor),
          outstanding: m(d.outstandingMinor),
        })),
      };
    });
  }

  async expenses(actor: Principal, query: DashboardQuery): Promise<ExpenseDashboardView> {
    return this.within(actor, "dashboards.expenses.view", query, async (ctx) => {
      const { range, groupBy, filter, m } = ctx;
      const days = await this.deps.queries.expenseDays(range.from, range.to, filter);
      const vehicles = await this.deps.queries.vehicleSpend(range.from, range.to, filter, TOP);
      const pending = await this.deps.queries.pendingExpenses(filter);
      const categories = new Map<string, { name: string; count: number; amount: number }>();
      for (const d of days) {
        const c = categories.get(d.categoryId) ?? { name: d.categoryName, count: 0, amount: 0 };
        c.count += d.count;
        c.amount += d.amountMinor;
        categories.set(d.categoryId, c);
      }
      const budgets =
        actor.grantFor("expenses.budgets.view") === undefined
          ? null
          : (await this.deps.expenses.budgets(range.to.slice(0, 7))).filter(
              (b) =>
                b.budget.branchId === null ||
                ((filter.branchIds === "all" || filter.branchIds.includes(b.budget.branchId)) &&
                  (filter.branchId === null || b.budget.branchId === filter.branchId)),
            );
      const points = series(
        range,
        groupBy,
        days.map((d) => ({ date: d.date, amount: d.amountMinor })),
        ["amount"],
      );
      return {
        period: { from: range.from, to: range.to, groupBy },
        total: m(sum(days, (d) => d.amountMinor)),
        net: m(sum(days, (d) => d.netMinor)),
        tax: m(sum(days, (d) => d.taxMinor)),
        count: sum(days, (d) => d.count),
        byCategory: [...categories.entries()]
          .sort(([, a], [, b]) => b.amount - a.amount || a.name.localeCompare(b.name))
          .map(([categoryId, c]) => ({
            categoryId,
            name: c.name,
            count: c.count,
            amount: m(c.amount),
          })),
        topVehicles: vehicles.map((v) => ({
          vehicleId: v.vehicleId,
          code: v.code,
          plateNumber: v.plateNumber,
          amount: m(v.amountMinor),
        })),
        pendingApproval: { count: pending.count, amount: m(pending.amountMinor) },
        budgets,
        series: points.map((p) => ({ key: p.key, from: p.from, to: p.to, amount: m(p.amount) })),
      };
    });
  }

  /** Rebuilds the vehicle stats now (after an import or a correction far in the past). */
  async rebuildStats(): Promise<Readonly<{ rows: number }>> {
    return { rows: await this.deps.stats.refresh() };
  }

  private profitOf(
    row: VehicleStatsRow,
    range: DateRange,
    m: (minor: number) => MoneyJson,
  ): VehicleProfitView {
    const figures = vehicleProfit(row, depreciationBetween(row.asset, range.from, range.to), {
      costMinor: row.asset.acquisitionCostMinor,
      days: range.days,
    });
    return {
      vehicleId: row.vehicleId,
      code: row.code,
      plateNumber: row.plateNumber,
      make: row.make,
      model: row.model,
      branchId: row.branchId,
      income: {
        total: m(figures.incomeMinor),
        remittances: m(row.remittanceIncomeMinor),
        rentals: m(row.rentalIncomeMinor),
        workpay: m(row.workpayIncomeMinor),
        sales: m(row.salesIncomeMinor),
        other: m(row.otherIncomeMinor),
      },
      costs: m(figures.costMinor),
      depreciation: m(figures.depreciationMinor),
      financeCosts: m(figures.financeCostMinor),
      profit: m(figures.profitMinor),
      acquisitionCost:
        row.asset.acquisitionCostMinor === null ? null : m(row.asset.acquisitionCostMinor),
      roiPercent: figures.roiPercent,
      paybackMonths: figures.paybackMonths,
      distance: { value: row.distance, unit: row.mileageUnit },
      costPerDistance:
        figures.costPerDistanceMinor === null ? null : m(figures.costPerDistanceMinor),
      fuel: {
        litres: row.fuelLitres,
        cost: m(row.fuelCostMinor),
        distancePerLitre: figures.distancePerLitre,
      },
      days: row.days,
      utilisationPercent: figures.utilisationPercent,
    };
  }

  /** Range, granularity, branch filter and money formatter of a dashboard, in a unit of work. */
  private within<T>(
    actor: Principal,
    permission: PermissionKey,
    query: DashboardQuery,
    body: (
      ctx: Readonly<{
        range: DateRange;
        groupBy: Granularity;
        filter: BranchFilter;
        m: (minor: number) => MoneyJson;
      }>,
    ) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const range = DateRange.of(query.from, query.to, await deps.calendar.today());
      if (query.branchId !== undefined) await deps.scope.branch(actor, permission, query.branchId);
      const base = await deps.posting.baseCurrency();
      return body({
        range,
        groupBy: query.groupBy ?? range.defaultGranularity(),
        filter: {
          branchIds: deps.scope.branchesFor(actor, permission),
          branchId: query.branchId ?? null,
        },
        m: (minor) => Money.ofMinor(minor, base).toJSON(),
      });
    });
  }
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function money<K extends string>(
  points: readonly (Bucket & Readonly<Record<K, number>>)[],
  fields: readonly K[],
  m: (minor: number) => MoneyJson,
): Point<K>[] {
  return points.map(
    (p) =>
      ({
        key: p.key,
        from: p.from,
        to: p.to,
        ...Object.fromEntries(fields.map((f) => [f, m(p[f])])),
      }) as Point<K>,
  );
}
