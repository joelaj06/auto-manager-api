import type { VehicleAssignment } from "../assignments/VehicleAssignment.js";

/** Vehicle assignments of the current tenant (tenant unit of work). */
export interface IAssignmentRepository {
  findById(id: string): Promise<VehicleAssignment | null>;
  /** The open assignment of a vehicle (locked for update), if any. */
  lockOpenForVehicle(vehicleId: string): Promise<VehicleAssignment | null>;
  /**
   * Inserts or updates. Throws AssignmentConflictError when the database refuses a second open
   * assignment or overlapping periods (decision 9).
   */
  save(assignment: VehicleAssignment): Promise<void>;
}
