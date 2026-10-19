import type { CustomFieldDefinition } from "../../domain/vehicles/CustomFields.js";
import type { OdometerReadingProps } from "../../domain/vehicles/OdometerReading.js";
import type { VehicleProps, VehicleUsage } from "../../domain/vehicles/Vehicle.js";
import type { VehicleDocumentType } from "../../domain/vehicles/VehicleCompliance.js";
import type { VehicleStatus } from "../../domain/vehicles/VehicleStatus.js";

export type VehicleListFilter = Readonly<{
  /** Branches the caller may see ("all" or a list); vehicles of inactive branches never show. */
  branchIds: "all" | readonly string[];
  branchId?: string;
  statuses?: readonly VehicleStatus[];
  usage?: VehicleUsage;
  groupId?: string;
  makeId?: string;
  tag?: string;
  /** Plate (any spelling), code, VIN, make or model. */
  search?: string;
  /** Include sold, transferred, scrapped and written-off vehicles. */
  includeOffFleet?: boolean;
  limit: number;
  /** Keyset cursor: created-at and id of the last vehicle of the previous page. */
  after?: Readonly<{ createdAt: string; id: string }>;
}>;

export type StatusHistoryEntry = Readonly<{
  id: string;
  from: VehicleStatus | null;
  to: VehicleStatus;
  reason: string | null;
  ref: Readonly<{ type: string; id: string }> | null;
  changedBy: string | null;
  changedAt: Date;
}>;

export type TimelineEntry = Readonly<{
  id: string;
  at: Date;
  kind: "status" | "document" | "odometer";
  actorId: string | null;
  data: Readonly<Record<string, unknown>>;
}>;

/** Reads over the vehicle register (tenant unit of work). */
export interface IVehicleQueries {
  list(filter: VehicleListFilter): Promise<VehicleProps[]>;
  statusHistory(vehicleId: string, limit: number): Promise<StatusHistoryEntry[]>;
  /** Status changes, documents and odometer readings, newest first. */
  timeline(vehicleId: string, before: Date | null, limit: number): Promise<TimelineEntry[]>;
  /** Vehicles still in the fleet (not off-fleet, not removed) in a branch. */
  countInBranch(branchId: string): Promise<number>;
  /** Distance driven between two instants from the readings (null without two readings). */
  distanceBetween(vehicleId: string, from: Date, to: Date): Promise<number | null>;
}

export type VehicleDocument = Readonly<{
  id: string;
  vehicleId: string;
  type: VehicleDocumentType;
  title: string | null;
  number: string | null;
  provider: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  costMinor: number | null;
  reminderDays: readonly number[];
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface IVehicleDocuments {
  list(vehicleId: string): Promise<VehicleDocument[]>;
  /** Documents of many vehicles at once (compliance board). */
  forVehicles(vehicleIds: readonly string[]): Promise<VehicleDocument[]>;
  get(id: string): Promise<VehicleDocument | null>;
  save(document: VehicleDocument): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface IOdometerReadings {
  /** The readings just before and just after `at` (by reading time). */
  neighbours(
    vehicleId: string,
    at: Date,
  ): Promise<
    Readonly<{
      before: OdometerReadingProps | null;
      after: OdometerReadingProps | null;
    }>
  >;
  add(reading: OdometerReadingProps): Promise<void>;
  list(vehicleId: string, limit: number): Promise<OdometerReadingProps[]>;
}

export type VehicleGroup = Readonly<{
  id: string;
  name: string;
  description: string | null;
  vehicleCount: number;
  createdAt: Date;
}>;

export interface IVehicleGroups {
  list(): Promise<VehicleGroup[]>;
  get(id: string): Promise<VehicleGroup | null>;
  nameTaken(name: string, exceptId: string | null): Promise<boolean>;
  save(group: Readonly<{ id: string; name: string; description: string | null }>): Promise<void>;
  /** Deletes the group and its memberships (the vehicles stay). */
  remove(id: string): Promise<void>;
  /** The ids among `ids` that are groups. */
  existing(ids: readonly string[]): Promise<string[]>;
}

export type VehicleComplianceSettings = Readonly<{
  /** Document types every vehicle needs to operate legally. */
  requiredDocuments: readonly VehicleDocumentType[];
  /** A document is "expiring" this many days before its expiry date. */
  expiringWithinDays: number;
  /**
   * What modules do with a non-compliant vehicle (rentals, assignments): warn and continue, or
   * refuse.
   */
  enforcement: "warn" | "block";
}>;

export type VehicleSettings = Readonly<{
  compliance: VehicleComplianceSettings;
  /** Reminder days per document type (copied onto new documents). */
  reminderDays: Readonly<Partial<Record<VehicleDocumentType, readonly number[]>>>;
  customFields: readonly CustomFieldDefinition[];
}>;

export const DEFAULT_VEHICLE_SETTINGS: VehicleSettings = Object.freeze({
  compliance: {
    requiredDocuments: ["registration", "roadworthy", "insurance"],
    expiringWithinDays: 30,
    enforcement: "warn",
  },
  reminderDays: {},
  customFields: [],
});

/** The business's vehicle settings (organisation settings, tenant unit of work). */
export interface IVehicleSettingsStore {
  get(): Promise<VehicleSettings>;
  set(settings: VehicleSettings): Promise<void>;
}
