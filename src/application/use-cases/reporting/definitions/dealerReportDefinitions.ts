import type { MoneyJson } from "../../../../domain/money/Money.js";
import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { DealerGrossProfit } from "../../dealer/DealerGrossProfit.js";
import type { DealerReports } from "../../dealer/DealerReports.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";

const minor = (m: MoneyJson) => m.amountMinor;
const percent = (p: string | null) => (p === null ? null : Number(p));

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
