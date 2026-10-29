import { DealRuleError } from "../../../domain/dealer/Deal.js";
import type { Financing } from "../../../domain/dealer/Quote.js";
import type { StockStatus } from "../../../domain/dealer/StockUnit.js";
import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import type {
  DatePeriod,
  DealerReportFilter,
  IDealerReporting,
  InstantPeriod,
} from "../../ports/IDealerReporting.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { BranchScope } from "../../services/BranchScope.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import { localMidnight } from "../../services/TenantLocalTime.js";

const REPORTS: PermissionKey = "dashboards.dealer.view";
const MAX_DAYS = 366;

export type DealerPeriodQuery = Readonly<{ from?: string; to?: string; branchId?: string }>;

export type DealerOverview = Readonly<{
  period: DatePeriod;
  sales: Readonly<{
    sold: number;
    /** The sale invoices before tax. */
    revenue: MoneyJson;
    delivered: number;
    averageDaysToSell: number | null;
  }>;
  stock: Readonly<{ count: number; asking: MoneyJson; agedOver90: number }>;
  leads: Readonly<{
    created: number;
    won: number;
    lost: number;
    /** Won of the leads closed in the period, to one decimal. */
    conversionPercent: string | null;
  }>;
  cash: Readonly<{
    /** Received on deals in the period (vehicles taken in part exchange aside). */
    collected: MoneyJson;
    /** Still owed on sold deals' invoices. */
    outstanding: MoneyJson;
    /** Paid on deals not yet sold. */
    depositsHeld: MoneyJson;
  }>;
}>;

type ReductionTotals = Readonly<{ reductions: number; vehicles: number; reduced: MoneyJson }>;

export type PriceReductionsReport = Readonly<{
  period: DatePeriod;
  totals: ReductionTotals;
  byMake: readonly (ReductionTotals & Readonly<{ make: string }>)[];
  reductions: readonly Readonly<{
    changeId: string;
    vehicle: Readonly<{
      id: string;
      code: string;
      plateNumber: string | null;
      name: string;
      branchId: string;
      stockStatus: StockStatus;
      daysInStockAtChange: number;
    }>;
    previousAskingPrice: MoneyJson;
    askingPrice: MoneyJson;
    reduction: MoneyJson;
    /** The cut as a share of the previous asking price, to one decimal. */
    reductionPercent: string;
    reason: string | null;
    changedBy: Readonly<{ id: string; name: string | null }> | null;
    changedAt: Date;
  }>[];
}>;

export type CollectionsReport = Readonly<{
  period: DatePeriod;
  collected: MoneyJson;
  /** Vehicles taken in part exchange, at their value. */
  tradeIns: MoneyJson;
  byMethod: readonly Readonly<{ method: string; payments: number; amount: MoneyJson }>[];
  byBranch: readonly Readonly<{ branchId: string; collected: MoneyJson; tradeIns: MoneyJson }>[];
  outstanding: MoneyJson;
  deals: readonly Readonly<{
    dealId: string;
    number: string;
    status: string;
    financing: Financing;
    branchId: string;
    customer: Readonly<{ id: string; name: string }>;
    salesExecutiveId: string;
    soldOn: string;
    invoiced: MoneyJson;
    paid: MoneyJson;
    balance: MoneyJson;
  }>[];
  depositsHeld: MoneyJson;
  deposits: readonly Readonly<{
    dealId: string;
    number: string;
    status: string;
    branchId: string;
    customerName: string;
    held: MoneyJson;
    holdUntil: string | null;
  }>[];
}>;

type Context = Readonly<{
  filter: DealerReportFilter;
  dates: DatePeriod;
  instants: InstantPeriod;
  today: string;
  timezone: string;
  m: (minor: number) => MoneyJson;
}>;

/**
 * Dealer reports (docs/10 §10, docs/14, decisions 459–462) under `dashboards.dealer.view`: the
 * overview of sales, stock, leads and cash; price reductions; and cash collected on deals against
 * what they still owe and the deposits held. Stock valuation and ageing, gross profit per unit,
 * the lead funnel and commissions per seller are the dealer stock, gross-profit, lead and
 * commission reports. Periods are local dates, the last 30 days by default.
 */
export class DealerReports {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      reporting: IDealerReporting;
      organisation: IOrganisationSettings;
      scope: BranchScope;
      calendar: TenantCalendar;
    }>,
  ) {}

  overview(actor: Principal, query: DealerPeriodQuery): Promise<DealerOverview> {
    return this.within(actor, query, async ({ filter, dates, instants, today, m }) => {
      const { reporting } = this.deps;
      const sales = await reporting.sales(dates, filter);
      const stock = await reporting.stockOnHand(today, filter);
      const leads = await reporting.leads(instants, filter);
      const collected = await reporting.collected(dates, filter);
      const balances = await reporting.balances(filter);
      const deposits = await reporting.deposits(filter);
      return {
        period: dates,
        sales: {
          sold: sales.sold,
          revenue: m(sales.revenueMinor),
          delivered: sales.delivered,
          averageDaysToSell: sales.sold === 0 ? null : Math.round(sales.daysToSell / sales.sold),
        },
        stock: { count: stock.count, asking: m(stock.askingMinor), agedOver90: stock.agedOver90 },
        leads: {
          ...leads,
          conversionPercent: oneDecimal(leads.won, leads.won + leads.lost),
        },
        cash: {
          collected: m(
            collected.filter((c) => c.method !== "trade_in").reduce((s, c) => s + c.amountMinor, 0),
          ),
          outstanding: m(balances.reduce((s, b) => s + b.invoicedMinor - b.paidMinor, 0)),
          depositsHeld: m(deposits.reduce((s, d) => s + d.heldMinor, 0)),
        },
      };
    });
  }

  priceReductions(actor: Principal, query: DealerPeriodQuery): Promise<PriceReductionsReport> {
    return this.within(actor, query, async ({ filter, dates, instants, timezone, m }) => {
      const rows = await this.deps.reporting.priceReductions(instants, filter);
      const totals = (of: typeof rows): ReductionTotals => ({
        reductions: of.length,
        vehicles: new Set(of.map((r) => r.vehicleId)).size,
        reduced: m(of.reduce((s, r) => s + r.previousAskingMinor - r.askingMinor, 0)),
      });
      const makes = [...new Set(rows.map((r) => r.make))].sort((a, b) => a.localeCompare(b));
      return {
        period: dates,
        totals: totals(rows),
        byMake: makes.map((make) => ({ make, ...totals(rows.filter((r) => r.make === make)) })),
        reductions: rows.map((r) => {
          const changedOn = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(
            r.changedAt,
          );
          return {
            changeId: r.changeId,
            vehicle: {
              id: r.vehicleId,
              code: r.vehicleCode,
              plateNumber: r.plateNumber,
              name: `${r.make} ${r.model}${r.year === null ? "" : ` ${r.year}`}`,
              branchId: r.branchId,
              stockStatus: r.stockStatus,
              daysInStockAtChange: Math.max(
                0,
                Math.round((Date.parse(changedOn) - Date.parse(r.stockedOn)) / 86_400_000),
              ),
            },
            previousAskingPrice: m(r.previousAskingMinor),
            askingPrice: m(r.askingMinor),
            reduction: m(r.previousAskingMinor - r.askingMinor),
            reductionPercent:
              oneDecimal(r.previousAskingMinor - r.askingMinor, r.previousAskingMinor) ?? "0.0",
            reason: r.reason,
            changedBy: r.changedBy === null ? null : { id: r.changedBy, name: r.changedByName },
            changedAt: r.changedAt,
          };
        }),
      };
    });
  }

  collections(actor: Principal, query: DealerPeriodQuery): Promise<CollectionsReport> {
    return this.within(actor, query, async ({ filter, dates, m }) => {
      const { reporting } = this.deps;
      const collected = await reporting.collected(dates, filter);
      const balances = await reporting.balances(filter);
      const deposits = await reporting.deposits(filter);
      const sum = (of: typeof collected) => of.reduce((s, c) => s + c.amountMinor, 0);
      const cash = collected.filter((c) => c.method !== "trade_in");
      const methods = [...new Set(collected.map((c) => c.method))];
      const branches = [...new Set(collected.map((c) => c.branchId))];
      return {
        period: dates,
        collected: m(sum(cash)),
        tradeIns: m(sum(collected.filter((c) => c.method === "trade_in"))),
        byMethod: methods.map((method) => {
          const of = collected.filter((c) => c.method === method);
          return {
            method,
            payments: of.reduce((s, c) => s + c.payments, 0),
            amount: m(sum(of)),
          };
        }),
        byBranch: branches.map((branchId) => ({
          branchId,
          collected: m(sum(cash.filter((c) => c.branchId === branchId))),
          tradeIns: m(
            sum(collected.filter((c) => c.branchId === branchId && c.method === "trade_in")),
          ),
        })),
        outstanding: m(balances.reduce((s, b) => s + b.invoicedMinor - b.paidMinor, 0)),
        deals: balances.map((b) => ({
          dealId: b.dealId,
          number: b.number,
          status: b.status,
          financing: b.financing,
          branchId: b.branchId,
          customer: { id: b.customerId, name: b.customerName },
          salesExecutiveId: b.salesExecutiveId,
          soldOn: b.soldOn,
          invoiced: m(b.invoicedMinor),
          paid: m(b.paidMinor),
          balance: m(b.invoicedMinor - b.paidMinor),
        })),
        depositsHeld: m(deposits.reduce((s, d) => s + d.heldMinor, 0)),
        deposits: deposits.map((d) => ({
          dealId: d.dealId,
          number: d.number,
          status: d.status,
          branchId: d.branchId,
          customerName: d.customerName,
          held: m(d.heldMinor),
          holdUntil: d.holdUntil,
        })),
      };
    });
  }

  private within<T>(
    actor: Principal,
    query: DealerPeriodQuery,
    body: (ctx: Context) => Promise<T>,
  ): Promise<T> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const branchIds = deps.scope.branchesFor(actor, REPORTS);
      if (query.branchId !== undefined) await deps.scope.branch(actor, REPORTS, query.branchId);
      else if (branchIds !== "all" && branchIds.length === 0)
        throw new DealRuleError("You have no branch to report on");
      const { timezone } = await deps.organisation.get();
      const today = await deps.calendar.today();
      const to = query.to ?? today;
      const from = query.from ?? TenantCalendar.addDays(to, -29);
      if (from > to) throw new DealRuleError("The period starts before it ends");
      if (TenantCalendar.addDays(from, MAX_DAYS) <= to)
        throw new DealRuleError(`A report covers at most ${MAX_DAYS} days`);
      const base = (await deps.organisation.currencySettings()).baseCurrency;
      return body({
        filter: { branchIds, branchId: query.branchId ?? null },
        dates: { from, to },
        instants: {
          from: localMidnight(from, timezone),
          to: localMidnight(TenantCalendar.addDays(to, 1), timezone),
        },
        today,
        timezone,
        m: (minor) => Money.ofMinor(minor, base).toJSON(),
      });
    });
  }
}

/** `part` of `whole` as a percentage to one decimal; null of nothing. */
function oneDecimal(part: number, whole: number): string | null {
  return whole === 0 ? null : (Math.round((part * 1000) / whole) / 10).toFixed(1);
}
