import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { DriverLedger } from "../../remittances/DriverLedger.js";
import { PERIOD_PARAMS, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { between, minor, minorOr, share, total, words } from "./cells.js";

/** Expected against received per driver, with the collection rate (docs/14 §3). */
export class RemittanceComplianceReport implements ReportDefinition {
  readonly id = "remittance_compliance";
  readonly title = "Remittance compliance";
  readonly description =
    "Per driver: remittance periods ending in the period, expected, received, waived and outstanding on fixed targets, the collection rate and what variable periods brought in";
  readonly category = "drivers" as const;
  readonly permission = "dashboards.remittances.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const drivers = await c.queries.remittancesByDriver(c.filter, c.range.from, c.range.to);
      const sum = (pick: (d: (typeof drivers)[number]) => number) => total(drivers, pick);
      const expected = sum((d) => d.expectedMinor);
      const received = sum((d) => d.receivedMinor);
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "code", header: "Code", type: "text", width: 0.7 },
          { key: "driver", header: "Driver", type: "text", width: 1.6 },
          { key: "vehicles", header: "Vehicles", type: "number", width: 0.6 },
          { key: "periods", header: "Periods", type: "number", width: 0.6 },
          { key: "short", header: "Short", type: "number", width: 0.6 },
          { key: "expected", header: "Expected", type: "money" },
          { key: "received", header: "Received", type: "money" },
          { key: "waived", header: "Waived", type: "money" },
          { key: "outstanding", header: "Outstanding", type: "money" },
          { key: "rate", header: "Collection rate", type: "percent", width: 0.8 },
          { key: "variable", header: "Variable received", type: "money" },
        ],
        rows: drivers.map((d) => ({
          code: d.code,
          driver: d.name,
          vehicles: d.vehicles,
          periods: d.periods,
          short: d.shortPeriods,
          expected: d.expectedMinor,
          received: d.receivedMinor,
          waived: d.waivedMinor,
          outstanding: d.outstandingMinor,
          rate: share(d.receivedMinor, d.expectedMinor),
          variable: d.variableReceivedMinor,
        })),
        totals: {
          code: "Total",
          driver: `${drivers.length} drivers`,
          vehicles: null,
          periods: sum((d) => d.periods),
          short: sum((d) => d.shortPeriods),
          expected,
          received,
          waived: sum((d) => d.waivedMinor),
          outstanding: sum((d) => d.outstandingMinor),
          rate: share(received, expected),
          variable: sum((d) => d.variableReceivedMinor),
        },
        summary: [
          { label: "Collection rate", value: `${share(received, expected) ?? "–"}%` },
          { label: "Outstanding", value: c.formatted(sum((d) => d.outstandingMinor)) },
        ],
      };
    });
  }
}

/** A driver's running account: charges, credits and the balance, with shortfalls (docs/14 §3). */
export class DriverStatementReport implements ReportDefinition {
  readonly id = "driver_statement";
  readonly title = "Driver statement";
  readonly description =
    "A driver's ledger in the period: what they were charged and paid with the running balance, opening and closing, and shortfall ageing";
  readonly category = "drivers" as const;
  readonly permission = "drivers.ledger.view" as const;
  readonly params = [
    { key: "driverId", label: "Driver", type: "uuid", required: true },
    { key: "from", label: "From", type: "date", required: false },
    { key: "to", label: "To", type: "date", required: false },
  ] as const;

  constructor(private readonly ledger: DriverLedger) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const st = await this.ledger.statement(actor, params.driverId!, {
      ...(params.from === undefined ? {} : { from: params.from }),
      ...(params.to === undefined ? {} : { to: params.to }),
    });
    const a = st.shortfalls.ageing;
    return {
      title: `${this.title}: ${st.driver.code} ${st.driver.name}`,
      subtitle: between(st),
      currency: st.closing.currency,
      columns: [
        { key: "date", header: "Date", type: "date", width: 0.8 },
        { key: "number", header: "Number", type: "text" },
        { key: "description", header: "Description", type: "text", width: 2.2 },
        { key: "charge", header: "Charge", type: "money" },
        { key: "credit", header: "Credit", type: "money" },
        { key: "balance", header: "Balance", type: "money" },
      ],
      rows: [
        {
          date: st.from,
          number: null,
          description: "Opening balance",
          charge: null,
          credit: null,
          balance: minor(st.opening),
        },
        ...st.lines.map((l) => ({
          date: l.date,
          number: l.number,
          description: l.description,
          charge: minorOr(l.charge),
          credit: minorOr(l.credit),
          balance: minor(l.balance),
        })),
      ],
      totals: {
        date: st.to,
        number: null,
        description: "Closing balance",
        charge: total(st.lines, (l) => l.charge?.amountMinor ?? 0),
        credit: total(st.lines, (l) => l.credit?.amountMinor ?? 0),
        balance: minor(st.closing),
      },
      summary: [
        { label: "Closing balance (owed by the driver)", value: st.closing.formatted },
        { label: "Short periods", value: String(st.shortfalls.periods) },
        { label: "Shortfalls", value: st.shortfalls.total.formatted },
        { label: "Shortfalls 0–7 days old", value: a.days0to7.formatted },
        { label: "Shortfalls 8–30 days old", value: a.days8to30.formatted },
        { label: "Shortfalls over 30 days old", value: a.over30.formatted },
      ],
    };
  }
}

/** A scorecard per driver: days worked, distance, collection, incidents and fines (docs/14 §3). */
export class DriverPerformanceReport implements ReportDefinition {
  readonly id = "driver_performance";
  readonly title = "Driver performance";
  readonly description =
    "Scorecard per driver: working days, distance, remittance collection rate, incidents, traffic offences and fines";
  readonly category = "drivers" as const;
  readonly permission = "dashboards.remittances.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const drivers = await c.queries.driverPerformance(c.filter, {
        from: c.range.from,
        to: c.range.to,
        fromAt: c.fromAt,
        untilAt: c.untilAt,
      });
      const sum = (pick: (d: (typeof drivers)[number]) => number) => total(drivers, pick);
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "code", header: "Code", type: "text", width: 0.7 },
          { key: "driver", header: "Driver", type: "text", width: 1.6 },
          { key: "status", header: "Status", type: "text", width: 0.8 },
          { key: "days", header: "Working days", type: "number", width: 0.7 },
          { key: "distance", header: "Distance", type: "number", width: 0.8 },
          { key: "expected", header: "Expected", type: "money" },
          { key: "received", header: "Received", type: "money" },
          { key: "rate", header: "Collection rate", type: "percent", width: 0.8 },
          { key: "incidents", header: "Incidents", type: "number", width: 0.6 },
          { key: "offences", header: "Offences", type: "number", width: 0.6 },
          { key: "fines", header: "Fines", type: "money" },
        ],
        rows: drivers.map((d) => ({
          code: d.code,
          driver: d.name,
          status: words(d.status),
          days: d.workingDays,
          distance: d.distance,
          expected: d.expectedMinor,
          received: d.receivedMinor,
          rate: share(d.receivedMinor, d.expectedMinor),
          incidents: d.incidents,
          offences: d.offences,
          fines: d.finesMinor,
        })),
        totals: {
          code: "Total",
          driver: `${drivers.length} drivers`,
          status: null,
          days: sum((d) => d.workingDays),
          distance: sum((d) => d.distance),
          expected: sum((d) => d.expectedMinor),
          received: sum((d) => d.receivedMinor),
          rate: share(
            sum((d) => d.receivedMinor),
            sum((d) => d.expectedMinor),
          ),
          incidents: sum((d) => d.incidents),
          offences: sum((d) => d.offences),
          fines: sum((d) => d.finesMinor),
        },
        summary: [{ label: "Drivers", value: String(drivers.length) }],
      };
    });
  }
}
