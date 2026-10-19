import type { StatusChange, Vehicle } from "../vehicles/Vehicle.js";

/** Vehicles of the current tenant (tenant unit of work). Removed vehicles are never returned. */
export interface IVehicleRepository {
  findById(id: string): Promise<Vehicle | null>;
  lockById(id: string): Promise<Vehicle | null>;
  /** Inserts or updates the vehicle with its group memberships. */
  save(vehicle: Vehicle): Promise<void>;
  /** Another (not removed) vehicle has this plate key or VIN. */
  plateTaken(plateKey: string, exceptId: string | null): Promise<boolean>;
  vinTaken(vin: string, exceptId: string | null): Promise<boolean>;
  recordStatusChange(
    vehicleId: string,
    change: StatusChange,
    changedBy: string | null,
    at: Date,
  ): Promise<void>;
}
