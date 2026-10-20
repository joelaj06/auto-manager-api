import { divideHalfEven } from "../money/Decimal.js";
import { Money } from "../money/Money.js";
import type { CustomFieldValue } from "./CustomFields.js";
import { InvalidVehicleError, parseVin, PlateNumber } from "./VehicleIdentifiers.js";
import {
  INITIAL_STATUSES,
  MODULE_STATUSES,
  manualNextStatuses,
  nextStatuses,
  VehicleStatusError,
  type VehicleStatus,
} from "./VehicleStatus.js";

export const BODY_TYPES = [
  "saloon",
  "hatchback",
  "suv",
  "pickup",
  "van",
  "minibus",
  "bus",
  "truck",
  "motorbike",
  "tricycle",
  "other",
] as const;
export const FUEL_TYPES = [
  "petrol",
  "diesel",
  "hybrid",
  "electric",
  "lpg",
  "cng",
  "other",
] as const;
export const TRANSMISSIONS = ["manual", "automatic", "cvt", "other"] as const;
export const DRIVES = ["2wd", "4wd", "awd"] as const;
export const USAGES = ["fleet", "rental", "workpay", "stock", "personal"] as const;
export const OWNERSHIP_TYPES = [
  "owned",
  "financed",
  "leased",
  "consigned",
  "driver_owned",
] as const;
export const DEPRECIATION_METHODS = ["none", "straight_line"] as const;

export type BodyType = (typeof BODY_TYPES)[number];
export type FuelType = (typeof FUEL_TYPES)[number];
export type Transmission = (typeof TRANSMISSIONS)[number];
export type Drive = (typeof DRIVES)[number];
export type VehicleUsage = (typeof USAGES)[number];
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];
export type MileageUnit = "km" | "mi";

/** Descriptive fields a user edits directly (identity, specs, classification). */
export type VehicleDetails = Readonly<{
  plateNumber: string | null;
  vin: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  makeId: string | null;
  make: string;
  modelId: string | null;
  model: string;
  trim: string | null;
  year: number | null;
  colour: string | null;
  bodyType: BodyType | null;
  fuelType: FuelType | null;
  transmission: Transmission | null;
  engineCc: number | null;
  seats: number | null;
  doors: number | null;
  drive: Drive | null;
  mileageUnit: MileageUnit;
  usage: VehicleUsage;
  ownershipType: OwnershipType;
  ownershipNote: string | null;
  tags: readonly string[];
  specs: Readonly<Record<string, string | number>>;
  customFields: Readonly<Record<string, CustomFieldValue>>;
  notes: string | null;
}>;

/** Acquisition and depreciation (shown only with `vehicles.financials.view`). */
export type VehicleFinancials = Readonly<{
  acquisitionDate: string | null;
  acquisitionCostMinor: number | null;
  residualValueMinor: number | null;
  depreciationMethod: DepreciationMethod;
  usefulLifeMonths: number | null;
}>;

export type VehicleProps = VehicleDetails &
  VehicleFinancials &
  Readonly<{
    id: string;
    code: string;
    plateKey: string | null;
    status: VehicleStatus;
    statusChangedAt: Date;
    branchId: string;
    currentOdometer: number | null;
    odometerReadAt: Date | null;
    primaryPhotoFileId: string | null;
    groupIds: readonly string[];
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    deletedReason: string | null;
  }>;

/** What a status change records (vehicle_status_history). */
export type StatusChange = Readonly<{
  from: VehicleStatus | null;
  to: VehicleStatus;
  reason: string | null;
  ref: Readonly<{ type: string; id: string }> | null;
}>;

export const NO_FINANCIALS: VehicleFinancials = Object.freeze({
  acquisitionDate: null,
  acquisitionCostMinor: null,
  residualValueMinor: null,
  depreciationMethod: "none",
  usefulLifeMonths: null,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SPEC_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const MAX_TAGS = 20;
const MAX_SPECS = 30;

/**
 * A vehicle (docs/06): the hub every module reads from and writes to. Its status changes only
 * through `changeStatus`, which applies the lifecycle and returns the history entry to record;
 * users move vehicles by hand only between states no module owns (decision 149).
 */
export class Vehicle {
  private constructor(private props: VehicleProps) {}

  static register(
    params: Readonly<{
      id: string;
      code: string;
      branchId: string;
      status: VehicleStatus;
      details: VehicleDetails;
      financials: VehicleFinancials;
      groupIds: readonly string[];
      createdBy: string | null;
      now: Date;
      currentYear: number;
    }>,
  ): { vehicle: Vehicle; change: StatusChange } {
    if (!INITIAL_STATUSES.includes(params.status))
      throw new VehicleStatusError(
        `A new vehicle starts as ${INITIAL_STATUSES.join(", ")} (not ${params.status})`,
      );
    const details = normaliseDetails(params.details, params.currentYear);
    const vehicle = new Vehicle({
      ...details,
      ...checkFinancials(params.financials),
      plateKey: details.plateNumber === null ? null : PlateNumber.parse(details.plateNumber).key,
      id: params.id,
      code: params.code,
      status: params.status,
      statusChangedAt: params.now,
      branchId: params.branchId,
      currentOdometer: null,
      odometerReadAt: null,
      primaryPhotoFileId: null,
      groupIds: [...new Set(params.groupIds)],
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
      deletedAt: null,
      deletedReason: null,
    });
    return {
      vehicle,
      change: { from: null, to: params.status, reason: "Registered", ref: null },
    };
  }

  static restore(props: VehicleProps): Vehicle {
    return new Vehicle(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): VehicleStatus {
    return this.props.status;
  }

  get branchId(): string {
    return this.props.branchId;
  }

  get deleted(): boolean {
    return this.props.deletedAt !== null;
  }

  snapshot(): VehicleProps {
    return this.props;
  }

  /** Edits the descriptive fields (not status, branch, odometer or financials). */
  updateDetails(changes: Partial<VehicleDetails>, now: Date, currentYear: number): void {
    const details = normaliseDetails({ ...this.props, ...changes }, currentYear);
    this.props = {
      ...this.props,
      ...details,
      plateKey: details.plateNumber === null ? null : PlateNumber.parse(details.plateNumber).key,
      updatedAt: now,
    };
  }

  updateFinancials(financials: VehicleFinancials, now: Date): void {
    this.props = { ...this.props, ...checkFinancials(financials), updatedAt: now };
  }

  setGroups(groupIds: readonly string[], now: Date): void {
    this.props = { ...this.props, groupIds: [...new Set(groupIds)], updatedAt: now };
  }

  moveToBranch(branchId: string, now: Date): void {
    if (MODULE_STATUSES.has(this.props.status))
      throw new VehicleStatusError(
        `A vehicle that is ${label(this.props.status)} stays in its branch until that ends`,
      );
    this.props = { ...this.props, branchId, updatedAt: now };
  }

  /** Where this vehicle may go next; `manual`: by a user's hand. */
  nextStatuses(manual: boolean): VehicleStatus[] {
    return manual ? manualNextStatuses(this.props.status) : nextStatuses(this.props.status);
  }

  /**
   * Moves the vehicle along its lifecycle. A user (`manual`) needs a reason and cannot enter or
   * leave a module's state; a module passes a reference to its record (rental, deal …).
   */
  changeStatus(
    to: VehicleStatus,
    params: Readonly<{
      manual: boolean;
      reason: string | null;
      ref?: Readonly<{ type: string; id: string }> | null;
      now: Date;
    }>,
  ): StatusChange {
    const from = this.props.status;
    if (to === from) throw new VehicleStatusError(`The vehicle is already ${label(to)}`);
    const reason = params.reason?.trim() ?? null;
    const ref = params.ref ?? null;
    if (!this.nextStatuses(params.manual).includes(to)) {
      const owned = params.manual && (MODULE_STATUSES.has(to) || MODULE_STATUSES.has(from));
      throw new VehicleStatusError(
        owned && nextStatuses(from).includes(to)
          ? `A vehicle becomes ${label(to)} through its ${moduleOf(MODULE_STATUSES.has(to) ? to : from)}, not by hand`
          : `A vehicle that is ${label(from)} cannot become ${label(to)}`,
      );
    }
    if (params.manual && (reason === null || reason.length < 3))
      throw new VehicleStatusError("Give a reason for the status change");
    if (!params.manual && MODULE_STATUSES.has(to) && ref === null)
      throw new VehicleStatusError(`Becoming ${label(to)} needs the record that causes it`);
    this.props = { ...this.props, status: to, statusChangedAt: params.now, updatedAt: params.now };
    return { from, to, reason, ref };
  }

  /** Takes a reading as the current odometer when it is the latest one. */
  applyOdometer(value: number, at: Date, now: Date): void {
    if (this.props.odometerReadAt !== null && at < this.props.odometerReadAt) return;
    this.props = { ...this.props, currentOdometer: value, odometerReadAt: at, updatedAt: now };
  }

  setOdometer(value: number | null, at: Date | null, now: Date): void {
    this.props = { ...this.props, currentOdometer: value, odometerReadAt: at, updatedAt: now };
  }

  setPrimaryPhoto(fileId: string | null, now: Date): void {
    this.props = { ...this.props, primaryPhotoFileId: fileId, updatedAt: now };
  }

  /**
   * Removes a mistaken entry: hidden everywhere, kept with the reason. Not while a module holds
   * the vehicle (a rental, an assignment, a deal …).
   */
  remove(reason: string, now: Date): void {
    if (MODULE_STATUSES.has(this.props.status))
      throw new VehicleStatusError(
        `A vehicle that is ${label(this.props.status)} cannot be removed`,
      );
    if (reason.trim().length < 3) throw new VehicleStatusError("Give a reason for removing it");
    this.props = { ...this.props, deletedAt: now, deletedReason: reason.trim(), updatedAt: now };
  }

  /**
   * Book value on `asOf` (straight-line, by whole months since acquisition), in the base
   * currency; null when the vehicle is not depreciated.
   */
  bookValue(asOf: string, currency: string): Money | null {
    const p = this.props;
    if (p.acquisitionCostMinor === null) return null;
    return Money.ofMinor(p.acquisitionCostMinor - accumulatedDepreciation(p, asOf), currency);
  }
}

/** What straight-line depreciation needs to know about a vehicle. */
export type DepreciableAsset = Pick<
  VehicleProps,
  | "acquisitionCostMinor"
  | "residualValueMinor"
  | "depreciationMethod"
  | "acquisitionDate"
  | "usefulLifeMonths"
>;

/**
 * Depreciation charged up to `asOf` (straight-line, by whole months since acquisition), in
 * minor units of the base currency; 0 when the vehicle is not depreciated.
 */
export function accumulatedDepreciation(asset: DepreciableAsset, asOf: string): number {
  if (
    asset.acquisitionCostMinor === null ||
    asset.depreciationMethod === "none" ||
    asset.acquisitionDate === null ||
    asset.usefulLifeMonths === null
  )
    return 0;
  const months = Math.max(
    0,
    Math.min(monthsBetween(asset.acquisitionDate, asOf), asset.usefulLifeMonths),
  );
  const depreciable = BigInt(asset.acquisitionCostMinor - (asset.residualValueMinor ?? 0));
  return Number(divideHalfEven(depreciable * BigInt(months), BigInt(asset.usefulLifeMonths)));
}

/** Depreciation of the days `from`–`to` (both included): the vehicle P&L's cost of ownership. */
export function depreciationBetween(asset: DepreciableAsset, from: string, to: string): number {
  const before = new Date(`${from}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  return (
    accumulatedDepreciation(asset, to) -
    accumulatedDepreciation(asset, before.toISOString().slice(0, 10))
  );
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

const MODULE_OF: Readonly<Partial<Record<VehicleStatus, string>>> = {
  assigned: "driver assignment",
  reserved: "sale",
  sold: "sale",
  reserved_rental: "rental",
  on_rent: "rental",
  on_workpay: "work-and-pay agreement",
  transferred: "work-and-pay agreement",
  repossessed: "work-and-pay agreement",
};
const moduleOf = (status: VehicleStatus) => MODULE_OF[status] ?? "module";
const label = (status: VehicleStatus) => status.replaceAll("_", " ");

function text(value: string | null | undefined, name: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) throw new InvalidVehicleError(`${name} is too long (max ${max})`);
  return trimmed;
}

function integer(value: number | null, name: string, min: number, max: number): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new InvalidVehicleError(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function normaliseDetails(d: VehicleDetails, currentYear: number): VehicleDetails {
  const make = text(d.make, "Make", 80);
  const model = text(d.model, "Model", 80);
  if (make === null || model === null) throw new InvalidVehicleError("Enter the make and model");
  const tags = [...new Set(d.tags.map((t) => t.trim().toLowerCase()).filter((t) => t !== ""))];
  if (tags.length > MAX_TAGS || tags.some((t) => t.length > 40))
    throw new InvalidVehicleError(`At most ${MAX_TAGS} tags of up to 40 characters`);
  const specs = Object.entries(d.specs);
  if (
    specs.length > MAX_SPECS ||
    specs.some(([k, v]) => !SPEC_KEY.test(k) || (typeof v === "string" && v.length > 100))
  )
    throw new InvalidVehicleError("Specs are short named values (e.g. tyre_size: 205/55R16)");
  return {
    ...d,
    plateNumber: d.plateNumber === null ? null : PlateNumber.parse(d.plateNumber).value,
    vin: d.vin === null || d.vin.trim() === "" ? null : parseVin(d.vin),
    engineNumber: text(d.engineNumber, "Engine number", 40)?.toUpperCase() ?? null,
    chassisNumber: text(d.chassisNumber, "Chassis number", 40)?.toUpperCase() ?? null,
    make,
    model,
    trim: text(d.trim, "Trim", 80),
    year: integer(d.year, "Year", 1950, currentYear + 1),
    colour: text(d.colour, "Colour", 40),
    engineCc: integer(d.engineCc, "Engine size", 1, 20_000),
    seats: integer(d.seats, "Seats", 1, 100),
    doors: integer(d.doors, "Doors", 0, 10),
    ownershipNote: text(d.ownershipNote, "Ownership note", 500),
    tags,
    notes: text(d.notes, "Notes", 4_000),
  };
}

function checkFinancials(f: VehicleFinancials): VehicleFinancials {
  if (f.acquisitionDate !== null && !DATE.test(f.acquisitionDate))
    throw new InvalidVehicleError("The acquisition date is YYYY-MM-DD");
  if (
    f.acquisitionCostMinor !== null &&
    f.residualValueMinor !== null &&
    f.residualValueMinor > f.acquisitionCostMinor
  )
    throw new InvalidVehicleError("The residual value cannot exceed the cost");
  integer(f.usefulLifeMonths, "Useful life (months)", 1, 600);
  if (
    f.depreciationMethod !== "none" &&
    (f.acquisitionCostMinor === null || f.acquisitionDate === null || f.usefulLifeMonths === null)
  )
    throw new InvalidVehicleError("Depreciation needs the cost, acquisition date and useful life");
  return f;
}
