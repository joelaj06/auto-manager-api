import type { Money } from "../../../domain/money/Money.js";
import {
  chooseVehicle,
  dailyCapacity,
  isFree,
  planMoves,
  type Candidate,
  type DayCapacity,
} from "../../../domain/rentals/Availability.js";
import { RentalPricingError, type RentalTier } from "../../../domain/rentals/RentalPricing.js";
import {
  assertWindow,
  blockedUntil,
  busyOf,
  holdExpiry,
  RENTABLE_STATUSES,
  VehicleBlockError,
  type BlockReason,
  type BlockStatus,
  type BusyInterval,
  type VehicleBlock,
} from "../../../domain/rentals/VehicleBlock.js";
import type { PermissionKey } from "../../authorization/permissionCatalog.js";
import type { Principal } from "../../authorization/Principal.js";
import { VehicleBlockNotFoundError, VehicleUnavailableError } from "../../errors/RentalErrors.js";
import type { IAuditTrail } from "../../ports/IAuditTrail.js";
import type { IPartyDirectory } from "../../ports/IFinanceRecords.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IRentalRates } from "../../ports/IRentalRates.js";
import type { IRequestContext } from "../../ports/IRequestContext.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";
import type { FleetVehicle, IVehicleBlocks } from "../../ports/IVehicleBlocks.js";
import { TenantCalendar } from "../../services/TenantCalendar.js";
import { localMidnight } from "../../services/TenantLocalTime.js";
import { recordUserAction } from "../reference/userAudit.js";
import type { VehicleAccess } from "../vehicles/VehicleAccess.js";
import { RentalRateNotFoundError } from "./RentalRateAdministration.js";
import type { RentalQuotes } from "./RentalQuotes.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** How far around a booking best fit looks for the bookings next to it. */
const FIT_HORIZON = 31 * DAY;
/** The longest calendar one request returns. */
export const MAX_CALENDAR_DAYS = 62;
/** A hold lasts this long unless the agent says otherwise. */
export const DEFAULT_HOLD_MINUTES = 60;

export type AvailabilityRequest = Readonly<{
  from: Date;
  to: Date;
  branchId?: string | null;
  classId?: string | null;
  /** Prices with the customer's negotiated rates. */
  customerId?: string | null;
}>;

type VehicleSummary = Pick<FleetVehicle, "id" | "code" | "plateNumber" | "make" | "model">;

export type ClassAvailability = Readonly<{
  classId: string;
  code: string;
  name: string;
  /** Vehicles of the class at the branch offered for rent. */
  vehicles: number;
  free: readonly VehicleSummary[];
  price: Readonly<{
    plan: Readonly<{ id: string; code: string; name: string }>;
    tier: RentalTier;
    days: number;
    hours: number;
    total: Money;
  }> | null;
  /** Why there is no price (no plan for these dates …). */
  priceNote: string | null;
}>;

export type CalendarRequest = Readonly<{
  /** Local dates, both included. */
  from: string;
  to: string;
  branchId?: string | null;
  classId?: string | null;
}>;

export type CalendarBar = Pick<
  VehicleBlock,
  | "id"
  | "reason"
  | "status"
  | "startsAt"
  | "endsAt"
  | "blockedUntil"
  | "expiresAt"
  | "classId"
  | "customerId"
  | "refType"
  | "refId"
  | "note"
>;

export type RentalCalendar = Readonly<{
  from: string;
  to: string;
  timezone: string;
  vehicles: readonly (VehicleSummary &
    Readonly<{
      branchId: string;
      classId: string | null;
      status: FleetVehicle["status"];
      rentable: boolean;
      blocks: readonly CalendarBar[];
    }>)[];
  classes: readonly Readonly<{
    classId: string;
    code: string;
    name: string;
    days: readonly DayCapacity[];
  }>[];
}>;

export type HoldRequest = Readonly<{
  /** Book a class (a vehicle is allocated), or hold one vehicle. */
  classId?: string | null;
  vehicleId?: string | null;
  branchId?: string | null;
  pickupAt: Date;
  returnAt: Date;
  holdMinutes?: number;
  customerId?: string | null;
  note?: string | null;
}>;

export type ManualBlockRequest = Readonly<{
  vehicleId: string;
  reason: Exclude<BlockReason, "rental">;
  startsAt: Date;
  /** Null: until further notice. */
  endsAt: Date | null;
  note?: string | null;
  /** Move class bookings in the way to other vehicles of their class. */
  displace?: boolean;
}>;

export type BlockChange = Readonly<{
  startsAt?: Date;
  endsAt?: Date | null;
  note?: string | null;
}>;

/** What the booking lifecycle (P5-3) asks the engine for. */
export type PlacementSpec = Readonly<{
  vehicleId?: string | null;
  classId?: string | null;
  branchId: string;
  reason: BlockReason;
  status: Exclude<BlockStatus, "released">;
  startsAt: Date;
  endsAt: Date | null;
  expiresAt?: Date | null;
  customerId?: string | null;
  refType?: string | null;
  refId?: string | null;
  note?: string | null;
}>;

export type Moved = Readonly<{ blockId: string; fromVehicleId: string; toVehicleId: string }>;

/**
 * The availability engine (docs/07 §3, docs/22 §4). Every busy time of a vehicle is a block; the
 * database refuses two live blocks of a vehicle that overlap, so a double booking cannot be
 * written whoever writes it. The engine also locks the vehicles it books, re-reads their blocks
 * and releases lapsed holds first, so callers get a clear refusal rather than a constraint error.
 * A class booking gets the best-fit vehicle of the class at the branch straight away and may be
 * moved within the class until check-out (decisions 324–331).
 */
export class RentalAvailability {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      blocks: IVehicleBlocks;
      rates: IRentalRates;
      vehicleAccess: VehicleAccess;
      parties: IPartyDirectory;
      organisation: IOrganisationSettings;
      quotes: RentalQuotes;
      auditTrail: IAuditTrail;
      requestContext: IRequestContext;
      ids: IIdGenerator;
      clock: { now(): Date };
    }>,
  ) {}

  // --- reading ---

  /** Classes with free vehicles at a branch for the times, and what each would cost. */
  async search(actor: Principal, request: AvailabilityRequest): Promise<ClassAvailability[]> {
    const { deps } = this;
    assertWindow("rental", request.from, request.to);
    const found = await deps.unitOfWork.run(async () => {
      const branchId = await this.branchFor(actor, "rentals.view", request.branchId);
      const classes = (await deps.rates.classes()).filter(
        (c) => c.active && (!given(request.classId) || c.id === request.classId),
      );
      if (given(request.classId) && classes.length === 0)
        throw new RentalRateNotFoundError("Class");
      const fleet = await deps.blocks.fleet({
        branchIds: [branchId],
        classId: request.classId ?? null,
        rentableOnly: true,
      });
      const longest = Math.max(0, ...fleet.map((v) => v.turnaroundMinutes));
      const busy = await this.busyByVehicle(fleet, {
        from: request.from,
        until: new Date(request.to.getTime() + longest * MINUTE),
      });
      return {
        branchId,
        classes: classes.map((c) => {
          const members = fleet.filter((v) => v.classId === c.id);
          const free = members.filter((v) =>
            isFree(
              (busy.get(v.id) ?? []).map(busyOf),
              this.windowFor(v, "rental", request.from, request.to),
            ),
          );
          return { vehicleClass: c, vehicles: members.length, free: free.map(summary) };
        }),
      };
    });

    return Promise.all(
      found.classes.map(async ({ vehicleClass, vehicles, free }): Promise<ClassAvailability> => {
        let price: ClassAvailability["price"] = null;
        let priceNote: string | null = null;
        try {
          const quote = await deps.quotes.quote(actor, {
            pickupAt: request.from,
            returnAt: request.to,
            classId: vehicleClass.id,
            branchId: found.branchId,
            customerId: request.customerId ?? null,
          });
          price = {
            plan: quote.plan,
            tier: quote.tier,
            days: quote.days,
            hours: quote.hours,
            total: quote.totals.total,
          };
        } catch (error) {
          if (!(error instanceof RentalPricingError)) throw error;
          priceNote = error.message;
        }
        return {
          classId: vehicleClass.id,
          code: vehicleClass.code,
          name: vehicleClass.name,
          vehicles,
          free,
          price,
          priceNote,
        };
      }),
    );
  }

  /** Vehicle rows with their blocks, and free vehicles per class per local day (Gantt data). */
  calendar(actor: Principal, request: CalendarRequest): Promise<RentalCalendar> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      if (request.to < request.from) throw new VehicleBlockError("The end is after the start");
      const dates: string[] = [];
      for (let d = request.from; d <= request.to; d = TenantCalendar.addDays(d, 1)) {
        dates.push(d);
        if (dates.length > MAX_CALENDAR_DAYS)
          throw new VehicleBlockError(`The calendar shows up to ${MAX_CALENDAR_DAYS} days`);
      }
      const { timezone } = await deps.organisation.get();
      const branchIds = !given(request.branchId)
        ? deps.vehicleAccess.branchesFor(actor, "rentals.view")
        : [(await deps.vehicleAccess.branch(actor, "rentals.view", request.branchId)).id];
      const days = dates.map((date) => ({
        date,
        from: localMidnight(date, timezone),
        until: localMidnight(TenantCalendar.addDays(date, 1), timezone),
      }));
      const window = { from: days[0]!.from, until: days.at(-1)!.until };
      const now = deps.clock.now();
      const fleet = await deps.blocks.fleet({
        branchIds,
        classId: request.classId ?? null,
        rentableOnly: false,
      });
      const blocks = await deps.blocks.busy(
        fleet.map((v) => v.id),
        window,
        now,
      );
      const byVehicle = group(blocks);
      const classes = (await deps.rates.classes()).filter((c) =>
        fleet.some((v) => v.classId === c.id),
      );
      return {
        from: request.from,
        to: request.to,
        timezone,
        vehicles: fleet.map((v) => ({
          ...summary(v),
          branchId: v.branchId,
          classId: v.classId,
          status: v.status,
          rentable: RENTABLE_STATUSES.has(v.status),
          blocks: (byVehicle.get(v.id) ?? []).map(bar),
        })),
        classes: classes.map((c) => ({
          classId: c.id,
          code: c.code,
          name: c.name,
          days: dailyCapacity(
            fleet
              .filter((v) => v.classId === c.id && RENTABLE_STATUSES.has(v.status))
              .map((v) => candidate(v, byVehicle.get(v.id) ?? [])),
            days,
          ),
        })),
      };
    });
  }

  async get(actor: Principal, id: string): Promise<VehicleBlock> {
    return this.deps.unitOfWork.run(() => this.reach(actor, id, "rentals.view"));
  }

  // --- holds ---

  /** Holds a vehicle, or the best-fit vehicle of a class, for a customer until the hold lapses. */
  hold(actor: Principal, request: HoldRequest): Promise<VehicleBlock> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      assertWindow("rental", request.pickupAt, request.returnAt);
      if (request.returnAt <= now) throw new VehicleBlockError("The rental is over already");
      let branchId: string;
      if (given(request.vehicleId)) {
        const vehicle = await deps.vehicleAccess.reach(actor, request.vehicleId, "rentals.create");
        branchId = vehicle.branchId;
      } else {
        if (!given(request.classId)) throw new VehicleBlockError("Choose a class or a vehicle");
        branchId = await this.branchFor(actor, "rentals.create", request.branchId);
      }
      if (
        given(request.customerId) &&
        (await deps.parties.find("customer", request.customerId)) === null
      )
        throw new RentalRateNotFoundError("Customer");
      const block = await this.place(
        {
          vehicleId: request.vehicleId ?? null,
          classId: !given(request.vehicleId) ? (request.classId ?? null) : null,
          branchId,
          reason: "rental",
          status: "hold",
          startsAt: request.pickupAt,
          endsAt: request.returnAt,
          expiresAt: holdExpiry(now, request.holdMinutes ?? DEFAULT_HOLD_MINUTES),
          customerId: request.customerId ?? null,
          note: request.note ?? null,
        },
        actor.userId,
      );
      await this.audit(actor, "rental.hold_placed", block, null);
      return block;
    });
  }

  /**
   * Books the vehicle, or the best-fit vehicle of the class at the branch (inside the caller's
   * unit of work). VehicleUnavailableError when it, or every vehicle of the class, is busy.
   */
  async place(spec: PlacementSpec, actorId: string | null): Promise<VehicleBlock> {
    const { deps } = this;
    assertWindow(spec.reason, spec.startsAt, spec.endsAt);
    const now = deps.clock.now();
    let vehicle: FleetVehicle;
    let classId: string | null = null;
    if (given(spec.vehicleId)) {
      const found = await deps.blocks.vehicle(spec.vehicleId);
      if (found === null) throw new VehicleBlockNotFoundError();
      if (spec.reason === "rental" && !RENTABLE_STATUSES.has(found.status))
        throw new VehicleUnavailableError(
          `${found.code} is not offered for rent (${found.status})`,
        );
      await deps.blocks.lock([found.id]);
      await deps.blocks.releaseLapsed([found.id], now);
      const window = this.windowFor(found, spec.reason, spec.startsAt, spec.endsAt);
      const [conflict] = await deps.blocks.busy([found.id], window, now);
      if (conflict !== undefined) throw new VehicleUnavailableError(describe(found, conflict));
      vehicle = found;
    } else {
      if (!given(spec.classId)) throw new VehicleBlockError("Choose a class or a vehicle");
      const vehicleClass = await deps.rates.vehicleClass(spec.classId);
      if (vehicleClass === null) throw new RentalRateNotFoundError("Class");
      if (!vehicleClass.active)
        throw new VehicleBlockError(`${vehicleClass.name} is not rented any more`);
      const fleet = await deps.blocks.fleet({
        branchIds: [spec.branchId],
        classId: vehicleClass.id,
        rentableOnly: true,
      });
      const ids = fleet.map((v) => v.id);
      await deps.blocks.lock(ids);
      await deps.blocks.releaseLapsed(ids, now);
      const window = this.windowFor(fleet[0], spec.reason, spec.startsAt, spec.endsAt);
      const busy = await this.busyByVehicle(fleet, around(window));
      const chosen = chooseVehicle(
        fleet.map((v) => candidate(v, busy.get(v.id) ?? [])),
        window,
      );
      const found = fleet.find((v) => v.id === chosen);
      if (found === undefined)
        throw new VehicleUnavailableError(
          `No ${vehicleClass.name} is free at the branch for these times`,
        );
      vehicle = found;
      classId = vehicleClass.id;
    }
    const block: VehicleBlock = {
      id: deps.ids.next(),
      vehicleId: vehicle.id,
      branchId: spec.branchId,
      classId,
      reason: spec.reason,
      status: spec.status,
      startsAt: spec.startsAt,
      endsAt: spec.endsAt,
      blockedUntil: blockedUntil(spec.reason, spec.endsAt, vehicle.turnaroundMinutes),
      expiresAt: spec.expiresAt ?? null,
      customerId: spec.customerId ?? null,
      refType: spec.refType ?? null,
      refId: spec.refId ?? null,
      note: spec.note?.trim() || null,
      releasedAt: null,
      releasedReason: null,
      releasedBy: null,
      createdBy: actorId,
      createdAt: now,
    };
    await deps.blocks.save(block);
    return block;
  }

  // --- manual blocks ---

  /** Takes a vehicle out of rental for maintenance, a transfer, a sale hold … */
  block(
    actor: Principal,
    request: ManualBlockRequest,
  ): Promise<Readonly<{ block: VehicleBlock; moved: readonly Moved[] }>> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const vehicle = await deps.vehicleAccess.reach(actor, request.vehicleId, "vehicles.update");
      assertWindow(request.reason, request.startsAt, request.endsAt);
      const now = deps.clock.now();
      const window = { from: request.startsAt, until: request.endsAt };
      const moved = await this.clear(actor, vehicle.id, window, request.displace === true);
      const block = await this.place(
        {
          vehicleId: vehicle.id,
          branchId: vehicle.branchId,
          reason: request.reason,
          status: request.startsAt <= now ? "out" : "confirmed",
          startsAt: request.startsAt,
          endsAt: request.endsAt,
          note: request.note ?? null,
        },
        actor.userId,
      );
      await this.audit(actor, "vehicle.block_added", block, null);
      return { block, moved };
    });
  }

  /** New times or note for a block that is not over (holds lapse; nothing else changes). */
  reschedule(actor: Principal, id: string, change: BlockChange): Promise<VehicleBlock> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.reach(actor, id, permissionFor);
      const now = deps.clock.now();
      this.assertOpen(before, now);
      if (change.startsAt !== undefined && before.status === "out")
        throw new VehicleBlockError("The vehicle is out already: only the end can change");
      const vehicle = await deps.blocks.vehicle(before.vehicleId);
      if (vehicle === null) throw new VehicleBlockNotFoundError();
      const startsAt = change.startsAt ?? before.startsAt;
      const endsAt = change.endsAt === undefined ? before.endsAt : change.endsAt;
      assertWindow(before.reason, startsAt, endsAt);
      await deps.blocks.lock([vehicle.id]);
      await deps.blocks.releaseLapsed([vehicle.id], now);
      const after: VehicleBlock = {
        ...before,
        startsAt,
        endsAt,
        blockedUntil: blockedUntil(before.reason, endsAt, vehicle.turnaroundMinutes),
        note: change.note === undefined ? before.note : change.note?.trim() || null,
      };
      const conflict = (await deps.blocks.busy([vehicle.id], busyOf(after), now)).find(
        (b) => b.id !== before.id,
      );
      if (conflict !== undefined) throw new VehicleUnavailableError(describe(vehicle, conflict));
      await deps.blocks.save(after);
      await this.audit(actor, "vehicle.block_changed", after, before);
      return after;
    });
  }

  /** Frees the vehicle (a hold given up, maintenance done early …). */
  release(actor: Principal, id: string, reason: string): Promise<VehicleBlock> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.reach(actor, id, permissionFor);
      const now = deps.clock.now();
      this.assertOpen(before, now);
      const after: VehicleBlock = {
        ...before,
        status: "released",
        releasedAt: now,
        releasedReason: reason.trim(),
        releasedBy: actor.userId,
      };
      await deps.blocks.save(after);
      await this.audit(actor, "vehicle.block_released", after, before);
      return after;
    });
  }

  /** Moves a class booking to another vehicle of its class (the best fit when none is named). */
  move(actor: Principal, id: string, vehicleId: string | null): Promise<VehicleBlock> {
    const { deps } = this;
    return deps.unitOfWork.run(async () => {
      const before = await this.reach(actor, id, "rentals.create");
      const now = deps.clock.now();
      this.assertOpen(before, now);
      if (before.classId === null || before.status === "out")
        throw new VehicleBlockError("Only class bookings not yet checked out change vehicle");
      const fleet = (
        await deps.blocks.fleet({
          branchIds: [before.branchId],
          classId: before.classId,
          rentableOnly: true,
        })
      ).filter((v) => v.id !== before.vehicleId && (vehicleId === null || v.id === vehicleId));
      if (vehicleId !== null && fleet.length === 0)
        throw new VehicleUnavailableError(
          "That vehicle is not one of the class offered for rent at the branch",
        );
      const ids = [before.vehicleId, ...fleet.map((v) => v.id)];
      await deps.blocks.lock(ids);
      await deps.blocks.releaseLapsed(ids, now);
      const window = busyOf(before);
      const busy = await this.busyByVehicle(fleet, around(window));
      const chosen = chooseVehicle(
        fleet.map((v) => candidate(v, busy.get(v.id) ?? [])),
        window,
      );
      if (chosen === null)
        throw new VehicleUnavailableError(
          vehicleId === null
            ? "No other vehicle of the class is free for these times"
            : "That vehicle is busy at these times",
        );
      const after: VehicleBlock = { ...before, vehicleId: chosen };
      await deps.blocks.save(after);
      await this.audit(actor, "vehicle.block_moved", after, before);
      return after;
    });
  }

  // --- helpers ---

  /**
   * Makes room on a vehicle: refuses when blocks are in the way, or with `displace`, moves the
   * class bookings in the way to other vehicles of their class (all or none).
   */
  private async clear(
    actor: Principal,
    vehicleId: string,
    window: BusyInterval,
    displace: boolean,
  ): Promise<Moved[]> {
    const { deps } = this;
    const now = deps.clock.now();
    const vehicle = await deps.blocks.vehicle(vehicleId);
    if (vehicle === null) throw new VehicleBlockNotFoundError();
    await deps.blocks.lock([vehicleId]);
    await deps.blocks.releaseLapsed([vehicleId], now);
    const conflicts = await deps.blocks.busy([vehicleId], window, now);
    if (conflicts.length === 0) return [];
    const fixed = conflicts.find((b) => !displace || b.classId === null || b.status === "out");
    if (fixed !== undefined) throw new VehicleUnavailableError(describe(vehicle, fixed));

    const moved: Moved[] = [];
    for (const [classId, blocks] of groupBy(conflicts, (b) => `${b.classId}|${b.branchId}`)) {
      const [cls, branchId] = classId.split("|") as [string, string];
      const fleet = (
        await deps.blocks.fleet({ branchIds: [branchId], classId: cls, rentableOnly: true })
      ).filter((v) => v.id !== vehicleId);
      const ids = fleet.map((v) => v.id);
      await deps.blocks.lock(ids);
      await deps.blocks.releaseLapsed(ids, now);
      const span = {
        from: new Date(Math.min(...blocks.map((b) => b.startsAt.getTime()))),
        until: latest(blocks.map((b) => b.blockedUntil)),
      };
      const busy = await this.busyByVehicle(fleet, around(span));
      const plan = planMoves(
        blocks.map((b) => ({ blockId: b.id, busy: busyOf(b) })),
        fleet.map((v) => candidate(v, busy.get(v.id) ?? [])),
      );
      for (const b of blocks) {
        const target = plan.get(b.id) ?? null;
        if (target === null)
          throw new VehicleUnavailableError(
            `${describe(vehicle, b)}, and no other vehicle of its class is free to take it`,
          );
        moved.push({ blockId: b.id, fromVehicleId: vehicleId, toVehicleId: target });
      }
    }
    for (const m of moved) {
      const before = conflicts.find((b) => b.id === m.blockId)!;
      const after = { ...before, vehicleId: m.toVehicleId };
      await deps.blocks.save(after);
      await this.audit(actor, "vehicle.block_moved", after, before);
    }
    return moved;
  }

  private async branchFor(
    actor: Principal,
    permission: PermissionKey,
    branchId: string | null | undefined,
  ): Promise<string> {
    const { vehicleAccess } = this.deps;
    const id = branchId ?? (await vehicleAccess.defaultBranch(actor, permission));
    return (await vehicleAccess.branch(actor, permission, id)).id;
  }

  /** The block, if the caller may act on its branch; otherwise it does not exist for them. */
  private async reach(
    actor: Principal,
    id: string,
    permission: PermissionKey | ((block: VehicleBlock) => PermissionKey),
  ): Promise<VehicleBlock> {
    const block = await this.deps.blocks.get(id);
    if (block === null) throw new VehicleBlockNotFoundError();
    const key = typeof permission === "function" ? permission(block) : permission;
    if (!this.deps.vehicleAccess.can(actor, key, block.branchId))
      throw new VehicleBlockNotFoundError();
    return block;
  }

  private assertOpen(block: VehicleBlock, now: Date): void {
    if (block.status === "released") throw new VehicleBlockError("The block is released already");
    if (block.status === "hold" && block.expiresAt !== null && block.expiresAt <= now)
      throw new VehicleBlockError("The hold has lapsed");
  }

  private windowFor(
    v: FleetVehicle | undefined,
    reason: BlockReason,
    from: Date,
    to: Date | null,
  ): BusyInterval {
    return { from, until: blockedUntil(reason, to, v?.turnaroundMinutes ?? 0) };
  }

  private async busyByVehicle(
    fleet: readonly FleetVehicle[],
    interval: BusyInterval,
  ): Promise<Map<string, VehicleBlock[]>> {
    const blocks = await this.deps.blocks.busy(
      fleet.map((v) => v.id),
      interval,
      this.deps.clock.now(),
    );
    return group(blocks);
  }

  private async audit(
    actor: Principal,
    action: string,
    after: VehicleBlock,
    before: VehicleBlock | null,
  ): Promise<void> {
    await recordUserAction(this.deps, actor.userId, {
      action,
      entityType: "vehicle_block",
      entityId: after.id,
      before: before === null ? null : auditView(before),
      after: auditView(after),
    });
  }
}

const given = <T>(value: T | null | undefined): value is T => value !== undefined && value !== null;

/** Holds are agents' work; other blocks are the fleet's. */
function permissionFor(block: VehicleBlock): PermissionKey {
  return block.reason === "rental" ? "rentals.create" : "vehicles.update";
}

const summary = (v: FleetVehicle): VehicleSummary => ({
  id: v.id,
  code: v.code,
  plateNumber: v.plateNumber,
  make: v.make,
  model: v.model,
});

const candidate = (v: FleetVehicle, blocks: readonly VehicleBlock[]): Candidate => ({
  vehicleId: v.id,
  code: v.code,
  busy: blocks.map(busyOf),
});

const bar = (b: VehicleBlock): CalendarBar => ({
  id: b.id,
  reason: b.reason,
  status: b.status,
  startsAt: b.startsAt,
  endsAt: b.endsAt,
  blockedUntil: b.blockedUntil,
  expiresAt: b.expiresAt,
  classId: b.classId,
  customerId: b.customerId,
  refType: b.refType,
  refId: b.refId,
  note: b.note,
});

const auditView = (b: VehicleBlock) => ({
  vehicleId: b.vehicleId,
  classId: b.classId,
  reason: b.reason,
  status: b.status,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt?.toISOString() ?? null,
  expiresAt: b.expiresAt?.toISOString() ?? null,
  customerId: b.customerId,
  note: b.note,
  releasedReason: b.releasedReason,
});

function group(blocks: readonly VehicleBlock[]): Map<string, VehicleBlock[]> {
  return groupBy(blocks, (b) => b.vehicleId);
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k);
    if (list === undefined) map.set(k, [item]);
    else list.push(item);
  }
  return map;
}

/** The window widened by the best-fit horizon, to see the bookings next to it. */
function around(window: BusyInterval): BusyInterval {
  return {
    from: new Date(window.from.getTime() - FIT_HORIZON),
    until: window.until === null ? null : new Date(window.until.getTime() + FIT_HORIZON),
  };
}

function latest(dates: readonly (Date | null)[]): Date | null {
  if (dates.some((d) => d === null)) return null;
  return new Date(Math.max(...dates.map((d) => d!.getTime())));
}

const WHAT: Record<BlockReason, string> = {
  rental: "rented",
  maintenance: "in maintenance",
  transfer: "being transferred",
  sale_hold: "held for a sale",
  other: "blocked",
};

function describe(vehicle: Pick<FleetVehicle, "code">, b: VehicleBlock): string {
  const until =
    b.blockedUntil === null ? "until further notice" : `to ${b.blockedUntil.toISOString()}`;
  const what = b.reason === "rental" && b.status === "hold" ? "held for a rental" : WHAT[b.reason];
  return `${vehicle.code} is ${what} from ${b.startsAt.toISOString()} ${until}`;
}
