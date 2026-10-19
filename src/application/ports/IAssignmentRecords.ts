import {
  DEFAULT_HANDOVER_ITEMS,
  type ChecklistItemDefinition,
  type RemittanceMode,
  type VehicleAssignmentProps,
} from "../../domain/assignments/VehicleAssignment.js";

/** An assignment with who and what it is about, for lists and history. */
export type AssignmentRecord = VehicleAssignmentProps &
  Readonly<{
    vehicle: Readonly<{
      id: string;
      code: string;
      plateNumber: string | null;
      make: string;
      model: string;
    }>;
    driver: Readonly<{ id: string; code: string; name: string; phone: string }>;
  }>;

export type AssignmentListFilter = Readonly<{
  /** Branches the caller may see (by the vehicle's current branch). */
  branchIds: "all" | readonly string[];
  branchId?: string;
  vehicleId?: string;
  driverId?: string;
  /** Only open (true) or only ended (false) assignments. */
  open?: boolean;
  limit: number;
  /** Keyset cursor: start time and id of the last assignment of the previous page. */
  after?: Readonly<{ startedAt: string; id: string }>;
}>;

/** Reads over assignments (tenant unit of work). */
export interface IAssignmentQueries {
  get(id: string): Promise<AssignmentRecord | null>;
  openForVehicle(vehicleId: string): Promise<AssignmentRecord | null>;
  openForDriver(driverId: string): Promise<AssignmentRecord | null>;
  /** The assignment of a vehicle covering an instant ("who was driving on date X"). */
  at(vehicleId: string, instant: Date): Promise<AssignmentRecord | null>;
  /** Newest start first. */
  list(filter: AssignmentListFilter): Promise<AssignmentRecord[]>;
}

export type AssignmentSettings = Readonly<{
  /** What is checked at every handover (docs/06 §6). */
  handoverItems: readonly ChecklistItemDefinition[];
  /** Remittance mode of new remittance assignments (decision 8). */
  defaultRemittanceMode: RemittanceMode;
  /** Refuse drivers whose licence has expired. */
  requireValidLicence: boolean;
}>;

export const DEFAULT_ASSIGNMENT_SETTINGS: AssignmentSettings = Object.freeze({
  handoverItems: DEFAULT_HANDOVER_ITEMS,
  defaultRemittanceMode: "fixed_target",
  requireValidLicence: true,
});

/** Assignment settings in `organisation.settings->'assignments'` (tenant unit of work). */
export interface IAssignmentSettingsStore {
  get(): Promise<AssignmentSettings>;
  set(settings: AssignmentSettings): Promise<void>;
}
