import { fuelAnomaly } from "../../../domain/expenses/ExpenseRules.js";
import { IncidentRuleError } from "../../../domain/incidents/Incident.js";
import type { Vehicle } from "../../../domain/vehicles/Vehicle.js";
import type { Principal } from "../../authorization/Principal.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { FuelLog, IFuelLogs } from "../../ports/IExpenseRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { FuelAnomalyRow, IIncidents } from "../../ports/IIncidents.js";
import type { INotificationSettingsStore } from "../../ports/INotifications.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { Notifier } from "../notifications/Notifier.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";

export class FuelAnomalyNotFoundError extends ApplicationError {
  readonly code = "FUEL_ANOMALY_NOT_FOUND";
  constructor() {
    super("Fuel anomaly not found");
  }
}

/** The fills an anomaly is judged against. */
const HISTORY = 30;

/**
 * Fuel anomalies (docs/06 §7): every full-tank fill is checked against the vehicle's own history
 * — no km since the last full fill, or far fewer km per litre than usual — and a fill that looks
 * wrong is kept for review and the branch's staff are told (decision 402).
 */
export class FuelAnomalies {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      incidents: IIncidents;
      logs: IFuelLogs;
      vehicleAccess: VehicleAccess;
      settings: INotificationSettingsStore;
      notifier: Notifier;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  /** Checks a fill just recorded (inside the fuel log's unit of work). */
  async check(vehicle: Vehicle, log: FuelLog): Promise<void> {
    const { deps } = this;
    const fills = await deps.logs.forVehicle(vehicle.id, HISTORY);
    const found = fuelAnomaly(fills, log.id);
    if (found === null) return;
    const row: FuelAnomalyRow = {
      id: deps.ids.next(),
      fuelLogId: log.id,
      vehicleId: vehicle.id,
      branchId: vehicle.branchId,
      driverId: log.driverId,
      kind: found.kind,
      kmPerLitre: found.kmPerLitre,
      baseline: found.baseline,
      litres: found.litres,
      distance: found.distance,
      status: "open",
      reviewedBy: null,
      reviewedAt: null,
      note: null,
      createdAt: deps.clock.now(),
    };
    await deps.incidents.addAnomaly(row);
    const settings = await deps.settings.get();
    if (!settings.rules.fuel_anomaly.enabled) return;
    const name = vehicle.snapshot().plateNumber ?? vehicle.snapshot().code;
    await deps.notifier.staff(settings, {
      rule: "fuel_anomaly",
      permission: "incidents.view",
      branchId: vehicle.branchId,
      dedupeKey: `fuel_anomaly:${log.id}`,
      title:
        found.kind === "no_distance"
          ? `${name}: ${found.litres} L with no km since the last fill`
          : `${name}: ${found.kmPerLitre} km/L, usually ${found.baseline}`,
      body:
        found.kind === "no_distance"
          ? `${found.litres} litres were put in ${name} without the odometer moving since the last full tank. Check the fill.`
          : `${name} did ${found.distance} km on ${found.litres} litres (${found.kmPerLitre} km/L) against its usual ${found.baseline} km/L. Possible siphoning or a leak.`,
      severity: "warning",
      data: { vehicleId: vehicle.id, fuelLogId: log.id },
    });
  }

  list(
    actor: Principal,
    query: Readonly<{ vehicleId?: string; status?: FuelAnomalyRow["status"]; limit: number }>,
  ): Promise<FuelAnomalyRow[]> {
    const { deps } = this;
    return deps.unitOfWork.run(() =>
      deps.incidents.anomalies({
        branchIds: deps.vehicleAccess.branchesFor(actor, "incidents.view"),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.status === undefined ? {} : { status: query.status }),
        limit: query.limit,
      }),
    );
  }

  /** Confirmed (something was wrong) or dismissed (explained), with a note. */
  review(
    actor: Principal,
    id: string,
    input: Readonly<{ status: "confirmed" | "dismissed"; note: string }>,
  ): Promise<FuelAnomalyRow> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const row = await deps.incidents.lockAnomaly(id);
      if (row === null || !deps.vehicleAccess.can(actor, "incidents.view", row.branchId))
        throw new FuelAnomalyNotFoundError();
      await deps.vehicleAccess.branch(actor, "incidents.manage", row.branchId);
      if (row.status !== "open")
        throw new IncidentRuleError(`The anomaly is already ${row.status}`);
      const note = input.note.trim();
      if (note.length < 3) throw new IncidentRuleError("Say what was found");
      const reviewed: FuelAnomalyRow = {
        ...row,
        status: input.status,
        note,
        reviewedBy: actor.userId,
        reviewedAt: deps.clock.now(),
      };
      await deps.incidents.updateAnomaly(reviewed);
      await recordUserAction(deps, actor.userId, {
        action: `fuel_anomaly.${input.status}`,
        entityType: "fuel_anomaly",
        entityId: id,
        before: { status: row.status },
        after: { status: input.status, note },
      });
      return reviewed;
    });
  }
}
