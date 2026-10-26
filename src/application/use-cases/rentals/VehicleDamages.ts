import { Money } from "../../../domain/money/Money.js";
import {
  VehicleDamage,
  type DamageArea,
  type DamageLiability,
  type DamageSeverity,
  type DamageStatus,
} from "../../../domain/rentals/VehicleDamage.js";
import type { Principal } from "../../authorization/Principal.js";
import { PermissionDeniedError } from "../../errors/AuthErrors.js";
import { ApplicationError } from "../../errors/ApplicationError.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRentalBookings } from "../../ports/IRentalBookings.js";
import type { IVehicleDamages } from "../../ports/IRentalInspections.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FileService, FileView, UploadStarted } from "../files/FileService.js";
import type { DocumentUploadInput, OwnedDocuments } from "../files/OwnedDocuments.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { damageDescription, damageView, type DamageView } from "./RentalInspections.js";

export class VehicleDamageNotFoundError extends ApplicationError {
  readonly code = "VEHICLE_DAMAGE_NOT_FOUND";
  constructor() {
    super("Damage not found");
  }
}

/** Amounts as clients send them ("250.00"); null clears one. */
type Amount = string | null;

export type DamageInput = Readonly<{
  vehicleId: string;
  area: DamageArea;
  severity: DamageSeverity;
  description: string;
  estimate?: Amount;
  notes?: string | null;
}>;

export type DamageChange = Readonly<{
  severity?: DamageSeverity;
  description?: string;
  liability?: DamageLiability;
  estimate?: Amount;
  finalCost?: Amount;
  workOrderRef?: string | null;
  claimRef?: string | null;
  notes?: string | null;
}>;

export type DamageQuery = Readonly<{
  vehicleId?: string;
  bookingId?: string;
  status?: DamageStatus;
  limit: number;
}>;

type Deps = Readonly<{
  unitOfWork: IUnitOfWork;
  damages: IVehicleDamages;
  bookings: IRentalBookings;
  vehicleAccess: VehicleAccess;
  organisation: IOrganisationSettings;
  files: FileService;
  photos: OwnedDocuments;
  auditTrail: IAuditTrail;
  requestContext: IRequestContext;
  ids: IIdGenerator;
  clock: { now(): Date };
}>;

/**
 * The damage register (docs/07 §6): damages found at rental inspections or reported on their own,
 * on the vehicle's damage map until repaired. Settling one decides who pays; the renter's share —
 * the estimate, then the final cost — is kept in step on their booking as `damage` charges
 * (decisions 346–349). Work orders (P6-2) are referenced for now.
 */
export class VehicleDamages {
  constructor(private readonly deps: Deps) {}

  list(actor: Principal, query: DamageQuery): Promise<DamageView[]> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (query.vehicleId !== undefined)
        await deps.vehicleAccess.reach(actor, query.vehicleId, "vehicles.view");
      const damages = await deps.damages.list({
        branchIds: deps.vehicleAccess.branchesFor(actor, "vehicles.view"),
        ...(query.vehicleId === undefined ? {} : { vehicleId: query.vehicleId }),
        ...(query.bookingId === undefined ? {} : { bookingId: query.bookingId }),
        ...(query.status === undefined ? {} : { statuses: [query.status] }),
        limit: query.limit,
      });
      return damages.map(damageView);
    });
  }

  get(actor: Principal, id: string): Promise<DamageView & { photos: readonly FileView[] }> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const damage = await this.reach(actor, id, "vehicles.view");
      return { ...damageView(damage), photos: await this.photosOf(damage) };
    });
  }

  /** A damage noticed outside a rental (a yard check, a driver's report). */
  record(actor: Principal, input: DamageInput): Promise<DamageView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicleAccess.reach(
        actor,
        input.vehicleId,
        "vehicles.damages.manage",
      );
      const currency = (await deps.organisation.get()).baseCurrency;
      const damage = VehicleDamage.record({
        id: deps.ids.next(),
        vehicleId: vehicle.id,
        branchId: vehicle.branchId,
        booking: null,
        area: input.area,
        severity: input.severity,
        description: input.description,
        currency,
        estimateMinor:
          input.estimate === undefined || input.estimate === null
            ? null
            : Money.parse(input.estimate, currency).amountMinor,
        notes: input.notes ?? null,
        createdBy: actor.userId,
        now: deps.clock.now(),
      });
      await deps.damages.insert(damage);
      await this.audit(actor, "vehicle_damage.recorded", damage, null);
      return damageView(damage);
    });
  }

  /** The estimate, the final cost, who pays; the renter's booking charges follow. */
  settle(actor: Principal, id: string, change: DamageChange): Promise<DamageView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const damage = await this.reach(actor, id, "vehicles.damages.manage", true);
      const before = damage.snapshot();
      const amount = (value: Amount | undefined) =>
        value === undefined
          ? undefined
          : value === null
            ? null
            : Money.parse(value, before.currency).amountMinor;
      damage.settle(
        {
          ...change,
          estimateMinor: amount(change.estimate),
          finalMinor: amount(change.finalCost),
        },
        deps.clock.now(),
      );
      await deps.damages.update(damage);
      await this.syncCharge(actor, damage);
      await this.audit(actor, "vehicle_damage.settled", damage, before);
      return damageView(damage);
    });
  }

  /** Off the damage map; the final cost (from the work order or the garage) may come with it. */
  repaired(
    actor: Principal,
    id: string,
    input: Readonly<{ finalCost?: Amount; workOrderRef?: string | null }>,
  ): Promise<DamageView> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const damage = await this.reach(actor, id, "vehicles.damages.manage", true);
      const before = damage.snapshot();
      damage.repaired(
        {
          ...(input.finalCost === undefined
            ? {}
            : {
                finalMinor:
                  input.finalCost === null
                    ? null
                    : Money.parse(input.finalCost, before.currency).amountMinor,
              }),
          ...(input.workOrderRef === undefined ? {} : { workOrderRef: input.workOrderRef }),
        },
        actor.userId,
        deps.clock.now(),
      );
      await deps.damages.update(damage);
      await this.syncCharge(actor, damage);
      await this.audit(actor, "vehicle_damage.repaired", damage, before);
      return damageView(damage);
    });
  }

  async startPhoto(
    actor: Principal,
    id: string,
    input: DocumentUploadInput,
  ): Promise<UploadStarted> {
    await this.deps.unitOfWork.run(() => this.reach(actor, id, "vehicles.damages.manage"));
    return this.deps.photos.start(id, input, actor.userId);
  }

  /** The photo is on the damage once its upload is confirmed. */
  async completePhoto(actor: Principal, id: string, fileId: string): Promise<FileView> {
    const { deps } = this;
    await deps.unitOfWork.run(() => this.reach(actor, id, "vehicles.damages.manage"));
    const file = await deps.photos.complete(id, fileId);
    await deps.unitOfWork.run(async () => {
      const damage = await this.reach(actor, id, "vehicles.damages.manage", true);
      damage.addPhoto(fileId, deps.clock.now());
      await deps.damages.update(damage);
    });
    return file;
  }

  // --- helpers ---

  /**
   * The renter's booking charges for the damage add up to their share: a charge (or credit) for
   * the difference whenever the share changes.
   */
  private async syncCharge(actor: Principal, damage: VehicleDamage): Promise<void> {
    const { deps } = this;
    const d = damage.snapshot();
    if (d.bookingId === null) return;
    const charged = await deps.damages.charged(d.id);
    const delta = damage.customerShareMinor() - charged.totalMinor;
    if (delta === 0) return;
    const booking = await deps.bookings.lock(d.bookingId);
    if (booking === null) return;
    const eventId = deps.ids.next();
    await deps.bookings.addEvent({
      id: eventId,
      bookingId: d.bookingId,
      type: "damage_charged",
      at: deps.clock.now(),
      actorId: actor.userId,
      data: { damageId: d.id, liability: d.liability, totalMinor: delta },
    });
    await deps.bookings.addCharge({
      id: deps.ids.next(),
      bookingId: d.bookingId,
      eventId,
      kind: "damage",
      description: damageDescription(
        damage,
        damage.customerShareMinor() === 0
          ? "withdrawn"
          : d.finalMinor === null
            ? "estimate"
            : "final",
      ),
      damageId: d.id,
      netMinor: delta,
      taxMinor: 0,
      totalMinor: delta,
      createdBy: actor.userId,
      createdAt: deps.clock.now(),
    });
  }

  /** Its photos: taken at the inspection (the booking's) or uploaded to the damage. */
  private photosOf(damage: VehicleDamage): Promise<FileView[]> {
    return Promise.all(damage.snapshot().photoIds.map((id) => this.deps.files.get(id)));
  }

  private async reach(
    actor: Principal,
    id: string,
    permission: "vehicles.view" | "vehicles.damages.manage",
    lock = false,
  ): Promise<VehicleDamage> {
    const { deps } = this;
    const damage = lock ? await deps.damages.lock(id) : await deps.damages.get(id);
    if (
      damage === null ||
      !deps.vehicleAccess.can(actor, "vehicles.view", damage.snapshot().branchId)
    )
      throw new VehicleDamageNotFoundError();
    if (!deps.vehicleAccess.can(actor, permission, damage.snapshot().branchId))
      throw new PermissionDeniedError(permission);
    return damage;
  }

  private async audit(
    actor: Principal,
    action: string,
    damage: VehicleDamage,
    before: ReturnType<VehicleDamage["snapshot"]> | null,
  ): Promise<void> {
    const view = (d: ReturnType<VehicleDamage["snapshot"]>) => ({
      vehicleId: d.vehicleId,
      bookingId: d.bookingId,
      area: d.area,
      severity: d.severity,
      status: d.status,
      liability: d.liability,
      estimateMinor: d.estimateMinor,
      finalMinor: d.finalMinor,
      workOrderRef: d.workOrderRef,
      claimRef: d.claimRef,
    });
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "vehicle_damage",
      entityId: damage.id,
      before: before === null ? null : view(before),
      after: view(damage.snapshot()),
    });
  }
}
