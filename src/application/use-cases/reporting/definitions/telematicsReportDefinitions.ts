import type { ParamValues, ReportTable } from "../../../../domain/reporting/Report.js";
import type { Principal } from "../../../authorization/Principal.js";
import type { TelematicsViews } from "../../telematics/TelematicsViews.js";
import { PERIOD_PARAMS, periodOf, type ReportDefinition } from "../ReportDefinition.js";
import type { ReportContext } from "../ReportContext.js";

/** Utilisation from ignition (docs/06 §9, decision 506). */
export class TelematicsUtilisationReport implements ReportDefinition {
  readonly id = "telematics_utilisation";
  readonly title = "Utilisation from trackers";
  readonly description =
    "Per tracked vehicle: engine, moving and idle hours, distance, trips, active days, over-speed events and engine hours against the working day";
  readonly category = "fleet" as const;
  readonly permission = "telematics.view" as const;
  readonly params = PERIOD_PARAMS;
  readonly landscape = true;

  constructor(
    private readonly views: TelematicsViews,
    private readonly context: ReportContext,
  ) {}

  async run(actor: Principal, params: ParamValues): Promise<ReportTable> {
    const u = await this.views.utilisation(actor, periodOf(params));
    return {
      title: this.title,
      subtitle: `${u.from} to ${u.to}`,
      currency: await this.context.baseCurrency(),
      columns: [
        { key: "vehicle", header: "Vehicle", type: "text", width: 1.4 },
        { key: "engine", header: "Engine hours", type: "number" },
        { key: "moving", header: "Moving hours", type: "number" },
        { key: "idle", header: "Idle hours", type: "number" },
        { key: "idlePercent", header: "Idle", type: "percent" },
        { key: "distance", header: "Distance (km)", type: "number" },
        { key: "trips", header: "Trips", type: "number" },
        { key: "activeDays", header: "Active days", type: "number" },
        { key: "overspeed", header: "Over speed", type: "number" },
        { key: "utilisation", header: "Utilisation", type: "percent" },
      ],
      rows: u.vehicles.map((v) => ({
        vehicle: v.vehicleName,
        engine: v.engineHours,
        moving: v.movingHours,
        idle: v.idleHours,
        idlePercent: v.idlePercent,
        distance: v.distanceKm,
        trips: v.trips,
        activeDays: v.activeDays,
        overspeed: v.overspeedEvents,
        utilisation: v.utilisationPercent,
      })),
      totals: {
        vehicle: `${u.vehicles.length} vehicles`,
        engine: u.totals.engineHours,
        moving: u.totals.movingHours,
        idle: u.totals.idleHours,
        idlePercent: u.totals.idlePercent,
        distance: u.totals.distanceKm,
        trips: u.totals.trips,
        activeDays: u.totals.activeDays,
        overspeed: u.totals.overspeedEvents,
        utilisation: u.totals.utilisationPercent,
      },
      summary: [
        { label: "Working day", value: `${u.workingHoursPerDay} hours` },
        {
          label: "Fleet utilisation",
          value:
            u.totals.utilisationPercent === null
              ? "–"
              : `${u.totals.utilisationPercent.toFixed(1)}%`,
        },
      ],
    };
  }
}
