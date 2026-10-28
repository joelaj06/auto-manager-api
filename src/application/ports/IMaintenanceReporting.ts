import type { OffRoadSpell } from "../../domain/maintenance/MaintenanceMetrics.js";
import type { BranchFilter } from "./IReporting.js";

export type Instants = Readonly<{ from: Date; to: Date }>;

/** A work order completed in the period with its cost by kind of line and who paid. */
export type CompletedOrderRow = Readonly<{
  id: string;
  vehicleId: string;
  type: string;
  completedAt: Date;
  labourMinor: number;
  partMinor: number;
  subletMinor: number;
  otherMinor: number;
  /** Shares charged to the driver, the renter and an insurer (the business pays the rest). */
  recoveredMinor: number;
}>;

/** A vehicle of the fleet in scope with what it did in the period. */
export type FleetVehicleRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  mileageUnit: "km" | "mi";
  addedAt: Date;
  /** When it left the fleet (sold, transferred, scrapped …); null while in it. */
  leftAt: Date | null;
  /** Odometer movement over the period's days (the daily stats). */
  distance: number;
}>;

export type ServiceDueRow = Readonly<{
  vehicleId: string;
  taskName: string;
  status: "due" | "overdue";
  dueKm: number | null;
  dueOn: string | null;
}>;

export type DocumentExpiryRow = Readonly<{
  vehicleId: string;
  documentId: string;
  type: string;
  title: string | null;
  number: string | null;
  expiresOn: string;
}>;

export type LicenceExpiryRow = Readonly<{
  driverId: string;
  code: string;
  name: string;
  phone: string;
  branchId: string;
  licenceNumber: string | null;
  expiresOn: string;
}>;

export type ComplianceVehicleRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  status: string;
  /** Unpaid or contested fines past their due date. */
  finesOverdue: number;
  openIncidents: number;
}>;

export type IdleVehicleRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  branchId: string;
  since: Date;
}>;

export type LateWorkOrderRow = Readonly<{
  id: string;
  number: string;
  vehicleId: string;
  vehicleName: string;
  branchId: string;
  expectedBackAt: Date;
}>;

/** What the maintenance KPIs, the compliance dashboard and the daily alerts read (docs/12 §6). */
export interface IMaintenanceReporting {
  completedOrders(period: Instants, filter: BranchFilter): Promise<CompletedOrderRow[]>;
  /** Corrective and accident work orders opened in the period, per vehicle. */
  failures(period: Instants, filter: BranchFilter): Promise<Map<string, number>>;
  /** Vehicles in scope that were in the fleet at some point of the period (dates inclusive). */
  fleet(
    period: Instants,
    days: Readonly<{ from: string; to: string }>,
    filter: BranchFilter,
  ): Promise<FleetVehicleRow[]>;
  /** Work orders and incidents that took the vehicles off the road, overlapping the period. */
  offRoadSpells(period: Instants, filter: BranchFilter): Promise<Map<string, OffRoadSpell[]>>;
  openWorkOrders(filter: BranchFilter): Promise<Readonly<{ open: number; offRoad: number }>>;
  serviceDue(filter: BranchFilter): Promise<ServiceDueRow[]>;
  /** The latest document of each type per vehicle, when it expires on or before `until`. */
  documentsExpiring(until: string, filter: BranchFilter): Promise<DocumentExpiryRow[]>;
  /** Active drivers whose licence expires on or before `until`. */
  licencesExpiring(until: string, filter: BranchFilter): Promise<LicenceExpiryRow[]>;
  /** Vehicles in the fleet (not sold, transferred or scrapped) with their fines and incidents. */
  complianceVehicles(today: string, filter: BranchFilter): Promise<ComplianceVehicleRow[]>;
  /** Vehicles available since before `before`. */
  idleVehicles(before: Date): Promise<IdleVehicleRow[]>;
  /** Work orders keeping a vehicle off the road past the time it was expected back. */
  lateWorkOrders(now: Date): Promise<LateWorkOrderRow[]>;
}
