import { PAYABLE_BUCKETS, bucketOf, daysOverdue } from "../../../../domain/finance/Payables.js";
import type {
  ParamValues,
  ReportColumn,
  ReportTable,
} from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { IncomeSource } from "../../../ports/IReporting.js";
import { TenantCalendar } from "../../../services/TenantCalendar.js";
import type { Dashboards, VehicleProfitView } from "../Dashboards.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import {
  AGE_HEADERS,
  between,
  minor,
  minorOr,
  share,
  total,
  totalsRow,
  vehicleName,
  words,
} from "./cells.js";

const SOURCES: Readonly<Record<IncomeSource, string>> = {
  remittances: "Remittances",
  rentals: "Rentals",
  other: "Other income",
};

/** Revenue by source, costs by account, net and cash, against the period before (docs/14 §3). */
export class BusinessOverviewReport implements ReportDefinition {
  readonly id = "business_overview";
  readonly title = "Business overview";
  readonly description =
    "Revenue by source, costs by account, net result and cash in and out, against the period before";
  readonly category = "executive" as const;
  readonly permission = "dashboards.overview.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly dashboards: Dashboards) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const o = await this.dashboards.overview(actor, periodOf(params));
    const line = (section: string, item: string, amount: number) => ({ section, item, amount });
    return {
      title: this.title,
      subtitle: between(o.period),
      currency: o.net.currency,
      columns: [
        { key: "section", header: "Section", type: "text", width: 0.8 },
        { key: "item", header: "Item", type: "text", width: 2 },
        { key: "amount", header: "Amount", type: "money", width: 1.2 },
      ],
      rows: [
        ...(Object.keys(SOURCES) as IncomeSource[]).map((source) =>
          line("Revenue", SOURCES[source], minor(o.revenue.bySource[source])),
        ),
        line("Revenue", "Total revenue", minor(o.revenue.total)),
        ...o.costs.byAccount.map((a) => line("Costs", `${a.code} ${a.name}`, minor(a.amount))),
        line("Costs", "Total costs", minor(o.costs.total)),
        line("Result", "Net", minor(o.net)),
        line("Cash", "Cash in", minor(o.cash.in)),
        line("Cash", "Cash out", minor(o.cash.out)),
        line("Cash", "Net cash", minor(o.cash.net)),
      ],
      totals: null,
      summary: [
        { label: "Previous period", value: between(o.previous) },
        { label: "Previous revenue", value: o.previous.revenue.formatted },
        { label: "Previous costs", value: o.previous.costs.formatted },
        { label: "Previous net", value: o.previous.net.formatted },
      ],
    };
  }
}

const PNL_COLUMNS: readonly ReportColumn[] = [
  { key: "vehicle", header: "Vehicle", type: "text", width: 1.2 },
  { key: "model", header: "Make and model", type: "text", width: 1.6 },
  { key: "remittances", header: "Remittances", type: "money" },
  { key: "rentals", header: "Rentals", type: "money" },
  { key: "other", header: "Other income", type: "money" },
  { key: "income", header: "Income", type: "money" },
  { key: "costs", header: "Costs", type: "money" },
  { key: "depreciation", header: "Depreciation", type: "money" },
  { key: "profit", header: "Profit", type: "money" },
  { key: "distance", header: "Distance", type: "number", width: 0.8 },
  { key: "costPerDistance", header: "Cost per km/mi", type: "money", width: 0.8 },
  { key: "utilisation", header: "Utilisation", type: "percent", width: 0.8 },
];

const pnlRow = (v: VehicleProfitView) => ({
  vehicle: vehicleName(v),
  model: `${v.make} ${v.model}`,
  remittances: minor(v.income.remittances),
  rentals: minor(v.income.rentals),
  other: minor(v.income.other),
  income: minor(v.income.total),
  costs: minor(v.costs),
  depreciation: minor(v.depreciation),
  profit: minor(v.profit),
  distance: v.distance.value,
  costPerDistance: minorOr(v.costPerDistance),
  utilisation: v.utilisationPercent,
});

/** Profit per vehicle: income by source less costs and depreciation (docs/14 §3 ⭐). */
export class VehiclePnlReport implements ReportDefinition {
  readonly id = "vehicle_pnl";
  readonly title = "Vehicle P&L";
  readonly description =
    "Per vehicle: income from remittances, rentals and other, costs, depreciation, profit, cost per km and utilisation";
  readonly category = "executive" as const;
  readonly permission = "dashboards.vehicles.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly dashboards: Dashboards) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const fleet = await this.dashboards.vehicleProfits(actor, periodOf(params));
    const t = fleet.totals;
    const keys = PNL_COLUMNS.map((c) => c.key);
    const sum = (pick: (v: VehicleProfitView) => number) => total(fleet.vehicles, pick);
    return {
      title: this.title,
      subtitle: between(fleet.period),
      currency: t.profit.currency,
      columns: PNL_COLUMNS,
      rows: fleet.vehicles.map(pnlRow),
      totals: totalsRow(keys, "Total", {
        model: `${fleet.vehicles.length} vehicles`,
        remittances: sum((v) => minor(v.income.remittances)),
        rentals: sum((v) => minor(v.income.rentals)),
        other: sum((v) => minor(v.income.other)),
        income: minor(t.income),
        costs: minor(t.costs),
        depreciation: minor(t.depreciation),
        profit: minor(t.profit),
        distance: sum((v) => v.distance.value),
        utilisation: t.utilisationPercent,
      }),
      summary: [
        { label: "Vehicles", value: String(fleet.vehicles.length) },
        { label: "Profit", value: t.profit.formatted },
      ],
    };
  }
}

const GROUPINGS = ["vehicle", "model", "branch"] as const;

/** Vehicles ranked by profit, or their profit by model or branch (docs/14 §3). */
export class FleetProfitabilityReport implements ReportDefinition {
  readonly id = "fleet_profitability";
  readonly title = "Fleet profitability ranking";
  readonly description =
    "Vehicles from most to least profitable, or grouped by make and model or by branch, with margin";
  readonly category = "executive" as const;
  readonly permission = "dashboards.vehicles.view" as const;
  readonly params = [
    ...PERIOD_PARAMS,
    { key: "groupBy", label: "Group by", type: "enum", required: false, options: GROUPINGS },
  ] as const;

  constructor(
    private readonly dashboards: Dashboards,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const fleet = await this.dashboards.vehicleProfits(actor, periodOf(params));
    const groupBy = (params.groupBy ?? "vehicle") as (typeof GROUPINGS)[number];
    const branches = groupBy === "branch" ? await this.context.branchNames() : {};
    const keyOf = (v: VehicleProfitView) =>
      groupBy === "vehicle"
        ? vehicleName(v)
        : groupBy === "model"
          ? `${v.make} ${v.model}`
          : (branches[v.branchId] ?? v.branchId);
    const groups = new Map<string, VehicleProfitView[]>();
    for (const v of fleet.vehicles) groups.set(keyOf(v), [...(groups.get(keyOf(v)) ?? []), v]);
    const rows = [...groups.entries()]
      .map(([name, vs]) => {
        const income = total(vs, (v) => minor(v.income.total));
        const profit = total(vs, (v) => minor(v.profit));
        return {
          rank: 0,
          name,
          vehicles: vs.length,
          income,
          costs: total(vs, (v) => minor(v.costs) + minor(v.depreciation)),
          profit,
          perVehicle: Math.round(profit / vs.length),
          margin: share(profit, income),
        };
      })
      .sort((a, b) => b.profit - a.profit)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    const t = fleet.totals;
    return {
      title: this.title,
      subtitle: between(fleet.period),
      currency: t.profit.currency,
      columns: [
        { key: "rank", header: "#", type: "number", width: 0.4 },
        {
          key: "name",
          header:
            groupBy === "vehicle" ? "Vehicle" : groupBy === "model" ? "Make and model" : "Branch",
          type: "text",
          width: 2,
        },
        { key: "vehicles", header: "Vehicles", type: "number", width: 0.7 },
        { key: "income", header: "Income", type: "money" },
        { key: "costs", header: "Costs and depreciation", type: "money" },
        { key: "profit", header: "Profit", type: "money" },
        { key: "perVehicle", header: "Profit per vehicle", type: "money" },
        { key: "margin", header: "Margin", type: "percent", width: 0.7 },
      ],
      rows,
      totals: {
        rank: null,
        name: "Total",
        vehicles: fleet.vehicles.length,
        income: minor(t.income),
        costs: minor(t.costs) + minor(t.depreciation),
        profit: minor(t.profit),
        perVehicle:
          fleet.vehicles.length === 0 ? null : Math.round(minor(t.profit) / fleet.vehicles.length),
        margin: share(minor(t.profit), minor(t.income)),
      },
      summary: [
        { label: "Grouped by", value: groupBy },
        ...(rows.length === 0
          ? []
          : [
              { label: "Best", value: rows[0]!.name },
              { label: "Worst", value: rows.at(-1)!.name },
            ]),
      ],
    };
  }
}

/** Payments in and out by day and method, and what is expected in the next 30 days (docs/14 §3). */
export class CashFlowReport implements ReportDefinition {
  readonly id = "cash_flow";
  readonly title = "Cash flow";
  readonly description =
    "Money received and paid by day and method, net, and the inflows expected over the next 30 days";
  readonly category = "executive" as const;
  readonly permission = "dashboards.overview.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const days = await c.queries.cashDays(c.filter, c.range.from, c.range.to);
      const until = TenantCalendar.addDays(c.today, 30);
      const expected = await c.queries.expectedInflows(
        c.filter,
        TenantCalendar.addDays(c.today, 1),
        until,
      );
      const rows = new Map<string, { date: string; method: string; in: number; out: number }>();
      for (const d of days) {
        const key = `${d.date}|${d.method}`;
        const row = rows.get(key) ?? { date: d.date, method: d.method, in: 0, out: 0 };
        row[d.direction] += d.amountMinor;
        rows.set(key, row);
      }
      const cashIn = total(days, (d) => (d.direction === "in" ? d.amountMinor : 0));
      const cashOut = total(days, (d) => (d.direction === "out" ? d.amountMinor : 0));
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "date", header: "Date", type: "date" },
          { key: "method", header: "Method", type: "text" },
          { key: "in", header: "In", type: "money", width: 1.2 },
          { key: "out", header: "Out", type: "money", width: 1.2 },
          { key: "net", header: "Net", type: "money", width: 1.2 },
        ],
        rows: [...rows.values()].map((r) => ({
          date: r.date,
          method: words(r.method),
          in: r.in,
          out: r.out,
          net: r.in - r.out,
        })),
        totals: { date: "Total", method: null, in: cashIn, out: cashOut, net: cashIn - cashOut },
        summary: [
          { label: "Net cash", value: c.formatted(cashIn - cashOut) },
          { label: "Invoices due by " + until, value: c.formatted(expected.invoicesMinor) },
          {
            label: "Work & Pay instalments due by " + until,
            value: c.formatted(expected.workpayMinor),
          },
        ],
      };
    });
  }
}

/** What customers and drivers owe on open invoices, by how long overdue (docs/14 §3). */
export class ReceivablesAgeingReport implements ReportDefinition {
  readonly id = "receivables_ageing";
  readonly title = "Receivables ageing";
  readonly description =
    "Open invoices per customer and driver by days past due: not yet due, 1–30, 31–60, 61–90 and over 90";
  readonly category = "executive" as const;
  readonly permission = "finance.invoices.view" as const;
  readonly params = [
    { key: "asOf", label: "As of", type: "date", required: false },
    { key: "branchId", label: "Branch", type: "uuid", required: false },
  ] as const;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const { asOf: _asOf, ...rest } = params;
    return this.context.within(actor, this.permission, rest, async (c) => {
      const asOf = params.asOf ?? c.today;
      const invoices = await c.queries.openInvoices(c.filter, asOf);
      type Line = Record<string, string | number | null>;
      const parties = new Map<string, Line>();
      const empty = () => Object.fromEntries(PAYABLE_BUCKETS.map((b) => [b, 0]));
      for (const inv of invoices) {
        const key = `${inv.partyType}:${inv.partyId}`;
        const line = parties.get(key) ?? {
          party: inv.partyName,
          type: inv.partyType,
          invoices: 0,
          ...empty(),
          total: 0,
        };
        const bucket = bucketOf(daysOverdue(inv.dueDate, asOf));
        line[bucket] = (line[bucket] as number) + inv.outstandingMinor;
        line.total = (line.total as number) + inv.outstandingMinor;
        line.invoices = (line.invoices as number) + 1;
        parties.set(key, line);
      }
      const rows = [...parties.values()].sort((a, b) => (b.total as number) - (a.total as number));
      const sumOf = (key: string) => total(rows, (r) => r[key] as number);
      return {
        title: this.title,
        subtitle: `As of ${asOf}`,
        currency: c.base,
        columns: [
          { key: "party", header: "Customer or driver", type: "text", width: 2 },
          { key: "type", header: "Type", type: "text", width: 0.8 },
          { key: "invoices", header: "Invoices", type: "number", width: 0.6 },
          ...PAYABLE_BUCKETS.map((b) => ({
            key: b,
            header: AGE_HEADERS[b],
            type: "money" as const,
          })),
          { key: "total", header: "Total", type: "money", width: 1.2 },
        ],
        rows,
        totals: {
          party: "Total",
          type: null,
          invoices: invoices.length,
          ...Object.fromEntries(PAYABLE_BUCKETS.map((b) => [b, sumOf(b)])),
          total: sumOf("total"),
        },
        summary: [
          { label: "Owed", value: c.formatted(sumOf("total")) },
          {
            label: "Overdue",
            value: c.formatted(sumOf("total") - sumOf("current")),
          },
          {
            label: "Overdue share",
            value: `${share(sumOf("total") - sumOf("current"), sumOf("total")) ?? 0}%`,
          },
        ],
      };
    });
  }
}
