import type { ChargeAmount } from "../../domain/rentals/RentalBooking.js";
import type { RentalInspection } from "../../domain/rentals/RentalInspection.js";
import type { DamageStatus, VehicleDamage } from "../../domain/rentals/VehicleDamage.js";

/** Check-out and check-in inspections of rental bookings (tenant unit of work), docs/07 §6. */
export interface IRentalInspections {
  /** The booking's inspections with their photos, check-out first. */
  ofBooking(bookingId: string): Promise<RentalInspection[]>;
  insert(inspection: RentalInspection): Promise<void>;
  /** Of these files, those an inspection or a damage uses already. */
  usedFiles(fileIds: readonly string[]): Promise<string[]>;
}

export type DamageFilter = Readonly<{
  branchIds: "all" | readonly string[];
  vehicleId?: string;
  bookingId?: string;
  statuses?: readonly DamageStatus[];
  limit: number;
}>;

/** The damage register (the damage map) of the fleet, docs/07 §6. */
export interface IVehicleDamages {
  get(id: string): Promise<VehicleDamage | null>;
  /** Locks the damage row until the unit of work ends. */
  lock(id: string): Promise<VehicleDamage | null>;
  /** Newest first. */
  list(filter: DamageFilter): Promise<VehicleDamage[]>;
  insert(damage: VehicleDamage): Promise<void>;
  /** Saves the damage and its photos. */
  update(damage: VehicleDamage): Promise<void>;
  /** What the booking charges for the damage so far. */
  charged(damageId: string): Promise<ChargeAmount>;
}
