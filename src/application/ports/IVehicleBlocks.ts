import type { BusyInterval, VehicleBlock } from "../../domain/rentals/VehicleBlock.js";
import type { VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";

/** A vehicle as availability sees it (docs/07 §3). */
export type FleetVehicle = Readonly<{
  id: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  classId: string | null;
  status: VehicleStatus;
  /** The class turnaround; 0 without a class. */
  turnaroundMinutes: number;
}>;

export type FleetFilter = Readonly<{
  branchIds: "all" | readonly string[];
  /** Only this class; otherwise every vehicle in a class. */
  classId?: string | null;
  /** Only vehicles in the rental states (RENTABLE_STATUSES). */
  rentableOnly: boolean;
}>;

/** Vehicle blocks of the current tenant (tenant unit of work), docs/07 §3, docs/22 §4. */
export interface IVehicleBlocks {
  /** Serialises block writers of these vehicles until the unit of work ends. */
  lock(vehicleIds: readonly string[]): Promise<void>;
  /** Releases the lapsed holds of these vehicles, so they stop blocking; how many. */
  releaseLapsed(vehicleIds: readonly string[], now: Date): Promise<number>;
  /** The live blocks of these vehicles sharing time with `interval` (lapsed holds left out). */
  busy(vehicleIds: readonly string[], interval: BusyInterval, now: Date): Promise<VehicleBlock[]>;
  get(id: string): Promise<VehicleBlock | null>;
  /** Inserts or updates; VehicleUnavailableError when another live block overlaps. */
  save(block: VehicleBlock): Promise<void>;
  /** Vehicles in a rental class (not removed, not off the fleet). */
  fleet(filter: FleetFilter): Promise<FleetVehicle[]>;
  vehicle(id: string): Promise<FleetVehicle | null>;
}
