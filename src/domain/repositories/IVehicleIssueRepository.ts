import type { Paged } from "../value-objects/Paged.js";
import type { IssueStatus, VehicleIssue } from "../vehicles/VehicleIssue.js";

export type VehicleIssueFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  vehicleId?: string;
  driverId?: string;
  statuses?: readonly IssueStatus[];
  limit: number;
  offset?: number;
}>;

export interface IVehicleIssueRepository {
  findById(id: string): Promise<VehicleIssue | null>;
  lockById(id: string): Promise<VehicleIssue | null>;
  save(issue: VehicleIssue): Promise<void>;
  /** Newest first. */
  list(filter: VehicleIssueFilter): Promise<Paged<VehicleIssue>>;
}
