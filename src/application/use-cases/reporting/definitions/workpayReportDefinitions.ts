import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { WorkPayReports } from "../../workpay/WorkPayReports.js";
import type { ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { minor, total, vehicleName, words } from "./cells.js";

/** Financed, collected, outstanding, PAR and ageing of the Work & Pay book (docs/14 §3). */
export class WorkPayPortfolioReport implements ReportDefinition {
  readonly id = "workpay_portfolio";
  readonly title = "Work & Pay portfolio";
  readonly description =
    "Agreements running, financed, collected and outstanding, completion, portfolio at risk 7/30/60/90 and overdue ageing";
  readonly category = "workpay" as const;
  readonly permission = "dashboards.workpay.view" as const;
  readonly params = [{ key: "branchId", label: "Branch", type: "uuid", required: false }] as const;

  constructor(private readonly workpay: WorkPayReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const p = await this.workpay.portfolio(
      actor,
      params.branchId === undefined ? {} : { branchId: params.branchId },
    );
    const line = (
      section: string,
      item: string,
      amount: number | null,
      agreements: number | null = null,
      pct: number | null = null,
    ) => ({ section, item, agreements, amount, percent: pct });
    return {
      title: this.title,
      subtitle: `As of ${p.asOf}`,
      currency: p.financed.currency,
      columns: [
        { key: "section", header: "Section", type: "text", width: 0.9 },
        { key: "item", header: "Item", type: "text", width: 1.8 },
        { key: "agreements", header: "Agreements", type: "number", width: 0.7 },
        { key: "amount", header: "Amount", type: "money", width: 1.2 },
        { key: "percent", header: "Share", type: "percent", width: 0.7 },
      ],
      rows: [
        line("Book", "Financed", minor(p.financed), p.agreements.running),
        line("Book", "Collected", minor(p.collected), null, p.completionPercent),
        line("Book", "Outstanding", minor(p.outstanding)),
        line("Book", "Overdue", minor(p.overdue)),
        line("Book", "Penalties outstanding", minor(p.penaltiesOutstanding)),
        line("Book", "Charges outstanding", minor(p.chargesOutstanding)),
        ...p.par.map((b) =>
          line("Portfolio at risk", `PAR ${b.days}`, minor(b.outstanding), b.agreements, b.percent),
        ),
        ...Object.entries(p.ageing).map(([bucket, m]) =>
          line(
            "Overdue ageing",
            bucket === "over_90" ? "Over 90 days" : `${bucket} days`,
            minor(m),
          ),
        ),
        line(
          "Collection",
          `Due ${p.collectionRate.from} to ${p.collectionRate.to}`,
          minor(p.collectionRate.due),
        ),
        line(
          "Collection",
          "Paid of that",
          minor(p.collectionRate.paid),
          null,
          p.collectionRate.percent,
        ),
      ],
      totals: null,
      summary: [
        { label: "Agreements running", value: String(p.agreements.running) },
        ...Object.entries(p.agreements.byStatus).map(([status, count]) => ({
          label: words(status)!,
          value: String(count),
        })),
      ],
    };
  }
}

/** Agreements in arrears, longest first (docs/14 §3). */
export class WorkPayArrearsReport implements ReportDefinition {
  readonly id = "workpay_arrears";
  readonly title = "Work & Pay arrears";
  readonly description =
    "Agreements in arrears with driver, vehicle, overdue, penalties, outstanding and days in arrears, longest first";
  readonly category = "workpay" as const;
  readonly permission = "dashboards.workpay.view" as const;
  readonly params = [{ key: "branchId", label: "Branch", type: "uuid", required: false }] as const;
  readonly landscape = true;

  constructor(
    private readonly workpay: WorkPayReports,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const rows = await this.workpay.arrears(actor, {
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      limit: 10_000,
    });
    const sum = (pick: (r: (typeof rows)[number]) => number) => total(rows, pick);
    return {
      title: this.title,
      subtitle: null,
      currency: await this.context.baseCurrency(),
      columns: [
        { key: "number", header: "Agreement", type: "text" },
        { key: "status", header: "Status", type: "text", width: 0.8 },
        { key: "driver", header: "Driver", type: "text", width: 1.5 },
        { key: "phone", header: "Phone", type: "text" },
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.2 },
        { key: "since", header: "In arrears since", type: "date" },
        { key: "days", header: "Days", type: "number", width: 0.5 },
        { key: "overdue", header: "Overdue", type: "money" },
        { key: "penalties", header: "Penalties", type: "money" },
        { key: "outstanding", header: "Outstanding", type: "money" },
        { key: "nextDue", header: "Next due", type: "date" },
      ],
      rows: rows.map((r) => ({
        number: r.number,
        status: words(r.status),
        driver: r.driver.name,
        phone: r.driver.phone,
        vehicle: vehicleName(r.vehicle),
        since: r.arrearsSince,
        days: r.daysInArrears,
        overdue: minor(r.overdue),
        penalties: minor(r.penaltiesOutstanding),
        outstanding: minor(r.outstanding),
        nextDue: r.nextDueOn,
      })),
      totals: {
        number: "Total",
        status: `${rows.length} agreements`,
        driver: null,
        phone: null,
        vehicle: null,
        since: null,
        days: null,
        overdue: sum((r) => minor(r.overdue)),
        penalties: sum((r) => minor(r.penaltiesOutstanding)),
        outstanding: sum((r) => minor(r.outstanding)),
        nextDue: null,
      },
      summary: [{ label: "Agreements in arrears", value: String(rows.length) }],
    };
  }
}

/** Instalments expected week by week over the next 90 days (docs/14 §3). */
export class WorkPayForecastReport implements ReportDefinition {
  readonly id = "workpay_forecast";
  readonly title = "Work & Pay collections forecast";
  readonly description =
    "Instalments due week by week over the next 90 days, and the next 7, 30 and 90 days";
  readonly category = "workpay" as const;
  readonly permission = "dashboards.workpay.view" as const;
  readonly params = [{ key: "branchId", label: "Branch", type: "uuid", required: false }] as const;

  constructor(private readonly workpay: WorkPayReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const p = await this.workpay.portfolio(
      actor,
      params.branchId === undefined ? {} : { branchId: params.branchId },
    );
    const f = p.forecast;
    return {
      title: this.title,
      subtitle: `As of ${p.asOf}`,
      currency: f.next90.currency,
      columns: [
        { key: "from", header: "From", type: "date" },
        { key: "to", header: "To", type: "date" },
        { key: "amount", header: "Expected", type: "money", width: 1.4 },
      ],
      rows: f.weeks.map((w) => ({ from: w.from, to: w.to, amount: minor(w.amount) })),
      totals: { from: "Total", to: null, amount: total(f.weeks, (w) => minor(w.amount)) },
      summary: [
        { label: "Next 7 days", value: f.next7.formatted },
        { label: "Next 30 days", value: f.next30.formatted },
        { label: "Next 90 days", value: f.next90.formatted },
      ],
    };
  }
}

/** One agreement's schedule and payments (docs/14 §3; the PDF statement is in docs/08 §6). */
export class WorkPayStatementReport implements ReportDefinition {
  readonly id = "workpay_statement";
  readonly title = "Work & Pay agreement statement";
  readonly description =
    "An agreement's instalment schedule with what was paid, waived and rescheduled, and its totals";
  readonly category = "workpay" as const;
  readonly permission = "workpay.view" as const;
  readonly params = [
    { key: "agreementId", label: "Agreement", type: "uuid", required: true },
  ] as const;

  constructor(private readonly workpay: WorkPayReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const st = await this.workpay.statement(actor, params.agreementId!);
    const t = st.totals;
    const sum = (pick: (s: (typeof st.schedule)[number]) => number) => total(st.schedule, pick);
    return {
      title: `${this.title} ${st.agreement.number}`,
      subtitle: `As of ${st.asOf}`,
      currency: t.outstanding.currency,
      columns: [
        { key: "number", header: "#", type: "number", width: 0.4 },
        { key: "dueOn", header: "Due", type: "date" },
        { key: "amount", header: "Amount", type: "money" },
        { key: "paid", header: "Paid", type: "money" },
        { key: "waived", header: "Waived", type: "money" },
        { key: "rescheduled", header: "Rescheduled", type: "money" },
        { key: "status", header: "Status", type: "text" },
      ],
      rows: st.schedule.map((s) => ({
        number: s.number,
        dueOn: s.dueOn,
        amount: minor(s.amount),
        paid: minor(s.paid),
        waived: minor(s.waived),
        rescheduled: minor(s.rescheduled),
        status: words(s.status),
      })),
      totals: {
        number: null,
        dueOn: "Total",
        amount: sum((s) => minor(s.amount)),
        paid: sum((s) => minor(s.paid)),
        waived: sum((s) => minor(s.waived)),
        rescheduled: sum((s) => minor(s.rescheduled)),
        status: null,
      },
      summary: [
        { label: "Driver", value: `${st.driver.code} ${st.driver.name}` },
        {
          label: "Vehicle",
          value: `${st.vehicle.code} ${st.vehicle.make} ${st.vehicle.model}`,
        },
        { label: "Total price", value: st.terms.totalPrice.formatted },
        { label: "Deposit", value: st.terms.deposit.formatted },
        { label: "Paid to date", value: t.paidToDate.formatted },
        { label: "Outstanding", value: t.outstanding.formatted },
        { label: "Overdue", value: t.overdue.formatted },
        { label: "Complete", value: `${t.percentComplete}%` },
        { label: "Days in arrears", value: String(t.daysInArrears) },
      ],
    };
  }
}
