import { PAYABLE_BUCKETS } from "../../../../domain/finance/Payables.js";
import type { MoneyJson } from "../../../../domain/money/Money.js";
import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { DealerCommissions } from "../../dealer/DealerCommissions.js";
import type { DealerGrossProfit, GroupProfit } from "../../dealer/DealerGrossProfit.js";
import type { DealerLeads } from "../../dealer/DealerLeads.js";
import type { DealerReports } from "../../dealer/DealerReports.js";
import type { DealerStock } from "../../dealer/DealerStock.js";
import type { SupplierPayables } from "../../payables/SupplierPayables.js";
import type { Purchases } from "../../purchases/Purchases.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { AGE_HEADERS, minor, percent } from "./cells.js";

/** Gross profit per unit sold (docs/10 §10), for those who see stock cost. */
export class DealerGrossProfitReport implements ReportDefinition {
  readonly id = "dealer_gross_profit";
  readonly title = "Dealer gross profit per unit";
  readonly description =
    "Each vehicle sold in the period: revenue, cost, reconditioning, holding, commission, gross profit and margin";
  readonly category = "dealer" as const;
  readonly permission = "dealer.stock.cost.view" as const;
  readonly params = [
    { key: "from", label: "From", type: "date", required: true },
    { key: "to", label: "To", type: "date", required: true },
    { key: "branchId", label: "Branch", type: "uuid", required: false },
    { key: "salesExecutiveId", label: "Sales executive", type: "uuid", required: false },
  ] as const;
  readonly landscape = true;

  constructor(private readonly grossProfit: DealerGrossProfit) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const report = await this.grossProfit.report(actor, {
      from: params.from!,
      to: params.to!,
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.salesExecutiveId === undefined
        ? {}
        : { salesExecutiveId: params.salesExecutiveId }),
    });
    const t = report.totals;
    return {
      title: this.title,
      subtitle: `${report.from} to ${report.to}`,
      currency: t.revenue.currency,
      columns: [
        { key: "soldOn", header: "Sold", type: "date" },
        { key: "deal", header: "Deal", type: "text", width: 1.3 },
        { key: "vehicle", header: "Vehicle", type: "text", width: 2.2 },
        { key: "source", header: "Lead source", type: "text" },
        { key: "revenue", header: "Revenue", type: "money", width: 1.2 },
        { key: "cost", header: "Cost", type: "money", width: 1.2 },
        { key: "reconditioning", header: "Reconditioning", type: "money", width: 1.2 },
        { key: "holding", header: "Holding", type: "money" },
        { key: "commission", header: "Commission", type: "money" },
        { key: "grossProfit", header: "Gross profit", type: "money", width: 1.2 },
        { key: "margin", header: "Margin", type: "percent", width: 0.7 },
      ],
      rows: report.units.map((u) => ({
        soldOn: u.soldOn,
        deal: u.dealNumber,
        vehicle: u.vehicle,
        source: u.source?.replaceAll("_", " ") ?? null,
        revenue: minor(u.figures.revenue),
        cost: minor(u.figures.cost),
        reconditioning: minor(u.figures.reconditioning),
        holding: minor(u.figures.holding),
        commission: minor(u.figures.commission),
        grossProfit: minor(u.figures.grossProfit),
        margin: percent(u.marginPercent),
      })),
      totals: {
        soldOn: "Total",
        deal: `${t.count} units`,
        vehicle: null,
        source: null,
        revenue: minor(t.revenue),
        cost: minor(t.cost),
        reconditioning: minor(t.reconditioning),
        holding: minor(t.holding),
        commission: minor(t.commission),
        grossProfit: minor(t.grossProfit),
        margin: percent(t.marginPercent),
      },
      summary: [
        { label: "Units sold", value: String(t.count) },
        { label: "Gross profit per unit", value: t.perUnit?.formatted ?? "–" },
      ],
    };
  }
}

/** Asking-price cuts in a period (docs/10 §10). */
export class DealerPriceReductionsReport implements ReportDefinition {
  readonly id = "dealer_price_reductions";
  readonly title = "Dealer price reductions";
  readonly description =
    "Cuts in asking prices in the period: the vehicle, the old and new price, the cut, days in stock, who and why";
  readonly category = "dealer" as const;
  readonly permission = "dashboards.dealer.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly reports: DealerReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const report = await this.reports.priceReductions(actor, periodOf(params));
    return {
      title: this.title,
      subtitle: `${report.period.from} to ${report.period.to}`,
      currency: report.totals.reduced.currency,
      columns: [
        { key: "changedAt", header: "Changed", type: "date" },
        { key: "vehicle", header: "Vehicle", type: "text", width: 2.2 },
        { key: "status", header: "Stock status", type: "text" },
        { key: "days", header: "Days in stock", type: "number", width: 0.8 },
        { key: "previous", header: "Was", type: "money", width: 1.2 },
        { key: "asking", header: "Now", type: "money", width: 1.2 },
        { key: "reduction", header: "Cut", type: "money", width: 1.2 },
        { key: "percent", header: "Cut %", type: "percent", width: 0.7 },
        { key: "by", header: "By", type: "text" },
        { key: "reason", header: "Reason", type: "text", width: 1.8 },
      ],
      rows: report.reductions.map((r) => ({
        changedAt: r.changedAt.toISOString().slice(0, 10),
        vehicle: [r.vehicle.name, r.vehicle.plateNumber].filter((x) => x !== null).join(", "),
        status: r.vehicle.stockStatus,
        days: r.vehicle.daysInStockAtChange,
        previous: minor(r.previousAskingPrice),
        asking: minor(r.askingPrice),
        reduction: minor(r.reduction),
        percent: Number(r.reductionPercent),
        by: r.changedBy?.name ?? null,
        reason: r.reason,
      })),
      totals: {
        changedAt: "Total",
        vehicle: `${report.totals.vehicles} vehicles`,
        status: null,
        days: null,
        previous: null,
        asking: null,
        reduction: minor(report.totals.reduced),
        percent: null,
        by: null,
        reason: null,
      },
      summary: [
        { label: "Reductions", value: String(report.totals.reductions) },
        { label: "Reduced in all", value: report.totals.reduced.formatted },
      ],
    };
  }
}

/** Purchases read for one landed-cost report. */
const MAX_PURCHASES = 200;

const BUCKET_LABELS: Readonly<Record<string, string>> = {
  days0to30: "0–30 days",
  days31to60: "31–60 days",
  days61to90: "61–90 days",
  over90: "Over 90 days",
};

/** Stock on hand at asking price and cost by age, status, source, make and branch (docs/14 §3). */
export class DealerStockValuationReport implements ReportDefinition {
  readonly id = "dealer_stock_valuation";
  readonly title = "Dealer stock valuation and ageing";
  readonly description =
    "Vehicles in stock by days in stock, stock status, source, make and branch: count, asking value and cost (with cost access)";
  readonly category = "dealer" as const;
  readonly permission = "dealer.stock.list" as const;
  readonly params = [{ key: "branchId", label: "Branch", type: "uuid", required: false }] as const;

  constructor(
    private readonly stock: DealerStock,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const a = await this.stock.ageing(
      actor,
      params.branchId === undefined ? {} : { branchId: params.branchId },
    );
    const branches = await this.context.branchNames();
    const withCost = a.total.cost !== undefined;
    const line = (
      by: string,
      name: string,
      b: Readonly<{ count: number; asking: MoneyJson; cost?: MoneyJson }>,
    ) => ({
      by,
      name,
      count: b.count,
      asking: minor(b.asking),
      ...(withCost ? { cost: b.cost === undefined ? null : minor(b.cost) } : {}),
    });
    return {
      title: this.title,
      subtitle: `As of ${a.asOf}`,
      currency: a.total.asking.currency,
      columns: [
        { key: "by", header: "By", type: "text", width: 0.8 },
        { key: "name", header: "Name", type: "text", width: 1.6 },
        { key: "count", header: "Vehicles", type: "number", width: 0.7 },
        { key: "asking", header: "Asking value", type: "money", width: 1.2 },
        ...(withCost ? [{ key: "cost", header: "Cost", type: "money" as const, width: 1.2 }] : []),
      ],
      rows: [
        ...Object.entries(a.buckets).map(([k, b]) => line("age", BUCKET_LABELS[k] ?? k, b)),
        ...a.byStatus.map((b) => line("status", b.status, b)),
        ...a.bySource.map((b) => line("source", b.source.replaceAll("_", " "), b)),
        ...a.byMake.map((b) => line("make", b.make, b)),
        ...a.byBranch.map((b) => line("branch", branches[b.branchId] ?? b.branchId, b)),
      ],
      totals: line("Total", "In stock", a.total),
      summary: [
        { label: "Vehicles in stock", value: String(a.total.count) },
        { label: "Asking value", value: a.total.asking.formatted },
        ...(a.total.cost === undefined ? [] : [{ label: "Cost", value: a.total.cost.formatted }]),
        {
          label: "Average days in stock",
          value: a.averageDays === null ? "–" : String(a.averageDays),
        },
      ],
    };
  }
}

const GP_GROUPS = ["make", "sales_executive", "source", "branch"] as const;

/** Gross profit of the units sold grouped by make, seller, lead source or branch (docs/14 §3). */
export class DealerSalesSummaryReport implements ReportDefinition {
  readonly id = "dealer_sales_summary";
  readonly title = "Dealer sales and gross profit";
  readonly description =
    "Units sold in the period grouped by make, sales executive, lead source or branch: revenue, cost, gross profit, margin and gross profit per unit";
  readonly category = "dealer" as const;
  readonly permission = "dealer.stock.cost.view" as const;
  readonly params = [
    { key: "from", label: "From", type: "date", required: true },
    { key: "to", label: "To", type: "date", required: true },
    { key: "branchId", label: "Branch", type: "uuid", required: false },
    { key: "groupBy", label: "Group by", type: "enum", required: false, options: GP_GROUPS },
  ] as const;
  readonly landscape = true;

  constructor(
    private readonly grossProfit: DealerGrossProfit,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const report = await this.grossProfit.report(actor, {
      from: params.from!,
      to: params.to!,
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
    });
    const groupBy = (params.groupBy ?? "make") as (typeof GP_GROUPS)[number];
    const names =
      groupBy === "sales_executive"
        ? await this.context.userNames(report.bySalesExecutive.map((g) => g.salesExecutiveId))
        : groupBy === "branch"
          ? await this.context.branchNames()
          : {};
    const groups: readonly (GroupProfit & Readonly<{ name: string }>)[] =
      groupBy === "make"
        ? report.byMake.map((g) => ({ ...g, name: g.make }))
        : groupBy === "sales_executive"
          ? report.bySalesExecutive.map((g) => ({
              ...g,
              name: names[g.salesExecutiveId] ?? g.salesExecutiveId,
            }))
          : groupBy === "source"
            ? report.bySource.map((g) => ({
                ...g,
                name: g.source?.replaceAll("_", " ") ?? "No lead",
              }))
            : report.byBranch.map((g) => ({ ...g, name: names[g.branchId] ?? g.branchId }));
    const line = (name: string, g: GroupProfit) => ({
      name,
      units: g.count,
      revenue: minor(g.revenue),
      cost: minor(g.cost),
      reconditioning: minor(g.reconditioning),
      commission: minor(g.commission),
      grossProfit: minor(g.grossProfit),
      margin: percent(g.marginPercent),
      perUnit: g.perUnit === null ? null : minor(g.perUnit),
    });
    return {
      title: this.title,
      subtitle: `${report.from} to ${report.to}`,
      currency: report.totals.revenue.currency,
      columns: [
        {
          key: "name",
          header: groupBy.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()),
          type: "text",
          width: 1.6,
        },
        { key: "units", header: "Units", type: "number", width: 0.6 },
        { key: "revenue", header: "Revenue", type: "money", width: 1.2 },
        { key: "cost", header: "Cost", type: "money", width: 1.2 },
        { key: "reconditioning", header: "Reconditioning", type: "money" },
        { key: "commission", header: "Commission", type: "money" },
        { key: "grossProfit", header: "Gross profit", type: "money", width: 1.2 },
        { key: "margin", header: "Margin", type: "percent", width: 0.7 },
        { key: "perUnit", header: "Per unit", type: "money" },
      ],
      rows: groups.map((g) => line(g.name, g)),
      totals: line("Total", report.totals),
      summary: [
        { label: "Units sold", value: String(report.totals.count) },
        { label: "Gross profit", value: report.totals.grossProfit.formatted },
      ],
    };
  }
}

/** Leads created in the period by stage, source and sales executive (docs/14 §3). */
export class DealerLeadFunnelReport implements ReportDefinition {
  readonly id = "dealer_lead_funnel";
  readonly title = "Dealer lead funnel";
  readonly description =
    "Leads created in the period by where they stand now, by source and by sales executive, with conversion as won of those closed";
  readonly category = "dealer" as const;
  readonly permission = "dealer.leads.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(
    private readonly leads: DealerLeads,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const range = await this.context.within(actor, this.permission, params, (c) =>
      Promise.resolve(c.range),
    );
    const f = await this.leads.funnel(actor, {
      from: range.from,
      to: range.to,
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
    });
    const names = await this.context.userNames(
      f.byAssignee.flatMap((a) => (a.userId === null ? [] : [a.userId])),
    );
    type Line = Readonly<{
      leads: number;
      open: number;
      won: number;
      lost: number;
      conversion: string | null;
    }>;
    const line = (by: string, name: string, l: Line) => ({
      by,
      name,
      leads: l.leads,
      open: l.open,
      won: l.won,
      lost: l.lost,
      conversion: percent(l.conversion),
    });
    return {
      title: this.title,
      subtitle: `${f.from} to ${f.to}`,
      currency: await this.context.baseCurrency(),
      columns: [
        { key: "by", header: "By", type: "text", width: 0.9 },
        { key: "name", header: "Name", type: "text", width: 1.6 },
        { key: "leads", header: "Leads", type: "number", width: 0.6 },
        { key: "open", header: "Open", type: "number", width: 0.6 },
        { key: "won", header: "Won", type: "number", width: 0.6 },
        { key: "lost", header: "Lost", type: "number", width: 0.6 },
        { key: "conversion", header: "Conversion", type: "percent", width: 0.8 },
      ],
      rows: [
        ...f.bySource.map((s) => line("source", s.source.replaceAll("_", " "), s)),
        ...f.byAssignee.map((a) =>
          line(
            "sales executive",
            a.userId === null ? "Unassigned" : (names[a.userId] ?? a.userId),
            a,
          ),
        ),
      ],
      totals: line("Total", "All leads", f.total),
      summary: Object.entries(f.stages).map(([stage, count]) => ({
        label: stage.replaceAll("_", " "),
        value: String(count),
      })),
    };
  }
}

/** A month's commissions per seller (docs/14 §3). */
export class DealerCommissionsReport implements ReportDefinition {
  readonly id = "dealer_commissions";
  readonly title = "Dealer commissions";
  readonly description =
    "Per seller for a month: vehicles earned on, commission earned, accrued, payable, paid and clawed back";
  readonly category = "dealer" as const;
  readonly permission = "dealer.commissions.view" as const;
  readonly params = [{ key: "month", label: "Month", type: "month", required: true }] as const;

  constructor(private readonly commissions: DealerCommissions) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const st = await this.commissions.statement(actor, { period: params.month! });
    type Totals = Readonly<{
      earned: MoneyJson;
      accrued: MoneyJson;
      payable: MoneyJson;
      paid: MoneyJson;
      clawedBack: MoneyJson;
    }>;
    const line = (seller: string, units: number | null, t: Totals) => ({
      seller,
      units,
      earned: minor(t.earned),
      accrued: minor(t.accrued),
      payable: minor(t.payable),
      paid: minor(t.paid),
      clawedBack: minor(t.clawedBack),
    });
    return {
      title: this.title,
      subtitle: st.period,
      currency: st.totals.earned.currency,
      columns: [
        { key: "seller", header: "Seller", type: "text", width: 1.6 },
        { key: "units", header: "Vehicles", type: "number", width: 0.6 },
        { key: "earned", header: "Earned", type: "money" },
        { key: "accrued", header: "Accrued", type: "money" },
        { key: "payable", header: "Payable", type: "money" },
        { key: "paid", header: "Paid", type: "money" },
        { key: "clawedBack", header: "Clawed back", type: "money" },
      ],
      rows: st.bySeller.map((s) => line(s.userName, s.units, s)),
      totals: line(
        "Total",
        st.bySeller.reduce((sum, s) => sum + s.units, 0),
        st.totals,
      ),
      summary: [
        { label: "Sellers", value: String(st.bySeller.length) },
        { label: "Payouts", value: String(st.payouts.length) },
      ],
    };
  }
}

/** Cash collected on deals, what sold deals still owe and deposits held (docs/10 §10). */
export class DealerCollectionsReport implements ReportDefinition {
  readonly id = "dealer_collections";
  readonly title = "Dealer collections";
  readonly description =
    "What sold and delivered deals still owe on their invoices, with cash collected on deals by method and the deposits held";
  readonly category = "dealer" as const;
  readonly permission = "dashboards.dealer.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly reports: DealerReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const r = await this.reports.collections(actor, periodOf(params));
    return {
      title: this.title,
      subtitle: `${r.period.from} to ${r.period.to}`,
      currency: r.outstanding.currency,
      columns: [
        { key: "number", header: "Deal", type: "text", width: 1.2 },
        { key: "status", header: "Status", type: "text", width: 0.8 },
        { key: "financing", header: "Financing", type: "text", width: 0.8 },
        { key: "customer", header: "Customer", type: "text", width: 1.6 },
        { key: "soldOn", header: "Sold", type: "date" },
        { key: "invoiced", header: "Invoiced", type: "money" },
        { key: "paid", header: "Paid", type: "money" },
        { key: "balance", header: "Balance", type: "money" },
      ],
      rows: r.deals.map((d) => ({
        number: d.number,
        status: d.status,
        financing: d.financing.replaceAll("_", " "),
        customer: d.customer.name,
        soldOn: d.soldOn,
        invoiced: minor(d.invoiced),
        paid: minor(d.paid),
        balance: minor(d.balance),
      })),
      totals: {
        number: "Total",
        status: `${r.deals.length} deals`,
        financing: null,
        customer: null,
        soldOn: null,
        invoiced: r.deals.reduce((s, d) => s + minor(d.invoiced), 0),
        paid: r.deals.reduce((s, d) => s + minor(d.paid), 0),
        balance: minor(r.outstanding),
      },
      summary: [
        { label: "Collected in the period", value: r.collected.formatted },
        ...r.byMethod.map((m) => ({
          label: `${m.method.replaceAll("_", " ")} (${m.payments})`,
          value: m.amount.formatted,
        })),
        { label: "Taken in part exchange", value: r.tradeIns.formatted },
        {
          label: "Deposits held",
          value: `${r.depositsHeld.formatted} on ${r.deposits.length} deals`,
        },
      ],
    };
  }
}

/** Vehicles bought with their landed cost and where each purchase stands (docs/14 §3). */
export class PurchasesReport implements ReportDefinition {
  readonly id = "purchases_landed_cost";
  readonly title = "Purchases and landed cost";
  readonly description =
    "Each vehicle on a purchase with its supplier, status and import stage, price and the landed cost built from direct and shared costs";
  readonly category = "dealer" as const;
  readonly permission = "purchases.view" as const;
  readonly params = [
    {
      key: "status",
      label: "Status",
      type: "enum",
      required: false,
      options: ["draft", "ordered", "received"],
    },
    { key: "branchId", label: "Branch", type: "uuid", required: false },
  ] as const;
  readonly landscape = true;

  constructor(
    private readonly purchases: Purchases,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const list = await this.purchases.list(actor, {
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      statuses:
        params.status === undefined
          ? ["draft", "ordered", "received"]
          : [params.status as "draft" | "ordered" | "received"],
      limit: MAX_PURCHASES,
    });
    const base = await this.context.baseCurrency();
    const views = [];
    for (const p of list) views.push(await this.purchases.get(actor, p.id));
    const rows = views.flatMap((p) =>
      p.lines.map((l) => ({
        number: p.number,
        type: p.type,
        status: p.status,
        stage: p.stage?.replaceAll("_", " ") ?? null,
        supplier: p.supplierName,
        vehicle: [l.year, l.make, l.model].filter((x) => x !== null).join(" "),
        vin: l.vin,
        price: minor(l.landedCost.price),
        direct: minor(l.landedCost.direct),
        shared: minor(l.landedCost.shared),
        landed: minor(l.landedCost.total),
        pending: minor(l.landedCost.pending),
      })),
    );
    const sum = (key: "price" | "direct" | "shared" | "landed" | "pending") =>
      rows.reduce((s, r) => s + r[key], 0);
    return {
      title: this.title,
      subtitle: null,
      currency: base,
      columns: [
        { key: "number", header: "Purchase", type: "text" },
        { key: "type", header: "Type", type: "text", width: 0.6 },
        { key: "status", header: "Status", type: "text", width: 0.7 },
        { key: "stage", header: "Stage", type: "text" },
        { key: "supplier", header: "Supplier", type: "text", width: 1.3 },
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.5 },
        { key: "vin", header: "VIN", type: "text", width: 1.3 },
        { key: "price", header: "Price", type: "money" },
        { key: "direct", header: "Direct costs", type: "money" },
        { key: "shared", header: "Shared costs", type: "money" },
        { key: "landed", header: "Landed cost", type: "money" },
        { key: "pending", header: "Pending", type: "money" },
      ],
      rows,
      totals: {
        number: "Total",
        type: null,
        status: null,
        stage: null,
        supplier: `${views.length} purchases`,
        vehicle: `${rows.length} vehicles`,
        vin: null,
        price: sum("price"),
        direct: sum("direct"),
        shared: sum("shared"),
        landed: sum("landed"),
        pending: sum("pending"),
      },
      summary: [
        { label: "Purchases", value: String(views.length) },
        {
          label: "In transit or at port",
          value: String(views.filter((p) => p.status === "ordered" && p.type === "import").length),
        },
      ],
    };
  }
}

/** What is owed to suppliers and drivers on approved bills, by age (docs/14 §3). */
export class SupplierPayablesReport implements ReportDefinition {
  readonly id = "supplier_payables";
  readonly title = "Supplier payables ageing";
  readonly description =
    "Unpaid bills per supplier or driver by days past due: not yet due, 1–30, 31–60, 61–90 and over 90";
  readonly category = "dealer" as const;
  readonly permission = "finance.payables.view" as const;
  readonly params = [{ key: "asOf", label: "As of", type: "date", required: false }] as const;
  readonly landscape = true;

  constructor(private readonly payables: SupplierPayables) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const aged = await this.payables.aged(
      actor,
      params.asOf === undefined ? {} : { asOf: params.asOf },
    );
    const buckets = PAYABLE_BUCKETS.map((b) => ({ key: b, header: AGE_HEADERS[b] }));
    const line = (
      payee: string,
      type: string | null,
      bills: number,
      t: MoneyJson,
      b: Readonly<Record<string, MoneyJson>>,
    ) => ({
      payee,
      type,
      bills,
      ...Object.fromEntries(buckets.map(({ key }) => [key, minor(b[key]!)])),
      total: minor(t),
    });
    return {
      title: this.title,
      subtitle: `As of ${aged.asOf}`,
      currency: aged.total.currency,
      columns: [
        { key: "payee", header: "Supplier or driver", type: "text", width: 2 },
        { key: "type", header: "Type", type: "text", width: 0.7 },
        { key: "bills", header: "Bills", type: "number", width: 0.5 },
        ...buckets.map(({ key, header }) => ({ key, header, type: "money" as const })),
        { key: "total", header: "Total", type: "money", width: 1.2 },
      ],
      rows: aged.payees.map((p) =>
        line(p.name, p.payee?.type ?? null, p.bills, p.total, p.buckets),
      ),
      totals: line(
        "Total",
        null,
        aged.payees.reduce((s, p) => s + p.bills, 0),
        aged.total,
        aged.buckets,
      ),
      summary: [
        { label: "Owed", value: aged.total.formatted },
        { label: "Payees", value: String(aged.payees.length) },
      ],
    };
  }
}
