import { RentalInspectionError, type InspectionStage } from "./RentalInspection.js";

export const DAMAGE_AREAS = [
  "front",
  "back",
  "left",
  "right",
  "roof",
  "interior",
  "windscreen",
  "wheels",
  "underbody",
  "other",
] as const;
export type DamageArea = (typeof DAMAGE_AREAS)[number];

export const DAMAGE_SEVERITIES = ["minor", "moderate", "major"] as const;
export type DamageSeverity = (typeof DAMAGE_SEVERITIES)[number];

export const DAMAGE_STATUSES = ["open", "repaired"] as const;
export type DamageStatus = (typeof DAMAGE_STATUSES)[number];

/** Who pays: still to be decided, the renter, the insurer (a claim) or the business itself. */
export const DAMAGE_LIABILITIES = ["undecided", "customer", "insurance", "business"] as const;
export type DamageLiability = (typeof DAMAGE_LIABILITIES)[number];

export type VehicleDamageProps = Readonly<{
  id: string;
  vehicleId: string;
  branchId: string;
  bookingId: string | null;
  inspectionId: string | null;
  /** At which inspection of the booking it was found (null: recorded outside a rental). */
  foundAt: InspectionStage | null;
  area: DamageArea;
  severity: DamageSeverity;
  description: string;
  status: DamageStatus;
  liability: DamageLiability;
  currency: string;
  estimateMinor: number | null;
  finalMinor: number | null;
  workOrderRef: string | null;
  claimRef: string | null;
  notes: string | null;
  photoIds: readonly string[];
  repairedAt: Date | null;
  repairedBy: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type DamageSettlement = Partial<
  Pick<
    VehicleDamageProps,
    | "severity"
    | "description"
    | "liability"
    | "estimateMinor"
    | "finalMinor"
    | "workOrderRef"
    | "claimRef"
    | "notes"
  >
>;

const amount = (value: number | null, what: string) => {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0))
    throw new RentalInspectionError(`${what} is zero or more`);
};

const ref = (value: string | null, what: string): string | null => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > 60) throw new RentalInspectionError(`${what} is up to 60 characters`);
  return trimmed === "" ? null : trimmed;
};

/**
 * A damage on a vehicle (docs/07 §6): on the damage map until repaired. One found when a rental
 * comes back may be the renter's to pay: the estimate first, the final cost once repaired; one
 * found at check-out was there before the renter had the vehicle.
 */
export class VehicleDamage {
  private constructor(private props: VehicleDamageProps) {}

  static record(params: {
    id: string;
    vehicleId: string;
    branchId: string;
    booking: Readonly<{ id: string; inspectionId: string; stage: InspectionStage }> | null;
    area: DamageArea;
    severity: DamageSeverity;
    description: string;
    currency: string;
    estimateMinor?: number | null;
    chargeCustomer?: boolean;
    photoIds?: readonly string[];
    notes?: string | null;
    createdBy: string | null;
    now: Date;
  }): VehicleDamage {
    if (params.chargeCustomer === true && params.booking?.stage !== "check_in")
      throw new RentalInspectionError(
        "Only a damage found when the vehicle comes back is charged to the renter",
      );
    const damage = new VehicleDamage({
      id: params.id,
      vehicleId: params.vehicleId,
      branchId: params.branchId,
      bookingId: params.booking?.id ?? null,
      inspectionId: params.booking?.inspectionId ?? null,
      foundAt: params.booking?.stage ?? null,
      area: params.area,
      severity: params.severity,
      description: params.description,
      status: "open",
      // Found at check-out: there before this renter.
      liability:
        params.chargeCustomer === true
          ? "customer"
          : params.booking?.stage === "check_out"
            ? "business"
            : "undecided",
      currency: params.currency,
      estimateMinor: params.estimateMinor ?? null,
      finalMinor: null,
      workOrderRef: null,
      claimRef: null,
      notes: params.notes ?? null,
      photoIds: [...new Set(params.photoIds ?? [])],
      repairedAt: null,
      repairedBy: null,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
    });
    damage.check();
    if (damage.props.photoIds.length > 10)
      throw new RentalInspectionError("At most 10 photos of a damage");
    return damage;
  }

  static restore(props: VehicleDamageProps): VehicleDamage {
    return new VehicleDamage(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): VehicleDamageProps {
    return this.props;
  }

  /** The estimate, the final cost, who pays, references. */
  settle(change: DamageSettlement, now: Date): void {
    const next = { ...this.props, ...dropUndefined(change), updatedAt: now };
    if (next.liability === "customer" && next.foundAt !== "check_in")
      throw new RentalInspectionError(
        next.bookingId === null
          ? "A damage recorded outside a rental is not charged to a renter"
          : "Only a damage found when the vehicle comes back is charged to the renter",
      );
    this.props = {
      ...next,
      workOrderRef: ref(next.workOrderRef, "The work order reference"),
      claimRef: ref(next.claimRef, "The claim number"),
    };
    this.check();
  }

  repaired(
    params: Readonly<{ finalMinor?: number | null; workOrderRef?: string | null }>,
    by: string | null,
    now: Date,
  ): void {
    if (this.props.status === "repaired")
      throw new RentalInspectionError("The damage is repaired already");
    this.settle(
      {
        ...(params.finalMinor === undefined ? {} : { finalMinor: params.finalMinor }),
        ...(params.workOrderRef === undefined ? {} : { workOrderRef: params.workOrderRef }),
      },
      now,
    );
    this.props = { ...this.props, status: "repaired", repairedAt: now, repairedBy: by };
  }

  addPhoto(fileId: string, now: Date): void {
    if (this.props.photoIds.includes(fileId)) return;
    if (this.props.photoIds.length >= 10)
      throw new RentalInspectionError("At most 10 photos of a damage");
    this.props = { ...this.props, photoIds: [...this.props.photoIds, fileId], updatedAt: now };
  }

  /** What the renter owes for it: the final cost once known, else the estimate. */
  customerShareMinor(): number {
    if (this.props.liability !== "customer") return 0;
    return this.props.finalMinor ?? this.props.estimateMinor ?? 0;
  }

  private check(): void {
    const p = this.props;
    const description = p.description.trim();
    if (description.length < 3 || description.length > 1_000)
      throw new RentalInspectionError("Describe the damage (3 to 1,000 characters)");
    amount(p.estimateMinor, "The estimate");
    amount(p.finalMinor, "The final cost");
    const notes = p.notes?.trim() ?? "";
    if (notes.length > 2_000) throw new RentalInspectionError("Keep notes under 2000 characters");
    this.props = { ...p, description, notes: notes === "" ? null : notes };
  }
}

function dropUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
