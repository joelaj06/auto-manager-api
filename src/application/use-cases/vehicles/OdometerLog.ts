import type { IVehicleRepository } from "../../../domain/repositories/IVehicleRepository.js";
import {
  checkOdometerReading,
  type OdometerReadingProps,
} from "../../../domain/vehicles/OdometerReading.js";
import type { Principal } from "../../authorization/Principal.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { IOdometerReadings } from "../../ports/IVehicleRecords.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "./VehicleAccess.js";

export type OdometerInput = Readonly<{
  value: number;
  /** When it was read (default: now); a late entry must fit between the readings around it. */
  readAt?: Date;
  /** The odometer was replaced: the series restarts from this value (needs `note`). */
  replacement?: boolean;
  note?: string | null;
}>;

/**
 * Odometer readings (docs/06 §5): recorded by hand here; rentals, fuel logs and work orders add
 * theirs later through the same rule (always increasing, unless the odometer was replaced).
 * The latest reading is the vehicle's current odometer.
 */
export class OdometerLog {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      vehicles: IVehicleRepository;
      readings: IOdometerReadings;
      access: VehicleAccess;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: IClock;
    }>,
  ) {}

  async list(actor: Principal, vehicleId: string, limit: number): Promise<OdometerReadingProps[]> {
    return this.deps.unitOfWork.run(async () => {
      await this.deps.access.reach(actor, vehicleId, "vehicles.view");
      return this.deps.readings.list(vehicleId, limit);
    });
  }

  async record(
    actor: Principal,
    vehicleId: string,
    input: OdometerInput,
  ): Promise<OdometerReadingProps> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      // Locking the vehicle serialises readings of the same vehicle.
      const vehicle = await deps.access.reach(actor, vehicleId, "vehicles.odometer.record", true);
      const now = deps.clock.now();
      const readAt = input.readAt ?? now;
      const note = input.note?.trim() ?? null;
      const reading = {
        value: input.value,
        readAt,
        replacement: input.replacement ?? false,
        note: note === "" ? null : note,
      };
      checkOdometerReading(reading, await deps.readings.neighbours(vehicleId, readAt), now);
      const recorded: OdometerReadingProps = {
        ...reading,
        id: deps.ids.next(),
        vehicleId,
        source: "manual",
        refId: null,
        recordedBy: actor.userId,
        createdAt: now,
      };
      await deps.readings.add(recorded);
      vehicle.applyOdometer(reading.value, readAt, now);
      await deps.vehicles.save(vehicle);
      await recordUserAction(deps, actor.userId, {
        action: reading.replacement ? "vehicle.odometer_replaced" : "vehicle.odometer_recorded",
        entityType: "vehicle",
        entityId: vehicleId,
        after: { value: reading.value, readAt, note: reading.note },
      });
      return recorded;
    });
  }
}
