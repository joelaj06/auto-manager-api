import { Money } from "../../../../domain/money/Money.js";
import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { MaintenanceReports } from "../../maintenance/MaintenanceReports.js";
import type { Dashboards, VehicleProfitView } from "../Dashboards.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";
import { between, minor, minorOr, share, total, vehicleName, words } from "./cells.js";

const BRANCH_PARAM = [{ key: "branchId", label: "Branch", type: "uuid", required: false }] as const;

/** Every vehicle with its status, branch, driver, odometer and documents (docs/14 §3). */
export class FleetRegisterReport implements ReportDefinition {
  readonly id = "fleet_register";
  readonly title = "Fleet register";
  readonly description =
    "All vehicles with status, use, ownership, branch, current driver, odometer and the next document to expire";
  readonly category = "fleet" as const;
  readonly permission = "vehicles.list" as const;
  readonly params = BRANCH_PARAM;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const vehicles = await c.queries.fleetRegister(c.filter, c.today);
      const byStatus = new Map<string, number>();
      for (const v of vehicles) byStatus.set(v.status, (byStatus.get(v.status) ?? 0) + 1);
      return {
        title: this.title,
        subtitle: `As of ${c.today}`,
        currency: c.base,
        columns: [
          { key: "code", header: "Code", type: "text", width: 0.8 },
          { key: "plate", header: "Plate", type: "text", width: 0.9 },
          { key: "vehicle", header: "Make and model", type: "text", width: 1.6 },
          { key: "year", header: "Year", type: "number", width: 0.5 },
          { key: "status", header: "Status", type: "text" },
          { key: "usage", header: "Use", type: "text", width: 0.7 },
          { key: "ownership", header: "Ownership", type: "text", width: 0.8 },
          { key: "branch", header: "Branch", type: "text" },
          { key: "driver", header: "Driver", type: "text", width: 1.3 },
          { key: "odometer", header: "Odometer", type: "number", width: 0.8 },
          { key: "nextDocument", header: "Next document", type: "text", width: 1.2 },
          { key: "expiresOn", header: "Expires", type: "date", width: 0.8 },
          { key: "expired", header: "Expired", type: "number", width: 0.6 },
        ],
        rows: vehicles.map((v) => ({
          code: v.code,
          plate: v.plateNumber,
          vehicle: `${v.make} ${v.model}`,
          year: v.year,
          status: words(v.status),
          usage: words(v.usage),
          ownership: words(v.ownership),
          branch: v.branchName,
          driver: v.driverName,
          odometer: v.odometer,
          nextDocument: words(v.nextDocument?.type ?? null),
          expiresOn: v.nextDocument?.expiresOn ?? null,
          expired: v.documentsExpired,
        })),
        totals: null,
        summary: [
          { label: "Vehicles", value: String(vehicles.length) },
          ...[...byStatus.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([status, count]) => ({ label: words(status)!, value: String(count) })),
        ],
      };
    });
  }
}

/** Days working, idle and off the road per vehicle (docs/14 §3). */
export class FleetUtilisationReport implements ReportDefinition {
  readonly id = "fleet_utilisation";
  readonly title = "Fleet utilisation";
  readonly description =
    "Per vehicle: days working, idle, off the road and otherwise, and utilisation as working days in service";
  readonly category = "fleet" as const;
  readonly permission = "dashboards.vehicles.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly dashboards: Dashboards) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const fleet = await this.dashboards.vehicleProfits(actor, periodOf(params));
    const sum = (pick: (v: VehicleProfitView) => number) => total(fleet.vehicles, pick);
    return {
      title: this.title,
      subtitle: between(fleet.period),
      currency: fleet.totals.profit.currency,
      columns: [
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "model", header: "Make and model", type: "text", width: 1.6 },
        { key: "working", header: "Working", type: "number" },
        { key: "idle", header: "Idle", type: "number" },
        { key: "offRoad", header: "Off the road", type: "number" },
        { key: "other", header: "Other", type: "number" },
        { key: "utilisation", header: "Utilisation", type: "percent" },
      ],
      rows: [...fleet.vehicles]
        .sort((a, b) => (b.utilisationPercent ?? -1) - (a.utilisationPercent ?? -1))
        .map((v) => ({
          vehicle: vehicleName(v),
          model: `${v.make} ${v.model}`,
          working: v.days.working,
          idle: v.days.idle,
          offRoad: v.days.off_road,
          other: v.days.other,
          utilisation: v.utilisationPercent,
        })),
      totals: {
        vehicle: "Total",
        model: `${fleet.vehicles.length} vehicles`,
        working: sum((v) => v.days.working),
        idle: sum((v) => v.days.idle),
        offRoad: sum((v) => v.days.off_road),
        other: sum((v) => v.days.other),
        utilisation: fleet.totals.utilisationPercent,
      },
      summary: [
        {
          label: "Fleet utilisation",
          value:
            fleet.totals.utilisationPercent === null
              ? "–"
              : `${fleet.totals.utilisationPercent.toFixed(1)}%`,
        },
      ],
    };
  }
}

/** Expired and expiring documents and licences, services and fines (docs/14 §3). */
export class ComplianceReport implements ReportDefinition {
  readonly id = "compliance";
  readonly title = "Compliance";
  readonly description =
    "Vehicle documents and driver licences expired or expiring, services due or overdue, overdue fines and open incidents";
  readonly category = "fleet" as const;
  readonly permission = "dashboards.maintenance.view" as const;
  readonly params = [
    ...BRANCH_PARAM,
    {
      key: "within",
      label: "Expiring within",
      type: "enum",
      required: false,
      options: ["7", "14", "30", "60", "90"],
    },
  ] as const;
  readonly landscape = true;

  constructor(
    private readonly maintenance: MaintenanceReports,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const dash = await this.maintenance.compliance(actor, {
      ...(params.branchId === undefined ? {} : { branchId: params.branchId }),
      ...(params.within === undefined ? {} : { days: Number(params.within) }),
    });
    const state = (expired: boolean) => (expired ? "expired" : "expiring");
    const rows = [
      ...dash.vehicles.flatMap((v) => {
        const subject = vehicleName(v);
        return [
          ...v.documents.map((d) => ({
            level: v.level,
            subject,
            kind: "document",
            item: d.title ?? words(d.type),
            reference: d.number,
            date: d.expiresOn,
            status: state(d.expired),
          })),
          ...v.services.map((s) => ({
            level: v.level,
            subject,
            kind: "service",
            item: s.taskName,
            reference: s.dueKm === null ? null : `at ${s.dueKm} km`,
            date: s.dueOn,
            status: s.status,
          })),
          ...(v.finesOverdue === 0
            ? []
            : [
                {
                  level: v.level,
                  subject,
                  kind: "fines",
                  item: `${v.finesOverdue} overdue`,
                  reference: null,
                  date: null,
                  status: "overdue",
                },
              ]),
          ...(v.openIncidents === 0
            ? []
            : [
                {
                  level: v.level,
                  subject,
                  kind: "incidents",
                  item: `${v.openIncidents} open`,
                  reference: null,
                  date: null,
                  status: "open",
                },
              ]),
        ];
      }),
      ...dash.drivers.map((d) => ({
        level: d.expired ? "red" : "amber",
        subject: `${d.code} ${d.name}`,
        kind: "licence",
        item: "Driving licence",
        reference: d.licenceNumber,
        date: d.expiresOn,
        status: state(d.expired),
      })),
    ];
    const s = dash.summary;
    return {
      title: this.title,
      subtitle: `As of ${dash.date}, expiring within ${dash.withinDays} days`,
      currency: await this.context.baseCurrency(),
      columns: [
        { key: "level", header: "Level", type: "text", width: 0.6 },
        { key: "subject", header: "Vehicle or driver", type: "text", width: 1.6 },
        { key: "kind", header: "Kind", type: "text", width: 0.8 },
        { key: "item", header: "Item", type: "text", width: 1.6 },
        { key: "reference", header: "Reference", type: "text" },
        { key: "date", header: "Expires or due", type: "date" },
        { key: "status", header: "Status", type: "text", width: 0.8 },
      ],
      rows,
      totals: null,
      summary: [
        {
          label: "Vehicles red / amber / green",
          value: `${s.vehicles.red} / ${s.vehicles.amber} / ${s.vehicles.green}`,
        },
        {
          label: "Documents expired / expiring",
          value: `${s.documentsExpired} / ${s.documentsExpiring}`,
        },
        {
          label: "Licences expired / expiring",
          value: `${s.licencesExpired} / ${s.licencesExpiring}`,
        },
        { label: "Services overdue / due", value: `${s.servicesOverdue} / ${s.servicesDue}` },
        { label: "Fines overdue", value: String(s.finesOverdue) },
        { label: "Open incidents", value: String(s.openIncidents) },
      ],
    };
  }
}

/** Fuel bought, consumption and cost per distance, with the anomalies flagged (docs/14 §3). */
export class FuelReport implements ReportDefinition {
  readonly id = "fuel";
  readonly title = "Fuel";
  readonly description =
    "Per vehicle: litres, fuel cost, distance, distance per litre, fuel cost per km or mile and the fuel anomalies flagged";
  readonly category = "fleet" as const;
  readonly permission = "dashboards.vehicles.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(
    private readonly dashboards: Dashboards,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const fleet = await this.dashboards.vehicleProfits(actor, periodOf(params));
    const anomalies = await this.context.within(actor, this.permission, params, (c) =>
      c.queries.fuelAnomalies(c.filter, c.fromAt, c.untilAt),
    );
    const flagged = new Map(anomalies.map((a) => [a.vehicleId, a.anomalies]));
    const vehicles = fleet.vehicles.filter((v) => v.fuel.litres > 0 || flagged.has(v.vehicleId));
    const litres = total(vehicles, (v) => v.fuel.litres);
    const cost = total(vehicles, (v) => minor(v.fuel.cost));
    const distance = total(vehicles, (v) => (v.fuel.litres > 0 ? v.distance.value : 0));
    const perDistance = (c: number, d: number) => (d === 0 ? null : Math.round(c / d));
    return {
      title: this.title,
      subtitle: between(fleet.period),
      currency: fleet.totals.profit.currency,
      columns: [
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "model", header: "Make and model", type: "text", width: 1.6 },
        { key: "litres", header: "Litres", type: "number" },
        { key: "cost", header: "Fuel cost", type: "money" },
        { key: "distance", header: "Distance", type: "number" },
        { key: "perLitre", header: "Per litre", type: "number", width: 0.7 },
        { key: "costPerDistance", header: "Fuel cost per km/mi", type: "money" },
        { key: "anomalies", header: "Anomalies", type: "number", width: 0.7 },
      ],
      rows: vehicles.map((v) => ({
        vehicle: vehicleName(v),
        model: `${v.make} ${v.model}`,
        litres: v.fuel.litres,
        cost: minor(v.fuel.cost),
        distance: v.distance.value,
        perLitre: v.fuel.distancePerLitre,
        costPerDistance: perDistance(minor(v.fuel.cost), v.distance.value),
        anomalies: flagged.get(v.vehicleId) ?? 0,
      })),
      totals: {
        vehicle: "Total",
        model: `${vehicles.length} vehicles`,
        litres: Math.round(litres * 100) / 100,
        cost,
        distance,
        perLitre: litres === 0 ? null : Math.round((distance / litres) * 100) / 100,
        costPerDistance: perDistance(cost, distance),
        anomalies: total(anomalies, (a) => a.anomalies),
      },
      summary: [
        {
          label: "Fuel cost",
          value: Money.ofMinor(cost, fleet.totals.profit.currency).toJSON().formatted,
        },
        { label: "Litres", value: String(Math.round(litres * 100) / 100) },
      ],
    };
  }
}

/** Distance per vehicle in the period (docs/14 §3). */
export class MileageReport implements ReportDefinition {
  readonly id = "mileage";
  readonly title = "Odometer and mileage";
  readonly description =
    "Distance covered by each vehicle in the period with its current odometer unit";
  readonly category = "fleet" as const;
  readonly permission = "dashboards.vehicles.view" as const;
  readonly params = PERIOD_PARAMS;

  constructor(private readonly dashboards: Dashboards) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const fleet = await this.dashboards.vehicleProfits(actor, periodOf(params));
    const vehicles = [...fleet.vehicles].sort((a, b) => b.distance.value - a.distance.value);
    const days = (v: VehicleProfitView) =>
      v.days.working + v.days.idle + v.days.off_road + v.days.other;
    return {
      title: this.title,
      subtitle: between(fleet.period),
      currency: fleet.totals.profit.currency,
      columns: [
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "model", header: "Make and model", type: "text", width: 1.6 },
        { key: "distance", header: "Distance", type: "number" },
        { key: "unit", header: "Unit", type: "text", width: 0.5 },
        { key: "workingDays", header: "Working days", type: "number" },
        { key: "perWorkingDay", header: "Per working day", type: "number" },
        { key: "costPerDistance", header: "Cost per km/mi", type: "money" },
      ],
      rows: vehicles.map((v) => ({
        vehicle: vehicleName(v),
        model: `${v.make} ${v.model}`,
        distance: v.distance.value,
        unit: v.distance.unit,
        workingDays: v.days.working,
        perWorkingDay: v.days.working === 0 ? null : Math.round(v.distance.value / v.days.working),
        costPerDistance: minorOr(v.costPerDistance),
      })),
      totals: {
        vehicle: "Total",
        model: `${vehicles.length} vehicles`,
        distance: total(vehicles, (v) => v.distance.value),
        unit: null,
        workingDays: total(vehicles, (v) => v.days.working),
        perWorkingDay: null,
        costPerDistance: null,
      },
      summary: [
        {
          label: "Vehicles that moved",
          value: `${vehicles.filter((v) => v.distance.value > 0).length} of ${vehicles.length}`,
        },
        {
          label: "Days in service",
          value: String(total(vehicles, days)),
        },
      ],
    };
  }
}

/** Accidents and other incidents, traffic offences and insurance claims (docs/14 §3). */
export class IncidentsReport implements ReportDefinition {
  readonly id = "incidents";
  readonly title = "Incidents, fines and claims";
  readonly description =
    "Incidents, traffic offences with their fines and insurance claims in the period, with vehicle, driver and status";
  readonly category = "fleet" as const;
  readonly permission = "incidents.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(private readonly context: ReportContext) {}

  run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    return this.context.within(actor, this.permission, params, async (c) => {
      const events = await c.queries.incidents(c.filter, {
        from: c.range.from,
        to: c.range.to,
        fromAt: c.fromAt,
        untilAt: c.untilAt,
      });
      const count = (kind: string) => events.filter((e) => e.kind === kind).length;
      const fines = total(events, (e) => (e.kind === "offence" ? (e.amountMinor ?? 0) : 0));
      return {
        title: this.title,
        subtitle: between(c.range),
        currency: c.base,
        columns: [
          { key: "date", header: "Date", type: "date", width: 0.8 },
          { key: "kind", header: "Kind", type: "text", width: 0.7 },
          { key: "reference", header: "Reference", type: "text" },
          { key: "type", header: "Type", type: "text" },
          { key: "vehicle", header: "Vehicle", type: "text", width: 1.3 },
          { key: "driver", header: "Driver", type: "text", width: 1.2 },
          { key: "branch", header: "Branch", type: "text" },
          { key: "status", header: "Status", type: "text", width: 0.8 },
          { key: "amount", header: "Fine or claim", type: "money" },
          { key: "detail", header: "Detail", type: "text", width: 1.6 },
        ],
        rows: events.map((e) => ({
          date: e.date,
          kind: e.kind,
          reference: e.reference,
          type: words(e.type),
          vehicle: e.vehicle,
          driver: e.driverName,
          branch: e.branchName,
          status: words(e.status),
          amount: e.amountMinor,
          detail: words(e.detail),
        })),
        totals: null,
        summary: [
          { label: "Incidents", value: String(count("incident")) },
          { label: "Traffic offences", value: String(count("offence")) },
          { label: "Fines", value: c.formatted(fines) },
          { label: "Insurance claims", value: String(count("claim")) },
          {
            label: "Share of offences unpaid",
            value: `${share(events.filter((e) => e.kind === "offence" && e.status === "unpaid").length, count("offence")) ?? 0}%`,
          },
        ],
      };
    });
  }
}
