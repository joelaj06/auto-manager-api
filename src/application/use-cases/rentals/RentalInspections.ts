import type { FuelLevel } from "../../../domain/assignments/VehicleAssignment.js";
import { Money } from "../../../domain/money/Money.js";
import type {
  ChargeAmount,
  ChargeKind,
  RentalBooking,
} from "../../../domain/rentals/RentalBooking.js";
import {
  differences,
  inspect,
  quartersMissing,
  RentalInspectionError,
  type ChecklistAnswer,
  type InspectionDifferences,
  type InspectionPhoto,
  type InspectionStage,
  type RentalInspection,
} from "../../../domain/rentals/RentalInspection.js";
import {
  VehicleDamage,
  type DamageArea,
  type DamageSeverity,
  type VehicleDamageProps,
} from "../../../domain/rentals/VehicleDamage.js";
import type { AuthorizationPolicy } from "../../authorization/AuthorizationPolicy.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IRentalBookings } from "../../ports/IRentalBookings.js";
import type { IRentalInspections, IVehicleDamages } from "../../ports/IRentalInspections.js";
import type { IRentalRates } from "../../ports/IRentalRates.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import {
  FileNotFoundError,
  type FileService,
  type FileView,
  type UploadStarted,
} from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { RentalBookingNotFoundError } from "./RentalBookings.js";
import type { RentalQuotes } from "./RentalQuotes.js";

export const BOOKING_PHOTO_OWNER = "rental_booking";

export type DamageReport = Readonly<{
  area: DamageArea;
  severity: DamageSeverity;
  description: string;
  /** Photos uploaded to the booking. */
  photoIds?: readonly string[];
  /** The repair estimate as clients send amounts ("850.00"). */
  estimate?: string | null;
  /** The renter pays (check-in only): the estimate is charged now, the final cost later. */
  chargeCustomer?: boolean;
}>;

/** What an agent records at the counter besides the odometer and fuel (docs/07 §6). */
export type InspectionInput = Readonly<{
  checklist?: readonly ChecklistAnswer[];
  photos?: readonly InspectionPhoto[];
  damages?: readonly DamageReport[];
  /** Check-out: the renter's ID and licence were seen. */
  idChecked?: boolean;
  /** Check-in: the vehicle needs cleaning (the cleaning fee). */
  needsCleaning?: boolean;
  /** Check-in: no refuelling charge (rentals.price.override). */
  waiveRefuel?: boolean;
}>;

export type PendingCharge = Readonly<{
  kind: ChargeKind;
  description: string;
  amount: ChargeAmount;
  damageId: string | null;
}>;

export type Inspected = Readonly<{
  inspection: RentalInspection;
  damages: readonly VehicleDamage[];
  charges: readonly PendingCharge[];
}>;

export type DamageView = Omit<VehicleDamageProps, "estimateMinor" | "finalMinor"> &
  Readonly<{ estimate: Money | null; finalCost: Money | null }>;

export type InspectionsView = Readonly<{
  bookingId: string;
  checkOut: RentalInspection | null;
  checkIn: RentalInspection | null;
  /** Check-in against check-out, once both exist. */
  differences: InspectionDifferences | null;
  /** Damages found at this booking's inspections. */
  damages: readonly DamageView[];
  /** The vehicle's damage map: damages not yet repaired. */
  openDamages: readonly DamageView[];
  /** The booking's photos with their (short-lived) links. */
  photos: readonly FileView[];
}>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  bookings: IRentalBookings;
  inspections: IRentalInspections;
  damages: IVehicleDamages;
  rates: IRentalRates;
  quotes: RentalQuotes;
  files: FileService;
  photos: OwnedDocuments;
  vehicleAccess: VehicleAccess;
  policy: AuthorizationPolicy;
  ids: IIdGenerator;
  clock: { now(): Date };
}>;

/**
 * Check-out and check-in inspections (docs/07 §6): photos uploaded to the booking, then recorded
 * with the checklist and the damages found when the keys go out or come back; a return adds the
 * refuelling, cleaning and damage charges (decisions 342–351). The booking lifecycle
 * (RentalBookings) records an inspection as part of its check-out and check-in.
 */
export class RentalInspections {
  constructor(private readonly deps: Deps) {}

  // --- photos ---

  /** An upload URL for a photo of the booking's vehicle (taken before the step is recorded). */
  async startPhoto(
    actor: Principal,
    bookingId: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    await this.deps.unitOfWork.run(() => this.reachForPhotos(actor, bookingId));
    return this.deps.photos.start(bookingId, input, actor.userId);
  }

  async completePhoto(actor: Principal, bookingId: string, fileId: string): Promise<FileView> {
    await this.deps.unitOfWork.run(() => this.reachForPhotos(actor, bookingId));
    return this.deps.photos.complete(bookingId, fileId);
  }

  // --- reading ---

  /** Both inspections, what changed between them, the damages and the vehicle's damage map. */
  view(actor: Principal, bookingId: string): Promise<InspectionsView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const booking = await this.reach(actor, bookingId, "rentals.view");
      const b = booking.snapshot();
      const inspections = await deps.inspections.ofBooking(b.id);
      const checkOut = inspections.find((i) => i.stage === "check_out") ?? null;
      const checkIn = inspections.find((i) => i.stage === "check_in") ?? null;
      const damages = await deps.damages.list({ branchIds: "all", bookingId: b.id, limit: 100 });
      const open = await deps.damages.list({
        branchIds: "all",
        vehicleId: b.vehicleId,
        statuses: ["open"],
        limit: 100,
      });
      return {
        bookingId: b.id,
        checkOut,
        checkIn,
        differences: checkOut !== null && checkIn !== null ? differences(checkOut, checkIn) : null,
        damages: damages.map(damageView),
        openDamages: open.map(damageView),
        photos: await deps.photos.list(b.id),
      };
    });
  }

  // --- recording (inside the booking's unit of work) ---

  /**
   * Records the inspection of a check-out or check-in with its damages; a check-in also prices
   * what the return adds. The booking is the one being checked out or in (not yet changed).
   */
  async record(
    actor: Principal,
    booking: RentalBooking,
    stage: InspectionStage,
    reading: Readonly<{ vehicleId: string; odometer: number; fuel: FuelLevel; at: Date }>,
    input: InspectionInput,
    notes: string | null,
  ): Promise<Inspected> {
    const { deps } = this;
    const b = booking.snapshot();
    const settings = await deps.rates.settings();
    const now = deps.clock.now();
    const reports = input.damages ?? [];
    if (reports.length > 20) throw new RentalInspectionError("At most 20 damages at a time");
    if (stage === "check_out" && (input.needsCleaning === true || input.waiveRefuel === true))
      throw new RentalInspectionError("Cleaning and refuelling are settled at check-in");
    await this.assertPhotos(b.id, [
      ...(input.photos ?? []).map((p) => p.fileId),
      ...reports.flatMap((d) => d.photoIds ?? []),
    ]);

    const inspection = inspect({
      id: deps.ids.next(),
      bookingId: b.id,
      stage,
      vehicleId: reading.vehicleId,
      odometer: reading.odometer,
      fuel: reading.fuel,
      items: settings.inspectionItems,
      answers: input.checklist ?? [],
      requiredViews: settings.inspectionPhotoViews,
      photos: input.photos ?? [],
      idChecked: input.idChecked ?? false,
      notes,
      inspectedBy: actor.userId,
      inspectedAt: reading.at,
    });
    await deps.inspections.insert(inspection);
    const damages: VehicleDamage[] = [];
    for (const report of reports) {
      const damage = VehicleDamage.record({
        id: deps.ids.next(),
        vehicleId: reading.vehicleId,
        branchId: b.branchId,
        booking: { id: b.id, inspectionId: inspection.id, stage },
        area: report.area,
        severity: report.severity,
        description: report.description,
        currency: b.currency,
        estimateMinor:
          report.estimate === undefined || report.estimate === null
            ? null
            : Money.parse(report.estimate, b.currency).amountMinor,
        chargeCustomer: report.chargeCustomer ?? false,
        photoIds: report.photoIds ?? [],
        createdBy: actor.userId,
        now,
      });
      await deps.damages.insert(damage);
      damages.push(damage);
    }
    if (stage === "check_out") return { inspection, damages, charges: [] };

    // What the return adds (docs/07 §6): refuelling, cleaning, the renter's damages.
    const charges: PendingCharge[] = [];
    const money = (minor: number) => Money.ofMinor(minor, b.currency);
    const missing = b.fuelOut === null ? 0 : quartersMissing(b.fuelOut, reading.fuel);
    const vehicleClass = b.classId === null ? null : await deps.rates.vehicleClass(b.classId);
    const perQuarter = vehicleClass?.refuelQuarterMinor ?? null;
    if (input.waiveRefuel === true) this.requireOverride(actor, b.branchId);
    if (missing > 0 && perQuarter !== null && input.waiveRefuel !== true)
      charges.push({
        kind: "fuel_refill",
        description: `Refuelling: ${missing} quarter tank${missing === 1 ? "" : "s"} (${b.fuelOut!.replaceAll("_", " ")} out, ${reading.fuel.replaceAll("_", " ")} in)`,
        amount: await deps.quotes.taxedLikeRental(b.terms, reading.at, money(perQuarter * missing)),
        damageId: null,
      });
    const cleaning = Money.parse(settings.cleaningFee, b.currency);
    if (input.needsCleaning === true && !cleaning.isZero())
      charges.push({
        kind: "cleaning",
        description: "Cleaning fee",
        amount: await deps.quotes.taxedLikeRental(b.terms, reading.at, cleaning),
        damageId: null,
      });
    for (const damage of damages) {
      const share = damage.customerShareMinor();
      if (share > 0)
        charges.push({
          kind: "damage",
          description: damageDescription(damage, "estimate"),
          amount: { netMinor: share, taxMinor: 0, totalMinor: share },
          damageId: damage.id,
        });
    }
    return { inspection, damages, charges };
  }

  // --- helpers ---

  /** Every photo a finished upload of this booking, not used by another inspection or damage. */
  private async assertPhotos(bookingId: string, fileIds: readonly string[]): Promise<void> {
    const { deps } = this;
    for (const fileId of new Set(fileIds)) {
      const file = await deps.files.load(fileId).catch((error: unknown) => {
        if (error instanceof FileNotFoundError) return null;
        throw error;
      });
      if (
        file === null ||
        file.kind !== "rental_photo" ||
        file.status !== "ready" ||
        !file.belongsTo({ type: BOOKING_PHOTO_OWNER, id: bookingId })
      )
        throw new RentalInspectionError(
          "Every photo must be a finished upload of this booking (upload it, then confirm it)",
        );
    }
    if ((await deps.inspections.usedFiles([...new Set(fileIds)])).length > 0)
      throw new RentalInspectionError("A photo is already part of an inspection or a damage");
  }

  private requireOverride(actor: Principal, branchId: string): void {
    if (!this.deps.policy.decide(actor, "rentals.price.override", { branchId }).allowed)
      throw new PermissionDeniedError("rentals.price.override");
  }

  /** Photos are taken for the next step: check-out before it, check-in until it is recorded. */
  private async reachForPhotos(actor: Principal, bookingId: string): Promise<void> {
    const booking = await this.reach(actor, bookingId, "rentals.view");
    const { status, branchId } = booking.snapshot();
    const permission: PermissionKey | null =
      status === "reserved" || status === "confirmed"
        ? "rentals.checkout"
        : status === "checked_out"
          ? "rentals.checkin"
          : null;
    if (permission === null)
      throw new RentalInspectionError(
        `A booking that is ${status.replaceAll("_", " ")} takes no more inspection photos`,
      );
    this.deps.policy.require(actor, permission, { branchId });
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey,
  ): Promise<RentalBooking> {
    const { deps } = this;
    const booking = await deps.bookings.get(id);
    if (
      booking === null ||
      !deps.vehicleAccess.can(actor, "rentals.view", booking.snapshot().branchId)
    )
      throw new RentalBookingNotFoundError();
    deps.policy.require(actor, permission, { branchId: booking.snapshot().branchId });
    return booking;
  }
}

export function damageView(damage: VehicleDamage): DamageView {
  const { estimateMinor, finalMinor, ...rest } = damage.snapshot();
  const money = (minor: number | null) =>
    minor === null ? null : Money.ofMinor(minor, rest.currency);
  return { ...rest, estimate: money(estimateMinor), finalCost: money(finalMinor) };
}

export function damageDescription(
  damage: VehicleDamage,
  basis: "estimate" | "final" | "withdrawn",
): string {
  const d = damage.snapshot();
  const what = `${d.severity[0]!.toUpperCase()}${d.severity.slice(1)} damage, ${d.area}`;
  return basis === "withdrawn"
    ? `${what}: no longer charged`
    : `${what} (${basis === "estimate" ? "estimate" : "final cost"})`;
}
