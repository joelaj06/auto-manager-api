import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { RentalReports } from "../../rentals/RentalReports.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { between, minor, minorOr, percent, share, total, vehicleName, words } from "./cells.js";

const BRANCH_PARAM = [{ key: "branchId", label: "Branch", type: "uuid", required: false }] as const;
const hours = (h: number) => Math.round(h * 10) / 10;

/** Bookings picked up in the period by status, customer and class (docs/14 §3). */
export class RentalBookingsReport implements ReportDefinition {
  readonly id = "rental_bookings";
  readonly title = "Rental bookings";
  readonly description =
    "Bookings with pickup in the period: status, customer and type, class, vehicle, dates and charges before tax";
  readonly category = "rentals" as const;
  readonly permission = "rentals.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const bookings = await c.queries.rentalBookings(c.filter, c.fromAt, c.untilAt);
      // Charges in another currency than the base are listed but not added up.
      const base = bookings.filter((b) => b.currency === c.base);
      const count = (pick: (b: (typeof bookings)[number]) => string) => {
        const counts = new Map<string, number>();
        for (const b of bookings) counts.set(pick(b), (counts.get(pick(b)) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1]);
      };
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "number", header: "Booking", type: "text" },
          { key: "status", header: "Status", type: "text", width: 0.8 },
          { key: "customer", header: "Customer", type: "text", width: 1.6 },
          { key: "customerType", header: "Type", type: "text", width: 0.7 },
          { key: "class", header: "Class", type: "text" },
          { key: "vehicle", header: "Vehicle", type: "text", width: 1.2 },
          { key: "branch", header: "Branch", type: "text" },
          { key: "pickup", header: "Pickup", type: "text", width: 1.1 },
          { key: "return", header: "Return", type: "text", width: 1.1 },
          { key: "charges", header: "Charges", type: "money" },
        ],
        rows: bookings.map((b) => ({
          number: b.number,
          status: words(b.status),
          customer: b.customerName,
          customerType: b.customerType,
          class: b.className,
          vehicle: b.vehicle,
          branch: b.branchName,
          pickup: c.timeOf(b.pickupAt),
          return: c.timeOf(b.returnAt),
          charges: b.currency === c.base ? b.chargesMinor : null,
        })),
        totals: {
          number: "Total",
          status: `${bookings.length} bookings`,
          customer: null,
          customerType: null,
          class: null,
          vehicle: null,
          branch: null,
          pickup: null,
          return: null,
          charges: total(base, (b) => b.chargesMinor),
        },
        summary: [
          ...count((b) => b.status).map(([s, n]) => ({ label: words(s)!, value: String(n) })),
          ...count((b) => b.customerType).map(([t, n]) => ({
            label: `${t} customers`,
            value: String(n),
          })),
          ...count((b) => b.className ?? "No class").map(([k, n]) => ({
            label: k,
            value: String(n),
          })),
        ],
      };
    });
  }
}

/** Hours on rent over hours available, per class and vehicle, with ADR (docs/14 §3). */
export class RentalUtilisationReport implements ReportDefinition {
  readonly id = "rental_utilisation";
  readonly title = "Rental utilisation and ADR";
  readonly description =
    "Utilisation by class and by vehicle as hours on rent over hours available, with the average daily rate and revenue per available vehicle";
  readonly category = "rentals" as const;
  readonly permission = "dashboards.rentals.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly rentals: RentalReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const query = periodOf(params);
    const u = await this.rentals.utilisation(actor, query);
    const r = await this.rentals.revenue(actor, query);
    return {
      title: this.title,
      subtitle: between(u.period),
      currency: r.revenue.currency,
      columns: [
        { key: "level", header: "Level", type: "text", width: 0.6 },
        { key: "name", header: "Class or vehicle", type: "text", width: 1.8 },
        { key: "class", header: "Class", type: "text" },
        { key: "vehicles", header: "Vehicles", type: "number", width: 0.6 },
        { key: "rented", header: "Hours on rent", type: "number" },
        { key: "available", header: "Hours available", type: "number" },
        { key: "utilisation", header: "Utilisation", type: "percent", width: 0.8 },
      ],
      rows: [
        ...u.byClass.map((k) => ({
          level: "class",
          name: k.className,
          class: k.className,
          vehicles: k.vehicles,
          rented: hours(k.rentedHours),
          available: hours(k.availableHours),
          utilisation: k.percent,
        })),
        ...u.byVehicle.map((v) => ({
          level: "vehicle",
          name: vehicleName(v),
          class: v.className,
          vehicles: 1,
          rented: hours(v.rentedHours),
          available: hours(v.availableHours),
          utilisation: v.percent,
        })),
      ],
      totals: {
        level: "Fleet",
        name: null,
        class: null,
        vehicles: u.fleet.vehicles,
        rented: hours(u.fleet.rentedHours),
        available: hours(u.fleet.availableHours),
        utilisation: u.fleet.percent,
      },
      summary: [
        { label: "Utilisation", value: u.fleet.percent === null ? "–" : `${u.fleet.percent}%` },
        { label: "Average daily rate", value: r.averageDailyRate?.formatted ?? "–" },
        {
          label: "Revenue per available vehicle-day",
          value: r.revenuePerAvailableVehicle?.formatted ?? "–",
        },
      ],
    };
  }
}

/** Booking revenue by class, branch and customer type (docs/14 §3). */
export class RentalRevenueReport implements ReportDefinition {
  readonly id = "rental_revenue";
  readonly title = "Rental revenue";
  readonly description =
    "Booking charges before tax by class, by branch and by customer type, with bookings and share of revenue";
  readonly category = "rentals" as const;
  readonly permission = "dashboards.rentals.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly rentals: RentalReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const r = await this.rentals.revenue(actor, periodOf(params));
    const line = (
      by: string,
      name: string,
      l: Readonly<{ revenue: { amountMinor: number }; bookings: number; share: number | null }>,
    ) => ({ by, name, bookings: l.bookings, revenue: l.revenue.amountMinor, share: l.share });
    return {
      title: this.title,
      subtitle: between(r.period),
      currency: r.revenue.currency,
      columns: [
        { key: "by", header: "By", type: "text", width: 0.8 },
        { key: "name", header: "Name", type: "text", width: 1.8 },
        { key: "bookings", header: "Bookings", type: "number", width: 0.7 },
        { key: "revenue", header: "Revenue", type: "money", width: 1.2 },
        { key: "share", header: "Share", type: "percent", width: 0.7 },
      ],
      rows: [
        ...r.byClass.map((k) => line("class", k.className, k)),
        ...r.byBranch.map((b) => line("branch", b.branchName, b)),
        ...r.byCustomerType.map((t) => line("customer type", t.customerType, t)),
      ],
      totals: {
        by: "Total",
        name: null,
        bookings: r.bookings,
        revenue: minor(r.revenue),
        share: null,
      },
      summary: [
        { label: "Revenue", value: r.revenue.formatted },
        { label: "Time charges", value: r.timeRevenue.formatted },
        {
          label: "Time charges share",
          value: `${share(r.timeRevenue.amountMinor, r.revenue.amountMinor) ?? "–"}%`,
        },
        { label: "Average daily rate", value: r.averageDailyRate?.formatted ?? "–" },
      ],
    };
  }
}

/** The day's pickups, returns, overdue rentals and lapsing reservations (docs/14 §3). */
export class RentalScheduleReport implements ReportDefinition {
  readonly id = "rental_schedule";
  readonly title = "Pickups and returns";
  readonly description =
    "Operational sheet of a day: pickups, returns, rentals overdue and reservations lapsing unless confirmed";
  readonly category = "rentals" as const;
  readonly permission = "dashboards.rentals.view" as const;
  readonly params = [
    { key: "date", label: "Date", type: "date", required: false },
    ...BRANCH_PARAM,
  ] as const;

  constructor(
    private readonly rentals: RentalReports,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const board = await this.rentals.board(actor, {
      ...(params.date === undefined ? {} : { date: params.date }),
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
    });
    // The tenant's clock for the times shown.
    const c = await this.context.within(actor, this.permission, {}, (scope) =>
      Promise.resolve(scope),
    );
    type Row = (typeof board.pickups)[number];
    const line = (what: string, b: Row, time: Date, note: string | null = null) => ({
      what,
      time: what === "overdue" ? c.timeOf(time) : c.timeOf(time).slice(11),
      number: b.number,
      status: words(b.status),
      customer: b.customer.name,
      phone: b.customer.phone,
      vehicle: `${vehicleName(b.vehicle)} ${b.vehicle.name}`,
      note,
    });
    return {
      title: this.title,
      subtitle: board.date,
      currency: c.base,
      columns: [
        { key: "what", header: "What", type: "text", width: 0.7 },
        { key: "time", header: "Time", type: "text", width: 0.8 },
        { key: "number", header: "Booking", type: "text" },
        { key: "status", header: "Status", type: "text", width: 0.8 },
        { key: "customer", header: "Customer", type: "text", width: 1.4 },
        { key: "phone", header: "Phone", type: "text" },
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.8 },
        { key: "note", header: "Note", type: "text" },
      ],
      rows: [
        ...board.pickups.map((b) => line("pickup", b, b.pickupAt)),
        ...board.returns.map((b) => line("return", b, b.returnAt)),
        ...board.overdue.map((b) =>
          line("overdue", b, b.returnAt, `${Math.round(b.overdueMinutes / 60)} h late`),
        ),
        ...board.expiring.map((b) => line("expiring", b, b.pickupAt, "confirm or lapse")),
      ],
      totals: null,
      summary: [
        { label: "Pickups", value: String(board.pickups.length) },
        { label: "Returns", value: String(board.returns.length) },
        { label: "Overdue", value: String(board.overdue.length) },
        { label: "Reservations lapsing", value: String(board.expiring.length) },
      ],
    };
  }
}

/** Security deposits held for renters: a liability (docs/14 §3). */
export class RentalDepositsReport implements ReportDefinition {
  readonly id = "rental_deposits";
  readonly title = "Rental deposits held";
  readonly description =
    "Security deposits held on bookings, with the customer, booking status and when taken";
  readonly category = "rentals" as const;
  readonly permission = "dashboards.rentals.view" as const;
  readonly params = BRANCH_PARAM;

  constructor(
    private readonly rentals: RentalReports,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const b = await this.rentals.balances(
      actor,
      params.branchId === undefined ? {} : { branchId: params.branchId },
    );
    const branches = await this.context.branchNames();
    return {
      title: this.title,
      subtitle: null,
      currency: b.depositsHeld.currency,
      columns: [
        { key: "number", header: "Booking", type: "text" },
        { key: "status", header: "Status", type: "text" },
        { key: "customer", header: "Customer", type: "text", width: 1.6 },
        { key: "branch", header: "Branch", type: "text" },
        { key: "heldAt", header: "Taken", type: "date" },
        { key: "held", header: "Held", type: "money", width: 1.2 },
      ],
      rows: b.deposits.map((d) => ({
        number: d.number,
        status: words(d.status),
        customer: d.customerName,
        branch: branches[d.branchId] ?? null,
        heldAt: d.heldAt.toISOString().slice(0, 10),
        held: minor(d.held),
      })),
      totals: {
        number: "Total",
        status: `${b.deposits.length} deposits`,
        customer: null,
        branch: null,
        heldAt: null,
        held: minor(b.depositsHeld),
      },
      summary: [
        { label: "Deposits held", value: b.depositsHeld.formatted },
        { label: "Owed by renters", value: b.outstanding.formatted },
      ],
    };
  }
}

/** Rental balances renters still owe (docs/07 §11). */
export class RentalBalancesReport implements ReportDefinition {
  readonly id = "rental_balances";
  readonly title = "Rental balances";
  readonly description =
    "What renters owe on their bookings: open invoices, charges not yet invoiced, credit held and the balance";
  readonly category = "rentals" as const;
  readonly permission = "dashboards.rentals.view" as const;
  readonly params = BRANCH_PARAM;

  constructor(private readonly rentals: RentalReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const b = await this.rentals.balances(
      actor,
      params.branchId === undefined ? {} : { branchId: params.branchId },
    );
    const sum = (pick: (r: (typeof b.bookings)[number]) => number) => total(b.bookings, pick);
    return {
      title: this.title,
      subtitle: null,
      currency: b.outstanding.currency,
      columns: [
        { key: "number", header: "Booking", type: "text" },
        { key: "status", header: "Status", type: "text", width: 0.8 },
        { key: "customer", header: "Customer", type: "text", width: 1.6 },
        { key: "returnAt", header: "Return", type: "date" },
        { key: "invoiced", header: "Invoiced, open", type: "money" },
        { key: "uninvoiced", header: "Not invoiced", type: "money" },
        { key: "credit", header: "Credit", type: "money" },
        { key: "balance", header: "Balance", type: "money" },
      ],
      rows: b.bookings.map((r) => ({
        number: r.number,
        status: words(r.status),
        customer: r.customer.name,
        returnAt: r.returnAt.toISOString().slice(0, 10),
        invoiced: minor(r.invoicedOpen),
        uninvoiced: minor(r.uninvoiced),
        credit: minor(r.credit),
        balance: minor(r.balance),
      })),
      totals: {
        number: "Total",
        status: `${b.bookings.length} bookings`,
        customer: null,
        returnAt: null,
        invoiced: sum((r) => minor(r.invoicedOpen)),
        uninvoiced: sum((r) => minor(r.uninvoiced)),
        credit: sum((r) => minor(r.credit)),
        balance: minor(b.outstanding),
      },
      summary: [{ label: "Owed by renters", value: b.outstanding.formatted }],
    };
  }
}

/** Damage costs against what renters were charged (docs/14 §3). */
export class RentalDamagesReport implements ReportDefinition {
  readonly id = "rental_damages";
  readonly title = "Rental damages";
  readonly description =
    "Damages recorded in the period with severity, liability, cost (final or estimated) and what was recovered from renters";
  readonly category = "rentals" as const;
  readonly permission = "dashboards.rentals.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly rentals: RentalReports) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const d = await this.rentals.damages(actor, periodOf(params));
    return {
      title: this.title,
      subtitle: between(d.period),
      currency: d.cost.currency,
      columns: [
        { key: "date", header: "Recorded", type: "date" },
        { key: "plate", header: "Vehicle", type: "text" },
        { key: "booking", header: "Booking", type: "text" },
        { key: "severity", header: "Severity", type: "text", width: 0.8 },
        { key: "status", header: "Status", type: "text", width: 0.8 },
        { key: "liability", header: "Liability", type: "text" },
        { key: "cost", header: "Cost", type: "money" },
        { key: "recovered", header: "Recovered", type: "money" },
      ],
      rows: d.rows.map((r) => ({
        date: r.createdAt.toISOString().slice(0, 10),
        plate: r.plateNumber,
        booking: r.bookingNumber,
        severity: words(r.severity),
        status: words(r.status),
        liability: words(r.liability),
        cost: minorOr(r.cost),
        recovered: minor(r.recovered),
      })),
      totals: {
        date: "Total",
        plate: `${d.damages} damages`,
        booking: null,
        severity: null,
        status: null,
        liability: null,
        cost: minor(d.cost),
        recovered: minor(d.recovered),
      },
      summary: [
        { label: "Cost", value: d.cost.formatted },
        { label: "Recovered", value: d.recovered.formatted },
        {
          label: "Recovered share",
          value: d.recoveredPercent === null ? "–" : `${percent(d.recoveredPercent)}%`,
        },
        ...d.byLiability.map((l) => ({
          label: `${words(l.liability)}: ${l.damages}`,
          value: `${l.cost.formatted} cost, ${l.recovered.formatted} recovered`,
        })),
      ],
    };
  }
}
